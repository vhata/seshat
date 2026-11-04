# Repository CI

The owner overview shows GitHub Actions results independently of open PRs.
**Repository CI** covers push-triggered runs on each repository's actual
default branch and scheduled runs. A repository with no open PRs still
appears. PR buckets keep their existing check and review rules.

## Reading the results

Each workflow and trigger has its own latest completed outcome and any
newer run in progress. A passing push build cannot clear a failed nightly
run, and a pending replacement does not erase the previous failure.
Failures, timeouts, startup failures, action required and cancellations
need attention, with the actual outcome shown in text. Other results and
inactive workflows are available in a disclosure. Muted repositories have
their own collapsed CI results and keep updating; monitoring off removes
their results.

Run links open GitHub. The commit and run time describe the **latest
observed run**, not proof that the branch's current head passed. CI's last
successful read time describes when Seshat checked GitHub, independently of
the age of the run. API failures retain the last good evidence with a
warning; missing permission, incomplete coverage and no observed runs are
not passing CI. Missing legacy evidence is unknown until checked.

Coverage is GitHub Actions `push` and `schedule` runs. External CI, release
and manually dispatched workflows are outside this coverage. A workflow
may support several triggers; its push and schedule evidence remain
separate. Seshat does not infer schedules from workflow names or promise
that a scheduled job ran when expected. A fresh read of an old success
does not establish a healthy schedule. See the
[implementation specification](specs/2026-11-03-repository-ci-health.md)
for scope and acceptance cases.

## Upgrade an existing GitHub App

New App registrations request **Actions: Read-only** and subscribe to
**Workflow run** events. Updating Seshat does not change an existing
GitHub App's permissions or webhook subscriptions. The original PR
overview permissions continue to work; Repository CI reports unavailable
access until the installation grants Actions read.

The App owner performs this update in GitHub:

1. Open account **Settings → Developer settings → GitHub Apps**, choose
   the instance's existing App, then **Permissions & events**.
2. Under repository permissions, set **Actions** to **Read-only**. Keep
   the existing Metadata, Pull requests, Checks and Commit statuses read
   permissions. Save the permission change.
3. Under event subscriptions, enable **Workflow run** and save. Keep the
   existing webhook URL and secret and its other subscriptions. Local
   development Apps without reachable webhooks can use visible sweeps.
4. Approve the new permissions for each installation that should expose
   CI. GitHub keeps its previous grant until the account owner approves
   the update; changing the registration alone does not grant access.
5. Return to Seshat and keep the overview visible for reconciliation.
   After GitHub grants the permission, the next read can confirm results.
   An installation token minted before approval may retain its previous
   grant until Seshat obtains a replacement.

These steps add read access to Actions data on repositories already
selected for the installation. They do not rerun workflows, download
logs, change monitored repositories or add Contents/write permissions.
GitHub documents [registration changes and installation approval][modify]
and the [Actions read requirement for workflow-run events][events].
No App registration or installation is modified automatically by Seshat.

## Synchronization and evidence

CI work runs through the instance's existing durable alarm scheduler.
Visible-overview reconciliation includes monitored repositories with no
open PRs. Workflow-run events queue authoritative repository CI reads;
event payloads are not treated as complete result snapshots. Reads share
bounded work, rate-limit waits and retries with ordinary overview work.
Workflow inventory and separate per-workflow trigger reads prevent a busy
push workflow from hiding a rare scheduled failure. Exhausted inventory
or history bounds leave coverage incomplete.

CI evidence is owner-only and independent of repository PR reconciliation
and individual PR reads. CI observations carry their own attempt and
last-success evidence. Continuations survive object eviction, superseded
responses cannot overwrite newer observations, and removing monitoring or
changing repository ownership/installation withdraws the old identity's
evidence. The general [freshness model](GRANULAR_FRESHNESS.md) continues to
describe PR reconciliation; it does not imply CI was read.

Automated reader, storage, scheduler, protocol and frontend checks use
synthetic GitHub data. Assembled browser checks exercise local production
assets and Workers with synthetic responses. These checks do not establish
that a production App has approved Actions access or receives live
workflow-run deliveries; those need separately authorized hosted checks.

[modify]: https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration
[events]: https://docs.github.com/en/webhooks/webhook-events-and-payloads#workflow_run
