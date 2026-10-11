# Deferred work

Ordinary follow-ups and bugs found during other work live here. Whole-codebase review findings promoted for separate work live in [review/BACKLOG.md](review/BACKLOG.md). Follow [docket/TODO_GUIDE.md](docket/TODO_GUIDE.md) before adding, claiming, moving or resolving an entry. Entries in **Ready for separate work** are unblocked and available now; anything with an unresolved `Depends on:` belongs in an earlier stage.

## Needs triage

### P0 Critical

### P1 High

- [GITHUB] `choose-github-integration` — **Choose GitHub authentication, credential access scope and permissions.** Enforce the single-owner boundary and plan credential lifecycle, forks and organization access; which repositories are monitored is decided in `define-minimal-deliverable`.
  - Source: owner project brief, [docs/BRIEF.md](docs/BRIEF.md), 2026-10-11
  - Depends on: `define-minimal-deliverable`
  - Related: `choose-change-detection`, `define-public-view`
  - Starting point: compare a GitHub App with OAuth against the permissions the deliverable's PR and project signals need; the choice constrains which webhooks are available.

- [GITHUB] `choose-change-detection` — **Choose change detection and missed-event reconciliation.** Evaluate webhooks versus polling and make sync freshness visible.
  - Source: owner project brief, [docs/BRIEF.md](docs/BRIEF.md), 2026-10-11
  - Depends on: `choose-github-integration`
  - Related: `choose-cloudflare-stack`

### P2 Normal

- [PRODUCT] `replace-projects-index` — **Choose the source of truth and update workflow for PROJECTS.md.** Compare hosted evidence with optional laptop-agent context and PR versus direct-push updates.
  - Source: owner project brief, [docs/BRIEF.md](docs/BRIEF.md), 2026-10-11
  - Depends on: `define-minimal-deliverable`
  - Related: `evaluate-optional-llm-refresh`

### P3 Low

- [PRODUCT] `define-public-view` — **Decide whether and how to offer a public view.** Define explicit publication consent and private metadata filtering.
  - Source: owner project brief, [docs/BRIEF.md](docs/BRIEF.md), 2026-10-11
  - Depends on: `define-minimal-deliverable`
  - Related: `choose-github-integration`
  - The brief treats this as optional and later; earlier auth and data decisions should avoid precluding it, not design for it.

- [PRODUCT] `evaluate-optional-llm-refresh` — **Decide whether optional LLM refresh is useful.** Define context, provider keys, approval and cost bounds without making paid AI required.
  - Source: owner project brief, [docs/BRIEF.md](docs/BRIEF.md), 2026-10-11
  - Depends on: `replace-projects-index`
  - Hosted refresh reads the existing Markdown, so it needs the source-of-truth decision first.

### Unprioritized

- [GITHUB] `track-upstream-prs` — **Show PRs the owner opened in repositories they do not own.** Upstream contributions are part of the owner's open work but fall outside the monitored-repository set chosen for the first cut.
  - Source: `define-minimal-deliverable` discussion on branch todo/define-minimal-deliverable, 2026-10-11
  - Depends on: `define-minimal-deliverable`
  - Related: `choose-github-integration`, `show-review-requests`
  - Needs a query beyond monitored repositories (for example a search for PRs authored by the owner), which changes the permissions and change-detection story; ties to the brief's Upstream classification.

- [GITHUB] `show-review-requests` — **Show PRs in other owners' repositories where the owner's review is requested.** The first cut covers only PRs on monitored repositories, whoever opened them.
  - Source: `define-minimal-deliverable` discussion on branch todo/define-minimal-deliverable, 2026-10-11
  - Depends on: `define-minimal-deliverable`
  - Related: `choose-github-integration`, `track-upstream-prs`
  - Overlaps GitHub's own review-requested inbox; decide whether a personal instance should surface organization or work review load at all.

## Needs proof of concept

### P0 Critical

### P1 High

- [HOSTING] `choose-cloudflare-stack` — **Choose a stack that fits current Cloudflare free-tier constraints.** Compare runtime, storage and frontend update mechanisms before adding dependencies.
  - Source: owner project brief, [docs/BRIEF.md](docs/BRIEF.md), 2026-10-11
  - Depends on: `define-minimal-deliverable`
  - Related: `choose-change-detection`
  - Starting point: a throwaway spike, outside the main tree, that receives a GitHub webhook in a Worker, persists it and pushes an update to an open browser tab, all on the free plan; confirm current limits from Cloudflare's documentation rather than memory. The same spike can inform `choose-change-detection`.

### P2 Normal

### P3 Low

### Unprioritized

## Ready for separate work

### P0 Critical

### P1 High

- [PRODUCT] `define-minimal-deliverable` — **Define the first dashboard deliverable and acceptance criteria.** Resolve which repositories are monitored (including forks and organization repositories), whether classifications and owner overrides are in the first cut, and which PR signals mean work is needed.
  - Source: owner project brief, [docs/BRIEF.md](docs/BRIEF.md), 2026-10-11
  - Starting point: an owner conversation recorded in [docs/DECISIONS.md](docs/DECISIONS.md), with acceptance checks the first implementation PR can be verified against. Every other entry waits on this one.

### P2 Normal

### P3 Low

### Unprioritized
