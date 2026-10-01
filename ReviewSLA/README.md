# Review SLA

First-response clocks for the review throughput RFC's Proposal 2: a scheduled job that works out
who owes a review on every open PR and by when, and report mode, which measures it over past weeks.

## The scheduled job

`.github/workflows/review-sla.yml` runs it every 30 minutes during business hours (10:00 to 17:00
Pacific, business days), and on demand. Each run rebuilds every assignee's clock from the open
PRs' timelines; there's no other state. The repo variable `REVIEW_SLA_MODE` switches it, and is
the rollback for every step:

| Mode | What it does |
| --- | --- |
| `off`, or unset | Nothing; the job is skipped |
| `shadow` | Keeps each PR's Review SLA comment, the Confluence dashboard and the 10:00 Slack digest up to date |
| `remind` | Also DMs each assignee when their review is due, and reassigns anyone the PTO calendar has out before their review is due |
| `enforce` | Reassignment at twice the target. Not built yet; runs as `remind` |

### Who owes what

Each assignee other than the author has their own clock on each ready PR:

- **First response:** due 4 business hours after it starts on a PR under 250 added lines, 7 (one
  business day) otherwise. It starts at the latest of the PR being marked ready, the person being
  assigned, and, mid-stack, their approval of the PR below or the PR below merging. It stops at
  their first review that counts: an approval, changes requested, or a comment review with a body
  or at least one inline comment.
- **Stacks:** an assignee owes a response only on the lowest ready PR in the stack they're
  assigned to and haven't approved. Requesting changes doesn't move them up the stack.
- **Re-review:** due 4 business hours after the author re-requests their review, if the author
  has pushed since their last one. A re-request with no new push, as Graphite makes on every
  `gt submit`, starts nothing.
- **Drafts** stop every clock on the PR. Marking it ready again starts the first-response clocks
  over.

Bot PRs and Graphite merge-queue PRs have no clocks.

### What it changes

- **A Review SLA comment** on each ready PR where someone owes a review, edited in place: who owes
  what, and when it's due. A hidden marker in it records which reminders have been sent, so reruns
  and late scheduled runs don't send them twice. The comment is written before the DM, so a failed
  write means a missed reminder, not a repeated one.
- **Reminder DMs** (`remind`): one per clock, when it's due, to the assignee's Slack ID in
  `REVIEW_PEOPLE`.
- **Out-of-office reassignment** (`remind`): an assignee the PTO calendar has out on any day from
  today to the day their review is due is replaced on every PR in the stack they're assigned to.
  A domain approver is replaced from the domain team and a rotation reviewer from the rotation team,
  by the same least-loaded pick AssignReviewers uses (`ReviewConfig/pick.js`). The other assignee is
  kept, and a comment on the lowest of those PRs says who took over and why.
- **The digest:** posted to the `REVIEW_SLA_SLACK_CHANNEL` channel by the 10:00 Pacific run
  (or a manual run with **digest** ticked): overdue reviews by person, and how many more are due
  today.
- **The dashboard:** a Confluence page with a checkmark per person while they're meeting the SLA,
  and their overdue reviews when they aren't. It saves a new version only when the content
  changes, as a minor edit, so watchers aren't notified every 30 minutes.

It fails safe: an API error is a warning, and that PR, repo, channel or page is skipped this run.

### Setup

| Name | Kind | What it is |
| --- | --- | --- |
| `REVIEW_SLA_MODE` | Repo variable | `off`, `shadow`, `remind` or `enforce` |
| `STAFL_CI_APP_ID`, `STAFL_CI_PRIVATE_KEY` | Org variable, secret | The staflsystemsci app, installed on every repo checked, with Pull requests and Issues write and Members read |
| `PTO_CALENDAR_URL` | Org secret | Rippling PTO calendar feed |
| `REVIEW_PEOPLE` | Org variable | Names and Slack IDs (see `ReviewConfig/`) |
| `REVIEW_SLA_SLACK_BOT_TOKEN`, `REVIEW_SLA_SLACK_CHANNEL` | Org secret, variable | Slack app with `chat:write`, invited to the digest channel |
| `CONFLUENCE_URL`, `CONFLUENCE_USER`, `CONFLUENCE_API_TOKEN` | Org variables, secret | Base URL ending in `/wiki`, and the email and API token of an account that can edit the page. A scoped (service account) token uses `https://api.atlassian.com/ex/confluence/<cloud id>/wiki` |
| `REVIEW_SLA_PAGE_ID` | Org variable | The dashboard page |

The repos checked are listed in the workflow.

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
| `run.js` | The scheduled job: modes, out-of-office reassignment, comments, reminders, digest, dashboard |
| `owed.js` | Who owes a review now: each assignee's clock, with the stack and re-review rules |
| `github.js` | Reads each repo's open PRs and their timelines |
| `comment.js`, `slack.js`, `confluence.js` | The PR comment, Slack messages and the dashboard page |
| `clock.js` | A PR's first response, measured both ways, for report mode |
| `report.js` | Report mode: fetches PRs and writes the weekly report |

## Tests

```bash
node --test ReviewSLA/ ReviewConfig/
```
