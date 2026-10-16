# Deferred work

Ordinary follow-ups and bugs found during other work live here. Whole-codebase review findings promoted for separate work live in [review/BACKLOG.md](review/BACKLOG.md). Follow [docket/TODO_GUIDE.md](docket/TODO_GUIDE.md) before adding, claiming, moving or resolving an entry. Entries in **Ready for separate work** are unblocked and available now; an understood entry with an unresolved `Depends on:` or a `Blocked by:` goes in **Waiting** until it clears.

## Needs triage

### P0 Critical

### P1 High

### P2 Normal

### P3 Low

- [GITHUB] `track-upstream-prs` — **Show PRs the owner opened in repositories they do not own.** Upstream contributions are part of the owner's open work but fall outside the monitored-repository set chosen for the first cut.
  - Source: `define-minimal-deliverable` discussion on branch todo/define-minimal-deliverable, 2026-10-11
  - Depends on: `build-pr-overview`
  - Related: `show-review-requests`
  - Needs a query beyond monitored repositories (for example a search for PRs authored by the owner), which changes the permissions and change-detection story; ties to the brief's Upstream classification.
  - The GitHub integration decision stores no owner user token; this entry may add one, with its own lifecycle, if acting as the owner is needed ([spec](docs/specs/2026-10-12-github-integration.md#d-hybrids)).

- [GITHUB] `show-review-requests` — **Show PRs in other owners' repositories where the owner's review is requested.** The first cut covers only PRs on monitored repositories, whoever opened them.
  - Source: `define-minimal-deliverable` discussion on branch todo/define-minimal-deliverable, 2026-10-11
  - Depends on: `build-pr-overview`
  - Related: `track-upstream-prs`
  - Overlaps GitHub's own review-requested inbox; decide whether a personal instance should surface organization or work review load at all.
  - The GitHub integration decision stores no owner user token; this entry may add one, with its own lifecycle, if acting as the owner is needed ([spec](docs/specs/2026-10-12-github-integration.md#d-hybrids)).

- [PRODUCT] `use-docket-labels` — **Show Docket labels on PR rows when a PR has them, without depending on them.** Docket's `pr-labels.sh` labels PRs with `docket` and `type:<kind>`, and with `queue:<todo|review|roadmap>`, `area:<area>` and `priority:<p0-p3>` when the PR claims or resolves queue entries; they say what a change is and how urgent its queue entry was, but not every PR has them, even in Docket repositories.
  - Source: owner, during replace-projects-index (PR #5), 2026-10-12; example labels on vhata/docket#22
  - Depends on: `build-pr-overview`
  - Related: `show-project-index`
  - Labels arrive with each PR under the Pull requests permission the GitHub App already has, and label changes arrive as `pull_request` events with the `labeled` and `unlabeled` actions, which need only Pull requests read ([webhook events](https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request)).
  - Bucketing stays on the GitHub facts in [docs/DELIVERABLE.md](docs/DELIVERABLE.md); a PR without these labels must look and sort exactly as it does today. Whether labels go beyond display (filtering, or a tie-break within a bucket) is the owner's call at triage.
  - The `docket` label also marks a repository as Docket-managed without reading its files, which otherwise needs Contents read.

### Unprioritized

- [TOOLING] `bump-checkout-action` — **Move CI from `actions/checkout@v4` to the current major version.** v4 runs on the Node 20 action runtime, which GitHub has deprecated.
  - Source: scaffold-worker-app, branch todo/scaffold-worker-app (PR #16), 2026-10-15
  - Both jobs in `.github/workflows/ci.yml` use it. Changing CI needs the owner's word in the turn it is made ([contract](docket/CONTRACT.md)).

- [TOOLING] `add-lint-format` — **Add a linter and formatter to the gates.** The scaffold's gates type-check, test and build but enforce no lint rules or formatting.
  - Source: scaffold-worker-app, branch todo/scaffold-worker-app (PR #16), 2026-10-15
  - Candidates: ESLint with Prettier, or Biome as one tool. Whichever is chosen runs from `scripts/check.sh`, so hooks and CI pick it up; the hook and CI change needs the owner's word in the turn it is made.

## Needs proof of concept

### P0 Critical

### P1 High

### P2 Normal

### P3 Low

### Unprioritized

## Waiting

### P0 Critical

### P1 High

- [PRODUCT] `bucket-prs` — **Implement PR bucketing, the CI and review-state derivations, ordering within buckets and the stale flag as pure functions with exhaustive tests.** These rules are most of the first deliverable's logic and need no GitHub access or change-detection choice.
  - Source: split of `build-pr-overview`, 2026-10-15
  - Split from: `build-pr-overview`
  - Depends on: `scaffold-worker-app`
  - Starting point: [Terms](docs/DELIVERABLE.md#terms), [Buckets](docs/DELIVERABLE.md#buckets), [Order within a bucket](docs/DELIVERABLE.md#order-within-a-bucket) and [Stale flag](docs/DELIVERABLE.md#stale-flag). Acceptance check 3's logic half (fixed sample data, one case per rule, precedence cases, every combination lands in a bucket, each derivation mapping) and check 8's logic half, the flag computed from last activity.
  - Takes a plain input type for a PR and its reviews, checks and reviewer permissions, so the GitHub reads in the [change detection design](docs/specs/2026-10-14-change-detection.md#re-reads) only have to fill it in.

- [GITHUB] `owner-sign-in` — **Implement owner-only sign-in through the GitHub App, refusing every other account.** Every other route sits behind it, and it needs no change-detection choice.
  - Source: split of `build-pr-overview`, 2026-10-15
  - Split from: `build-pr-overview`
  - Depends on: `scaffold-worker-app`
  - Starting point: [Sign-in](docs/DELIVERABLE.md#sign-in) and acceptance check 1, and the sign-in and credential sections of [docs/specs/2026-10-12-github-integration.md](docs/specs/2026-10-12-github-integration.md). The owner is configured by account ID; the stubbed `GET /user` test with a matching username and a different ID is required.
  - This entry's gate is check 1's automated half: the stubbed `GET /user` test and tests that a refused account sees no instance data and leaves no stored credential. The manual second-account scenario moves to `build-pr-overview`, since the owner could not create a second account on 2026-10-14 ([results](docs/specs/2026-10-13-cloudflare-stack.md#github-app-checks)).
  - Includes the App's [registration and installation](docs/specs/2026-10-12-github-integration.md#registration-and-installation) setup routes, since sign-in cannot be tried by hand without them. Registering a real App creates a GitHub resource and needs the owner's word at the time.

- [PRODUCT] `build-pr-overview` — **Build the rest of the PR overview: monitored repositories, GitHub reads, change detection, live updates, sync status and the overview page.** With sign-in and bucketing split off, this is what remains of the first deliverable.
  - Source: TODO.md triage, 2026-10-14
  - Depends on: `bucket-prs`, `owner-sign-in`
  - Starting point: [docs/DELIVERABLE.md](docs/DELIVERABLE.md), within the [Cloudflare stack decision](docs/DECISIONS.md#2026-10-13--cloudflare-stack), the [GitHub integration decision](docs/DECISIONS.md#2026-10-12--github-integration) and the [change detection decision](docs/DECISIONS.md#2026-10-15--change-detection), whose design is in [docs/specs/2026-10-14-change-detection.md](docs/specs/2026-10-14-change-detection.md). Visual references are in [docs/design/README.md](docs/design/README.md). Covers acceptance checks 2, 4 to 7, 9 and 10; the end-to-end halves of check 3 (every open PR on a monitored repository appears exactly once) and check 8 (the stale flag shown on a row from GitHub's activity data); and the manual half of check 1 if a second GitHub account is available by then, which is otherwise the owner's call to waive.
  - Split further before parallel work starts, for example repository selection, sync and live updates, and the page.

### P2 Normal

- [PRODUCT] `show-project-index` — **Ingest the project index and show it beside GitHub evidence.** The index decision defines what the dashboard shows; this is the deliverable that builds it, after the PR overview.
  - Source: replace-projects-index decision, branch todo/replace-projects-index, 2026-10-12
  - Depends on: `build-pr-overview`
  - Related: `design-project-classifications`
  - Needs Contents read added to the GitHub App chosen for the integration ([decision](docs/DECISIONS.md#2026-10-12--github-integration)): for the index repository, and across monitored repositories if it shows branch and commit evidence rather than limiting GitHub evidence to Metadata and PR signals. Adding Contents applies to every repository in the installation and prompts every installation to approve.
  - Ingestion reads the index at a given commit through an interface that does not assume GitHub; the first implementation reads it from GitHub. The index stays on GitHub for now ([decision](docs/DECISIONS.md#2026-10-13--project-index-stays-on-github)).
  - Requirements are in the model and evidence-boundary sections of [docs/specs/2026-10-12-projects-index.md](docs/specs/2026-10-12-projects-index.md): per-field provenance and survey dates, "not reported" rather than "none", rename-safe joins, last good parse kept on errors, and a warning when the index repository is public.
  - Parses the index with the shared parser and check defined in [docs/INDEX_FORMAT.md](docs/INDEX_FORMAT.md), building that module and its conformance fixtures if `ship-projects-cli` has not ([implementation](docs/INDEX_FORMAT.md#implementation)).

### P3 Low

- [PRODUCT] `ship-projects-cli` — **Ship a Seshat command-line tool for working with the project index locally.** Power users want to list projects by classification, run commands across them and check the index against disk without the hosted app.
  - Source: replace-projects-index decision, branch todo/replace-projects-index, 2026-10-12
  - Depends on: `scaffold-worker-app`
  - Related: `write-survey-prompt`
  - Commands from the decision: list by classification (paths or JSON), run a command across projects in given classifications, check the file against the format and the directories on disk, and `survey`, which prints the local-only signals (checked-out branch, uncommitted and untracked files, unpushed commits, local-only branches and repositories) in a stable table and JSON form. See the Seshat CLI section of [docs/specs/2026-10-12-projects-index.md](docs/specs/2026-10-12-projects-index.md).
  - Its PR chooses the language and distribution; the hosted app's stack ([decision](docs/DECISIONS.md#2026-10-13--cloudflare-stack)) does not settle the CLI's. Waits for the scaffold so that a TypeScript CLI shares its toolchain and the [shared parser module](docs/INDEX_FORMAT.md#implementation). Commit counts must count named branches only, not hidden refs that tools create.
  - Uses only git, with no GitHub assumption; the index repository's remote is configuration.
  - `check` runs the shared format check and the disk check defined in [docs/INDEX_FORMAT.md](docs/INDEX_FORMAT.md), building the shared module and its conformance fixtures if `show-project-index` has not.
  - Low because the owner's existing local tool already parses the index until this replaces it ([spec](docs/specs/2026-10-12-projects-index.md#follow-up-work)).

### Unprioritized

## Ready for separate work

### P0 Critical

### P1 High

- [TOOLING] `scaffold-worker-app` — **Scaffold the Worker, Durable Object and React frontend, with type checks and tests run by `scripts/check.sh`, the hooks and CI.** Every overview PR needs a buildable, tested project to land in, and the gates should exist before the first feature does.
  - Source: split of `build-pr-overview`, 2026-10-15
  - Split from: `build-pr-overview`
  - Starting point: the [Cloudflare stack decision](docs/DECISIONS.md#2026-10-13--cloudflare-stack) (one TypeScript Worker serving Vite-built React static assets, one SQLite-backed Durable Object, no other storage products) and [Constraints for implementation](docs/specs/2026-10-13-cloudflare-stack.md#constraints-for-implementation), which include keeping writes out of object constructors. Tests should run in the Workers runtime where they touch Worker or object code.
  - Choose and record the package manager and test runner. Ship at least one real test of the Worker and the object, since an empty suite is a failed gate, and update [docs/QUALITY.md](docs/QUALITY.md) and the README to describe the new gates.
  - Includes local development (`wrangler dev` or equivalent) but no deploy; deploying needs the owner's word each time ([AGENTS.md](AGENTS.md#docket)). Adding the toolchain to `.github/workflows/ci.yml` and the hooks is a CI and hooks change, which the [contract](docket/CONTRACT.md) says needs the owner's word in the turn it is made; ask then.
  - Update the expected tracked content and the deferred-checks paragraph in [docs/QUALITY.md](docs/QUALITY.md) for the new files and gates.

### P2 Normal

- [PRODUCT] `write-survey-prompt` — **Write the optional laptop-agent prompt or skill that surveys local checkouts and proposes index updates.** Local-only evidence reaches the index only through this survey.
  - Source: replace-projects-index decision, branch todo/replace-projects-index, 2026-10-12
  - Related: `ship-projects-cli`
  - Uses only git, with no GitHub assumption; the index repository's remote is configuration. The one exception is an unattended run's draft PR, opened only where the host supports PRs; where the host has no PRs, an unattended run pushes to a review branch, never to the default branch, and leaves review to the owner.
  - Pushes directly after the owner approves the diff in the session; when unattended, opens or updates a single draft PR (or updates its review branch where the host has no PRs); never force-pushes; never deletes an entry for a checkout it did not find without confirmation. Excludes work checkouts, secrets and observations about non-project files. Should read the CLI's `survey` output once it exists rather than running ad-hoc git commands.
  - Reads and writes the file by [docs/INDEX_FORMAT.md](docs/INDEX_FORMAT.md), including its [writing rules](docs/INDEX_FORMAT.md#writing-the-file); until the shared check exists, the owner's review of the diff stands in for it. Can carry out the [migration](docs/INDEX_FORMAT.md#migrating-the-current-file) of the owner's current file.

### P3 Low

- [PRODUCT] `evaluate-optional-llm-refresh` — **Decide whether optional LLM refresh is useful.** Define context, provider keys, approval and cost bounds without making paid AI required.
  - Source: owner project brief, [docs/BRIEF.md](docs/BRIEF.md), 2026-10-11
  - Starting point: the constraints the project index decision sets for refresh in [docs/specs/2026-10-12-projects-index.md](docs/specs/2026-10-12-projects-index.md) (PR-only writes, one open refresh PR, never triggered by an index push, a non-owner author or else a draft, consent for what is sent to the provider). Most survey signals are available from the GitHub API, so a refresh could gather one context bundle (commits, branches, PRs, CI, README and queue files). Commits, branches, READMEs and other files all need Contents read ([permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)), so the bundle needs Contents read across monitored repositories; adding Contents to the App applies to every repository in the installation and prompts every installation to approve. Writing refresh PRs to the index repository also needs Contents write and Pull requests write. The bundle sends private repository content to the provider.
  - Related: `show-project-index`

- [PRODUCT] `define-public-view` — **Decide whether and how to offer a public view.** Define explicit publication consent and private metadata filtering.
  - Source: owner project brief, [docs/BRIEF.md](docs/BRIEF.md), 2026-10-11
  - The brief treats this as optional and later; earlier auth and data decisions should avoid precluding it, not design for it.
  - Data is read with GitHub App installation tokens, so a public page needs no visitor sign-in, but GitHub's permissions do no filtering for it ([spec](docs/specs/2026-10-12-github-integration.md#public-view)).

- [PRODUCT] `design-project-classifications` — **Design project classifications, suggestions and evidence freshness.** The brief lists this as an open question; the index decision settled only that the section an entry sits under is the authoritative classification.
  - Source: replace-projects-index decision, branch todo/replace-projects-index, 2026-10-12
  - Related: `show-project-index`, `evaluate-optional-llm-refresh`
  - Covers the set of classifications, thresholds for computed suggestions, how a suggestion that disagrees with the owner is shown, whether an owner classification expires, when laptop evidence is too old to show without a warning, and projects spanning several repositories.

### Unprioritized
