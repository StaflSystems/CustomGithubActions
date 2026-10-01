// Run with: node --test PlanCITier/
const test = require('node:test');
const assert = require('node:assert');
const planTier = require('./plan.js');

// A fake GitHub serving open PRs by base branch. Each PR: { number, head, base, draft }.
function fakeGithub(prs, { fail = false } = {}) {
  const github = {
    calls: 0,
    paginate: async (fn, params) => (await fn(params)).data,
    rest: {
      pulls: {
        list: async ({ base, state }) => {
          github.calls++;
          if (fail) throw new Error('API rate limit exceeded');
          assert.strictEqual(state, 'open');
          const data = prs
            .filter((p) => p.base === base)
            .map((p) => ({ number: p.number, draft: Boolean(p.draft), head: { ref: p.head }, base: { ref: p.base } }));
          return { data };
        },
      },
    },
  };
  return github;
}

function fakeCore() {
  const core = { outputs: {}, notices: [], warnings: [] };
  core.setOutput = (k, v) => (core.outputs[k] = v);
  core.notice = (m) => core.notices.push(m);
  core.warning = (m) => core.warnings.push(m);
  core.summary = { addRaw: () => core.summary, write: async () => {} };
  return core;
}

function prContext(head, { draft = false, base = 'main' } = {}) {
  return {
    eventName: 'pull_request',
    repo: { owner: 'StaflSystems', repo: 'StaflLib' },
    payload: { pull_request: { number: 1, draft, head: { ref: head }, base: { ref: base } } },
  };
}

async function run(context, prs = [], { mode = 'on', fail = false } = {}) {
  const core = fakeCore();
  const github = fakeGithub(prs, { fail });
  await planTier({ github, context, core, inputs: { mode, maxStackDepth: '30' } });
  return { ...core.outputs, core, github };
}

test('push to main or dev runs everything', async () => {
  for (const ref of ['refs/heads/main', 'refs/heads/dev/1.2']) {
    const out = await run({ eventName: 'push', ref, repo: { owner: 'o', repo: 'r' }, payload: {} });
    assert.deepStrictEqual([out.tier, out['run-unit'], out['run-ready'], out['run-release']], ['release', 'true', 'true', 'true']);
  }
});

test('merge-queue PRs are drafts but run everything', async () => {
  const out = await run(prContext('gtmq_spec_abc123_1790', { draft: true }));
  assert.strictEqual(out.tier, 'release');
  assert.strictEqual(out.github.calls, 0);
});

test('a draft runs only the always tier', async () => {
  const out = await run(prContext('feature/a', { draft: true }));
  assert.deepStrictEqual([out.tier, out['run-unit'], out['run-ready'], out['run-release']], ['always', 'false', 'false', 'false']);
  assert.strictEqual(out.github.calls, 0);
});

test('a ready PR with nothing above it gets the ready tier', async () => {
  const out = await run(prContext('feature/a'));
  assert.deepStrictEqual([out.tier, out['run-unit'], out['run-ready'], out['run-release']], ['ready', 'true', 'true', 'false']);
});

test('a ready PR with only drafts above it is the highest ready PR', async () => {
  const stack = [
    { number: 2, head: 'feature/b', base: 'feature/a', draft: true },
    { number: 3, head: 'feature/c', base: 'feature/b', draft: true },
  ];
  const out = await run(prContext('feature/a'), stack);
  assert.strictEqual(out.tier, 'ready');
});

test('a ready PR with a ready PR above it gets the unit tier', async () => {
  const stack = [{ number: 2, head: 'feature/b', base: 'feature/a', draft: false }];
  const out = await run(prContext('feature/a'), stack);
  assert.deepStrictEqual([out.tier, out['run-unit'], out['run-ready']], ['unit', 'true', 'false']);
  assert.match(out.core.notices[0], /#2/);
});

test('a ready PR further up, past a draft, still counts as above', async () => {
  const stack = [
    { number: 2, head: 'feature/b', base: 'feature/a', draft: true },
    { number: 3, head: 'feature/c', base: 'feature/b', draft: false },
  ];
  const out = await run(prContext('feature/a'), stack);
  assert.strictEqual(out.tier, 'unit');
});

test('a forked stack: a ready PR on either branch counts', async () => {
  const stack = [
    { number: 2, head: 'feature/b1', base: 'feature/a', draft: true },
    { number: 3, head: 'feature/b2', base: 'feature/a', draft: true },
    { number: 4, head: 'feature/c2', base: 'feature/b2', draft: false },
  ];
  const out = await run(prContext('feature/a'), stack);
  assert.strictEqual(out.tier, 'unit');
});

test('merge-queue PRs based on the branch are ignored', async () => {
  const stack = [{ number: 9, head: 'gtmq_spec_x', base: 'feature/a', draft: false }];
  const out = await run(prContext('feature/a'), stack);
  assert.strictEqual(out.tier, 'ready');
});

test('the walk stops at the depth limit', async () => {
  const stack = Array.from({ length: 40 }, (_, i) => ({ number: i + 2, head: `s${i + 1}`, base: `s${i}`, draft: i < 39 }));
  const out = await run(prContext('s0'), stack);
  assert.strictEqual(out.tier, 'ready'); // the ready PR sits 40 deep, past the limit of 30
  assert.strictEqual(out.github.calls, 30);
});

test('an API error fails open to the ready tier with a warning', async () => {
  const out = await run(prContext('feature/a'), [], { fail: true });
  assert.strictEqual(out.tier, 'ready');
  assert.strictEqual(out.core.warnings.length, 1);
});

test('CI_TIER_MODE=off runs everything, even on drafts', async () => {
  const out = await run(prContext('feature/a', { draft: true }), [], { mode: 'off' });
  assert.strictEqual(out.tier, 'release');
});

test('an unknown mode warns and behaves as on', async () => {
  const out = await run(prContext('feature/a', { draft: true }), [], { mode: 'shadow' });
  assert.strictEqual(out.tier, 'always');
  assert.strictEqual(out.core.warnings.length, 1);
});
