// A PR's first-response clock (review RFC, Proposal 2), rebuilt from its timeline.
//
// A PR here is { number, author, createdAt, closedAt, isDraft, additions, headRefName, timeline },
// where `timeline` holds the PR's ready and draft events and its reviews, in any order:
//   { type: 'ready' | 'draft', at }
//   { type: 'review', at, author: { login, bot }, state, body, comments }
// `author` is { login, bot }. Times are Dates.
//
// Two measures are kept side by side:
// - `rfc` is how the RFC measured its baseline: from the first ready event (or creation, for a PR
//   never marked ready) to the first review by anyone but the author, in wall-clock hours. PRs
//   whose first review came before that start aren't timed.
// - `sla` follows the SLA's clock rules: the clock runs while the PR is ready and restarts each
//   time it's marked ready again, and only a review that counts stops it. It's measured in business
//   hours against the PR's target.

const { businessHoursBetween } = require('../ReviewConfig/hours.js');

const SMALL_PR_LINES = 250;
const TARGET_HOURS = { small: 4, standard: 7 };
const HOUR_MS = 3600 * 1000;

function isBot(actor) {
  return !actor || actor.bot || actor.login.endsWith('[bot]');
}

// Bots, Graphite's merge-queue PRs and their speculative copies have no SLA.
function hasSla(pr) {
  return !isBot(pr.author) && pr.author.login !== 'graphite-app' && !pr.headRefName.startsWith('gtmq_');
}

// An approval, changes requested, or a comment review with a body or at least one inline comment.
// A dismissed review was an approval or changes requested when it was submitted.
function countsAsResponse(review) {
  if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) return true;
  return review.state === 'COMMENTED' && (Boolean(review.body?.trim()) || review.comments > 0);
}

function targetHours(pr) {
  return pr.additions < SMALL_PR_LINES ? TARGET_HOURS.small : TARGET_HOURS.standard;
}

function byTime(a, b) {
  return a.at - b.at;
}

// Whether the PR was opened as a draft. GitHub records no event for the state a PR is opened in,
// so it's read off the first ready or draft event, or the PR's current state if there are none.
function openedAsDraft(pr) {
  const first = pr.timeline.filter((e) => e.type === 'ready' || e.type === 'draft').sort(byTime)[0];
  return first ? first.type === 'ready' : pr.isDraft;
}

function rfcClock(pr, until) {
  const reviews = pr.timeline
    .filter((e) => e.type === 'review' && e.at <= until && e.author && e.author.login !== pr.author.login)
    .sort(byTime);
  const ready = pr.timeline.filter((e) => e.type === 'ready' && e.at <= until).sort(byTime)[0];
  const start = ready ? ready.at : pr.createdAt;
  if (start > until) return null;
  const first = reviews[0];
  if (!first) return { start, reviewedAt: null, hours: null };
  if (first.at < start) return { start, reviewedAt: first.at, hours: null, untimed: 'reviewed before ready' };
  return { start, reviewedAt: first.at, hours: (first.at - start) / HOUR_MS };
}

// status: 'responded', 'waiting' (still ready and unreviewed at `until`), 'closed' (closed
// unreviewed), 'reviewed while draft', or 'not ready' (a draft at `until`, or never ready).
function slaClock(pr, until, holidays) {
  const target = targetHours(pr);
  const end = pr.closedAt && pr.closedAt <= until ? pr.closedAt : until;
  let start = openedAsDraft(pr) ? null : pr.createdAt;
  const events = pr.timeline.filter((e) => e.at <= end).sort(byTime);
  for (const event of events) {
    if (event.type === 'ready') start ??= event.at;
    else if (event.type === 'draft') start = null;
    else if (event.type === 'review' && !isBot(event.author) && event.author.login !== pr.author.login && countsAsResponse(event)) {
      if (!start) return { status: 'reviewed while draft', target };
      const hours = businessHoursBetween(start, event.at, holidays);
      return { status: 'responded', start, reviewedAt: event.at, reviewer: event.author.login, hours, target, met: hours <= target };
    }
  }
  if (!start) return { status: 'not ready', target };
  // Still unreviewed: it's a miss once it's past the target, and not yet known before that.
  const hours = businessHoursBetween(start, end, holidays);
  const status = end === until ? 'waiting' : 'closed';
  return { status, start, reviewedAt: null, hours, target, met: hours > target ? false : null };
}

function firstResponse(pr, { until, holidays }) {
  return { rfc: rfcClock(pr, until), sla: slaClock(pr, until, holidays) };
}

module.exports = { countsAsResponse, firstResponse, hasSla, isBot, targetHours, SMALL_PR_LINES, TARGET_HOURS };
