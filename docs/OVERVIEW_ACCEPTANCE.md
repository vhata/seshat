# Assembled overview acceptance

The overview combines the GitHub reader, repository choices, reconciliation
and the browser page. Component tests cover each part; the assembled check
also exercises the production Worker and SQLite Durable Object through a
real browser and WebSocket.

## Reproducing the assembled check

Run the regular gates first:

```sh
bash scripts/check.sh
```

Then run the browser scenario with Playwright and Chromium installed:

```sh
node scripts/acceptance-overview.mjs
```

If Playwright is installed outside this worktree, set `PLAYWRIGHT_MODULE`
to its module path. `CHROMIUM_PATH` selects an existing Chromium executable.
The scenario uses the built frontend from `dist/client`, production Worker
and object classes, a local Miniflare runtime and real browser WebSockets.
GitHub is replaced at the runtime's outbound service boundary; an unknown
request fails the scenario. Browser requests to other origins are refused.

The harness seeds an owner session through a private service binding. Its
test bundle supplies clock and alarm controls through that binding, outside
the HTTP surface. Since workerd reserves the alarm RPC name, a generated
test-only subclass exposes a method that calls the production alarm handler.
It inherits the production fetch, storage and socket behavior. The deployed
entrypoint, object source and authorization checks are unchanged. Simulated
tab visibility goes through the page's actual visibility listener and real
socket.

Screenshots and aggregate results are written to the ignored directory
`.context/acceptance-overview/`. No test seed routes, credentials or generated
test bundle are added to the deployed application.

## Real GitHub App scenario

To run the same assembled page against an existing local App configuration:

```sh
SESHAT_REAL_APP_VARS=/path/to/.dev.vars \
  node scripts/acceptance-overview.mjs
```

This mode allows GitHub REST reads, GraphQL queries and creation of ephemeral
installation tokens. It refuses DELETE and other mutations, including
GraphQL mutations. It keeps local application state in Miniflare, seeds a
local owner session, completes a production sweep and checks the resulting
browser rows and a 390 px viewport. It does not authorize through a browser,
receive real webhook deliveries, deploy or open a tunnel. The private
screenshots stay ignored; the JSON result contains aggregate counts.

## Acceptance coverage

