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
