# Seshat

A self-hosted dashboard for GitHub project health and open pull requests,
intended to run on Cloudflare's free tier. Named after Seshat, the Egyptian
goddess of writing and record keeping.

Seshat is at the planning stage. There is no application, deployment or
selected technology stack yet.

The intended dashboard connects to GitHub, lets the instance owner monitor
selected repositories, groups projects by their state, and shows open pull
requests that need attention. Only the owner may sign in; a public view is an
optional future capability.

The project also aims to replace a manually maintained `PROJECTS.md` index.
How to collect local context, classify projects and update that index remains
open. See the [project brief](docs/BRIEF.md) for requirements and design questions.

## Development workflow

Read [AGENTS.md](AGENTS.md) and the [Docket contract](docket/CONTRACT.md).
Run `bash scripts/setup.sh` to configure hooks and `bash scripts/check.sh` to
validate the scaffold. Git and Bash are external prerequisites; no application
dependencies are installed. Follow-ups live in [TODO.md](TODO.md), decisions in
[docs/DECISIONS.md](docs/DECISIONS.md), and validation in
[docs/QUALITY.md](docs/QUALITY.md).

## License

[MIT](LICENSE), copyright 2026 Jonathan Hitchcock.
