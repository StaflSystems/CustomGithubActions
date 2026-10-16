// Names the two people responsible for reviewing a ready PR (review RFC, Proposal 1) by making them
// its assignees: one domain approver from the domain team and one rotation reviewer. The whole
// review team is still requested as reviewers; the assignees are the ones who owe a response.
//
// - Mid-stack, it copies the assignees of the nearest PR below it that has any, so the same two
//   people own the whole stack.
// - Otherwise it picks the least-loaded available member of each team: fewest open, ready PRs
//   already assigned to them (not counting their own), skipping anyone the PTO calendar has out
//   today or next business day. Ties go to whoever was assigned longest ago.
// - The author is never an assignee (a self-assignment is removed). Each member of the review team,
//   and any assignee outside it, is requested individually, unless they already are or their
//   approval stands.
// - A PR that already has a domain approver and a second assignee only gets the review requests
//   topped up, so reruns are harmless and hand-picked assignees are kept.

const { pickLeastLoaded, teamMembers } = require('../ReviewConfig/pick.js');
const { awaySoon } = require('../ReviewConfig/pto.js');

function isBot(user) {
  return !user || user.type === 'Bot' || user.login.endsWith('[bot]');
}

function humanLogins(users) {
  return (users || []).filter((u) => !isBot(u)).map((u) => u.login);
}

// Walks down the stack (this PR's base, then that PR's base, ...) and returns the assignees of the
// nearest open PR that has any, or null when the walk reaches a branch with no open PR.
//
// When a whole stack is submitted at once, every PR's run starts together. So if a ready PR below
// has no assignees yet, wait for its own run to assign them before looking further down.
//
// The PR below is found by matching head branches across the repo's open PRs rather than with the
// list endpoint's `head: owner:branch` filter. In a repo that is a fork of another repo in the same
// org (goldengate-bms2000-string is a fork of stafl-bms2000-template), that filter finds nothing.
async function inheritedAssignees(github, owner, repo, pr, author, { maxDepth, parentWaitMs, pollMs, sleep }) {
  let baseRef = pr.base.ref;
  const seen = new Set([pr.number]);
  const assigneesOf = async (number) => {
    const { data } = await github.rest.pulls.get({ owner, repo, pull_number: number });
    return humanLogins(data.assignees).filter((login) => login !== author && login !== data.user.login);
  };
  // PRs from other repos (forks) can share a branch name with this repo's stack, so they're left out.
  const thisRepo = `${owner}/${repo}`.toLowerCase();
  const open = (await github.paginate(github.rest.pulls.list, { owner, repo, state: 'open', per_page: 100 })).filter(
    (p) => p.head.repo?.full_name.toLowerCase() === thisRepo,
  );
  for (let depth = 0; depth < maxDepth; depth++) {
    const parent = open.find((p) => p.head.ref === baseRef && !seen.has(p.number));
    if (!parent) return null;
    seen.add(parent.number);
    let assignees = await assigneesOf(parent.number);
    for (let waited = 0; assignees.length === 0 && !parent.draft && waited < parentWaitMs; waited += pollMs) {
      await sleep(pollMs);
      assignees = await assigneesOf(parent.number);
    }
    if (assignees.length > 0) return { from: parent.number, assignees };
    baseRef = parent.base.ref;
  }
  return null;
}

