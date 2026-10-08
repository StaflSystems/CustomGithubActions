// Slack: reminder DMs to assignees, and the 10:00 digest. One bot token does both; its only scope
// is chat:write, and the bot has to be invited to the digest channel.

const { pacificDate } = require('../ReviewConfig/pto.js');
const { formatTime, graphiteUrl, KIND } = require('./comment.js');

async function postMessage({ token, channel, text, fetch = globalThis.fetch }) {
  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ channel, text, unfurl_links: false, unfurl_media: false }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) throw new Error(`Slack: ${body.error ?? `HTTP ${response.status}`}`);
}

// Slack's mrkdwn wants &, < and > escaped in text.
const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const prLink = (pr) => `<${graphiteUrl(pr)}|${pr.repo}#${pr.number}: ${escape(pr.title)}>`;

function reminderText(clock) {
  const what = clock.kind === 'first' ? 'your first response' : 'your re-review';
  return `Review due: ${prLink(clock.pr)}. As an assignee, ${what} was due at ${formatTime(clock.due)} PT.`;
}

// Overdue reviews and those due today, by person, each linked to Graphite, then a count of the rest.
function digestText(clocks, { now, people, dashboardUrl }) {
  const nameOf = (login) => people[login]?.name || login;
  const byPerson = (a, b) => nameOf(a.login).localeCompare(nameOf(b.login)) || a.due - b.due;
  const overdue = clocks.filter((c) => c.overdue).sort(byPerson);
  const dueToday = clocks.filter((c) => !c.overdue && pacificDate(c.due) === pacificDate(now)).sort(byPerson);
  const later = clocks.length - overdue.length - dueToday.length;
  const line = (c, when) => `• ${escape(nameOf(c.login))}: ${prLink(c.pr)}, ${KIND[c.kind].toLowerCase()} due ${when}`;
  const lines = [`*Review SLA, ${formatTime(now).split(',')[0]}*`];
  if (overdue.length === 0 && dueToday.length === 0) lines.push('No reviews overdue or due today.');
  if (overdue.length > 0) {
    lines.push(`*Overdue (${overdue.length})*`);
    for (const c of overdue) lines.push(line(c, formatTime(c.due)));
  }
  if (dueToday.length > 0) {
    lines.push(`*Due today (${dueToday.length})*`);
    for (const c of dueToday) lines.push(line(c, formatTime(c.due).split(', ')[1]));
  }
  if (later > 0) lines.push(`${later} more ${later === 1 ? 'review is' : 'reviews are'} owed, due after today.`);
  if (dashboardUrl) lines.push(`<${dashboardUrl}|Dashboard>`);
  return lines.join('\n');
}

module.exports = { digestText, postMessage, reminderText };
