// Run with: node --test AssignReviewers/
const test = require('node:test');
const assert = require('node:assert');
const assign = require('./assign.js');

const STAFF = ['staffA', 'staffB', 'staffC'];
const EVERYONE = [...STAFF, 'devD', 'devE', 'devF'];

// A fake GitHub: open PRs keyed by number, team membership, per-user load and Busy status.
function fakeGithub({ prs, load = {}, busy = [] }) {
  const calls = { assign: [], unassign: [], review: [], graphql: 0 };
  const byNumber = new Map(prs.map((p) => [p.number, { assignees: [], requested: [], teams: [], reviews: [], ...p }]));
  const teams = { embeddedreviewersstaff: STAFF, embeddedreviewers: EVERYONE };
  const user = (login) => ({ login, type: 'User' });
  const github = {
    paginate: async (fn, params) => (await fn(params)).data,
    graphql: async (query) => {
      calls.graphql++;
      const out = {};
      for (const [, key, login] of query.matchAll(/(l\d+): search\(query: "[^"]*assignee:([^"]+)"/g)) {
        out[key] = { issueCount: load[login] ?? 0 };
      }
      for (const [, key, login] of query.matchAll(/(u\d+): user\(login: "([^"]+)"\)/g)) {
        out[key] = { status: { indicatesLimitedAvailability: busy.includes(login) } };
      }
      return out;
    },
    rest: {
      pulls: {
        get: async ({ pull_number }) => {
          const p = byNumber.get(pull_number);
          return {
            data: {
              user: user(p.author),
              assignees: p.assignees.map(user),
              requested_reviewers: p.requested.map(user),
              requested_teams: p.teams.map((slug) => ({ slug })),
            },
          };
        },
        list: async ({ head }) => ({
          data: [...byNumber.values()]
            .filter((p) => `StaflSystems:${p.head}` === head)
            .map((p) => ({ number: p.number, draft: Boolean(p.draft), base: { ref: p.base } })),
        }),
        listReviews: async ({ pull_number }) => ({
          data: byNumber.get(pull_number).reviews.map(([login, state]) => ({ user: user(login), state })),
        }),
        requestReviewers: async ({ pull_number, reviewers = [], team_reviewers = [] }) => {
          calls.review.push({ pull_number, reviewers, team_reviewers });
          const p = byNumber.get(pull_number);
          p.requested.push(...reviewers);
          p.teams.push(...team_reviewers);
        },
      },
      issues: {
        addAssignees: async ({ issue_number, assignees }) => {
          calls.assign.push(...assignees);
          byNumber.get(issue_number).assignees.push(...assignees);
        },
        removeAssignees: async ({ issue_number, assignees }) => {
          calls.unassign.push(...assignees);
          const p = byNumber.get(issue_number);
          p.assignees = p.assignees.filter((a) => !assignees.includes(a));
        },
      },
      teams: {
        listMembersInOrg: async ({ team_slug }) => ({ data: teams[team_slug].map(user) }),
      },
    },
  };
  return { github, calls, pr: (n) => byNumber.get(n) };
}

function run(fake, number, overrides = {}, onSleep = () => {}) {
  const pr = fake.pr(number);
  const logs = [];
  const core = { info: (m) => logs.push(m), warning: (m) => logs.push(`WARN ${m}`) };
  const context = {
    repo: { owner: 'StaflSystems', repo: 'StaflLib' },
    payload: {
      pull_request: {
        number,
        draft: false,
        user: { login: pr.author, type: 'User' },
        head: { ref: pr.head },
        base: { ref: pr.base },
        ...overrides,
      },
    },
  };
  const inputs = { rotationTeam: 'embeddedreviewers', domainTeam: 'embeddedreviewersstaff' };
  return assign({ github: fake.github, context, core, inputs, sleep: async () => onSleep() }).then(() => logs);
}

const isStaff = (login) => STAFF.includes(login);

test('bottom of stack: least-loaded staff approver and rotation reviewer, whole team requested', async () => {
  const fake = fakeGithub({
    prs: [{ number: 10, author: 'devE', head: 'a', base: 'main' }],
    load: { staffA: 5, staffB: 1, staffC: 3, devD: 4, devF: 0 },
  });
  await run(fake, 10);
  assert.deepStrictEqual(fake.pr(10).assignees, ['staffB', 'devF']);
  assert.deepStrictEqual(fake.pr(10).teams, ['embeddedreviewers']);
});

test('staff author is never an assignee', async () => {
  const fake = fakeGithub({ prs: [{ number: 11, author: 'staffA', head: 'a', base: 'main' }] });
  await run(fake, 11);
  const assignees = fake.pr(11).assignees;
  assert.strictEqual(assignees.length, 2);
  assert.ok(!assignees.includes('staffA'));
  assert.ok(assignees.some(isStaff));
});

test('mid-stack: copies the assignees of the PR below without picking anyone', async () => {
  const fake = fakeGithub({
    prs: [
      { number: 20, author: 'devE', head: 'a', base: 'main', assignees: ['staffC', 'devD'] },
      { number: 21, author: 'devE', head: 'b', base: 'a' },
    ],
  });
  await run(fake, 21);
  assert.deepStrictEqual(fake.pr(21).assignees.sort(), ['devD', 'staffC']);
  assert.strictEqual(fake.calls.graphql, 0);
});

test('skips a draft parent with no assignees and inherits from further down', async () => {
  const fake = fakeGithub({
    prs: [
      { number: 30, author: 'devE', head: 'a', base: 'main', assignees: ['staffB', 'devF'] },
      { number: 31, author: 'devE', head: 'b', base: 'a', draft: true },
      { number: 32, author: 'devE', head: 'c', base: 'b' },
    ],
  });
  await run(fake, 32);
  assert.deepStrictEqual(fake.pr(32).assignees.sort(), ['devF', 'staffB']);
});

test('waits for a ready parent submitted in the same stack to get its assignees', async () => {
  const fake = fakeGithub({
    prs: [
      { number: 90, author: 'devE', head: 'a', base: 'main' },
      { number: 91, author: 'devE', head: 'b', base: 'a' },
    ],
  });
  let sleeps = 0;
  // The parent's own run assigns its reviewers while the child is waiting.
  await run(fake, 91, {}, () => {
    if (++sleeps === 2) fake.pr(90).assignees.push('staffC', 'devF');
  });
  assert.deepStrictEqual(fake.pr(91).assignees.sort(), ['devF', 'staffC']);
  assert.strictEqual(fake.calls.graphql, 0);
});

test('fills the domain approver when the stack only had a rotation assignee', async () => {
  const fake = fakeGithub({
    prs: [
      { number: 40, author: 'devE', head: 'a', base: 'main', assignees: ['devD'] },
      { number: 41, author: 'devE', head: 'b', base: 'a' },
    ],
    load: { staffA: 2, staffB: 0, staffC: 2 },
  });
  await run(fake, 41);
  assert.deepStrictEqual(fake.pr(41).assignees.sort(), ['devD', 'staffB']);
});

test('skips people whose GitHub status is Busy', async () => {
  const fake = fakeGithub({
    prs: [{ number: 50, author: 'devE', head: 'a', base: 'main' }],
    load: { staffA: 0, staffB: 3, staffC: 3, devD: 0, devF: 1 },
    busy: ['staffA', 'devD'],
  });
  await run(fake, 50);
  const assignees = fake.pr(50).assignees;
  assert.ok(!assignees.includes('staffA') && !assignees.includes('devD'));
  assert.ok(assignees.includes('devF'));
});

test('ties rotate by PR number rather than always going to the same person', async () => {
  const picks = new Set();
  for (const number of [60, 61, 62]) {
    const fake = fakeGithub({ prs: [{ number, author: 'devE', head: 'a', base: 'main' }] });
    await run(fake, number);
    picks.add(fake.pr(number).assignees.find(isStaff));
  }
  assert.strictEqual(picks.size, 3);
});

test("replaces an author's self-assignment", async () => {
  const fake = fakeGithub({ prs: [{ number: 70, author: 'devE', head: 'a', base: 'main', assignees: ['devE'] }] });
  await run(fake, 70);
  assert.deepStrictEqual(fake.calls.unassign, ['devE']);
  assert.ok(!fake.pr(70).assignees.includes('devE'));
  assert.strictEqual(fake.pr(70).assignees.length, 2);
});

test('keeps hand-picked assignees and does not re-request a team someone already reviewed for', async () => {
  const fake = fakeGithub({
    prs: [
      {
        number: 71,
        author: 'devE',
        head: 'a',
        base: 'main',
        assignees: ['staffB', 'devF'],
        reviews: [['staffB', 'APPROVED']],
      },
    ],
  });
  await run(fake, 71);
  assert.deepStrictEqual(fake.calls.assign, []);
  assert.ok(fake.calls.review.every((c) => c.team_reviewers.length === 0));
  // devF hasn't reviewed or been requested, so they're requested individually.
  assert.deepStrictEqual(fake.pr(71).requested, ['devF']);
});

test('requests an assignee from outside the team individually', async () => {
  const fake = fakeGithub({
    prs: [
      { number: 72, author: 'devE', head: 'a', base: 'main', assignees: ['staffA', 'ownerX'] },
      { number: 73, author: 'devE', head: 'b', base: 'a' },
    ],
  });
  await run(fake, 73);
  assert.deepStrictEqual(fake.pr(73).teams, ['embeddedreviewers']);
  assert.deepStrictEqual(fake.pr(73).requested, ['ownerX']);
});

test('ignores drafts, bots and merge-queue PRs', async () => {
  const fake = fakeGithub({ prs: [{ number: 80, author: 'devE', head: 'gtmq_1', base: 'main' }] });
  await run(fake, 80, { draft: true });
  await run(fake, 80, { user: { login: 'graphite-app[bot]', type: 'Bot' } });
  await run(fake, 80);
  assert.deepStrictEqual(fake.calls, { assign: [], unassign: [], review: [], graphql: 0 });
});

test('still assigns when the load and status query fails', async () => {
  const fake = fakeGithub({ prs: [{ number: 95, author: 'devE', head: 'a', base: 'main' }] });
  fake.github.graphql = async () => {
    throw new Error('Resource not accessible by integration');
  };
  const logs = await run(fake, 95);
  assert.strictEqual(fake.pr(95).assignees.length, 2);
  assert.ok(logs.some((l) => l.startsWith('WARN')));
});
