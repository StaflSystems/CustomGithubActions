// Who owes a review right now, per assignee (review RFC, Proposal 2). Rebuilt on every run from
// the open PRs' timelines; there's no other state.
//
// An open PR here is clock.js's PR shape plus { repo, url, title, baseRefName, assignees }, and its
// timeline can also hold:
//   { type: 'assigned' | 'unassigned' | 'requested', at, login }
//   { type: 'pushed', at }   a push or force-push to the PR's branch
//   { type: 'base', at }     the PR's base branch changed (a restack, or the PR below merged)
//
// Each assignee owes a response only on the lowest ready PR in the stack that they're assigned to
// and haven't approved. Their clock there starts at the latest of: the PR being marked ready, their
// assignment, their approval of the PR below, and the PR's base changing (the PR below merging).
// Requesting changes doesn't move them up the stack. Once they've responded, a re-request from the
// author starts a re-review clock, but only if the author has pushed since their last review, so
// Graphite re-requesting on every `gt submit` doesn't.

const { addBusinessHours, businessHoursBetween } = require('../ReviewConfig/hours.js');
const { byTime, countsAsResponse, hasSla, isBot, openedAsDraft, targetHours, TARGET_HOURS } = require('./clock.js');

// When the PR was last marked ready (or opened, if it was opened ready), or null for a draft.
function readySince(pr) {
  if (pr.isDraft) return null;
  let start = openedAsDraft(pr) ? null : pr.createdAt;
  for (const event of pr.timeline.filter((e) => e.type === 'ready' || e.type === 'draft').sort(byTime)) {
    if (event.type === 'ready') start ??= event.at;
    else start = null;
  }
  return start ?? pr.createdAt;
}

function reviewsBy(pr, login) {
  return pr.timeline.filter((e) => e.type === 'review' && e.author?.login === login).sort(byTime);
}

// The time of `login`'s approval, if their latest approval or changes-requested review is an approval.
function approvedAt(pr, login) {
  const decisive = reviewsBy(pr, login).filter((r) => r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED');
  const last = decisive.at(-1);
  return last?.state === 'APPROVED' ? last.at : null;
}

function latest(pr, type, login) {
  return pr.timeline.filter((e) => e.type === type && (login === undefined || e.login === login)).sort(byTime).at(-1)?.at ?? null;
}

const assigneesOf = (pr) => pr.assignees.filter((login) => login !== pr.author.login && !login.endsWith('[bot]'));

// The open PRs below `pr` in its stack, nearest first.
function below(pr, byHead) {
  const chain = [];
  const seen = new Set([pr.number]);
  for (let next = byHead.get(pr.baseRefName); next && !seen.has(next.number); next = byHead.get(next.baseRefName)) {
    seen.add(next.number);
    chain.push(next);
  }
  return chain;
}

// Every open PR in `pr`'s stack, including `pr`, bottom first.
function stackOf(pr, prs) {
  const byHead = new Map(prs.map((p) => [p.headRefName, p]));
  const members = new Map([[pr.number, pr]]);
  for (const p of below(pr, byHead)) members.set(p.number, p);
  for (let frontier = [pr]; frontier.length > 0; ) {
    const next = [];
    for (const p of frontier) {
      for (const child of prs.filter((c) => c.baseRefName === p.headRefName && !members.has(c.number))) {
        members.set(child.number, child);
        next.push(child);
      }
    }
    frontier = next;
  }
  const depth = (p) => below(p, byHead).length;
  return [...members.values()].sort((a, b) => depth(a) - depth(b) || a.number - b.number);
}

function clockFor(pr, login, readyAt, lower) {
  // The lowest ready PR they're assigned to and haven't approved is where they owe.
  const lowerReady = lower.filter((p) => readySince(p) && assigneesOf(p).includes(login));
  if (lowerReady.some((p) => !approvedAt(p, login))) return null;

  const responses = reviewsBy(pr, login).filter((r) => countsAsResponse(r) && r.at >= readyAt);
  if (responses.length === 0) {
    const base = latest(pr, 'base');
    const starts = [readyAt, latest(pr, 'assigned', login), base && base > readyAt ? base : null, ...lowerReady.map((p) => approvedAt(p, login))];
    return { kind: 'first', start: new Date(Math.max(...starts.filter(Boolean))), target: targetHours(pr) };
  }
  const lastReview = responses.at(-1).at;
  const requested = latest(pr, 'requested', login);
  const pushed = latest(pr, 'pushed');
  if (requested && requested > lastReview && pushed && pushed > lastReview) {
    return { kind: 're-review', start: requested, target: TARGET_HOURS.reReview };
  }
  return null;
}

// Every running clock across `prs` (the open PRs of one repo):
// [{ pr, login, kind: 'first' | 're-review', start, target, due, hours, overdue }].
function owedClocks(prs, { now, holidays }) {
  const byHead = new Map(prs.map((p) => [p.headRefName, p]));
  const clocks = [];
  for (const pr of prs) {
    if (!hasSla(pr) || isBot(pr.author)) continue;
    const readyAt = readySince(pr);
    if (!readyAt) continue;
    const lower = below(pr, byHead);
    for (const login of assigneesOf(pr)) {
      const clock = clockFor(pr, login, readyAt, lower);
      if (!clock || clock.start > now) continue;
      const due = addBusinessHours(clock.start, clock.target, holidays);
      clocks.push({ pr, login, ...clock, due, hours: businessHoursBetween(clock.start, now, holidays), overdue: now >= due });
    }
  }
  return clocks;
}

module.exports = { approvedAt, assigneesOf, owedClocks, readySince, stackOf };
