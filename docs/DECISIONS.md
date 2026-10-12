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
  private repository the owner selects. The file holds owner judgment and
  dated laptop observations. Seshat derives GitHub evidence live, shows it
  beside the file with its source, and never writes it back; Cloudflare
  storage holds only a cache rebuildable from GitHub and the file.
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
from the GitHub API, along with some it never had, such as open PRs, CI and
squash merges. A hosted refresh could therefore gather one context bundle per
refresh, at the cost of Contents read across monitored repositories, which
shapes `evaluate-optional-llm-refresh`.
