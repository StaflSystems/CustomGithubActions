// Run with: node --test ReviewSLA/
const test = require('node:test');
const assert = require('node:assert');
const { countsAsResponse, firstResponse, hasSla } = require('./clock.js');
const { measure, percentile, toPr, weekOf } = require('./report.js');

const HOLIDAYS = { 2026: [{ date: '2026-11-26' }, { date: '2026-11-27' }] };
const UNTIL = new Date('2026-12-31T00:00:00Z');
const at = (iso) => new Date(iso);

const author = { login: 'alovelace', bot: false };
const reviewer = { login: 'ghopper', bot: false };

function pr(overrides = {}) {
  return {
    number: 1,
    author,
    createdAt: at('2026-10-01T17:00:00Z'), // 10:00 Thursday, Pacific
    closedAt: null,
    isDraft: false,
    additions: 100,
    headRefName: 'feature/x',
    timeline: [],
    ...overrides,
  };
}
const ready = (iso) => ({ type: 'ready', at: at(iso) });
const draft = (iso) => ({ type: 'draft', at: at(iso) });
const review = (iso, state = 'APPROVED', extra = {}) => ({ type: 'review', at: at(iso), author: reviewer, state, body: '', comments: 0, ...extra });
const clock = (p, until = UNTIL) => firstResponse(p, { until, holidays: HOLIDAYS });

test('reviews that count: approvals, changes requested, and comments with something in them', () => {
  assert.ok(countsAsResponse({ state: 'APPROVED' }));
  assert.ok(countsAsResponse({ state: 'CHANGES_REQUESTED' }));
  assert.ok(countsAsResponse({ state: 'DISMISSED' }));
  assert.ok(countsAsResponse({ state: 'COMMENTED', body: 'Looks close', comments: 0 }));
  assert.ok(countsAsResponse({ state: 'COMMENTED', body: '', comments: 2 }));
  assert.ok(!countsAsResponse({ state: 'COMMENTED', body: '  ', comments: 0 }));
});

test('a small PR marked ready at 16:30 Friday and reviewed at 13:30 Monday is just within target', () => {
  const p = pr({
    createdAt: at('2026-10-02T20:00:00Z'),
    timeline: [ready('2026-10-02T23:30:00Z'), review('2026-10-05T20:30:00Z')],
  });
  const { sla, rfc } = clock(p);
  assert.deepStrictEqual([sla.status, sla.hours, sla.target, sla.met, sla.reviewer], ['responded', 4, 4, true, 'ghopper']);
  assert.strictEqual(rfc.hours, 69);
});

test('a standard PR gets one business day', () => {
  const p = pr({ additions: 250, timeline: [review('2026-10-02T17:00:00Z')] });
  assert.deepStrictEqual([clock(p).sla.hours, clock(p).sla.target, clock(p).sla.met], [7, 7, true]);
});

test('the day before a listed holiday, the holiday doesn\'t count', () => {
  // Ready 16:00 Wednesday before Thanksgiving, reviewed 11:00 the Monday after.
  const p = pr({ createdAt: at('2026-11-26T00:00:00Z'), timeline: [review('2026-11-30T19:00:00Z')] });
  assert.strictEqual(clock(p).sla.hours, 2);
});

test('only the author\'s own reviews, bots and empty comment reviews leave the clock running', () => {
  const p = pr({
    timeline: [
      review('2026-10-01T18:00:00Z', 'COMMENTED', { author, body: 'Note to self' }),
      review('2026-10-01T18:30:00Z', 'COMMENTED', { author: { login: 'copilot', bot: true }, body: 'Summary' }),
      review('2026-10-01T19:00:00Z', 'COMMENTED'),
      review('2026-10-01T21:00:00Z', 'COMMENTED', { comments: 1 }),
    ],
  });
  assert.deepStrictEqual([clock(p).sla.status, clock(p).sla.hours], ['responded', 4]);
});

test('going back to draft stops the clock, and marking ready again starts it over', () => {
  const p = pr({
    timeline: [draft('2026-10-01T22:00:00Z'), ready('2026-10-05T17:00:00Z'), review('2026-10-05T19:00:00Z')],
  });
  const { sla, rfc } = clock(p);
  assert.deepStrictEqual([sla.start, sla.hours], [at('2026-10-05T17:00:00Z'), 2]);
  // The RFC measured from the first ready time, which for a PR opened ready is when it was opened.
  assert.deepStrictEqual(rfc.start, at('2026-10-05T17:00:00Z'));
});

