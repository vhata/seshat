# Review backlog

Only work promoted from whole-codebase reviews belongs here. Every entry is ready for separate work and carries a `Findings:` line naming the raw review findings it covers; each finding maps to at most one entry. Claiming and resolving follow [docket/TODO_GUIDE.md](../docket/TODO_GUIDE.md); promotion follows [docket/CODE_REVIEW_GUIDE.md](../docket/CODE_REVIEW_GUIDE.md).

## P0 Critical

## P1 High

## P2 Normal

## P3 Low

## Unprioritized

- [GITHUB] `repair-overview-reread-lifecycle` — **Discard orphan reread progress so later events continue to sync.** Removing an installation during a continued read can otherwise block all later event reads and repeatedly rearm due alarms.
  - Source: [full review](2026-10-24-0255-full.md), 2026-10-24
  - Findings: `orphan-reread-continuation-blocks-events`
  - Starting point: `OverviewSync.alarm` in `src/object/overview-sync.ts`; normalize continuation identity and surviving marks before job selection.
  - Verify: yield a continued read, remove its installation, deliver a mark for a surviving installation and confirm it runs; restart the object and confirm no orphan alarm loop remains.

- [GITHUB] `protect-overview-read-ordering` — **Prevent older continued reads from replacing newer observed GitHub changes.** A cached sweep can currently overwrite an event reread and report success with no repair mark left.
  - Source: [full review](2026-10-24-0255-full.md), 2026-10-24
  - Findings: `sweep-continuation-regresses-event-state`
  - Starting point: `OverviewSync.sweep`, `applyPr` and `applyRepository` in `src/object/overview-sync.ts`, with the reader's replayed response cache.
  - Verify: interleave new-head, close/open and repository-change deliveries with a partial sweep or repository reread; resuming cached work must preserve newer facts and authoritative membership, or schedule repair within the notified-change bound.

- [GITHUB] `bind-sessions-to-configured-owner` — **Invalidate sessions when the configured numeric owner changes or becomes invalid.** Session records currently carry only a token hash and lifetime, so an old owner retains access until expiry.
  - Source: [full review](2026-10-24-0255-full.md), 2026-10-24
  - Findings: `sessions-survive-owner-change`
  - Starting point: `findSession` in `src/worker/auth.ts`, session schema/storage and the socket authorization checks in `src/object/instance.ts`.
  - Verify: sign in as A, change OWNER_ID to B or remove it, and confirm A's HTTP requests and existing socket stop receiving instance data; B's valid session still works. Cover upgrade handling for existing unbound sessions.

- [GITHUB] `reset-monitoring-overrides-on-transfer` — **Reset durable monitoring choices when repository ownership changes.** Clearing only the repository record lets discovery restore an old opt-in in a different organization.
  - Source: [full review](2026-10-24-0255-full.md), 2026-10-24
  - Findings: `transfers-preserve-durable-monitor-override`
  - Starting point: transfer handling in `src/object/overview-sync.ts`, `RepositoryDiscoveryStore` and override restoration in `src/object/repository-selection.ts`.
  - Verify: opt into a repository, transfer it between accepted organizations and refresh discovery; require a new opt-in, including when the transfer delivery is missed. Preserve overrides across same-owner disappearance/reappearance.

- [TOOLING] `honor-remote-exclusions-for-nested-each` — **Apply remote exclusions before dispatching commands below an excluded Git root.** An indexed ordinary subdirectory currently bypasses the enclosing repository's remote exclusion.
  - Source: [full review](2026-10-24-0255-full.md), 2026-10-24
  - Findings: `each-nested-directory-bypasses-remote-exclusion`
  - Starting point: the noncheckout early return in `discoverDirectories` in `src/cli/survey.ts` and target preflight in `src/cli/commands.ts`.
  - Verify: configure a remote exclusion and select an indexed subdirectory in that repository; `each` must invoke nothing there and disclose no excluded names. Keep ordinary nonexcluded directory targets usable.

- [PRODUCT] `recover-overview-after-session-expiry` — **Return the overview to sign-in when its session ends.** Expired or revoked sessions currently retry permanently as a transport outage until the owner reloads or signs out.
  - Source: [full review](2026-10-24-0255-full.md), 2026-10-24
  - Findings: `expired-session-reconnect-loop`
  - Starting point: `SocketLike` and the browser adapter in `src/frontend/overview-client.ts`, plus session state in `src/frontend/App.tsx`.
  - Verify: expire or revoke a session while the overview is open, confirm it explains that sign-in is required and stops unsuccessful retries, and retain automatic recovery after an ordinary network outage.
