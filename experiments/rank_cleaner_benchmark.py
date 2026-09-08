#!/usr/bin/env python3
"""Aggregate repeated cleaner benchmark runs into a quality-speed ranking."""

from __future__ import annotations

import argparse
import json
import math
import statistics
from collections import defaultdict
from pathlib import Path


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        return math.inf
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, math.ceil(fraction * len(ordered)) - 1))
    return ordered[index]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("result", type=Path)
    parser.add_argument("--latency-result", type=Path, help="Optional single-item result used only for p50/p95 speed.")
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    data = json.loads(args.result.read_text(encoding="utf-8"))
    latency_data = json.loads(args.latency_result.read_text(encoding="utf-8")) if args.latency_result else data
    latency_groups = defaultdict(list)
    for run in latency_data["runs"]:
        latency_groups[(run["model"], run["prompt"])].extend(run.get("request_latencies", []))
    grouped = defaultdict(list)
    for run in data["runs"]:
        grouped[(run["model"], run["prompt"])].append(run)

    rows = []
    for (model, prompt), runs in grouped.items():
        case_results = [case for run in runs for case in run.get("cases", [])]
        preserve = [case for case in case_results if case["raw"] == case["expected"]]
        cleanup = [case for case in case_results if case["raw"] != case["expected"]]
        total = len(case_results) or 1
        accuracy = sum(case["content_exact"] for case in case_results) / total
        preserve_accuracy = sum(case["content_exact"] for case in preserve) / max(1, len(preserve))
        cleanup_accuracy = sum(case["content_exact"] for case in cleanup) / max(1, len(cleanup))
        expected_outputs = len(data["cases"]) * len(runs)
        completed_outputs = sum(bool(case["actual"]) for case in case_results)
        completion_rate = completed_outputs / max(1, expected_outputs)
        requests = sum(run.get("request_count", 1) for run in runs)
        successful_requests = sum(run.get("successful_requests", int(not run.get("error"))) for run in runs)
        strict_requests = sum(run.get("strict_requests", int(run.get("format_ok", False))) for run in runs)
        request_success_rate = successful_requests / max(1, requests)
        format_rate = strict_requests / max(1, successful_requests)
        latencies = latency_groups.get(
            (model, prompt),
            [latency for run in runs for latency in run.get("request_latencies", [])],
        )
        quality_score = 100 * (
            0.45 * accuracy
            + 0.20 * preserve_accuracy
            + 0.15 * cleanup_accuracy
            + 0.10 * completion_rate
            + 0.05 * request_success_rate
            + 0.05 * format_rate
        )
        rows.append(
            {
                "model": model,
                "prompt": prompt,
                "runs": len(runs),
                "quality": quality_score,
                "accuracy": 100 * accuracy,
                "preserve": 100 * preserve_accuracy,
                "cleanup": 100 * cleanup_accuracy,
                "completion": 100 * completion_rate,
                "request_success": 100 * request_success_rate,
                "format": 100 * format_rate,
                "p50": statistics.median(latencies) if latencies else math.inf,
                "p95": percentile(latencies, 0.95),
            }
        )

    finite_p50 = [row["p50"] for row in rows if math.isfinite(row["p50"]) and row["p50"] > 0]
    fastest = min(finite_p50) if finite_p50 else 1.0
    for row in rows:
        row["speed"] = 100 * fastest / row["p50"] if math.isfinite(row["p50"]) else 0.0
        row["combined"] = 0.80 * row["quality"] + 0.20 * row["speed"]
    rows.sort(key=lambda row: (row["combined"], row["quality"]), reverse=True)

    lines = [
        "# Cleaner quality-speed ranking",
        "",
        "Combined score = 80% quality + 20% relative speed.",
        "Quality = 45% overall accuracy + 20% preservation + 15% cleanup + 10% completion + 5% request success + 5% strict JSON.",
        "Speed = fastest median latency / model median latency.",
        f"Latency source: {args.latency_result or args.result}",
        "",
        "| Rank | Model | Prompt | Combined | Quality | Speed | Accuracy | Preserve | Cleanup | Complete | Success | JSON | p50 | p95 |",
        "|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for index, row in enumerate(rows, 1):
        p50 = f"{row['p50']:.2f}s" if math.isfinite(row["p50"]) else "n/a"
        p95 = f"{row['p95']:.2f}s" if math.isfinite(row["p95"]) else "n/a"
        lines.append(
            f"| {index} | {row['model']} | {row['prompt']} | {row['combined']:.1f} | {row['quality']:.1f} | "
            f"{row['speed']:.1f} | {row['accuracy']:.1f}% | {row['preserve']:.1f}% | {row['cleanup']:.1f}% | "
            f"{row['completion']:.1f}% | {row['request_success']:.1f}% | {row['format']:.1f}% | {p50} | {p95} |"
        )
    output = args.output or args.result.with_name(args.result.stem + "-ranking.md")
    output.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
