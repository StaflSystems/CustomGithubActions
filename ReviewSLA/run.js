// The scheduled Review SLA job (review RFC, Proposal 2). Each run rebuilds every assignee's clock
// from the open PRs' timelines, then, depending on REVIEW_SLA_MODE:
//
//   off      does nothing
//   shadow   keeps each PR's Review SLA comment, the Confluence dashboard and the 10:00 Slack digest
//            up to date (kept as the rollback)
//   remind   also DMs each assignee when their review is due, and reassigns an assignee the PTO
//            calendar has out before their review is due, across the whole stack
//   enforce  reassignment at twice the target (step 3); not built yet, so it runs as remind
//
// It fails safe: an API error is a warning, and that PR, repo or channel is skipped for this run.
// A missed reminder is cheap; a wrong reassignment isn't.

const { addDays, pacificDate, readHolidays, readOutDates } = require('../ReviewConfig/pto.js');
const { isBusinessDay, pacificOffset, pacificTime } = require('../ReviewConfig/hours.js');
const { pickLeastLoaded, teamMembers } = require('../ReviewConfig/pick.js');
const { hasSla } = require('./clock.js');
const { parseState, reminderKey, renderComment } = require('./comment.js');
const { renderDashboard, updateDashboard } = require('./confluence.js');
const { fetchOpenPrs } = require('./github.js');
const { approvedAt, assigneesOf, owedClocks, readySince, stackOf } = require('./owed.js');
const { digestText, postMessage, reminderText } = require('./slack.js');

const MODES = ['off', 'shadow', 'remind', 'enforce'];

// The scheduled runs at 10:00 Pacific, which post the digest: 17:00 UTC in daylight time and 18:00
// in standard time. Both fire all year; only the one that is 10:00 Pacific that day posts it.
const DIGEST_CRONS = { '-7': '0 17 * * 1-5', '-8': '0 18 * * 1-5' };

function readMode(value, core) {
  const mode = (value || 'off').trim().toLowerCase();
  if (!MODES.includes(mode)) {
    core.warning(`Unknown REVIEW_SLA_MODE '${value}'; running as shadow.`);
    return 'shadow';
  }
  if (mode === 'enforce') {
    core.warning("REVIEW_SLA_MODE 'enforce' (reassignment at twice the target) isn't built yet; running as remind.");
    return 'remind';
  }
  return mode;
}

function readPeople(value, core) {
  if (value && typeof value === 'object') return value;
  try {
    return JSON.parse(value || '{}');
  } catch {
    core.warning("The REVIEW_PEOPLE org variable isn't valid JSON; reminders and names are off this run.");
    return {};
  }
}

// Business days, from opening until half an hour after closing, so dues at 17:00 are caught.
function inBusinessHours(now, holidays) {
  const today = pacificDate(now);
  return isBusinessDay(today, holidays) && now >= pacificTime(today, 10) && now <= pacificTime(today, 17.5);
}

function isDigestRun(inputs, now) {
  if (String(inputs.digest) === 'true') return true;
  return inputs.eventName === 'schedule' && inputs.schedule === DIGEST_CRONS[String(pacificOffset(pacificDate(now)))];
}

// Whether the calendar has `login` out on any day from today to the day the review is due.
function outBefore(out, login, due, now) {
  const dates = out[login];
  if (!dates) return false;
  for (let date = pacificDate(now); date <= pacificDate(due); date = addDays(date, 1)) if (dates.has(date)) return true;
  return false;
}

