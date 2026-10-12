# First deliverable: PR overview

Decided with the owner on 2026-10-11 (see [DECISIONS.md](DECISIONS.md)). This
defines what the first implementation must do and how it will be judged. It does
not choose a stack, an authentication mechanism or a change-detection mechanism;
those remain open in [TODO.md](../TODO.md) and must meet the requirements here.
Visual references, which do not override this document, are in
[design/README.md](design/README.md).

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
- **CI:** the combined result of every check run and commit status reported on
  the PR's head commit, whether or not branch protection requires it:
  - *failing* if any result is failure, error, timed out, cancelled, startup
    failure or action required;
  - otherwise *pending* if any is queued, in progress, waiting, requested,
    pending or expected;
  - otherwise *passing* if any is success (neutral, skipped and stale results
    count as neither);
  - otherwise *none*.
- **Conflicts:** GitHub reports the PR as not mergeable because of conflicts.
  While GitHub has not yet computed mergeability, the PR is treated as having no
  conflicts and the row says that mergeability is being checked.
- **Trusted reviewer:** a reviewer whose permission on the repository is
  write, maintain or admin. The owner is a trusted reviewer on every repository
  they own. Reviews from anyone else, such as a passer-by on a public
  repository, are ignored for review state and bucketing. This matches whose
  approvals GitHub counts towards required reviews.
- **Review state:** derived from each trusted reviewer's latest approval or
  changes-requested review, ignoring comment-only and dismissed reviews. It is
  *changes requested* if any trusted reviewer's latest such review requests
  changes, otherwise *approved* if at least one trusted reviewer's latest such
  review is an approval submitted on the current head commit, otherwise *none*.
  A request for changes stands until that reviewer reviews again or it is
  dismissed; an approval lapses when new commits are pushed. Seshat derives
  this itself rather than using GitHub's review decision, which GitHub reports
  only when branch protection requires reviews.
- **Reviewed the current head:** the owner submitted a review (approval,
  changes requested or comment) on the PR's current head commit. A push, including
  a force-push, changes the head, so earlier reviews no longer count.

### Buckets

Each open PR appears exactly once, in the first bucket whose rule matches.

| # | Group | Bucket | Rule |
| --- | --- | --- | --- |
| 1 | Needs you | Ready to land | Not a draft; CI passing or none; no conflicts; review state is not changes requested; and either the review state is approved or it is the owner's PR. |
| 2 | Needs you | Broken | The owner's PR, not a draft, with CI failing or conflicts. |
| 3 | Needs you | Awaiting your review | Someone else's PR, not a draft, that the owner has not reviewed at the current head. |
| 4 | Needs you | Changes requested on yours | The owner's PR, not a draft, whose review state is changes requested. |
| 5 | Waiting | CI running | Not a draft, with CI pending. |
| 6 | Waiting | Waiting on the author | Someone else's PR, not a draft, that the owner has reviewed at the current head. This includes the owner having requested changes. |
| 7 | Waiting | Draft | A draft PR, whoever opened it. |

Notes on the rules:

- The owner's own non-draft PR with passing CI counts as ready to land without
  an approval, because the owner is the only person who would approve it.
- Every rule except Draft excludes drafts, so a draft is always in Draft, even
  with failing CI or conflicts: work in progress is expected to be broken at
  times.
- Pushing to someone else's PR after it was approved moves it back to awaiting
  your review, because the approval no longer covers the head commit.
- Someone else's PR approved on its current head by a trusted reviewer, such as
  a co-maintainer, is ready to land without the owner's own review. An approval
  from a reviewer without write access leaves it awaiting your review.
- The rules cover every combination of author, draft state, CI, conflicts,
  review state and whether the owner has reviewed the current head, so no PR is
  left unbucketed. Tests must show this.
- Ready to land reflects Seshat's view, not GitHub's merge gate. On a repository
  whose branch protection requires an approval, the owner's own unapproved PR
  still shows as ready to land even though GitHub may block the merge.

### Order within a bucket

- In Needs you, rows are ordered longest waiting first: the oldest last
  activity comes first.
- In Waiting, rows are ordered by latest activity first.
- Ties are broken by repository name, then PR number, so the order is
  deterministic.

Sorting by column, as the [prototype](design/README.md#ordering-proposal)
offers, is not required for this deliverable.

### Stale flag

A PR with no activity (commits, reviews, comments or state changes) for 7 days
is flagged as stale in whichever bucket it is in. Stale is a flag, not a bucket.
The threshold is fixed for this deliverable.

### Row contents

Every row shows the plain facts behind its bucket: repository, title, author
(bots marked as bots), age, time of last activity, draft state, CI result,
review state and conflict state. Bucketing must never be the only way to see
why a PR is where it is.

## Freshness

- A change on GitHub reaches an open overview within 60 seconds of GitHub
  reporting it, without a reload. The changes that count are a PR opened,
  closed, merged, converted to or from draft, or pushed to; a review submitted;
  and a CI result on the head commit.
- The overview always shows when data last synced successfully from GitHub.
- When a sync is overdue or has failed, the overview says so prominently.
  Stale data must never look current. The overdue threshold is set by the
  change-detection decision (`choose-change-detection`).
- Changes that GitHub fails to report, or reports late, are still picked up:
  the overview converges on GitHub's state without owner action, within a
  catch-up bound the change-detection decision also sets.

## Evidence boundary

The overview must show only what GitHub reports. It must make no claim about local
checkouts, uncommitted changes, unpushed commits or local-only repositories,
and its wording must not suggest that such evidence was inspected.

## Cost

The overview must run on Cloudflare's free tier with no paid Cloudflare service
and no LLM provider key.

## Acceptance checks

The first implementation PR must demonstrate each of these, by automated test
where practical and otherwise by a recorded manual scenario.

1. A second GitHub account completes sign-in and is refused, seeing no instance
   data, and no credential for it remains stored afterwards. The owner check
   compares account IDs: a test shows that an account whose username matches
   the owner's but whose ID differs is refused.
2. Owned repositories that are neither archived nor forks are monitored by
   default. A repository created after setup appears without owner action, and
   one archived after setup drops out. Turning a repository off removes its PRs.
   Forks and organization repositories appear only once opted in.
3. Every open PR on a monitored repository appears exactly once, in the bucket
   the rules assign. Tests of the bucketing logic run on fixed sample PR data,
   with at least one case per rule, the precedence cases between rules, and a
   check that every combination of inputs lands in a bucket. Tests of the CI
   and review-state derivations cover each mapping in [Terms](#terms),
   including reviews from reviewers without write access being ignored. Rows
   within each bucket follow [Order within a bucket](#order-within-a-bucket).
4. Each row shows the contents listed under [Row contents](#row-contents).
5. Each kind of change listed under [Freshness](#freshness) reaches an open
   overview within 60 seconds, with no reload.
6. A change made while Seshat receives no notification of it (simulated by
   dropping the notification) still appears without owner action, within the
   catch-up bound under [Freshness](#freshness).
7. The last successful sync time is always visible, and an overdue or failed
   sync is flagged.
8. A PR with no activity for 7 days carries the stale flag.
9. The basic overview needs no paid Cloudflare service and no LLM key.
10. A recorded manual review confirms that the overview is readable on a phone
    and that no wording implies local evidence was inspected.
