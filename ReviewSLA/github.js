// Reads a repo's open PRs, with the timeline events owed.js needs and the PR's Review SLA comment.

const { MARKER } = require('./comment.js');

const TIMELINE_TYPES = [
  'READY_FOR_REVIEW_EVENT',
  'CONVERT_TO_DRAFT_EVENT',
  'PULL_REQUEST_REVIEW',
  'ASSIGNED_EVENT',
  'UNASSIGNED_EVENT',
  'REVIEW_REQUESTED_EVENT',
  'BASE_REF_CHANGED_EVENT',
].join(', ');

const TIMELINE_FIELDS = `
  pageInfo { hasPreviousPage startCursor }
  nodes {
    __typename
    ... on ReadyForReviewEvent { createdAt }
    ... on ConvertToDraftEvent { createdAt }
    ... on PullRequestReview { databaseId state submittedAt body comments { totalCount } author { __typename login } }
    ... on AssignedEvent { createdAt assignee { ... on User { login } } }
    ... on UnassignedEvent { createdAt assignee { ... on User { login } } }
    ... on ReviewRequestedEvent { createdAt requestedReviewer { ... on User { login } } }
    ... on BaseRefChangedEvent { createdAt }
  }`;

const OPEN_PRS = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 30, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number url title isDraft additions headRefName headRefOid baseRefName createdAt
        author { __typename login }
        assignees(first: 10) { nodes { login } }
        comments(last: 50) { nodes { databaseId body } }
        timelineItems(last: 100, itemTypes: [${TIMELINE_TYPES}]) { ${TIMELINE_FIELDS} }
      }
    }
  }
}`;

const EARLIER_TIMELINE = `query($owner: String!, $name: String!, $number: Int!, $before: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      timelineItems(last: 100, before: $before, itemTypes: [${TIMELINE_TYPES}]) { ${TIMELINE_FIELDS} }
    }
  }
}`;

const actor = (a) => a && { login: a.login, bot: a.__typename === 'Bot' };

function toEvent(item) {
  const at = (iso) => (iso ? new Date(iso) : null);
  switch (item.__typename) {
    case 'ReadyForReviewEvent':
      return { type: 'ready', at: at(item.createdAt) };
    case 'ConvertToDraftEvent':
      return { type: 'draft', at: at(item.createdAt) };
    case 'PullRequestReview':
      // Pending reviews have no submittedAt and aren't visible to anyone else yet.
      return item.submittedAt && {
        type: 'review',
        at: at(item.submittedAt),
        author: actor(item.author),
        state: item.state,
        body: item.body,
        comments: item.comments.totalCount,
        id: item.databaseId,
        commit: null,
      };
    case 'AssignedEvent':
    case 'UnassignedEvent':
      return item.assignee?.login && { type: item.__typename === 'AssignedEvent' ? 'assigned' : 'unassigned', at: at(item.createdAt), login: item.assignee.login };
    case 'ReviewRequestedEvent':
      return item.requestedReviewer?.login && { type: 'requested', at: at(item.createdAt), login: item.requestedReviewer.login };
    case 'BaseRefChangedEvent':
      return { type: 'base', at: at(item.createdAt) };
    default:
      return null;
  }
}

function toOpenPr(repo, node, items) {
  const sticky = node.comments.nodes.find((c) => c.body?.startsWith(MARKER));
  return {
    repo,
    number: node.number,
    url: node.url,
    title: node.title,
    isDraft: node.isDraft,
    additions: node.additions,
    headRefName: node.headRefName,
    headRefOid: node.headRefOid,
    baseRefName: node.baseRefName,
    createdAt: new Date(node.createdAt),
    closedAt: null,
    author: actor(node.author) ?? { login: 'ghost', bot: false },
    assignees: node.assignees.nodes.map((a) => a.login),
    timeline: items.map(toEvent).filter(Boolean),
    sticky: sticky ? { id: sticky.databaseId, body: sticky.body } : null,
  };
}

// Whether a re-review clock could be running: a re-request of someone after their own review.
function mayOweReReview(pr) {
  if (pr.isDraft) return false;
  const reviewed = new Map();
  for (const e of [...pr.timeline].sort((a, b) => a.at - b.at)) {
    if (e.type === 'review' && e.author) reviewed.set(e.author.login, e.at);
    if (e.type === 'requested' && reviewed.has(e.login)) return true;
  }
  return false;
}

// The commit each review was left on, which tells whether the author has pushed since. GraphQL
// only gives it with the app's Contents permission in private repos; REST's commit_id doesn't
// need it. On failure the commits stay unknown, so no re-review clock starts.
async function addReviewCommits({ github, core, owner, pr }) {
  try {
    const reviews = await github.paginate(github.rest.pulls.listReviews, { owner, repo: pr.repo, pull_number: pr.number, per_page: 100 });
    const commits = new Map(reviews.map((r) => [r.id, r.commit_id]));
    for (const e of pr.timeline) if (e.type === 'review') e.commit = commits.get(e.id) ?? null;
  } catch (error) {
    core.warning(`${pr.repo}#${pr.number}: couldn't read which commits were reviewed (${error.message}); no re-review clocks on it this run.`);
  }
}

// Earlier timeline pages are read for PRs with more than 100 events, up to `maxPages` in all.
async function fetchOpenPrs({ github, core, owner, repo, maxPages = 5 }) {
  const prs = [];
  for (let after = null; ; ) {
    const data = await github.graphql(OPEN_PRS, { owner, name: repo, after });
    const page = data.repository.pullRequests;
    for (const node of page.nodes) {
      let items = node.timelineItems.nodes;
      let info = node.timelineItems.pageInfo;
      for (let pages = 1; info.hasPreviousPage && pages < maxPages; pages++) {
        const earlier = await github.graphql(EARLIER_TIMELINE, { owner, name: repo, number: node.number, before: info.startCursor });
        items = [...earlier.repository.pullRequest.timelineItems.nodes, ...items];
        info = earlier.repository.pullRequest.timelineItems.pageInfo;
      }
      const pr = toOpenPr(repo, node, items);
      if (mayOweReReview(pr)) await addReviewCommits({ github, core, owner, pr });
      prs.push(pr);
    }
    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }
  return prs;
}

module.exports = { fetchOpenPrs, toEvent, toOpenPr };
