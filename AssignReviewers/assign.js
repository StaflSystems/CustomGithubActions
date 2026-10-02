// Names the two people responsible for reviewing a ready PR (review RFC, Proposal 1) by making them
// its assignees: one domain approver from the domain team and one rotation reviewer. The whole
// review team is still requested as reviewers; the assignees are the ones who owe a response.
//
// - Mid-stack, it copies the assignees of the nearest PR below it that has any, so the same two
//   people own the whole stack.
// - Otherwise it picks the least-loaded available member of each team: fewest open, ready PRs
//   already assigned to them (not counting their own), skipping anyone the PTO calendar has out
//   today or next business day. Ties go to whoever was assigned longest ago.
// - The author is never an assignee (a self-assignment is removed). The review team is requested
//   unless someone from it already is, and an assignee outside the team is requested individually.
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
async function inheritedAssignees(github, owner, repo, pr, author, { maxDepth, parentWaitMs, pollMs, sleep }) {
  let baseRef = pr.base.ref;
  const seen = new Set([pr.number]);
  const assigneesOf = async (number) => {
    const { data } = await github.rest.pulls.get({ owner, repo, pull_number: number });
    return humanLogins(data.assignees).filter((login) => login !== author && login !== data.user.login);
  };
  for (let depth = 0; depth < maxDepth; depth++) {
    const parents = await github.rest.pulls.list({ owner, repo, state: 'open', head: `${owner}:${baseRef}` });
    const parent = parents.data.find((p) => !seen.has(p.number));
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
  const reviewed = new Set(
    humanLogins((await github.paginate(github.rest.pulls.listReviews, { owner, repo, pull_number: pr.number, per_page: 100 })).map((r) => r.user)),
  );
  const requested = new Set(humanLogins(current.requested_reviewers));
  const involved = (login) => requested.has(login) || reviewed.has(login);
  // The whole review team is requested, as authors used to do by hand, unless someone from it
  // already has been or has reviewed (so reruns and restacks don't re-request approvers).
  const reviewTeamMembers = await teamMembers(github, owner, reviewTeam);
  const teamAlreadyRequested = (current.requested_teams || []).some((t) => t.slug === reviewTeam);
  if (!teamAlreadyRequested && !reviewTeamMembers.some((login) => login !== author && involved(login))) {
    await github.rest.pulls.requestReviewers({ owner, repo, pull_number: pr.number, team_reviewers: [reviewTeam] });
    for (const login of reviewTeamMembers) requested.add(login);
    notes.push(`requested team ${reviewTeam}`);
  }
  // Assignees from outside the team (a designated domain owner, say) are requested individually.
  const toRequest = [...named].filter((login) => !involved(login));
  if (toRequest.length > 0) {
    await github.rest.pulls.requestReviewers({ owner, repo, pull_number: pr.number, reviewers: toRequest });
  }

  core.info(`Assignees: ${[...named].join(', ') || 'none'}${notes.length ? ` (${notes.join('; ')})` : ''}.`);
};
