// The one Review SLA comment on each ready PR: who owes what, and when it's due. Its first line
// is a hidden marker that also records which reminders have been sent, so reruns and late
// scheduled runs don't send them twice.

const { TIME_ZONE } = require('../ReviewConfig/pto.js');
const { SMALL_PR_LINES, TARGET_HOURS } = require('./clock.js');

const MARKER = '<!-- review-sla';

const KIND = { first: 'First response', 're-review': 'Re-review' };

// "Fri Oct 2, 10:00", Pacific.
function formatTime(instant) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: TIME_ZONE,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.weekday} ${parts.month} ${parts.day}, ${parts.hour}:${parts.minute}`;
}

// A PR's page in Graphite, where the team reviews stacks: github.com/<owner>/<repo>/pull/<n> becomes
// app.graphite.com/github/pr/<owner>/<repo>/<n>.
function graphiteUrl(pr) {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(pr.url ?? '');
  return match ? `https://app.graphite.com/github/pr/${match[1]}/${match[2]}/${match[3]}` : pr.url;
}

// One key per clock, so a reminder is sent once per clock: a new clock (a re-review, or a restart
// after the PR goes back to draft) has a new start and gets its own.
const reminderKey = (clock) => `${clock.login}:${clock.kind}:${clock.start.toISOString()}`;

function parseState(body) {
  const match = body && new RegExp(`^${MARKER} (.*?) -->`).exec(body);
  try {
    const state = match ? JSON.parse(match[1]) : {};
    return { reminded: Array.isArray(state.reminded) ? state.reminded : [] };
  } catch {
    return { reminded: [] };
  }
}

function renderComment(clocks, state, { dashboardUrl } = {}) {
  const lines = [`${MARKER} ${JSON.stringify(state)} -->`, '**Review SLA**', ''];
  if (clocks.length === 0) {
    lines.push("Nobody owes a review on this PR right now.");
  } else {
    lines.push('| Assignee | Owes | Due | |', '| --- | --- | --- | --- |');
    for (const clock of [...clocks].sort((a, b) => a.due - b.due || a.login.localeCompare(b.login))) {
      lines.push(`| \`${clock.login}\` | ${KIND[clock.kind]} | ${formatTime(clock.due)} PT | ${clock.overdue ? 'Overdue' : ''} |`);
    }
  }
  lines.push(
    '',
    `<sub>Due times are in business hours, 10:00 to 17:00 Pacific: ${TARGET_HOURS.small} h for a PR under ${SMALL_PR_LINES} added lines, ` +
      `${TARGET_HOURS.standard} h otherwise, and ${TARGET_HOURS.reReview} h for a re-review. Mid-stack, an assignee owes a response on the ` +
      `lowest PR they haven't approved.${dashboardUrl ? ` [Dashboard](${dashboardUrl})` : ''}</sub>`,
  );
  return lines.join('\n');
}

module.exports = { formatTime, graphiteUrl, KIND, MARKER, parseState, reminderKey, renderComment };
