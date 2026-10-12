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
  with a stale flag after 7 days without activity. The owner's own green PR counts as ready to
  land without an approval.
- Changes on GitHub should reach an open page within 60 seconds, with sync
  status always visible. The owner's working hypothesis for meeting this is
  GitHub webhooks persisted in Cloudflare and pushed to a reactive frontend;
  `choose-cloudflare-stack` tests it. Bounded polling within about five minutes
  is the fallback discussed if the free tier cannot support that.
