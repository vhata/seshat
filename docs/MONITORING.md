# Instance monitoring

The instance monitor checks HTTP availability, synchronization progress and
an optional manual account-usage sample. Its destination is the invoking
owner's terminal. It creates no scheduled job, notification integration,
Cloudflare resource or persistent log collection. The implementation is
local until the owner authorizes deployment; this document does not assert
that a hosted instance has been updated or checked.

## Run a check

Use the repository's Node.js version or later. Sign in to the intended
instance as its owner, and put the complete session `Cookie` header value
in a private file outside the checkout. The file contains only the raw
header value: no `Cookie:` prefix, JSON, browser cookie export or
`Set-Cookie` attributes. Use just the `__Host-seshat-session` cookie
(`seshat-session` is also accepted for HTTP loopback development), with
its unchanged 43-character base64url token. The file must contain no
control characters, including a trailing newline. Save without a final
newline using a private editor or a protected `printf` workflow; do not
use `echo`. Restrict access to the owner (`chmod 600`). Never paste the
cookie into a command, issue, screenshot or shared terminal log.

```sh
node scripts/monitor-instance.mjs https://INSTANCE \
  --cookie-file /private/path/session-cookie \
  --usage-file /private/path/usage.json
```

The usage file is optional; omitting it reports unknown Cloudflare
capacity. Supply an HTTPS origin without credentials, path, query or
fragment. Plain HTTP is accepted only for loopback development. The
command refuses redirects and limits each request to ten seconds and
64 KiB of JSON response data. Cookie and usage inputs must be private
regular files, without symlinks, at most 4 KiB and 16 KiB respectively.
It prints one JSON line, `{"ok":boolean,"issues":string[]}`, containing
fixed issue codes rather than response bodies, cookies, upstream
exception text or instance URLs. Exit status is `0` when no issue is
found, `1` for an alert (including unknown capacity), and `2` for invalid local
configuration (`config-invalid`). An unavailable or invalid diagnostic
response is an alert, never evidence of healthy synchronization.

Availability codes are `health-unavailable`, `monitoring-auth-required`
(HTTP 401), `monitoring-unavailable` and `monitoring-invalid` (a 200
response with invalid JSON or schema). The state codes below distinguish
synchronization and capacity incidents.

The command requests public `/api/health` and owner-only
`/api/monitoring`. The latter uses the existing owner session gate and
returns aggregate diagnostic state with private, no-store caching. It
contains no repository or installation identifiers, PR content, GitHub
tokens, session material or raw upstream errors. Reading diagnostics does
not report a page visible or request a new sweep. It does not keep a
dormant instance synchronizing.

Owner sessions expire seven days after sign-in and are not extended by
checks. A refused or expired session requires signing in and replacing the
private cookie file. A successful health request cannot establish that
owner authentication or GitHub reads are working.

## Signals and thresholds

The [synchronization scheduler](OVERVIEW_SYNC.md) remains authoritative
for work, retries, visibility and rate limits. The diagnostic response
reports version `1`, its `serverTime`, the continuous visible period's
`activeSince` (or `null`), `sync` status, the first enqueue time of the
oldest pending event, discovery or installation-guard job
(`oldestPendingAt`), the latest exhausted event retry time
(`lastEventFailureAt`), `githubRateLimited`, and
`cloudflareCapacity: "unknown"`. Sync status includes
`lastSuccessfulSweepAt`, `latestAttempt` (or `null`), `intervalMs` and
`slowedByRateLimit`; an attempt has `startedAt`, `result` and an optional
bounded `reason`. All diagnostic timestamps are epoch milliseconds.

