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
| 2: repository selection | `src/object/repository-selection.test.ts`, `src/worker/repositories.test.ts`, repository discovery through sync tests, and assembled monitoring changes through `/repositories`. |
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
