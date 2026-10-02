// Picking a reviewer: the least-loaded available member of a team. Shared by AssignReviewers,
// which picks a new PR's assignees, and ReviewSLA, which replaces an assignee who is out.

async function teamMembers(github, org, team) {
  const members = await github.paginate(github.rest.teams.listMembersInOrg, { org, team_slug: team, per_page: 100 });
  return members.map((m) => m.login);
}

// For each login: how many open, ready PRs in the org already have them as assignee.
async function reviewerLoad(github, org, logins, core) {
  if (logins.length === 0) return {};
  try {
    return await queryLoad(github, org, logins);
  } catch (error) {
    core.warning(`Couldn't read reviewer load (${error.message}); picking without it.`);
    return Object.fromEntries(logins.map((login) => [login, 0]));
  }
}

// Load is counted from live PR data rather than GitHub search, whose index lags new assignments
// by minutes: several PRs opened close together would otherwise all see stale counts. The query
// covers the org's most recently pushed repositories, which is where open PRs live.
async function queryLoad(github, org, logins) {
  const prFields = 'pageInfo { hasNextPage endCursor } nodes { isDraft assignees(first: 10) { nodes { login } } }';
  const data = await github.graphql(
    `query($org: String!) {
      organization(login: $org) {
        repositories(first: 50, orderBy: { field: PUSHED_AT, direction: DESC }) {
          nodes { name pullRequests(states: OPEN, first: 100) { ${prFields} } }
        }
      }
    }`,
    { org },
  );
  const load = Object.fromEntries(logins.map((login) => [login, 0]));
  const count = (pullRequests) => {
    for (const pullRequest of pullRequests?.nodes ?? []) {
      if (pullRequest.isDraft) continue;
      for (const assignee of pullRequest.assignees?.nodes ?? []) {
        if (assignee.login in load) load[assignee.login]++;
      }
    }
  };
  for (const repository of data.organization?.repositories?.nodes ?? []) {
    let page = repository.pullRequests;
    count(page);
    // Busy repos (StaflLib) have more than one page of open PRs.
    while (page?.pageInfo?.hasNextPage) {
      const next = await github.graphql(
        `query($org: String!, $name: String!, $after: String!) {
          repository(owner: $org, name: $name) { pullRequests(states: OPEN, first: 100, after: $after) { ${prFields} } }
        }`,
        { org, name: repository.name, after: page.pageInfo.endCursor },
      );
      page = next.repository?.pullRequests;
      count(page);
    }
  }
  return load;
}

// The least-loaded candidate who isn't away, or the least-loaded of everyone if they all are.
// Ties rotate by `seed` (the PR number) so they don't always go to the same person.
// Returns { login, load } or null when there are no candidates.
async function pickLeastLoaded({ github, org, core, candidates, away, seed }) {
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort();
  const load = await reviewerLoad(github, org, sorted, core);
  const available = sorted.filter((login) => !away.has(login));
  const pool = available.length > 0 ? available : sorted;
  const least = Math.min(...pool.map((login) => load[login]));
  const tied = pool.filter((login) => load[login] === least);
  return { login: tied[seed % tied.length], load: least };
}

module.exports = { pickLeastLoaded, reviewerLoad, teamMembers };
