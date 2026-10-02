# Assign Reviewers

Names the two people responsible for reviewing each ready PR by making them its **assignees**: a
**domain approver** (from `embeddedreviewersstaff`) and a **rotation reviewer** (from
`embeddedreviewers`). The whole review team is still requested as reviewers, so anyone can review;
the assignees are the ones who owe a response. Every PR in a Graphite stack gets the same two
assignees. This implements Proposal 1 of the review throughput RFC.

What it does each time a PR is opened ready or marked ready:

1. **Keeps what's there.** If the PR already has a domain approver and a second assignee, it doesn't
   pick anyone, so reruns are harmless and hand-picked assignees stay.
2. **Inherits down the stack.** Mid-stack, it copies the assignees of the nearest PR below it that has
   any. If the PR directly below is ready but has no assignees yet, as when a whole stack is submitted
   at once, it waits up to two minutes for that PR's own run.
3. **Picks the rest.** It adds the least-loaded domain approver if there's none, then the
   least-loaded rotation reviewer if there are fewer than two. Load is the number of open, ready PRs
   already assigned to that person in the org, not counting PRs they wrote themselves; anyone the
   Rippling PTO calendar has out today or on the next business day is skipped (Work From Home
   doesn't count). PRs merge quickly, so most people are at 0 most of the time and ties are common:
   they go to whoever was assigned to someone else's PR longest ago (anyone not assigned recently
   first), then rotate by PR number.
4. **Requests reviewers.** It requests the review team (default `embeddedreviewers`) unless someone
   from it has already been requested or has reviewed, so restacks don't re-request approvers. An
   assignee from outside the team is requested individually.

The author is never an assignee; a self-assignment is removed. Drafts, bot PRs and Graphite
merge-queue PRs are skipped. Team review auto-assignment settings are left as they are.

## Setup

1. **GitHub App**: the default `GITHUB_TOKEN` can't read team membership or request team reviewers,
   so the action uses an installation token from the existing `staflsystemsci` app (org variable
   `STAFL_CI_APP_ID`, org secret `STAFL_CI_PRIVATE_KEY`). It is installed on all repositories and
   has the permissions needed: *Pull requests* and *Issues* write, *Members* read.
2. **PTO calendar**: the Rippling PTO calendar feed URL is the org secret `PTO_CALENDAR_URL`. People
   are matched to it by name through the org variable `REVIEW_PEOPLE` (see
   [ReviewConfig](../ReviewConfig/README.md)), kept out of this public repo. Without both, nobody is
   skipped.
3. **Each repository**: add `.github/workflows/assign-reviewers.yml`:

   ```yaml
   name: Assign reviewers
   on:
     pull_request:
       types: [opened, reopened, ready_for_review]
   permissions: {}
   jobs:
     assign:
       if: ${{ !github.event.pull_request.draft }}
       runs-on: ubuntu-latest
       steps:
         - uses: actions/create-github-app-token@v2
           id: app
           with:
             app-id: ${{ vars.STAFL_CI_APP_ID }}
             private-key: ${{ secrets.STAFL_CI_PRIVATE_KEY }}
         - uses: StaflSystems/CustomGithubActions/AssignReviewers@main
           with:
             token: ${{ steps.app.outputs.token }}
             pto-calendar-url: ${{ secrets.PTO_CALENDAR_URL }}
             people: ${{ vars.REVIEW_PEOPLE }}
   ```

4. **Authors** no longer need to add reviewers by hand, and shouldn't assign themselves.

## Inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `token` | required | App installation token |
| `rotation-team` | `embeddedreviewers` | Team the rotation reviewer is picked from |
| `domain-team` | `embeddedreviewersstaff` | Team the domain approver is picked from |
| `review-team` | the rotation team | Team requested as reviewers |
| `max-stack-depth` | `30` | How far down a stack to look for assignees to inherit |
| `pto-calendar-url` | none | Rippling PTO calendar feed; people out today or next business day aren't picked |
| `people` | none | `REVIEW_PEOPLE` org variable: GitHub login to Rippling name and Slack ID |

## Tests

```bash
node --test AssignReviewers/ ReviewConfig/
```