test('a PR opened as a draft starts its clock when it\'s marked ready', () => {
  const p = pr({ isDraft: false, timeline: [ready('2026-10-02T17:00:00Z'), review('2026-10-02T18:00:00Z')] });
  assert.deepStrictEqual([clock(p).sla.start, clock(p).sla.hours], [at('2026-10-02T17:00:00Z'), 1]);
});

test('a PR reviewed while still a draft isn\'t timed', () => {
  const p = pr({ isDraft: true, timeline: [review('2026-10-02T18:00:00Z'), ready('2026-10-05T17:00:00Z')] });
  assert.strictEqual(clock(p).sla.status, 'reviewed while draft');
  assert.strictEqual(clock(p).rfc.untimed, 'reviewed before ready');
});

test('an unreviewed PR is a miss once it\'s past its target, and unknown before that', () => {
  const p = pr();
  const early = clock(p, at('2026-10-01T19:00:00Z')).sla;
  assert.deepStrictEqual([early.status, early.hours, early.met], ['waiting', 2, null]);
  const late = clock(p, at('2026-10-02T17:00:00Z')).sla;
  assert.deepStrictEqual([late.status, late.hours, late.met], ['waiting', 7, false]);
});

test('a PR closed unreviewed stops its clock when it closed', () => {
  const p = pr({ closedAt: at('2026-10-01T18:00:00Z') });
  assert.deepStrictEqual([clock(p).sla.status, clock(p).sla.hours, clock(p).sla.met], ['closed', 1, null]);
});

test('events after the end of the range are ignored', () => {
  // Opened as a draft, reviewed, and marked ready after the range ended: the RFC timed it from creation.
  const p = pr({ isDraft: false, timeline: [review('2026-10-02T18:00:00Z'), ready('2026-10-09T17:00:00Z')] });
  const { rfc, sla } = clock(p, at('2026-10-05T00:00:00Z'));
  assert.deepStrictEqual([rfc.start, rfc.hours], [p.createdAt, 25]);
  assert.strictEqual(sla.status, 'reviewed while draft');
  const unreviewed = clock(pr({ timeline: [review('2026-10-09T18:00:00Z')] }), at('2026-10-05T00:00:00Z'));
  assert.deepStrictEqual([unreviewed.rfc.reviewedAt, unreviewed.sla.status], [null, 'waiting']);
});

test('bot, Graphite and merge-queue PRs have no SLA', () => {
  assert.ok(hasSla(pr()));
  assert.ok(!hasSla(pr({ author: { login: 'dependabot[bot]', bot: true } })));
  assert.ok(!hasSla(pr({ author: { login: 'graphite-app', bot: false } })));
  assert.ok(!hasSla(pr({ headRefName: 'gtmq_spec_1234' })));
});

test('report: percentiles interpolate, weeks start on Monday', () => {
  assert.strictEqual(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.strictEqual(percentile([10], 0.9), 10);
  assert.strictEqual(percentile([], 0.5), null);
  assert.strictEqual(weekOf('2026-10-01'), '2026-09-28');
  assert.strictEqual(weekOf('2026-10-04'), '2026-09-28');
  assert.strictEqual(weekOf('2026-10-05'), '2026-10-05');
});

test('report: GraphQL nodes become PRs, and only clocks started in range are counted', () => {
  const node = {
    number: 7,
    url: 'https://github.com/o/r/pull/7',
    createdAt: '2026-10-01T17:00:00Z',
    closedAt: null,
    isDraft: false,
    additions: 10,
    headRefName: 'feature/y',
    author: { __typename: 'User', login: 'alovelace' },
    timelineItems: {
      pageInfo: { hasNextPage: false },
      nodes: [
        { __typename: 'PullRequestReview', state: 'PENDING', submittedAt: null, body: '', comments: { totalCount: 0 }, author: { __typename: 'User', login: 'ghopper' } },
        { __typename: 'PullRequestReview', state: 'APPROVED', submittedAt: '2026-10-01T18:00:00Z', body: '', comments: { totalCount: 0 }, author: { __typename: 'User', login: 'ghopper' } },
      ],
    },
  };
  const converted = toPr(node);
  assert.strictEqual(converted.timeline.length, 1);
  const [row] = measure([converted], { since: '2026-10-01', until: '2026-10-01', holidays: HOLIDAYS });
  assert.deepStrictEqual([row.rfc.hours, row.sla.hours, row.slaInRange], [1, 1, true]);
  const [outside] = measure([converted], { since: '2026-10-02', until: '2026-10-08', holidays: HOLIDAYS });
  assert.deepStrictEqual([outside.rfc, outside.slaInRange], [null, false]);
});
