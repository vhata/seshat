# Manage a hosted Seshat site

Keep a permanent clone of Seshat. Git, Bash, Node.js 24 or later, npm and a
browser are required. Start from the checkout:

```sh
./bin/seshat site setup
```

Setup installs the locked dependencies, guides Cloudflare authentication
and target selection, and detects an existing instance before creating a
new one. Browser pages handle GitHub App registration and installation;
the CLI handles credential upload. GitHub CLI (`gh`) is optional and helps
identify the GitHub account you intend to use.

Read the displayed account, Worker and origin before confirming a change.
Setup does not select paid plans or authorize billable provisioning on
your behalf. Seshat is intended to use Cloudflare's free tier; your account
plan, quota and other usage still matter.

## Everyday commands

```sh
./bin/seshat site status
./bin/seshat site update
```

Update validates, builds, deploys and verifies the current checkout. It
does not fetch or change Git branches. Pull updates yourself when ready,
and commit any local customizations before deploying: deployment requires
a clean, identified source revision. Existing deployed secrets and data
are retained during routine updates.

The command shows the saved target and asks once before deployment.
`--yes` skips that routine confirmation; it does not resolve an ambiguous
target or authorize new billable resources. If deployment succeeds but
verification fails, the site may already be running the new code. Read
the reported deployment state before retrying.

| Command | Purpose |
| --- | --- |
| `site setup` | Configure, adopt or resume setup of one hosted instance. |
| `site update` | Validate, build, deploy and check the current source. |
| `site status` | Inspect the saved target and running revision. |
| `site doctor` | Check configuration, authentication and instance gates. |
| `site logs` | Stream new Worker events until Ctrl-C. |
| `site open` | Open the instance in your browser. |
| `site validate` | Run the repository's validation without deploying. |
| `site build` | Build locally without deploying. |

Use `site --help` for options. Logs are live output, not historical incident
records, and can contain private request details. Keep them private.

