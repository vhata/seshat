# Decisions

## 2026-10-11 — Foundation before application

The owner authorized a documentation scaffold followed by a public GitHub
repository and full Docket installation. Workflow shell scripts, hooks and CI
are in scope; application code and dependency selection are deferred.

The basic dashboard targets Cloudflare's free tier. Optional LLM calls would
use an owner-supplied key and incur separate provider costs. No architecture
or provider has been chosen; see [the brief](BRIEF.md).

Use a tracked `.githooks/` directory with repository-local `core.hooksPath` so
workflow setup needs only Git and Bash and works in linked worktrees. Hooks
check without rewriting content. Checks inspect the current worktree, including
unstaged changes; they do not prove the staged snapshot is independently valid.
CI checks the committed PR merge tree.

Install an empty review index and backlog without inventing a baseline review.
Defer scheduled extended validation until there are meaningful extended checks.
GitHub protection is recommended, not configured as part of installation.

## 2026-10-11 — First deliverable is the PR overview

The first deliverable is an overview of open pull requests on monitored
repositories, defined with acceptance checks in [DELIVERABLE.md](DELIVERABLE.md).
Project classifications wait: PR signals come directly from GitHub, while
classifications need owner judgment and override rules that deserve their own
design. The PR overview also exercises sign-in, change detection and live
updates early.

- PRs in scope are those on monitored repositories, opened by the owner or by
  anyone else, bots included. PRs the owner opened elsewhere and review
  requests in other owners' repositories are deferred to `track-upstream-prs`
  and `show-review-requests` in [TODO.md](../TODO.md).
- Monitoring defaults to every non-archived, non-fork repository the owner's
  personal account owns, with per-repository overrides. Forks and organization
  repositories are opt-in. Explicit per-repository opt-in was rejected because
  it hides new repositories until the owner adds them; rule-based selection was
  deferred as more to build and explain than the first cut needs.
- PRs are sorted into ordered buckets (ready to land, broken, awaiting your
  review, changes requested on yours, CI running, waiting on the author, draft),
  with a stale flag after 7 days without activity. The owner's own green PR
  counts as ready to land without an approval. Drafts always sit in the draft
  bucket, even when failing, because work in progress is expected to break. An
  approval lapses when new commits are pushed, so an approved PR that changes
  returns to awaiting review.
- Changes on GitHub should reach an open page within 60 seconds, with sync
  status always visible. The owner's working hypothesis for meeting this is
  GitHub webhooks persisted in Cloudflare and pushed to a reactive frontend;
  `choose-cloudflare-stack` tests it. Bounded polling within about five minutes
  is the fallback discussed if the free tier cannot support that.

## 2026-10-12 — Prototype differences and bucket ordering

The Claude Design prototype of the PR overview, kept as a reference in
[design/README.md](design/README.md), disagreed with the bucket rules in
[DELIVERABLE.md](DELIVERABLE.md) in three cases. The owner settled them:

- Someone else's PR the owner has not reviewed stays in awaiting your review
  while its CI runs, as the deliverable already said. Reviewing need not wait
  for CI.
- Mergeability that GitHub is still computing counts as no conflicts, as the
  deliverable already said. The state is usually resolved within seconds, and
  the row says it is being checked.
- Only trusted reviewers, those with write, maintain or admin permission on the
  repository, affect review state. Someone else's PR approved on its current
  head by a co-maintainer is ready to land without the owner's review; an
  approval from a passer-by on a public repository counts for nothing. The
  same rule applies to requests for changes, so a passer-by cannot block a PR
  or move the owner's PR into changes requested; permission is read as it
  stands when a PR is bucketed, so removing a collaborator withdraws their
  earlier approvals; and reviews from bots and GitHub Apps are ignored. All of
  this matches whose reviews GitHub counts towards required reviews.

Rows within a bucket follow the prototype's proposal: longest waiting first in
Needs you, latest activity first in Waiting. A tie-break by repository and PR
number was added so the order is deterministic, and the prototype's column
sorting is left out of the first deliverable as more than it needs.

## 2026-10-12 — GitHub integration

Each instance owner registers their own GitHub App and installs it on their
personal account with access to all repositories. The full comparison,
permissions, events and credential lifecycle are in
[specs/2026-10-12-github-integration.md](specs/2026-10-12-github-integration.md).
A GitHub App is the only option that hears about a personal account's new
repositories without polling, since user accounts cannot have webhooks; it can
be limited to read-only access; and its credentials are either short-lived
installation tokens or a private key that never leaves the instance.

