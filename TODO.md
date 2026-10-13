# Deferred work

Ordinary follow-ups and bugs found during other work live here. Whole-codebase review findings promoted for separate work live in [review/BACKLOG.md](review/BACKLOG.md). Follow [docket/TODO_GUIDE.md](docket/TODO_GUIDE.md) before adding, claiming, moving or resolving an entry. Entries in **Ready for separate work** are unblocked and available now; anything with an unresolved `Depends on:` belongs in an earlier stage.

## Needs triage

### P0 Critical

### P1 High


### P2 Normal

### P3 Low

- [PRODUCT] `evaluate-optional-llm-refresh` — **Decide whether optional LLM refresh is useful.** Define context, provider keys, approval and cost bounds without making paid AI required.
  - Source: owner project brief, [docs/BRIEF.md](docs/BRIEF.md), 2026-10-11
  - Depends on: `replace-projects-index`
  - Hosted refresh reads the existing Markdown, so it needs the source-of-truth decision first.

### Unprioritized

- [GITHUB] `track-upstream-prs` — **Show PRs the owner opened in repositories they do not own.** Upstream contributions are part of the owner's open work but fall outside the monitored-repository set chosen for the first cut.
  - Source: `define-minimal-deliverable` discussion on branch todo/define-minimal-deliverable, 2026-10-11
  - Related: `show-review-requests`
  - Needs a query beyond monitored repositories (for example a search for PRs authored by the owner), which changes the permissions and change-detection story; ties to the brief's Upstream classification.
  - The GitHub integration decision stores no owner user token; this entry may add one, with its own lifecycle, if acting as the owner is needed ([spec](docs/specs/2026-10-12-github-integration.md#d-hybrids)).

- [GITHUB] `show-review-requests` — **Show PRs in other owners' repositories where the owner's review is requested.** The first cut covers only PRs on monitored repositories, whoever opened them.
  - Source: `define-minimal-deliverable` discussion on branch todo/define-minimal-deliverable, 2026-10-11
  - Related: `track-upstream-prs`
  - Overlaps GitHub's own review-requested inbox; decide whether a personal instance should surface organization or work review load at all.
  - The GitHub integration decision stores no owner user token; this entry may add one, with its own lifecycle, if acting as the owner is needed ([spec](docs/specs/2026-10-12-github-integration.md#d-hybrids)).

## Needs proof of concept

### P0 Critical

### P1 High

- [HOSTING] `choose-cloudflare-stack` — **Choose a stack that fits current Cloudflare free-tier constraints.** Compare runtime, storage and frontend update mechanisms before adding dependencies.
  - Source: owner project brief, [docs/BRIEF.md](docs/BRIEF.md), 2026-10-11
  - Related: `choose-change-detection`
  - Starting point: a throwaway spike, outside the main tree, that receives a GitHub webhook in a Worker, persists it and pushes an update to an open browser tab, all on the free plan; confirm current limits from Cloudflare's documentation rather than memory. The same spike can inform `choose-change-detection`.
  - The spike should also confirm the first two items under [Not verified](docs/specs/2026-10-12-github-integration.md#not-verified) in the GitHub integration spec: whether an all-repositories installation on a personal account receives events for repositories created later, and whether other GitHub users can authorize a private app owned by a personal account.
  - Owner's working hypothesis (2026-10-11): webhooks persisted in Cloudflare storage, with a reactive frontend (for example React) re-rendering when the data model changes, so the page updates without a reload. Test this shape first; the fallback discussed is bounded polling within about five minutes. Requirements are in [docs/DELIVERABLE.md](docs/DELIVERABLE.md).

### P2 Normal

### P3 Low

### Unprioritized

## Ready for separate work

### P0 Critical

### P1 High

- [GITHUB] `choose-change-detection` — **Choose change detection and missed-event reconciliation.** Evaluate webhooks versus polling and make sync freshness visible.
  - Source: owner project brief, [docs/BRIEF.md](docs/BRIEF.md), 2026-10-11
  - Related: `choose-cloudflare-stack`
  - Must meet the freshness requirements in [docs/DELIVERABLE.md](docs/DELIVERABLE.md#freshness): changes visible within 60 seconds, convergence after missed or late notifications, and the overdue-sync threshold and catch-up bound this decision sets.
  - GitHub access is a GitHub App with read-only Metadata, Pull requests, Checks and Commit statuses ([decision](docs/DECISIONS.md#2026-10-12--github-integration)). The events it can receive and the constraints that bear on this choice (no automatic redelivery, fork CI events matched by head SHA, no event for mergeability, no push or top-level PR comment events without more permissions, rate and subrequest limits) are under [Webhook events](docs/specs/2026-10-12-github-integration.md#webhook-events) and [Rate limits](docs/specs/2026-10-12-github-integration.md#rate-limits) in the spec.

### P2 Normal

- [PRODUCT] `replace-projects-index` — **Choose the source of truth and update workflow for PROJECTS.md.** Compare hosted evidence with optional laptop-agent context and PR versus direct-push updates.
  - Source: owner project brief, [docs/BRIEF.md](docs/BRIEF.md), 2026-10-11
  - Related: `evaluate-optional-llm-refresh`

### P3 Low

- [PRODUCT] `define-public-view` — **Decide whether and how to offer a public view.** Define explicit publication consent and private metadata filtering.
  - Source: owner project brief, [docs/BRIEF.md](docs/BRIEF.md), 2026-10-11
  - The brief treats this as optional and later; earlier auth and data decisions should avoid precluding it, not design for it.
  - Data is read with GitHub App installation tokens, so a public page needs no visitor sign-in, but GitHub's permissions do no filtering for it ([spec](docs/specs/2026-10-12-github-integration.md#public-view)).

### Unprioritized
