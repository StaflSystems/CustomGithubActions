# Review SLA

First-response clocks for the review throughput RFC's Proposal 2. This is step 1 of its rollout:
the clock code and report mode. Nothing is scheduled yet, so nothing changes for authors or
reviewers. Reminders, the Confluence dashboard and reassignment come in later steps.

## Report mode

Weekly first-response numbers for a date range. Like CIMetrics, it isn't an action; run it locally
with an authenticated `gh`:

```bash
node ReviewSLA/report.js StaflLib coit-tower-bms2000 --since 2026-06-26 --until 2026-09-24
```

It writes `review_sla_<since>_<until>.md` and a `prs.tsv` with one row per PR to `--out` (default
`review-sla-report/`). Dates are Pacific and both ends are inclusive. Each PR counts in the week
(Monday to Sunday) its clock started, and events after `--until` are ignored, so a past range reads
the same however long after it the report is run.

Each row has two sets of columns:

| Columns | Clock starts | Clock stops | Measured in | Hit |
| --- | --- | --- | --- | --- |
| RFC | First ready event, or creation for a PR opened ready | First review by anyone but the author | Wall-clock hours | Within 8 h |
| SLA | Each time the PR is marked ready (or opened ready); going back to draft stops it | First review that counts | Business hours | Within target |

The RFC columns measure the way the RFC's baseline did, so its numbers can be checked; PRs whose
first review came before that start aren't timed. The SLA columns follow the SLA's clock rules:

- **Business hours** are 10:00 to 17:00 Pacific on business days (see `ReviewConfig/`), so a
  business day is 7 hours.
- **Targets** are 4 business hours for a PR under 250 added lines and 7 (one business day)
  otherwise.
- **A review counts** if it's an approval, changes requested, or a comment review with a body or at
  least one inline comment. Issue comments, reactions, the author's own reviews and bots' reviews
  don't.
- **Within target** also counts PRs still unreviewed past their target, or closed unreviewed after
  it, as misses. One unreviewed and still under its target isn't counted either way.
- PRs reviewed while still drafts aren't timed, and bot PRs and Graphite merge-queue PRs are left
  out.

PRs created up to 60 days before `--since` are fetched, in case they were marked ready in range.
Only each PR's first 100 ready, draft and review events are read; a PR with more and no review in
the first 100 is flagged on stderr.

### Checking it against the RFC

Over Jun 26 to Sep 24, 2026, the RFC columns reproduce the RFC exactly for the PRs it measured:
StaflLib's 139 come out at a 64.5 h median, 232.3 h p90 and 21% within 8 h, and coit-tower's 71 at
5.4 h, 29.5 h and 70%. The full StaflLib run times 173, because the RFC sampled the 300 most recent
PRs by creation date, and 34 PRs opened before Jun 26 were marked ready during the range.

## Files

| File | What it does |
| --- | --- |
| `clock.js` | Rebuilds a PR's first-response clock from its ready and draft events and its reviews |
| `report.js` | Report mode: fetches PRs and writes the weekly report |

## Tests

```bash
node --test ReviewSLA/ ReviewConfig/
```
