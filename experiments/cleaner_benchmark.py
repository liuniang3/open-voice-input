#!/usr/bin/env python3
"""Benchmark transcript-cleaning prompts without persisting API credentials."""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import difflib
import json
import os
import re
import sqlite3
import sys
import time
import unicodedata
import urllib.error
import urllib.request
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CASES_PATH = Path(__file__).with_name("cleaner-benchmark-cases.json")
DEFAULT_DB_PATH = Path.home() / ".cc-switch" / "cc-switch.db"
RESULTS_DIR = Path(__file__).with_name("results")


@dataclass(frozen=True)
class ProviderSpec:
    label: str
    source: str
    provider_name: str
    model: str
    protocol: str


PROVIDERS = (
    ProviderSpec("gpt-5.4-mini", "opencode", "Aixoras GPT", "gpt-5.4-mini", "chat"),
    ProviderSpec("gpt-5.6-sol", "opencode", "Aixoras GPT", "gpt-5.6-sol", "chat"),
    ProviderSpec("glm-5.2", "opencode", "Aixoras GLM", "glm-5.2", "chat"),
    ProviderSpec("grok-4.5", "opencode", "Aixoras Grok", "grok-4.5", "chat"),
    ProviderSpec("deepseek-v4-pro", "opencode", "Aixoras DeepSeek", "deepseek-v4-pro", "chat"),
    ProviderSpec("mimo-v2.5", "codex", "Xiaomi MiMo", "mimo-v2.5", "responses"),
    ProviderSpec("mimo-v2.5-pro", "codex", "Xiaomi MiMo", "mimo-v2.5-pro", "responses"),
)


PROMPTS = {
    "current": """You clean dictated text for direct insertion.
Only delete filler words, hesitations, repeated false starts, and duplicate fragments.
Add natural punctuation when needed.
Never add information, answer questions, explain, summarize, or change technical terms.
Process every item independently.""",
    "minimal-edit": """You are a loss-averse transcript editor. Make the smallest possible edit to each item.
Allowed operations: delete an unmistakable filler, delete an unmistakable stutter or abandoned false start, collapse an unmistakably accidental duplicate, and adjust punctuation.
Do not paraphrase, reorder, replace, summarize, infer, or improve style.
Preserve grammatical reduplication (慢慢, 想想, 讨论讨论, 明明白白), deliberate emphasis, parallel wording, negation, quoted speech, discourse connectives, identifiers, model names, and mixed Chinese-English text.
Words such as 然后, 就是, 嗯, and repeated wording may be meaningful. Delete them only when the local sentence proves they are hesitation noise.
If uncertain, keep the original wording. Process every item independently.""",
    "deletion-span": """Clean dictated text by a conservative deletion-span procedure.
For each item, first identify exact spans that are unquestionably one of: filler noise, a stutter, an abandoned false start, or an accidental duplicate. Reject any proposed deletion that changes meaning, emphasis, negation, grammatical reduplication, quoted speech, a connective, a technical term, a number, or an identifier.
Reconstruct the result only by deleting approved spans and adjusting punctuation. Never paraphrase, reorder, replace, summarize, answer, or add content.
Normal forms such as 慢慢, 想想, 讨论讨论, 明明白白, 一次一次, 好好好, and 别别 must be preserved when they are meaningful in context.
If evidence is insufficient, delete nothing. Process every item independently.""",
}