| Code | Alert condition | Recovery |
| --- | --- | --- |
| `sync-failed` | The latest stored sweep attempt failed, even while dormant. | A complete successful sweep; starting recovery does not clear failure. |
| `sync-overdue` | After one minute continuously visible, the last successful sweep is older than `max(5 minutes, 2 × intervalMs)`, or no sweep has succeeded. | A complete successful sweep, or visible activity ends. |
| `sync-stalled` | While a page is visible, a running attempt is older than ten minutes. | The attempt finishes, is replaced by a later attempt, or visible activity ends. |
| `background-work-overdue` | The first enqueue time of pending work is older than ten minutes, including while dormant. | The pending work is drained. Coalescing newer events does not reset its age. |
| `event-read-failed` | A repository event read has exhausted its retries. | A complete successful sweep that started after the exhaustion; an older in-flight sweep cannot clear it. |
| `github-budget-low` | The known remaining installation budget is below ten percent of its reported limit and the reset has not passed. | The reported reset passes or newer budget evidence recovers. |
| `cloudflare-capacity-low` | Any supplied quota ratio reaches `0.8`. | A complete fresh sample below the threshold. |
| `cloudflare-capacity-unknown` | Usable fresh account evidence is absent. | A complete fresh sample. |

The overdue rule allows one minute for catch-up after a page becomes
visible. After that grace, old or absent successful-sync evidence alerts;
the grace does not restart the successful-sync age. A ten-minute running
attempt alerts independently while active. Hiding the last page cancels
sweep work and may leave its stored status running, so that status does
not signal a stalled sweep while dormant. Failed sweeps, stalled queued
background work and exhausted event retries remain
actionable while dormant. These are monitoring thresholds, separate from
the page's freshness wording.

The monitor can inspect only deliveries the instance received. It cannot
detect a webhook that GitHub never delivered. A visible sweep supplies the
existing missed-event recovery path; a dormant instance has no guarantee
of discovering undelivered changes.

## Inspect account capacity

The application has no account-wide Cloudflare usage credentials. Inspect
the correct account's Workers, Durable Objects, SQLite and logging usage
in the Cloudflare dashboard. Include other workloads sharing each
allowance. For every dimension below, record `usage / applicable limit`
for the same current quota window. Do not use a Worker-only count as an
account total or invent a zero for unavailable usage.

```json
{
  "observedAt": 1793030400000,
  "workersRequests": 0.12,
  "objectRequests": 0.08,
  "objectDuration": 0.04,
  "rowsRead": 0.03,
  "rowsWritten": 0.06,
  "storage": 0.02,
  "logs": 0
}
```

Replace the example timestamp with the observation time in epoch
milliseconds. Every ratio must be finite and nonnegative; values above
one are valid evidence of an exceeded allowance. All dimensions are
required. An omitted usage-file argument, future-dated sample or more
than fifteen-minute-old sample means capacity is unknown. Malformed JSON,
missing dimensions or invalid numbers are local configuration errors
and exit `2`.
`logs: 0` is appropriate only after verifying no metered log usage for the
account's current allowance. Store the sample privately outside the
checkout; the command emits codes rather than copying its contents.

Published Free-plan reference values checked on 2026-10-26 are
100,000 Worker requests/day, resetting at midnight UTC
([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)).
For SQLite-backed Durable Objects, the references list 100,000 object
requests/day, 13,000 GB-s duration/day, five million rows read/day,
100,000 rows written/day and 5 GB stored; daily free limits reset at
00:00 UTC, and exceeding a dimension blocks that operation
([Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)).
These are reference values, not verified account settings. Check the
actual account plan, current allowances and applicable window before
calculating ratios; update the procedure when Cloudflare changes them.
The monitor's own requests also consume request and object allowances.

A manual sample provides a brief observation, not continuous quota
monitoring. The diagnostic route always reports Cloudflare capacity as
unknown; the CLI's explicit usage file supplies the separate evidence.
Reaching a threshold calls for investigating usage and reducing avoidable
load, not automatically buying a plan or changing account limits.

## Privacy and retention

