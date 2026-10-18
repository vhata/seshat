<img src="assets/seshat.svg" alt="Seshat project health dashboard logo" width="80" height="80">

# Seshat

A self-hosted dashboard for GitHub project health and open pull requests,
intended to run on Cloudflare's free tier. Named after Seshat, the Egyptian
goddess of writing and record keeping.

The [PR overview](docs/DELIVERABLE.md) runs on a Cloudflare Worker with a
SQLite Durable Object and React frontend. Owner-only GitHub sign-in opens
the overview; `/repositories` controls monitoring, including overrides for
owned repositories, forks and accepted organization installations. Setup
pages register and install the instance's own GitHub App.

Open PRs are grouped by the action they need, with the CI, review, conflict
and activity facts behind each bucket. Signed GitHub deliveries and sweeps
while a page is visible keep the stored overview current. The page receives
updates through its owner-gated WebSocket, displays the last successful
GitHub sync and flags failed or overdue data. Desktop and phone scenarios,
runtime integration and the free-tier boundary are recorded in
[overview acceptance](docs/OVERVIEW_ACCEPTANCE.md).

Project health classifications and a public view remain future capabilities.
The hosted overview reports GitHub evidence only.

The project also aims to replace a manually maintained `PROJECTS.md` index.
Its [format](docs/INDEX_FORMAT.md) and
[classifications](docs/specs/2026-10-15-project-classifications.md) are
defined, and an optional agent skill,
[survey-projects](skills/survey-projects/README.md), surveys local checkouts
and updates it. See the [project brief](docs/BRIEF.md) for requirements and
design questions.

The local [Seshat CLI](docs/CLI.md) lists index entries by classification,
runs commands across their paths, checks the format and disk coverage, and
surveys local Git signals. Run `./bin/seshat --help` after setup; it needs
no hosted instance or credential and shares the survey skill's settings.

## Development workflow

Read [AGENTS.md](AGENTS.md) and the [Docket contract](docket/CONTRACT.md).
Git, Bash and Node.js (the major version in `.node-version` or later, with its
bundled npm) are prerequisites.

```sh
bash scripts/setup.sh   # configure hooks, install dependencies, generate types
bash scripts/check.sh   # docs and queue checks, type check, tests, build
npm run dev             # serve the app locally at the printed URL
```

`npm run dev` runs the Worker, the Durable Object and the page in the local
Workers runtime; try `/` and `/api/health`. Local state lives in `.wrangler/`.
There is no deploy script, and deploying needs the owner's word each time.

## Configuration and sign-in

Only the owner, identified by numeric GitHub account ID, can sign in. Each
instance has its own GitHub App, registered from the instance's setup page.
Seshat stores no GitHub token for anyone and no App credential: the owner
sets these as Worker secrets, in `.dev.vars` for local development (ignored
by Git) or with `npx wrangler secret put` or `npx wrangler secret bulk` for a
deployed instance. Each secret write deploys a new version.

| Name | Set by | What it is |
| --- | --- | --- |
| `OWNER_ID` | the owner, before setup | The owner's numeric account ID, from `https://api.github.com/users/<login>`; setup shows it if unset |
| `SETUP_SECRET` | the owner, before setup | Any long random string; it unlocks the setup page |
| `GITHUB_APP_SLUG` | setup | The App's URL name |
| `GITHUB_CLIENT_ID` | setup | The App's client ID |
| `GITHUB_CLIENT_SECRET` | setup | The App's client secret |
| `GITHUB_PRIVATE_KEY` | setup | The App's private key, the PEM exactly as GitHub issued it |
| `GITHUB_WEBHOOK_SECRET` | setup | The App's webhook secret |

To try sign-in locally:

1. Put `OWNER_ID` and `SETUP_SECRET` in `.dev.vars` and run
   `npm run dev -- --port 5173 --strictPort`. The App's callback URLs name
   this address, so keep the port the same on later runs.
2. Open `/setup`, enter the setup secret and a name for the App, and confirm
   on GitHub. This registers a real, private GitHub App on your account,
   pointed at the local server. GitHub refuses a webhook it cannot reach,
   so this App has no webhook or event subscriptions; sign-in does not need
   them.
3. Copy the `.dev.vars` lines the page shows (it shows them only once),
   restart `npm run dev`, and follow its link to install the App on your
   personal account with All repositories. GitHub then returns you to
   `/setup/installed`, which checks the installation after you sign in.
4. Sign in at `/`. Signing out is on the same page.

Setup closes as soon as any of the App's credentials is set, and without
`SETUP_SECRET` it never opens. A deployed instance follows the same steps
at its own address, with its own App, storing the JSON the setup page shows
with `npx wrangler secret bulk`.

The code lives under `src/`: `worker/` for the Worker's routes, `object/`
for the Durable Object and its schema, `shared/` for pure logic with tests
that run in Node, and `frontend/` for the React page. Worker and object tests
run in the Workers runtime.

Follow-ups live in [TODO.md](TODO.md), decisions in
[docs/DECISIONS.md](docs/DECISIONS.md), and gates and validation in
[docs/QUALITY.md](docs/QUALITY.md).

## License

[MIT](LICENSE), copyright 2026 Jonathan Hitchcock.