For a command on your PATH, the existing
[CLI installation instructions](CLI.md#install-from-a-checkout) explain
how to link `bin/seshat`. A linked command manages the checkout containing
that launcher, even when you run it from another project's directory.

## Automatic deployment

The owner authorizes CI to update the configured production instance when
`SESHAT_AUTO_DEPLOY` is `true`. A push to `main` deploys only after both
`check` and `Queue and PR hygiene` pass. Merging remains the owner's
decision. PRs never run the deployment job or receive its token.

Configure the GitHub `production` environment to allow deployments only
from the `main` branch. Store these environment variables and secret in
the repository running the instance:

| Name | Kind | Value |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Environment secret | Dedicated API token restricted to the instance's account. |
| `SESHAT_ACCOUNT_ID` | Environment variable | Existing Cloudflare account ID. |
| `SESHAT_WORKER_NAME` | Environment variable | Existing Worker name. |
| `SESHAT_ORIGIN` | Environment variable | Existing HTTPS origin, without a trailing slash. |
| `SESHAT_NAMESPACE_ID` | Environment variable | Existing `INSTANCE` Durable Object namespace ID. |
| `SESHAT_AUTO_DEPLOY` | Repository variable | `true` to enable; `false` to pause future jobs. |

The enable switch must be a repository variable because the job condition
is evaluated before the production environment is available. Do not
enable it until the target and credential are configured. Example secret
entry (interactive; do not put a token in a command argument):

```sh
gh secret set CLOUDFLARE_API_TOKEN --repo OWNER/REPO --env production
gh variable set SESHAT_AUTO_DEPLOY --repo OWNER/REPO --body true
```

Start with Cloudflare's
[Edit Cloudflare Workers token template](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/),
restricted to the intended account. The update also reads account identity,
Worker settings, domains/subdomain, secret names and versions; a token
that can only upload is insufficient. Do not copy a personal Wrangler
OAuth token into GitHub. The GitHub App secrets stay in Cloudflare.

CI creates private, ephemeral site settings with the pinned namespace and
uses the same `site update --yes` implementation as a manual update. It
reruns validation, builds clean source and verifies the exact uploaded
version at 100% traffic, schema, anonymous refusal, setup closure and
namespace preservation. It never invokes setup or creates an instance.
Changes to the expected Durable Object binding or class migration shape
are refused for operator inspection.

Deployments are serialized without cancelling an active upload. Source
must still be current remote `main` at preflight and immediately before
upload; rerunning an older workflow cannot redeploy superseded source.
A main push during preparation can make an older deployment fail safely;
the newest main run supplies the next candidate. Avoid simultaneous manual
updates, secret writes or rollbacks while automatic deployment runs:
GitHub concurrency cannot lock an operator's terminal. Remote checks catch
changes during preparation but cannot make the final upload atomic with
an external operator.

The run summary records the attempted source, uploaded version and final
operation state. `upload-outcome-unknown` or `deployed-unverified` can mean
production already changed. Inspect the serving revision before retrying.
There is no automatic rollback: code rollback does not restore object data
or reverse database migrations. A forcibly cancelled runner may stop
before writing its summary; inspect production after any interrupted job.

To pause, set `SESHAT_AUTO_DEPLOY` to `false`; this does not stop a job
that has already started. Wait for active deployments to finish before
an authorized manual update or rollback. After correcting a transient
failure, rerun the latest main CI run. A successful job proves the listed
deployment checks, not real sign-in, socket recovery or GitHub freshness;
those browser checks remain part of release acceptance.

## Local settings and credentials

Site state belongs to the checkout's ignored `.seshat/` directory. It
records the selected Cloudflare account, Worker, HTTPS origin, known
GitHub identity, setup progress and deployment evidence. Routine commands
reuse these values; there are no account-ID exports to repeat.

Private directories and files are restricted to your local account.
Seshat reuses Wrangler authentication and introduces no Keychain
dependency. It does not copy your GitHub CLI or Cloudflare login tokens
into site settings. App credentials are retained privately while setup
is incomplete and removed after a successful upload and verification.
They then live as Cloudflare secrets; their values cannot be downloaded
back from Cloudflare. Local settings are not a credential backup.

Run `site setup` again after an interruption. It rechecks the remote
target and resumes available progress. It must not silently replace an
existing Worker or register another App. If a one-time GitHub conversion
completed before credentials could be saved, recovery may require GitHub
App credential rotation; repeating registration cannot recover that code.

Adoption preserves the deployed App, secrets and application data.
Discovery can read secret names, not secret values, so an adopted site's
owner or App metadata can remain unknown locally. Signing in through the
existing site remains the owner check.

Linked Git worktrees have separate settings. A new Conductor worktree
does not automatically inherit another checkout's deployment target.
Use discovery/adoption to associate it with the existing instance rather
than creating a second deployment for the same owner.

## What verification establishes

Automated checks compare the built Git revision with the active serving
version, check health and schema, and check anonymous data refusal and
closed registration on a configured instance. They do not prove that
GitHub sign-in, an authenticated socket or real webhook freshness works.
Finish installation and sign-in in the browser, then verify that an
actual GitHub change reaches the open overview.

Adoption also accepts an older Seshat instance whose schema is compatible
and whose anonymous access gates pass, after verifying its Cloudflare
target and local namespace binding. Its running source can remain unknown
until an update deploys a build with revision identity. Adoption does not
claim the stronger source verification performed after an update.

The [operations runbook](INSTANCE_OPERATIONS.md) covers deeper diagnosis,
secret changes, rollback constraints and the remaining browser checks.
[Running revision](RUNNING_REVISION.md) explains identity evidence;
[monitoring](MONITORING.md) covers private sync diagnostics. A code rollback
does not restore Durable Object data or reverse database migrations.

## Local development and Linux

Local development remains `npm run dev`, with its own `.dev.vars`, local
storage and GitHub App. Do not reuse hosted credentials for development;
see [local sign-in setup](../README.md#configuration-and-sign-in).

macOS is the supported interactive operator platform initially. The
headless automatic update runs on GitHub's Ubuntu runner without opening
a browser; its hosted acceptance must be established by a real main
deployment. Browser opening uses
the macOS `open` command and attempts `xdg-open` on Linux; Linux needs that
program and a graphical browser session. The registration callback needs
a browser on the same machine as the CLI, so remote/headless terminals
need additional handling. Linux authentication, permissions and runtime
behavior have not been accepted as a supported workflow. These portability
gaps do not require macOS-specific credential storage.
