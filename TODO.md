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

## Waiting

### P0 Critical

### P1 High

- [PRODUCT] `select-monitored-repositories` — **Choose monitored repositories from each accepted installation's listing, with the owner's overrides, organization acceptance and the repositories screen.** This is acceptance check 2, and the sweep needs the monitored set before it reads any PR.
  - Source: split of `build-pr-overview`, 2026-10-17
  - Split from: `build-pr-overview`
  - Blocked by: the owner choosing an organization to monitor and authorizing the App visibility change needed for its live installation.
  - Starting point: [Monitored repositories](docs/DELIVERABLE.md#monitored-repositories), [Repository discovery and monitoring](docs/specs/2026-10-12-github-integration.md#repository-discovery-and-monitoring) and the guard's repository-selection paragraph under [Registration and installation](docs/specs/2026-10-12-github-integration.md#registration-and-installation); the Repositories screen in [docs/design/README.md](docs/design/README.md#screens).
  - Covers `GET /installation/repositories` with conditional requests and paging, keyed by repository ID; the default rules (owned by the owner, not a fork, not archived); overrides to turn any repository off and an owned fork or an accepted organization's repository on, offered only where the owner's own permission is at least read; storing each repository's visibility and listing time; and an operation that refreshes one installation's listing, which the sweep and repository deliveries in `sync-and-live-updates` call.
  - Includes the owner accepting or refusing a pending organization installation (formerly `accept-org-installations`; the sign-in PR holds one as pending with no way to accept it), and the prominent warning when the personal installation is set to selected repositories.
  - Reuses the installation-token helper from `read-prs-from-github`; repository listing and selection live in separate modules from the PR reader.
  - Gate: acceptance check 2. A repository created or archived after setup is shown by refreshing the listing; that a delivery or sweep triggers the refresh is shown in `sync-and-live-updates`. Turning a repository off removes its PRs from the snapshot.
  - Demonstrating organization opt-in requires the owner's choice to monitor
    an organization and make the private App public for installation there;
    changing App visibility needs authorization at the time. Acceptance
    check 2 remains a gate unless the owner explicitly amends it.

- [GITHUB] `sync-and-live-updates` — **Keep the stored PRs current from webhooks and sweeps, and push every change to open pages.** This is the change detection design, and what makes the overview live.
  - Source: split of `build-pr-overview`, 2026-10-17
  - Split from: `build-pr-overview`
  - Depends on: `select-monitored-repositories`
  - Starting point: [Recommended design](docs/specs/2026-10-14-change-detection.md#recommended-design) in the change detection design, within its [decision](docs/DECISIONS.md#2026-10-15--change-detection).
  - Covers reducing deliveries to marks and the facts a re-read must show, with the webhook path doing no GitHub reads; dropping deliveries from installations that are not accepted, and running the installation guard and listing refresh on `installation` and `installation_repositories` deliveries (formerly `guard-installation-webhooks`; the sign-in PR runs the guard only from the setup page); repository deliveries triggering the listing refresh; holding unmatched CI SHAs for a minute; re-reads with their 5, 15 and 30 second retries; mergeability checks; the one alarm and its re-arming; sweeps every 2 minutes only while a page has a current visible report, the catch-up sweep, dormancy, the retry before failure, the slower interval when the GraphQL budget is low and continuation across invocations; recording sync status; and pushing changes to sockets.
  - Updates each repository's visibility, and when it was last reported, from every read that stores its PRs and from every delivery's `repository` object, including `privatized`, `publicized`, `transferred` and `deleted` ([public view constraints](docs/specs/2026-10-15-public-view.md#constraints-for-current-work)).
  - Test the design's [not verified](docs/specs/2026-10-14-change-detection.md#not-verified) point about mergeability after a conflicting push to a base branch, and add its REST fallback if GitHub leaves the old value.
  - Gate: acceptance checks 5 and 6, and the end-to-end halves of check 3 (every open PR on a monitored repository appears exactly once) and check 8 (the stale flag from GitHub's activity data), by automated tests with GitHub stubbed.
  - The existing webhook only verifies signatures and acknowledges deliveries.
    Guard accepted installations before processing their data; retain the
    Worker path's no-GitHub-read boundary by running guard reads in the
    object after reduction and handoff.

- [PRODUCT] `build-pr-overview` — **Run the assembled PR overview against a real GitHub App and complete the acceptance checks that need the whole of it.** The other parts each demonstrate their own checks; this records the rest and confirms the deliverable is done.
  - Source: TODO.md triage, 2026-10-14
  - Depends on: `select-monitored-repositories`, `render-pr-overview`, `sync-and-live-updates`
  - Starting point: [Acceptance checks](docs/DELIVERABLE.md#acceptance-checks). Gate: check 9 (no paid Cloudflare service and no LLM key) and check 10 (a recorded manual review that the overview is readable on a phone and that no wording implies local evidence was inspected), with a note in the PR naming where each other check was demonstrated.
  - Verify the assembled page through the real browser, Worker and Durable Object, including the owner session, snapshot, socket updates, visibility-driven catch-up and monitoring changes. Stub GitHub for repeatable timing and failure scenarios; record real-App evidence separately. Component checks against fake sockets alone do not complete the deliverable.
  - Run on a local instance with the local App from PR #20, which has no webhook GitHub can reach, so live webhooks need a tunnel or a deployed instance; either needs the owner's word at the time.
  - Split on 2026-10-17 into `define-overview-protocol`, `read-prs-from-github`, `select-monitored-repositories`, `render-pr-overview` and `sync-and-live-updates`; earlier, `bucket-prs` and `owner-sign-in`.
  - The manual half of acceptance check 1 (a second GitHub account refused at sign-in) is waived by the owner, 2026-10-17. GitHub blocked creating a second account, and its terms allow one free account per person. The automated half landed with `owner-sign-in` (PR #19): the stubbed `GET /user` test, and tests that a refused account sees no instance data and leaves no stored credential.

### P2 Normal

- [PRODUCT] `show-project-index` — **Ingest the project index and show it beside GitHub evidence.** The index decision defines what the dashboard shows; this is the deliverable that builds it, after the PR overview.
  - Source: replace-projects-index decision, branch todo/replace-projects-index, 2026-10-12
  - Depends on: `build-pr-overview`
  - Related: `suggest-classifications`
  - Needs Contents read added to the GitHub App chosen for the integration ([decision](docs/DECISIONS.md#2026-10-12--github-integration)): for the index repository, and across monitored repositories if it shows branch and commit evidence rather than limiting GitHub evidence to Metadata and PR signals. Adding Contents applies to every repository in the installation and prompts every installation to approve.
  - Ingestion reads the index at a given commit through an interface that does not assume GitHub; the first implementation reads it from GitHub. The index stays on GitHub for now ([decision](docs/DECISIONS.md#2026-10-13--project-index-stays-on-github)).
  - Requirements are in the model and evidence-boundary sections of [docs/specs/2026-10-12-projects-index.md](docs/specs/2026-10-12-projects-index.md): per-field provenance and survey dates, "not reported" rather than "none", rename-safe joins, last good parse kept on errors, and a warning when the index repository is public.
  - Parses the index with the shared `parseProjectIndex` module and conformance fixtures in `src/shared/projects/`, following [docs/INDEX_FORMAT.md](docs/INDEX_FORMAT.md#implementation).
  - Serves nothing from the index on an unauthenticated route; publishing entries is `publish-index-entries` ([public view constraints](docs/specs/2026-10-15-public-view.md#constraints-for-current-work)).

  - From the [classifications decision](docs/DECISIONS.md#2026-10-15--project-classifications): sections are shown in the file's order with unknown names as written; laptop observations that change day to day (`Last commit`, `Checked out`, `Branches`, `Unpushed`, `Uncommitted`) carry a warning when their survey is more than 30 days old, and a survey date after today is flagged ([laptop evidence age](docs/specs/2026-10-15-project-classifications.md#laptop-evidence-age)); an Upstream entry whose repository is outside the installation is described as not visible to the GitHub App. Suggestions themselves are `suggest-classifications`.

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

## Ready for separate work

### P0 Critical

### P1 High

- [PRODUCT] `render-pr-overview` — **Build the overview page: buckets and rows from the snapshot, live changes, the sync status states and the visibility reports that drive sweeps.** The page can be built against fixture snapshots and a fake socket while sync is built.
  - Source: split of `build-pr-overview`, 2026-10-17
  - Split from: `build-pr-overview`
  - Starting point: [PR overview](docs/DELIVERABLE.md#pr-overview), [Freshness](docs/DELIVERABLE.md#freshness) and [Evidence boundary](docs/DELIVERABLE.md#evidence-boundary); [Sync status on the overview](docs/specs/2026-10-14-change-detection.md#sync-status-on-the-overview) and the page's side of [When the object sweeps](docs/specs/2026-10-14-change-detection.md#when-the-object-sweeps); the prototype and its [notes for implementation](docs/design/README.md#notes-for-implementation). The page renders what `buildOverview` returns and recomputes nothing about buckets.
  - Covers the summary strip, groups and buckets with their rules in words, rows with every field in [Row contents](docs/DELIVERABLE.md#row-contents) and the stale badge, empty states, and the initial-load state; applying changes from the socket and marking changed rows; Live, Checking, Overdue, Sync failed and Disconnected judged on the page's own clock with the object's clock correction, reconnection, "Retry now" and the overdue message; visibility reports on connect, on `visibilitychange`, every 10 minutes while visible and after a timer gap of more than a minute; and the narrow layout.
  - From the design notes: fonts served from the instance, no nested interactive elements in rows, and "by you" describing only the owner's own review.
  - Gate: acceptance checks 4 and 7.

### P2 Normal

- [GITHUB] `rate-limit-sign-in-callback` — **Limit sign-in callback token exchanges to reduce abuse of the App's OAuth token budget.** GitHub allows 2,000 OAuth token requests an hour per app, and every refused sign-in spends one, which could lock the owner out.
  - Source: owner-sign-in, branch todo/owner-sign-in (PR #19), 2026-10-16
  - Starting point: `finishSignIn` in `src/worker/auth.ts`. Check a
    per-client attempt limit, using trusted `CF-Connecting-IP`, after state
    validation and before `exchangeCode`; limiting only after refusal has
    already spent the token request. A single instance-wide cap could let
    one stranger lock the owner out. State validation already stops callbacks
    without a valid cookie, but anyone can get one from `/auth/sign-in`.
  - Verify that an over-limit callback makes no GitHub call, another client
    can still sign in, and counters expire and stay bounded. Preserve the
    sign-in decision's boundary against durable rows for anonymous attempts
    or stored refused-account credentials. Per-client limits mitigate abuse;
    they do not guarantee an app-wide budget against distributed clients.
  - The [rate limits](docs/specs/2026-10-12-github-integration.md#rate-limits) section already asks implementation to rate-limit; the sign-in PR does not. Any limiter has to live in the Durable Object or a Workers binding within the [stack decision](docs/DECISIONS.md#2026-10-13--cloudflare-stack).

- [TOOLING] `check-worker-first-paths` — **Test that every route the Worker serves is covered by `run_worker_first` in `wrangler.jsonc`.** The Workers tests call the Worker directly, so a route missing from that list passes the tests and is then served as the static page.
  - Source: owner-sign-in, branch todo/owner-sign-in (PR #19), 2026-10-16
  - The route table is in `src/worker/routes.ts`; `run_worker_first` currently
    lists `/api`, `/api/*`, `/auth/*`, `/setup` and `/setup/*`. All current
    routes are covered, so this prevents regressions. Include exact-path and
    wildcard semantics and keep frontend assets served without invoking the
    Worker; setting `run_worker_first: true` would defeat that constraint.

### P3 Low

### Unprioritized
