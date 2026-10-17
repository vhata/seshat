<img src="assets/seshat.svg" alt="Seshat project health dashboard logo" width="80" height="80">

# Seshat

A self-hosted dashboard for GitHub project health and open pull requests,
intended to run on Cloudflare's free tier. Named after Seshat, the Egyptian
goddess of writing and record keeping.

Seshat is starting to build its first deliverable, the PR overview defined in
[DELIVERABLE.md](docs/DELIVERABLE.md), on the stack chosen in
[DECISIONS.md](docs/DECISIONS.md#2026-10-13--cloudflare-stack). So far there
is a scaffold: a Cloudflare Worker serving a placeholder React page and a
health route backed by the instance's Durable Object. Nothing is deployed.

The intended dashboard connects to GitHub, lets the instance owner monitor
selected repositories, groups projects by their state, and shows open pull
requests that need attention. Only the owner may sign in; a public view is an
optional future capability.

The project also aims to replace a manually maintained `PROJECTS.md` index.
Its [format](docs/INDEX_FORMAT.md) and
[classifications](docs/specs/2026-10-15-project-classifications.md) are
defined, and an optional agent skill,
[survey-projects](skills/survey-projects/README.md), surveys local checkouts
and updates it. See the [project brief](docs/BRIEF.md) for requirements and
design questions.

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

The code lives under `src/`: `worker/` for the Worker's routes, `object/`
for the Durable Object and its schema, `shared/` for pure logic with tests
that run in Node, and `frontend/` for the React page. Worker and object tests
run in the Workers runtime.

Follow-ups live in [TODO.md](TODO.md), decisions in
[docs/DECISIONS.md](docs/DECISIONS.md), and gates and validation in
[docs/QUALITY.md](docs/QUALITY.md).

## License

[MIT](LICENSE), copyright 2026 Jonathan Hitchcock.
