// Run with: node --test ReviewSLA/
const test = require('node:test');
const assert = require('node:assert');
const run = require('./run.js');
const { MARKER } = require('./comment.js');

const STAFF = ['ghopper', 'mhamilton'];
const EVERYONE = [...STAFF, 'kjohnson', 'dvaughan', 'alovelace'];
const PEOPLE = Object.fromEntries(EVERYONE.map((login, i) => [login, { name: `Person ${login}`, slack: `U00${i}` }]));
const HOLIDAYS = { 2026: [{ date: '2026-11-26' }, { date: '2026-11-27' }] };
const PTO_URL = 'https://calendar.example/pto.ics';

// Thursday Oct 1, 2026, 10:00 Pacific.
const OPENED = '2026-10-01T17:00:00Z';

const userNode = (login) => ({ __typename: 'User', login });
const reviewItem = (login, state, iso, databaseId = 1) => ({ __typename: 'PullRequestReview', databaseId, state, submittedAt: iso, body: 'ok', comments: { totalCount: 0 }, author: userNode(login) });
const requestedItem = (login, iso) => ({ __typename: 'ReviewRequestedEvent', createdAt: iso, requestedReviewer: userNode(login) });

// A fake org: open PRs (as GraphQL nodes, rebuilt on every query so comments written by one run
// are read by the next), teams, Slack, Confluence and the PTO calendar.
function world({ prs, out = [], failRepo, failComments = false, isPrivate = true }) {
  const calls = { dms: [], posts: [], comments: [], edits: [], assign: [], unassign: [], requested: [], puts: [], graphql: 0 };
  const state = new Map(prs.map((p) => [p.number, { repo: 'StaflLib', author: 'alovelace', base: 'main', isDraft: false, additions: 300, timeline: [], assignees: [], comments: [], headRefOid: 'head', reviewCommits: {}, ...p }]));
  let commentId = 100;
  let page = { title: 'Review Dashboard', version: { number: 3, message: '' } };
  const asNode = (p) => ({
    number: p.number,
    url: `https://github.com/StaflSystems/${p.repo}/pull/${p.number}`,
    title: `PR ${p.number}`,
    isDraft: p.isDraft,
    additions: p.additions,
    headRefName: p.head,
    headRefOid: p.headRefOid,
    baseRefName: p.base,
    createdAt: OPENED,
    author: userNode(p.author),
    assignees: { nodes: p.assignees.map((login) => ({ login })) },
    comments: { nodes: p.comments },
    timelineItems: { pageInfo: { hasPreviousPage: false }, nodes: p.timeline },
  });
  const github = {
    paginate: async (fn, params) => (await fn(params)).data,
    graphql: async (query, vars) => {
      calls.graphql++;
      if (query.includes('organization(login')) {
        return { organization: { repositories: { nodes: [{ name: 'StaflLib', pullRequests: { nodes: [] } }] } } };
      }
      if (vars.name === failRepo) throw new Error('HTTP 502');
      const nodes = [...state.values()].filter((p) => p.repo === vars.name).map(asNode);
      return { repository: { isPrivate, pullRequests: { pageInfo: { hasNextPage: false }, nodes } } };
    },
    rest: {
      teams: {
        listMembersInOrg: async ({ team_slug }) => ({ data: (team_slug === 'embeddedreviewersstaff' ? STAFF : EVERYONE).map((login) => ({ login })) }),
      },
      issues: {
        createComment: async ({ issue_number, body }) => {
          if (failComments) throw new Error('HTTP 500');
          calls.comments.push({ issue_number, body });
          state.get(issue_number).comments.push({ databaseId: commentId++, body });
        },
        updateComment: async ({ comment_id, body }) => {
          calls.edits.push({ comment_id, body });
          for (const p of state.values()) for (const c of p.comments) if (c.databaseId === comment_id) c.body = body;
        },
        addAssignees: async ({ issue_number, assignees }) => {
          calls.assign.push([issue_number, ...assignees]);
          state.get(issue_number).assignees.push(...assignees);
        },
        removeAssignees: async ({ issue_number, assignees }) => {
          calls.unassign.push([issue_number, ...assignees]);
          const p = state.get(issue_number);
          p.assignees = p.assignees.filter((a) => !assignees.includes(a));
        },
      },
      pulls: {
        requestReviewers: async ({ pull_number, reviewers }) => calls.requested.push([pull_number, ...reviewers]),
        listReviews: async ({ pull_number }) => {
          calls.listReviews = (calls.listReviews ?? 0) + 1;
          return { data: Object.entries(state.get(pull_number).reviewCommits).map(([id, commit_id]) => ({ id: Number(id), commit_id })) };
        },
      },
    },
  };
  const fetch = async (url, options = {}) => {
    if (url === PTO_URL) {
      const day = (d) => d.replaceAll('-', '');
      const events = out.map(([name, date]) => `BEGIN:VEVENT\r\nDTSTART;VALUE=DATE:${day(date)}\r\nSUMMARY:${name} is Out of Office\r\nEND:VEVENT`);
      return { ok: true, status: 200, text: async () => ['BEGIN:VCALENDAR', ...events, 'END:VCALENDAR'].join('\r\n') };
    }
    if (url.startsWith('https://slack.com/')) {
      const message = JSON.parse(options.body);
      (message.channel.startsWith('U') ? calls.dms : calls.posts).push(message);
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (url.includes('/rest/api/content/')) {
      if (options.method === 'PUT') {
        const update = JSON.parse(options.body);
        calls.puts.push(update);
        page = { title: update.title, version: update.version };
        return { ok: true, status: 200, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => page };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { github, fetch, calls, pr: (n) => state.get(n) };
}

function logger() {
  const logs = [];
  return { logs, core: { info: (m) => logs.push(m), warning: (m) => logs.push(`WARN ${m}`) } };
}

const INPUTS = {
  repos: 'StaflLib',
  rotationTeam: 'embeddedreviewers',
  domainTeam: 'embeddedreviewersstaff',
  people: JSON.stringify(PEOPLE),
  ptoCalendarUrl: PTO_URL,
  slackToken: 'xoxb-test',
  slackChannel: 'C123',
  confluenceUrl: 'https://example.atlassian.net/wiki',
  confluenceUser: 'sla@example.com',
  confluenceToken: 'token',
  confluencePageId: '42',
  dashboardUrl: 'https://example.atlassian.net/wiki/spaces/EM/pages/42',
  eventName: 'schedule',
  schedule: '*/30 17-23 * * 1-5',
};

async function go(w, { mode = 'remind', now, inputs = {} } = {}) {
  const { core, logs } = logger();
  const result = await run({ github: w.github, core, fetch: w.fetch, holidays: HOLIDAYS, now: new Date(now), inputs: { ...INPUTS, mode, ...inputs } });
  return { logs, result };
}

// One standard PR opened ready at 10:00 Thursday, due at 17:00.
const onePr = (extra = {}) => ({ number: 1, head: 'feature/a', assignees: ['ghopper', 'kjohnson'], ...extra });

test('off does nothing at all', async () => {
  const w = world({ prs: [onePr()] });
  const { logs } = await go(w, { mode: 'off', now: '2026-10-02T00:00:00Z' });
  assert.strictEqual(w.calls.graphql, 0);
  assert.deepStrictEqual(logs, ['REVIEW_SLA_MODE is off: nothing to do.']);
});

test('scheduled runs outside business hours do nothing', async () => {
  const w = world({ prs: [onePr()] });
  await go(w, { now: '2026-10-03T19:00:00Z' }); // Saturday
  await go(w, { now: '2026-10-01T15:00:00Z' }); // 08:00 Thursday
  assert.strictEqual(w.calls.graphql, 0);
});

test('shadow keeps the comment and dashboard but sends no reminders and reassigns nobody', async () => {
  const w = world({ prs: [onePr()], out: [['Person ghopper', '2026-10-02']] });
  await go(w, { mode: 'shadow', now: '2026-10-02T00:00:00Z' });
  assert.strictEqual(w.calls.comments.length, 1);
  assert.ok(w.calls.comments[0].body.startsWith(`${MARKER} {"reminded":[]} -->`));
  assert.match(w.calls.comments[0].body, /\| `ghopper` \| First response \| Thu Oct 1, 17:00 PT \| Overdue \|/);
  assert.deepStrictEqual([w.calls.dms, w.calls.assign], [[], []]);
  assert.strictEqual(w.calls.puts.length, 1);
});

test('remind DMs each overdue assignee once, however many runs see it', async () => {
  const w = world({ prs: [onePr()] });
  await go(w, { now: '2026-10-01T23:30:00Z' });
  assert.deepStrictEqual(w.calls.dms, []);
  await go(w, { now: '2026-10-02T00:00:00Z' });
  assert.deepStrictEqual(w.calls.dms.map((m) => m.channel).sort(), ['U000', 'U002']);
  assert.match(w.calls.dms[0].text, /^Review due: <https:\/\/app.graphite.com\/github\/pr\/StaflSystems\/StaflLib\/1\|StaflLib#1: PR 1>\. As an assignee, your first response was due at Thu Oct 1, 17:00 PT\.$/);
  await go(w, { now: '2026-10-02T17:30:00Z' });
  assert.strictEqual(w.calls.dms.length, 2);
  // One comment, edited in place.
  assert.strictEqual(w.calls.comments.length, 1);
});

test('a re-request after a push since the review starts a re-review clock; without one, nothing', async () => {
  const timeline = [reviewItem('ghopper', 'CHANGES_REQUESTED', '2026-10-01T18:00:00Z', 7), reviewItem('kjohnson', 'APPROVED', '2026-10-01T18:00:00Z', 8), requestedItem('ghopper', '2026-10-01T20:00:00Z')];
  const pushed = world({ prs: [onePr({ timeline, headRefOid: 'bbb', reviewCommits: { 7: 'aaa', 8: 'aaa' } })] });
  await go(pushed, { now: '2026-10-01T21:00:00Z' });
  assert.match(pushed.calls.comments[0].body, /\| `ghopper` \| Re-review \| Thu Oct 1, 17:00 PT \| {2}\|/);
  const resubmitted = world({ prs: [onePr({ timeline, headRefOid: 'aaa', reviewCommits: { 7: 'aaa', 8: 'aaa' } })] });
  await go(resubmitted, { now: '2026-10-01T21:00:00Z' });
  assert.deepStrictEqual(resubmitted.calls.comments, []);
  // Only PRs with a re-request after a review need the extra call.
  const plain = world({ prs: [onePr()] });
  await go(plain, { now: '2026-10-01T21:00:00Z' });
  assert.strictEqual(plain.calls.listReviews, undefined);
});

test('no comment is created for a PR nobody owes a review on', async () => {
  const w = world({ prs: [onePr({ timeline: [reviewItem('ghopper', 'APPROVED', '2026-10-01T18:00:00Z'), reviewItem('kjohnson', 'APPROVED', '2026-10-01T18:00:00Z')] })] });
  await go(w, { now: '2026-10-02T00:00:00Z' });
  assert.deepStrictEqual(w.calls.comments, []);
});

test('an assignee out before their review is due is replaced across the stack, and only them', async () => {
  // Bottom PR #1 and top PR #2 both have ghopper (domain approver) and kjohnson.
  const w = world({
    prs: [onePr(), { number: 2, head: 'feature/b', base: 'feature/a', assignees: ['ghopper', 'kjohnson'] }],
    out: [['Person ghopper', '2026-10-01']],
  });
  await go(w, { now: '2026-10-01T18:00:00Z' });
  assert.deepStrictEqual(w.calls.unassign, [[1, 'ghopper'], [2, 'ghopper']]);
  assert.deepStrictEqual(w.calls.assign, [[1, 'mhamilton'], [2, 'mhamilton']]);
  assert.deepStrictEqual(w.pr(1).assignees.sort(), ['kjohnson', 'mhamilton']);
  const notice = w.calls.comments.find((c) => !c.body.startsWith(MARKER));
  assert.strictEqual(notice.issue_number, 1);
  assert.match(notice.body, /`ghopper` out before their review is due, so @mhamilton takes over from them as assignee on #1, #2/);
});

test('an assignee who is out keeps the PRs they already approved', async () => {
  // ghopper approved bottom PR #1 and owes a review on #2.
  const w = world({
    prs: [
      onePr({ timeline: [reviewItem('ghopper', 'APPROVED', '2026-10-01T17:30:00Z')] }),
      { number: 2, head: 'feature/b', base: 'feature/a', assignees: ['ghopper', 'kjohnson'] },
    ],
    out: [['Person ghopper', '2026-10-01']],
  });
  await go(w, { now: '2026-10-01T18:00:00Z' });
  assert.deepStrictEqual(w.calls.unassign, [[2, 'ghopper']]);
  assert.deepStrictEqual(w.pr(1).assignees.sort(), ['ghopper', 'kjohnson']);
  const notice = w.calls.comments.find((c) => !c.body.startsWith(MARKER));
  assert.strictEqual(notice.issue_number, 2);
});

test('on a public repo, the reassignment notice doesn\'t say the person is out', async () => {
  const w = world({ prs: [onePr()], out: [['Person ghopper', '2026-10-01']], isPrivate: false });
  await go(w, { now: '2026-10-01T18:00:00Z' });
  const notice = w.calls.comments.find((c) => !c.body.startsWith(MARKER));
  assert.match(notice.body, /^\*\*Review SLA:\*\* `ghopper` isn't available before their review is due, so @mhamilton takes over/);
  assert.doesNotMatch(notice.body, /PTO|out/);
});

test('someone out after their review is due is left alone', async () => {
  const w = world({ prs: [onePr()], out: [['Person ghopper', '2026-10-02']] });
  await go(w, { now: '2026-10-01T18:00:00Z' });
  assert.deepStrictEqual(w.calls.assign, []);
});

test('the digest posts only on the 10:00 Pacific run', async () => {
  const w = world({ prs: [onePr()] });
  await go(w, { now: '2026-10-02T17:05:00Z', inputs: { schedule: '0 18 * * 1-5' } });
  assert.deepStrictEqual(w.calls.posts, []);
  await go(w, { now: '2026-10-02T17:05:00Z', inputs: { schedule: '0 17 * * 1-5' } });
  assert.strictEqual(w.calls.posts.length, 1);
  assert.strictEqual(w.calls.posts[0].channel, 'C123');
  assert.strictEqual(
    w.calls.posts[0].text,
    [
      '*Review SLA, Fri Oct 2*',
      '*Overdue (2)*',
      '• Person ghopper: <https://app.graphite.com/github/pr/StaflSystems/StaflLib/1|StaflLib#1: PR 1>, first response due Thu Oct 1, 17:00',
      '• Person kjohnson: <https://app.graphite.com/github/pr/StaflSystems/StaflLib/1|StaflLib#1: PR 1>, first response due Thu Oct 1, 17:00',
      '<https://example.atlassian.net/wiki/spaces/EM/pages/42|Dashboard>',
    ].join('\n'),
  );
  assert.ok(run.isDigestRun({ eventName: 'schedule', schedule: '0 18 * * 1-5' }, new Date('2026-12-01T18:00:00Z')));
  assert.ok(run.isDigestRun({ digest: 'true', eventName: 'workflow_dispatch' }, new Date('2026-12-01T20:00:00Z')));
});

test('the digest also lists reviews due today, and counts the ones due later', async () => {
  // PR 1 opened 10:00 Thursday is due 17:00 Thursday; PR 2, opened 16:00 Thursday, isn't due until Friday.
  const second = { number: 2, head: 'feature/b', assignees: ['mhamilton'], timeline: [{ __typename: 'AssignedEvent', createdAt: '2026-10-01T23:00:00Z', assignee: userNode('mhamilton') }] };
  const w = world({ prs: [onePr(), second] });
  await go(w, { now: '2026-10-01T23:30:00Z', inputs: { digest: 'true' } });
  assert.strictEqual(
    w.calls.posts[0].text,
    [
      '*Review SLA, Thu Oct 1*',
      '*Due today (2)*',
      '• Person ghopper: <https://app.graphite.com/github/pr/StaflSystems/StaflLib/1|StaflLib#1: PR 1>, first response due 17:00',
      '• Person kjohnson: <https://app.graphite.com/github/pr/StaflSystems/StaflLib/1|StaflLib#1: PR 1>, first response due 17:00',
      '1 more review is owed, due after today.',
      '<https://example.atlassian.net/wiki/spaces/EM/pages/42|Dashboard>',
    ].join('\n'),
  );
});

test('the dashboard lists every review owed, linked to Graphite, with overdue ones marked', async () => {
  const second = { number: 2, head: 'feature/b', assignees: ['ghopper'], timeline: [{ __typename: 'AssignedEvent', createdAt: '2026-10-01T23:00:00Z', assignee: userNode('ghopper') }] };
  const w = world({ prs: [onePr(), second] });
  await go(w, { now: '2026-10-02T00:00:00Z' });
  const page = w.calls.puts.at(-1).body.storage.value;
  assert.ok(page.includes(
    '<tr><td>Person ghopper</td><td>1 overdue</td><td><ul>' +
      '<li><a href="https://app.graphite.com/github/pr/StaflSystems/StaflLib/1">StaflLib#1</a> PR 1: first response, <strong>overdue since Thu Oct 1, 17:00</strong></li>' +
      '<li><a href="https://app.graphite.com/github/pr/StaflSystems/StaflLib/2">StaflLib#2</a> PR 2: first response, due Fri Oct 2, 16:00</li>' +
      '</ul></td></tr>',
  ), page);
  assert.ok(page.includes('<tr><td>Person dvaughan</td><td>✅</td><td></td></tr>'));
});

test('the dashboard saves a new version only when its content changes, as a minor edit', async () => {
  const w = world({ prs: [onePr()] });
  await go(w, { now: '2026-10-01T18:00:00Z' });
  await go(w, { now: '2026-10-01T18:30:00Z' });
  assert.strictEqual(w.calls.puts.length, 1);
  assert.deepStrictEqual([w.calls.puts[0].version.number, w.calls.puts[0].version.minorEdit], [4, true]);
  await go(w, { now: '2026-10-02T00:00:00Z' });
  assert.strictEqual(w.calls.puts.length, 2);
  assert.match(w.calls.puts[1].body.storage.value, /<td>Person ghopper<\/td><td>1 overdue<\/td>/);
  assert.match(w.calls.puts[1].body.storage.value, /<td>Person dvaughan<\/td><td>✅<\/td>/);
});

test('a repo that can\'t be read is a warning, and the other repos carry on', async () => {
  const w = world({ prs: [onePr()], failRepo: 'coit-tower-bms2000' });
  const { logs } = await go(w, { now: '2026-10-02T00:00:00Z', inputs: { repos: 'coit-tower-bms2000 StaflLib' } });
  assert.ok(logs.includes("WARN coit-tower-bms2000: couldn't read open PRs (HTTP 502); skipping it this run."));
  assert.strictEqual(w.calls.dms.length, 2);
});

test('if the comment can\'t be written, no reminder is sent for that PR', async () => {
  const w = world({ prs: [onePr()], failComments: true });
  const { logs } = await go(w, { now: '2026-10-02T00:00:00Z' });
  assert.deepStrictEqual(w.calls.dms, []);
  assert.ok(logs.some((l) => l.startsWith("WARN StaflLib#1: couldn't write the Review SLA comment")));
});

test('someone with no Slack ID is warned about, and the others still get reminders', async () => {
  const people = { ...PEOPLE, ghopper: { name: 'Person ghopper' } };
  const w = world({ prs: [onePr()] });
  const { logs } = await go(w, { now: '2026-10-02T00:00:00Z', inputs: { people: JSON.stringify(people) } });
  assert.deepStrictEqual(w.calls.dms.map((m) => m.channel), ['U002']);
  assert.ok(logs.includes('WARN No Slack ID in REVIEW_PEOPLE for ghopper, so they get no reminders.'));
});

test('enforce isn\'t built yet and runs as remind', async () => {
  const w = world({ prs: [onePr()] });
  const { logs } = await go(w, { mode: 'enforce', now: '2026-10-02T00:00:00Z' });
  assert.ok(logs.some((l) => l.startsWith("WARN REVIEW_SLA_MODE 'enforce'")));
  assert.strictEqual(w.calls.dms.length, 2);
});
