# Transcript cleaner benchmark

This benchmark compares transcript-cleaning models and prompts without storing API credentials in the repository.

## Inputs

- `cleaner-benchmark-cases.json`: expected input/output pairs covering fillers, stutters, restarts, self-corrections, normal reduplication, semantic repetition, quoted speech, negation, discourse words, and technical identifiers.
- `cleaner_benchmark.py`: reads configured provider credentials from the local CC Switch database at runtime and writes ignored reports under `experiments/results/`.
- `rank_cleaner_benchmark.py`: combines repeated quality runs with optional single-item latency runs.

## Run

```powershell
npm run benchmark:cleaner
```

Use `--models`, `--prompts`, `--case-ids`, `--batch-size`, and `--repeats` to narrow or repeat a run.

```powershell
python experiments/cleaner_benchmark.py --prompts deletion-span --batch-size 4 --workers 7
```

Generate a quality-speed ranking:

```powershell
python experiments/rank_cleaner_benchmark.py <quality-result.json> --latency-result <single-item-result.json>
```

The combined score weights quality at 80% and relative median latency at 20%. Quality includes overall content accuracy, preservation accuracy, cleanup accuracy, output completeness, request success, and strict JSON compliance.

Generated results are excluded by `.gitignore`. Never place API keys in benchmark arguments, fixtures, reports, or source files.