The numbered requirements are in
[DELIVERABLE.md](DELIVERABLE.md#acceptance-checks).

| Check | Evidence |
| --- | --- |
| 1: owner boundary | `src/worker/auth.test.ts`, `src/worker/overview.test.ts` and assembled anonymous snapshot/session revocation checks. The separate manual scenario has the explicit waiver recorded below. |
| 2: repository selection | `src/object/repository-selection.test.ts` covers selection and owner-only repository routes, with discovery through sync tests and assembled monitoring changes through `/repositories`. Organization coverage meets the initial-release amendment below; live organization verification is deferred. |
| 3: complete bucketing and ordering | `src/shared/overview/*.test.ts`, reader and sync runtime tests, and one assembled row in each of the seven buckets. |
| 4: row facts | `src/frontend/Overview.test.tsx` and the assembled desktop and phone renders. |
| 5: notified changes | `src/object/overview-sync.test.ts`, webhook reduction tests and signed deliveries through the assembled Worker to the real browser socket. |
| 6: missed events and visibility | Sync runtime tests plus the assembled missed-delivery sweep, hidden-tab dormancy and visible catch-up. |
| 7: sync status | Freshness/client tests plus assembled last-success display, checking before overdue, failed sweep/retry and recovery. |
| 8: stale flag | Activity/rule tests, reader activity mapping, sync tests and assembled seven-day stale badges. |
| 9: free tier and no LLM key | Configuration and dependency review below. |
| 10: phone readability and wording | Recorded assembled screenshots and visual review below. |

The reader's real-App checks, including private repository reads, live query
cost and pagination limits, are recorded in
[GITHUB_READER.md](GITHUB_READER.md).

### Organization acceptance for the initial release

Selection tests exercise organization acceptance, refusal, owner permissions
and repository opt-in with stubbed GitHub responses. The real-App run below
used the owner's installation and does not demonstrate a live organization
installation.

The [initial-release decision](DECISIONS.md#2026-10-23--organization-acceptance-for-the-initial-release)
accepts this automated coverage for check 2 because the instance owner
controls no organizations. Live organization installation and opt-in remain
unverified and are deferred under `verify-live-organization-opt-in` in
[TODO.md](../TODO.md). This amendment applies to that live scenario; the
other acceptance requirements continue to apply.

### Second-account manual check waiver

On 2026-10-17 the manual half of check 1 was explicitly waived: GitHub
blocked creating a second account, and the recorded reason included its
one-free-account-per-person restriction. The original decision is preserved
in the [immutable queue record](https://github.com/vhata/seshat/blob/2df998a1c7ee65bcf0439121394d965ffb9f926d/TODO.md#L158).
This waiver covers only that manual scenario. Automated refusal by numeric
account ID, including a matching username with a different ID, lack of
instance data and absence of stored credentials remain required and tested.

## Required services and free-tier boundary

`wrangler.jsonc` requires a Worker with static assets and one SQLite Durable
Object (`new_sqlite_classes`). There are no paid-only bindings or services.
The application configuration accepts owner/App credentials; it has no LLM
provider setting, dependency or request path. The complete stubbed scenario
also refuses every outbound request except the explicitly modeled GitHub
API endpoints.

Cloudflare's current [Durable Object pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
includes SQLite objects on Workers Free: 100,000 requests, 13,000 GB-s,
100,000 rows written and 5 million rows read per day, with 5 GB of storage.
A single object awake continuously uses about 11,059 GB-s in a day; the
application additionally uses hibernating sockets and skips scheduled
GitHub reads while no overview is visible. Reader work is bounded below the
[Workers Free subrequest limit](https://developers.cloudflare.com/workers/platform/limits/#subrequests)
and continues across invocations. These establish free-plan-compatible
dependencies and bounded work, not unlimited capacity: other applications
on the account share its quotas, and excessive usage can fail operations.
No Cloudflare resource was provisioned for these local checks.

## Recorded observations

The repeatable assembled scenario passed on 2026-10-18. Seven sample PRs
appeared once each, one per bucket, with stale flags from GitHub activity
eight days earlier. Thirteen signed deliveries exercised PR state, head,
review, status, check-run and repository changes through the real Worker,
object and browser socket. Each transition was observed after 2.512 seconds
of controlled scheduler time. This is deterministic local timing with
stubbed GitHub, not a measurement of GitHub delivery latency.

A missed delivery was recovered by the next visible sweep within two
minutes of controlled time. Six minutes hidden produced no scheduled
GitHub reads; becoming visible started catch-up. A newly visible overview
with old data said Checking, then Overdue after a minute without a sweep.
A failed sweep and its retry produced a prominent failed banner while
retaining all known rows. An explicit retry after the shared one-minute
catch-up throttle recovered. Evicting the object closed the real socket;
the page reconnected and recovered its stored snapshot without reloading.
Revoking the session disconnected the socket, and an anonymous snapshot
request returned 401 without repository data.

### Phone and wording review

The generated full-page 390 px screenshot, 320 px viewport screenshot and
390 px failed-sync screenshot were visually reviewed. Header controls,
summary chips, long rules and PR titles wrap within the viewport. Cards
show repository, author/bot, draft/stale labels, CI, review, conflicts,
opened age and last activity without horizontal scrolling. The failed
banner remains prominent above the dimmed rows. Document scroll widths
were exactly 390 and 320 px respectively. The page names GitHub as its
source and makes no claim to have inspected local checkouts, local changes
or unpushed commits. This is a headless Chromium phone-viewport review;
physical-device interaction was not exercised.

### Real App read

The read-only real-App scenario completed on 2026-10-18 at 06:55 UTC. A
production sweep discovered 74 repositories, including 13 private ones;
the default monitored owned-repository set produced 52 open PR rows.
All 52 rows had distinct GitHub node IDs, and the browser
rendered the same count as the object snapshot over its real WebSocket.
The sweep made 110 GitHub requests across invocations. At 390 px, the page's
scroll width was 390 px; no browser errors or third-party page requests
were observed. Only aggregate counts are recorded here; private repository
content and screenshots remain outside version control.

Real GitHub webhook timing is outside this local check: GitHub cannot reach
the local instance without a tunnel or deployment. Signed local deliveries
and controlled GitHub replies exercise that path in the repeatable scenario.

## Hosted verification, 2026-10-26

The owner-authorized instance at <https://seshat.vhata.workers.dev> uses a
Worker, static frontend assets and a SQLite Durable Object. Its separate
GitHub App is installed on the owner's personal account with All repositories.
Its active, TLS-verified webhook points to `/api/github/webhook` on that
origin and subscribes to the seven events in the production manifest.
Owner and App credentials were uploaded as Worker secrets; no credential
or private repository content is included in this record.

The initial deployment exposed a private-review permission boundary that
the earlier local real-App sample, which had no private submitted reviews,
had not demonstrated. GitHub accepted the review webhook with HTTP 202,
but `PullRequestReview.commit` returned a GraphQL integration-access error.
The review was not reflected within 60 seconds, and a subsequent closure
also timed out in a 45-second browser observation. That shorter closure
observation does not establish its 60-second result. Successful webhook
acknowledgement alone did not establish that the page was current.

The reader now obtains review commit identities through the REST review
listing with the same Pull requests read permission. It retains strict
GraphQL error handling, identity validation, pagination and request limits.
The corrected application was deployed from
`a0fcc3df9dbc786bf7a091fb7996372617d6eb2c`, Worker version
`fd8b7f83-176c-477f-a30a-1c0447c3c050`. The [reader documentation](GITHUB_READER.md)
describes the API and continuation boundary.

### Real browser and notified changes

An ordinary browser completed GitHub authorization through the hosted
`/auth/callback` (HTTP 303), then received an authenticated `/api/session`
response (HTTP 200). No session was seeded or injected. The overview used
the production WebSocket and GitHub API, with no stubbed responses or
test-only server routes.

A private fixture repository exercised the following fresh changes after
the correction was deployed. Each timing starts before sending the real
GitHub mutation and ends when the existing page's DOM reflects its result.
This conservatively includes the API request time before GitHub reports
the change. No document navigation or manual reload occurred during any
measurement. All results meet the 60-second bound.

| GitHub change | Observed on the page |
| --- | --- |
| PR opened | 26.720 s |
| PR closed, with submitted private reviews | 5.074 s |
| PR reopened | 5.682 s |
| PR merged, fixture content only | 10.163 s |
| Draft to ready | 8.370 s |
| Ready to draft | 4.871 s |
| Push to the PR | 7.435 s |
| Comment review submitted | 7.917 s |
| Head commit status pending | 4.057 s |
| Head commit status failing | 4.078 s |
| Head commit status passing | 3.885 s |

The review appeared with its real submitted time and commit identity. A
subsequent push changed the stored and socket-delivered head while preserving
the older reviews' commit SHAs. GitHub's delivery records independently
confirmed HTTP 202 responses for the corresponding real events.

### Automatic catch-up and access boundary

A top-level comment, which the App does not subscribe to, reached the
visible page in 21.559 seconds, within the five-minute catch-up bound.
A passive DOM observer recorded the first matching activity timestamp;
the page was not refreshed to obtain it.

For the hidden case, only one overview was open. Browser focus emulation
was disabled and the dedicated window was minimized; the browser reported
`hidden` and its production socket sent `visible: false`. A new unsubscribed
comment remained unobserved for the 150.944-second hidden interval.
Restoring the window and visibility produced the DOM update in 25.267
seconds from restoration starting (24.592 seconds from the browser's visible
event), within the three-minute bound. Neither catch-up measurement
navigated or reloaded the overview.

The public health endpoint returned HTTP 200. Anonymous overview, session
and socket requests returned HTTP 401 with no instance data; `/setup`
returned HTTP 404 after configuration. An unsigned webhook returned HTTP
401. Independent checks also confirmed `Cache-Control: no-store` on those
responses. GitHub's initial registration ping arrived before App secrets
were uploaded and returned HTTP 503; the configured installation and
measured change deliveries succeeded.

Signing out through the production endpoint returned HTTP 303 and closed
the already-open socket without navigating its page. Replaying the former
browser session cookie against `/api/session` returned HTTP 401, confirming
server-side revocation rather than only cookie removal. A fresh ordinary
GitHub authorization then restored the owner's authenticated overview.

### Validation scope

The corrected source passed `bash scripts/check.sh`: 621 tests, type checks
and production build. The assembled browser scenario also passed all seven
buckets, thirteen signed transitions, missed-event and visibility handling,
failure/retry, reconnect, session revocation and 390/320 px viewport checks,
with no browser errors or unexpected outbound requests. That scenario still
uses local controlled timing; the table above is separate hosted evidence.

The live review case was a comment review, and CI used real commit statuses.
Approval/changes-requested bucketing and check-run payloads retain their
automated coverage. No additional GitHub identity, live organization
installation or physical phone was exercised. This deployment used the
owner's existing Cloudflare account with explicit billing authorization;
it does not establish operation under a Workers Free subscription or prove
account-wide quota capacity. Private raw evidence and browser profiles
remain ignored under `.context/hosted/` and `.context/hosted-browser/`.
The private fixture's PRs were closed and its repository archived after
verification; no repository was deleted.
