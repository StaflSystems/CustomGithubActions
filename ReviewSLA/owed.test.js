// Run with: node --test ReviewSLA/
const test = require('node:test');
const assert = require('node:assert');
const { owedClocks, stackOf } = require('./owed.js');

const HOLIDAYS = { 2026: [{ date: '2026-11-26' }, { date: '2026-11-27' }] };
const at = (iso) => new Date(iso);
const user = (login) => ({ login, bot: false });

// Thursday Oct 1, 2026, 10:00 Pacific.
const OPENED = '2026-10-01T17:00:00Z';

let nextNumber = 1;
function pr({ head, base = 'main', assignees = ['ghopper', 'kjohnson'], timeline = [], ...rest } = {}) {
  const number = nextNumber++;
  return {
    repo: 'StaflLib',
    number,
    url: `https://github.com/StaflSystems/StaflLib/pull/${number}`,
    title: `PR ${number}`,
    author: user('alovelace'),
    createdAt: at(OPENED),
    closedAt: null,
    isDraft: false,
    additions: 300,
    headRefName: head ?? `feature/${number}`,
    baseRefName: base,
    assignees,
    timeline: timeline.map(([type, iso, extra = {}]) => ({ type, at: at(iso), ...extra })),
    ...rest,
  };
}
const review = (login, state = 'APPROVED') => ({ author: user(login), state, body: 'ok', comments: 0 });
const clocks = (prs, now) => owedClocks(prs, { now: at(now), holidays: HOLIDAYS }).map((c) => ({
  pr: c.pr.number,
  login: c.login,
  kind: c.kind,
  start: c.start.toISOString(),
  due: c.due.toISOString(),
  overdue: c.overdue,
}));

test('a standard PR opened ready at 10:00 Thursday is due at 17:00 that day, for each assignee', () => {
  const p = pr();
  assert.deepStrictEqual(clocks([p], '2026-10-01T23:00:00Z'), [
    { pr: p.number, login: 'ghopper', kind: 'first', start: '2026-10-01T17:00:00.000Z', due: '2026-10-02T00:00:00.000Z', overdue: false },
    { pr: p.number, login: 'kjohnson', kind: 'first', start: '2026-10-01T17:00:00.000Z', due: '2026-10-02T00:00:00.000Z', overdue: false },
  ]);
  assert.ok(clocks([p], '2026-10-02T00:00:00Z').every((c) => c.overdue));
});

test('a small PR marked ready at 16:30 Friday is due 13:30 Monday', () => {
  const p = pr({ additions: 100, timeline: [['ready', '2026-10-02T23:30:00Z']] });
  assert.strictEqual(clocks([p], '2026-10-05T17:00:00Z')[0].due, '2026-10-05T20:30:00.000Z');
});

test('a review that counts stops only that assignee\'s clock', () => {
  const p = pr({
    timeline: [
      ['review', '2026-10-01T18:00:00Z', review('ghopper', 'COMMENTED')],
      ['review', '2026-10-01T18:30:00Z', { ...review('kjohnson', 'COMMENTED'), body: '' }],
      ['review', '2026-10-01T19:00:00Z', review('mhamilton')],
    ],
  });
  assert.deepStrictEqual(clocks([p], '2026-10-01T20:00:00Z').map((c) => c.login), ['kjohnson']);
});

test('the author, bots and Graphite merge-queue PRs owe nothing, and drafts have no clocks', () => {
  assert.deepStrictEqual(clocks([pr({ assignees: ['alovelace', 'renovate[bot]'] })], '2026-10-02T20:00:00Z'), []);
  assert.deepStrictEqual(clocks([pr({ author: { login: 'dependabot[bot]', bot: true } })], '2026-10-02T20:00:00Z'), []);
  assert.deepStrictEqual(clocks([pr({ head: 'gtmq_spec_1' })], '2026-10-02T20:00:00Z'), []);
  assert.deepStrictEqual(clocks([pr({ isDraft: true })], '2026-10-02T20:00:00Z'), []);
});

test('going back to draft and ready again starts the clock over, with no miss', () => {
  const p = pr({ timeline: [['draft', '2026-10-01T18:00:00Z'], ['ready', '2026-10-05T17:00:00Z']] });
  const [clock] = clocks([p], '2026-10-05T18:00:00Z');
  assert.deepStrictEqual([clock.start, clock.overdue], ['2026-10-05T17:00:00.000Z', false]);
});