OUTPUT_RULE = """
Return exactly one JSON object and nothing else, using this schema:
{"results":[{"id":"the input id","text":"cleaned text"}]}
Return one result for every input id in the same order. Do not include reasoning or deletion spans.
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Compare transcript-cleaning prompts and models.")
    parser.add_argument("--models", help="Comma-separated model labels; defaults to all configured models.")
    parser.add_argument("--prompts", help="Comma-separated prompt names; defaults to all prompts.")
    parser.add_argument("--case-ids", help="Comma-separated case ids; defaults to the full corpus.")
    parser.add_argument("--repeats", type=int, default=1)
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--batch-size", type=int, default=0, help="Cases per API call; 0 sends the full corpus.")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB_PATH)
    parser.add_argument("--output-dir", type=Path, default=RESULTS_DIR)
    return parser.parse_args()


def select_named(items, requested, key):
    if not requested:
        return list(items)
    wanted = {part.strip() for part in requested.split(",") if part.strip()}
    selected = [item for item in items if key(item) in wanted]
    missing = wanted - {key(item) for item in selected}
    if missing:
        raise SystemExit(f"Unknown selection: {', '.join(sorted(missing))}")
    return selected


def load_connection(db_path: Path, spec: ProviderSpec) -> tuple[str, str]:
    with sqlite3.connect(db_path) as connection:
        row = connection.execute(
            "SELECT settings_config FROM providers WHERE app_type = ? AND name = ?",
            (spec.source, spec.provider_name),
        ).fetchone()
    if not row:
        raise RuntimeError(f"CC Switch provider not found: {spec.provider_name}")
    config = json.loads(row[0])
    if spec.protocol == "chat":
        return config["options"]["baseURL"].rstrip("/"), config["options"]["apiKey"]
    base_match = re.search(r'base_url\s*=\s*"([^"]+)"', config.get("config", ""))
    if not base_match:
        raise RuntimeError(f"No base URL configured for {spec.provider_name}")
    return base_match.group(1).rstrip("/"), config["auth"]["OPENAI_API_KEY"]


def build_user_prompt(cases: list[dict]) -> str:
    inputs = [{"id": case["id"], "raw": case["raw"]} for case in cases]
    return "Clean these inputs:\n" + json.dumps(inputs, ensure_ascii=False, separators=(",", ":"))


def post_json(url: str, api_key: str, payload: dict, timeout: int) -> dict:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def extract_responses_text(body: dict) -> str:
    if body.get("output_text"):
        return str(body["output_text"])
    parts = []
    for item in body.get("output", []):
        for content in item.get("content", []):
            if content.get("type") == "output_text" and content.get("text"):
                parts.append(str(content["text"]))
    return "".join(parts)


def call_model(
    spec: ProviderSpec,
    prompt_name: str,
    cases: list[dict],
    db_path: Path,
    timeout: int,
    batch_size: int,
    repeat: int,
) -> dict:
    base_url, api_key = load_connection(db_path, spec)
    system_prompt = PROMPTS[prompt_name] + OUTPUT_RULE
    started = time.perf_counter()
    size = batch_size if batch_size > 0 else len(cases)
    batches = [cases[index:index + size] for index in range(0, len(cases), size)]
    try:
        all_outputs = {}
        format_ok = True
        strict_requests = 0
        request_latencies = []
        for batch in batches:
            request_started = time.perf_counter()
            user_prompt = build_user_prompt(batch)
            if spec.protocol == "chat":
                body = post_json(
                    f"{base_url}/chat/completions",
                    api_key,
                    {
                        "model": spec.model,
                        "messages": [
                            {"role": "system", "content": system_prompt},
                            {"role": "user", "content": user_prompt},
                        ],
                        "temperature": 0,
                        "stream": False,
                    },
                    timeout,
                )
                response_text = str(body.get("choices", [{}])[0].get("message", {}).get("content", ""))
            else:
                body = post_json(
                    f"{base_url}/responses",
                    api_key,
                    {
                        "model": spec.model,
                        "instructions": system_prompt,
                        "input": user_prompt,
                        "stream": False,
                        "store": False,
                    },
                    timeout,
                )
                response_text = extract_responses_text(body)
            parsed, batch_format_ok = parse_result_json(response_text)
            request_latencies.append(round(time.perf_counter() - request_started, 3))
            all_outputs.update(parsed)
            format_ok = format_ok and batch_format_ok
            strict_requests += int(batch_format_ok)
        return {
            "model": spec.label,
            "prompt": prompt_name,
            "repeat": repeat,
            "latency_seconds": round(time.perf_counter() - started, 2),
            "format_ok": format_ok,
            "request_count": len(batches),
            "successful_requests": len(batches),
            "strict_requests": strict_requests,
            "request_latencies": request_latencies,
            "outputs": all_outputs,
            "error": "",
        }
    except urllib.error.HTTPError as error:
        return failed_run(spec, prompt_name, repeat, started, len(batches), f"HTTP {error.code}")
    except Exception as error:
        return failed_run(spec, prompt_name, repeat, started, len(batches), type(error).__name__)


def failed_run(
    spec: ProviderSpec,
    prompt_name: str,
    repeat: int,
    started: float,
    request_count: int,
    error: str,
) -> dict:
    return {
        "model": spec.label,
        "prompt": prompt_name,
        "repeat": repeat,
        "latency_seconds": round(time.perf_counter() - started, 2),
        "format_ok": False,
        "request_count": request_count,
        "successful_requests": 0,
        "strict_requests": 0,
        "request_latencies": [],
        "outputs": {},
        "error": error,
    }


def parse_result_json(value: str) -> tuple[dict[str, str], bool]:
    text = str(value or "").strip()
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", text, re.IGNORECASE)
    candidate = fenced.group(1) if fenced else text
    try:
        parsed = json.loads(candidate)
        results = parsed.get("results", []) if isinstance(parsed, dict) else parsed
        outputs = {
            str(item.get("id", "")): str(item.get("text", item.get("cleaned", "")))
            for item in results
            if isinstance(item, dict) and item.get("id")
        }
        strict = (
            not fenced
            and isinstance(parsed, dict)
            and set(parsed) == {"results"}
            and all(isinstance(item, dict) and set(item) == {"id", "text"} for item in results)
            and len(outputs) == len(results)
        )
        return outputs, strict
    except (json.JSONDecodeError, AttributeError):
        # Scoring remains possible when a model adds prose or truncates the outer
        # array. Product code should still reject these non-compliant responses.
        outputs = {}
        for match in re.finditer(r"\{[^{}]*\}", text):
            try:
                item = json.loads(match.group(0))
            except json.JSONDecodeError:
                continue
            if not isinstance(item, dict) or not item.get("id"):
                continue
            cleaned = item.get("text", item.get("cleaned"))
            if cleaned is not None:
                outputs[str(item["id"])] = str(cleaned)
        return outputs, False


CONTENT_PUNCTUATION = re.compile(r"[\s，,。.!！?？；;：:、‘’“”\"'（）()《》〈〉【】\[\]…—-]+")


def normalize_exact(value: str) -> str:
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", str(value or "")))


def normalize_content(value: str) -> str:
    return CONTENT_PUNCTUATION.sub("", unicodedata.normalize("NFKC", str(value or ""))).lower()


def score_runs(runs: list[dict], cases: list[dict]) -> None:
    by_id = {case["id"]: case for case in cases}
    for run in runs:
        details = []
        for case_id, case in by_id.items():
            actual = run["outputs"].get(case_id, "")
            expected_content = normalize_content(case["expected"])
            actual_content = normalize_content(actual)
            details.append(
                {
                    "id": case_id,
                    "category": case["category"],
                    "raw": case["raw"],
                    "expected": case["expected"],
                    "actual": actual,
                    "exact": normalize_exact(actual) == normalize_exact(case["expected"]),
                    "content_exact": actual_content == expected_content,
                    "content_similarity": round(difflib.SequenceMatcher(None, expected_content, actual_content).ratio(), 4),
                }
            )
        run["cases"] = details
        total = len(details)
        run["score"] = {
            "exact": sum(item["exact"] for item in details),
            "content_exact": sum(item["content_exact"] for item in details),
            "total": total,
            "content_accuracy": round(sum(item["content_exact"] for item in details) / total, 4),
            "mean_similarity": round(sum(item["content_similarity"] for item in details) / total, 4),
        }


def category_scores(run: dict) -> dict[str, str]:
    grouped = defaultdict(list)
    for item in run["cases"]:
        grouped[item["category"]].append(item["content_exact"])
    return {name: f"{sum(values)}/{len(values)}" for name, values in sorted(grouped.items())}


def write_report(path: Path, runs: list[dict], cases: list[dict], generated_at: str) -> None:
    ranked = sorted(
        runs,
        key=lambda run: (run["score"]["content_accuracy"], run["score"]["mean_similarity"], run["format_ok"]),
        reverse=True,
    )
    lines = [
        "# Cleaner model and prompt benchmark",
        "",
        f"Generated: {generated_at}",
        f"Cases: {len(cases)}",
        "",
        "## Ranking",
        "",
        "| Rank | Model | Prompt | Run | Content exact | Text exact | Similarity | JSON | Latency |",
        "|---:|---|---|---:|---:|---:|---:|:---:|---:|",
    ]
    for index, run in enumerate(ranked, 1):
        score = run["score"]
        lines.append(
            f"| {index} | {run['model']} | {run['prompt']} | {run.get('repeat', 1)} | {score['content_exact']}/{score['total']} | "
            f"{score['exact']}/{score['total']} | {score['mean_similarity']:.3f} | "
            f"{'yes' if run['format_ok'] else 'no'} | {run['latency_seconds']:.2f}s |"
        )
    lines.extend(["", "## Category scores", ""])
    for run in ranked:
        scores = ", ".join(f"{key} {value}" for key, value in category_scores(run).items())
        lines.extend([f"### {run['model']} / {run['prompt']}", "", scores, ""])
    lines.extend(["## Mismatches from the top five combinations", ""])
    for run in ranked[:5]:
        mismatches = [item for item in run["cases"] if not item["content_exact"]]
        lines.extend([f"### {run['model']} / {run['prompt']}", ""])
        if not mismatches:
            lines.extend(["No content mismatches.", ""])
            continue
        for item in mismatches:
            lines.append(f"- `{item['id']}` expected: {item['expected']} | actual: {item['actual'] or '[missing]'}")
        lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    args = parse_args()
    cases = json.loads(CASES_PATH.read_text(encoding="utf-8"))
    if args.case_ids:
        wanted_case_ids = {part.strip() for part in args.case_ids.split(",") if part.strip()}
        cases = [case for case in cases if case["id"] in wanted_case_ids]
        missing_case_ids = wanted_case_ids - {case["id"] for case in cases}
        if missing_case_ids:
            raise SystemExit(f"Unknown case ids: {', '.join(sorted(missing_case_ids))}")
    providers = select_named(PROVIDERS, args.models, lambda item: item.label)
    prompt_names = select_named(PROMPTS.keys(), args.prompts, lambda item: item)
    jobs = [
        (provider, prompt_name, repeat)
        for provider in providers
        for prompt_name in prompt_names
        for repeat in range(1, max(1, args.repeats) + 1)
    ]
    print(f"Running {len(jobs)} benchmark calls over {len(cases)} cases...", flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.workers)) as executor:
        futures = [
            executor.submit(call_model, provider, prompt_name, cases, args.db, args.timeout, args.batch_size, repeat)
            for provider, prompt_name, repeat in jobs
        ]
        runs = []
        for future in concurrent.futures.as_completed(futures):
            run = future.result()
            runs.append(run)
            status = "ok" if not run["error"] else run["error"]
            print(
                f"{run['model']} / {run['prompt']} / run {run.get('repeat', 1)}: "
                f"{status} ({run['latency_seconds']:.2f}s)",
                flush=True,
            )
    score_runs(runs, cases)
    generated_at = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    json_path = args.output_dir / "cleaner-benchmark-latest.json"
    report_path = args.output_dir / "cleaner-benchmark-latest.md"
    json_path.write_text(
        json.dumps({"generated_at": generated_at, "cases": cases, "runs": runs}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    write_report(report_path, runs, cases, generated_at)
    successful = sum(not run["error"] for run in runs)
    print(f"Completed {successful}/{len(runs)} calls. Report: {report_path}")
    return 0 if successful else 1


if __name__ == "__main__":
    sys.exit(main())
