#!/usr/bin/env node
// Report mode: weekly first-response numbers for a date range (review RFC, Proposal 2).
//
//   node ReviewSLA/report.js StaflLib coit-tower-bms2000 --since 2026-06-26 --until 2026-09-24
//
// Writes review_sla_<since>_<until>.md and a prs.tsv with one row per PR to --out. Each PR counts
// in the week (Monday to Sunday, Pacific) its clock started, and events after --until are ignored,
// so a past range reads the same however long after it the report is run.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { addDays, pacificDate, readHolidays } = require('../ReviewConfig/pto.js');
const { pacificTime } = require('../ReviewConfig/hours.js');
const { firstResponse, hasSla, SMALL_PR_LINES, TARGET_HOURS } = require('./clock.js');

// PRs created this long before --since are still fetched, in case they were marked ready in range.
const LOOKBACK_DAYS = 60;

const PR_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 50, after: $after, orderBy: { field: CREATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number url createdAt closedAt isDraft additions headRefName
        author { __typename login }
        timelineItems(first: 100, itemTypes: [READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT, PULL_REQUEST_REVIEW]) {
          pageInfo { hasNextPage }
          nodes {
            __typename
            ... on ReadyForReviewEvent { createdAt }
            ... on ConvertToDraftEvent { createdAt }
            ... on PullRequestReview { state submittedAt body comments { totalCount } author { __typename login } }
          }
        }
      }
    }
  }
}`;

const actor = (a) => a && { login: a.login, bot: a.__typename === 'Bot' };

// GraphQL nodes to the PR shape clock.js reads. Pending reviews (no submittedAt) are dropped.
// Only the first 100 timeline items are read. First responses come early, so that's almost always
// enough; a PR with more and no response in the first 100 is flagged as truncated.
function toPr(node) {
  const timeline = [];
  for (const item of node.timelineItems.nodes) {
    if (item.__typename === 'ReadyForReviewEvent') timeline.push({ type: 'ready', at: new Date(item.createdAt) });
    else if (item.__typename === 'ConvertToDraftEvent') timeline.push({ type: 'draft', at: new Date(item.createdAt) });
    else if (item.__typename === 'PullRequestReview' && item.submittedAt) {
      timeline.push({
        type: 'review',
        at: new Date(item.submittedAt),
        author: actor(item.author),
        state: item.state,
        body: item.body,
        comments: item.comments.totalCount,
      });
    }
  }
  return {
    number: node.number,
    url: node.url,
    author: actor(node.author) ?? { login: 'ghost', bot: false },
    createdAt: new Date(node.createdAt),
    closedAt: node.closedAt ? new Date(node.closedAt) : null,
    isDraft: node.isDraft,
    additions: node.additions,
    headRefName: node.headRefName,
    truncated: node.timelineItems.pageInfo.hasNextPage,
    timeline,
  };
}

async function fetchPrs({ graphql, owner, repo, since }) {
  const oldest = pacificTime(addDays(since, -LOOKBACK_DAYS), 0);
  const prs = [];
  for (let after = null; ; ) {
    const data = await graphql(PR_QUERY, { owner, name: repo, after });
    const page = data.repository.pullRequests;
    for (const node of page.nodes) prs.push(toPr(node));
    const last = page.nodes.at(-1);
    if (!page.pageInfo.hasNextPage || !last || new Date(last.createdAt) < oldest) break;
    after = page.pageInfo.endCursor;
  }
  return prs;
}

// Percentile by linear interpolation between closest ranks.
function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (sorted.length - 1) * p;
  const low = Math.floor(rank);
  return sorted[low] + (sorted[Math.min(low + 1, sorted.length - 1)] - sorted[low]) * (rank - low);
}

// The Monday of the week a date is in.
function weekOf(date) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return addDays(date, -((day + 6) % 7));
}

function summarize(rows) {
  const rfcHours = rows.filter((r) => r.rfc?.hours != null).map((r) => r.rfc.hours);
  const responded = rows.filter((r) => r.sla.status === 'responded');
  const known = rows.filter((r) => r.sla.met != null);
  return {
    rfc: {
      timed: rfcHours.length,
      median: percentile(rfcHours, 0.5),
      p90: percentile(rfcHours, 0.9),
      within8: rfcHours.length ? rfcHours.filter((h) => h <= 8).length / rfcHours.length : null,
    },
    sla: {
      responded: responded.length,
      median: percentile(responded.map((r) => r.sla.hours), 0.5),
      p90: percentile(responded.map((r) => r.sla.hours), 0.9),
      withinTarget: known.length ? known.filter((r) => r.sla.met).length / known.length : null,
      overdue: rows.filter((r) => r.sla.met === false && r.sla.status !== 'responded').length,
    },
  };
}

// Every PR with an SLA, with both clocks, and the dates each clock started (null if it never did).
function measure(prs, { since, until, holidays }) {
  const end = pacificTime(addDays(until, 1), 0);
  const inRange = (start) => start && pacificDate(start) >= since && pacificDate(start) <= until;
  return prs.filter(hasSla).map((pr) => {
    const { rfc, sla } = firstResponse(pr, { until: end, holidays });
    return {
      pr,
      rfc: inRange(rfc?.start) ? rfc : null,
      sla,
      slaInRange: inRange(sla.start),
    };
  });
}

const fmt = (h) => (h == null ? '—' : `${h.toFixed(1)}`);
const pct = (f) => (f == null ? '—' : `${Math.round(f * 100)}%`);

function table(measured) {
  const weeks = new Map();
  const add = (week, kind, row) => {
    if (!weeks.has(week)) weeks.set(week, { rfc: [], sla: [] });
    weeks.get(week)[kind].push(row);
  };
  for (const row of measured) {
    if (row.rfc) add(weekOf(pacificDate(row.rfc.start)), 'rfc', row);
    if (row.slaInRange) add(weekOf(pacificDate(row.sla.start)), 'sla', row);
  }
  const lines = [
    '| Week of | RFC: timed | median h | p90 h | within 8 h | SLA: responded | median bh | p90 bh | within target | overdue, unreviewed |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  const line = (label, rfcRows, slaRows) => {
    const { rfc } = summarize(rfcRows);
    const { sla } = summarize(slaRows);
    lines.push(
      `| ${label} | ${rfc.timed} | ${fmt(rfc.median)} | ${fmt(rfc.p90)} | ${pct(rfc.within8)} | ` +
        `${sla.responded} | ${fmt(sla.median)} | ${fmt(sla.p90)} | ${pct(sla.withinTarget)} | ${sla.overdue} |`,
    );
  };
  for (const week of [...weeks.keys()].sort()) line(week, weeks.get(week).rfc, weeks.get(week).sla);
  line(
    '**All**',
    measured.filter((r) => r.rfc),
    measured.filter((r) => r.slaInRange),
  );
  return lines.join('\n');
}

function renderReport(byRepo, { since, until }) {
  const parts = [
    `# First response, ${since} to ${until}`,
    '',
    'RFC columns measure as the RFC did: wall-clock hours from the first ready event (or creation) to the first',
    'review by anyone but the author, leaving out PRs reviewed before that. SLA columns follow the SLA clock rules:',
    `business hours (10:00 to 17:00 Pacific, business days) from the latest time the PR was marked ready, to the first`,
    `review that counts. The target is ${TARGET_HOURS.small} h under ${SMALL_PR_LINES} added lines and ${TARGET_HOURS.standard} h otherwise. "Within target" also counts`,
    'PRs still unreviewed past their target as misses. Weeks start on Monday, by when each clock started.',
  ];
  for (const [repo, measured] of Object.entries(byRepo)) {
    const untimed = measured.filter((r) => r.sla.status === 'reviewed while draft').length;
    parts.push('', `## ${repo}`, '', table(measured));
    if (untimed) parts.push('', `${untimed} PRs were reviewed while still drafts, so the SLA columns don't time them.`);
  }
  return `${parts.join('\n')}\n`;
}

