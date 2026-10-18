# Quality and validation

## What quality means here

- Preserve the owner's intent and open decisions; describe the application only as far as it is built.
- Respect the [implementation constraints](specs/2026-10-13-cloudflare-stack.md#constraints-for-implementation),
  including Durable Object constructors that never write, and test Worker and
  object code in the Workers runtime.
- Keep Docket byte-identical to its installed source; put project rules in AGENTS.md.
- Validate documentation links, queues, shell syntax, types, tests and the build with reproducible commands.
- Protect secrets and local evidence through ignore rules and independent review.

## Gates

Run `bash scripts/setup.sh` after cloning or creating a worktree, and again
after `package-lock.json` changes. It requires Git, Bash and Node.js at the
major version in `.node-version` or later (npm comes with Node). It configures
repository-local `core.hooksPath` to `.githooks`, installs the locked
dependencies with `npm ci --ignore-scripts` and generates the Worker types
with `wrangler types`. Existing custom hook paths are not overwritten; setup
reports the conflict and fails for the owner to resolve. The toolchain is
recorded in [DECISIONS.md](DECISIONS.md#2026-10-15--toolchain).

Run `bash scripts/check.sh` before committing or presenting changes. It may be
called from any working directory, and runs in order:

1. `bash -n` over all tracked or untracked-but-not-ignored shell scripts and
   tracked hooks, then strict queue and Markdown link validation.
2. A dependency check that fails, pointing at setup, when `node_modules` is
   missing or older than `package-lock.json`.
3. `wrangler types`, regenerating `worker-configuration.d.ts`, then the type
   check (`tsc --build` over the frontend, Worker, test and configuration
   projects, plus the Node-only CLI project).
4. The tests (`vitest run`): the `frontend` project checks the page markup,
   socket lifecycle and browser-clock freshness logic in Node. The `shared`
   project runs pure logic under
   `src/shared/` in Node, and the `workers` project runs Worker and Durable
   Object tests in the Workers runtime with the bindings from
   `wrangler.jsonc`. The `workers` project also gets a test configuration
   (a fixed owner ID and a throwaway App key generated on each run, so no
   private key is committed). In all projects a setup file,
   `src/test/fetch-guard.ts`, replaces `fetch` before every test with a
   guard that refuses the request, and fails the test afterwards if any
   request was made that the test's own stub of GitHub did not answer, so
   no test reaches the network. The `cli` project runs command and survey
   tests in Node against temporary directories and Git repositories;
   conformance fixture tests run in `shared` and are type-checked with the
   Node-only CLI project. They use synthetic data and make no remote Git
   calls. Vitest fails when it finds no test files.
5. The production build (`vite build`) of the frontend and the Worker.

`bash scripts/check.sh --quick` stops after step 3. Wrangler's usage metrics
are turned off for every step.

The `pre-commit` hook runs `check.sh --quick` and `pre-push` runs the full
check. They check the current worktree without rewriting tracked files, so an
unstaged problem may block a commit and unstaged fixes do not prove the staged
tree valid. CI checks the committed tree. Hook timing is measured when the
gates change and reported in the PR rather than asserted here.

CI runs `check` and `Queue and PR hygiene` on PRs and pushes to `main`. The
`check` job sets up Node from `.node-version` with npm's download cache, then
runs `bash scripts/setup.sh` and `bash scripts/check.sh`. The hygiene job calls
`bash docket/scripts/ci.sh`, including PR marker validation on pull requests.
A full checkout supplies queue snapshots at the base and head. The PR body is
also revalidated on edits. Superseded PR runs are cancelled; main runs are not.
`check` has a ten-minute timeout and the hygiene job five; both have read-only
permissions.

Run the app locally with `npm run dev`, which serves the page, the Worker and
the Durable Object from the local Workers runtime, keeping local object state
under `.wrangler/` and reading secrets from `.dev.vars`; trying sign-in needs
the configuration in the [README](../README.md#configuration-and-sign-in). Nothing in the gates deploys or creates Cloudflare
resources; deploying needs the owner's word each time
([AGENTS.md](../AGENTS.md#docket)).

## Review inputs

- Focus: brief fidelity, secret exclusions, complete queue sources, Docket drift,
  worktree-safe hooks, Bash portability and CI/PR validation behavior; for
  application code, the stack's implementation constraints, writes kept out of
  object constructors, and tests that would fail if the behaviour broke; for
  the owner boundary, that every route outside the public list in
  `src/worker/routes.ts` needs the owner's session, that nothing is stored
  for a refused account and that no GitHub token is stored at all.
- Baseline: `bash scripts/check.sh`, `bash docket/scripts/ci.sh`,
  `bash docket/scripts/review-due.sh`, and the skill installer's `--check` when
  that skill checkout is available. Run the installed PR marker validator
  against the actual PR body and run `claim-check.sh --self install-docket`
  for this installation branch.
- Exercise hooks in a disposable repository with valid content, a broken link
  and a malformed queue entry; verify rejection without changing production Git history.
- Inspect runtime documentation against actual scripts, hook configuration and CI.
- Review source paths: `src bin scripts .githooks .github docs skills` and the
  root configuration files; include `AGENTS.md`, `TODO.md`, `README.md` and
  the review index in documentation review.
- Expected tracked content: Markdown, LICENSE, .gitignore, shell scripts,
  executable hooks, YAML workflows, the verbatim vendored docket directory,
  logo artwork, and design references under `docs/design/` (exported prototype
  HTML and PNG screenshots, without the Claude Design runtime); TypeScript and
  TSX sources and tests under `src/`, `index.html`, and the toolchain
  configuration at the root (`package.json`, `package-lock.json`,
  `.node-version`, `tsconfig*.json`, `vite.config.ts`, `vitest.config.ts` and
  `wrangler.jsonc`). Generated and local files stay untracked: `node_modules/`,
  `dist/`, `.wrangler/`, `worker-configuration.d.ts`, `*.tsbuildinfo` and
  `.dev.vars` files.

## Review and schedules

The empty review index means no whole-codebase review has been recorded.
Independent PR review is separate and belongs in a PR comment. Builds and
application tests run in every check. Scheduled extended validation and
automated browser checks remain outside the default gate. For overview
changes, check desktop and phone layouts with `npm run dev`, including
sync warnings and socket updates; fixture-driven headless browser checks can
exercise these without GitHub access.
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
