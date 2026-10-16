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

- [GITHUB] `rate-limit-sign-in-callback` — **Rate-limit refused sign-ins so a stranger cannot exhaust the App's OAuth token budget.** GitHub allows 2,000 OAuth token requests an hour per app, and every refused sign-in spends one, which could lock the owner out.
  - Source: owner-sign-in, branch todo/owner-sign-in (PR #19), 2026-10-16
  - The [rate limits](docs/specs/2026-10-12-github-integration.md#rate-limits) section already asks implementation to rate-limit; the sign-in PR does not. Any limiter has to live in the Durable Object or a Workers binding within the [stack decision](docs/DECISIONS.md#2026-10-13--cloudflare-stack).

- [GITHUB] `guard-installation-webhooks` — **Run the installation guard on `installation` and `installation_repositories` deliveries, and drop deliveries from installations that are not accepted.** The sign-in PR runs the guard only when the owner opens the setup page.
  - Source: owner-sign-in, branch todo/owner-sign-in (PR #19), 2026-10-16
  - See the installation guard under [registration and installation](docs/specs/2026-10-12-github-integration.md#registration-and-installation). May fold into a `build-pr-overview` split, since that work handles deliveries.

- [PRODUCT] `accept-org-installations` — **Let the owner accept or refuse pending organization installations.** The sign-in PR holds an organization installation as pending with no way to accept it.
  - Source: owner-sign-in, branch todo/owner-sign-in (PR #19), 2026-10-16
  - Could fold into the repository-selection part of a `build-pr-overview` split.

- [TOOLING] `check-worker-first-paths` — **Test that every route the Worker serves is covered by `run_worker_first` in `wrangler.jsonc`.** The Workers tests call the Worker directly, so a route missing from that list passes the tests and is then served as the static page.
  - Source: owner-sign-in, branch todo/owner-sign-in (PR #19), 2026-10-16

- [PRODUCT] `confirm-dismissed-review-semantics` — **Confirm how dismissed reviews should affect review state, then make the Terms in docs/DELIVERABLE.md say so.** Read literally, Terms would let an earlier request for changes come back when a later approval is dismissed.
  - Source: bucket-prs, branch todo/bucket-prs (PR #18), 2026-10-16
  - The bucketing code treats a dismissal as withdrawing that reviewer's opinion without reviving an earlier one, and counts the owner's own dismissed review on the head as having reviewed it. Owner edge case: a co-maintainer dismisses the owner's request for changes, and the PR stays in Waiting on the author.
  - Check against GitHub's own review decision after a dismissal.

- [GITHUB] `verify-private-draft-prs` — **Confirm whether the owner's GitHub plan allows draft PRs in a private index repository.** The unattended survey opens a draft PR, and the hosted-writes rules rely on drafts; GitHub's documentation does not say which plans support them on private repositories.
  - Source: write-survey-prompt validation, branch todo/write-survey-prompt (PR #17), 2026-10-16
  - The survey skill treats a refused draft as a failure and leaves the review branch in place.

- [TOOLING] `bump-checkout-action` — **Move CI from `actions/checkout@v4` to the current major version.** v4 runs on the Node 20 action runtime, which GitHub has deprecated.
  - Source: scaffold-worker-app, branch todo/scaffold-worker-app (PR #16), 2026-10-15
  - Both jobs in `.github/workflows/ci.yml` use it. Changing CI needs the owner's word in the turn it is made ([contract](docket/CONTRACT.md)).

- [TOOLING] `add-lint-format` — **Add a linter and formatter to the gates.** The scaffold's gates type-check, test and build but enforce no lint rules or formatting.
  - Source: scaffold-worker-app, branch todo/scaffold-worker-app (PR #16), 2026-10-15
  - Candidates: ESLint with Prettier, or Biome as one tool. Whichever is chosen runs from `scripts/check.sh`, so hooks and CI pick it up; the hook and CI change needs the owner's word in the turn it is made.

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

## Needs proof of concept

### P0 Critical

### P1 High

### P2 Normal

### P3 Low

### Unprioritized

## Waiting

### P0 Critical

### P1 High

- [PRODUCT] `build-pr-overview` — **Build the rest of the PR overview: monitored repositories, GitHub reads, change detection, live updates, sync status and the overview page.** With sign-in and bucketing split off, this is what remains of the first deliverable.
  - Source: TODO.md triage, 2026-10-14
  - Depends on: `owner-sign-in`
  - Starting point: [docs/DELIVERABLE.md](docs/DELIVERABLE.md), within the [Cloudflare stack decision](docs/DECISIONS.md#2026-10-13--cloudflare-stack), the [GitHub integration decision](docs/DECISIONS.md#2026-10-12--github-integration) and the [change detection decision](docs/DECISIONS.md#2026-10-15--change-detection), whose design is in [docs/specs/2026-10-14-change-detection.md](docs/specs/2026-10-14-change-detection.md). Visual references are in [docs/design/README.md](docs/design/README.md). Covers acceptance checks 2, 4 to 7, 9 and 10; the end-to-end halves of check 3 (every open PR on a monitored repository appears exactly once) and check 8 (the stale flag shown on a row from GitHub's activity data); and the manual half of check 1 if a second GitHub account is available by then, which is otherwise the owner's call to waive.
  - Split further before parallel work starts, for example repository selection, sync and live updates, and the page.
  - Store each repository's visibility, and the time a GitHub read last reported it, with every read that stores its PRs and with each repository listing; update it from every delivery's `repository` object and from `privatized`, `publicized`, `transferred` and `deleted`; and treat anything other than `public` as private. The public view's 24-hour confirmation bound rests on that time. The owner snapshot and API stay reachable only through the owner's session ([public view constraints](docs/specs/2026-10-15-public-view.md#constraints-for-current-work)).

  - The bucketing rules are pure functions in `src/shared/overview/`: the GitHub reads fill in `PrInput` ([types](src/shared/overview/types.ts), which notes the GitHub field behind each input), and the page renders what `buildOverview` returns.

### P2 Normal

- [PRODUCT] `show-project-index` — **Ingest the project index and show it beside GitHub evidence.** The index decision defines what the dashboard shows; this is the deliverable that builds it, after the PR overview.
  - Source: replace-projects-index decision, branch todo/replace-projects-index, 2026-10-12
  - Depends on: `build-pr-overview`
  - Related: `suggest-classifications`
  - Needs Contents read added to the GitHub App chosen for the integration ([decision](docs/DECISIONS.md#2026-10-12--github-integration)): for the index repository, and across monitored repositories if it shows branch and commit evidence rather than limiting GitHub evidence to Metadata and PR signals. Adding Contents applies to every repository in the installation and prompts every installation to approve.
  - Ingestion reads the index at a given commit through an interface that does not assume GitHub; the first implementation reads it from GitHub. The index stays on GitHub for now ([decision](docs/DECISIONS.md#2026-10-13--project-index-stays-on-github)).
  - Requirements are in the model and evidence-boundary sections of [docs/specs/2026-10-12-projects-index.md](docs/specs/2026-10-12-projects-index.md): per-field provenance and survey dates, "not reported" rather than "none", rename-safe joins, last good parse kept on errors, and a warning when the index repository is public.
  - Parses the index with the shared parser and check defined in [docs/INDEX_FORMAT.md](docs/INDEX_FORMAT.md), building that module and its conformance fixtures if `ship-projects-cli` has not ([implementation](docs/INDEX_FORMAT.md#implementation)).
  - Serves nothing from the index on an unauthenticated route; publishing entries is `publish-index-entries` ([public view constraints](docs/specs/2026-10-15-public-view.md#constraints-for-current-work)).

  - From the [classifications decision](docs/DECISIONS.md#2026-10-15--project-classifications): sections are shown in the file's order with unknown names as written; laptop observations that change day to day (`Last commit`, `Checked out`, `Branches`, `Unpushed`, `Uncommitted`) carry a warning when their survey is more than 30 days old, and a survey date after today is flagged ([laptop evidence age](docs/specs/2026-10-15-project-classifications.md#laptop-evidence-age)); an Upstream entry whose repository is outside the installation is described as not visible to the GitHub App. Suggestions themselves are `suggest-classifications`.

### P3 Low

### Unprioritized

- [PRODUCT] `build-hosted-refresh` — **Build optional hosted LLM refresh of the project index to the recorded design, if the owner finds owner fields still go stale between laptop surveys.** Refresh was deferred because the laptop agent covers the same owner-field proposals with no new permissions, and nothing yet shows whether a gap remains.
  - Source: evaluate-optional-llm-refresh decision, branch todo/evaluate-optional-llm-refresh, 2026-10-15
  - Starting point: [Design if adopted](docs/specs/2026-10-15-llm-refresh.md#design-if-adopted) and the [decision](docs/DECISIONS.md#2026-10-15--hosted-llm-refresh-waits): owner-requested or visible-overview-gated weekly runs, a Seshat-gathered bundle, structured proposals applied by the [writing rules](docs/INDEX_FORMAT.md#writing-the-file), one PR from one branch.
  - Depends on: `show-project-index`
  - Blocked by: the owner's judgment, after using both, that owner fields (summaries, next actions, sections) still go stale between laptop surveys, for example through work on other machines or on GitHub alone ([revisit conditions](docs/specs/2026-10-15-llm-refresh.md#what-would-make-it-worthwhile)).
  - Needs a second GitHub App installed only on the index repository with Contents and Pull requests write, registered by the owner, which needs the owner's word at the time. The richer bundle needs Contents read on the main App, which `show-project-index` may already have added; adding it prompts every installation and covers every repository in it.
  - The provider key is an owner-set Worker secret; without one nothing changes. Calling a provider is a billable owner cost, so tests stub the provider.

- [PRODUCT] `build-public-view` — **Build the opt-in public view of published repositories' open PRs, served without sign-in.** The public view decision allows one under explicit per-repository consent and a fixed field list; nothing is built for it in the first deliverable.
  - Source: define-public-view decision, branch todo/define-public-view, 2026-10-15
  - Depends on: `build-pr-overview`
  - Related: `publish-index-entries`
  - Starting point: [docs/specs/2026-10-15-public-view.md](docs/specs/2026-10-15-public-view.md) and the [decision](docs/DECISIONS.md#2026-10-15--public-view): the off switch, per-repository consent kept with the repository ID and owner account ID and cleared when the repository stops being public, changes owner or leaves the installation's listing, the 24-hour [confirmation bound](docs/specs/2026-10-15-public-view.md#confirmation-bound), the rotatable random path served from a custom domain where the owner has one, with `workers_dev = false` and `preview_urls = false`, the allowlist projection in the Durable Object, freshness worded as visibility confirmed within the last day plus notified changes, with no exact sync time, `X-Robots-Tag: noindex`, `Referrer-Policy: no-referrer`, `Cache-Control: private, max-age=60`, no Cloudflare cache, no socket, no storage writes and no sweeps from public requests.
  - Tests must show that a fixture with private and internal repositories, unpublished public repositories and owner settings yields a public response containing none of their names or IDs, and that each withdrawal event in the spec's table, including a repository not confirmed public for 24 hours, takes effect on the next response.
  - Check before relying on them: whether the Workers Rate Limiting binding is available on Free, and whether GitHub shows conflict state to visitors without write access ([not verified](docs/specs/2026-10-15-public-view.md#not-verified)).

- [PRODUCT] `publish-index-entries` — **Let the owner publish chosen project index entries on the public view, bound to the text they approved.** The index decision keeps index content private unless consent names it, and the public view decision says what consent may cover.
  - Source: define-public-view decision, branch todo/define-public-view, 2026-10-15
  - Depends on: `build-public-view`, `show-project-index`
  - Related: `suggest-classifications`
  - Starting point: [Index entries](docs/specs/2026-10-15-public-view.md#index-entries). Only entries whose `Remote` joins to a published repository; only the name, classification and summary; consent records those values and a change withholds them until the owner confirms. `Next`, `Note`, `Path`, laptop observations, unknown fields and local-only entries are never public.

- [PRODUCT] `suggest-classifications` — **Compute classification suggestions from evidence and show them beside the owner's classification in the index view.** The owner's section is authoritative, so Seshat's only way to flag an entry whose classification looks out of date is a suggestion.
  - Source: design-project-classifications decision, branch todo/design-project-classifications, 2026-10-15
  - Depends on: `show-project-index`
  - Starting point: [Rules](docs/specs/2026-10-15-project-classifications.md#rules) and [How a suggestion is shown](docs/specs/2026-10-15-project-classifications.md#how-a-suggestion-is-shown). The rules are pure functions of a parse, GitHub evidence and a date, in the shared module beside the index parser so the CLI can use them; tests cover every row of the fit and suggestion tables and the examples.
  - Needs the head commit date of open PRs added to the PR reads, to tell a bot's push from the owner's; confirm the fields listed under [Not verified](docs/specs/2026-10-15-project-classifications.md#not-verified).
  - Includes the row marker with its reason, the count and filter in the index header, the link to the entry's line in the file, and suggestions for monitored repositories with no entry.

## Ready for separate work

### P0 Critical

### P1 High

- [GITHUB] `owner-sign-in` — **Implement owner-only sign-in through the GitHub App, refusing every other account.** Every other route sits behind it, and it needs no change-detection choice.
  - Source: split of `build-pr-overview`, 2026-10-15
  - Split from: `build-pr-overview`
  - Starting point: [Sign-in](docs/DELIVERABLE.md#sign-in) and acceptance check 1, and the sign-in and credential sections of [docs/specs/2026-10-12-github-integration.md](docs/specs/2026-10-12-github-integration.md). The owner is configured by account ID; the stubbed `GET /user` test with a matching username and a different ID is required.
  - This entry's gate is check 1's automated half: the stubbed `GET /user` test and tests that a refused account sees no instance data and leaves no stored credential. The manual second-account scenario moves to `build-pr-overview`, since the owner could not create a second account on 2026-10-14 ([results](docs/specs/2026-10-13-cloudflare-stack.md#github-app-checks)).
  - Includes the App's [registration and installation](docs/specs/2026-10-12-github-integration.md#registration-and-installation) setup routes, since sign-in cannot be tried by hand without them. Registering a real App creates a GitHub resource and needs the owner's word at the time.
  - Every route requires the owner's session unless it is on one explicit, tested list of unauthenticated routes (setup, sign-in and its callback, the webhook, static assets), so a later public route is an addition to that list ([public view constraints](docs/specs/2026-10-15-public-view.md#constraints-for-current-work)).

### P2 Normal

### P3 Low


- [PRODUCT] `ship-projects-cli` — **Ship a Seshat command-line tool for working with the project index locally.** Power users want to list projects by classification, run commands across them and check the index against disk without the hosted app.
  - Source: replace-projects-index decision, branch todo/replace-projects-index, 2026-10-12
  - Commands from the decision: list by classification (paths or JSON), run a command across projects in given classifications, check the file against the format and the directories on disk, and `survey`, which prints the local-only signals (checked-out branch, uncommitted and untracked files, unpushed commits, local-only branches and repositories) in a stable table and JSON form. See the Seshat CLI section of [docs/specs/2026-10-12-projects-index.md](docs/specs/2026-10-12-projects-index.md).
  - Its PR chooses the language and distribution; the hosted app's stack ([decision](docs/DECISIONS.md#2026-10-13--cloudflare-stack)) does not settle the CLI's. A TypeScript CLI can share the app's [toolchain](docs/DECISIONS.md#2026-10-15--toolchain) and the [shared parser module](docs/INDEX_FORMAT.md#implementation). Commit counts must count named branches only, not hidden refs that tools create.
  - Uses only git, with no GitHub assumption; the index repository's remote is configuration.
  - The laptop survey skill, [skills/survey-projects/SKILL.md](skills/survey-projects/SKILL.md), switches to `seshat survey --json` and `seshat check` once they exist. Its signal commands and its settings file (survey root, exclusions) are the starting point for both, so the CLI should read the same settings rather than define new ones.
  - `check` runs the shared format check and the disk check defined in [docs/INDEX_FORMAT.md](docs/INDEX_FORMAT.md), building the shared module and its conformance fixtures if `show-project-index` has not.
  - Low because the owner's existing local tool already parses the index until this replaces it ([spec](docs/specs/2026-10-12-projects-index.md#follow-up-work)).

### Unprioritized
