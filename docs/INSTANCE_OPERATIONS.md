# Hosted instance operations

Use this runbook for an existing Seshat instance. First-time registration
and installation remain in [hosted setup](../README.md#hosted-setup);
configuration names and owner/session behavior are in
[configuration and sign-in](../README.md#configuration-and-sign-in).
The [acceptance record](OVERVIEW_ACCEPTANCE.md#hosted-verification-2026-10-26)
describes a past deployment, not necessarily the version running now.

## Identify the target before making changes

Run commands from the repository root after `bash scripts/setup.sh`.
Examples below use the installed Wrangler and Bash. Replace the example
account ID, Worker name and HTTPS origin with the intended instance's
values; do not infer the account or URL from this checkout alone.

```sh
export WRANGLER_SEND_METRICS=false
export CLOUDFLARE_ACCOUNT_ID='<account-id>'
instance_worker='seshat'
instance_origin='https://<instance-host>'
npx wrangler --version
npx wrangler whoami
```

In the Cloudflare dashboard, select that account, then **Workers & Pages**
and the Worker. Compare its account ID, name, domains/routes and subscription
with the intended target. `whoami` identifies the authenticated principal
and accounts; it does not establish the Worker URL or billing plan. Use
the Worker's configured production domain, not a version-preview URL.
Keep account details and raw inspection output private.

The default source configuration is [wrangler.jsonc](../wrangler.jsonc):
Worker `seshat`, binding `INSTANCE`, class `InstanceObject`, and initial
SQLite class migration `v1`. All instance state uses the object named
`instance` within that Worker's namespace. Changing a Worker name, binding
or namespace can select different state; it is not a routine update.
There are no named Wrangler environments in this repository.

Inspect the current deployment and version history without deploying:

```sh
npx wrangler deployments status --name "$instance_worker"
npx wrangler deployments list --name "$instance_worker"
npx wrangler versions list --name "$instance_worker"
instance_version='<version-id-from-deployment-status>'
npx wrangler versions view "$instance_version" --name "$instance_worker"
```

Record the deployment ID/time and its active version IDs and traffic
percentages. Inspect every active version if more than one is listed.
`versions list` is recent upload history; an uploaded or newest version
need not be serving traffic. `deployments list` records deployment history;
`deployments status` identifies the current deployment. Dashboard deployment
details are also useful for comparing bindings and version metadata.

Seshat currently exposes only `{ ok, schemaVersion }` at `/api/health`.
There is no running-commit endpoint or reliable automatic Git-to-version
mapping. An untagged Cloudflare version, local `git rev-parse HEAD`, and
package version `0.0.0` do not prove the source running remotely. Preserve
an operator record linking source commit, build, returned version/deployment
IDs, origin, time and verification results whenever deploying. If that
link is missing, report the source revision as unknown. Automated identity
is tracked by `identify-running-revision` in [TODO.md](../TODO.md).

## Initial setup, updates and secret changes

The repository's [CI workflow](../.github/workflows/ci.yml) validates PRs
and pushes to main. Its checks install dependencies, check queues/docs,
type-check, test and build; they neither upload nor deploy. A green main
run is not evidence of an updated hosted instance. There is no deployment
script or automatic post-deployment verification.

Every deployment, including secret uploads and rollback, requires explicit
owner authorization for that operation. Before provisioning or changing
billable resources, state the cost/provisioning implications and obtain
confirmation. Free-tier-compatible bindings do not prove the target account
is on Free or has spare quota; check its plan and usage before provisioning.
Writing this runbook does not authorize any of these operations.

For a new instance, follow the README's hosted setup at the final HTTPS
origin. That flow uploads `OWNER_ID` and `SETUP_SECRET`, registers a separate
hosted GitHub App, uploads its one-time credential JSON, and installs it.
A localhost App lacks the webhook and subscriptions; changing only its
OAuth callback is insufficient. Finish setup before applying the configured
instance checks below.

For a routine update of an already configured instance:

1. Identify the target and record the current deployment as above. Review
   source/config changes, especially Durable Object bindings, migrations,
   permissions and credentials, and assess rollback compatibility below.
2. Use a clean checkout of the intended commit. Record `git rev-parse HEAD`
   and confirm `git status --short` is empty. Run `bash scripts/setup.sh`
   and `bash scripts/check.sh`; the latter builds the Worker and frontend.
3. Inspect the generated `dist/seshat/wrangler.json`: its Worker name,
   bindings, migrations and asset paths must match the intended instance.
   It must come from this successful build, not an older ignored `dist/`.
   Vite also writes `.wrangler/deploy/config.json`, redirecting a plain
   `wrangler deploy` to that generated configuration. Use the explicit
   generated config below so the artifact selection is visible.
4. With authorization, upload the built application to the confirmed
   account and Worker. Preserve the returned version ID and URL privately:

   ```sh
   npx wrangler deploy --config dist/seshat/wrangler.json --name "$instance_worker"
   ```

5. Re-run deployment status and inspect its active version. Compare with
   the upload result, record the source-to-version link, then perform the
   post-deployment checks. If someone else deployed meanwhile, resolve that
   discrepancy before claiming this source is live.

The explicit name must agree with the generated name; do not use `--name`
to repurpose an artifact for another instance. For changed build layouts,
consult the generated redirect file rather than guessing the config path.
Cloudflare documents this distinction under
[generated Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/#generated-wrangler-configuration).

Do not repeat App registration or re-upload bootstrap secrets for a normal
code update. Existing secrets are retained by a normal deploy; plaintext
dashboard variables are replaced by the build configuration unless
`--keep-vars` is deliberately used. Store the README's owner/App values as
secrets as instructed, and review any dashboard-only variable before an
update. When a secret change is intended and authorized, use the confirmed
account/name and a private file outside the repository, readable only by
its owner:

```sh
npx wrangler secret bulk /path/to/private/app-secrets.json --name "$instance_worker"
# For a single value, Wrangler prompts without placing it in shell history:
npx wrangler secret put GITHUB_CLIENT_SECRET --name "$instance_worker"
```

`secret bulk` deploys all supplied values together (JSON `null` deletes a
secret); `secret put` deploys a new version for each invocation. These update
the deployed Worker's secrets; they do not upload your local application
edits. Do not treat them as
read-only inspection. After either, record the new active deployment and
repeat verification. Keep credential JSON, PEM keys, tokens, cookies and
OAuth URLs out of commits, terminal transcripts and public evidence. Delete
temporary upload files after success and retain required credentials only
in the owner's secure storage. See [Cloudflare secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

Code updates restart Durable Objects and disconnect existing WebSockets
([Cloudflare behavior](https://developers.cloudflare.com/durable-objects/best-practices/websockets/#websocket-disconnection-on-deploy)).
Treat secret deployments as disruptive too. Check that an open overview
reconnects and becomes current. A session ended by expiry, sign-out or an
owner change requires sign-in; ordinary network loss reconnects automatically.

## Verify after each deployment

Use the confirmed origin in a terminal with no browser cookies. These GETs
do not change remote configuration, but health reaches the object and can
initialize or advance its application schema. Review migration compatibility
before issuing them against a newly deployed version.

```sh
curl --silent --show-error --include "$instance_origin/api/health"
curl --silent --show-error --include "$instance_origin/api/overview"
curl --silent --show-error --include "$instance_origin/api/session"
curl --silent --show-error --include "$instance_origin/api/overview/socket"
curl --silent --show-error --include "$instance_origin/setup"
```

For a configured instance, require:

- Health: HTTP 200, JSON `ok: true` and the expected `schemaVersion` from
  the deployed source's [application migrations](../src/object/schema.ts).
  The current source expects version 4; the Wrangler class migration tag
  `v1` is a separate mechanism. Health proves object/schema reachability,
  not successful GitHub synchronization, remaining quota or source identity.
- Anonymous overview, session and socket paths: HTTP 401 and no instance
  data. A plain GET is sufficient to check the socket's authentication gate.
  The static frontend at `/` is public and is not a data-refusal check.
- Setup: HTTP 404 with “Setup is finished” once all App credentials are
  present. A partial App configuration returns 503, and a registration form
  means setup is open. The responses above should have `Cache-Control:
  no-store`; HTML where API JSON is expected suggests wrong routing/assets.

Then verify in the owner's ordinary browser:

1. Complete GitHub sign-in and load the overview and `/repositories`.
   Confirm the expected monitoring choices and that private data is visible
   only in the authenticated session. Do not export the session cookie.
2. In browser network tools, confirm the same-origin
   `/api/overview/socket` upgrades with HTTP 101, receives the snapshot,
   and reconnects following a deployment. Check last successful GitHub sync
   and the Checking/Overdue/Failed state, not just the existence of rows.
3. Check the App's active, TLS-verified webhook URL ends in
   `/api/github/webhook` at this origin and its subscriptions match
   [the manifest](../src/shared/manifest.ts). With authorization to change
   a suitable fixture PR, observe an actual notified change in the existing
   visible overview without reloading, within 60 seconds. Correlate the
   delivery time/status on GitHub with the page update. HTTP 202 means marks
   were accepted; it does not prove a GitHub reread or browser update.
4. Where the release needs a full freshness check, use an authorized fixture
   and a top-level comment (not subscribed) to check catch-up within five
   minutes while visible. With only one overview open, hide it, make another
   such change, then restore visibility and require catch-up within three
   minutes. Hidden pages intentionally do no scheduled GitHub reads.

Record checks actually performed, elapsed times, active version and any
limits on evidence. If fixtures or browser authorization are unavailable,
report GitHub freshness/sign-in as unverified; health alone cannot close
those checks. The [acceptance procedure and evidence](OVERVIEW_ACCEPTANCE.md)
and [sync design](OVERVIEW_SYNC.md) explain the broader scenarios.

## Logs and troubleshooting

Start a short live tail against the confirmed target, reproduce the issue,
then stop with Ctrl-C:

```sh
npx wrangler tail "$instance_worker" --format pretty
```

Tail shows new events while connected, not historical incident logs. Treat
request URLs, console output and exception details as private: they may
contain OAuth parameters or repository information. Share only redacted
time/status/error summaries. The Cloudflare dashboard's metrics and account
usage can help correlate exceptions, request failures and quota exhaustion;
do not assume historical logs or retention have been configured.

| Symptom | Next checks |
| --- | --- |
| Wrong page, version or origin | Recheck account/name, dashboard domains, deployment status and active version; compare the operator's source record. Check generated assets and `run_worker_first` in `wrangler.jsonc` if API paths return HTML. |
| Health fails or schema mismatch | Inspect exceptions and both migration mechanisms. Compare stored schema expectations with the deployed source; do not delete state or blindly roll back. |
| Sign-in refused or unavailable | Confirm numeric `OWNER_ID`, complete App secrets and exact hosted callback origin. Partial credentials close setup and sign-in. Owner changes invalidate old sessions; expiry requires another sign-in. A callback 429 carries `Retry-After`; wait rather than loop. |
| Webhook fails | Check active URL, TLS, event subscriptions and matching webhook secret. Unsigned requests return 401; an App not fully configured returns 503. A ping before credential upload can fail; inspect subsequent real deliveries. |
| Delivery 202 but stale rows | Inspect Failed/Overdue state, GitHub API permissions, installation access, rate-limit errors and Worker exceptions. Acceptance previously found a private-review read failure despite 202 deliveries. Keep a visible page for catch-up; do not assume acknowledgement is freshness. |
| Missing repositories or PRs | Check All repositories on the personal installation, archive/fork defaults, monitoring overrides and organization acceptance plus individual opt-in. Compare GitHub access with `/repositories` before treating missing data as a sync bug. |
| Socket repeatedly disconnects | Correlate deployments, network failures, session expiry and owner changes. Verify authenticated same-origin upgrades and browser errors; persistent reconnect failure is not a successful update. |

Minimal production alerts, thresholds, destinations and log retention have
not been established. `define-instance-monitoring` in [TODO.md](../TODO.md)
tracks that work; this tail/metrics procedure is manual investigation, not
demonstrated monitoring or alert delivery.

## Rollback and data recovery limits

A [Worker rollback](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)
changes the serving version, including its configuration/secrets; it does
not rewind Durable Object data or reverse application SQL migrations.
Cloudflare may block rollback across Durable Object class lifecycle changes.
Separately, Seshat refuses a database schema newer than the code knows
([migration guard](../src/shared/migrations.ts)). Older code can therefore
fail even when Cloudflare accepts the rollback. Check target credentials
too: rollback must not revive revoked or superseded secret values.

Before any authorized rollback, inspect the exact previous version, its
bindings and class migrations, compare its application schema with the
current database, and establish compatibility. Prefer a forward correction
when the older code cannot safely use current state. If compatibility is
unknown, stop and establish a recovery plan rather than experimenting on
the production object. When compatibility is established and the owner has
authorized that rollback, target an explicit version:

```sh
npx wrangler rollback '<compatible-version-id>' --name "$instance_worker"
```

Run in an interactive terminal outside CI and answer Wrangler's message
and confirmation prompts. Non-interactive/CI execution can accept defaults
without a human prompt. Record the new deployment, inspect the active
version and repeat post-deployment checks, including socket
recovery and GitHub freshness. Do not equate command success with recovery.

GitHub repository/PR facts can be reread subject to access and sync behavior;
owner monitoring overrides, installation decisions and sessions are local
instance state and cannot all be reconstructed from GitHub. There is no
demonstrated backup/restore or migration-recovery procedure for this instance.
`prove-instance-data-recovery` in [TODO.md](../TODO.md) tracks a disposable
backup/restore and code-rollback experiment, retention and restore limits.
Do not claim a recovery window or use object/namespace deletion as repair.
Link the demonstrated monitoring and recovery procedures here when those
tasks land. Repeatable deployment automation remains
`standardize-instance-deployment`; this manual runbook does not supply it.

## Command verification boundary

The inspection syntax above was checked against installed Wrangler
4.151.0 using local `--help` for `whoami`, `deployments status`,
`deployments list`, `versions list`, `versions view` and `tail` on
2026-10-26. Deployment, secret and rollback options were also checked via
help/source and the linked Cloudflare documentation. The production build's
generated config was inspected locally. These checks do not establish live
account permissions, a currently active deployment, working log delivery or
a successful production update/restore. Recheck help after upgrading the
locked toolchain; no deployment or secret mutation is part of documenting
this runbook.