// Replaces `login` with someone from the same team on every PR in the stack they're assigned to
// and haven't approved; their approvals stand. The domain approver is replaced from the domain
// team, the rotation reviewer from the rotation team.
async function reassign({ github, core, owner, inputs, teams, clock, stack, out, now }) {
  const { pr, login } = clock;
  const others = assigneesOf(pr).filter((l) => l !== login);
  const domain = await teams(inputs.domainTeam);
  const fromDomain = domain.includes(login) && !others.some((l) => domain.includes(l));
  const team = fromDomain ? inputs.domainTeam : inputs.rotationTeam;
  const members = fromDomain ? domain : await teams(inputs.rotationTeam);
  const authors = new Set(stack.map((p) => p.author.login));
  const candidates = members.filter((m) => m !== login && !others.includes(m) && !authors.has(m));
  const away = new Set(Object.keys(out).filter((l) => outBefore(out, l, clock.due, now)));
  const chosen = await pickLeastLoaded({ github, org: owner, core, candidates, away, seed: pr.number });
  if (!chosen || away.has(chosen.login)) {
    core.warning(`${pr.repo}#${pr.number}: ${login} is out before their review is due, but no one else in ${team} is available.`);
    return [];
  }
  const changed = stack.filter((p) => assigneesOf(p).includes(login) && !approvedAt(p, login));
  if (changed.length === 0) return [];
  for (const p of changed) {
    await github.rest.issues.removeAssignees({ owner, repo: p.repo, issue_number: p.number, assignees: [login] });
    await github.rest.issues.addAssignees({ owner, repo: p.repo, issue_number: p.number, assignees: [chosen.login] });
    p.assignees = [...p.assignees.filter((l) => l !== login), chosen.login];
    try {
      await github.rest.pulls.requestReviewers({ owner, repo: p.repo, pull_number: p.number, reviewers: [chosen.login] });
    } catch (error) {
      core.warning(`${p.repo}#${p.number}: couldn't request a review from ${chosen.login} (${error.message}).`);
    }
  }
  const numbers = changed.map((p) => `#${p.number}`).join(', ');
  // A public repo's PRs are visible to anyone, so they don't say why.
  const reason = pr.isPrivate === false ? `\`${login}\` isn't available` : `the PTO calendar has \`${login}\` out`;
  await github.rest.issues.createComment({
    owner,
    repo: pr.repo,
    issue_number: changed[0].number,
    body:
      `**Review SLA:** ${reason} before their review is due, so @${chosen.login} ` +
      `takes over from them as assignee on ${numbers}, picked from ${team} by fewest open assigned PRs.`,
  });
  core.info(`${pr.repo}: reassigned ${login} to ${chosen.login} on ${numbers} (out of office).`);
  return changed.map((p) => `${p.repo}#${p.number}:${login}`);
}

