# Repository and PR freshness

The owner overview distinguishes two kinds of GitHub evidence:

- **Repository fully checked:** the complete open PR set and its current
  facts were reconciled, including an authoritative empty result.
- **This PR checked:** an individual PR was successfully read. This does
  not establish that the repository's complete PR list was checked.

Neither `RepositoryRecord.listedAt` nor a webhook payload establishes a
complete check. Discovery metadata, PR activity dates and the inactivity
`stale` flag have separate meanings. The aggregate **Last full check**
continues to describe the last successful complete sweep. Partial success
never advances that aggregate or suppresses its required warnings.

## Durable status lifecycle

`CheckStatus` keeps `lastSuccessfulCheckAt` independently of its
`latestAttempt`. An absent legacy status means unknown; no timestamp is
inferred from listing metadata or from a global sweep.

Each logical check receives a durable, monotonically increasing token and
an observation start time. Queued scheduling evidence is replaced or
advanced to running when the logical read starts. Success, failure and
interruption are terminal outcomes for that token. Failures retain the
previous successful time. A retry begins a new
attempt; a request-budget continuation retains its original token and
observation time. Completing or replaying cached responses cannot make
old evidence appear newly observed.

Success times are conservative logical observation starts, rather than
completion times. Token and time guards reject delayed completions and
prevent older work from overwriting newer evidence. A successful read can
supply evidence while separately queued webhook work still awaits facts.
Cancellation or supersession interrupts only the canceled work's tokens.

Evidence lives in namespaced `settings` rows, independently of discovery
records and PR facts. Constructors do not write. Scheduler tokens and
continuations are saved before network work and survive object eviction.
Removing a repository, disabling monitoring, or changing its owner or
installation clears evidence associated with the old monitored identity.
Only current monitored repositories and cached PR identities are projected
into the private owner snapshot.

## Integration points

- `OverviewCheckStore`, exposed through `OverviewStore`, owns token
  allocation, guarded transitions, successful observations and projection.
- `OverviewSync` associates tokens with sweeps, repository marks and PR
  rereads. Its existing observation-generation guards remain responsible
  for rejecting superseded facts and membership. Freshness tokens guard
  evidence; they do not replace those guards.
- `OverviewSnapshot.freshness` is an additive optional protocol field with
  separate repository-ID and PR-node-ID maps. Legacy snapshots remain
  readable, and stored evidence survives process restarts. The instance
  publishes it with its existing authoritative snapshots.
- `CheckFreshness` renders the same details on hover and keyboard focus,
  with Escape dismissal. Checking, overdue and failed states have text.
  The repository disclosure also exposes checks for empty repositories.
  Global connection status and prominent failure/overdue warnings remain.

## Refresh one repository

The owner can choose **Refresh** beside a repository name in the overview
or in **Repository checks**, including empty and muted repositories. This
queues a complete open-PR reconciliation through `queueRepositoryRead`;
it does not refresh installation discovery or merely reread cached PR IDs.
Missed opens and closes are reconciled with current PR facts, reviewer
permissions and mergeability. The selected numeric repository owner is
checked, and organization repositories require a fresh check of the
instance owner's access before applying even an empty result.

Explicit requests use the same `CheckStatus` lifecycle in the
`repository-refresh` namespace. The optional `repositoryRefreshes` map in
freshness evidence exposes these tokens independently of background
checks. Queued and running requests coalesce without restarting their
budgets. One token follows the requested work through continuations,
observation invalidation and the scheduler's bounded retries; only that
work completes or fails it. Running means the logical request is still
pending, including retry waits. Successful times conservatively use the
request time. Failed requests preserve cached rows and previous successful
evidence. Removal, monitoring changes and identity changes clear the old
identity's evidence.

Manual reads share the scheduler's request budgets, permission and head
caches, continuations and observation guards. They honor known primary
rate resets and HTTP retry deadlines, including secondary throttles that
expire before a healthy primary rate window. Repeated requests cannot
bypass those waits. Normal visible sweeps and hidden webhook processing
continue independently. Muting stays independent of monitoring; collapsed
muted repositories receive the same reads and scoped evidence.

## Validation and evidence limits

The automated storage, scheduler, protocol and frontend tests cover
independent evidence, mixed success, unchanged and empty reads, partial
results, retries, cached continuations, delayed observations, restart
persistence and accessible details. The local assembled scenario in
`scripts/acceptance-overview.mjs` exercises production assets, Worker and
Durable Object code with real Chromium sockets and synthetic GitHub data.
It checks keyboard focus, hover and Escape, separate PR/repository times,
empty repository evidence, inactivity flags and eviction persistence.
Targeted refresh tests cover request attribution, access denial, bounded
authorization continuations, retry deadlines, coalescing, missed events
and observation races. The assembled scenario also clicks refresh
controls and checks queued/running/completion/failure feedback, targeted
reads, cached-row retention and empty muted repository refreshes.

These are local and synthetic checks. They do not establish hosted GitHub
permissions, production data behavior or live delivery timing. No
production deployment is part of these checks.
