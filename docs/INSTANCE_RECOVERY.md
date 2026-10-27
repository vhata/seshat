# Instance recovery proof

Worker code and Durable Object data recover separately. This document records
an offline proof, the state that must survive recovery, and the hosted checks
still required before claiming that a deployed instance can be restored.

## Recovery mechanisms and limits

Cloudflare's [SQLite Durable Object storage API][pitr] documents point-in-time
recovery (PITR) of the complete SQL and key-value database over the past 30 days.
It does not document a different Free-plan retention period. This is a bounded
recovery window, not an off-account backup or protection against losing access
to the account. A saved bookmark does not extend retention.

- `getCurrentBookmark()` identifies the current database position.
- `getBookmarkForTime(date)` finds a position for a timestamp; prefer an exact
  saved bookmark when a known checkpoint matters.
- `onNextSessionRestoreBookmark(bookmark)` schedules restoration for the next
  object restart and returns a bookmark for undoing that restoration.
  `ctx.abort()` can trigger that restart; its exception/lost response is not
  proof that restoration completed. Verify state from a subsequent session.
- PITR is unavailable in the local runtime because it has no durable change
  log. Copying local persistence files is a separate recovery mechanism.

[Worker rollback][rollback] switches application code without reverting bound
storage. The rollback target must be among the latest 100 published versions;
Durable Object class lifecycle migrations can prevent rollback. Those platform
migrations (`wrangler.jsonc`) differ from Seshat's application SQL migrations
(`src/object/schema.ts`). Seshat refuses a stored schema newer than its code
knows, even if an additive SQL change appears compatible. Never lower
`schema_version` to silence that guard. Restore a compatible checkpoint or
roll forward with reviewed code.

Checked on 2026-10-26 with Wrangler 4.151.0: existing OAuth authentication
allowed account identification, but a read-only subscriptions request returned
HTTP 403, Cloudflare error 10000. The owner subsequently confirmed that this
account uses Workers Free. That confirmation establishes the plan for this
experiment; it was not verified through the billing API. Account identifiers
and billing payloads are intentionally omitted here. An authorized operator
can inspect the dashboard or use the [subscriptions API][subscriptions] with
Billing Read for a later plan check. No new credential or subscription was
created for this check.

Wrangler 4.151.0 has no Durable Object restore/export command. D1 time-travel
commands do not operate on this database. [Data Studio][studio] can query live
SQL-backed objects, but is not a demonstrated PITR control or backup procedure.
The deployed Seshat entrypoint exposes no PITR or maintenance RPC. The hosted
procedure below needs a separately reviewed control implementation and
explicit deployment authorization before it can run.

## What recovery must retain

| State | Recovery treatment |
| --- | --- |
| `settings`: `repository-monitoring:<id>` | Owner choice; retain numeric owner identity and explicit on/off overrides, including choices for temporarily missing repositories. |
| `installations.status` | Retain accepted/pending organization decisions; discovery must not silently accept an organization. |
| `settings`: `installation-refused:<id>` | Owner refusal; retain tombstones. A database restore cannot undo a GitHub-side uninstall. |
| Repository and PR records | Reconstructible GitHub facts, including private data. Restore as stale evidence, then reconcile with current GitHub access. |
| Discovery/permission caches and sync progress | Derived state; check freshness, visibility and scheduler/alarm behavior after recovery. Do not present an old successful sweep as current verification. |
| `schema_version` and SQL schema | Recover together with all rows; select compatible application code. |
| `sessions` | Cookie hashes, expiry and owner identity. A restore can resurrect a signed-out cookie. Invalidate all restored sessions before reopening traffic and require sign-in. |
| In-memory state and WebSockets | Recreated after restart; disconnect clients and recheck authorization. Callback rate-limit counters and installation tokens are volatile. |
| Worker secrets/configuration | Outside the object database: owner ID, App identity, client secret, private key, webhook secret and setup secret. Preserve separately through the owner's credential store. |

The [secret API][secrets] cannot retrieve existing secret values. Do not put
credentials, raw cookies, real database dumps, or private repository names in
commits, PRs or public logs. App/user tokens are not persisted by Seshat;
restoring the database does not recreate external credentials, GitHub App
installations, or access revoked on GitHub. Recheck the configured numeric owner
and App identity before using recovered settings.

## Repeatable offline experiment

From a checkout with `bash scripts/setup.sh` completed, run:

```sh
node scripts/acceptance-recovery.mjs
```

The script bundles the actual Worker, InstanceObject, migrations and storage
classes. All administrative controls exist only in generated local bundles and
are reached through an in-process service binding. It reads no `.dev.vars`,
uses only synthetic identities, refuses outbound Worker requests, disables
Cloudflare metadata fetching/telemetry, and never invokes Wrangler or deploys.

Each run creates a new private directory beneath `.context/recovery/run-*`.
The script accepts no target path, so it cannot overwrite an existing local or
hosted instance. It stops the runtime before copying the entire persistence
directory, including SQLite sidecars, and keeps checkpoint, working, restored
and pre-restore copies separately. Do not copy a running database's main SQLite
file alone. Evidence stays ignored; directory/file permissions default to
0700/0600 through a private process umask. Retain or remove these synthetic run
directories according to local needs; the script does not delete prior runs.

The bounded scenario:

