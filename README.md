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
and activity facts behind each bucket. Signed GitHub deliveries and
[sweeps while a page is visible](docs/OVERVIEW_SYNC.md) keep the stored
overview current. The page receives
updates through its owner-gated WebSocket, displays the last successful
GitHub sync and flags failed or overdue data. Desktop and phone scenarios,
runtime integration and the free-tier boundary are recorded in
[overview acceptance](docs/OVERVIEW_ACCEPTANCE.md).
Owner-run [instance monitoring](docs/MONITORING.md) checks availability,
GitHub sync progress and an explicit account-usage sample, reporting fixed
alert codes to the terminal.

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
Hosted operations use `./bin/seshat site`; deployments require an explicit
operator invocation and confirmation.
Build and runtime version inspection are described in
[running revision](docs/RUNNING_REVISION.md).

## Configuration and sign-in

Only the owner, identified by numeric GitHub account ID, can sign in. Each
instance has its own GitHub App. Guided site setup registers the hosted
App and uploads its credentials as Cloudflare Worker secrets. Local
development uses the browser setup below and `.dev.vars` (ignored by Git).
Seshat keeps no owner GitHub token or App credential in application data.
Manual `wrangler secret put` and `secret bulk` are advanced alternatives;
each secret write deploys a new version.

| Name | Set by | What it is |
| --- | --- | --- |
| `OWNER_ID` | site setup; manually for local development | The owner's numeric account ID; hosted registration supplies it |
| `SETUP_SECRET` | the owner, for browser/manual setup | Any long random string; it unlocks the setup page and is unnecessary for guided site setup |
| `GITHUB_APP_SLUG` | setup | The App's URL name |
| `GITHUB_CLIENT_ID` | setup | The App's client ID |
| `GITHUB_CLIENT_SECRET` | setup | The App's client secret |
| `GITHUB_PRIVATE_KEY` | setup | The App's private key, the PEM exactly as GitHub issued it |
| `GITHUB_WEBHOOK_SECRET` | setup | The App's webhook secret |

Sessions last seven days and are bound to the configured numeric owner.
Changing, removing or invalidating `OWNER_ID` rejects the old owner's HTTP
requests and sockets before further private messages. Upgrading from
sessions without an owner identity requires signing in again. The browser
returns to an explanatory sign-in screen when a session ends, including
quiet expiry and rejected reconnects; ordinary network outages still
reconnect automatically.

After valid OAuth state, callbacks allow ten token exchanges per client
per ten-minute window, using Cloudflare's trusted `CF-Connecting-IP`.
Blocked callbacks return 429 with `Retry-After`, without calling GitHub.
The instance object keeps at most 4,096 hashed client counters in memory;
no anonymous attempt writes database rows. A full map temporarily refuses
new clients until a slot expires, while existing clients keep their own
allowance. Eviction or restart resets counters; distributed clients can
still spend the App's shared OAuth budget. Hosted callbacks without the
trusted IP fail before exchange; plain HTTP loopback development uses a
shared local counter instead.

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
`SETUP_SECRET` it never opens. Hosted instances use the guided site setup
below, which handles the registration and upload without copying JSON.

### Hosted setup

Keep a permanent checkout and let the site commands save the target and
guide browser approvals:

```sh
./bin/seshat site setup
```

For routine maintenance:

```sh
./bin/seshat site status
./bin/seshat site update
```

Update validates, builds and deploys the current clean checkout, asking
once before changing the saved target. Pull from `main` yourself when
ready; the command does not update Git. Setup detects existing instances
and resumes interrupted progress without repeated IDs or credential JSON
copying.

See [site commands](docs/SITE.md) for installation, local settings,
credentials, diagnostics and macOS/Linux boundaries. The
[instance operations runbook](docs/INSTANCE_OPERATIONS.md) remains the
advanced reference for verification, secret changes and recovery.

The App needs only Metadata, Pull requests, Checks and Commit statuses
read permissions. Private review commit identities use the REST review
endpoint; they do not require adding Contents access.

The code lives under `src/`: `worker/` for the Worker's routes, `object/`
for the Durable Object and its schema, `shared/` for pure logic with tests
that run in Node, and `frontend/` for the React page. Worker and object tests
run in the Workers runtime.

Follow-ups live in [TODO.md](TODO.md), decisions in
[docs/DECISIONS.md](docs/DECISIONS.md), and gates and validation in
[docs/QUALITY.md](docs/QUALITY.md).

Recovery mechanisms, the offline and disposable hosted experiments, and
production recovery limits are documented in
[instance recovery](docs/INSTANCE_RECOVERY.md).

## License

[MIT](LICENSE), copyright 2026 Jonathan Hitchcock.
