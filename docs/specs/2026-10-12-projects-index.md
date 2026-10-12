# Project index: source of truth and update workflow

Proposal for `replace-projects-index` in [TODO.md](../../TODO.md), written
2026-10-12.

**Status: proposal awaiting the owner's decision.** Nothing here is decided
until [DECISIONS.md](../DECISIONS.md) records it. The questions that need the
owner's judgment are listed under
[Questions for the owner](#questions-for-the-owner), each with a recommended
answer.

## Recommendation in brief

Keep the project index as Markdown in a dedicated private repository the owner
selects. That file is the only durable record of what GitHub cannot supply:
owner judgment (classification, summary, next action, notes) and dated
observations from an optional laptop survey. Seshat reads the file, joins each
entry to the repository it names, and shows GitHub evidence beside it, derived
live and never written back. Cloudflare storage holds only data that can be
rebuilt from GitHub and the file.

The laptop agent updates the file with git: by direct push after the owner
approves the diff in the session, or by draft PR when it runs unattended.
Seshat writes nothing to the index for now. If `evaluate-optional-llm-refresh`
later adopts hosted refresh, it proposes changes only by PR, with one open
refresh PR at a time, from an identity other than the owner's where the
integration allows it, and otherwise as a draft.

This needs no new credential on the laptop and keeps the file usable without
Seshat. Seshat's extra GitHub access is reading one repository, and only that
repository where the integration allows per-repository grants; see
[GitHub access needs](#github-access-needs).

## The index today

The owner's current file is a local Markdown document, maintained by asking an
agent to re-survey a directory of checkouts and edit the file in place. Hand
edits are expected, and the agent reads the current file before changing it.
These structural observations shape the options; the contents stay out of this
repository.

- Second-level headings are classification sections: the brief's seven, plus a
  section for local directories that are not projects.
- Third-level headings are projects, named after their checkout directory.
- Each project has labelled bullet fields (stack, start date, last commit and
  branch, branch list, next action, and where relevant the GitHub remote as
  `owner/name`, unpushed work, a local path and notes), plus a prose summary.
- A file-level line records the date of the last full survey.
- A local script parses the file by this heading structure, lists projects by
  classification and checks the file against the directories on disk. The
  structure is therefore already a contract, not only a convention.
- Roughly half of the entries name a GitHub remote. The rest are local-only,
  or their remote was not recorded.
- The file lives in a local repository with no remote.

Two consequences follow. Entries are keyed by local directory, so the hosted
side needs an explicit join to GitHub repositories. And a survey of a laptop
can notice things that are not about any project and should not leave the
machine, for example an employer's repositories or files that look like they
hold secrets.

## Requirements

- Keep the brief's [evidence boundary](../BRIEF.md#project-index): the hosted
  side must never imply that local evidence was inspected. The first
  deliverable states a stricter form of the rule for the PR overview under
  [Evidence boundary](../DELIVERABLE.md#evidence-boundary).
- Owner judgment must survive refreshes. Nothing automated may silently
  overwrite a classification, a next action or a note.
- The index must stay readable and editable without Seshat, and the owner must
  be able to back it up and move it.
- Private repository names, local-only repository names, summaries and notes
  must not become public by accident (`define-public-view`).
- The basic dashboard must not depend on the laptop agent or on any LLM.
- Seshat's extra GitHub access should be the least that works.

## Evidence split

| Evidence | Hosted GitHub data | Laptop survey |
| --- | --- | --- |
| Commits on pushed branches, with dates | Yes | Yes, as of the survey |
| Remote branches, ahead/behind the default branch | Yes | Yes, as of the last fetch |
| Open and merged PRs, review and CI state | Yes | Only through the GitHub API |
| Fork parent, archived flag, visibility, creation date | Yes | Partly |
| Last push and other activity dates | Yes | Partly |
| Unpushed commits and local-only branches | No | Yes |
| Uncommitted changes and stashes | No | Yes |
| Repositories with no GitHub remote | No | Yes |
| Stack as built (toolchain files, lockfiles) | Partly (languages) | Yes |
| Intent: classification, next action, notes | No | Only as proposed by the agent; the owner decides |

Hosted evidence is current to the last sync. Laptop evidence is current only to
the survey date, and only for the checkouts on the machine that ran it. The
two can disagree without either being wrong: a branch the survey listed as
unmerged may have been merged on GitHub since. Seshat should show such a
disagreement as two dated observations, not resolve it.

## Source-of-truth options

The brief names three options. Each is assessed on who writes, conflicts,
where owner judgment lives, portability, privacy and build cost.

### A. Dashboard data in Cloudflare storage

Seshat's storage holds every field. The owner edits in the dashboard. The
laptop agent posts its survey to an instance API.

- **Writers:** the owner through the dashboard, the laptop agent through an
  API, and hosted refresh directly.
- **Conflicts:** concurrent writes need application-level locking or
  last-write-wins. A survey that overwrites an owner's edit made in the
  meantime is hard to detect without per-field versioning.
- **Owner judgment:** in storage, editable only through Seshat.
- **Portability and backup:** needs an export feature and a backup routine.
  History exists only if Seshat records it. If the instance is lost, so is
  the record. The local script would need a generated copy of the file.
- **Privacy:** data sits behind owner sign-in, which is good, but the laptop
  needs a long-lived credential for the instance API. That is a new secret to
  issue, store, rotate and revoke, and a new way in.
- **Build cost:** higher than B. An editor, an authenticated ingestion API,
  history, export and import all have to be built before the index is as
  useful as the file is now.

### B. Markdown in an owner-selected repository

A Markdown file in a repository the owner chooses (expected to be private) is
the record. Seshat reads it.

- **Writers:** the owner (locally, or in GitHub's web editor) and the laptop
  agent, both through git. Hosted writes are a separate choice, discussed
  under [Hosted writes](#hosted-writes-and-self-pr-behaviour).
- **Conflicts:** git handles them. A push that is behind is rejected and the
  writer rebases. Nothing is overwritten silently unless someone force-pushes.
- **Owner judgment:** in the file, where the owner already keeps it.
- **Portability and backup:** a git repository, with full history, that
  clones anywhere. It works with no Seshat instance, and the local script
  keeps working against a clone.
- **Privacy:** protected by the repository's visibility. Seshat needs read
  access to the file's contents in one more repository, which may widen its
  access to other repositories depending on the integration (see
  [GitHub access needs](#github-access-needs)). The laptop uses the owner's
  existing git credentials.
- **Build cost:** moderate. A documented format, a parser that reports errors,
  ingestion on push, and a view that joins entries to GitHub evidence. The
  file format becomes an interface that Seshat and the laptop agent both
  depend on.

The weakness of B on its own is that it invites storing GitHub-derived facts
in the file, which then go stale, or having Seshat commit them, which creates
noise. The recommended model below addresses this by splitting fields by
source.

### C. A synchronized combination

Both stores hold editable data and are kept in step.

- **Two-way sync**, where either side may edit any field, combines the costs
  of A and B and adds merge logic between git and storage. Conflicts become
  Seshat's problem rather than git's. Not recommended.
- **One-way, split by field source**, where the file holds what only the
  owner or the laptop can know and storage holds a rebuildable cache of GitHub
  evidence plus the parsed file, is B with a clear rule about what goes where.
  This is the recommendation.

### Comparison

| | A: dashboard | B/C: Markdown, split by source | C: two-way sync |
| --- | --- | --- | --- |
| Durable record | Cloudflare storage | Git repository | Both |
| Conflict handling | Built by Seshat | Git | Built by Seshat |
| Works without Seshat | No | Yes | Partly |
| New laptop credential | Yes | No | Depends on whether the laptop writes through git or the instance |
| Seshat GitHub access beyond monitoring | None | Read the index repository's contents | Read and write the index repository's contents |
| Build cost | High | Moderate | Highest |

## Recommended model

### Index repository

The owner selects one repository and one file path, defaulting to
`PROJECTS.md` at the root. It should be dedicated to the index, so that
where the integration allows per-repository grants, granting Seshat access to
it exposes nothing else. Seshat shows the repository's visibility on its
settings page and warns prominently if it is public, because the file names
private and local-only repositories.

If it is owned by the owner's personal account and not a fork, it is monitored
by default under the first deliverable's rules, and its PRs appear in the
overview. That is useful: a pending index PR shows up as something needing the
owner. The owner can still turn monitoring off; Seshat reads the index either
way.

### Field ownership and provenance

Every field in the file has one kind of source, implied by its name, so
provenance needs no inline markup. The file holds only owner-authored and
laptop-observed fields. GitHub-derived fields are never stored in it.

| Kind | Examples | Written by | Seshat shows it as |
| --- | --- | --- | --- |
| Owner judgment | Classification (the section an entry sits under), summary, next action, notes | The owner; the laptop agent may propose | The owner's, from the index at its last commit |
| Join key | Repository (`owner/name`), local path | The owner or the laptop agent | Used to join; shown as written |
| Laptop observation | Stack, local last commit, local branches, unpushed commits, uncommitted changes | The laptop agent | Reported by the laptop survey on its date |
| Survey date | `Surveyed: YYYY-MM-DD`, per entry | The laptop agent | The age of the laptop evidence |
| GitHub evidence | Last push, remote branches, open PRs, fork parent, archived | Never written to the file | From GitHub, as of the last sync |

The survey date is per entry, not only per file, because a survey may cover
some checkouts and not others, for example when the owner has more than one
machine.

The current file's fields map onto this table with one change of meaning:
"last commit" and "branches" become local observations, dated by the survey,
rather than facts Seshat relies on. The file stays a complete standalone
survey, and Seshat puts GitHub's live values beside it with their own labels.

### Keeping the evidence boundary

- Absence in the file means "not reported", never "none". If an entry has no
  uncommitted-changes field, Seshat says there is no local survey for it, not
  that it is clean.
- A laptop observation is always shown with its survey date and source, for
  example "unpushed commits: 2, laptop survey 2026-10-11". It is never merged
  into a GitHub value or shown without its date.
- A monitored repository with no entry in the index shows GitHub evidence only
  and says it has no index entry.
- An index entry with no GitHub repository is shown from the file alone, with
  each field labelled with its source (the owner or the laptop survey) and no
  GitHub evidence.
- Wording that Seshat generates itself, such as "no recent activity", is
  qualified as GitHub activity.

### Joining entries to repositories

An entry joins to a GitHub repository through its repository field. Seshat
resolves `owner/name` to GitHub's repository ID once and follows renames from
then on, so a renamed repository does not drop out of the join. An entry
whose repository cannot be resolved, because it was deleted, renamed beyond
GitHub's redirect, or is not accessible to Seshat, is shown with a visible
warning. It is not dropped.

The first cut joins one entry to one repository. Projects that span several
repositories can wait for the classifications design.

### Ingestion

- Seshat re-reads the file when the index repository's default branch changes,
  through whatever mechanism `choose-change-detection` selects for monitored
  repositories, plus the same reconciliation.
- It parses the file into storage as a cache. Rebuilding the cache from the
  repository must reproduce it exactly.
- A parse error does not blank the index. Seshat keeps the last good parse,
  shows that the index failed to parse with the commit and line, and shows the
  commit time of the last good parse.
- Unknown fields are kept and shown as unrecognised fields of unknown source,
  not as owner notes. Unknown section names are accepted and shown as written;
  this decision does not fix the set of classifications.
- A format check that Seshat and the laptop agent share (and that the index
  repository's CI could run) keeps the two parsers from drifting.

## Laptop-agent workflow

The optional laptop agent is a prompt or skill the owner runs locally. It
reads the current index from a clone, surveys local checkouts, and proposes
edits: refreshing laptop observations and survey dates, adding entries for new
checkouts, and suggesting changes to owner fields such as next actions. It
never deletes an entry for a checkout it did not find without the owner's
confirmation, since the checkout may live on another machine.

The prompt itself is generic and can live in this public repository. The
owner's own settings (which directories to survey, what to exclude) stay in
the private index repository or on the laptop. The prompt must exclude work
checkouts and must never record secrets or observations about non-project
files. Anything it writes leaves the laptop for a private GitHub repository
and Seshat's storage.

### PR or direct push

| | PR to the index repository | Direct push to the default branch |
| --- | --- | --- |
| Review | The owner reviews the diff on GitHub, separately from the session | The owner reviews the diff in the session before the agent pushes |
| History | One squash commit per survey, plus a PR thread | One commit per survey, no thread |
| Noise | A PR per survey in the overview and in notifications | None beyond the commit |
| Conflicts | Surface at merge; the PR can go stale while it waits | A push that is behind is rejected; the agent pulls, rebases and shows the diff again |
| Unattended runs | Safe: nothing lands without review | Unsafe without a standing authorization |
| Ingestion | When the PR is merged | When the push lands |
| Format check | Can run as PR CI in the index repository | Runs locally before the push |

A PR the laptop agent opens is authored by the owner's account, because the
agent uses the owner's credentials and has no other identity. In the overview
it is therefore the owner's PR, and with no CI a non-draft one lands in Ready
to land. That bucket says the owner's work is ready to merge, which is wrong
for generated content nobody has read. The unattended agent should open its PR
as a draft, so it sits in Draft until the owner reads it and marks it ready.
The same rule applies to any generated PR authored as the owner; see
[Hosted writes](#hosted-writes-and-self-pr-behaviour). The cost is visibility:
Draft is in the Waiting group, so the owner has to look for it.

Recommended: when the owner runs the agent and is present, the agent shows the
diff, asks, then pulls, commits and pushes directly, never force-pushing. When
it runs unattended, it opens a draft PR, updating its own open PR rather than
adding another. This matches how the owner maintains the file now (edited in
place with the agent in the loop) while keeping review for runs nobody
watches.

## Hosted writes and self-PR behaviour

Three ways hosted updates could reach the index:

- **Dashboard-only.** Hosted signals are computed and shown, and never
  written. This is the recommendation for deterministic signals. They are
  rebuildable from GitHub, so writing them to the file only adds commits that
  go stale.
- **Direct commits.** Seshat commits to the default branch. Rejected for
  automated updates: a commit on every change to any monitored repository is
  noise, and unattended edits to owner fields would breach the rule that owner
  judgment survives refreshes. An edit the owner makes in the dashboard, if
  that is ever added, is different: it is the owner's own action and could
  reasonably commit directly.
- **PRs.** Seshat opens a PR for the owner to accept. This is the only
  acceptable path for content Seshat generates without the owner present,
  which in practice means the optional LLM refresh.

If `evaluate-optional-llm-refresh` adopts hosted refresh, these constraints
come from this decision; approval flow, keys and cost bounds stay with that
entry.

- Refresh proposes changes only through PRs, never direct commits.
- At most one refresh PR is open at a time. A new refresh updates it rather
  than opening another.
- A refresh is triggered by a schedule or an owner request, never by a push to
  the index repository. Otherwise merging a refresh PR triggers the next
  refresh, which is the self-PR loop the brief warns about.
- The PR should be authored by an identity other than the owner's account.
  Under the first deliverable's rules, an owner-authored PR with no CI is
  Ready to land without review; a refresh PR authored as someone else lands in
  Awaiting your review instead, which is accurate, and does not look like the
  owner's own work. If the chosen integration can only author as the owner,
  refresh PRs open as drafts, like unattended laptop-agent PRs.
- Refresh may propose changes to owner fields but never to laptop
  observations, which it cannot verify.
- Refresh may propose new entries for monitored repositories that have none,
  with the repository field as the join key and only owner fields filled in.
  It never changes an existing entry's join key, and never adds or removes
  entries for local-only repositories, which it cannot see.
- Refresh sends private index content (owner notes, next actions, local-only
  repository names) and private GitHub context to the LLM provider.
  `evaluate-optional-llm-refresh` must decide what is sent and get the owner's
  consent for it.

## Privacy and the public view

- The index repository is private by default and Seshat warns when it is not.
- Nothing from the index appears in a public view unless `define-public-view`
  introduces explicit per-project consent. Owner notes, next actions,
  local-only repository names and laptop observations should be excluded even
  then unless consent names them.
- Because the file is the only durable copy of the index and storage is a
  rebuildable cache, revoking Seshat's access and clearing its storage removes
  the index from the instance completely.

## GitHub access needs

For `choose-github-integration`, which this proposal does not decide:

- **Now:** read the contents of one owner-selected repository, which may be
  private and may be excluded from monitoring, and learn when its default
  branch changes. Webhook push events or polling would both work.
- **Later, only if hosted refresh is adopted:** create a branch, commit and
  open or update a PR on that one repository. Seshat needs no write access to
  monitored repositories for this.
- **Scope constraint:** the aim is contents access to the index repository
  alone, but not every mechanism can grant that. A GitHub App's permissions
  apply to every repository in an installation, and an App has only one
  installation per account, so adding contents read (or later write) for the
  index would extend it to every monitored repository on the owner's account.
  Contents access limited to the index needs either a separate App for the
  index, or an index repository owned by a different account, such as an
  organization, with its own installation. An App can narrow each
  installation token it requests to one repository and one permission, which
  limits what Seshat itself does with a token, but not what a leaked private
  key could reach. A classic OAuth token cannot be limited to one repository
  at all. `choose-github-integration` should weigh this; if per-repository
  scope is not available, the owner should be told how far the extra access
  reaches.
- **Authoring identity:** refresh PRs should come from an identity other than
  the owner's account where the integration allows it, and otherwise open as
  drafts (see above). A GitHub App's bot identity provides this naturally; a
  user OAuth token would author the PRs as the owner, so they would be drafts.
- **Laptop:** the laptop agent uses the owner's existing local git and GitHub
  credentials and needs no Seshat credential.

## Relationship to the first deliverable and classifications

The PR overview does not read the index, and nothing in this proposal blocks
it. Replacing `PROJECTS.md` is out of scope for the first deliverable per
[DELIVERABLE.md](../DELIVERABLE.md#scope). The access needs above are listed
so the integration choice does not rule the index out.

Settled by this decision:

- Where the owner's classification lives: the section an entry sits under in
  the file. Hosted code never moves an entry between sections except through
  a PR the owner merges. Whether that section is authoritative over computed
  classifications is put to the owner in question 6.
- Which fields the file holds, who writes each, and how provenance and
  freshness are shown.
- The write paths for the owner, the laptop agent and any hosted refresh.

Left for the classifications design, which has no queue entry yet:

- The set of classifications and the thresholds for any computed ones.
- Whether Seshat suggests classifications from evidence, how a suggestion is
  shown when it disagrees with the owner's, and whether an owner
  classification ever expires.
- When laptop evidence counts as too old to show without a warning.
- Projects that span several repositories.
- Whether the owner can edit index fields from the dashboard.

## Rejected alternatives

- **Dashboard storage as the source of truth (option A):** the most to build,
  no history or portability without extra work, a new laptop credential, and
  the index stops being usable without the instance.
- **Two-way sync:** the costs of both stores plus conflict resolution between
  them, for no gain over a one-way split.
- **Storing GitHub-derived facts in the file and having Seshat keep them
  current:** commit noise on every monitored change, a standing need for write
  access, and duplicated facts that drift.
- **Direct hosted commits for automated content:** unreviewed changes to owner
  judgment, and a loop risk once refresh exists.
- **Always using PRs for the laptop agent:** a review step the owner has
  already performed in the session, plus a PR in the overview after every
  survey. Kept as the mode for unattended runs.
- **Keeping the file in a repository that also holds unrelated files:**
  granting Seshat read access would expose the rest, even where the
  integration allows per-repository grants.

## Questions for the owner

1. **Source of truth.** Should the index be Markdown in a dedicated private
   repository, with GitHub evidence derived live by Seshat and never written
   back? Recommended: yes.
2. **Laptop-agent updates.** Should the laptop agent push directly after you
   approve its diff in the session, and open a draft PR only when it runs
   unattended? Recommended: yes. The alternatives are a PR for every survey,
   or unattended PRs that are not drafts and so appear in Ready to land
   before anyone has read them.
3. **Standalone file.** Should the file stay a complete standalone survey,
   with last commit and branches kept as dated local observations, or shrink
   to owner judgment plus what GitHub cannot see? Recommended: stay
   standalone, so the file and the local script remain useful without
   Seshat.
4. **Local-only repositories.** Are you content for the names and summaries of
   local-only repositories to live in the private index repository and in
   Seshat's storage? Recommended: yes, since they are the main thing only the
   index can show, with work checkouts and non-project observations excluded
   by the agent's prompt.
5. **Hosted writes.** Should Seshat write nothing to the index until
   `evaluate-optional-llm-refresh` is decided, and then only by PR, from a
   non-owner identity where the integration allows it and otherwise as a
   draft? Recommended: yes.
6. **Authoritative classification.** Is the section an entry sits under the
   authoritative classification, with computed classifications only ever
   shown as suggestions? Recommended: yes. The brief says some
   classifications express owner judgment, and a computed value that
   silently replaced the owner's would break the rule that owner judgment
   survives refreshes. Thresholds and how suggestions look stay with the
   classifications design.

## Follow-up work if accepted

Once the owner decides, record the decision in
[DECISIONS.md](../DECISIONS.md), update the
[brief's open questions](../BRIEF.md#open-design-questions), and consider
queue entries for:

- Migrating the index: creating the dedicated private repository, moving the
  file into it, and replacing the single file-wide survey date with
  per-entry `Surveyed:` lines. The owner's local script parses the file and
  may need updating for the new fields.
- Documenting the index format and its shared format check.
- Writing the laptop-agent prompt or skill.
- Ingesting the index and showing it beside GitHub evidence, as a deliverable
  after the PR overview.
- The classifications design, which the brief lists as an open question but
  the queue does not yet track.

`evaluate-optional-llm-refresh` is unblocked by the decision.
