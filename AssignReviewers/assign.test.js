// Run with: node --test AssignReviewers/
const test = require('node:test');
const assert = require('node:assert');
const assign = require('./assign.js');

const STAFF = ['staffA', 'staffB', 'staffC'];
const EVERYONE = [...STAFF, 'devD', 'devE', 'devF'];

// A fake GitHub: open PRs keyed by number, team membership and per-user load.
function fakeGithub({ prs, load = {} }) {
  const calls = { assign: [], unassign: [], review: [], graphql: 0 };
  const byNumber = new Map(prs.map((p) => [p.number, { assignees: [], requested: [], teams: [], reviews: [], ...p }]));
  const teams = { embeddedreviewersstaff: STAFF, embeddedreviewers: EVERYONE };
  const user = (login) => ({ login, type: 'User' });
  const github = {
    paginate: async (fn, params) => (await fn(params)).data,
    // Serves the load query from the fake PRs, as GitHub would.
    graphql: async () => {
      calls.graphql++;
      const out = {
        organization: {
          repositories: {
            nodes: [
              {
                pullRequests: {
                  nodes: [
                    ...[...byNumber.values()].map((p) => ({
                      isDraft: Boolean(p.draft),
                      assignees: { nodes: p.assignees.map((login) => ({ login })) },
                    })),
                    // PRs in other repos, one per unit of preset load.
                    ...Object.entries(load).flatMap(([login, n]) =>
                      Array.from({ length: n }, () => ({ isDraft: false, assignees: { nodes: [{ login }] } })),
                    ),
                  ],
                },
              },
            ],
          },
        },
      };
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

// A PTO calendar feed with all-day entries: [name, kind, first date, last date].
function ptoFeed(entries) {
  const day = (d) => d.replaceAll('-', '');
  const next = (d) => new Date(Date.parse(`${d}T12:00:00Z`) + 864e5).toISOString().slice(0, 10);
  const events = entries.map(
    ([name, kind, first, last = first]) =>
      `BEGIN:VEVENT\r\nDTSTART;VALUE=DATE:${day(first)}\r\nDTEND;VALUE=DATE:${day(next(last))}\r\nSUMMARY:${name} ${kind}\r\nEND:VEVENT`,
  );
  return ['BEGIN:VCALENDAR', ...events, 'END:VCALENDAR'].join('\r\n');
}

// Thursday Oct 1, 2026, 10:00 Pacific.
const THURSDAY = new Date('2026-10-01T17:00:00Z');
const PEOPLE = Object.fromEntries(EVERYONE.map((login) => [login, { name: `Person ${login}` }]));

function withPto(entries, fetches = []) {
  return {
    ptoCalendarUrl: 'https://calendar.example/pto.ics',
    pto: {
      now: THURSDAY,
      people: PEOPLE,
      holidays: { 2026: [] },
      fetch: async (url) => {
        fetches.push(url);
        return { ok: true, status: 200, text: async () => ptoFeed(entries) };
      },
    },
  };
}

function run(fake, number, overrides = {}, onSleep = () => {}, extraInputs = {}) {
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
  const inputs = { rotationTeam: 'embeddedreviewers', domainTeam: 'embeddedreviewersstaff', ...extraInputs };
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

test('skips people the PTO calendar has out today or next business day', async () => {
  const fake = fakeGithub({
    prs: [{ number: 50, author: 'devE', head: 'a', base: 'main' }],
    load: { staffA: 0, staffB: 3, staffC: 3, devD: 0, devF: 1 },
  });
  const pto = withPto([
    ['Person staffA', 'is Out of Office', '2026-10-01'],
    ['Person devD', 'on Vacation', '2026-10-02', '2026-10-09'],
  ]);
  await run(fake, 50, {}, undefined, pto);
  const assignees = fake.pr(50).assignees;
  assert.ok(!assignees.includes('staffA') && !assignees.includes('devD'));
  assert.ok(assignees.includes('devF'));
});

test('Work From Home and time off after the next business day do not count as out', async () => {
  const fake = fakeGithub({
    prs: [{ number: 51, author: 'devE', head: 'a', base: 'main' }],
    load: { staffA: 0, staffB: 3, staffC: 3, devD: 0, devF: 1 },
  });
  const pto = withPto([
    ['Person staffA', 'on Work From Home', '2026-10-01'],
    ['Person devD', 'is Out of Office', '2026-10-05'],
  ]);
  await run(fake, 51, {}, undefined, pto);
  assert.deepStrictEqual(fake.pr(51).assignees, ['staffA', 'devD']);
});

test('still assigns, with a warning, when the PTO calendar cannot be read', async () => {
  const fake = fakeGithub({ prs: [{ number: 52, author: 'devE', head: 'a', base: 'main' }] });
  const pto = withPto([]);
  pto.pto.fetch = async () => ({ ok: false, status: 403, text: async () => '' });
  const logs = await run(fake, 52, {}, undefined, pto);
  assert.strictEqual(fake.pr(52).assignees.length, 2);
  assert.ok(logs.some((l) => l === "WARN Couldn't read the PTO calendar (HTTP 403); not checking who is out."));
  assert.ok(logs.every((l) => !l.includes('calendar.example')));
});

test('does not read the PTO calendar when the stack already has its assignees', async () => {
  const fake = fakeGithub({
    prs: [
      { number: 53, author: 'devE', head: 'a', base: 'main', assignees: ['staffC', 'devD'] },
      { number: 54, author: 'devE', head: 'b', base: 'a' },
    ],
  });
  const fetches = [];
  await run(fake, 54, {}, undefined, withPto([], fetches));
  assert.deepStrictEqual(fetches, []);
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

test('still assigns when the load query fails', async () => {
  const fake = fakeGithub({ prs: [{ number: 95, author: 'devE', head: 'a', base: 'main' }] });
  fake.github.graphql = async () => {
    throw new Error('Resource not accessible by integration');
  };
  const logs = await run(fake, 95);
  assert.strictEqual(fake.pr(95).assignees.length, 2);
  assert.ok(logs.some((l) => l.startsWith('WARN')));
});

test('counts assignments made moments ago by other runs', async () => {
  // Two PRs opened back to back: the second must see the first one's fresh assignment.
  const fake = fakeGithub({
    prs: [
      { number: 100, author: 'devE', head: 'a', base: 'main' },
      { number: 102, author: 'devE', head: 'b', base: 'main' },
    ],
    load: { staffB: 1 },
  });
  await run(fake, 100);
  await run(fake, 102);
  const firstStaff = fake.pr(100).assignees.find(isStaff);
  const secondStaff = fake.pr(102).assignees.find(isStaff);
  assert.notStrictEqual(firstStaff, secondStaff);
});

test('ignores draft PRs when counting load', async () => {
  const fake = fakeGithub({
    prs: [
      { number: 110, author: 'devE', head: 'x', base: 'main', draft: true, assignees: ['staffA', 'staffA'] },
      { number: 111, author: 'devE', head: 'a', base: 'main' },
    ],
    load: { staffB: 1, staffC: 1 },
  });
  await run(fake, 111);
  assert.ok(fake.pr(111).assignees.includes('staffA'));
});

test("follows a busy repo's second page of open PRs when counting load", async () => {
  const fake = fakeGithub({ prs: [{ number: 120, author: 'devE', head: 'a', base: 'main' }] });
  const assigned = (logins) => logins.map((login) => ({ isDraft: false, assignees: { nodes: [{ login }] } }));
  fake.github.graphql = async (query, vars) => {
    if (query.includes('repository(owner')) {
      assert.strictEqual(vars.after, 'cursor1');
      // The second page is where staffA's and staffB's load is.
      return { repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes: assigned(['staffA', 'staffB']) } } };
    }
    return {
      organization: {
        repositories: {
          nodes: [{ name: 'StaflLib', pullRequests: { pageInfo: { hasNextPage: true, endCursor: 'cursor1' }, nodes: [] } }],
        },
      },
    };
  };
  await run(fake, 120);
  assert.ok(fake.pr(120).assignees.includes('staffC'));
});