function tsv(byRepo) {
  const iso = (d) => (d ? d.toISOString() : '');
  const num = (h) => (h == null ? '' : h.toFixed(2));
  const rows = [['repo', 'pr', 'author', 'additions', 'rfc_start', 'rfc_first_review', 'rfc_hours', 'sla_status', 'sla_start', 'sla_first_response', 'reviewer', 'business_hours', 'target', 'met']];
  for (const [repo, measured] of Object.entries(byRepo)) {
    for (const { pr, rfc, sla, slaInRange } of measured) {
      if (!rfc && !slaInRange) continue;
      rows.push([repo, pr.number, pr.author.login, pr.additions, iso(rfc?.start), iso(rfc?.reviewedAt), num(rfc?.hours), sla.status,
        iso(sla.start), iso(sla.reviewedAt), sla.reviewer ?? '', num(sla.hours), sla.target, sla.met ?? '']);
    }
  }
  return `${rows.map((r) => r.join('\t')).join('\n')}\n`;
}

function githubGraphql(token) {
  return async (query, variables) => {
    const response = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: { authorization: `bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    const body = await response.json();
    if (!response.ok || body.errors) throw new Error(`GraphQL: ${JSON.stringify(body.errors ?? body)}`);
    return body.data;
  };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      since: { type: 'string' },
      until: { type: 'string' },
      owner: { type: 'string', default: 'StaflSystems' },
      out: { type: 'string', default: 'review-sla-report' },
    },
  });
  const { since, until, owner, out } = values;
  if (!since || !until || positionals.length === 0) {
    console.error('Usage: node ReviewSLA/report.js <repo>... --since YYYY-MM-DD --until YYYY-MM-DD [--owner org] [--out dir]');
    process.exit(2);
  }
  const token = process.env.GITHUB_TOKEN || execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  const graphql = githubGraphql(token);
  const holidays = readHolidays();
  const byRepo = {};
  for (const repo of positionals) {
    const prs = await fetchPrs({ graphql, owner, repo, since });
    byRepo[repo] = measure(prs, { since, until, holidays });
    for (const { pr, sla } of byRepo[repo]) {
      if (pr.truncated && sla.status !== 'responded') {
        console.error(`${repo}#${pr.number}: more than 100 timeline items and no response in the first 100; its SLA clock may be wrong.`);
      }
    }
    console.error(`${repo}: ${prs.length} PRs fetched.`);
  }
  fs.mkdirSync(out, { recursive: true });
  const report = renderReport(byRepo, { since, until });
  fs.writeFileSync(path.join(out, `review_sla_${since}_${until}.md`), report);
  fs.writeFileSync(path.join(out, 'prs.tsv'), tsv(byRepo));
  process.stdout.write(report);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { measure, percentile, renderReport, toPr, weekOf };
