// Picking a reviewer: the least-loaded available member of a team. Shared by AssignReviewers,
// which picks a new PR's assignees, and ReviewSLA, which replaces an assignee who is out.

async function teamMembers(github, org, team) {
  const members = await github.paginate(github.rest.teams.listMembersInOrg, { org, team_slug: team, per_page: 100 });
  return members.map((m) => m.login);
}

// For each login: `load`, how many open, ready PRs in the org have them as assignee, and
// `lastAssigned`, when they were last assigned to a PR (an ISO time, or absent if not recently).
// A PR doesn't count for its own author, so assigning yourself to your own PR doesn't make you
// look busy.
async function reviewerHistory(github, org, logins, core) {
  if (logins.length === 0) return { load: {}, lastAssigned: {} };
  let load;
  try {
    load = await queryLoad(github, org, logins);
  } catch (error) {
    core.warning(`Couldn't read reviewer load (${error.message}); picking without it.`);
    load = Object.fromEntries(logins.map((login) => [login, 0]));
  }
  let lastAssigned = {};
  try {
    lastAssigned = await queryLastAssigned(github, org, logins);
  } catch (error) {
    core.warning(`Couldn't read when reviewers were last assigned (${error.message}); breaking ties by PR number.`);
  }
  return { load, lastAssigned };
}

// Both are read from live PR data rather than GitHub search, whose index lags new assignments by
// minutes: several PRs opened close together would otherwise all see stale counts. They cover the
// org's most recently pushed repositories, which is where open PRs live.
async function queryLoad(github, org, logins) {
  const prFields = 'pageInfo { hasNextPage endCursor } nodes { isDraft author { login } assignees(first: 10) { nodes { login } } }';
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
        if (assignee.login in load && assignee.login !== pullRequest.author?.login) load[assignee.login]++;
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

// When each login was last assigned to someone else's PR, from the assignment events on the most
// recently updated PRs of the most recently pushed repositories. Kept small: one larger query
// times out.
async function queryLastAssigned(github, org, logins) {
  const data = await github.graphql(
    `query($org: String!) {
      organization(login: $org) {
        repositories(first: 20, orderBy: { field: PUSHED_AT, direction: DESC }) {
          nodes {
            pullRequests(first: 30, orderBy: { field: UPDATED_AT, direction: DESC }) {
              nodes {
                author { login }
                timelineItems(last: 10, itemTypes: [ASSIGNED_EVENT]) {
                  nodes { ... on AssignedEvent { createdAt assignee { ... on User { login } } } }
                }
              }
            }
          }
        }
      }
    }`,
    { org },
  );
  const wanted = new Set(logins);
  const lastAssigned = {};
  for (const repository of data.organization?.repositories?.nodes ?? []) {
    for (const pullRequest of repository.pullRequests?.nodes ?? []) {
      for (const event of pullRequest.timelineItems?.nodes ?? []) {
        const login = event.assignee?.login;
        if (!wanted.has(login) || login === pullRequest.author?.login || !event.createdAt) continue;
        if (!lastAssigned[login] || event.createdAt > lastAssigned[login]) lastAssigned[login] = event.createdAt;
      }
    }
  }
  return lastAssigned;
}

// The least-loaded candidate who isn't away, or the least-loaded of everyone if they all are.
// Most people have no open assigned PRs most of the time, since PRs merge quickly, so ties are
// common: they go to whoever was assigned longest ago (anyone not assigned recently first), and
// only then rotate by `seed` (the PR number).
// Returns { login, load, lastAssigned } or null when there are no candidates.
async function pickLeastLoaded({ github, org, core, candidates, away, seed }) {
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort();
  const { load, lastAssigned } = await reviewerHistory(github, org, sorted, core);
  const available = sorted.filter((login) => !away.has(login));
  const pool = available.length > 0 ? available : sorted;
  const least = Math.min(...pool.map((login) => load[login]));
  const tied = pool.filter((login) => load[login] === least);
  const since = (login) => (lastAssigned[login] ? Date.parse(lastAssigned[login]) : -Infinity);
  const longest = Math.min(...tied.map(since));
  const waited = tied.filter((login) => since(login) === longest);
  const login = waited[seed % waited.length];
  return { login, load: least, lastAssigned: lastAssigned[login] ?? null };
}

module.exports = { pickLeastLoaded, reviewerHistory, teamMembers };
