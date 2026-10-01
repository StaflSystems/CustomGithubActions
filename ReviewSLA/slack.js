// Slack: reminder DMs to assignees, and the 10:00 digest. One bot token does both; its only scope
// is chat:write, and the bot has to be invited to the digest channel.

const { pacificDate } = require('../ReviewConfig/pto.js');
const { formatTime, KIND } = require('./comment.js');

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
const prLink = (pr) => `<${pr.url}|${pr.repo}#${pr.number}: ${escape(pr.title)}>`;

function reminderText(clock) {
  const what = clock.kind === 'first' ? 'your first response' : 'your re-review';
  return `Review due: ${prLink(clock.pr)}. As an assignee, ${what} was due at ${formatTime(clock.due)} PT.`;
}

function digestText(clocks, { now, people, dashboardUrl }) {
  const nameOf = (login) => people[login]?.name || login;
  const overdue = clocks.filter((c) => c.overdue).sort((a, b) => nameOf(a.login).localeCompare(nameOf(b.login)) || a.due - b.due);
  const dueToday = clocks.filter((c) => !c.overdue && pacificDate(c.due) === pacificDate(now));
  const lines = [`*Review SLA, ${formatTime(now).split(',')[0]}*`];
  if (overdue.length === 0) lines.push('No overdue reviews.');
  else {
    lines.push(`${overdue.length} overdue ${overdue.length === 1 ? 'review' : 'reviews'}:`);
    for (const c of overdue) lines.push(`• ${escape(nameOf(c.login))}: ${prLink(c.pr)} (${KIND[c.kind].toLowerCase()}, due ${formatTime(c.due)})`);
  }
  if (dueToday.length > 0) lines.push(`${dueToday.length} more due today.`);
  if (dashboardUrl) lines.push(`<${dashboardUrl}|Dashboard>`);
  return lines.join('\n');
}

module.exports = { digestText, postMessage, reminderText };