module.exports = async ({ github, context, core, inputs, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) => {
  const { owner, repo } = context.repo;
  const pr = context.payload.pull_request;
  const author = pr.user.login;
  const rotationTeam = inputs.rotationTeam;
  const domainTeam = inputs.domainTeam;
  const reviewTeam = inputs.reviewTeam || rotationTeam;
  const maxDepth = Number(inputs.maxStackDepth || 30);
  const parentWaitMs = Number(inputs.parentWaitMs ?? 120000);
  const pollMs = Number(inputs.pollMs ?? 10000);
  const pto = inputs.pto || {};

  if (pr.draft) return core.info('Draft PR: nothing to do.');
  if (isBot(pr.user)) return core.info(`Bot-authored PR (${author}): nothing to do.`);
  if (pr.head.ref.startsWith('gtmq_')) return core.info('Merge-queue PR: nothing to do.');

  const { data: current } = await github.rest.pulls.get({ owner, repo, pull_number: pr.number });
  const originalAssignees = humanLogins(current.assignees);
  const named = new Set(originalAssignees.filter((login) => login !== author));
  const domainMembers = await teamMembers(github, owner, domainTeam);
  const hasDomainApprover = () => [...named].some((login) => domainMembers.includes(login));
  const notes = [];

  if (!(hasDomainApprover() && named.size >= 2)) {
    // 1. Same assignees as the rest of the stack.
    const inherited = await inheritedAssignees(github, owner, repo, pr, author, {
      maxDepth,
      parentWaitMs,
      pollMs,
      sleep,
    });
    if (inherited) {
      for (const login of inherited.assignees) named.add(login);
      notes.push(`inherited ${inherited.assignees.join(', ')} from #${inherited.from}`);
    }

    // 2. Fill the domain approver, then the rotation reviewer, least-loaded first.
    let away;
    const pick = async (team, members) => {
      const candidates = members.filter((login) => login !== author && !named.has(login));
      if (candidates.length === 0) return null;
      away ??= await awaySoon({ url: inputs.ptoCalendarUrl, people: inputs.people, core, ...pto });
      const chosen = await pickLeastLoaded({ github, org: owner, core, candidates, away, seed: pr.number });
      const last = chosen.lastAssigned ? `last assigned ${chosen.lastAssigned.slice(0, 10)}` : 'not assigned recently';
      notes.push(`picked ${chosen.login} from ${team} (${chosen.load} open assigned PRs, ${last})`);
      return chosen.login;
    };
    if (!hasDomainApprover()) {
      const chosen = await pick(domainTeam, domainMembers);
      if (chosen) named.add(chosen);
      else core.warning(`No one in ${domainTeam} is available to be the domain approver.`);
    }
    if (named.size < 2) {
      const chosen = await pick(rotationTeam, await teamMembers(github, owner, rotationTeam));
      if (chosen) named.add(chosen);
      else core.warning(`Only ${named.size} assignee(s) and no one left in ${rotationTeam} to add.`);
    }
  }

  // 3. Apply: assignees, author's self-assignment, review requests.
  const toAssign = [...named].filter((login) => !originalAssignees.includes(login));
  if (toAssign.length > 0) {
    await github.rest.issues.addAssignees({ owner, repo, issue_number: pr.number, assignees: toAssign });
  }
  if (originalAssignees.includes(author)) {
    await github.rest.issues.removeAssignees({ owner, repo, issue_number: pr.number, assignees: [author] });
    notes.push(`removed author ${author} from assignees`);
  }
  // Everyone on the review team, and any assignee from outside it (a designated domain owner, say),
  // is requested individually rather than as a team: the team's auto-assignment turns a team
  // request back into the same individual requests, approvers included, so the only way to leave
  // out the people who don't need asking is per person. That's the author, anyone already
  // requested, and anyone whose approval stands. A review that's only a comment, or an approval
  // since dismissed or replaced by a change request, doesn't count, so an early comment doesn't
  // keep anyone else from being asked.
  const reviews = await github.paginate(github.rest.pulls.listReviews, { owner, repo, pull_number: pr.number, per_page: 100 });
  const decisive = new Map();
  for (const review of reviews) {
    if (!isBot(review.user) && (review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED')) decisive.set(review.user.login, review.state);
  }
  const approved = (login) => decisive.get(login) === 'APPROVED';
  const requested = new Set(humanLogins(current.requested_reviewers));
  // A team that's already requested (by hand, say) already covers its members.
  const reviewTeamMembers = await teamMembers(github, owner, reviewTeam);
  if ((current.requested_teams || []).some((t) => t.slug === reviewTeam)) for (const login of reviewTeamMembers) requested.add(login);
  const toRequest = [...new Set([...reviewTeamMembers, ...named])].filter(
    (login) => login !== author && !requested.has(login) && !approved(login),
  );
  if (toRequest.length > 0) {
    await github.rest.pulls.requestReviewers({ owner, repo, pull_number: pr.number, reviewers: toRequest });
    notes.push(`requested ${toRequest.join(', ')}`);
  }

  core.info(`Assignees: ${[...named].join(', ') || 'none'}${notes.length ? ` (${notes.join('; ')})` : ''}.`);
};