Keep only fixed terminal summaries by default. Neither the CLI nor this
procedure persists application logs. If the owner chooses to retain
sanitized terminal output for investigation, keep it private for at most
three days and delete it afterwards. Cookie and usage files are inputs,
not logs; remove the cookie when no longer needed or when the session is
revoked. Do not collect request/response bodies, headers, sign-in callback
URLs, repository names, PR titles or upstream error messages.

Do not generically enable Workers Logs as a monitoring setup step.
Cloudflare's invocation logs include fetch URLs, which can expose OAuth
callback query parameters. Any future logging setup must explicitly
exclude invocation logs and approve a small sanitized event allowlist
before activation
([Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)).

As of the reference check above, Workers Logs lists Free retention of
three days with 200,000 events/day, and Paid retention of seven days.
Cloudflare announces a different Observability model from 2026-12-01,
including shared account allowances and default seven-day retention
([Workers Logs pricing](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#pricing),
[Observability pricing](https://developers.cloudflare.com/observability/pricing/)).
Recheck the current account's settings and pricing before enabling or
relying on log storage. Published retention is not evidence that this
instance collects logs, nor a retention guarantee for owner-held output.

## Investigate and verify

1. Run the terminal check and keep its exit status and issue codes. For a
   local configuration error, fix the origin or private input format
   before drawing conclusions about the instance.
2. For availability failure, inspect the intended account and Worker's
   deployment status and metrics in the dashboard. Check origin spelling
   and current network reachability. For owner authentication failure,
   sign in again and replace the private cookie file.
3. For failed or overdue sync, open the owner's overview and inspect its
   sync status. Check GitHub App installation permissions and current
   GitHub service availability. A visible owner page triggers the normal
   catch-up path; use its retry control if appropriate. Verify a complete
   successful sweep and rerun the monitor. A healthy HTTP response alone
   does not close this incident.
4. For stalled events or exhausted retries, inspect the App's delivery
   status privately and the owner's sync state, then verify recovery
   through a successful sweep started after the failure. Do not copy
   private webhook payloads or OAuth requests into an incident record.
5. For low GitHub budget, check the reported reset and allow the normal
   rate-limit slowdown. Avoid repeated manual retries that consume the
   remaining allowance. For Cloudflare capacity, inspect the account
   usage and refresh the sample after corrective action.
6. Verify failure reporting with the repository's local monitoring tests:
   run
   `npx vitest run --project cli src/cli/monitor-instance.test.ts`, then
   [the combined validation gates](QUALITY.md#gates).
   Use synthetic cookies, diagnostic state and usage samples. Exercise
   healthy, failed-sweep, overdue, dormant, pending-event, exhausted-retry,
   quota, expired-session, timeout and redirect cases. Assert fixed codes,
   exit statuses and recovery, and that secret markers or private fixture
   text never appear in output. Never induce these failures by corrupting
   production state, exhausting real quotas or revoking live credentials.

These tests use mocked `fetch` responses to verify local issue codes and
exit decisions, and a subprocess checks terminal output for invalid local
configuration. They exercise no real HTTP server or network delivery.
No notification destination has been configured or sent a test message.
The command must be invoked to observe a failure; no unattended detection
or delivery guarantee is implied.

## Optional future activation

Remote notification delivery needs the owner's explicit authorization and
a known destination. First agree on that destination, who can read it,
the sanitized payload, cadence and recovery notices. If the chosen service
creates or changes billable resources, disclose the cost and what will be
provisioned, then obtain confirmation before setup. Deployment and any
schedule also need the authorization required by
[the repository workflow](../AGENTS.md#docket).

After authorization, verify delivery using a controlled synthetic failure
and recovery, confirm both messages at the destination, and record the
observed time, fixed codes and delivery result without credentials or
private payloads. Verify expired monitor credentials and the scheduler's
own failure path as well. A passing local test or a queued message does
not establish successful remote delivery. Until those checks are observed,
describe remote alerts and continuous quota coverage as unverified.
