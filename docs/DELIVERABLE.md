# First deliverable: PR overview

Decided with the owner on 2026-10-11 (see [DECISIONS.md](DECISIONS.md)). This
defines what the first implementation must do and how it will be judged. It does
not choose a stack, an authentication mechanism or a change-detection mechanism;
those remain open in [TODO.md](../TODO.md) and must meet the requirements here.

## Outcome

A signed-in owner sees every open pull request on the repositories they monitor,
sorted into buckets that say whether the owner needs to act, and the page keeps
itself current without a reload.

## Scope

In scope:

- Owner-only sign-in through GitHub.
- Automatic selection of monitored repositories, with per-repository overrides.
- One overview of open PRs on monitored repositories, whoever opened them.
- Live updates and visible sync status.

Out of scope for this deliverable, each tracked separately where it has a queue
entry:

- Project classifications and project health (Active, Cooling, Stranded and so
  on from the [brief](BRIEF.md#project-index)).
- Replacing `PROJECTS.md` (`replace-projects-index`).
- PRs the owner opened in repositories they do not own (`track-upstream-prs`).
- Review requests in other owners' repositories (`show-review-requests`).
- A public view (`define-public-view`).
- LLM features of any kind (`evaluate-optional-llm-refresh`).
- A layout designed specifically for mobile. The overview is built for a desktop
  browser and must remain readable on a phone.

## Sign-in

The owner is configured at deploy time by their GitHub account ID, not their
username, because usernames can be renamed and reassigned. Any other account
that completes GitHub sign-in is refused: it sees no PRs, no repository names
and no other instance data, and the instance keeps no credential for it beyond
what the refusal requires.

## Monitored repositories

- Every repository owned by the owner's personal account is monitored by
  default, public or private, unless it is archived or a fork.
- A repository created after setup is monitored without any owner action.
- A repository that becomes archived stops being monitored.
- The owner can turn monitoring off for any repository, and turn it on for any
  fork they own or any organization repository they can access. Organization
  repositories are opted in individually; nothing from an organization is
  monitored by default.
- Turning a repository off removes its PRs from the overview.

## PR overview

### Terms

- **Owner's PR:** a PR whose author is the owner's account. Every other PR,
  including one opened by a bot such as Dependabot or Renovate, is **someone
  else's**.
- **CI:** the combined result of check runs and commit statuses on the PR's
  head commit: *passing*, *failing*, *pending* or *none* (nothing reported).
- **Conflicts:** GitHub reports the PR as not mergeable because of conflicts.
  While GitHub has not yet computed mergeability, the PR is treated as having no
  conflicts and the row says that mergeability is being checked.
- **Reviewed since the latest push:** the owner submitted a review (approval,
  changes requested or comment) after the most recent commit was added to the
  PR.

### Buckets

Each open PR appears exactly once, in the first bucket whose rule matches.

| # | Group | Bucket | Rule |
| --- | --- | --- | --- |
| 1 | Needs you | Ready to land | Not a draft; CI passing or none; no conflicts; review decision is not changes requested; and either the review decision is approved or it is the owner's PR. |
| 2 | Needs you | Broken | The owner's PR, not a draft, with CI failing or conflicts. |
| 3 | Needs you | Awaiting your review | Someone else's PR, not a draft, that the owner has not reviewed since the latest push. |
| 4 | Needs you | Changes requested on yours | The owner's PR, not a draft, whose review decision is changes requested. |
| 5 | Waiting | CI running | Not a draft, with CI pending. |
| 6 | Waiting | Waiting on the author | Someone else's PR, not a draft, that the owner has reviewed since the latest push. This includes the owner having requested changes. |
| 7 | Waiting | Draft | A draft PR, whoever opened it. |

Notes on the rules:

- The owner's own non-draft PR with passing CI counts as ready to land without
  an approval, because the owner is the only person who would approve it.
- A draft with failing CI is a draft, not broken: work in progress is expected
  to be red at times.
- The rules cover every combination of author, draft state, CI, conflicts and
  review state, so no PR is left unbucketed. Tests must show this.

### Stale flag

A PR with no activity (commits, reviews, comments or state changes) for 7 days
is flagged as stale in whichever bucket it is in. Stale is a flag, not a bucket.
The threshold is fixed for this deliverable.

### Row contents

Every row shows the plain facts behind its bucket: repository, title, author
(bots marked as bots), age, time of last activity, draft state, CI result,
review decision and conflict state. Bucketing must never be the only way to see
why a PR is where it is.

## Freshness

- A change on GitHub (a PR opened, closed or merged, a push, a review, a CI
  result) reaches an open overview within about a minute of GitHub reporting
  it, without a reload.
- The overview always shows when data last synced successfully from GitHub.
- When a sync is overdue or has failed, the overview says so prominently.
  Stale data must never look current. The overdue threshold is set by the
  change-detection decision (`choose-change-detection`).
- Missed or delayed webhook deliveries are reconciled, so the overview
  converges on GitHub's state even when an event is lost.

## Evidence boundary

The overview shows only what GitHub reports. It makes no claim about local
checkouts, uncommitted changes, unpushed commits or local-only repositories,
and its wording must not suggest that such evidence was inspected.

## Cost

The overview runs on Cloudflare's free tier with no paid Cloudflare service and
no LLM provider key.

## Acceptance checks

The first implementation PR must demonstrate each of these, by automated test
where practical and otherwise by a recorded manual scenario.

1. A second GitHub account completes sign-in and is refused, seeing no instance
   data.
2. Owned repositories that are neither archived nor forks are monitored by
   default. A repository created after setup appears without owner action.
   Turning a repository off removes its PRs. Forks and organization
   repositories appear only once opted in.
3. Every open PR on a monitored repository appears exactly once, in the bucket
   the rules assign. Tests of the bucketing logic run on fixed sample PR data,
   with at least one case per rule, the precedence cases between rules, and a
   check that every combination of inputs lands in a bucket.
4. Each row shows the contents listed under [Row contents](#row-contents).
5. A change made on GitHub reaches an open overview within about a minute, with
   no reload.
6. The last successful sync time is always visible, and an overdue or failed
   sync is flagged.
7. A PR with no activity for 7 days carries the stale flag.
8. The basic overview needs no paid Cloudflare service and no LLM key.
