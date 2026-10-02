// The Review SLA dashboard: a Confluence page under Embedded Team Dashboard, rewritten each run.
// It shows a checkmark per person while they're meeting the SLA, and lists overdue reviews only for
// those who aren't. A new version is saved only when the content changes, as a minor edit, so
// neither the page history nor watchers' notifications fill up every 30 minutes. The version
// message carries a hash of the content, which is what "changed" is checked against: Confluence
// rewrites storage format on save, so the page's own body can't be compared.

const crypto = require('node:crypto');
const { formatTime, KIND } = require('./comment.js');
const { SMALL_PR_LINES, TARGET_HOURS } = require('./clock.js');

const html = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function renderDashboard(clocks, { people }) {
  const nameOf = (login) => people[login]?.name || login;
  const logins = [...new Set([...Object.keys(people), ...clocks.map((c) => c.login)])].sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  const rows = logins.map((login) => {
    const mine = clocks.filter((c) => c.login === login);
    const overdue = mine.filter((c) => c.overdue).sort((a, b) => a.due - b.due);
    const status = overdue.length === 0 ? '✅' : `${overdue.length} overdue`;
    const list = overdue.length === 0 ? '' : `<ul>${overdue
      .map((c) => `<li><a href="${html(c.pr.url)}">${html(`${c.pr.repo}#${c.pr.number}`)}</a> ${html(c.pr.title)}: ${KIND[c.kind].toLowerCase()}, overdue since ${html(formatTime(c.due))}</li>`)
      .join('')}</ul>`;
    return `<tr><td>${html(nameOf(login))}</td><td>${status}</td><td>${mine.length}</td><td>${list}</td></tr>`;
  });
  return [
    '<p>Kept up to date by the Review SLA job every 30 minutes during business hours (10:00 to 17:00 Pacific, business days). ' +
      `An assignee owes a first response within ${TARGET_HOURS.small} business hours on a PR under ${SMALL_PR_LINES} added lines, ` +
      `${TARGET_HOURS.standard} otherwise, and a re-review within ${TARGET_HOURS.reReview}. Times are Pacific.</p>`,
    '<table><tbody><tr><th>Assignee</th><th>Status</th><th>Reviews owed</th><th>Overdue</th></tr>',
    ...rows,
    '</tbody></table>',
  ].join('');
}

// `baseUrl` ends in /wiki: https://<site>.atlassian.net/wiki, or for a scoped (service account)
// token, https://api.atlassian.com/ex/confluence/<cloud id>/wiki.
async function updateDashboard({ baseUrl, user, token, pageId, body, fetch = globalThis.fetch }) {
  const headers = {
    authorization: `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`,
    accept: 'application/json',
    'content-type': 'application/json',
  };
  const url = `${baseUrl.replace(/\/$/, '')}/rest/api/content/${pageId}`;
  const current = await fetch(`${url}?expand=version`, { headers });
  if (!current.ok) throw new Error(`Confluence: reading the page returned HTTP ${current.status}`);
  const page = await current.json();
  const message = `review-sla ${crypto.createHash('sha256').update(body).digest('hex').slice(0, 16)}`;
  if (page.version?.message === message) return false;
  const update = await fetch(url, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      id: pageId,
      type: 'page',
      title: page.title,
      version: { number: page.version.number + 1, minorEdit: true, message },
      body: { storage: { value: body, representation: 'storage' } },
    }),
  });
  if (!update.ok) throw new Error(`Confluence: updating the page returned HTTP ${update.status}`);
  return true;
}

module.exports = { renderDashboard, updateDashboard };
