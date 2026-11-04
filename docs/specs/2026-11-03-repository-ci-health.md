# Repository CI health

Status: accepted for implementation, 2026-11-04, after proposal capture on
2026-11-03. [Repository CI](../REPOSITORY_CI.md) documents the resulting
behavior and existing-App upgrade. This extends the overview without
changing the PR bucket rules in the first deliverable.

The owner wants to see failures on a repository's main branch and in
periodic CI, including repositories with no open PRs. Today the overview
reads checks and commit statuses on open PR heads. A successful PR check
does not establish that the merged branch or its nightly jobs are healthy.

## Experience

Add **Repository CI** above the PR buckets. Show failing workflows for
monitored, unmuted repositories even when they have no open PRs. Each row
shows the repository, actual default branch name, workflow, trigger,
conclusion, commit, run time and a direct link to the GitHub run. Group
push-triggered default-branch runs and scheduled runs separately.

Offer a disclosure for passing, running and unknown results so the owner
can distinguish an uneventful repository from one Seshat could not check.
Muted repositories retain their CI results in a collapsed disclosure and
continue updating. Monitoring off removes them. Keep the seven PR buckets
and their rules unchanged; repository health is useful independently of
whether a PR is ready to land.

Example: a passing `build` push run and a failing `nightly integration`
scheduled run produce one visible nightly failure. An empty PR list does
not hide it. A newer successful scheduled run clears that failure; a
successful PR or push run does not.

## Result semantics

- Discover the current default branch rather than assuming `main`.
- Initially cover GitHub Actions runs triggered by `push` on the default
  branch and by `schedule`. Label this coverage explicitly; external CI,
  release workflows and arbitrary dispatch chains are outside this cut.
- Track each workflow by stable workflow ID and trigger class, scoped to
  repository ID, installation, owner and default branch. Never use one
  repository's most recent run as its entire CI result.
- Keep the latest completed outcome and any newer queued/running run
  separately. A newer run in progress does not clear the previous failure;
  show that a replacement is running. Order runs by their creation/run
  sequence, not completion time: an old slow run finishing late must not
  replace a newer result. Within a run, reconcile its latest attempt.
- A failure, timeout or startup failure needs attention. Cancellation and
  action-required outcomes also need attention, with their own wording.
  Neutral, skipped and unknown conclusions must not be reported as passing.
- Label evidence as the latest observed run, with its actual commit and
  run time. Current-head coverage is unknown unless independently verified;
  never imply the branch's current head passed. Preserve scheduled evidence
  across newer commits, since the next scheduled run may be days away.
  Authoritative branch-head comparison needs a separate access/design
  decision; this proposal does not add Contents read to obtain it.
- No observed runs, missing permission, incomplete history and failed reads
  are distinct from passing. Enumerate workflows and read per workflow/
  trigger with bounded pagination so busy push CI cannot hide a rare
  scheduled failure. A history or request limit leaves coverage incomplete.
  Never infer a schedule from a workflow name. Inventory alone cannot
  identify a scheduled workflow that has never run without reading YAML.
- Treat disabled or deleted workflows as inactive, rather than leaving
  their failures as current indefinitely. Reconcile inventory before
  dropping results; a partial or failed listing is not proof of deletion.

## GitHub access and synchronization

GitHub's [workflow-runs API][runs] supports branch and event filters and
requires Actions read for installation tokens accessing private data.
The [workflow inventory API][workflows] also provides workflow state.
The [workflow_run webhook][events] requires Actions read as well.

The existing manifest grants Metadata, Pull requests, Checks and Commit
statuses read. Implementation must add Actions read and the workflow-run
subscription for new registrations, document the owner-approved permission
and subscription update for existing Apps, and show an actionable missing-
permission state until approved. A manifest change does not upgrade an
existing registration. No write permissions, workflow execution, log
downloads or changes to monitored repositories' workflows are required.

Reuse the existing scheduler's visible-overview sweeps, durable work,
coalescing, budgets, continuations, rate-limit waits and retries. Webhooks
mark repository CI for an authoritative reread. Do not attach CI reads
only to PR reads: `OverviewSync` currently skips full PR reads for
repositories whose open-PR count is zero. Add a repository CI phase that
includes all monitored repositories and cannot starve normal PR work.

Persist CI results and their own check evidence, with conservative
observation times, last-good retention on failure, restart persistence
and guards against superseded observations. A PR read or repository
listing must not advance CI freshness. Keep GitHub run time separate from
Seshat's last successful read time. Reuse the patterns in
[granular freshness](../GRANULAR_FRESHNESS.md), without changing what the
existing repository full-check timestamp means. Expose the data only in
the owner protocol; no public projection gains these fields implicitly.

## Periodic work that stops running

The initial scope reports observed outcomes and their age. It does not
promise that an expected schedule ran. GitHub documents that scheduled
runs can be [delayed or dropped, and disabled after public-repository
inactivity][schedule]. A fresh API read of an old successful run does not
mean a periodic job ran recently.

Detecting missing runs needs a separate decision about expected cadence
and grace periods, whether set by the owner or read from workflow YAML.
Do not guess that any run older than a day is broken, or equate a disabled
workflow with a failing run.

## Implementation acceptance

1. Show a default-branch failure and a scheduled failure in a repository
   with no open PRs, with working GitHub run links and explicit triggers.
2. Prove workflow/trigger isolation, recovery, reruns, late completion,
   failure plus a newer pending run, and run-scoped SHA/time wording that
   leaves current-head coverage unknown when it was not verified.
3. Cover pagination with a rare nightly run behind many push runs, unknown
   coverage, disabled/deleted workflows and default-branch changes.
4. Preserve last-good results on permission errors, partial reads and rate
   limits; show scoped freshness and resume durable work after restart.
5. Verify monitoring, muting, installation/owner identity changes and
   stale-response rejection, with no change to PR bucketing.
6. Test the new-App manifest and document existing-App migration. Record
   synthetic scheduler/browser evidence separately from any authorized live
   GitHub permission, webhook and recovery checks.

[runs]: https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-repository
[workflows]: https://docs.github.com/en/rest/actions/workflows#list-repository-workflows
[events]: https://docs.github.com/en/webhooks/webhook-events-and-payloads#workflow_run
[schedule]: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule
