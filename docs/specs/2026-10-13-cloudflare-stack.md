# Cloudflare stack

Status: **proposed on 2026-10-13, awaiting the owner.** This answers the queue
entry `choose-cloudflare-stack` and is judged against
[DELIVERABLE.md](../DELIVERABLE.md), within the GitHub App chosen in
[DECISIONS.md](../DECISIONS.md#2026-10-12--github-integration). Facts about
Cloudflare were checked against Cloudflare's documentation on 2026-10-13 and
measured the same day with a throwaway spike deployed to a Workers Free
account. Each documented claim links to its source; each measured one says so.
Points the spike has not yet settled are listed under
[Not verified](#not-verified).

This document does not choose how changes are detected or how missed events
are reconciled (`choose-change-detection`). It records what the stack allows
and costs, which that decision works within.

## Recommendation

- **One Worker per instance**, written in TypeScript. It serves the frontend
  as [static assets][cf-assets], receives GitHub webhooks, runs sign-in and
  serves the API.
- **One SQLite-backed Durable Object per instance** holds all instance state:
  the PR model, sync status, monitoring overrides and sessions. It also holds
  every open browser connection, using the [WebSocket Hibernation
  API][do-websockets]. The Worker verifies a webhook's signature and hands it
  to the object, which stores it, updates the model and pushes the change to
  open tabs.
- **Heavy work runs in the Durable Object.** On the Free plan the spike's
  object ran for 18 seconds of CPU in one invocation, while a stateless Worker
  request is documented at 10 ms. GitHub API reads, parsing and bucketing
  belong in the object; the Worker's own path stays small.
- **Reconciliation runs from a Durable Object alarm or a Cron Trigger**, in
  batches of at most 50 GitHub requests per invocation, the Free plan's
  external subrequest limit (measured in both the Worker and the object). The
  interval and catch-up bound are `choose-change-detection`'s to set.
- **The frontend** is a reactive client built to static files. On connecting
  it receives a snapshot of the model, then a message per change, and
  re-renders. Any framework fits this; which one is
  [question 2](#questions-for-the-owner).
- **No other storage product.** KV, D1, R2, Queues, Workflows and Secrets
  Store are not needed for the first deliverable; see
  [Options considered](#options-considered).
- **Credentials stay Worker secrets set by the owner**, as the GitHub
  decision proposed, because the Free plan offers no encrypted store that a
  Worker can write itself; see [Secrets](#secrets). The Worker accepts the
  private key in the PKCS#1 form GitHub issues and converts it itself, so the
  owner pastes it unchanged.

The owner's working hypothesis, webhooks persisted in Cloudflare storage and
pushed to a reactive page without a reload, holds on the Free plan. Bounded
polling is not needed as the primary path, though the page still resyncs on
every reconnect.

## The spike

A single Worker with one SQLite-backed Durable Object, deployed to the owner's
personal Cloudflare account as `seshat-spike-stack`. The account is on the
Free plan: deploying with a configured CPU limit was refused with "CPU limits
are not supported for the Free plan" (code 100328), which is a paid-only
setting ([Wrangler configuration][cf-wrangler-limits]).

The spike was throwaway code kept outside this repository, which has no
application stack yet. It did the following:

- `POST /webhook` checked `X-Hub-Signature-256` with Web Crypto HMAC and a
  constant-time comparison, parsed the payload, reduced it to a summary and
  called the object over RPC.
- The object stored the summary in SQLite keyed by `X-GitHub-Delivery`
  (`INSERT OR IGNORE`, so a redelivery is a no-op) and sent it to every
  hibernatable WebSocket. A runtime auto-response answered `ping` with `pong`
  without waking the object.
- `GET /` was a plain page that opened the socket, rendered a snapshot on
  connect and each pushed event afterwards, and reconnected with backoff. It
  used no framework; the point was the transport.
- A Cron Trigger every five minutes called the object, which recorded a
  last-sync time and pushed it to the page.
- Benchmark routes signed a GitHub App JWT from a PKCS#1 key, burned CPU in
  the Worker and in the object, and made external requests until refused.
- A temporary webhook on this repository sent real GitHub deliveries to the
  spike.

CPU and wall time came from `wrangler tail --format json`, whose events carry
`cpuTime` and `wallTime` fields (not documented for `wrangler tail`, but
present). Synthetic deliveries used a 29 KB `pull_request` payload built from
this repository's PR #6.

## Measurements

All on the Free plan, 2026-10-13 and 2026-10-14 UTC, from a client in the
United States. Wall times include the network between the client, Cloudflare
and the object.

| Path | CPU | Wall | Notes |
| --- | --- | --- | --- |
| Webhook, Worker side | 1–2 ms | median 49 ms | 11 deliveries of 29 KB, signature check and parse included |
| Webhook, object side (`ingest`) | 0–1 ms | median 35 ms | SQLite insert and broadcast |
| Webhook POST to socket receipt | | median 75 ms, max 129 ms | 10 rounds, one open tab |
| Same after 90 s idle | | 156 ms | Object hibernated and was woken by the delivery |
| Cron Trigger to object | 1 ms | 200 ms | Records and pushes last sync |
| RS256 JWT, PKCS#1 key | 3–6 ms | | One JWT including key wrap and import; 10 in one request took 14 ms |
| Socket ping | | | Answered by auto-response; no invocation recorded |

Real GitHub deliveries: GitHub recorded the hook's `ping` as answered with
202 in 0.39 s. Timings for real pull request and CI events are under
[Not verified](#not-verified).

**Hibernation works with a socket held open.** A tab kept its socket open for
90 seconds of idle time, sending a ping every 20 seconds. The pings were
answered without any invocation of the object appearing in the tail. The
object's constructor counter went from 1 to 2 across the idle period, which
means it was evicted from memory and rebuilt when the next delivery arrived,
and that delivery still reached the open socket. Hibernated objects are not
billed for duration ([Durable Objects pricing][do-pricing]).

**Durable Objects get about 30 seconds of CPU on Free.** Cloudflare's limits
page contradicts itself: its table gives 30 s per request with no plan split,
while its FAQ says objects have the same per-invocation CPU limits as any
Worker, which on Free is 10 ms ([Durable Objects limits][do-limits]). In the
spike, object invocations using 5.3 s and 18.1 s of CPU completed; one at
32.5 s was stopped with "Durable Object exceeded its CPU time limit and was
reset." The table is right.

**The Worker's 10 ms is not a hard cutoff, but should be treated as one.**
Stateless requests using up to 1.4 s of CPU completed repeatedly; one at
2.0 s was stopped with error 1102 and outcome `exceededCpu`. Cloudflare
documents 10 ms on Free with "some built-in flexibility" for occasional
overruns ([Workers limits][cf-limits-cpu]). That flexibility is not a budget:
the design keeps the Worker's own path within 10 ms and does heavy work in the
object, where 30 s is the documented limit.

**50 external subrequests per invocation, in the Worker and in the object.**
Sequential `fetch` calls failed at the 51st with "Too many subrequests by
single Worker invocation" in both, matching the documented Free limit
([Workers limits][cf-limits-subrequests]). Each new invocation, such as an
alarm or an RPC call into the object, gets its own budget, so reconciliation
is split across invocations.

**The JWT path needs no library.** Web Crypto has no PKCS#1 import, so the
spike wrapped GitHub's PKCS#1 key in a PKCS#8 header (about 20 lines of DER
encoding) and imported that. The resulting RS256 JWT verified against the
key's public half. Signing once per hour, when an installation token is
minted, costs a few milliseconds.

## Free-plan budget

Quotas reset at 00:00 UTC. Going over a free quota makes further operations
of that type fail; nothing is billed ([Durable Objects pricing][do-pricing];
[Workers limits][cf-limits-requests]).

| Quota (Free) | Limit | What uses it |
| --- | --- | --- |
| Worker requests | 100,000 per day ([limits][cf-limits-requests]) | Each webhook delivery, page load, socket open and scheduled run. Static assets are free and unlimited ([assets billing][cf-assets-billing]). |
| Durable Object requests | 100,000 per day ([pricing][do-pricing]) | Each RPC call, socket open, incoming socket message and alarm. Messages from the object to the browser are free. |
| Durable Object duration | 13,000 GB-s per day ([pricing][do-pricing]) | Time awake, billed at 128 MB. One object awake all day uses about 11,059 GB-s, so even without hibernation one instance fits. |
| SQLite rows written | 100,000 per day ([pricing][do-pricing]) | Each stored delivery, model update and alarm set. |
| SQLite rows read | 5,000,000 per day ([pricing][do-pricing]) | Snapshots, recomputation. |
| SQLite storage | 5 GB per account ([pricing][do-pricing]) | The PR model and a bounded delivery log. |
| CPU | 10 ms per Worker request, 30 s per object invocation | See [Measurements](#measurements). |
| External subrequests | 50 per invocation ([limits][cf-limits-subrequests]) | GitHub API calls. |
| Cron Triggers | 5 per account ([limits][cf-limits-account]) | One for reconciliation, if alarms are not used instead. |
| Secrets and variables | 64 per Worker, 5 KB each ([limits][cf-limits-env]) | Private key, client secret, webhook secret, owner ID. |
| Workers Logs | 200,000 events per day, 3 days retention; from 2026-12-01, 0.5 GB per day and 7 days, with ingestion stopping at the cap ([Workers Logs][cf-logs]; [observability pricing][cf-obs-pricing]) | One event per invocation plus each `console.log`. |

As an estimate, a heavy GitHub user's instance uses a small fraction of these.
Say 50 pushes a day across monitored repositories, each producing a
`pull_request` delivery and around ten CI deliveries (`check_run` created and
completed, `check_suite`, `status`): about 550 deliveries, each one Worker
request and one object request. A reconciliation run every minute adds 1,440
of each. Page loads and socket opens add tens or hundreds. That is a few
thousand requests a day against 100,000. Rows written depend on how the model
is stored, and stay in the thousands on the same assumptions. Whether a Cron
Trigger run counts as a Worker request is not documented; this estimate
assumes it does.

## Options considered

**Storage.**

- *Durable Object SQLite* (recommended): strongly consistent, one writer, so
  concurrent deliveries for the same PR cannot race; the same object holds the
  sockets, so storing a change and pushing it is one step. Free plan objects
  must be SQLite-backed ([Durable Objects limits][do-limits]).
- *D1*: the same quotas as Durable Object SQLite and a familiar database
  interface, but it is a second component that the Worker reaches over a
  binding, with a 50-queries-per-invocation limit ([D1 limits][d1-limits]),
  and pushing to browsers still needs a Durable Object. Each D1 database is
  itself backed by a Durable Object. Nothing it adds is needed here.
- *KV*: 1,000 writes per day on Free and up to 60 seconds or more before a
  change is visible in other locations ([KV limits][kv-limits]; [how KV
  works][kv-consistency]). Ruled out for webhook state.
- *R2*: enabling it takes a subscription through a checkout flow
  ([R2 get started][r2-start]), and Cloudflare's billing policy asks for a
  valid payment method before enabling subscriptions
  ([billing policy][cf-billing]). Ruled out by the brief's no-paid-service
  rule, and not needed.

**Live updates.**

- *Hibernatable WebSockets on the Durable Object* (recommended): measured
  above. Up to 32,768 per object ([state API][do-state]); pushes from the
  object are free.
- *Server-sent events from the Worker*: a stateless Worker cannot fan an
  update out to other tabs, so it would still need a Durable Object, which
  then offers WebSockets anyway, and an object streaming a response without
  hibernation is billed for duration while the stream stays open.
- *Polling from the page*: works, at a Worker request per tab per interval,
  and adds up to the interval to every update. Kept only as the resync on
  reconnect.

**Background work.** Queues (10,000 operations per day on Free) and Workflows
(3,000 steps per day, 10 ms CPU per step) are both available
([Workers pricing][cf-pricing]; [Workflows limits][wf-limits]), but alarms on
the one Durable Object give scheduling, retries and 30 s of CPU without
another product.

## Constraints for implementation

- **Every deploy disconnects every socket** and restarts every Durable Object
  ([WebSockets best practices][do-websockets]), and so does `wrangler secret
  put`, which deploys a new version ([Workers secrets][cf-secrets]). The page
  reconnects with backoff and reloads its snapshot; the spike's page did.
- **The webhook handler answers quickly.** GitHub stops waiting after 10
  seconds and does not redeliver on its own (see
  [Webhook events](2026-10-12-github-integration.md#webhook-events)). The
  spike answered in about 50 ms of wall time. Delivery IDs are the
  de-duplication key.
- **Object placement.** An object is created near the first request for it
  and does not move; a location hint is honoured only on that first request
  ([data location][do-location]). The first request may be a webhook from
  GitHub rather than the owner's browser, so the instance should pass a hint
  for the owner's region.
- **Cron Trigger changes** can take up to 15 minutes to propagate
  ([Cron Triggers][cf-cron]).
- **Workers Logs pricing changes on 2026-12-01.** On Free, logging stops at
  0.5 GB a day. Logging every webhook body would use that quickly; log
  summaries.
- **Tail Workers and Logpush are paid-only** ([Workers Logs][cf-logs]). Free
  instances have Workers Logs and `wrangler tail`.

## Secrets

The GitHub decision left one point to this stack: the setup page shows the
app's credentials once for the owner to store as secrets, unless the stack
has encrypted storage that is as good.

- A Worker cannot set its own secrets. Secrets are written with Wrangler, the
  dashboard or the API with a Cloudflare API token, and each write creates and
  deploys a new version ([Workers secrets][cf-secrets]).
- Secrets Store, which Workers read through a read-only binding, is in open
  beta, and its documentation states no plan availability or price
  ([Secrets Store][cf-secrets-store]).
- Durable Object storage is the remaining option. The spike kept its test
  app's credentials there for convenience. That puts the private key in
  instance storage, which the GitHub decision chose to avoid.

So the recommendation keeps the GitHub decision as it stands: the setup page
shows the credentials once and the owner stores them with `wrangler secret
put`. Because the Worker converts the key itself, the owner pastes the PEM
GitHub issued without converting it, which removes the conversion from
setup step 4 in
[Setup burden](2026-10-12-github-integration.md#setup-burden).

## Not verified

- **The GitHub App items this spike was asked to confirm**, the first two
  under [Not verified](2026-10-12-github-integration.md#not-verified) in the
  GitHub integration spec: whether an all-repositories installation on a
  personal account receives `repository` `created` and
  `installation_repositories` `added` for a repository created later and
  lists it in `GET /installation/repositories`, and whether other GitHub users
  can authorize a private app owned by a personal account. Registering an app
  needs the owner in a browser, and the second check needs a second GitHub
  account. The spike has routes ready for both: `/app/new` registers a
  private app through the manifest flow with the four read-only permissions,
  `/app/status` mints installation tokens and lists the installation's
  repositories and the lifecycle events received, and `/app/sign-in` runs the
  user authorization, compares the account ID with the app owner's and
  revokes the token.
- **Real GitHub-to-page latency for pull request and CI events.** Synthetic
  deliveries reached the page in under 130 ms of their POST; GitHub's own
  delay before delivering is not yet measured.
- Whether a Cron Trigger run counts toward the 100,000 daily Worker requests.
- Whether the 20:1 ratio for incoming WebSocket messages applies to the Free
  plan's request count; the pricing page states it for paid usage only
  ([Durable Objects pricing][do-pricing]). The page sends one ping every 30
  seconds per tab, which is small either way.

## Questions for the owner

1. **Stack.** Accept one Worker with static assets, one SQLite-backed Durable
   Object per instance and hibernatable WebSockets, with no other storage
   product? Recommended.
2. **Frontend framework.** React, as the working hypothesis named, is a
   reasonable default with the widest ecosystem; Preact is the same model at a
   fraction of the size; a framework-free page is enough for one table but
   gets harder as the overview grows. Any of them builds to static files and
   uses the socket the same way. Recommended: React with Vite, which
   Cloudflare supports for Workers with static assets through its Vite
   plugin.
3. **GitHub App checks.** Register the spike app at `/app/new`, install it on
   the personal account with All repositories, create a test repository, and
   try `/app/sign-in` from a second GitHub account, so the two GitHub items
   above can be recorded here.
4. **Teardown.** After the checks, delete the spike Worker, the temporary
   webhook on this repository and the spike app.

## Sources

Cloudflare documentation, read 2026-10-13:

- [Workers limits][cf-limits-cpu]
- [Workers pricing][cf-pricing]
- [Wrangler configuration: limits][cf-wrangler-limits]
- [Workers static assets: billing and limitations][cf-assets-billing]
- [Workers secrets][cf-secrets]
- [Workers Logs][cf-logs]
- [Observability pricing][cf-obs-pricing]
- [Cron Triggers][cf-cron]
- [Durable Objects limits][do-limits]
- [Durable Objects pricing][do-pricing]
- [Durable Objects WebSockets best practices][do-websockets]
- [Durable Object state API][do-state]
- [Durable Objects data location][do-location]
- [D1 limits][d1-limits]
- [KV limits][kv-limits]
- [How KV works][kv-consistency]
- [R2 get started][r2-start]
- [Billing policy][cf-billing]
- [Secrets Store][cf-secrets-store]
- [Workflows limits][wf-limits]

[cf-limits-cpu]: https://developers.cloudflare.com/workers/platform/limits/#cpu-time
[cf-limits-requests]: https://developers.cloudflare.com/workers/platform/limits/#daily-requests
[cf-limits-subrequests]: https://developers.cloudflare.com/workers/platform/limits/#subrequests
[cf-limits-account]: https://developers.cloudflare.com/workers/platform/limits/#account-plan-limits
[cf-limits-env]: https://developers.cloudflare.com/workers/platform/limits/#environment-variables
[cf-pricing]: https://developers.cloudflare.com/workers/platform/pricing/
[cf-wrangler-limits]: https://developers.cloudflare.com/workers/wrangler/configuration/#limits
[cf-assets]: https://developers.cloudflare.com/workers/static-assets/
[cf-assets-billing]: https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/#billing
[cf-secrets]: https://developers.cloudflare.com/workers/configuration/secrets/#secrets-on-deployed-workers
[cf-logs]: https://developers.cloudflare.com/workers/observability/logs/workers-logs/#pricing
[cf-obs-pricing]: https://developers.cloudflare.com/observability/pricing/#plans
[cf-cron]: https://developers.cloudflare.com/workers/configuration/cron-triggers/
[do-limits]: https://developers.cloudflare.com/durable-objects/platform/limits/
[do-pricing]: https://developers.cloudflare.com/durable-objects/platform/pricing/
[do-websockets]: https://developers.cloudflare.com/durable-objects/best-practices/websockets/
[do-state]: https://developers.cloudflare.com/durable-objects/api/state/#acceptwebsocket
[do-location]: https://developers.cloudflare.com/durable-objects/reference/data-location/#provide-a-location-hint
[d1-limits]: https://developers.cloudflare.com/d1/platform/limits/
[kv-limits]: https://developers.cloudflare.com/kv/platform/limits/
[kv-consistency]: https://developers.cloudflare.com/kv/concepts/how-kv-works/#consistency
[r2-start]: https://developers.cloudflare.com/r2/get-started/#before-you-begin
[cf-billing]: https://developers.cloudflare.com/billing/understand/billing-policy/
[cf-secrets-store]: https://developers.cloudflare.com/secrets-store/
[wf-limits]: https://developers.cloudflare.com/workflows/reference/limits/
