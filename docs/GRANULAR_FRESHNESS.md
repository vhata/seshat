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

The later `refresh-single-repository` task should queue a complete
repository reconciliation through `queueRepositoryRead`, rather than
rereading cached PR IDs. It should reuse these tokens, scheduler budgets,
continuations and observation guards, and tie action feedback to its own
work. This change adds no manual refresh action. Mute preferences should
remain independent of monitoring and should not change these checks.

## Validation and evidence limits

The automated storage, scheduler, protocol and frontend tests cover
independent evidence, mixed success, unchanged and empty reads, partial
results, retries, cached continuations, delayed observations, restart
persistence and accessible details. The local assembled scenario in
`scripts/acceptance-overview.mjs` exercises production assets, Worker and
Durable Object code with real Chromium sockets and synthetic GitHub data.
It checks keyboard focus, hover and Escape, separate PR/repository times,
empty repository evidence, inactivity flags and eviction persistence.

These are local and synthetic checks. They do not establish hosted GitHub
permissions, production data behavior or live delivery timing. No
production deployment or manual refresh is part of this change.
