/** Page sizes are part of the query's rate-limit cost, even for empty nodes. */
export const PR_PAGE_SIZE = 20;
export const REVIEW_PAGE_SIZE = 30;
export const CHECK_PAGE_SIZE = 50;

export const RATE_FIELDS = "rateLimit { cost remaining resetAt }";
export const REPOSITORY_FIELDS = `id databaseId nameWithOwner visibility
  owner { login ... on User { databaseId } ... on Organization { databaseId } }`;
const ACCOUNT_FIELDS = `__typename login ... on User { databaseId }
  ... on Bot { databaseId } ... on Mannequin { databaseId }`;
export const REVIEW_FIELDS = `id databaseId state submittedAt commit { oid }
  author { ${ACCOUNT_FIELDS} } comments(last: 1) { nodes { createdAt } }`;
export const CHECK_FIELDS = `__typename
  ... on CheckRun { id databaseId name status conclusion }
  ... on StatusContext { id context state }`;
export const PAGE_FIELDS = "totalCount pageInfo { hasNextPage endCursor }";

export const PR_FIELDS = `id databaseId number state title url updatedAt createdAt
  isDraft headRefOid mergeable author { ${ACCOUNT_FIELDS} }
  repository { ${REPOSITORY_FIELDS} }
  comments(last: 1) { nodes { createdAt } }
  forcePush: timelineItems(last: 1, itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT]) {
    nodes { ... on HeadRefForcePushedEvent { createdAt } }
  }
  stateChange: timelineItems(last: 1, itemTypes:
    [REOPENED_EVENT, CONVERT_TO_DRAFT_EVENT, READY_FOR_REVIEW_EVENT]) {
    nodes { ... on ReopenedEvent { createdAt }
      ... on ConvertToDraftEvent { createdAt }
      ... on ReadyForReviewEvent { createdAt } }
  }
  reviews(first: ${REVIEW_PAGE_SIZE}) { ${PAGE_FIELDS} nodes { ${REVIEW_FIELDS} } }
  commits { totalCount }
  statusCheckRollup { contexts(first: ${CHECK_PAGE_SIZE}) {
      ${PAGE_FIELDS} nodes { ${CHECK_FIELDS} }
  } }`;

export const COUNT_QUERY = `query SeshatPrCounts($ids: [ID!]!) {
  nodes(ids: $ids) { ... on Repository { ${REPOSITORY_FIELDS}
    pullRequests(states: OPEN) { totalCount }
  } } ${RATE_FIELDS}
}`;

export const REPOSITORIES_QUERY = `query SeshatRepositoryPrs($ids: [ID!]!) {
  nodes(ids: $ids) { ... on Repository { ${REPOSITORY_FIELDS}
    pullRequests(states: OPEN, first: ${PR_PAGE_SIZE}, orderBy: {field: CREATED_AT, direction: ASC}) {
      ${PAGE_FIELDS} nodes { ${PR_FIELDS} }
    }
  } } ${RATE_FIELDS}
}`;

export const REREAD_QUERY = `query SeshatPrs($ids: [ID!]!) {
  nodes(ids: $ids) { ... on PullRequest { ${PR_FIELDS} } } ${RATE_FIELDS}
}`;

export const PR_PAGE_QUERY = `query SeshatPrPage($id: ID!, $after: String!) {
  node(id: $id) { ... on Repository { ${REPOSITORY_FIELDS}
    pullRequests(states: OPEN, first: ${PR_PAGE_SIZE}, after: $after,
      orderBy: {field: CREATED_AT, direction: ASC}) {
      ${PAGE_FIELDS} nodes { ${PR_FIELDS} }
    }
  } } ${RATE_FIELDS}
}`;

export const REVIEW_PAGE_QUERY = `query SeshatReviewPage($id: ID!, $after: String!) {
  node(id: $id) { ... on PullRequest { id headRefOid
    reviews(first: ${REVIEW_PAGE_SIZE}, after: $after) {
      ${PAGE_FIELDS} nodes { ${REVIEW_FIELDS} }
    }
  } } ${RATE_FIELDS}
}`;

export const CHECK_PAGE_QUERY = `query SeshatCheckPage($id: ID!, $after: String!) {
  node(id: $id) { ... on PullRequest { id headRefOid
    statusCheckRollup {
      contexts(first: ${CHECK_PAGE_SIZE}, after: $after) {
        ${PAGE_FIELDS} nodes { ${CHECK_FIELDS} }
      }
    }
  } } ${RATE_FIELDS}
}`;

/**
 * GitHub's documented estimate: connections requested / 100, rounded, min 1.
 * Includes latest issue/review comments and two separate activity timelines.
 * The API's rateLimit.cost is authoritative; this is a planning estimate.
 */
export function estimatePrQueryCost(repositories: number, prsPerRepository = PR_PAGE_SIZE): number {
  const perPr = 1 + 2 + 1 + REVIEW_PAGE_SIZE + 1;
  return Math.max(1, Math.round((repositories + repositories * prsPerRepository * perPr) / 100));
}
