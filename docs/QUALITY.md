# Quality and validation

## What quality means here

- Preserve the owner's intent and open decisions without claiming an application exists.
- Keep Docket byte-identical to its installed source; put project rules in AGENTS.md.
- Validate documentation links, queues and shell syntax with reproducible commands.
- Protect secrets and local evidence through ignore rules and independent review.

## Gates

Run `bash scripts/setup.sh` after cloning or creating a worktree. It configures
repository-local `core.hooksPath` to `.githooks`, installs no dependencies and
requires Git and Bash already available. Existing custom hook paths are not
overwritten; setup reports the conflict and fails for the owner to resolve.

Run `bash scripts/check.sh` before committing or presenting changes. It checks
all tracked or untracked-but-not-ignored shell scripts and tracked hooks with
`bash -n`, then runs strict queue and Markdown link validation. It may be called
from any working directory. There is no application test suite or build yet;
scaffold checks are not reported as passing application tests.

Both hooks, `pre-commit` and `pre-push`, call the same check entrypoint. They
check the current worktree without rewriting files, so an unstaged problem may
block a commit and unstaged fixes do not prove the staged tree valid. CI checks
the committed tree. Hook timing is measured during installation and reported
in the PR rather than asserted here.

CI runs `check` and `Queue and PR hygiene` on PRs and pushes to `main`.
The hygiene job calls `bash docket/scripts/ci.sh`, including PR marker validation
on pull requests. A full checkout supplies queue snapshots at the base and head.
The PR body is also revalidated on edits. Superseded PR runs are cancelled;
main runs are not. Jobs have five-minute timeouts and read-only permissions.

## Review inputs

- Focus: brief fidelity, secret exclusions, complete queue sources, Docket drift,
  worktree-safe hooks, Bash portability and CI/PR validation behavior.
- Baseline: `bash scripts/check.sh`, `bash docket/scripts/ci.sh`,
  `bash docket/scripts/review-due.sh`, and the skill installer's `--check` when
  that skill checkout is available. Run the installed PR marker validator
  against the actual PR body and run `claim-check.sh --self install-docket`
  for this installation branch.
- Exercise hooks in a disposable repository with valid content, a broken link
  and a malformed queue entry; verify rejection without changing production Git history.
- Inspect runtime documentation against actual scripts, hook configuration and CI.
- Review source paths: `scripts .githooks .github docs`; include `AGENTS.md`,
  `TODO.md`, `README.md` and the review index in documentation review.
- Expected tracked content: Markdown, LICENSE, .gitignore, shell scripts,
  executable hooks, YAML workflows, the verbatim vendored docket directory,
  logo artwork, and design references under `docs/design/` (exported prototype
  HTML and PNG screenshots, without the Claude Design runtime).

## Review and schedules

The empty review index means no whole-codebase review has been recorded.
Independent PR review is separate and belongs in the PR body. Builds and
application tests arrive with `scaffold-worker-app`; scheduled extended
validation and browser checks wait until there is an application to run them
against.
A red main must be addressed the same day or filed as P1 with evidence (P0 if
release-blocking); recovery requires a green run on main.

## GitHub protection

Protection and rulesets are not configured by this installation. Before landing,
inspect GitHub and apply settings only with the owner's authorization. Recommend
required `check` and `Queue and PR hygiene` checks, linear history and squash
merges. Up-to-date-with-base is optional (default recommendation: off).
Zero approving GitHub reviews is compatible with independent agent review
recorded in the PR. Administrator bypass can support Docket's documented
queue/plan direct-push exceptions. Merge-method settings are recommendations,
not assertions about current hosting configuration.
