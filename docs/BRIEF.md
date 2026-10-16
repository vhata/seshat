# Seshat project brief

Source: owner's project request, 2026-10-11. This brief records intent and open
questions; it does not claim implemented capabilities or a settled architecture.

## Intended outcome

Give a heavy GitHub user one place to see the state of the projects they are
working on and the open pull requests across those projects. Each user hosts
an instance on Cloudflare's free tier and authenticates through GitHub. Only
the configured owner is allowed to sign in, even if other people authenticate
successfully with GitHub. An optional public view may follow.

After connection, the app can discover accessible repositories; which of those
are monitored, including forks and organization repositories, needs a decision.
The dashboard should reflect changes without requiring a manual page refresh.
No paid Cloudflare services should be required. Any optional LLM usage is a
separate owner-funded cost and must not be necessary for the basic dashboard.

## Project index

The motivating `PROJECTS.md` is a local, agent-maintained project survey. It
contains summaries, stacks, recent activity, branch state and next actions,
grouped under these starting classifications:

- **Active:** recent commits and continuing momentum.
- **Cooling:** recently active, now quiet, with recoverable momentum.
- **Stranded:** unfinished work or an unmerged feature needing a decision.
- **Dormant:** paused, but potentially worth reviving.
- **Thin:** very little history, potentially worth retiring.
- **Upstream:** a fork or contribution to someone else's project.
- **Archived:** deliberately finished or abandoned.

These are examples, not fixed thresholds or an exhaustive schema. Some
classifications express owner judgment. GitHub can provide commits, branches,
fork relationships and PRs, but cannot reveal uncommitted changes, unpushed
commits, local-only repositories or the owner's intent. The hosted dashboard
must not imply that missing local evidence was inspected.

The personal inventory is deliberately not copied into this public repository.

## Open design questions

- Choose a frontend and Cloudflare runtime/storage approach after confirming
  current free-tier constraints. Decide reactive updates versus bounded polling.
  Decided: one Worker and one Durable Object per instance, pushing updates to
  a React frontend over WebSockets; see
  [DECISIONS.md](DECISIONS.md#2026-10-13--cloudflare-stack).
- Choose GitHub authentication and authorization, permissions, repository scope
  and credential lifecycle. Compare a GitHub App with OAuth-based integration.
  Decided: a GitHub App per instance; see
  [DECISIONS.md](DECISIONS.md#2026-10-12--github-integration).
- Choose webhook installation or another change-detection mechanism, including
  reconciliation after missed events and visibility of stale data.
  Decided: GitHub App webhooks mark PRs for re-reading, and a sweep
  reconciles only while an overview is visible; see
  [DECISIONS.md](DECISIONS.md#2026-10-15--change-detection).
- Define the PR overview: draft state, review needs, CI results, mergeability
  and which signals mean that work is needed.
- Define classifications, manual overrides, evidence and freshness. Decide
  whether deterministic signals, owner input or optional LLM summaries apply.
  Partly decided 2026-10-12: the section an index entry sits under is the
  authoritative classification and computed ones are only suggestions; see
  [DECISIONS.md](DECISIONS.md#2026-10-12--project-index-source-of-truth).
  Decided 2026-10-15: the brief's seven are the classifications Seshat
  knows, deterministic signals produce suggestions shown beside the owner's
  section, and owner classifications do not expire; see
  [DECISIONS.md](DECISIONS.md#2026-10-15--project-classifications).
- Decide the source of truth for replacing `PROJECTS.md`: dashboard data,
  Markdown in an owner-selected repository, or a synchronized combination.
  Decided 2026-10-12 and refined 2026-10-13: Markdown in a dedicated private
  git repository, hosted on GitHub for now; see
  [DECISIONS.md](DECISIONS.md#2026-10-12--project-index-source-of-truth).
- Evaluate an optional laptop-agent prompt that surveys local checkouts and
  proposes Markdown updates through a PR or an owner-authorized direct push.
  Decided in the same entry: direct push after in-session approval, draft PR
  when unattended.
- Evaluate hosted refresh using GitHub context, the existing Markdown and a
  supplied prompt, optionally with an owner-supplied Anthropic or OpenAI key.
  Decide approval, secret handling, cost bounds and self-PR behavior before use.
  Decided 2026-10-15: not now, with the design it would follow recorded; see
  [DECISIONS.md](DECISIONS.md#2026-10-15--hosted-llm-refresh-waits).
- Define public-view consent and filtering. Private repository names, PRs,
  summaries and local context must not become public by accident.
  Decided: a later, opt-in public view with per-repository consent for
  public repositories only, a fixed field list and separate consent for
  index entries; see
  [DECISIONS.md](DECISIONS.md#2026-10-15--public-view).

## Next phase

Application work began on 2026-10-15
([decision](DECISIONS.md#2026-10-15--application-work-begins)).

The first deliverable, a PR overview, is defined in
[DELIVERABLE.md](DELIVERABLE.md). The remaining questions above stay open
unless [DECISIONS.md](DECISIONS.md) records an answer.
