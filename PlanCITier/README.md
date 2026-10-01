# Plan CI Tier

Picks how much CI a run gets, from the PR's draft state and its place in a Graphite stack. This
implements Proposal 1 of the CI spend RFC and replaces the Graphite CI optimizer, so there are no
per-repo optimizer settings to keep in sync.

Tiers are cumulative: each one also runs everything in the tiers before it.

| Tier | Runs on | What the calling workflow runs |
| --- | --- | --- |
| always | Every PR push, draft or ready | Plan step, formatting, lint |
| unit | Every ready PR, anywhere in its stack | Full unit test suites with coverage |
| ready | The highest ready PR in each stack | One GCC and one IAR embedded build, SIL tests, Axivion |
| release | Graphite's merge queue (`gtmq_*`), pushes to main or dev | Everything |

How it decides:

1. **Release** for anything that isn't a `pull_request` event, and for merge-queue PRs. Those are
   drafts, so this check comes first.
2. **Always** for a draft PR.
3. For a ready PR, it walks up the stack: the open PRs based on this PR's branch, then the PRs based
   on theirs, and so on, every branch of a forked stack included. PRs are marked ready bottom-up, so
   if there's no ready PR anywhere above, this is the highest ready PR and gets **ready**. Otherwise
   it gets **unit**.
4. If the GitHub API call fails, it logs a warning and gives **ready**: running too much costs
   minutes, running too little lets breakage through.

The tier is logged as a notice and in the job summary.

## Usage

The calling workflow needs to trigger on `ready_for_review` and `converted_to_draft`, so a PR gets a
new run when its state changes, and the plan job needs `pull-requests: read`.

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review, converted_to_draft]

jobs:
  plan:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read
    outputs:
      tier: ${{ steps.tier.outputs.tier }}
      run_unit: ${{ steps.tier.outputs.run-unit }}
      run_ready: ${{ steps.tier.outputs.run-ready }}
      run_release: ${{ steps.tier.outputs.run-release }}
    steps:
      - id: tier
        uses: StaflSystems/CustomGitHubActions/PlanCITier@main
        with:
          mode: ${{ vars.CI_TIER_MODE || 'on' }}

  unit-tests:
    needs: plan
    if: needs.plan.outputs.run_unit == 'true'
    # ...
```

Set the repository variable `CI_TIER_MODE` to `off` to run everything on every run without a code
change. That's the rollback.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `token` | `github.token` | Token that can list the repository's pull requests |
| `mode` | `on` | `on` picks a tier; `off` gives every run the release tier |
| `max-stack-depth` | `30` | How many PRs up the stack to look for a ready PR |

## Outputs

`tier` (`always`, `unit`, `ready` or `release`), and `run-unit`, `run-ready` and `run-release`,
each `'true'` or `'false'`.

## Tests

```bash
node --test PlanCITier/
```