1. Initialize the real schema and seed explicit monitoring on/off choices,
   accepted and pending organizations, a refusal tombstone, a repository/PR,
   sync status and an owner session. Check authenticated access and anonymous
   refusal, stop the runtime, then capture its persistence directory.
2. Load a synthetic Worker code regression that returns HTTP 503; damage owner
   settings and cached facts and revoke the original session. Load the original
   application bundle against the same storage. Health recovers, but the data
   damage and session revocation remain: code rollback did not restore data.
3. Load the application with a synthetic next SQL migration that adds a column.
   Reload the original code without touching storage. Its real schema guard
   returns HTTP 500 for the newer schema.
4. Stop the runtime and retain its pre-restore state for undo. Copy the original
   checkpoint to a fresh directory and boot compatible code. Compare every
   application table and row against the baseline, and verify schema health.
5. Confirm the revoked session row reappeared in the restored data. Before any
   authenticated HTTP request, delete all sessions through the test-only
   control. Verify the old cookie and anonymous request are refused, including
   after another runtime restart. Create a fresh synthetic owner session and
   check that the recovered overview contains its PR.
6. Boot the preserved pre-restore copy with matching newer code and verify that
   it still contains the newer schema and damaged data. Assert zero outbound
   requests over the entire experiment.

On 2026-10-26 this passed with application schema 4 on source `93aa6a4` plus
this proof harness. The synthetic migration advanced to schema 5; the exact
schema-version and exact table-row comparisons succeeded after restore. `report.json` records
source revision, named assertions and outbound count; `bundles.json` records
bundle SHA-256 hashes, and `baseline.json` records synthetic application rows.
A failed run has no `result: passed` marker and exits nonzero.

This demonstrates local file backup/restore and code replacement in workerd.
It does not demonstrate Cloudflare PITR, its retention, published-version
rollback, credential recovery, browser reconnection, live GitHub reconciliation,
or recovery of an actual production database. The local fixture has no active
sweep/alarm or WebSocket; their recovery remains a hosted acceptance gate.
The proof is separate from the ordinary gate and makes no CI/hook changes.

## Hosted acceptance procedure awaiting authorization

The original `prove-instance-data-recovery` entry stays open until a disposable
hosted experiment establishes the missing evidence. The owner has confirmed
Workers Free; recheck the target account and plan before provisioning.
Prepare and review a temporary harness before requesting deployment approval:

1. Confirm the exact account, billing plan, new Worker name and SQLite class
   namespace. Use a dedicated disposable Worker such as
   `seshat-recovery-YYYYMMDD`; never bind it to the production namespace or copy
   production state/secrets. Provisioning is metered and may be billable under
   the account's plan, so describe the resources and obtain cost/provisioning
   confirmation. Deployment and destructive experiments also need authorization
   under [AGENTS.md](../AGENTS.md#docket) and the queue entry.
2. Keep the maintenance gate outside restored object data. Gate HTTP, socket,
   webhook and alarm activity while restoring. Use a private control binding
   with exact account/Worker/namespace/object identity checks; never expose an
   anonymous SQL or restore route. Store control credentials and proof artifacts
   privately. Review that restoration cannot reopen traffic or restore an old
   control credential.
3. Seed only the synthetic choices/facts from the local scenario. Save source
   commit, bundle hash, published version ID, namespace/object ID, schema version,
   canonical table data and `getCurrentBookmark()` privately. Exercise an active
   scheduler and owner WebSocket as additional checks.
4. Publish a bounded code regression, mutate only the disposable state and
   revoke a session. Roll back to the saved published version with explicit
   account/Worker targeting. Verify code identity/HTTP health and that data
   damage remains. Separately apply the synthetic next SQL migration and verify
   the older code refuses it; do not change the platform class migration.
5. Close traffic; save a pre-restore bookmark, current version and state.
   Schedule the checkpoint with `onNextSessionRestoreBookmark()`, save its
   returned undo bookmark outside the object, then restart. If the response is
   lost, inspect the next session and existing proof before retrying; do not
   assume an RPC exception means failure or success.
6. Under maintenance, compare all recovered rows/schema with the checkpoint,
   invalidate every restored session, verify the revoked cookie is refused,
   clear/reconcile stale sync progress as needed and rearm alarms deliberately.
   Verify accepted/refused organizations and monitoring overrides, anonymous
   refusal, new owner sign-in, WebSocket reconnection and current GitHub
   synchronization before making any production-readiness claim.
7. Demonstrate undo using the saved pre-restore bookmark with compatible code,
   verify its exact state and retain sanitized results, version IDs and timing.
   Keep recovery latency and data-loss bounds empirical; the local run supplies
   neither hosted bound. Delete only the authorized disposable resources after
   evidence is secured, using an explicit namespace-scoped cleanup plan.

Any production restore needs a separately authorized maintenance window,
reviewed controls and a verified credential/reconciliation procedure. Do not
substitute this proposed procedure for an implemented or executed restore.

[pitr]: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api
[rollback]: https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/
[subscriptions]: https://developers.cloudflare.com/api/resources/accounts/subresources/subscriptions/methods/get/
[studio]: https://developers.cloudflare.com/durable-objects/observability/data-studio/
[secrets]: https://developers.cloudflare.com/workers/configuration/secrets/
