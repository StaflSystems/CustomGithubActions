// Picks the CI tier for a workflow run (CI spend RFC, Proposal 1). Tiers are cumulative, so each
// one also runs everything in the tiers before it:
//
//   always   every push, draft or ready: plan step, formatting and lint
//   unit     every ready PR, anywhere in its stack: full unit test suites with coverage
//   ready    the highest ready PR in each stack: plus a GCC and an IAR build, SIL tests, Axivion
//   release  Graphite's merge queue and pushes to main or dev: everything
//
// PRs are marked ready bottom-up, so the highest ready PR is the one with no open, ready PR
// anywhere above it. "Above" comes from PR base branches: the PRs based on this PR's branch, then
// the PRs based on theirs, and so on. Graphite's merge-queue PRs (gtmq_*) are drafts, so they're
// checked before the draft rule.

const TIERS = ['always', 'unit', 'ready', 'release'];

function isMergeQueue(ref) {
  return ref.startsWith('gtmq_');
}

// Returns the number of the nearest open, ready PR above `headRef`, or null if there is none.
// Walks every branch of the stack, since a Graphite stack can fork.
async function readyPrAbove(github, owner, repo, headRef, maxDepth) {
  const seen = new Set([headRef]);
  let frontier = [headRef];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next = [];
    for (const base of frontier) {
      const children = await github.paginate(github.rest.pulls.list, { owner, repo, state: 'open', base, per_page: 100 });
      for (const child of children) {
        if (isMergeQueue(child.head.ref)) continue;
        if (!child.draft) return child.number;
        if (!seen.has(child.head.ref)) {
          seen.add(child.head.ref);
          next.push(child.head.ref);
        }
      }
    }
    frontier = next;
  }
  return null;
}

async function pickTier({ github, context, core, mode, maxDepth }) {
  if (mode === 'off') return { tier: 'release', reason: 'CI_TIER_MODE is off, so everything runs' };
  if (context.eventName !== 'pull_request') return { tier: 'release', reason: `${context.eventName} event` };

  const pr = context.payload.pull_request;
  if (isMergeQueue(pr.head.ref)) return { tier: 'release', reason: 'Graphite merge-queue PR' };
  if (pr.draft) return { tier: 'always', reason: 'draft PR' };

  const { owner, repo } = context.repo;
  try {
    const above = await readyPrAbove(github, owner, repo, pr.head.ref, maxDepth);
    if (above) return { tier: 'unit', reason: `ready PR #${above} is above it in the stack` };
    return { tier: 'ready', reason: 'highest ready PR in its stack' };
  } catch (err) {
    // Fail open: running too much costs minutes, running too little lets breakage through.
    core.warning(`Couldn't read the stack above this PR, so running the ready tier: ${err.message}`);
    return { tier: 'ready', reason: 'stack lookup failed' };
  }
}

module.exports = async function planTier({ github, context, core, inputs }) {
  const mode = (inputs.mode || 'on').trim().toLowerCase();
  if (mode !== 'on' && mode !== 'off') {
    core.warning(`Unknown CI_TIER_MODE '${inputs.mode}', treating it as 'on'.`);
  }
  const maxDepth = Number(inputs.maxStackDepth) || 30;
  const { tier, reason } = await pickTier({ github, context, core, mode, maxDepth });

  const level = TIERS.indexOf(tier);
  core.setOutput('tier', tier);
  core.setOutput('run-unit', String(level >= TIERS.indexOf('unit')));
  core.setOutput('run-ready', String(level >= TIERS.indexOf('ready')));
  core.setOutput('run-release', String(level >= TIERS.indexOf('release')));
  core.notice(`CI tier: ${tier} (${reason})`);
  await core.summary.addRaw(`CI tier: **${tier}** (${reason})`, true).write();
  return { tier, reason };
};