module.exports = async function run({ github, core, inputs, now = new Date(), fetch = globalThis.fetch, holidays = readHolidays() }) {
  const mode = readMode(inputs.mode, core);
  if (mode === 'off') return core.info('REVIEW_SLA_MODE is off: nothing to do.');
  if (inputs.eventName === 'schedule' && !inBusinessHours(now, holidays)) {
    return core.info('Outside business hours: nothing to do.');
  }
  const remind = mode === 'remind';
  const owner = inputs.owner || 'StaflSystems';
  const people = readPeople(inputs.people, core);
  const repos = (inputs.repos || '').split(/[\s,]+/).filter(Boolean);
  const dashboardUrl = inputs.dashboardUrl || '';

  // 1. Every open PR, and every running clock.
  const prs = [];
  let clocks = [];
  for (const repo of repos) {
    try {
      const open = await fetchOpenPrs({ github, core, owner, repo });
      prs.push(...open);
      clocks.push(...owedClocks(open, { now, holidays }));
    } catch (error) {
      core.warning(`${repo}: couldn't read open PRs (${error.message}); skipping it this run.`);
    }
  }

  // 2. Out of office: hand the review to someone else before it's due.
  if (remind && clocks.length > 0) {
    const out = await readOutDates({ url: inputs.ptoCalendarUrl, core, people, now, fetch, holidays });
    if (out) {
      const teamCache = new Map();
      const teams = async (slug) => {
        if (!teamCache.has(slug)) teamCache.set(slug, await teamMembers(github, owner, slug));
        return teamCache.get(slug);
      };
      const reassigned = new Set();
      for (const clock of clocks) {
        if (reassigned.has(`${clock.pr.repo}#${clock.pr.number}:${clock.login}`) || !outBefore(out, clock.login, clock.due, now)) continue;
        const stack = stackOf(clock.pr, prs.filter((p) => p.repo === clock.pr.repo));
        try {
          for (const key of await reassign({ github, core, owner, inputs, teams, clock, stack, out, now })) reassigned.add(key);
        } catch (error) {
          core.warning(`${clock.pr.repo}#${clock.pr.number}: couldn't reassign ${clock.login} (${error.message}).`);
        }
      }
      clocks = clocks.filter((c) => !reassigned.has(`${c.pr.repo}#${c.pr.number}:${c.login}`));
    }
  }

  // 3. Each PR's comment, then the DMs it records. The comment is written first, so a failed
  //    write means a missed reminder rather than a repeated one.
  const slackIdMissing = new Set();
  let reminders = 0;
  for (const pr of prs) {
    if (!hasSla(pr)) continue;
    const mine = clocks.filter((c) => c.pr === pr);
    if (!pr.sticky && mine.length === 0) continue;
    const keys = new Set(mine.map(reminderKey));
    const reminded = parseState(pr.sticky?.body).reminded.filter((k) => keys.has(k));
    const due = !remind || !inputs.slackToken ? [] : mine.filter((c) => c.overdue && !reminded.includes(reminderKey(c)));
    const sendable = due.filter((c) => {
      if (people[c.login]?.slack) return true;
      slackIdMissing.add(c.login);
      return false;
    });
    const state = { reminded: [...reminded, ...sendable.map(reminderKey)] };
    const body = renderComment(readySince(pr) ? mine : [], state, { dashboardUrl });
    try {
      if (!pr.sticky) await github.rest.issues.createComment({ owner, repo: pr.repo, issue_number: pr.number, body });
      else if (body !== pr.sticky.body) await github.rest.issues.updateComment({ owner, repo: pr.repo, comment_id: pr.sticky.id, body });
    } catch (error) {
      core.warning(`${pr.repo}#${pr.number}: couldn't write the Review SLA comment (${error.message}); no reminders for it this run.`);
      continue;
    }
    for (const clock of sendable) {
      try {
        await postMessage({ token: inputs.slackToken, channel: people[clock.login].slack, text: reminderText(clock), fetch });
        reminders++;
      } catch (error) {
        core.warning(`${pr.repo}#${pr.number}: couldn't DM ${clock.login} (${error.message}).`);
      }
    }
  }
  if (slackIdMissing.size > 0) core.warning(`No Slack ID in REVIEW_PEOPLE for ${[...slackIdMissing].join(', ')}, so they get no reminders.`);

  // 4. The 10:00 digest.
  if (isDigestRun(inputs, now)) {
    if (!inputs.slackToken || !inputs.slackChannel) core.info('No Slack token or digest channel configured; no digest.');
    else {
      try {
        await postMessage({ token: inputs.slackToken, channel: inputs.slackChannel, text: digestText(clocks, { now, people, dashboardUrl }), fetch });
        core.info('Posted the digest.');
      } catch (error) {
        core.warning(`Couldn't post the digest (${error.message}).`);
      }
    }
  }

  // 5. The dashboard.
  if (!inputs.confluenceUrl || !inputs.confluenceUser || !inputs.confluenceToken || !inputs.confluencePageId) {
    core.info('Confluence isn\'t fully configured; not updating the dashboard.');
  } else {
    try {
      const saved = await updateDashboard({
        baseUrl: inputs.confluenceUrl,
        user: inputs.confluenceUser,
        token: inputs.confluenceToken,
        pageId: inputs.confluencePageId,
        body: renderDashboard(clocks, { people }),
        fetch,
      });
      core.info(saved ? 'Updated the dashboard.' : 'Dashboard unchanged.');
    } catch (error) {
      core.warning(`Couldn't update the dashboard (${error.message}).`);
    }
  }

  const overdue = clocks.filter((c) => c.overdue).length;
  core.info(`Mode ${mode}: ${prs.length} open PRs, ${clocks.length} reviews owed, ${overdue} overdue, ${reminders} reminders sent.`);
  return { clocks, reminders };
};

module.exports.inBusinessHours = inBusinessHours;
module.exports.isDigestRun = isDigestRun;
