# GitHub PR reader

The [reader](../src/worker/github-pr-reader.ts) supplies the same complete
PR record to sweeps and event-triggered re-reads. It performs no scheduling,
storage writes, webhook handling or publication. Installation credentials
stay in the [token helper's](../src/worker/github-installation-token.ts)
memory; callers must never store the token helper or its token result.

## Calling contract

Create one `GithubPrReader` per installation and invocation. Its methods
share a maximum of 40 HTTP calls, including REST follow-ups. Token minting
and repository listing are outside that count and need their own allowance.

- `countOpenPrs` reads up to 100 repository node IDs per query. A confirmed
  zero is distinct from an inaccessible node or failed query.
- `readRepositories` reads at most 10 repositories per query, with 20 PRs,
  30 reviews and 50 check contexts initially. It follows every required
  page, retaining review order and rejecting duplicate or changing pages.
- `rereadPrs` reads at most 10 PR node IDs per query through the same mapping.
  Closed and merged PRs are explicit tombstones. An unavailable node never
  implies closure.

`status` and `issues` distinguish complete, partial and failed operations.
Only a repository with `complete: true` supports deleting rows absent from
its listing. Unknown API enum values or malformed connections fail that
read rather than silently weakening the facts used for bucketing.

Each open record includes stringified numeric review/check-run IDs matching
webhooks. Commit statuses match by context name, state and the PR's head
SHA; their GraphQL IDs are opaque. Reviewer permissions are keyed by account
ID, conditionally refreshed with ETags, and preserved on a failed lookup.
The permission response's user ID must match the reviewer: a reassigned
login cannot confer trust on the previous account.

## Continuations and caches

A request-limit result includes a JSON-safe `continuation`. In the next
invocation, construct a new reader with that continuation and repeat the
same method and inputs for the same installation. Successful API responses,
completed permission refreshes and immutable head dates are replayed without
new HTTP calls, so deep nested pages and large repository listings make
forward progress. Repeat until complete; discard the continuation when the
logical read finishes or encounters a failure other than its request limit.

Continuations contain private API facts, never tokens or authorization
headers. Keep them within the owner-only object. They describe one logical
read and must not be reused for a later sweep. Across fresh reads, carry
`permissionCache` and `headCommitDates` instead; the latter is keyed by
repository ID and immutable head SHA. A sweep sets `refreshPermissions:
true`; a re-read can reuse known permissions and look up new reviewers.

The head date comes from the REST PR commits endpoint with the PR's commit
count, requesting one entry on the last page and checking its SHA. This
works with Pull requests read on private repositories. Above that endpoint's
250-commit limit, the reader searches committed timeline events for the
exact head SHA, following the last page and then previous pages. This path
shares the same request budget and continuation. A missing head remains a
failed read; no activity date is invented.

## Installation-token validation

Measured locally at **2026-10-18 06:15 UTC**, using the configured personal
GitHub App's installation token and the production query exports. No App
permissions or repository data were changed. These figures describe that
sample, not a guaranteed cost for every account.

| Operation | Result | GraphQL points | Wall time |
| --- | --- | --- | --- |
| Count 50 repository node IDs | Complete | 1 | 2.484 s |
| Read 10 nonempty repositories, 49 PRs | Complete | 70 | GraphQL: 3.739 s |
| Re-read 10 PR node IDs using cached head dates | Complete | 4 | 1.444 s |

The full read used two bounded invocations: 40 HTTP requests followed by 11.
Those counts include the count query, full query and 49 head-date requests.
No initial query was repeated on continuation. The direct private-PR rollup
read and REST head-date read succeeded. The private PR timeline endpoint
returned 200 and included the matching head SHA and committer date.

The query-cost estimate is 70 points for 10 repositories at the requested
page sizes and matched the API's `rateLimit.cost`. Latest inline comment
times require the last comment on every review, including older reviews:
using only the latest review or thread would miss newer replies. Those
nested comment connections raise the cost above the earlier partial-query
estimate. At 30 sweeps an hour this query shape alone costs about 2,100
points; actual cost also includes counts, additional pages and event reads.
The scheduler uses the returned actual installation limit, remaining budget
and reset time; see [overview synchronization](OVERVIEW_SYNC.md).

The original nested `commits.nodes.commit` query returned integration-access
errors on private PRs. The production query instead uses the PR's direct
`statusCheckRollup`, the commit count and REST commit dates. This requires
no Contents permission. See GitHub's [PR fields][fields],
[PR commits endpoint][commits], [timeline permissions][timeline] and
[committed event fields][events].

Live private-review access needs a repository with submitted reviews. The
available sample contained no such reviews, so `review.commit.oid` is
covered by stubs, not demonstrated on a private reviewed PR. Long timelines,
permission failures, deep review/check pagination and partial results are
covered by Workers-runtime tests; the live timeline probe used an ordinary
PR, not a PR with more than 250 commits.

`bash scripts/setup.sh` and `bash scripts/check.sh` passed. The final full
code check ran 381 tests, including a 90-request read resumed across three
invocations, permission refresh continuation and long-timeline pagination.
All tests stub GitHub; none reaches the network.

[fields]: https://docs.github.com/en/graphql/reference/pulls
[commits]: https://docs.github.com/en/rest/pulls/pulls#list-commits-on-a-pull-request
[timeline]: https://docs.github.com/en/rest/issues/timeline#list-timeline-events-for-an-issue
[events]: https://docs.github.com/en/rest/using-the-rest-api/issue-event-types#committed