- The app is registered through GitHub's manifest flow, which fills in the
  registration so the owner does not copy a dozen settings by hand.
  Installing with all repositories, not selected ones, is what lets
  repositories created after setup be monitored without owner action.
- Sign-in uses the app's user authorization. Seshat compares the account ID
  from `GET /user` with the configured owner ID, then revokes the user token;
  for any other account it deletes the authorization on GitHub, so nothing is
  left stored for them. Data is read with installation tokens, so no user token
  is kept, the owner's included. Later features that must act as the owner can
  add a stored token with its own lifecycle if they need one.
- Permissions are read-only Metadata, Pull requests, Checks and Commit
  statuses, with no organization or account permissions. Contents, Issues and
  Members are left out for the first deliverable. Contents and Issues would
  add push and top-level comment events but grant reading all code and
  issues; Members would add collaborator-change events, but as an
  organization permission it would stop repository admins installing the
  app. Revisit when change detection, ingesting the projects index or hosted
  refresh needs them.
- The app starts private and is made public when the first organization is
  added, because a private app cannot be installed on another account. An
  installation guard ships from the start: it accepts the owner's personal
  installation, holds organization installations until the owner accepts them,
  and deletes any other, so a public app stays safe.
- The setup page shows the app's credentials once for the owner to store as
  secrets, unless `choose-cloudflare-stack` finds encrypted storage that is as
  good. That keeps the private key out of instance storage without giving the
  instance a Cloudflare API token.

Rejected: an OAuth App needs the `repo` scope, which is full read and write,
and must create a webhook on every repository; a fine-grained personal access
token cannot sign anyone in and needs one token per account and manual
rotation; a stored owner user token serves nothing in the first deliverable;
and installing on selected repositories would hide new ones.

