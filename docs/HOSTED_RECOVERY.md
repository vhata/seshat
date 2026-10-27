# Disposable hosted recovery experiment

This is an operator procedure for a dedicated synthetic fixture. It prepares
reviewable artifacts without deploying them. The owner has confirmed Workers
Free. A hosted run creates one temporary Worker and its new SQLite Durable
Object namespace and consumes the account's free quotas. It adds no paid plan,
custom domain, GitHub App or integration. Deployment, destructive fixture
mutations, rollback and cleanup still need the owner's explicit authorization
under [AGENTS.md](../AGENTS.md#docket).

The [instance recovery notes](INSTANCE_RECOVERY.md) describe retained state,
credentials, the passing offline proof and the remaining production limits.

## Prepare and validate without deploying

Choose a previously unused `seshat-recovery-proof-<suffix>` Worker name.
Read-only account inspection must establish its exact workers.dev subdomain
and confirm that the Worker name is absent. Then prepare:

```sh
node scripts/prepare-hosted-recovery.mjs \
  --account ACCOUNT_ID \
  --name seshat-recovery-proof-UNIQUE_SUFFIX \
  --subdomain ACCOUNT_SUBDOMAIN
node scripts/check-hosted-recovery.mjs
```

Use lowercase letters, digits and hyphens in the suffix. Preparation writes
private artifacts beneath `.context/hosted-recovery/run-*`: current, broken
and synthetic-future-migration bundles, a cleanup tombstone, four exact-account
Wrangler configs, manifest hashes, and the fixture secret. No production
state or credentials are read. The source commit is recorded; regenerate after source changes.
Do not print or commit the secret files.

The three runtime configs bind only the new `RecoveryFixture` class as
`RECOVERY`. They have the same Worker name, class and platform migration tag;
the future variant changes only the application's SQL migration list. The
cleanup config removes the class/binding and appends a deletion migration.
Preview URLs and observability logs are disabled. `RECOVERY_MAINTENANCE`
and the bearer secret are Worker bindings, outside restored database state.
The fixture permanently refuses ordinary application routes and disables
production alarms and sockets. These controls are for synthetic state only;
they are not an implemented production maintenance mechanism.

The client checks frozen bundle/config hashes and the exact prepared HTTPS
origin before sending the secret. It verifies the observed Worker identity,
source, mode and object ID, and saves private responses to unique files.
Native PITR is not simulated by the local safeguards check.

## Authorized hosted run

Only execute the following after the owner approves provisioning and the
bounded experiment, including eventual deletion of these exact resources.
In a shell, set `recovery_run` to the generated directory and `recovery_url`
to its frozen workers.dev origin. Check the manifest and config again before
any upload. Record the starting namespace inventory privately.

1. Deploy the current bundle using its exact config and secret file:

   ```sh
   WRANGLER_SEND_METRICS=false node_modules/.bin/wrangler deploy \
     --config "$recovery_run/wrangler.current.json" \
     --secrets-file "$recovery_run/secrets.json" \
     --durable-objects-code-update-mode immediate
   ```

   Read back the deployed Worker's settings and namespace inventory. Confirm
   its sole Durable Object binding targets the newly created SQLite
   `RecoveryFixture` namespace; record its namespace ID, class and Worker.
   Stop if any binding points to an existing production namespace.

2. Use the client for each control operation:

   ```sh
   node scripts/hosted-recovery-control.mjs \
     --directory "$recovery_run" --url "$recovery_url" --op status
   ```

   Inspect the saved status response and save its published version and object
   IDs. After every upload/rollback, poll status until that same object reports
   the intended mode and exact version ID in consecutive responses. Bound the
   wait and stop if it fails. Wrangler 4.151.0 defaults to deferred object code
   updates with a 300-second maximum delay. This run also observed stale object
   code after requesting immediate updates; the flag and a successful CLI
   response do not prove which code the object is executing.
   Run `seed` before `health` on a new fixture, then `inspect`, `health` and
   `bookmark`. Save the exact baseline rows/schema-version and checkpoint
   bookmark response filenames. `seed` refuses an already initialized object.

3. Deploy `wrangler.broken.json` with the same secret file. Run `damage`,
   confirm `health` returns HTTP 503, then roll back to the recorded current
   version:

   ```sh
   WRANGLER_SEND_METRICS=false node_modules/.bin/wrangler rollback \
     CURRENT_VERSION_ID --config "$recovery_run/wrangler.current.json" \
     --durable-objects-code-update-mode immediate
   ```

   Confirm `status` reports the recorded published version, `health` succeeds
   and `inspect` still shows damaged settings, revoked sessions and missing
   cached PRs. The old data must not reappear merely from code rollback.

4. Deploy `wrangler.migration.json` with the same secret file; run `health`
   to apply the synthetic future SQL migration. Save `inspect` and a new
   `bookmark` for the pre-restore state. Roll back to the saved current
   published version. Confirm its real schema guard returns HTTP 500 while
   `inspect` still works and reports the future schema.

5. Schedule native restoration to the original checkpoint:

   ```sh
   node scripts/hosted-recovery-control.mjs \
     --directory "$recovery_run" --url "$recovery_url" \
     --op prepare-restore --bookmark-file CHECKPOINT_RESPONSE_FILE
   ```

   The client saves the returned undo bookmark privately before reporting
   success. Preserve that filename, then use it for the separate restart:

   ```sh
   node scripts/hosted-recovery-control.mjs \
     --directory "$recovery_run" --url "$recovery_url" \
     --op restart --undo-file PREPARE_RESPONSE_FILE
   ```

   Restart forwards the saved successful native prepare receipt, including
   target, object ID and undo bookmark. The server validates it under the
   fixture bearer token even if the runtime discarded its in-memory phase.
   It aborts without scheduling another restore.

   `ctx.abort()` may sever the restart response; that is not a passing check.
   Native scheduling also permits incidental eviction to trigger the restore
   before the explicit restart. Inspect the next session instead of assuming
   either success or failure. If the prepare response/undo bookmark is lost,
   stop and investigate; do not blindly schedule another restore.

6. Compare `inspect` with every original application row and schema-version;
   verify current-code health. The revoked session row should be restored.
   Run `invalidate-sessions` and verify all session rows are gone, including
   after another deployment/restart of compatible code. Keep normal traffic
   closed throughout. The earlier local proof exercises old-cookie refusal
   and fresh owner access; this hosted fixture does not expose those routes.

7. Demonstrate native undo by using `prepare-restore --undo-file
   PREPARE_RESPONSE_FILE` with the first restoration's saved undo response.
   Preserve the newly returned prepare response and restart with that new
   file. Use the migration bundle when checking the newer schema's health,
   and compare the original pre-restore rows exactly. Record observed timings,
   published versions, object/namespace
   IDs and sanitized results. Do not infer a hosted recovery bound from the
   local proof or claim the full advertised retention window was tested.

8. After preserving evidence, check the recorded fixture namespace ID against
   the current Worker binding and saved starting inventory. Deploy the frozen
   tombstone to delete only `RecoveryFixture` through a new platform migration:

   ```sh
   WRANGLER_SEND_METRICS=false node_modules/.bin/wrangler deploy \
     --config "$recovery_run/wrangler.cleanup.json" \
     --durable-objects-code-update-mode immediate
   ```

   This bundle exports no class and has no Durable Object binding. Its new
   migration deletes only `RecoveryFixture`; its HTTP handler returns 410.
   Verify the recorded namespace has gone, then delete the exact temporary
   Worker:

   ```sh
   WRANGLER_SEND_METRICS=false node_modules/.bin/wrangler delete \
     --config "$recovery_run/wrangler.cleanup.json"
   ```

   Recheck the namespace/Worker inventory and the production instance's health.
   Never use a wildcard namespace cleanup or delete the production class.

The native run proves the disposable object's SQL PITR and actual published
code rollback. Live GitHub reconciliation, production alarms/WebSockets,
credential recovery and production maintenance remain outside that proof.

## Recorded hosted result

The authorized disposable experiment passed on 2026-10-26 on the
owner-confirmed Workers Free account. The fixture bundles were frozen at
source `6907d53`; the restart-receipt repair used source `c626e91`. Native
evidence is scoped to those immutable builds. Repository checks cover the
integrated checkout separately.

| Check | Observed result |
| --- | --- |
| Target isolation | One new SQLite namespace bound only to the temporary Worker; all three existing namespace IDs preserved. |
| Refusal and maintenance | Anonymous controls returned 401; ordinary application routes remained 503 throughout the fixture run. |
| Published code rollback | Broken code returned 503; the original published version returned healthy schema 4 after activation, while damaged choices and revoked sessions remained. |
| Schema compatibility | The synthetic migration produced schema 5. The verified older published object version refused it with 500. |
| Native PITR | Restored all seven application tables exactly to the original schema-4 checkpoint, including monitoring choices, accepted/pending organizations, refusal tombstone, PR and session rows. |
| Session invalidation | The revoked session row reappeared after restore. Deleting restored sessions survived an actual object abort/restart. |
| Native undo | The first restore's returned undo bookmark restored the exact pre-restore schema-5 rows; compatible migration code returned healthy schema 5. |
| Receipt after JavaScript state loss | A saved successful native receipt acknowledged restart after status reported idle and the volatile phase had disappeared; no second scheduling call was made for that restart. |
| Cleanup | A scoped class-deletion migration removed only the fixture namespace; tombstone returned 410, then the temporary Worker was deleted. Final Worker/namespace inventories exactly matched their starting ID sets. |
| Production check | Health returned 200 with identical schema, build and published version before and after the experiment. |

The run found two practical limits. A successful rollback command preceded
actual object code activation, including when immediate updates were
requested. Every successful phase was checked against its observed object
version and schema; stale transition samples were retained separately.
The initial restart control also lost its volatile acknowledgement. The
saved native undo receipt survived outside the object, and deploying the
reviewed repair triggered the already scheduled restore. Existing intent was
resumed without blindly scheduling it again. A later native undo exercised
the repaired acknowledgement after another observed loss of JavaScript state.

The successful undo was verified about 47 seconds after its prepare response,
including an intentional 36-second idle gap before restart. This single
workflow timing establishes no general recovery bound. Only fresh bookmarks
were exercised; the advertised 30-day window was not tested end to end.

Private evidence is retained under `.context/hosted-recovery/run-OEaZ0b` and
`.context/hosted-recovery/run-GAGeZo`. It includes frozen bundle/config hashes,
API inventories, published/object identity, raw synthetic row snapshots,
native prepare/undo receipts, restart outcomes and an indexed assertion record.
The undo input/receipt linkage is explicitly recorded as coordinator invocation
evidence; the original response format did not echo its input bookmark.
Deployed fixture tokens were removed locally after cloud cleanup. No production
credentials or database were copied into the experiment.

Live GitHub reconciliation, real OAuth sign-in, active alarms/WebSockets,
full-window retention, account-loss recovery and production maintenance were
outside the hosted fixture. The offline proof separately verifies old-cookie
refusal and fresh synthetic owner access after session invalidation.
