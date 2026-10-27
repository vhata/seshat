# Review backlog

Only work promoted from whole-codebase reviews belongs here. Every entry is ready for separate work and carries a `Findings:` line naming the raw review findings it covers; each finding maps to at most one entry. Claiming and resolving follow [docket/TODO_GUIDE.md](../docket/TODO_GUIDE.md); promotion follows [docket/CODE_REVIEW_GUIDE.md](../docket/CODE_REVIEW_GUIDE.md).

## P0 Critical

## P1 High

## P2 Normal

## P3 Low

## Unprioritized

- [GITHUB] `serialize-installation-guard-reconciliation` — **Preserve newer installation acceptance and data when an older guard finishes.** Reconcile only a current authoritative report while retaining real uninstall detection.
  - Source: [full review](2026-10-27-1626-full.md), 2026-10-27
  - Findings: `stale-installation-guard-removes-newer-installation`
  - Starting point: `src/object/instance.ts` (`checkInstallations`). An
    older list awaiting stranger uninstall can erase a concurrently added,
    accepted organization and its discovered repositories. Serialize or
    generation-protect reconciliation; test obsolete lists finishing after
    new acceptance, plus genuine uninstall and concurrent refusal.

- [GITHUB] `scope-reread-invalidation-to-affected-prs` — **Let deep PR rereads finish while unrelated webhook traffic continues.** Preserve unaffected continuation progress without allowing stale results to replace newer observations.
  - Source: [full review](2026-10-27-1626-full.md), 2026-10-27
  - Findings: `unrelated-deliveries-starve-deep-rereads`
  - Starting point: `src/object/overview-sync.ts` (`receive`,
    `invalidateReads`, `normalizeReread`). Every delivery invalidates all
    read progress for its installation. A 42-page PR reread restarts at
    every unrelated event and remains empty after 92 simulated seconds.
    Retain per-invocation request bounds, stale-result protection, orphan
    cleanup and fairness; test continued unrelated traffic through success.

- [TOOLING] `use-full-survey-symbolic-refs` — **Keep survey branch observations stable when tags share branch names.** Read full symbolic refs and remove exact namespaces instead of relying on Git's ambiguity-dependent abbreviations.
  - Source: [full review](2026-10-27-1626-full.md), 2026-10-27
  - Findings: `survey-ref-abbreviation-ambiguity`
  - Starting point: `src/cli/survey.ts` (`signals`) and the manual commands
    in `skills/survey-projects/SKILL.md`. Cover branch/tag `main`, default
    `trunk` with tag `origin/trunk`, and detached HEAD without remote calls.