The owner asked whether simply pasting a GitHub token would do instead of
authorizing an app. A token does not sign the browser visitor in, so
owner-only sign-in would still need an app. With a token or an OAuth App, push
notifications also need a webhook created on each repository, which takes
admin rights on it and a write-capable scope, plus polling to find new
repositories, because user accounts cannot have webhooks. The owner agreed it
gains nothing. The owner also asked whether setting up an app is complicated:
with the manifest flow it is a few confirmations on GitHub plus storing the
credentials it returns (see
[Setup burden](specs/2026-10-12-github-integration.md#setup-burden)).

## 2026-10-12 — Project index source of truth

The owner accepted the proposal in
[specs/2026-10-12-projects-index.md](specs/2026-10-12-projects-index.md),
answering all six of its questions as recommended:

- The project index that replaces `PROJECTS.md` is Markdown in a dedicated
  private git repository the owner selects, hosted on GitHub for now. The file
  holds owner judgment and dated laptop observations. Seshat derives GitHub
  evidence live, shows it beside the file with its source, and never writes it
  back; Cloudflare storage holds only a cache rebuildable from GitHub and the
  file.
- The laptop agent pushes directly after the owner approves its diff in the
  session, and opens a draft PR only when it runs unattended, so unread
  generated content never appears in Ready to land.
- The file stays a complete standalone survey: last commit and branches are
  kept as dated local observations, so the file stays useful without Seshat.
- Names and summaries of local-only repositories may live in the private index
  repository and in Seshat's storage. The survey prompt excludes work
  checkouts and observations about files that are not projects.
- Seshat writes nothing to the index until `evaluate-optional-llm-refresh` is
  decided. After that, refresh writes only by PR, one at a time, from a
  non-owner identity where the integration allows it and otherwise as a
  draft, and is never triggered by a push to the index repository.
- The section an entry sits under is its authoritative classification.
  Computed classifications are only ever shown as suggestions; thresholds and
  presentation wait for `design-project-classifications`.

Rejected: dashboard storage as the source of truth, as the most to build, with
no history or portability and a new laptop credential; two-way sync, as the
costs of both stores plus conflict resolution between them; storing
GitHub-derived facts in the file and keeping them current from Seshat, as
commit noise and duplicated facts that drift; direct hosted commits for
generated content, as unreviewed changes to owner judgment; and a PR for every
laptop survey, as repeating a review the owner already did in the session.

The owner added two inputs. Seshat should include a command-line tool for
power users that works on a clone of the index (list by classification, run a
command across projects, check against disk) plus a `survey` command that
prints the local-only signals in a stable form for the laptop agent
(`ship-projects-cli`). And most signals a laptop survey reads are available
from the GitHub API, along with some it lacked, such as open PRs, CI and
reliable squash-merge detection. A hosted refresh could therefore gather one
context bundle per refresh. Commits, branches, READMEs and other files all need
Contents read, so that bundle, and any branch or commit evidence that
`show-project-index` shows, needs Contents read across monitored repositories;
only last push, archived, fork parent, visibility, PR state and CI are
available without it. This shapes `show-project-index` and
`evaluate-optional-llm-refresh`.

On 2026-10-13 the owner asked three questions about where the index lives,
recorded in the spec:

- The owner's fork of Seshat is ruled out: forks of a public repository are
  public and a fork's visibility cannot be changed by itself. A private copy,
  imported or mirrored rather than forked, is allowed but not recommended,
  because it mixes instance deploys and upstream updates with index commits.
- Cloudflare storage with a utility that syncs to the laptop and works offline
  stays rejected. It is dashboard storage plus two-way sync, and git already
  gives offline editing and later sync with merges, history and backups; its
  gains are smaller than the cost of a sync protocol, conflict handling, a CLI
  credential, history and export.
- A git repository hosted on Cloudflare is feasible in principle, since
  open-source git servers on Workers, Durable Objects and R2 exist. It would
  mean a public push endpoint and a canonical copy held by Seshat, a
  Seshat-issued token on the laptop, and losing GitHub editing, CI checks and
  PRs, and whether it fits the Workers Free CPU limits is unverified. Its
  main saving, the index-specific Contents grant, is small because
  `show-project-index` needs Contents across monitored repositories anyway.

Decided: the index is Markdown in a private git repository, hosted on GitHub
for now, and where it is hosted stays open. The laptop agent and the CLI
assume only git, with the remote as configuration, so moving the index is a
remote change. Seshat's ingestion reads the index at a commit through an
interface that does not assume GitHub, though the first implementation uses
GitHub. Self-hosting on Cloudflare goes to a proof of concept,
`self-host-index-repo`.

## 2026-10-13 — Cloudflare stack

The owner accepted the proposal in
[specs/2026-10-13-cloudflare-stack.md](specs/2026-10-13-cloudflare-stack.md),
answering its questions as recommended. A throwaway spike on a Workers Free
account carried real GitHub deliveries to an open socket in about 1 to 3
seconds, so the owner's working hypothesis holds and the bounded-polling
fallback is not forced.

- Each instance is one Worker, written in TypeScript, that serves the frontend
  as static assets, receives GitHub webhooks, runs sign-in and serves the API.
- All instance state lives in one SQLite-backed Durable Object per instance,
  which also holds every open browser connection through hibernatable
  WebSockets. The Worker verifies a webhook and hands it to the object, which
  stores it, updates the model and pushes the change to every open page.
- Heavy work (GitHub reads, parsing, bucketing) runs in the object, where the
  spike completed invocations of up to 18 seconds of CPU on Free; the Worker's
  own paths stay within the documented 10 ms. Cloudflare's documentation gives
  both 10 ms and 30 s for objects on Free and enforcement could change, so
  each invocation stays well under 30 s and is measured. Reconciliation runs
  from an alarm or a Cron Trigger in batches of at most 50 GitHub requests,
  the Free plan's per-invocation subrequest limit. How often, and how missed
  events are caught up, is left to `choose-change-detection`.
- The frontend is React built with Vite to static files. On connecting it
  receives a snapshot of the model, then a message per change.
- No other storage or background product: KV, D1, R2, Queues, Workflows and
  Secrets Store are not used for the first deliverable.
- Credentials stay Worker secrets that the owner sets, as the GitHub
  integration decision chose, because the Free plan has no encrypted store a
  Worker can write itself. The Worker converts the PKCS#1 key GitHub issues,
  so the owner pastes it unchanged.

Free-plan quotas belong to the Cloudflare account and are shared with the
owner's other Workers, and going over the daily rows-written quota stopped a
spike's objects even for reads because they wrote on start-up. The
implementation therefore keeps writes out of object constructors and bounds
its writes; these and the other limits it must respect are under [Constraints
for implementation](specs/2026-10-13-cloudflare-stack.md#constraints-for-implementation).

Rejected: KV for webhook state (1,000 writes a day and eventual consistency);
D1 (the same quotas, a second component, and pushing to browsers still needs a
Durable Object); R2 (enabling it needs a subscription and a payment method);
server-sent events from the Worker (a stateless Worker cannot fan out to other
tabs); polling from the page except as the resync on reconnect; Queues and
Workflows, since alarms on the one object give scheduling and retries without
another product. Preact and a page without a framework were the frontend
alternatives; React was chosen for its ecosystem.

The owner ran the GitHub App checks the queue entry asked for on 2026-10-14
UTC ([results](specs/2026-10-13-cloudflare-stack.md#github-app-checks)). A
repository created after installing with All repositories was delivered
within seconds and listed by `GET /installation/repositories`, so new
repositories are monitored without owner action. Revoking the owner's user
token also invalidated its refresh token, so sign-in needs neither fallback in
the GitHub integration spec. Whether another
GitHub user can authorize a private app owned by a personal account was not
checked, for want of a second account; Seshat's account-ID check refuses other
accounts either way. All three spike Workers were deleted with their data on
2026-10-14 UTC.

## 2026-10-13 — Project index stays on GitHub

The owner accepted the recommendation in
[specs/2026-10-13-self-host-index-repo.md](specs/2026-10-13-self-host-index-repo.md)
to rule out hosting the project index repository on Cloudflare for now. This
settles where the index is hosted, which the
[project index decision](#2026-10-12--project-index-source-of-truth) left open.

A git server on Durable Objects does run on Free and serves a small index with
little CPU, but the one candidate that runs without R2 has four days of public
history by one author, gating reads needed a wrapper around it, a single bulk
push exhausted the account's daily Durable Object write quota, and the index
would lose GitHub's web and mobile editing, CI checks and PRs. The saving, an
index-specific Contents grant, is small because `show-project-index` needs
Contents across monitored repositories anyway.

The index stays in a private GitHub repository. The laptop agent and the CLI
still assume only git, and Seshat's ingestion still reads the index through an
interface that does not assume GitHub, so the index can move later with a
remote change if a better-maintained server appears.

## 2026-10-15 — Project index format

The owner accepted format 1 of the project index, defined in
[INDEX_FORMAT.md](INDEX_FORMAT.md), answering three of its four questions as
recommended and settling the remaining one, on labels, by keeping those the
current file already uses.

- `##` sections are classifications and `###` headings are entries, read as
  CommonMark block structure. An entry's first bullet list holds its
  `Label: value` fields, in plain or bold-label form; unlabelled items and
  everything else in the entry are its summary.
- An entry is keyed by `Remote` (`owner/name`) when it names a repository and
  by `Path` otherwise. The heading is a display name only. `Path` is relative
  to a survey root each machine configures, which Seshat never knows.
  `Remote: none` records a local-only project, distinct from an absent field.
- `Surveyed: YYYY-MM-DD` on each entry dates its laptop observations, and
  Seshat does not show observations from an entry without one.
- Only the structure, the key, `Surveyed` and a `Format` version are checked.
  Other values are text, shown as written. Unknown fields and section names
  are kept, shown as written and preserved by every writer.
- One shared check, a pure function of the file, reports problems with stable
  codes. Only ambiguities are errors, which leave Seshat on its last good
  parse; everything else is a warning. Checks against the disk belong to the
  CLI.
- The labels are those of the owner's current file where it has them
  (`Remote`, `Next`, `Note`, `Path`, `Stack`, `Started`, `Last commit`,
  `Branches`, `Unpushed`), with `Checked out`, `Uncommitted` and `Surveyed`
  added.

Migrating the current file mostly adds a `Path` to each entry, since the
format no longer implies the path from the heading, reduces each `Remote` to
exactly `owner/name` or `none`, and replaces the file-wide survey date with
per-entry `Surveyed` lines.

## 2026-10-15 — Application work begins

The owner authorized application code and installing dependencies, lifting
the deferral recorded in
[Foundation before application](#2026-10-11--foundation-before-application).
The first deliverable, the stack, GitHub integration and the project index
format are settled enough to build against; open questions stay in
[TODO.md](../TODO.md) and are settled by their own entries rather than held
as a reason not to start.

- Work starts with `scaffold-worker-app`: the Worker, Durable Object and
  React frontend, with type checks and tests in `scripts/check.sh`, the hooks
  and CI. Bucketing (`bucket-prs`) and owner sign-in (`owner-sign-in`) need no
  change-detection choice and follow it; the rest of the overview
  (`build-pr-overview`) waits for `choose-change-detection`.
- Dependencies are chosen in the PR that adds them, within the stack decision.
  The CLI's language is chosen in its own PR, since the stack does not settle
  it.
- Deploying stays a separate step: each deploy needs the owner's word at the
  time, as Docket requires, and so does creating or changing Cloudflare or
  GitHub resources such as registering the GitHub App.
- Changing CI or hooks still needs the owner's word in the turn it is made,
  as Docket requires; the scaffold is the first PR that will ask.

## 2026-10-15 — Change detection

The owner accepted the proposal in
[specs/2026-10-14-change-detection.md](specs/2026-10-14-change-detection.md)
after reshaping it, and answered its remaining questions as recommended. The
first version swept GitHub every 2 minutes around the clock; the owner
objected that this checks GitHub when nobody is looking, and directed that
Seshat check it only while someone is.

- **Webhooks mark PRs for re-reading.** The Durable Object re-reads marked
  PRs from GitHub's GraphQL API about 2 seconds after the first mark, checks
  each read against the facts the deliveries reported, and reads again 5, 15
  and 30 seconds after the first read while any are missing. Payloads are
  never written into the model, so delivery order and duplicates do not
  matter. This replaces three points of the [stack
  decision](#2026-10-13--cloudflare-stack): the object stores marks rather
  than deliveries, and keeps no delivery-ID de-duplication or delivery log.
  The stack is otherwise unchanged.
- **A sweep reconciles.** For each accepted installation it lists the
  repositories, counts open PRs per repository in one query, and reads only
  the repositories that have some, which cost about 8 GraphQL points for the
  owner's 48 monitored repositories. It catches lost deliveries and the
  changes the app is never told about: top-level comments, reviewer
  permission changes and conflicts caused by a push to a base branch. Failed
  deliveries are not replayed from GitHub's delivery log.
- **Sweeps run only while an overview is visible**, as the browser reports
  it. Pages report their visibility to the instance; a session, an open
  socket in a background tab and a periodic ping that wakes the instance were
  each rejected as the signal. While none is visible, webhooks and the reads
  they trigger carry on, so stored data stays close to current, but changes
  GitHub did not report wait until an overview is next visible.
- **While an overview is visible** the sweep runs every 2 minutes. A page
  that becomes visible gets a catch-up sweep at once when the last one is
  more than 2 minutes old, and says it is checking rather than opening on an
  overdue banner. The owner's first suggestion of 10 more minutes of sweeps
  after the last page closes was dropped: nothing reads the data in that
  time, and the next page needs a catch-up sweep anyway.
- **Bounds.** Missed changes appear within 5 minutes while an overview is
  visible and within 3 minutes of one becoming visible. A sync is overdue
  when the last successful sweep started more than 5 minutes ago and the page
  has been visible for a minute, and failed when a sweep and one retry fail.
  The page judges this on its own clock.
- **Mergeability** still being computed is re-read through the REST
  endpoint, which GitHub documents as starting the computation.
- **No new GitHub permissions.** Contents and Issues stay out; the sweep
  meets the catch-up bound without them, which settles the change-detection
  condition the [GitHub integration decision](#2026-10-12--github-integration)
  left for revisiting them. `show-project-index` may still need Contents.
- **No Cron Trigger.** One alarm schedules re-reads, mergeability checks and
  sweeps, and every request into the object re-arms it; nothing needs to run
  on a timer while no page is visible.
- [DELIVERABLE.md](DELIVERABLE.md#freshness) says all of this plainly,
  including which changes GitHub never reports to the app.

Rejected: applying webhook payloads to the model directly (fragments, out of
order, with no reviewer permission or mergeability); polling without
webhooks (slower and dearer); replaying GitHub's delivery log (it misses
changes GitHub never reports, so a sweep is needed anyway); sweeps that read
every repository (GraphQL charges for the page sizes requested, 96 points
for the owner's repositories), use search (not documented as current) or use
REST (about 220 subrequests a sweep); and sweeping around the clock, which
at the measured cost was about 3% of the installation's GitHub budget and
under 1% of Cloudflare's daily requests, all of it spent whether or not
anyone looked.

## 2026-10-15 — Hosted LLM refresh waits

Seshat does not build hosted LLM refresh of the project index now. The
evaluation, and the design refresh would follow if it is built later, are in
[specs/2026-10-15-llm-refresh.md](specs/2026-10-15-llm-refresh.md).

- Refresh could only propose changes to owner judgment (summaries, next
  actions, sections and entries for repositories without one), since GitHub
  evidence is shown live and never written to the index. The laptop agent
  (`write-survey-prompt`) already proposes the same changes with the owner
  present, sees local evidence refresh cannot, and needs nothing new from
  Seshat.
- Refresh would need Contents and Pull requests write on the index
  repository. On the instance's one GitHub App that write access would reach
  every repository the owner owns, and confining it takes a second App. Its
  richer bundle would also need Contents read across every repository in the
  installation.
- Nothing reads the index yet, so there is no evidence that owner fields go
  stale between laptop surveys, which is the only problem refresh solves.
- Seshat therefore still writes nothing to the index, as the [project index
  decision](#2026-10-12--project-index-source-of-truth) required until this
  was decided.

Refresh is revisited, as `build-hosted-refresh`, once `show-project-index` is
built and in use, `write-survey-prompt` is in use, and the owner finds that
owner fields still go stale between surveys. When built, it follows the
recorded design:

- Runs start only at the owner's request or when a weekly schedule, off by
  default, is due and an overview is visible; never from a push, a merged
  refresh PR or any webhook.
- Seshat gathers the bundle; the model gets no tools. By default it receives
  the index entries for monitored repositories, repository metadata, and PR
  and CI state, which need no read permission beyond the index
  repository; commit subjects, branches, READMEs and queue files are added
  only where the App has Contents read and the owner has consented.
  Local-only entries, laptop observations, code, diffs, comments and
  titles of other accounts' PRs are never sent.
- The model returns structured proposals. Seshat discards any that touch
  anything but owner fields and sections, applies the rest by the index
  format's writing rules, and opens or updates one PR from one branch.
- Writes go through a second GitHub App installed only on the index
  repository, with Contents and Pull requests write, so the PR is authored
  by its bot. It lands in Awaiting your review when the index repository is
  monitored, and is always shown beside the index and on the refresh
  settings page, since turning monitoring off removes a repository's PRs
  from the overview.
- The owner supplies an Anthropic or OpenAI key as a Worker secret, ideally
  in a dedicated workspace or project with a provider spend limit. Without a
  key nothing changes.
- Consent names the provider and what is sent, previews the bundle, and is
  asked again when what is sent widens. Refresh does not run while the index
  repository is public.
- Default caps are 150,000 input and 16,000 output tokens per run and 3 runs
  a day. As an estimate from 2026-10-15 prices, a typical run on a mid-priced
  model costs about 8 cents with the default bundle and 15 with the richer
  one.

Rejected: building now on the one App, letting the model rewrite the whole
file, running on a bare timer, a personal access token for the index
repository, keeping the key in Durable Object storage, and Workers AI's free
allocation for now.

## 2026-10-15 — Public view

Seshat will offer a public view, later and opt-in, under the design in
[specs/2026-10-15-public-view.md](specs/2026-10-15-public-view.md). It is not
part of the first deliverable: `build-public-view` follows the PR overview,
and `publish-index-entries` follows `show-project-index`. Until then, current
work only keeps it possible.

- **Nothing is public by default.** The view is off until the owner turns it
  on, and then publishes nothing until the owner publishes a repository.
  Consent is per repository, given by the signed-in owner, and holds only
  while the repository is monitored and GitHub reports it as public. A
  repository that becomes public later is not published without the owner.
  A repository that becomes private or internal, is transferred or is deleted
  loses its consent; making it public again does not republish it. Consent
  records the owner account ID, so a read reporting a different owner
  clears it even if the `transferred` delivery was lost, and so does a
  complete repository listing that no longer includes it, which also
  covers a repository deselected from an installation. If both visibility
  deliveries are lost and the repository is public again by the next read,
  the consent survives, since GitHub reports no visibility history.
- **Withheld unless confirmed public in the last 24 hours.** GitHub does not
  redeliver a lost `privatized` delivery and nothing sweeps while no owner
  overview is visible, so a published repository is shown only if a GitHub
  read reported it public within the last 24 hours. A missed change to
  private therefore leaves earlier PRs public for at most a day, without a
  timer or reads started by visitors; a quiet repository drops off the page
  after a day with no owner visit or activity, and returns on the next read.
- **A fixed field list, not per-field settings.** A published repository
  shows its open PRs with the facts GitHub shows anyone on the PR's page:
  number and link, title, author, draft state, opened and last active, and
  the combined CI result. Buckets, review state, reviewers, branch names,
  check details, conflict state, instance settings and sync errors are not
  shown. Private and internal repositories never appear, not even as a
  count.
- **Index entries need their own consent.** Only an entry joined to a
  published repository can be published, and only its name, classification
  and summary. Consent binds to that text, so a change withholds the entry
  until the owner confirms it. `Next`, `Note`, `Path`, laptop observations
  and local-only entries are never public. Consent lives in instance
  settings, not the index file, which agents write; losing it publishes
  nothing.
- **Served as a snapshot by the same Worker.** A rotatable random path
  returns, without sign-in and whoever asks, a projection built by one
  allowlist function in the Durable Object. It opens no socket, writes
  nothing to storage and never makes the object sweep, which settles the
  reader rule the [change detection
  decision](#2026-10-15--change-detection) left open. Responses carry
  `X-Robots-Tag: noindex`, `Referrer-Policy: no-referrer` and
  `Cache-Control: private, max-age=60`. The page says that each
  repository's visibility was confirmed within the last day and that
  notified changes since are included, not that every row was re-read, and
  gives no exact sync time, which would say when the owner last had Seshat
  open. It is served from a custom domain with the `workers.dev` route off
  where the owner has one, because a `workers.dev` link discloses the
  account subdomain and with it the likely addresses of the owner's other
  Workers; preview URLs are turned off too.
- **Withdrawal takes effect on the next request.** Public responses go into
  no Cloudflare cache, so nothing needs purging; browsers may reuse a copy
  for a minute. The Cache API purges one data center at a time, and Workers
  Cache, though it can purge globally from the Worker, still bills every hit
  as a Worker request, works under the Free purge limits and documents no
  propagation time. The settings say that copies others made cannot be
  recalled, and that the page draws on the account's shared free quotas.

Constraints on current work, added to their queue entries: `owner-sign-in`
requires the owner's session on every route except one explicit, tested list;
`build-pr-overview` stores each repository's visibility, and when a read
last reported it, with every read and delivery, and treats anything but
public as private; `show-project-index` serves nothing from the index on an
unauthenticated route. None adds a GitHub permission, storage product or
credential.

Rejected: publishing every public repository automatically; field-level
consent; redacted rows or counts for private repositories; publishing buckets
and review state; live updates for visitors; letting a public page start
sweeps; a timer that confirms published repositories' visibility, which
would run while nobody is looking; a separate GitHub read with a narrowed
installation token; hosting the page elsewhere, which needs a write
credential; edge caching with purge; and consent recorded in the index
file.

## 2026-10-15 — Project classifications

Project classifications and the suggestions Seshat computes for them follow
[specs/2026-10-15-project-classifications.md](specs/2026-10-15-project-classifications.md),
with its owner choices as recommended. This settles what the
[project index decision](#2026-10-12--project-index-source-of-truth) left for
`design-project-classifications`. The index format is unchanged.

- **Classifications.** Seshat knows the brief's seven (Active, Cooling,
  Stranded, Dormant, Thin, Upstream, Archived) by exact section name. Other
  sections, including one for directories that are not projects, are shown
  as written and get no suggestions. Sections appear in the file's order.
- **The owner's section stands.** Seshat never moves, hides or re-sorts an
  entry. When the evidence does not fit the owner's section it shows one
  suggested classification as a secondary marker on the row, with the rule
  and each dated fact and its source, a count and filter in the index view,
  and how to accept it by moving the entry in the file. Suggestions stay out
  of the PR overview and notifications. A monitored repository with no entry
  shows its suggestion as a hint for where to add one.
- **Signals.** Last activity, from GitHub's last push (ignored when it
  matches a bot PR's head commit), the head commits of the owner's open PRs
  and the laptop `Last commit`; first activity, from GitHub's creation date
  and the laptop `Started`; GitHub's fork and archived flags; and loose
  ends, meaning unpushed or uncommitted work on the laptop or a stale PR of
  the owner's. All are available under the App's current permissions;
  Contents read would improve them and is not required. PRs are read only
  for monitored repositories, so for an entry whose repository is not
  monitored PR loose ends are not reported, and the last push, which cannot
  be checked against bot PRs, is used unchecked for a fork, where Dependabot
  is off unless the owner turns it on, and ignored otherwise. With no dated
  activity, only the archived and fork rules apply.
- **Thresholds**, as starting values changed by PR: the owner's Active fits
  under 45 quiet days, Cooling from 14 to 180, Dormant from 90, and Stranded,
  Thin and Archived from 14; Upstream always fits; when GitHub reports the
  repository archived, Archived fits whatever the quiet days, and no other
  section fits. When the section does not fit, the suggestion is the first of
  Archived (archived on GitHub), Active (under 30 quiet days), Upstream (a
  fork), Thin (under 14 days of activity), Stranded (loose ends), Cooling
  (under 120 quiet days) and Dormant. The wider fit bands keep a project near
  a boundary from flipping.
- **No expiry.** An owner classification lasts until the owner changes it;
  quiet time raises a suggestion instead. Seshat keeps no record of rejected
  suggestions, since its storage holds only what it can rebuild.
- **Laptop evidence age.** Observations that change day to day carry a
  warning when their survey is more than 30 days old, and are then not used
  for suggestions, so a local-only entry with an older survey gets none. A
  survey date after today is flagged and not used.
- **Several repositories.** One entry per repository for now, each
  classified on its own; grouping waits for `group-multi-repo-projects`. An
  Upstream entry whose repository is outside the installation is described
  as not visible to the GitHub App.
- **No dashboard editing yet; `edit-index-from-dashboard` decides it.**
  Seshat still writes nothing to the index. If editing is built, its writes
  go through the second App, installed only on the index repository, that
  the [refresh decision](#2026-10-15--hosted-llm-refresh-waits) records, and
  a dashboard accept opens a PR unless the owner amends the index decision's
  rule that hosted code moves entries between sections only through a PR
  the owner merges.

Rejected: moving entries to their suggested section; storing dismissed
suggestions; a single set of thresholds, which flips near boundaries;
suggesting from local branches; suggesting Archived from long quiet; and a
mapping of section names to classifications. Implementation is
`suggest-classifications`, after `show-project-index`.

## 2026-10-15 — Toolchain

Chosen in `scaffold-worker-app`, within the
[stack decision](#2026-10-13--cloudflare-stack).

- **npm** manages dependencies, with `package-lock.json` committed. It ships
  with Node, so setup and CI need no extra tool. Node's major version is in
  `.node-version` (24, a long-term support line), which CI reads.
- **Dependency install scripts stay off.** `scripts/setup.sh` runs
  `npm ci --ignore-scripts`, and `package.json` records `allowScripts`
  denials for the packages that have them. workerd and esbuild ship their
  binaries as platform packages, so their install scripts are not needed.
- **Vite with the Cloudflare plugin** builds the frontend and the Worker
  together, and `npm run dev` runs both in the local Workers runtime with
  the Durable Object. Wrangler stays the deploy tool, and nothing here
  deploys.
- **Vitest** runs the tests in two projects: Worker and object code in the
  Workers runtime through `@cloudflare/vitest-plugin` (the renamed
  `@cloudflare/vitest-pool-workers`), and pure logic under `src/shared/` in
  Node.
- **TypeScript 7** type-checks the frontend, the Worker and the build
  configuration as separate projects. The Worker's runtime and binding
  types are generated by `wrangler types` from `wrangler.jsonc` on setup and
  on every check, rather than committed, so they cannot drift.
- **Schema migrations** are numbered and run on the object's first use, not
  in its constructor, and write only when one is pending
  ([constraints](specs/2026-10-13-cloudflare-stack.md#constraints-for-implementation)).

Rejected: pnpm (faster installs, but one more tool to install for a project
this size); `@cloudflare/workers-types` instead of generated types (the
generated file matches the compatibility date and bindings); running every
test in the Workers runtime (pure logic tests would then depend on it for no
gain).
