# Meeting analysis benchmark

Reproducible **synthetic** evaluation of meeting correction + structured summary models via the local `opencode` CLI.

## Scope

| In scope | Out of scope |
| --- | --- |
| Short/medium synthetic Chinese cases (meeting + personal) | Multi-hour real meetings |
| Single-shot correct + summarize JSON | Full production pipeline (batching, rolling merge, evidence scrub, export UI) |
| Keyword-group + source-id overlap scoring | Exact wording match only |
| `opencode run -m provider/model [--variant]` | Embedding API keys in repo/args/reports |

This is an **initial smoke / ranking** harness. It is **not** equivalent to scoring two-hour real meetings, and **not** a complete production-pipeline grade.

## Cases

Under `cases/`:

| Id | File | Intent |
| --- | --- | --- |
| A | `case-a-multi-party.json` | Multi-party meeting: final decision, rejected option, owner/due, speakers, early/mid/late facts, uncertain proper name |
| B | `case-b-personal-monologue.json` | Personal monologue: layered views, false starts/ASR errors, must-preserve numbers/terms |
| C | `case-c-adversarial-no-decision.json` | Adversarial: no decision, no action items; discussed-but-not-adopted options (hallucination stress) |

Each case includes: `rawItems`, gold `goldClaims`, `mustNotClaims`, `mustPreserve`, `allowedCorrections`. **No real user data.**

## Output schema

See `output-schema.json`. The model must return **one** JSON object covering meeting and/or personal template fields, plus `correctedItems` for every input id.

## Run

```powershell
# Offline scorer checks (no model)
npm run benchmark:meeting-analysis -- --self-test

# Dry-run with fixture outputs (no paid calls)
npm run benchmark:meeting-analysis -- --dry-run

# Real models via local opencode (keys stay in your opencode config — never passed here)
npm run benchmark:meeting-analysis -- --models provider/model-a,provider/model-b --repeats 2 --variant high
npm run benchmark:meeting-analysis -- --models provider/model-a --case A,C

# Re-score existing run dirs (no model calls; rewrites per-attempt scores + summary)
npm run benchmark:meeting-analysis -- --rescore 20260720-214503468-22640,20260720-214503493-53136
```

CLI flags: `--models`, `--repeats`, `--variant`, `--case`, `--timeout`, `--dry-run`, `--self-test`, `--rescore`, `--help`.

## Results

Written to `experiments/results/meeting-analysis/<run-id>/` (`YYYYMMDD-HHMMSSmmm-<pid>`, ms+pid so parallel runners never share a dir):

- per-attempt `*.json` (scores + model JSON)
- `summary.json` / `summary.md`

Reports omit API keys, env dumps, app settings, and absolute user paths.

`--rescore <dir1,dir2,...>` loads each attempt’s `modelOutput` / `caseId` / `callOk` / `jsonOk`, re-runs `scoreCase`, overwrites `scores`, and regenerates that directory’s `summary.json` / `summary.md`. Latency and model metadata are kept. Paths outside `experiments/results/meeting-analysis/` are rejected; reports never print absolute user paths.

## Scoring (automatic)

- End-to-end latency, call success, JSON/schema validity
- `correctedItems`: each item requires non-empty `sourceItemId` and string `correctedText` (wrong keys like `correctText` fail schema)
- `mustPreserve` presence (numbers/terms; Arabic ↔ Chinese numeral alts allowed)
- Forbidden novel numbers/idents on **semantic** fields only (`correctedText` / `text` / `title` / `label` / `owner` / `due`, …) — baseline includes raw text numbers, raw item/speakerId structure digits, and `mustPreserve` text/alts whitelist; numbers only under local negation are not inventions
- Decision / action / viewpoint (and personal sections) **recall** via gold keyword groups + source id overlap
- `mustNotClaims`: independent claims on listed paths only (no summary-blob merge); local negation/correction windows (“不是…”, “不要…”, “无需…”, “不必…”, “不应…”, “未采纳…”, …) do not count as asserting the forbidden claim
- `sourceItemIds` legality
- Early / mid / late span coverage
- Case C empty `decisions` / `actionItems` expectation

Failed subprocesses are recorded; the batch continues.

## Scoring gates

- If the subprocess call fails (`callOk=false`) or JSON/schema is invalid (`jsonOk=false`), **composite score is forced to 0** (no vacuous pass from empty gold sections).
- Aggregation: composite / claim_recall / preserve / coverage treat failed runs as 0 over all `runs`.
- `mustNotCleanRate` is computed only over **valid** runs (`callOk && jsonOk`); summary reports `validRuns`. If `validRuns=0`, rate is 0.
- When merging several run dirs by model (e.g. 9/6/3 attempts), weight by attempt counts; do not average `must_not_clean` across models or dirs with different `validRuns` without weighting.

## Dependencies

Node built-ins only. Live runs need the local `opencode` CLI:

- **Windows:** resolves `%APPDATA%/npm/node_modules/opencode-ai/bin/opencode.exe`, or `npm.cmd root -g` + `opencode-ai/bin/opencode.exe` (verified with `existsSync`). Spawn uses `shell: false`; the prompt is a single argv element (never string-concatenated into a shell line).
- **Other platforms:** `opencode` on `PATH`.

If the CLI cannot be resolved, the runner exits with a clear error before any model call.

Results under `experiments/results/meeting-analysis/` are gitignored (cleaner result files under `experiments/results/` remain trackable).
