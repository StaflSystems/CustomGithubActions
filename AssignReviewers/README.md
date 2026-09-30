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
   already assigned to that person in the org; anyone whose GitHub status is Busy is skipped, and ties
   rotate by PR number.
4. **Requests reviewers.** It requests the review team (default `embeddedreviewers`) unless someone
   from it has already been requested or has reviewed, so restacks don't re-request approvers. An
   assignee from outside the team is requested individually.

The author is never an assignee; a self-assignment is removed. Drafts, bot PRs and Graphite
merge-queue PRs are skipped. Team review auto-assignment settings are left as they are.

## Setup

1. **GitHub App** (org owner, once): the default `GITHUB_TOKEN` can't read team membership or request
   team reviewers, so the action needs an app installation token. Create an org-owned app with
   repository permissions *Pull requests: read and write* and *Issues: read and write*, organization
   permission *Members: read*, and no webhook. Install it on the repositories that use the action,
   then store its ID as org variable `REVIEW_BOT_APP_ID` and a private key as org secret
   `REVIEW_BOT_PRIVATE_KEY`.
2. **Each repository**: add `.github/workflows/assign-reviewers.yml`:

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
         - uses: actions/create-github-app-token@v1
           id: app
           with:
             app-id: ${{ vars.REVIEW_BOT_APP_ID }}
             private-key: ${{ secrets.REVIEW_BOT_PRIVATE_KEY }}
         - uses: StaflSystems/CustomGithubActions/AssignReviewers@main
           with:
             token: ${{ steps.app.outputs.token }}
   ```

3. **Authors** no longer need to add reviewers by hand, and shouldn't assign themselves.

## Inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `token` | required | App installation token |
| `rotation-team` | `embeddedreviewers` | Team the rotation reviewer is picked from |
| `domain-team` | `embeddedreviewersstaff` | Team the domain approver is picked from |
| `review-team` | the rotation team | Team requested as reviewers |
| `max-stack-depth` | `30` | How far down a stack to look for assignees to inherit |

## Tests

```bash
node --test AssignReviewers/
```
