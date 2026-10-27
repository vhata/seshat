# Instance recovery proof

Worker code and Durable Object data recover separately. This document records
offline and disposable hosted proofs, the state that must survive recovery,
and the limits still to address before restoring a production instance.

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
The deployed Seshat entrypoint exposes no PITR or maintenance RPC. The
dedicated synthetic fixture and its
[hosted procedure](HOSTED_RECOVERY.md) demonstrate the native experiment on
disposable state. Production maintenance controls remain unimplemented, and
future deployments/restores still need explicit authorization.

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

## Hosted proof and production limits

The authorized [hosted experiment](HOSTED_RECOVERY.md#recorded-hosted-result)
passed on the owner-confirmed Workers Free account. It demonstrated native
PITR, published-version rollback, schema compatibility checks, session
invalidation across restart and native undo using synthetic state. Its
Worker and SQLite namespace were deleted after verification. This completes
the disposable proof requested by `prove-instance-data-recovery`.

A production restore still needs its own authorized maintenance window and
reviewed controls. The synthetic fixture permanently closes application
routes and disables alarms/sockets; it supplies no production maintenance RPC.
Before applying recovery to production:

- Keep HTTP, socket, webhook and alarm activity closed through a gate outside
  restored object data. Verify the exact account, Worker, namespace and object,
  and protect bookmarks/credentials outside the restored database.
- Preserve the native undo receipt before restarting. A lost response is an
  uncertain outcome, and JavaScript state may disappear while the native
  restore remains scheduled. Reconnect and inspect actual state; do not
  blindly schedule the same operation again.
- Use compatible application code and check its actual executing object
  version. CLI deployment success and an immediate-update request did not
  ensure immediate object code activation in this experiment.
- Compare recovered data/schema, invalidate every restored session and verify
  old-cookie refusal before reopening traffic. Require owner sign-in and
  verify current GitHub access, organizations, monitoring choices and freshness.
- Reconcile stale sync/monitoring progress and deliberately rearm alarms;
  verify WebSocket reconnection and live GitHub synchronization. These active
  runtime checks were outside the disposable fixture.

Only fresh checkpoints were exercised. Cloudflare documents 30-day PITR;
this experiment establishes neither full-window retention nor a production
recovery-time/data-loss guarantee. Native PITR is not an off-account backup,
and saved bookmarks do not protect against namespace deletion or loss of
account access. No production database, GitHub App or credential was restored.

[pitr]: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api
[rollback]: https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/
[subscriptions]: https://developers.cloudflare.com/api/resources/accounts/subresources/subscriptions/methods/get/
[studio]: https://developers.cloudflare.com/durable-objects/observability/data-studio/
[secrets]: https://developers.cloudflare.com/workers/configuration/secrets/
