# CI Metrics

Weekly job-level report of GitHub Actions minutes, used to check each step of the CI spend RFC's
rollout against the Sep 17–23, 2026 baseline. It isn't an action; run it locally with an
authenticated `gh`:

```bash
uv run CIMetrics/ci_metrics.py StaflLib coit-tower-bms2000 --since 2026-09-17 --until 2026-09-23
```

For every workflow run created in the date range (UTC, both ends inclusive), it:

1. Fetches every job of every attempt and bills it the way GitHub does: its duration rounded up to
   the minute, and nothing for jobs that were skipped or never got a runner.
2. Works out whether the run's PR was a draft when the run was created, from the PR's
   ReadyForReview and ConvertToDraft events. Runs from Graphite's `gtmq_*` branches count as
   merge queue, even though those PRs are drafts.
3. Writes `report_<since>_<until>.md` with billed minutes by runner, 8-core minutes by PR state, and
   the biggest jobs, plus a `jobs.tsv` per repo with one row per job.

API responses are cached under `--out` (default `ci-metrics-data/`), so a rerun only fetches what's
missing. A week of StaflLib is about 2,200 runs and takes a few minutes.

Prices are the per-minute rates the billing API reported for September 2026. Only the Linux 8-core
runner (`ubuntu-medium`) is paid today; the other runners are covered by the included minutes.

Rerunning the baseline week reproduces the RFC's numbers: 3,621 8-core minutes for StaflLib
(exactly) and 3,459 for coit-tower (the RFC has 3,443; jobs re-run after the original fetch add the
difference).
