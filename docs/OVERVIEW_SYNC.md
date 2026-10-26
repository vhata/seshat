# Overview synchronization

The [scheduler](../src/object/overview-sync.ts) implements the accepted
[change-detection design](specs/2026-10-14-change-detection.md#recommended-design).
The owner snapshot and socket remain behind the session gate. Nothing here
exposes an unauthenticated overview or starts a hosted deployment.

## Deliveries and authoritative reads

The Worker verifies the delivery signature, reduces its selected fields to
marks, and waits for durable storage before returning 202. It makes no
GitHub request. Unknown or unaccepted installations contribute no repository
or PR data; installation events still schedule the guard that can discover
an owner's new installation.

Marks coalesce by PR node ID. Their observed head, state, draft, review and
CI facts survive restart, and API propagation retries run 5, 15 and 30
seconds after the first read. Unmatched CI SHAs remain available for one
minute to match a newly read head, including fork checks without PR links.
The [same reader](GITHUB_READER.md) supplies both event reads and sweeps;
webhook payloads never become PR records.

Repository and installation events schedule discovery even when no page is
visible. Every accepted repository payload updates visibility and its
`visibilityReportedAt` time; unknown visibility is private. Only an API read
advances `listedAt`, the visibility confirmation used by a future public
view. A public delivery alone cannot extend that confirmation. Transfers clear the
monitoring override and withdraw stored PRs until discovery applies the
monitoring rules again. Durable choices are scoped to the repository owner's
numeric ID; discovery also discards them when ownership changes without a
delivery. Same-owner renames, listing omissions and installation removal
preserve those choices. Legacy choices acquire an owner from an existing
repository record before it is removed; without that evidence they reset to
the defaults. Deletion removes the repository and its PRs.

## Visibility and one alarm

The object timestamps visibility reports in hibernating socket attachments.
A visible report expires after 15 minutes. Reports, the overdue message,
retry requests, sockets and ordinary RPCs repair a missing alarm when work
exists; keep-alive pings use the runtime's automatic response.

While a current visible report exists, a sweep runs every two minutes. A
page returning after more than two minutes starts catch-up immediately,
subject to the one-minute catch-up throttle. Hiding the last page stops
sweeps immediately, with no grace tail. Event reads continue while dormant.
An HTTP request already in flight can finish; cancelled sweep readers stop
before the next HTTP request, discard their cached continuation and restart
with fresh facts when a page returns.

One alarm chooses the earliest due operation among installation guards,
discovery, event reads and sweep phases. Continuations move their due time
forward, so a continuing event stream cannot indefinitely starve an older
sweep. Progress is stored in the object's private settings table. No
credential or authorization header is part of that progress.

Each alarm performs one bounded phase: at most 25 charged discovery calls,
one token allowance plus 40 PR-reader requests, or at most 10 installation
list requests plus 40 attempted deletions. Permissions and REST follow-ups
share the reader's allowance. Deep pages resume on another invocation.
The scheduler does not combine those independent allowances in one alarm.

## Freshness and mergeability

Only a completed sweep advances the successful-sync time, and it records
when the sweep started. An error or incomplete PR listing preserves known
rows. The sweep retries once after 15 seconds before recording failure and
the unreadable repositories. A prior failure remains in stored status while
a recovery sweep runs, until a complete sweep succeeds.

The reader requests GraphQL's actual installation `rateLimit.limit` with
`remaining` and `resetAt`. Below ten percent of that limit, visible sweeps
slow to four minutes. The ordinary two-minute interval resumes after the
reported reset. The page still judges overdue status from its own clock.

No available read-only sample demonstrates GitHub recomputing conflicts
promptly after a base push that introduces a conflict. To avoid depending on
that behavior, every sweep PR read also uses GitHub's documented REST
mergeability computation trigger. An unknown result schedules the ordinary
5/15/30-second follow-ups. These REST calls share the bounded continuation;
no Contents permission, test branch mutation or live conflicting push is
required. This is a conservative fallback, not live proof of recomputation.

## Validation boundary

[Scheduler tests](../src/object/overview-sync.test.ts) run with real Durable
Object storage and stubbed GitHub, covering restart and bounded pagination,
missed events, partial reads, retry/failure behavior, out-of-order facts,
activity-based stale rows, fairness and cancellation. The
[Worker/socket tests](../src/worker/overview-sync-runtime.test.ts) connect a
real owner socket through the Worker, deliver signed webhooks, execute the
object's alarm and check live snapshots, catch-up, dormancy, expired
visibility and alarm repair. All GitHub responses are stubbed; no automated
test reaches the network.

These exercise the automatic halves of acceptance checks 3, 5, 6 and 8.
Real-browser assembly and real-App observations are recorded separately by
`build-pr-overview`. GitHub cannot deliver a webhook to the local App without
a reachable ingress, which still requires explicit deployment or tunnel
authorization. No such ingress was created for these checks.
