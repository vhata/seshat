# Project classifications and suggestions

Status: drafted on 2026-10-15 for the `design-project-classifications` queue
entry, for the owner to accept or amend. It takes effect when merged and is
recorded in
[DECISIONS.md](../DECISIONS.md#2026-10-15--project-classifications). Each
[owner choice](#owner-choices) gives a recommendation and its alternative.

This settles what the
[project index decision](2026-10-12-projects-index.md#relationship-to-the-first-deliverable-and-classifications)
left for the classifications design: the set of classifications, whether and
how Seshat suggests one from evidence, how a suggestion that disagrees with
the owner is shown, whether an owner classification expires, when laptop
evidence is too old to show without a warning, projects that span several
repositories, and whether the owner can edit index fields from the dashboard.
It changes nothing in [INDEX_FORMAT.md](../INDEX_FORMAT.md).

## Recommendation

- **The brief's seven classifications are the ones Seshat knows**: Active,
  Cooling, Stranded, Dormant, Thin, Upstream and Archived, matched by exact
  section name. Any other section is shown as written, in the file's order,
  and gets no suggestions.
- **The owner's section always stands.** Seshat never moves, hides or
  re-sorts an entry. When the evidence does not fit the owner's section,
  Seshat shows one suggested classification beside the entry, with the rule
  and the dated facts behind it.
- **Suggestions come from a few dated signals.** Last activity, first
  activity, GitHub's fork and archived flags, and loose ends such as unpushed
  commits or a stale PR of the owner's. All of them are available with the
  GitHub App's current permissions plus the laptop survey; Contents read
  would improve them but is not needed.
- **Two sets of thresholds.** A wider band decides when the owner's
  classification fits, a narrower one picks the suggestion, so a project near
  a boundary does not flip back and forth. The numbers are starting values to
  tune.
- **Owner classifications do not expire.** Time passing without activity
  makes a suggestion appear; it never changes the classification.
- **Laptop observations older than 30 days carry a warning**, and a
  local-only entry gets no suggestion once its survey is that old.
- **One entry per repository for now.** A project that spans several
  repositories is several entries; grouping waits until the owner needs it.
- **No dashboard editing yet; `edit-index-from-dashboard` decides it.**
  Seshat still writes nothing to the index
  ([decision](../DECISIONS.md#2026-10-15--hosted-llm-refresh-waits)), so
  accepting a suggestion means moving the entry in the file.

## What the design must keep

From the [project index decision](2026-10-12-projects-index.md) and
[INDEX_FORMAT.md](../INDEX_FORMAT.md):

- The section an entry sits under is its authoritative classification.
  Computed classifications are only ever shown as suggestions.
- The evidence boundary: absence means "not reported"; a laptop observation
  is always shown with its survey date and source and never merged into a
  GitHub value; wording Seshat generates is qualified by its source, such as
  "no GitHub activity".
- Cloudflare storage holds only a cache rebuildable from GitHub and the
  file. So Seshat cannot keep a record of suggestions the owner dismissed,
  and suggestions are recomputed rather than stored.
- Any section name is valid, and an unknown one is shown as written.
- The GitHub App has read-only Metadata, Pull requests, Checks and Commit
  statuses ([decision](../DECISIONS.md#2026-10-12--github-integration)).
  Contents read is not granted; `show-project-index` may add it. Without it,
  GitHub cannot say when commits were made outside PRs, list branches or
  count commits.

## The classifications

| Classification | Brief's meaning | Seshat can suggest it from |
| --- | --- | --- |
| Active | Recent commits and continuing momentum | Recent activity |
| Cooling | Recently active, now quiet, recoverable momentum | Activity some weeks old |
| Stranded | Unfinished work or an unmerged feature needing a decision | Loose ends on a quiet project |
| Dormant | Paused, but potentially worth reviving | Activity months old |
| Thin | Very little history, potentially worth retiring | A short span of activity, now quiet |
| Upstream | A fork or contribution to someone else's project | GitHub's fork flag |
| Archived | Deliberately finished or abandoned | GitHub's archived flag |

These are the classifications Seshat compares evidence against. Names match
exactly, after the [heading text rules](../INDEX_FORMAT.md#file), so
`## Active` is known and `## Active projects` is not. The owner's order of
sections in the file is the display order; Seshat does not impose one.

A section with any other name, including the owner's section for directories
that are not projects, is shown as written with its entries and gets no
suggestions, since Seshat cannot tell whether evidence fits it. Its entries
still show their evidence.

Archived here is the owner's judgment that a project is finished. GitHub's
archived flag is one piece of evidence for it, and a project can be Archived
in the index without being archived on GitHub.

## Evidence

### Signals

| Signal | Source | Permission or field | Used for |
| --- | --- | --- | --- |
| Last push | GitHub | Metadata (`pushed_at`) | Last activity, unless a bot made it |
| Created | GitHub | Metadata (`created_at`) | First activity |
| Fork | GitHub | Metadata (`fork`) | Upstream |
| Archived | GitHub | Metadata (`archived`) | Archived |
| Committer date of the head commit of the owner's open PRs | GitHub | Pull requests | Last activity |
| Committer date of the head commit of bots' open PRs | GitHub | Pull requests | Telling a bot's push from the owner's |
| The owner's open PRs flagged stale | GitHub | Pull requests ([stale flag](../DELIVERABLE.md#stale-flag)) | Loose ends |
| `Last commit` | Laptop survey | Index field | Last activity |
| `Started` | Laptop survey | Index field | First activity |
| `Unpushed` | Laptop survey | Index field | Loose ends |
| `Uncommitted` | Laptop survey | Index field | Loose ends |
| `Surveyed` | Laptop survey | Index field | Age of the laptop signals; end of observation for local-only entries |

The sweep already lists each installation's repositories with
`GET /installation/repositories`
([change detection](2026-10-14-change-detection.md#the-sweep)). GitHub's
[OpenAPI description][openapi] gives each repository in that listing
`pushed_at`, `created_at`, `fork` and `archived`, so the Metadata signals
cost no request beyond the listing. The head commit dates of open PRs need
one more field in the PR reads the overview already makes.

The listing covers every repository in the installation, monitored or not,
but PRs are read only for monitored repositories, and forks and archived
repositories are not monitored by default
([deliverable](../DELIVERABLE.md#monitored-repositories)). For an index
entry joined to a repository that is not monitored, loose ends from PRs are
not reported, which the reason says, and the last push cannot be checked
against bot PRs:

- For a fork, Seshat uses the last push unchecked, and the reason says it was
  not checked against bot PRs. Dependabot version updates are not enabled
  automatically on forks, even when the fork has a `dependabot.yml`
  ([configuring version updates][dependabot-forks]), and security updates
  are disabled automatically when a fork is created
  ([security updates][dependabot-security-forks]), so a fork's push is
  usually the owner's own. Ignoring it would leave most forks with no dated
  activity, and the [no-date rules](#derived-values) would then suggest
  Upstream for every fork the owner develops as their own project. Syncing a
  fork with its upstream is a push too, and counts as activity.
- For any other repository that is not monitored, such as one the owner
  turned off, Seshat ignores the last push, so last activity comes from the
  laptop or is unknown. Bots run there as usual, and without its PRs Seshat
  cannot tell their pushes from the owner's.

Archived repositories cannot be pushed to, and the fork and archived flags
apply whether or not a repository is monitored.

GitHub's last push covers any branch and any author. A bot that opens PRs,
such as Dependabot or Renovate, pushes a branch to the repository, which would
make a paused project look active. Seshat therefore ignores the last push when
the head commit of a bot's open PR has a committer date within 10 minutes of
it, a starting value like the thresholds below. GitHub reports only the latest
push, so an ignored push leaves no earlier push date, and last activity then
comes from the other signals or is unknown. This misses bot pushes for PRs
that have since closed and workflows that push straight to a branch, and it
can hide an owner's push followed by a bot's within those minutes. On one of
the owner's repositories, checked on 2026-10-16, `pushed_at` matched the head
commit of an open Dependabot PR to the second. With Contents read, the latest
commit by a person, on any branch, replaces this guess.

Laptop fields are free text with suggested forms
([INDEX_FORMAT.md](../INDEX_FORMAT.md#laptop-observations)). For suggestions
Seshat reads them by those forms: a leading `YYYY-MM-DD` in `Last commit` and
`Started`, and `none` (any case) or `0` against anything else in `Unpushed`
and `Uncommitted`. A value it cannot read that way is not used, and the
explanation of a suggestion says which field it skipped. Laptop signals are
used only from a survey within the [warning age](#laptop-evidence-age).

### Derived values

All ages are whole UTC days, computed from the evidence and today's date, so
the same inputs on the same day always give the same suggestion.

- **Last activity (A):** the latest of the last push (unless a bot's), the
  committer dates of the head commits of the owner's open PRs, and the laptop
  `Last commit`.
- **End of observation (E):** today for an entry joined to a GitHub
  repository, since GitHub is current to the last sync. For an entry with no
  GitHub evidence (`Remote: none`, no `Remote`, or a repository Seshat cannot
  resolve), E is the `Surveyed` date, because nothing is known after it.
- **Quiet days (Q):** E minus A, and never less than zero, so a laptop
  commit dated after its own survey counts as activity on the survey date.
- **First activity (F):** the earlier of GitHub's creation date and the
  laptop `Started`. A repository created to hold an older local project has a
  late creation date, which `Started` corrects when the survey has it.
- **Span (S):** A minus F.
- **Loose ends (L):** any of `Unpushed` other than `none` or `0`,
  `Uncommitted` other than `none` or `0`, or an open PR of the owner's
  carrying the stale flag, drafts included.

With no A, Seshat applies only the rules that need no date: when GitHub
reports the repository archived, only Archived fits and Archived is
suggested; Upstream fits as always; and a fork in any other section is
suggested as Upstream. Any other entry gets no suggestion, and says there is
no dated activity to judge from.

## Rules

Each rule is a starting value. The constants live in one place in the code
and in the tables below, and are changed by PR.

### When the owner's classification fits

Seshat first checks whether the evidence fits the owner's section. If it
does, nothing is shown beyond the evidence itself.

| Owner's section | Fits when |
| --- | --- |
| Active | Q < 45 |
| Cooling | 14 <= Q < 180 |
| Dormant | Q >= 90 |
| Stranded | Q >= 14 |
| Thin | Q >= 14 |
| Upstream | Always |
| Archived | Q >= 14 |

When GitHub reports the repository archived, Archived fits whatever Q is,
and no other section fits.

Stranded, Thin, Upstream and Archived are mostly owner judgment, so the only
evidence that contradicts them is the project being worked on again, or
archived on GitHub. Upstream fits even while active, since a contribution
being worked on is still a contribution. One cost: an entry filed under
Stranded, Thin or Archived straight after its last commit shows "Suggests
Active" until 14 days have passed, unless it is archived on GitHub.

### What Seshat suggests

When the owner's section does not fit, the suggestion is the first of these
that matches:

| # | Suggest | When |
| --- | --- | --- |
| 1 | Archived | GitHub reports the repository archived |
| 2 | Active | Q < 30 |
| 3 | Upstream | GitHub reports a fork |
| 4 | Thin | S < 14 |
| 5 | Stranded | Loose ends (L) |
| 6 | Cooling | Q < 120 |
| 7 | Dormant | Otherwise |

The fit bands are wider than the suggestion bands on purpose. An Active
project fits until 45 quiet days, and is then suggested as Cooling, which
fits from 14. A project worked on in bursts a month apart therefore does not
gain and lose a suggestion each time.

Active comes before Upstream and Stranded so that a project being worked on
is called Active whatever else is true of it. A quiet fork is suggested as
Upstream rather than Cooling or Dormant, because the brief defines Upstream
by what the project is.

### Examples

Each example is for a project with more than 14 days between its first and
last activity, and not a fork unless it says so.

| Owner's section | Evidence | Shown |
| --- | --- | --- |
| Active | Last push 20 days ago | Nothing |
| Active | Last push 60 days ago; survey 5 days ago reports a last commit 60 days ago and 2 unpushed commits | Suggests Stranded |
| Active | Last push 60 days ago, nothing else | Suggests Cooling |
| Dormant | Last push 3 days ago, matching no bot PR | Suggests Active |
| Dormant | Last push 1 day ago, matching a Dependabot PR's head commit; survey 5 days ago reports a last commit 200 days ago | Nothing |
| Cooling | Fork, last push 200 days ago | Suggests Upstream |
| Stranded | Last push 400 days ago, no loose ends reported | Nothing |
| Upstream | GitHub reports it archived | Suggests Archived |
| Active | `Remote: none`, survey 10 days ago, last commit 70 days before it | Suggests Cooling |
| Active | `Remote: none`, survey 40 days ago | Nothing; the survey is too old to suggest from |

### Repositories with no index entry

A monitored repository with no index entry is already shown with GitHub
evidence only and a note that it has no entry
([decision](2026-10-12-projects-index.md#keeping-the-evidence-boundary)). It
also shows the classification its evidence suggests, from the same table,
as a hint for where to add it.

## How a suggestion is shown

- The entry stays under the owner's section, in the file's order. The
  owner's classification is the heading it sits under; the suggestion is a
  secondary marker on the row, such as "Suggests Stranded", never styled as
  an error and never replacing the section.
- The marker opens the reason in words, naming the rule and each fact with
  its source and date, for example: "No GitHub activity for 52 days (last
  push 2026-08-24, any branch). Laptop survey 2026-10-01: 2 unpushed commits
  on feature-x." A field skipped because it was not in the expected form is
  named. When no survey is within the warning age, the reason says that
  laptop loose ends were not reported, and why: no survey, or a survey too
  old to use. Where PRs are not read, it says the same of PR loose ends. As
  with buckets, the marker is never the only way to see why.
- The index view's header counts entries with suggestions and offers a
  filter to show only those. Suggestions do not appear in the PR overview,
  in its Needs you group or in any notification.
- Seshat writes nothing to the index, so there is no accept button. The
  reason ends with how to act, "Move this entry under Stranded in
  PROJECTS.md to accept", and links to the entry's line in the file on
  GitHub.
- A suggestion disappears as soon as the owner moves the entry to a section
  that fits, or new evidence makes the current one fit.

The CLI and the laptop agent may use the same rules. The rules are pure
functions of a parse, GitHub evidence and a date, so they belong in the
shared TypeScript module beside the parser
([implementation](../INDEX_FORMAT.md#implementation)). The CLI can apply
them to laptop evidence alone, and the laptop agent can cite them when it
proposes moving an entry, which the owner still decides.

## Owner classifications do not expire

An owner classification lasts until the owner changes it. What changes over
time is the evidence: Q grows by a day every day, so an Active project left
alone gains a suggestion after 45 quiet days without anyone touching the
file. That is the reminder an expiry would give, without Seshat changing
owner judgment.

Because Seshat stores nothing it cannot rebuild, it cannot remember that the
owner has seen a suggestion and disagrees. A suggestion the owner rejects
stays until the evidence changes or the owner moves the entry. The fit bands
are chosen so that this is rare for the owner's deliberate calls: Stranded,
Thin, Upstream and Archived are contradicted only by renewed activity or
GitHub's archived flag, and Dormant fits any project quiet for 90 days.

## Laptop evidence age

`Surveyed` dates every laptop observation in an entry
([INDEX_FORMAT.md](../INDEX_FORMAT.md#laptop-observations)). Seshat already
shows each observation with that date and never shows one without it.

- **Warning age: 30 days.** Observations from a survey more than 30 days
  before today are shown with a warning that they may be out of date, for
  example "laptop survey 2026-09-01, 44 days ago". The warning applies to the
  observations that change from day to day: `Last commit`, `Checked out`,
  `Branches`, `Unpushed` and `Uncommitted`. `Stack` and `Started` rarely
  change and are shown with their date but without the warning.
- **Suggestions.** Laptop signals past the warning age are not used. An
  entry with GitHub evidence is judged from GitHub alone; a local-only entry
  gets no suggestion, and says its survey is too old to suggest from.
- **A survey date after today** is shown with a warning that the date is in
  the future, and its observations are not used for suggestions. The format
  check cannot catch this, since it uses no clock.

Laptop observations and GitHub evidence can disagree without either being
wrong, and are shown side by side, as the
[index decision](2026-10-12-projects-index.md#evidence-split) requires; the
age warning does not hide either.

## Projects spanning several repositories

Format 1 joins one entry to one repository, and a repeated `Remote` is an
error. A project made of several repositories, such as an application and its
infrastructure, is several entries, each classified on its own and suggested
from its own evidence. The owner can mention the related entries in each
summary or `Note`.

The cost is that a quiet part of an active project can gain a suggestion,
for example an infrastructure repository in Active that has not changed in
two months. The owner can file it under the classification its own activity
fits.

Grouping is left for `group-multi-repo-projects`, to be taken up when the
owner has a project that needs it. The likely shape is a field on one entry
listing further repositories, joined like `Remote`, with last activity taken
across all of them. That adds a defined field and so changes the format,
which this design avoids.

A contribution to someone else's project often has a `Remote` outside
Seshat's installation, such as an upstream repository the owner pushes to
directly. Seshat cannot read it, and the index decision shows such an entry
with a visible warning. For an entry under Upstream, the warning should say
the repository is not visible to Seshat's GitHub App rather than suggest it
was deleted, since that is the expected case.

## Editing from the dashboard

No dashboard editing yet; `edit-index-from-dashboard` decides it. Seshat
still writes nothing to the index: the
[refresh decision](../DECISIONS.md#2026-10-15--hosted-llm-refresh-waits)
deferred hosted refresh and kept owner decision 5 in force.

If editing is built, an accept button on suggestions is its likely first use,
and two earlier decisions shape it:

- Index writes on the instance's one App would reach every repository the
  owner owns, so they go through a second App installed only on the index
  repository, as the
  [refresh design](2026-10-15-llm-refresh.md#github-permissions) records.
  Dashboard edits share that App.
- The index decision says hosted code
  [never moves an entry between sections](2026-10-12-projects-index.md#relationship-to-the-first-deliverable-and-classifications)
  except through a PR the owner merges, although its section on hosted
  writes says an owner's own dashboard edit could commit directly. Until the
  owner amends the first rule, a dashboard accept opens a PR.

## With Contents read

If `show-project-index` adds Contents read, the rules stay the same and
three signals improve:

- Last activity becomes the latest commit by a person on any branch, which
  removes the bot-push guess.
- First activity becomes the first commit's date, and Thin can use a commit
  count, counting named branches only
  ([decision](2026-10-12-projects-index.md#survey-signals)), instead of the
  span.
- Loose ends can include pushed branches with commits not on the default
  branch and no open PR.

## Rejected alternatives

- **Moving entries to the suggested section, or showing them under it.** This
  breaks the settled rule that the owner's section is authoritative.
- **Remembering dismissed suggestions in Seshat's storage.** The storage
  would hold owner judgment that cannot be rebuilt from GitHub and the file,
  against the index decision.
- **A single set of thresholds.** Simpler to explain, but a project near a
  boundary would gain and lose a suggestion with each burst of work.
- **Suggesting from every signal the laptop survey reports, such as local
  branches.** Merged branches nobody deleted would make many quiet projects
  look stranded.
- **Suggesting Archived from long quiet.** Archived is the owner's statement
  that a project is finished; quiet only says Dormant.
- **A per-instance mapping of section names to classifications.** It would
  let the owner keep names such as "Active projects", but the owner can as
  easily rename the section, and the mapping is one more setting to explain.

## Not verified

- How often bot pushes move `pushed_at` on the owner's repositories, and how
  well the 10-minute match against bot PR head commits catches them across
  all of them; one repository was checked.
- Whether a PR's head commit date is available in the GraphQL PR reads under
  Pull requests read alone, as listing a PR's commits is.
- The thresholds. None has been tried against the owner's index; they are
  starting values.

## Owner choices

Each has a recommendation, which takes effect if this is merged unchanged,
and the alternative.

1. **Known classifications.** The brief's seven, by exact name, with other
   sections shown but never suggested against. Alternative: a configurable
   mapping from section names to the seven.
2. **Thresholds.** The fit and suggestion tables above, as constants changed
   by PR. Alternative: instance settings the owner edits in Seshat.
3. **Where suggestions show.** A marker on the entry's row, counted in the
   index header with a filter. Alternative: only in the entry's detail, with
   no count.
4. **Repositories with no entry.** Show a suggested classification as a hint.
   Alternative: show evidence only.
5. **Expiry.** None; quiet time raises a suggestion instead. Alternative: a
   `Classified: YYYY-MM-DD` owner field that restarts the quiet count when
   the owner confirms a classification, which adds a field to the format.
6. **Laptop warning age.** 30 days, on observations that change day to day.
   Alternative: 14 days, for an owner who surveys weekly.
7. **Several repositories.** One entry per repository until a project needs
   grouping. Alternative: add a field listing further repositories now,
   changing the format.
8. **Quiet forks.** Suggest Upstream. Alternative: never suggest Upstream,
   and show the fork flag only as evidence.
9. **Repositories that are not monitored.** Use a fork's last push
   unchecked, and say so in the reason, since Dependabot is off on forks
   unless the owner turns it on; ignore any other repository's. Alternative:
   ignore every unchecked push, and skip the no-date fork rule when a push
   was ignored rather than absent, which keeps bot pushes out entirely but
   leaves most forks with no recency at all.

## Follow-up work

Queue entries in [TODO.md](../../TODO.md):

- `suggest-classifications`: the rules as pure functions in the shared
  module, with tests for every row of both tables and the examples, and the
  markers, reasons, count and filter in the index view. After
  `show-project-index`.
- `show-project-index` gains the laptop warning age, the future-date
  warning, sections in file order and the Upstream wording for repositories
  outside the installation.
- `write-survey-prompt` gains a note to cite these rules when proposing to
  move an entry.
- `edit-index-from-dashboard` and `group-multi-repo-projects`, both for
  triage.

[openapi]: https://github.com/github/rest-api-description
[dependabot-forks]: https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/configure-version-updates#enabling-version-updates-on-forks
[dependabot-security-forks]: https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-security-updates#enablement-for-forked-repositories
