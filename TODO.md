# Deferred work

Ordinary follow-ups and bugs found during other work live here. Whole-codebase review findings promoted for separate work live in [review/BACKLOG.md](review/BACKLOG.md). Follow [docket/TODO_GUIDE.md](docket/TODO_GUIDE.md) before adding, claiming, moving or resolving an entry. Entries in **Ready for separate work** are unblocked and available now; an understood entry with an unresolved `Depends on:` or a `Blocked by:` goes in **Waiting** until it clears.

The PR overview's [parallel work plan](plans/2026-10-17-pr-overview-split.md) records ownership, shared interfaces and the acceptance checks retained by its split entries.

## Needs triage

### P0 Critical

### P1 High

### P2 Normal

- [PRODUCT] `confirm-dismissed-review-semantics` — **Confirm how dismissed reviews should affect review state, then make the Terms in docs/DELIVERABLE.md say so.** Read literally, Terms would let an earlier request for changes come back when a later approval is dismissed.
  - Source: bucket-prs, branch todo/bucket-prs (PR #18), 2026-10-16
  - The bucketing code treats a dismissal as withdrawing that reviewer's opinion without reviving an earlier one, and counts the owner's own dismissed review on the head as having reviewed it. Owner edge case: a co-maintainer dismisses the owner's request for changes, and the PR stays in Waiting on the author.
  - Decision needed: whether dismissal withdraws the latest opinion without
    reviving an earlier one, and whether the owner's dismissed review still
    counts as having reviewed the current head. Compare GitHub's behaviour
    where review requirements expose it, then ask the owner; that comparison
    informs Seshat's policy but does not choose it.
  - Starting point: `src/shared/overview/reviews.ts` and its tests already
    exercise both current interpretations. After the decision, align Terms
    and the tests, changing the bucketing code only if the chosen rule differs.

### P3 Low

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

- [PRODUCT] `use-docket-labels` — **Show Docket labels on PR rows when a PR has them, without depending on them.** Docket's `pr-labels.sh` labels PRs with `docket` and `type:<kind>`, and with `queue:<todo|review|roadmap>`, `area:<area>` and `priority:<p0-p3>` when the PR claims or resolves queue entries; they say what a change is and how urgent its queue entry was, but not every PR has them, even in Docket repositories.
  - Source: owner, during replace-projects-index (PR #5), 2026-10-12; example labels on vhata/docket#22
  - Related: `show-project-index`
  - Labels arrive with each PR under the Pull requests permission the GitHub App already has, and label changes arrive as `pull_request` events with the `labeled` and `unlabeled` actions, which need only Pull requests read ([webhook events](https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request)).
  - Bucketing stays on the GitHub facts in [docs/DELIVERABLE.md](docs/DELIVERABLE.md); a PR without these labels must look and sort exactly as it does today. Whether labels go beyond display (filtering, or a tie-break within a bucket) is the owner's call at triage.
  - The `docket` label also marks a repository as Docket-managed without reading its files, which otherwise needs Contents read.

- [PRODUCT] `edit-index-from-dashboard` — **Let the owner edit index fields from the dashboard, starting with accepting a classification suggestion.** Accepting a suggestion today means editing the file by hand.
  - Source: design-project-classifications decision, branch todo/design-project-classifications, 2026-10-15
  - Depends on: `show-project-index`
  - Related: `build-hosted-refresh`, `suggest-classifications`
  - Seshat still writes nothing to the index ([refresh decision](docs/DECISIONS.md#2026-10-15--hosted-llm-refresh-waits)); this entry decides whether owner edits lift that. Index writes go through the second App, installed only on the index repository, that the [refresh design](docs/specs/2026-10-15-llm-refresh.md#github-permissions) records, since Contents write on the main App would reach every repository the owner owns; registering it needs the owner's word at the time.
  - Conflict to settle: the index decision says hosted code never moves an entry between sections except through a PR the owner merges ([spec](docs/specs/2026-10-12-projects-index.md#relationship-to-the-first-deliverable-and-classifications)), while its [hosted writes](docs/specs/2026-10-12-projects-index.md#hosted-writes-and-self-pr-behaviour) section says an owner's own dashboard edit could commit directly. A dashboard accept opens a PR unless the owner amends the first rule ([classifications design](docs/specs/2026-10-15-project-classifications.md#editing-from-the-dashboard)).

- [PRODUCT] `group-multi-repo-projects` — **Group a project that spans several repositories under one index entry.** Format 1 joins one entry to one repository, so a quiet part of an active project is classified and suggested on its own.
  - Source: design-project-classifications decision, branch todo/design-project-classifications, 2026-10-15
  - Related: `suggest-classifications`
  - Take up when the owner has a project that needs it. Likely shape: a field listing further repositories, joined like `Remote`, with last activity taken across all of them; this changes [docs/INDEX_FORMAT.md](docs/INDEX_FORMAT.md) ([projects spanning several repositories](docs/specs/2026-10-15-project-classifications.md#projects-spanning-several-repositories)).

### Unprioritized

## Needs proof of concept

### P0 Critical

### P1 High

### P2 Normal

### P3 Low

### Unprioritized

- [HOSTING] `prove-instance-data-recovery` — **Demonstrate safe recovery of instance data and application code.** Worker code rollback alone does not restore Durable Object data or undo schema migrations.
  - Source: productionization assessment, branch vhata/prototype-status-review, 2026-10-26
  - Related: [instance operations runbook](docs/INSTANCE_OPERATIONS.md)
  - Starting point: the SQLite Durable Object's schema, monitoring overrides, installation choices and sessions. Establish the account's available recovery mechanisms, retention and restore constraints; distinguish reconstructible GitHub facts from owner settings that must be retained.
  - Run a bounded backup/restore and code-rollback experiment against disposable state, including migration compatibility and verification after recovery. Record recovery limits, credential handling and the exact procedure; do not treat a successful code rollback as a database restore.
  - Production restores, destructive experiments, deployments and billable resources require their own authorization; this entry records future work only.

## Waiting

### P0 Critical

### P1 High

### P2 Normal

- [PRODUCT] `suggest-classifications` — **Compute classification suggestions from evidence and show them beside the owner's classification in the index view.** The owner's section is authoritative, so Seshat's only way to flag an entry whose classification looks out of date is a suggestion.
  - Source: design-project-classifications decision, branch todo/design-project-classifications, 2026-10-15
  - Depends on: `show-project-index`
  - Starting point: [Rules](docs/specs/2026-10-15-project-classifications.md#rules) and [How a suggestion is shown](docs/specs/2026-10-15-project-classifications.md#how-a-suggestion-is-shown). The rules are pure functions of a parse, GitHub evidence and a date, in the shared module beside the index parser so the CLI can use them; tests cover every row of the fit and suggestion tables and the examples.
  - Needs the head commit date of open PRs added to the PR reads, to tell a bot's push from the owner's; confirm the fields listed under [Not verified](docs/specs/2026-10-15-project-classifications.md#not-verified).
  - Includes the row marker with its reason, the count and filter in the index header, the link to the entry's line in the file, and suggestions for monitored repositories with no entry.

- [TOOLING] `add-lint-format` — **Add a linter and formatter to the gates.** The scaffold's gates type-check, test and build but enforce no lint rules or formatting.
  - Source: scaffold-worker-app, branch todo/scaffold-worker-app (PR #16), 2026-10-15
  - Blocked by: explicit owner authorization to change CI and hook gates in
    the implementation turn ([contract](docket/CONTRACT.md)). This triage
    records the work and does not authorize those changes.
  - Candidates: ESLint with Prettier, or Biome as one tool. Whichever is chosen runs from `scripts/check.sh`, so hooks and CI pick it up; the hook and CI change needs the owner's word in the turn it is made.
  - The first formatting pass touches most files, so land it while few other
    branches are open, and record its commit in `.git-blame-ignore-revs` if
    the owner agrees to that file.

### P3 Low

- [PRODUCT] `build-hosted-refresh` — **Build optional hosted LLM refresh of the project index to the recorded design, if the owner finds owner fields still go stale between laptop surveys.** Refresh was deferred because the laptop agent covers the same owner-field proposals with no new permissions, and nothing yet shows whether a gap remains.
  - Source: evaluate-optional-llm-refresh decision, branch todo/evaluate-optional-llm-refresh, 2026-10-15
  - Starting point: [Design if adopted](docs/specs/2026-10-15-llm-refresh.md#design-if-adopted) and the [decision](docs/DECISIONS.md#2026-10-15--hosted-llm-refresh-waits): owner-requested or visible-overview-gated weekly runs, a Seshat-gathered bundle, structured proposals applied by the [writing rules](docs/INDEX_FORMAT.md#writing-the-file), one PR from one branch.
  - Depends on: `show-project-index`
  - Blocked by: the owner's judgment, after using both, that owner fields (summaries, next actions, sections) still go stale between laptop surveys, for example through work on other machines or on GitHub alone ([revisit conditions](docs/specs/2026-10-15-llm-refresh.md#what-would-make-it-worthwhile)).
  - Needs a second GitHub App installed only on the index repository with Contents and Pull requests write, registered by the owner, which needs the owner's word at the time. The richer bundle needs Contents read on the main App, which `show-project-index` may already have added; adding it prompts every installation and covers every repository in it.
  - The provider key is an owner-set Worker secret; without one nothing changes. Calling a provider is a billable owner cost, so tests stub the provider.

- [PRODUCT] `publish-index-entries` — **Let the owner publish chosen project index entries on the public view, bound to the text they approved.** The index decision keeps index content private unless consent names it, and the public view decision says what consent may cover.
  - Source: define-public-view decision, branch todo/define-public-view, 2026-10-15
  - Depends on: `build-public-view`, `show-project-index`
  - Related: `suggest-classifications`
  - Starting point: [Index entries](docs/specs/2026-10-15-public-view.md#index-entries). Only entries whose `Remote` joins to a published repository; only the name, classification and summary; consent records those values and a change withholds them until the owner confirms. `Next`, `Note`, `Path`, laptop observations, unknown fields and local-only entries are never public.

- [TOOLING] `bump-checkout-action` — **Move CI from `actions/checkout@v4` to the current major version.** v4 runs on the Node 20 action runtime, which GitHub has deprecated.
  - Source: scaffold-worker-app, branch todo/scaffold-worker-app (PR #16), 2026-10-15
  - Blocked by: explicit owner authorization to change CI in the
    implementation turn ([contract](docket/CONTRACT.md)).
  - Both jobs in `.github/workflows/ci.yml` use it; `actions/setup-node`
    is already on v7. The [latest checkout release](https://github.com/actions/checkout/releases)
    checked on 2026-10-17 is v7.0.1 (2026-07-20).
  - GitHub [retired the Node 20 action runtime](https://github.blog/changelog/2026-09-23-node-20-is-no-longer-available-in-github-actions/)
    on 2026-09-23 and runners now use Node 24. Main CI checked on 2026-10-17
    passed at `2df998a`, so this was maintenance with no observed failing
    gate at triage; recheck releases and CI before implementation.

### Unprioritized

- [GITHUB] `verify-live-organization-opt-in` — **Record live organization installation and repository opt-in evidence when a suitable organization is available.** Automated organization coverage is sufficient for the initial release; a real installation remains unverified.
  - Source: [organization acceptance decision](docs/DECISIONS.md#2026-10-23--organization-acceptance-for-the-initial-release), 2026-10-23
  - Blocked by: a suitable authorized organization installation becoming available; changing the App's visibility still requires approval at the time.
  - Starting point: install the App on an authorized organization, confirm its installation remains pending until accepted, confirm repositories stay off until individually selected, and verify opting a repository in and out adds and removes its PRs from the overview.

## Ready for separate work

### P0 Critical

### P1 High

### P2 Normal

- [PRODUCT] `show-project-index` — **Ingest the project index and show it beside GitHub evidence.** The index decision defines what the dashboard shows; this is the deliverable that builds it, after the PR overview.
  - Source: replace-projects-index decision, branch todo/replace-projects-index, 2026-10-12
  - Related: `suggest-classifications`
  - Needs Contents read added to the GitHub App chosen for the integration ([decision](docs/DECISIONS.md#2026-10-12--github-integration)): for the index repository, and across monitored repositories if it shows branch and commit evidence rather than limiting GitHub evidence to Metadata and PR signals. Adding Contents applies to every repository in the installation and prompts every installation to approve.
  - Ingestion reads the index at a given commit through an interface that does not assume GitHub; the first implementation reads it from GitHub. The index stays on GitHub for now ([decision](docs/DECISIONS.md#2026-10-13--project-index-stays-on-github)).
  - Requirements are in the model and evidence-boundary sections of [docs/specs/2026-10-12-projects-index.md](docs/specs/2026-10-12-projects-index.md): per-field provenance and survey dates, "not reported" rather than "none", rename-safe joins, last good parse kept on errors, and a warning when the index repository is public.
  - Parses the index with the shared `parseProjectIndex` module and conformance fixtures in `src/shared/projects/`, following [docs/INDEX_FORMAT.md](docs/INDEX_FORMAT.md#implementation).
  - Serves nothing from the index on an unauthenticated route; publishing entries is `publish-index-entries` ([public view constraints](docs/specs/2026-10-15-public-view.md#constraints-for-current-work)).

  - From the [classifications decision](docs/DECISIONS.md#2026-10-15--project-classifications): sections are shown in the file's order with unknown names as written; laptop observations that change day to day (`Last commit`, `Checked out`, `Branches`, `Unpushed`, `Uncommitted`) carry a warning when their survey is more than 30 days old, and a survey date after today is flagged ([laptop evidence age](docs/specs/2026-10-15-project-classifications.md#laptop-evidence-age)); an Upstream entry whose repository is outside the installation is described as not visible to the GitHub App. Suggestions themselves are `suggest-classifications`.

- [TOOLING] `check-worker-first-paths` — **Test that every route the Worker serves is covered by `run_worker_first` in `wrangler.jsonc`.** The Workers tests call the Worker directly, so a route missing from that list passes the tests and is then served as the static page.
  - Source: owner-sign-in, branch todo/owner-sign-in (PR #19), 2026-10-16
  - The route table is in `src/worker/routes.ts`; `run_worker_first` currently
    lists `/api`, `/api/*`, `/auth/*`, `/setup` and `/setup/*`. All current
    routes are covered, so this prevents regressions. Include exact-path and
    wildcard semantics and keep frontend assets served without invoking the
    Worker; setting `run_worker_first: true` would defeat that constraint.

### P3 Low

- [PRODUCT] `build-public-view` — **Build the opt-in public view of published repositories' open PRs, served without sign-in.** The public view decision allows one under explicit per-repository consent and a fixed field list; nothing is built for it in the first deliverable.
  - Source: define-public-view decision, branch todo/define-public-view, 2026-10-15
  - Related: `publish-index-entries`
  - Starting point: [docs/specs/2026-10-15-public-view.md](docs/specs/2026-10-15-public-view.md) and the [decision](docs/DECISIONS.md#2026-10-15--public-view): the off switch, per-repository consent kept with the repository ID and owner account ID and cleared when the repository stops being public, changes owner or leaves the installation's listing, the 24-hour [confirmation bound](docs/specs/2026-10-15-public-view.md#confirmation-bound), the rotatable random path served from a custom domain where the owner has one, with `workers_dev = false` and `preview_urls = false`, the allowlist projection in the Durable Object, freshness worded as visibility confirmed within the last day plus notified changes, with no exact sync time, `X-Robots-Tag: noindex`, `Referrer-Policy: no-referrer`, `Cache-Control: private, max-age=60`, no Cloudflare cache, no socket, no storage writes and no sweeps from public requests.
  - Tests must show that a fixture with private and internal repositories, unpublished public repositories and owner settings yields a public response containing none of their names or IDs, and that each withdrawal event in the spec's table, including a repository not confirmed public for 24 hours, takes effect on the next response.
  - Check before relying on them: whether the Workers Rate Limiting binding is available on Free, and whether GitHub shows conflict state to visitors without write access ([not verified](docs/specs/2026-10-15-public-view.md#not-verified)).

### Unprioritized

- [HOSTING] `standardize-instance-deployment` — **Provide a repeatable, explicitly invoked deployment with automated post-deployment verification.** Validation, target selection, upload and smoke checks still rely on separate operator commands.
  - Source: productionization assessment, branch vhata/prototype-status-review, 2026-10-26
  - Related: [instance operations runbook](docs/INSTANCE_OPERATIONS.md), `prove-instance-data-recovery`
  - Starting point: `scripts/check.sh`, the Vite production build and Wrangler. Require a clean, identified source revision, passing validation and an explicit target account/Worker; record the deployed version, commit and URL without exposing secrets.
  - Add repeatable smoke checks for the expected running revision, health/schema, anonymous data refusal and configured setup closure. Keep authenticated sign-in, socket and real GitHub freshness checks explicit where they cannot safely be automated; health alone is insufficient.
  - Preserve per-deployment owner authorization. A local owner-invoked command is sufficient; a manually triggered CI workflow is an alternative that needs authorization to change CI in its implementation turn. Do not enable automatic deployment on merge or provision billable resources from queue capture.
