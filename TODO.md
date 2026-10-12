# Deferred work

Ordinary follow-ups and bugs found during other work live here. Whole-codebase review findings promoted for separate work live in [review/BACKLOG.md](review/BACKLOG.md). Follow [docket/TODO_GUIDE.md](docket/TODO_GUIDE.md) before adding, claiming, moving or resolving an entry. Entries in **Ready for separate work** are unblocked and available now; anything with an unresolved `Depends on:` belongs in an earlier stage.

## Needs triage

### P0 Critical

### P1 High


### P2 Normal

### P3 Low

- [PRODUCT] `evaluate-optional-llm-refresh` — **Decide whether optional LLM refresh is useful.** Define context, provider keys, approval and cost bounds without making paid AI required.
  - Source: owner project brief, [docs/BRIEF.md](docs/BRIEF.md), 2026-10-11
  - Starting point: the constraints the project index decision sets for refresh in [docs/specs/2026-10-12-projects-index.md](docs/specs/2026-10-12-projects-index.md) (PR-only writes, one open refresh PR, never triggered by an index push, a non-owner author or else a draft, consent for what is sent to the provider). Most survey signals are available from the GitHub API, so a refresh could gather one context bundle (commits, branches, PRs, CI, README and queue files); that needs Contents read across monitored repositories, which under a GitHub App is installation-wide anyway, and sends private repository content to the provider.
  - Related: `show-project-index`, `choose-github-integration`

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

- [TOOLING] `ship-projects-cli` — **Ship a Seshat command-line tool for working with the project index locally.** Power users want to list projects by classification, run commands across them and check the index against disk without the hosted app.
  - Source: replace-projects-index decision, branch todo/replace-projects-index, 2026-10-12
  - Depends on: `define-index-format`
  - Related: `write-survey-prompt`
  - Commands from the decision: list by classification (paths or JSON), run a command across projects in given classifications, check the file against the format and the directories on disk, and `survey`, which prints the local-only signals (checked-out branch, uncommitted and untracked files, unpushed commits, local-only branches and repositories) in a stable table and JSON form. See the Seshat CLI section of [docs/specs/2026-10-12-projects-index.md](docs/specs/2026-10-12-projects-index.md).
  - Needs a language and distribution choice; no application stack is selected. Commit counts must count named branches only, not hidden refs that tools create.

- [TOOLING] `write-survey-prompt` — **Write the optional laptop-agent prompt or skill that surveys local checkouts and proposes index updates.** Local-only evidence reaches the index only through this survey.
  - Source: replace-projects-index decision, branch todo/replace-projects-index, 2026-10-12
  - Depends on: `define-index-format`
  - Related: `ship-projects-cli`
  - Pushes directly after the owner approves the diff in the session; opens or updates a single draft PR when unattended; never force-pushes; never deletes an entry for a checkout it did not find without confirmation. Excludes work checkouts, secrets and observations about non-project files. Should read the CLI's `survey` output once it exists rather than running ad-hoc git commands.

- [PRODUCT] `show-project-index` — **Ingest the project index and show it beside GitHub evidence.** The index decision defines what the dashboard shows; this is the deliverable that builds it, after the PR overview.
  - Source: replace-projects-index decision, branch todo/replace-projects-index, 2026-10-12
  - Depends on: `define-index-format`, `choose-github-integration`, `choose-change-detection`, `choose-cloudflare-stack`
  - Blocked by: the first deliverable (PR overview) landing
  - Related: `design-project-classifications`
  - Requirements are in the model and evidence-boundary sections of [docs/specs/2026-10-12-projects-index.md](docs/specs/2026-10-12-projects-index.md): per-field provenance and survey dates, "not reported" rather than "none", rename-safe joins, last good parse kept on errors, and a warning when the index repository is public.

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

### P3 Low

- [PRODUCT] `define-public-view` — **Decide whether and how to offer a public view.** Define explicit publication consent and private metadata filtering.
  - Source: owner project brief, [docs/BRIEF.md](docs/BRIEF.md), 2026-10-11
  - The brief treats this as optional and later; earlier auth and data decisions should avoid precluding it, not design for it.
  - Data is read with GitHub App installation tokens, so a public page needs no visitor sign-in, but GitHub's permissions do no filtering for it ([spec](docs/specs/2026-10-12-github-integration.md#public-view)).

### Unprioritized

- [DOCS] `define-index-format` — **Document the project index format and a shared format check.** Seshat, the CLI and the laptop agent all parse the file, so the format is an interface and needs one definition.
  - Source: replace-projects-index decision, branch todo/replace-projects-index, 2026-10-12
  - Starting point: the field-ownership table in [docs/specs/2026-10-12-projects-index.md](docs/specs/2026-10-12-projects-index.md). Settle the entry key (GitHub `owner/name` plus local path, where the owner's current file keys by directory name), per-entry `Surveyed:` dates, how unknown fields and sections are treated, and what the check reports.
  - Related: `ship-projects-cli`, `write-survey-prompt`, `show-project-index`

- [PRODUCT] `design-project-classifications` — **Design project classifications, suggestions and evidence freshness.** The brief lists this as an open question; the index decision settled only that the section an entry sits under is the authoritative classification.
  - Source: replace-projects-index decision, branch todo/replace-projects-index, 2026-10-12
  - Related: `show-project-index`, `evaluate-optional-llm-refresh`
  - Covers the set of classifications, thresholds for computed suggestions, how a suggestion that disagrees with the owner is shown, whether an owner classification expires, when laptop evidence is too old to show without a warning, and projects spanning several repositories.
