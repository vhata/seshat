# Agent instructions

Seshat is building its first deliverable, the PR overview ([docs/DELIVERABLE.md](docs/DELIVERABLE.md)). Read [the brief](docs/BRIEF.md) for the wider intent.

<!-- docket:begin -->

## Docket

This project is run with docket. Read [docket/CONTRACT.md](docket/CONTRACT.md) before any work; it is the authoritative workflow, and this section records only this project's settings. The installer keeps this section current: the text above the list is rewritten on every run, the list keeps the values this project has set, and the section may sit anywhere in this file.

- Queue areas: `[PRODUCT]`, `[GITHUB]`, `[HOSTING]`, `[TOOLING]`, `[DOCS]`.
- Concurrency cap: Two heavy builds or validation runs at once.
- Merging and releases: The user merges; no standing delegation. Releases, deployment and publishing require explicit authorization.
- Optional pieces in force: Staged TODO queue, independent review, review ledger scaffolding, hooks and PR/main CI are in force. Codebase review snapshots await a requested review. Roadmap queue, stacked PRs and scheduled extended validation are deferred until needed.
- Environment: Bash 3.2-compatible workflow scripts. Standalone Python uses `/Users/jonathan.hitchcock/.venv/3.12/`; a future Python project must use its own Python 3.12 virtualenv. The application stack is TypeScript on Cloudflare Workers with a React and Vite frontend ([decision](docs/DECISIONS.md#2026-10-13--cloudflare-stack)); dependencies are npm packages locked in `package-lock.json` and installed by `scripts/setup.sh` on Node.js at the major version in `.node-version` or later ([toolchain](docs/DECISIONS.md#2026-10-15--toolchain)).

<!-- docket:end -->

## Working together

Parallelize independent work where practical. Give each agent clear ownership,
dependencies and checks; concurrent writers use isolated worktrees. Coordinate
shared interfaces and serialize shared queue edits.

Each code-writing agent, including the coordinator and integration author,
needs a separate reviewer before work is reported ready. Reviewers inspect the
actual changes and surrounding code, check requirements and validation, and
report findings rather than editing. Authors fix; reviewers verify fixes and
subsequent changes. Self-review and automated checks do not replace independent
review. Reviewing alone does not require another reviewer.

Keep PRs draft while implementation, checks or independent review are incomplete
or actionable findings remain. Once those gates pass, mark the PR ready without
waiting for user approval. Return it to draft if a gate becomes incomplete.
The coordinator checks the combined result. Report the reviewed commit, scope,
findings, actual checks and limitations; disclose unavailable reviewers or tools
and leave review pending. The user performs final review and landing unless
explicitly delegated. Awaiting that review is not a reason to keep completed
work draft.

## Current scope

Application code and installing dependencies are authorized
([decision](docs/DECISIONS.md#2026-10-15--application-work-begins)), within
the chosen stack
([decision](docs/DECISIONS.md#2026-10-13--cloudflare-stack)) and the other
decisions in [docs/DECISIONS.md](docs/DECISIONS.md). Open questions are
settled by their own entries in [TODO.md](TODO.md), not held as a reason to
wait. Deploying still needs the owner's word each time, as the Docket section
above says.
Do not infer that a public GitHub repository authorizes exposing private
project information in the future application.
