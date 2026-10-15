# Change detection and reconciliation

Status: **proposed on 2026-10-14 and revised on 2026-10-15** after the owner
directed that Seshat check GitHub on its own only while someone is looking (see
[When the object sweeps](#when-the-object-sweeps)); the rest is for the owner
to accept, under [Questions for the owner](#questions-for-the-owner). The
owner also asked for [DELIVERABLE.md](../DELIVERABLE.md#freshness) to say
plainly what that means for freshness, which it now does. This answers the
queue entry `choose-change-detection` and is judged against
[DELIVERABLE.md](../DELIVERABLE.md#freshness), within the GitHub App chosen in
[DECISIONS.md](../DECISIONS.md#2026-10-12--github-integration) and the stack
chosen in [DECISIONS.md](../DECISIONS.md#2026-10-13--cloudflare-stack). Facts
about GitHub and Cloudflare were checked against their documentation on
2026-10-14; each claim links to its source. GitHub API costs were measured the
next morning UTC against the owner's own repositories; see
[Measurements](#measurements). Points not yet settled are under [Not
verified](#not-verified).

## Recommendation

- **A webhook says what to re-read; GitHub's API says what is true.** Each
  delivery is reduced to the PRs, commits or repositories it concerns, and
  those are marked for re-reading. Shortly afterwards the Durable Object reads
  the marked PRs from GitHub's GraphQL API in one query, stores what the read
  returned and pushes any change to open pages. No payload is written into the
  model.
- **A sweep every 2 minutes while an overview is visible reconciles
  everything.** For each accepted installation it lists the repositories,
  counts open PRs per repository in one GraphQL query, and reads every open
  PR in the repositories that have any. A change whose webhook was lost, and
  a change that has no webhook at all (top-level comments, reviewer
  permission changes, conflicts caused by a push to a base branch), is picked
  up by the next sweep. For the owner's 48 monitored repositories this
  measured about 8 GraphQL points and 3 subrequests per sweep (4 when the
  installation token is renewed).
- **No overview visible, no sweeps.** Pages report their visibility to the
  object. When none is visible the object stops sweeping, while webhooks and
  the re-reads they trigger carry on, so the stored model stays close to
  current. A page that becomes visible gets a catch-up sweep at once if the
  last one is more than 2 minutes old, and shows that it is checking until
  that sweep finishes, a few seconds for the owner's account.
- **Mergeability that GitHub is still computing is re-read** through the REST
  endpoint that starts the computation, at increasing intervals, until it
  resolves or the next sweep takes over.
- **Bounds for [DELIVERABLE.md](../DELIVERABLE.md#freshness).** Catch-up bound:
  while an overview is visible, a change GitHub fails to report, or reports
  late, reaches it within 5 minutes: one sweep interval, plus one late or
  failed sweep, plus a minute for the sweep's own reads and follow-ups. When
  an overview becomes visible after none was, it converges within 2 minutes,
  and within seconds when the last sweep is more than 2 minutes old, which is
  the usual case after a quiet spell.
  Overdue threshold: the overview flags the sync as overdue when the last
  successful sweep started more than 5 minutes ago and the page has been
  visible for at least a minute, and flags a failed sync as soon as a sweep
  and its retry have both failed.
- **One Durable Object alarm schedules all of this.** Re-reads, mergeability
  checks and sweeps share it, and every request into the object makes sure it
  is set. No Cron Trigger is needed, since nothing has to run on a timer while
  no page is visible.
- **The page judges staleness on its own clock.** It receives the time of the
  last successful sweep and works out whether that is overdue itself, so an
  object that has stopped cannot make stale data look current.
- **No new GitHub permissions.** Reconciliation meets the catch-up bound
  without Contents or Issues, which the GitHub decision left to revisit if it
  could not ([question 2 there](2026-10-12-github-integration.md#questions-for-the-owner)).

## What the decision must meet

From [DELIVERABLE.md](../DELIVERABLE.md#freshness):

- A PR opened, closed, merged, converted to or from draft, or pushed to; a
  review submitted; and a CI result on the head commit reach an open overview
  within 60 seconds of GitHub reporting them, without a reload.
- The time of the last successful sync is always visible; an overdue or failed
  sync is said prominently; stale data never looks current.
- Changes GitHub fails to report, or reports late, still appear without owner
  action, within a catch-up bound (acceptance check 6).

Before this decision DELIVERABLE.md left the overdue threshold and the
catch-up bound to it, and did not say whether Seshat had to keep checking
GitHub while nobody looked. The owner decided on 2026-10-15 that it does not
([DECISIONS.md](../DECISIONS.md#2026-10-15--check-github-only-while-someone-is-looking)),
and DELIVERABLE.md now says so, with the bounds set here (see [Changes to
DELIVERABLE.md](#changes-to-deliverablemd)).

Constraints from the earlier decisions and from GitHub:

- GitHub does not redeliver a failed delivery on its own, and a delivery fails
  if the receiver takes more than 10 seconds to answer ([failed
  deliveries][wh-failed]; [best practices][wh-best]).
- "GitHub may deliver webhooks in a different order than the order in which
  the events took place" ([troubleshooting webhooks][wh-order]).
- `check_run` and `check_suite` payloads for a PR whose head is in a fork have
  an empty `pull_requests` array and no `head_branch`, so they must be matched
  to PRs by head SHA ([webhook events][wh-check-run]).
- No event reports that GitHub has finished computing mergeability, and the
  app has no `push` or `issue_comment` events, because it holds neither
  Contents nor Issues ([Minimum
  permissions](2026-10-12-github-integration.md#minimum-permissions)). Nor
  does any event report a change in a reviewer's repository permission.
- The installation's GraphQL budget is 5,000 points an hour, plus 50 for each
  repository above 20, up to 12,500 ([GraphQL rate limits][gql-limits]). The
  owner's installation covers all 72 repositories the account owns, forks
  included, which makes 7,600. Each GraphQL request must finish within 10
  seconds or is cut off, and a timeout costs extra points for the next hour
  ([timeouts][gql-timeouts]).
- On the Free plan each invocation may make 50 external subrequests, the
  Worker's own paths stay within 10 ms of CPU, and the object stays well under
  30 seconds per invocation; daily quotas are shared with the owner's other
  Workers ([stack constraints](2026-10-13-cloudflare-stack.md#free-plan-budget)).

## Options considered

### What a webhook does

- **A. Apply the payload to the model.** Fastest, and costs no GitHub reads.
  But each payload carries part of the picture: a `check_run` payload carries
  one check, a `pull_request_review` payload one review, and no payload carries
  a reviewer's permission or a computed mergeability. Deliveries may arrive out
  of order, so every update would need comparing against timestamps that are
  truncated to the second. The model would be assembled from fragments by
  logic that exists only for that purpose, and any error in it would persist
  until a sweep overwrote it.
- **B. Mark what changed and re-read it** (recommended). A delivery only says
  which PRs might have changed. The re-read returns the PR whole, through the
  same code the sweep uses, so ordering does not matter, a duplicate delivery
  costs one redundant read, and there is one way the model is built. Up to 10
  PRs re-read in one query cost 1 point and took 0.5 to 1.5 seconds (see
  [Measurements](#measurements)); with a 2-second wait to collect a burst of
  deliveries, a change still shows in a few seconds against a 60-second
  requirement.

### How missed changes are caught

- **C. No reconciliation.** Rejected: GitHub does not redeliver, and some
  changes have no event at all.
- **D. Read GitHub's delivery log and redeliver failures.** The app can list
  its recent deliveries with their status code, event and repository, filtered
  to failures, and ask for a redelivery, both with a JWT ([app webhooks
  API][rest-app-hooks]). This repairs deliveries GitHub attempted and that
  failed, but not changes GitHub never reports (comments, permissions,
  base-branch conflicts, mergeability), and GitHub's page gives its retention
  as 7 days in its introduction and 3 days everywhere else
  ([redelivering][wh-redeliver]). A sweep is needed regardless, and once it
  exists the log adds only speed for a case the sweep already covers. Not
  recommended for the first deliverable; it could be added if sweeps ever had
  to become infrequent.
- **E. Poll only, with no webhooks.** A sweep every 30 seconds would meet the
  60-second requirement, at four times the GraphQL points of a 2-minute sweep
  whether or not anything changes, with every change taking up to 30 seconds
  where webhooks take a few. It would not remove any setup step, since the
  GitHub App has its webhook anyway. Rejected.
- **F. Webhooks plus a periodic sweep** (recommended). Webhooks carry nearly
  every change in seconds; the sweep is the authority that catches the rest.

### When to sweep

- **Always, every 2 minutes.** About 720 sweeps a day whether or not anyone
  looks. For the owner that is about 3% of the installation's GraphQL budget
  and under 1% of Cloudflare's daily requests: small, but wasted whenever
  nobody is looking, and it grows with the repositories that have open PRs.
  This was the first version of this proposal. Rejected by the owner.
- **While the owner is signed in.** A session lasts days and says nothing
  about whether anyone is watching. Rejected.
- **While a page has its socket open.** A dashboard is the kind of page left
  pinned in a background tab all day, which would sweep all day. Rejected.
- **While a page is visible** (recommended, and directed by the owner). The
  page reports its visibility; see [When the object
  sweeps](#when-the-object-sweeps).
- **The same, plus 10 minutes after the last page goes.** The owner's first
  suggestion. Nothing reads the stored model during those 10 minutes, and the
  page that opens next needs a catch-up sweep anyway unless the last one was
  under 2 minutes ago, so the tail spends up to 5 sweeps to save one sweep and
  a few seconds of the checking state. Dropped with the owner's agreement.
- **A periodic ping from the page that wakes the object.** At one every 30
  seconds that is 2,880 object requests a day per open tab, which the stack
  chose an auto-response for keep-alives to avoid
  ([stack spec](2026-10-13-cloudflare-stack.md#not-verified)). Visibility
  reports, sent when visibility changes and every 10 minutes while visible,
  carry the same information. Rejected.

### How the sweep reads GitHub

Measured on the owner's repositories (see [Measurements](#measurements)):

| Sweep shape | GraphQL points | Subrequests | Notes |
| --- | --- | --- | --- |
| Full read of every monitored repository, 50 PRs, reviews and checks each | 96 | 1 or 2 | Points are charged for the page sizes requested, not the PRs found; one query took 6.6 to 7.5 s, near the 10 s timeout |
| Full read of every repository with smaller pages (10 PRs, 20 reviews, 30 checks) | 20 | 1 | Still charges for 39 repositories that have no open PR |
| **Count open PRs per repository, then read only repositories that have some** (20 PRs, 30 reviews, 50 checks) | **1 + 7** | **2** | Recommended; pages beyond those sizes are fetched only where a count says they exist |
| Search for open PRs across the account | 4 | 1 | GitHub does not document how soon search reflects a change, and a reconciliation pass must be authoritative |
| REST with conditional requests | none (REST has its own limit, and 304 responses cost none of it) | about 220 | A request for the repository list, one per repository for its PRs, and four per PR (the PR for mergeability, reviews, check runs, statuses); 304 responses cost no rate limit ([conditional requests][rest-conditional]) but each is a subrequest, so one sweep would span five invocations |

The count-then-read sweep scales with the repositories that have open PRs,
not with every repository the account owns.

## Recommended design

### Events handled

The app's manifest subscribes to the events in this table except
`installation` and `installation_repositories`, which, like
`github_app_authorization` and `installation_target`, are delivered without a
subscription ([webhook events][wh-events]).

| Event | What it marks |
| --- | --- |
| `pull_request` (any action) | That PR |
| `pull_request_review` | That PR |
| `pull_request_review_comment` | That PR (last activity and the stale flag) |
| `check_run`, `check_suite` | Each PR in `pull_requests`; when the array is empty, each known open PR whose head SHA is the payload's `head_sha` |
| `status` | Each known open PR whose head SHA is the payload's `sha` |
| `repository`, `installation_repositories` | The repository list, re-read at once, and then the repository's open PRs |
| `installation` | The installation guard and the repository list ([GitHub spec](2026-10-12-github-integration.md#registration-and-installation)) |

`check_suite` repeats what the `check_run` events already reported, and costs
one more delivery per suite; it is kept because a burst of marks for the same
PR collapses into one read, so a second signal costs almost nothing and covers
a lost `check_run`.

A CI event can arrive before the re-read that stores a PR's new head, for
example a `status` event, or a fork PR's `check_run`, racing the
`synchronize` that preceded it. A CI SHA that matches no known PR is
therefore held for a minute against its repository; any re-read that stores
that SHA as a PR's head in the meantime marks the PR again. A SHA still
unmatched after a minute is dropped, and the next sweep finds the PR if it
exists.

### Receiving a delivery

1. The Worker checks `X-Hub-Signature-256`, drops deliveries from
   installations that are not accepted, and reduces the payload to its marks
   (PR node IDs or repository and number, a head SHA, a repository ID) plus the
   facts a re-read should be able to see (see [Re-reads](#re-reads)).
2. It calls the object over RPC. The object writes one row per marked PR, so
   a burst of deliveries for one PR leaves one row; the facts each delivery
   reported are added to that row rather than replacing earlier ones. It sets
   its alarm for 2 seconds ahead unless it is already due sooner.
3. The Worker answers 202 once the object has stored the marks. A delivery the
   object did not store is answered with an error, so it shows as failed in the
   app's delivery log, where the owner can redeliver it by hand, and the next
   sweep covers it regardless.

No delivery log or de-duplication store is needed: a repeated delivery only
marks a PR that is about to be re-read anyway. The object keeps a short
in-memory record of recent deliveries for diagnostics, not in storage.

### Re-reads

When the alarm fires, the object reads every marked PR in one GraphQL query of
up to 10 PRs per query (repeated for more), with the same fields the sweep
reads: state, draft, title, author, head SHA, mergeability, reviews with
their commit and author, every check run and commit status on the head
commit, and the latest comment time. It compares the result with the stored
PR, writes and pushes only what changed, and clears the marks.

A read can come back before GitHub's API shows what the webhook reported. On
this repository's own PR, the API showed each check run's new state 1.2 to
2.2 seconds after the time GitHub gives for it, about when the stack spike saw
deliveries arrive (see [Measurements](#measurements)), so a read 2 seconds
after delivery should usually see it. To cover the rest, each mark keeps the
facts its deliveries reported:

| Delivery | Fact the read must show |
| --- | --- |
| `pull_request` `opened`, `reopened`, `closed` | The PR's state (open, closed or merged) |
| `pull_request` `converted_to_draft`, `ready_for_review` | The draft flag |
| `pull_request` `synchronize` | The head SHA |
| `pull_request` other actions | Nothing beyond the PR itself |
| `pull_request_review` `submitted`, `dismissed` | The review's ID and state |
| `check_run` | The check run's ID with that status, or a later one |
| `status` | That context with that state on that SHA |

A fact counts as shown when the read shows it or a later state: a check run
that is already completed satisfies an `in_progress` delivery that arrived
out of order, and a head SHA superseded by a newer push satisfies the older
`synchronize`, since the PR's head has moved on. Facts that are shown are
cleared. If any remain, the PR is read again 5, 15 and 30 seconds after the
first read; facts still missing after that are left to the sweep. With
GitHub's delivery delay of a few seconds, the last retry happens about 35
seconds after the change, inside the 60 seconds. A reported change that the
API shows only after that counts as missed, and appears within the catch-up
bound.

Reviewer permission comes from the REST collaborator permission endpoint, as
the GitHub spec chose. A re-read that finds an approval or a request for
changes from a reviewer whose permission on that repository is not yet known
looks it up before the PR is bucketed, so a review from a new reviewer is
bucketed correctly within the 60 seconds. Each sweep then refreshes every
pair of repository and reviewer that has such a review on an open PR, with
conditional requests so an unchanged answer costs no rate limit. The GraphQL
field `authorCanPushToRepository` might replace it, once its meaning is
confirmed ([GitHub spec](2026-10-12-github-integration.md#not-verified)). The
owner's open PRs had no such reviews when measured.

### Mergeability

GraphQL reports `mergeable` as `MERGEABLE`, `CONFLICTING` or `UNKNOWN` while
GitHub computes it ([MergeableState][gql-mergeable]). GitHub documents that
getting a PR through the REST API starts the computation ([get a pull
request][rest-pull]; [checking mergeability][rest-mergeability]); it says
nothing about GraphQL doing so. When a read returns `UNKNOWN`, the object
therefore fetches that PR with `GET /repos/{owner}/{repo}/pulls/{number}`,
and again 5, 15 and 30 seconds later until `mergeable` is no longer null,
after which the sweep takes over. The row says mergeability is being checked
meanwhile, as [DELIVERABLE.md](../DELIVERABLE.md#terms) asks.

A push to a PR's base branch can introduce conflicts without any event the app
receives, and the app cannot see the base branch's head without Contents. The
PR's `baseRefOid` does not follow the base branch: of 28 open PRs whose base
had moved since they were opened, 20 still gave a different commit. The design
therefore relies on GitHub recomputing mergeability itself after a base push,
which the sweep then reads. For those 20 PRs GraphQL's `mergeable` agreed with
the REST endpoint's, and none was still being computed, which suggests GitHub
does; whether it does promptly after a push that causes a conflict is [not
verified](#not-verified). Such conflicts appear within the catch-up bound
rather than 60 seconds; they are not in the Freshness list.

### When the object sweeps

The object sweeps only while some overview is visible, as the browser reports
it: the foreground tab of a window that is not minimized, even if other
windows cover it ([MDN][mdn-visibility]). Webhooks,
re-reads and mergeability checks carry on regardless: they are driven by
GitHub's events, not a timer, and cost little. While nobody is looking they
keep the stored model close to current, so an overview opened later starts
from mostly right data, and the catch-up sweep corrects the rest.

- **Pages report their visibility.** The page uses the Page Visibility API
  ([MDN][mdn-visibility]) and sends the object one message when it connects
  and one on each `visibilitychange`. The overdue message and "Retry now"
  (below) carry a report too. A page whose own timer finds a gap of more
  than a minute between two ticks, as after the machine wakes from sleep,
  treats that as becoming visible: it reports again and restarts its
  "visible for" clock (see [Sync status](#sync-status-on-the-overview)),
  since browsers are not documented to fire `visibilitychange` on waking.
  The object keeps each socket's latest
  report with the socket, through `serializeAttachment`, which survives
  hibernation ([WebSockets][do-websockets]), and forgets it when the socket
  closes.
- **A report expires.** A machine that goes to sleep with the page visible
  sends nothing more, and its socket may stay open for a while. So a visible
  page repeats its report every 10 minutes, and a report older than 15
  minutes counts as hidden. That is at most 6 object requests an hour per
  visible page; keep-alive pings stay on the auto-response and never wake the
  object.
- **Active** means at least one socket with a current report of visible. While
  the object is active it sweeps every 2 minutes.
- **Becoming active.** When a page connects visible, or reports that it has
  become visible, the object sweeps at once if the last successful sweep
  started more than 2 minutes ago, no sweep is running and no catch-up sweep
  started in the last minute (so switching tabs back and forth during a
  GitHub outage does not start a sweep each time). Otherwise the next timed
  sweep is less than 2 minutes away. For the owner's account this catch-up
  sweep is the count query and one read, about 5 to 7 seconds of wall time as
  measured (see [Measurements](#measurements)).
- **Dormant.** When a sweep falls due and no page is active, the object skips
  it and schedules no further sweep. Its alarm then serves only work that
  deliveries started: re-reads, their retries and mergeability checks.
- **"Retry now"**, the prototype's action on the sync banner ([design
  notes](../design/README.md#notes-for-implementation)), carries a
  visibility report, so it makes the object active, and asks for a sweep at
  once, at most once a minute. The 30-second interval its copy assumes becomes
  the 2 minutes decided here.

The rule is that the object sweeps while something is reading the data.
Today the only reader is a visible overview. Later features that read the
model when no owner page is visible, such as notifications, a public view
(`define-public-view`) or an API or command-line client, would each count as a
reader by a rule of their own, and would make the object active by the same
mechanism.

### The sweep

Every 2 minutes while the object is active, from the alarm, for each accepted
installation (each has its own token, repository list and GraphQL budget,
and one query cannot mix repositories from different installations):

1. Mint an installation token if the cached one is within a few minutes of
   expiring (one subrequest an hour).
2. `GET /installation/repositories` with a conditional request, 100 per page,
   which gives the repository list with `fork` and `archived`
   ([installations API][rest-installations]). Apply the monitoring rules and
   overrides.
3. One GraphQL query counting open PRs on each monitored repository, by node
   ID, up to 100 repositories per query. Measured at 1 point for 48.
4. GraphQL queries reading every open PR on each repository with a nonzero
   count: 20 PRs, the last 30 reviews and the first 50 check contexts per PR,
   fetching further pages only where a count says there are more. At most 10
   repositories go in one query, to stay well inside GitHub's 10-second
   limit; the measured query for 9 repositories took 2.5 to 4.3 seconds.
5. Reviewer permission lookups, as under [Re-reads](#re-reads).
6. Compare with the stored model: update changed PRs, drop PRs that are no
   longer open, including every stored PR of a repository whose count came
   back as zero, push the changes, record the sweep's result and start time,
   and start mergeability checks for any `UNKNOWN`. A repository whose count
   or read failed keeps its stored PRs (see [Constraints for
   implementation](#constraints-for-implementation)).

For the owner that is 3 subrequests, or 4 when the token is renewed, well
inside one invocation's 50. A larger account whose sweep would pass about 40
subrequests continues in a second alarm invocation a moment later; the sweep
counts as complete only when every part has succeeded, and its time is when
it started. Each sweep also counts the PRs whose stored state it had to
correct. A correction that a webhook should have delivered first is evidence
that deliveries are failing, and the repositories screen can show the count.

A sweep that fails is retried once, 15 seconds later, before it is reported
as failed, so a single transient GitHub error does not raise a banner.

The sweep reads `rateLimit.remaining` and `rateLimit.resetAt` from each
response. While an installation has less than a tenth of its hourly budget
left, the sweep interval is 4 minutes, back to 2 once `resetAt` has
passed; the overview says why, and still shows the sync as overdue if the
last success is older than 5 minutes.

On a new installation the first sweep is the initial load, and the page shows
that it is in progress rather than an empty overview.

### Scheduling

A Durable Object has one alarm at a time, and setting it replaces the previous
one ([alarms API][do-alarms]). The object keeps the due times of its pending
work (marked re-reads, mergeability checks, the next sweep) and sets the alarm
for the earliest. The handler catches its own errors and always sets the next
alarm before returning.

A failed alarm is retried with exponential backoff, from 2 seconds, up to 6
times, and after that is not run again until `setAlarm` is next called
([alarms API][do-alarms]). Setting an alarm is billed as a row written
([pricing][do-pricing]), so on a day the account's write quota runs out the
object cannot set its alarm either. These re-arm it:

- every RPC, socket connection, socket message (visibility reports included)
  and API request into the object checks that an alarm is set when one is
  needed, and sets one if not;
- when the page's own timer finds the sync overdue, it sends the object one
  message, carrying a visibility report, which makes the object active and
  re-arms the alarm; keep-alive pings do not, since they are
  answered without waking the object
  ([stack spec](2026-10-13-cloudflare-stack.md#measurements)).

No Cron Trigger watchdog is needed. While no page is visible nothing needs to
run on a timer, and a broken alarm chain left behind with pending re-reads is
covered by the catch-up sweep when a page next becomes visible. While a page
is visible, its visibility reports and its overdue message re-arm the alarm.

### Sync status on the overview

The object sends the page, in the snapshot and whenever it changes:

- the time of the last successful sweep;
- the result of the latest sweep attempt, with the reason when it failed
  (GitHub unavailable, rate limited, installation suspended or removed,
  Cloudflare quota reached) and the repositories it could not read;
- its own clock, so the page can correct for the browser's.

The page shows "Checked with GitHub *n* minutes ago" at all times and, on its
own timer, the first of these states whose condition holds. "Visible for"
counts from the moment the page last became visible, or last woke from sleep,
so a tab brought back to the front starts again. An instance that has never
completed a sweep, as on a new installation, counts its last success as more
than 5 minutes ago, so its initial load shows as Checking:

| State | When | Shown |
| --- | --- | --- |
| Disconnected | The socket is closed and reconnecting | Prominently, with the time of the last message |
| Checking | Visible for less than a minute, the last successful sweep started more than 5 minutes ago, and no sweep has failed with its retry since the page became visible | Without a banner: "Checking with GitHub", with the time of the last check; rows stay as stored until the sweep's changes arrive |
| Sync failed | The latest sweep and its retry failed | Prominently, with the reason and the affected repositories, until a sweep succeeds |
| Overdue | The last successful sweep started more than 5 minutes ago | Prominently, with the time of the last success; every row is marked as possibly out of date |
| Live | Otherwise | The time of the last check, without a banner |

Checking exists so that an overview opened after a quiet spell does not open
on an overdue or failed banner left from before it became visible, which the
catch-up sweep is about to clear and which would teach the owner to ignore
the banner. It ends when a sweep succeeds, when the catch-up sweep and its
retry fail, or after a minute, whichever comes first.

Updates that arrive through re-reads do not reset the time shown: a re-read
proves that one PR is current, and the overview only shows that everything was
checked when a sweep succeeds.

When the Worker's request quota is spent, the frontend's static files are
still served, since static assets are not counted unless the Worker is set to
run first for them ([assets billing][cf-assets-billing]), so the page can load
and say that the instance cannot be reached. The Worker must not be configured
to run before assets.

### Budget

Estimates for the owner's instance as measured, plus the heavy-user activity
the stack spec assumed (550 deliveries a day; [Free-plan
budget](2026-10-13-cloudflare-stack.md#free-plan-budget)), and, as an
assumption, an overview visible for 2 hours a day across 10 openings:

| Item | Per day | Against |
| --- | --- | --- |
| GraphQL points for sweeps | about 560 (60 timed sweeps and 10 catch-up sweeps at 8) | 7,600 an hour for this installation; about 240 an hour while a page is visible, none otherwise |
| GraphQL points for re-reads | a few hundred | the same |
| Worker requests | about 600 (550 deliveries, page loads and socket opens) | 100,000 |
| Durable Object requests | about 1,000 (70 sweep alarms, a few hundred re-read alarms, 550 RPCs, a few dozen visibility reports) | 100,000 |
| Rows written | a few thousand (marks, sweep results, each `setAlarm`, changed PRs) | 100,000 |
| Subrequests | 3 or 4 per sweep, 1 or 2 per re-read | 50 per invocation |

Sweeping only while a page is visible cuts sweeps from 720 a day to about 70
on that assumption; a page left visible all day costs what the always-on
design did. Sweep cost grows with the repositories that have open PRs: as
arithmetic on the measured rate, 30 such repositories would cost about 24
points a sweep, or 720 an hour while a page is visible.

## Measurements

Measured between 06:38 and 07:10 UTC on 2026-10-15 (the evening of 2026-10-14
in the owner's time zone) against the owner's own GitHub account, with the
GitHub CLI's user token rather than an installation token; GraphQL charges the
same way for both, but the budget differs ([GraphQL rate
limits][gql-limits]). The account owned 72 repositories, 24 of them forks and
none archived, leaving 48 monitored by default; 9 of those had open PRs, 42 when
the run began and 44 by its end. The open PRs had no reviews and at
most 10 check contexts each. Costs are the `rateLimit.cost` GitHub reported
for each query; times are wall time from the owner's machine in the United
States. The scripts and their output are kept outside the repository, and no
repository or PR name is recorded here.

| Query | Points | Nodes counted | Wall time | Response |
| --- | --- | --- | --- | --- |
| All 48 repositories, 50 PRs, 50 reviews, 50 checks each, one query | 96 | 247,248 | 6.6 to 7.5 s | 55 KB |
| The same, two queries of 25 | 96 | 247,248 | 1.3 to 1.5 s and 3.6 to 4.8 s | 7 and 48 KB |
| 10 repositories per query, 100 of each | 192 over 5 queries | 974,448 | 0.6 to 2.2 s each | |
| Light probe of all 48 (PR updated time, head, draft, mergeability, counts) | 48 | 9,648 | 3.4 to 4.1 s | 18 KB |
| Open PR count per repository, all 48 | 1 | 48 | 2.3 s | 6 KB |
| The 9 repositories with PRs, 50 PRs, 50 reviews, 50 checks | 18 | 46,359 | 4.0 s | 50 KB |
| The 9 repositories, 20 PRs, 30 reviews, 50 checks | 7 | 14,949 | 4.3 s | 50 KB |
| The 9 repositories, 10 PRs, 20 reviews, 30 checks | 4 | 4,779 | 2.5 s | 47 KB |
| All 48, 10 PRs, 20 reviews, 30 checks | 20 | 25,488 | 4.1 s | 52 KB |
| Search for open PRs, 100, with 50 reviews and 50 checks | 4 | 10,300 | 4.3 s | 52 KB |
| Re-read of 1, 5 and 10 PRs by node ID | 1 each | 83 to 830 | 0.5, 1.0, 1.5 s | 1 to 10 KB |

Points follow GitHub's documented rule: the requests needed to fill every
connection at its full page size, divided by 100 ([GraphQL rate
limits][gql-limits]). That is why the first row costs 96 for 42 PRs, and why
counting first is the cheapest authoritative sweep.

**When the API shows a CI result.** While this PR's own CI ran, a script
polled the REST check runs endpoint for its head commit every half second,
with conditional requests, and recorded when each state first appeared. For
the two check runs, `queued`, `in_progress` and `completed` each appeared 1.2
to 2.2 seconds after the time GitHub gives for it (`started_at` or
`completed_at`, truncated to the second, so up to a second of each figure is
truncation and up to half a second is the polling interval). The stack spike
saw real deliveries arrive 1.0 to 2.8 seconds after the same timestamps
([stack spec](2026-10-13-cloudflare-stack.md#measurements)). Two check runs
are a small sample. A push to this PR's branch showed as the PR's
`headRefOid` in GraphQL on the second poll, within 1.3 seconds of `git push`
returning. Reviews and PR state changes were not measured.

**Base branch and mergeability.** Of 45 open PRs, 28 had a base branch whose
latest commit was newer than the PR. For 20 of those, `baseRefOid` still gave
a different commit from the base branch's head (`baseRef.target.oid`, read
with the owner's token; an installation without Contents may not be able to
read it). For each of the 20, `GET /repos/{owner}/{repo}/pulls/{number}`
returned a computed `mergeable` at once, never null, and a second request 20
seconds later agreed with GraphQL's value; neither value had changed, and
`baseRefOid` had not moved.

## Changes to DELIVERABLE.md

Made at the owner's direction on 2026-10-15, in
[Freshness](../DELIVERABLE.md#freshness) and the acceptance checks:

1. Seshat checks GitHub on its own only while an overview is visible. While
   none is, it still updates from GitHub's notifications, and changes that
   were not reported wait until an overview is next visible.
2. The catch-up bound is 5 minutes while an overview is visible, and 2
   minutes after an overview becomes visible when none was.
3. A sync is overdue when the last successful one started more than 5 minutes
   ago and the overview has been visible for at least a minute; until then an
   overview that has just become visible says it is checking. A sync has
   failed when it and one retry have failed.
4. Top-level comments, reviewer permission changes and conflicts caused by a
   push to a base branch have no notification the app receives, and arrive
   within the catch-up bound rather than 60 seconds.
5. Acceptance check 6 tests both bounds and that no scheduled reads of GitHub
   run while no overview is visible; check 7 tests the checking state.

## Effect on earlier decisions

The [stack decision](../DECISIONS.md#2026-10-13--cloudflare-stack) and its
[spec](2026-10-13-cloudflare-stack.md#recommendation) describe the object as
storing each delivery and updating the model from it, with delivery IDs as
the de-duplication key and a bounded delivery log. Under this design the
object stores marks, not deliveries, builds the model only from GitHub reads,
and keeps no delivery log or de-duplication store. On acceptance, the
decision entry records that this supersedes those three points; the stack
itself is unchanged.

## Constraints for implementation

- The webhook path in the Worker does no GitHub reads; it verifies, reduces,
  hands off and answers, as in the stack spike's 1 to 3 ms of CPU.
- Every GraphQL query sets page sizes deliberately, since points are charged
  for the sizes requested; and stays well within the 10-second limit, since a
  timeout costs points for the next hour ([timeouts][gql-timeouts]).
- One code path turns a GitHub read into a stored PR, used by re-reads and the
  sweep alike.
- The sweep never treats a failed or partial read as "no open PRs". A
  repository that could not be read keeps its last known PRs, marked as out of
  date, and is listed in the sync failure.
- The object's constructor writes nothing, as the [stack
  constraints](2026-10-13-cloudflare-stack.md#constraints-for-implementation)
  require; the alarm check on each request writes only when no alarm is set.

## Not verified

- **Whether GitHub's API reflects a change by the time its webhook arrives.**
  For check runs the API showed new states about when deliveries arrive (see
  [Measurements](#measurements)), as did one push; reviews and PR state
  changes were not measured. The design checks each read against the facts
  the delivery reported and retries, so this affects only how often retries
  happen.
- **Whether GitHub recomputes mergeability promptly after a push to the base
  branch that causes a conflict.** The design relies on it, and the sample in
  [Measurements](#measurements) included no push that caused a conflict.
  Implementation should test it with a conflicting push to a base branch,
  and if GitHub leaves the old value, have the sweep fetch each open PR
  through the REST endpoint in turn, a few per sweep.
- **Whether a GraphQL read starts the mergeability computation.** The design
  uses the REST endpoint, which is documented to.
- **Costs with an installation token.** The measurements used a user token. The
  documented point rule does not depend on the token, but GraphQL access with
  an installation token to `nodes` by repository ID is not yet exercised.
- **Subrequest budget in an alarm.** The stack spike found a fresh budget of 50
  for an RPC call into the object, and alarms were not tested. Cloudflare's
  limits page lists alarm handlers as an invocation type for wall time, but
  does not say that the 50 subrequests apply per alarm ([Workers
  limits][cf-limits-subrequests]). The sweep keeps each alarm under 50 either
  way.
- **Whether a deploy keeps a scheduled alarm.** Cloudflare's alarm pages do not
  say. The pages that reconnect after a deploy re-arm it regardless.
- **How long a socket stays open after the client's machine sleeps.** The
  design does not depend on it, since a visibility report expires after 15
  minutes.
- **Search freshness.** Not needed by this design; listed because the
  search-based sweep was rejected on it.

## Questions for the owner

Decided by the owner on 2026-10-15, and recorded in
[DECISIONS.md](../DECISIONS.md#2026-10-15--check-github-only-while-someone-is-looking):
the object sweeps only while an overview is visible, judged by visibility
reports rather than sessions, sockets or pings; there is no tail of sweeps
after the last page goes; a page that becomes visible gets a catch-up sweep
and a checking state; the sweep runs every 2 minutes while active, with the
bounds and threshold above; and DELIVERABLE.md says so. That also settles the earlier question about a
Cron Trigger watchdog, which is no longer needed.

Still open:

1. **Mechanism.** Accept webhooks as marks for re-reading, plus a sweep that
   counts open PRs and then reads the repositories that have them, with no
   delivery-log redelivery? *Recommended.*
2. **No new permissions.** Leave Contents and Issues out, so top-level
   comments and base-branch conflicts arrive by sweep rather than by webhook?
   *Recommended.*

## Sources

GitHub documentation, read 2026-10-14:

- [Webhook events and payloads][wh-events]
- [Handling failed webhook deliveries][wh-failed]
- [Best practices for using webhooks][wh-best]
- [Troubleshooting webhooks][wh-order]
- [Redelivering webhooks][wh-redeliver]
- [REST API endpoints for GitHub App webhooks][rest-app-hooks]
- [REST API endpoints for GitHub App installations][rest-installations]
- [REST API endpoints for pull requests][rest-pull]
- [Checking mergeability of pull requests][rest-mergeability]
- [Best practices for using the REST API][rest-conditional]
- [Rate limits and query limits for the GraphQL API][gql-limits]
- [GraphQL enums: MergeableState][gql-mergeable]

Cloudflare documentation, read 2026-10-14 and, for the WebSockets page,
2026-10-15:

- [Durable Objects alarms API][do-alarms]
- [Durable Objects pricing][do-pricing]
- [Workers limits][cf-limits-subrequests]
- [Durable Objects WebSockets][do-websockets]
- [Static assets billing][cf-assets-billing]

Other:

- [MDN: Page Visibility API][mdn-visibility]

[wh-events]: https://docs.github.com/en/webhooks/webhook-events-and-payloads
[wh-check-run]: https://docs.github.com/en/webhooks/webhook-events-and-payloads#check_run
[wh-failed]: https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries
[wh-best]: https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks
[wh-order]: https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/troubleshooting-webhooks#webhooks-deliveries-are-out-of-order
[wh-redeliver]: https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks
[rest-app-hooks]: https://docs.github.com/en/rest/apps/webhooks#list-deliveries-for-an-app-webhook
[rest-installations]: https://docs.github.com/en/rest/apps/installations#list-repositories-accessible-to-the-app-installation
[rest-pull]: https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request
[rest-mergeability]: https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-your-git-database#checking-mergeability-of-pull-requests
[rest-conditional]: https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests
[gql-limits]: https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api
[gql-timeouts]: https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api#timeouts
[gql-mergeable]: https://docs.github.com/en/graphql/reference/enums#mergeablestate
[do-alarms]: https://developers.cloudflare.com/durable-objects/api/alarms/
[do-pricing]: https://developers.cloudflare.com/durable-objects/platform/pricing/
[cf-limits-subrequests]: https://developers.cloudflare.com/workers/platform/limits/#subrequests
[do-websockets]: https://developers.cloudflare.com/durable-objects/best-practices/websockets/
[mdn-visibility]: https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API
[cf-assets-billing]: https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/#billing