test('someone assigned later starts their clock when they\'re assigned', () => {
  const p = pr({ assignees: ['ghopper'], timeline: [['assigned', '2026-10-02T17:00:00Z', { login: 'ghopper' }]] });
  assert.strictEqual(clocks([p], '2026-10-02T18:00:00Z')[0].start, '2026-10-02T17:00:00.000Z');
});

test('in a three-PR stack with nothing approved, clocks run on the bottom PR only', () => {
  const bottom = pr({ head: 'a' });
  const middle = pr({ head: 'b', base: 'a' });
  const top = pr({ head: 'c', base: 'b' });
  assert.deepStrictEqual(new Set(clocks([top, middle, bottom], '2026-10-01T20:00:00Z').map((c) => c.pr)), new Set([bottom.number]));
  assert.deepStrictEqual(stackOf(middle, [top, middle, bottom]).map((p) => p.number), [bottom.number, middle.number, top.number]);
});

test('approving the bottom PR moves that assignee up the stack, from the time they approved', () => {
  const bottom = pr({ head: 'a', timeline: [['review', '2026-10-01T20:00:00Z', review('ghopper')]] });
  const middle = pr({ head: 'b', base: 'a' });
  const top = pr({ head: 'c', base: 'b' });
  assert.deepStrictEqual(
    clocks([bottom, middle, top], '2026-10-01T21:00:00Z').map((c) => [c.pr, c.login, c.start]),
    [
      [bottom.number, 'kjohnson', '2026-10-01T17:00:00.000Z'],
      [middle.number, 'ghopper', '2026-10-01T20:00:00.000Z'],
    ],
  );
});

test('requesting changes stops the reviewer\'s clock and starts nothing higher up', () => {
  const bottom = pr({ head: 'a', assignees: ['ghopper'], timeline: [['review', '2026-10-01T20:00:00Z', review('ghopper', 'CHANGES_REQUESTED')]] });
  const top = pr({ head: 'b', base: 'a', assignees: ['ghopper'] });
  assert.deepStrictEqual(clocks([bottom, top], '2026-10-02T21:00:00Z'), []);
});

test('a draft PR below doesn\'t hold the clock back', () => {
  const bottom = pr({ head: 'a', isDraft: true });
  const top = pr({ head: 'b', base: 'a' });
  assert.deepStrictEqual(new Set(clocks([bottom, top], '2026-10-01T20:00:00Z').map((c) => c.pr)), new Set([top.number]));
});

test('when the PR below merges, the clock starts when the base changes', () => {
  const p = pr({ assignees: ['ghopper'], timeline: [['base', '2026-10-02T18:00:00Z']] });
  assert.strictEqual(clocks([p], '2026-10-02T19:00:00Z')[0].start, '2026-10-02T18:00:00.000Z');
});

test('the author pushing a fix and re-requesting review starts a 4-hour re-review clock', () => {
  const p = pr({
    assignees: ['ghopper'],
    timeline: [
      ['review', '2026-10-01T18:00:00Z', review('ghopper', 'CHANGES_REQUESTED')],
      ['pushed', '2026-10-01T20:00:00Z'],
      ['requested', '2026-10-01T20:05:00Z', { login: 'ghopper' }],
    ],
  });
  assert.deepStrictEqual(
    clocks([p], '2026-10-01T21:00:00Z').map((c) => [c.kind, c.start, c.due]),
    [['re-review', '2026-10-01T20:05:00.000Z', '2026-10-02T17:05:00.000Z']],
  );
});

test('a re-request with no push since the last review (a Graphite resubmit) starts nothing', () => {
  const p = pr({
    assignees: ['ghopper'],
    timeline: [
      ['pushed', '2026-10-01T17:30:00Z'],
      ['review', '2026-10-01T18:00:00Z', review('ghopper', 'COMMENTED')],
      ['requested', '2026-10-01T20:05:00Z', { login: 'ghopper' }],
    ],
  });
  assert.deepStrictEqual(clocks([p], '2026-10-01T21:00:00Z'), []);
});
