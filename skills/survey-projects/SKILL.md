---
name: survey-projects
description: Survey the git checkouts under a configured directory and propose updates to the owner's Seshat project index (PROJECTS.md, format 1), or migrate an older index file to format 1. Use when the owner asks to survey, refresh or migrate their project index, or when a scheduled unattended survey runs.
---

# Survey projects

You survey the owner's local git checkouts and update the project index, a
Markdown file in a git repository the owner controls. You write laptop
observations and survey dates, add missing join keys and new entries, and
propose everything else for the owner to decide. These instructions are
written for any agent harness; where they say "ask the owner", stop and ask
in the conversation and wait for an answer.

The file format is defined in `docs/INDEX_FORMAT.md` in the Seshat
repository ([link](../../docs/INDEX_FORMAT.md)). It is the authority for how
the file is read and written; this skill says how to apply it. Resolve this
file's real path first (it is usually installed through a symbolic link) and
read `INDEX_FORMAT.md` from two directories above it, in full, before you read
or edit the index. If it is not there, stop and tell the owner the skill must
be installed from a Seshat checkout; see [README.md](README.md).

## Modes

- **Interactive**, the default. The owner is present. You show the diff, and
  push to the index's default branch only after the owner approves it.
- **Unattended**, only when the invocation says so in words (for example the
  argument `unattended`). Nobody is present. You never push the default
  branch; you push a review branch and, where configured, open or update one
  draft PR.
- **Migrate**, when the owner asks to migrate or import their current index
  file. Always interactive. See [Migration](#migration).

If you cannot tell which mode applies, use interactive. If you are in
interactive mode and cannot get an answer from the owner, push nothing.

## Rules for every run

1. **Git only.** Use git and ordinary shell utilities (`cd`, `pwd`, `ls`,
   `find`, `grep`, `sed`, `awk`, `sort`, `head`, `wc`, `tr`, `paste`,
   `printf`, `date`, `mktemp`, `hostname`). Assume nothing about where any
   repository is hosted. The exceptions are `gh`, only in an unattended run
   with `index.pullRequests = gh`, and the `seshat` CLI once it exists (see
   [Signals](#signals)).
2. **Surveyed checkouts are read-only.** Run only the commands given in
   [step 3](#3-find-checkouts) and [Signals](#signals) in them, and read no
   file there except the manifests named under Signals and the README for a
   proposed summary. Never fetch, pull, check out, stash, commit,
   prune, `gc`, run `remote set-head` or change config in a surveyed
   checkout. Run `git status` with `--no-optional-locks` so that it does not
   rewrite the index file.
3. **Never force-push.** No `--force`, `--force-with-lease`, `+` refspecs,
   `--mirror` or deleting remote branches, in any mode. When a push is
   rejected, fetch and build on the new remote state as described below.
4. **The default branch moves only with approval.** Push the index's default
   branch only in interactive mode, after the owner has approved the final
   diff in this session.
5. **Never delete an entry without confirmation.** An entry whose checkout you
   did not find may be on another machine. Interactive runs ask; unattended
   runs never delete.
6. **Excluded checkouts leave no trace.** For a directory that matches an
   exclusion (see [Configuration](#configuration) and
   [step 3](#3-find-checkouts)), record nothing: not in the file, a commit
   message, a PR, or your report beyond a count.
7. **No secrets and no observations about non-project files.** Never record
   file contents, the names of untracked or modified files, environment
   values, or remote URLs (record `owner/name` only, which also drops any
   credentials embedded in a URL). Never open files whose names suggest
   secrets (`.env*`, `*.pem`, `*.key`, `id_*`, `*credential*`, `*secret*`,
   `*token*`, `*.p12`, `*.keychain*`). Record nothing about loose files in the
   survey root or about what a directory that is not a git checkout
   contains.
8. **Write by the format.** Follow
   [Writing the file](../../docs/INDEX_FORMAT.md#writing-the-file) and
   [Editing the file](#editing-the-file). Never push a file with errors as
   defined in [Errors](../../docs/INDEX_FORMAT.md#errors).
9. **Count named branches only.** Any commit count, written or shown in the
   session, counts commits reachable from `refs/heads/` (`--branches`), never
   `--all`, which includes hidden refs that tools create. The one exception
   is the count of commits on a detached `HEAD` under
   [Unpushed](#unpushed): `HEAD` is the checked-out commit, not one of those
   hidden refs, and the count excludes everything a branch already holds.

## Configuration

Settings live on the laptop, in git-config syntax, at `$SESHAT_SURVEY_CONFIG`
if that is set and otherwise at
`${XDG_CONFIG_HOME:-$HOME/.config}/seshat/survey.conf`. Read each key with
git, which follows `[include]` files. Read the two path keys, `survey.root`
and `index.clone`, with `--type=path`, which expands a leading `~`; without
it the `~` stays literal:

```sh
conf="${SESHAT_SURVEY_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/seshat/survey.conf}"
git config -f "$conf" --includes --type=path --get survey.root
git config -f "$conf" --includes --type=path --get index.clone
git config -f "$conf" --includes --get-all survey.exclude
```

A missing key makes `git config` exit 1; use the default below. If the file
is missing, interactive runs offer to write one from the owner's answers and
unattended runs stop.

| Key | Default | Meaning |
| --- | --- | --- |
| `survey.root` | required | Directory whose children are surveyed. `Path` values are relative to it. |
| `survey.machine` | output of `hostname -s` | Name used for this machine in commit messages and PR titles. Set it, since host names can change with the network. |
| `survey.exclude` | none | Repeatable. A pattern matched against a directory's path relative to the root. |
| `survey.excludeRemote` | none | Repeatable. A pattern matched against every remote URL of a checkout. |
| `survey.githubHost` | none | Repeatable. Extra host names, such as SSH aliases, whose remotes are recorded as `owner/name`. `github.com` is always recognised. |
| `survey.unattendedSection` | none | Section that unattended runs add new entries to. Unset means unattended runs add no entries. |
| `index.clone` | required | Local clone of the index repository. |
| `index.remote` | `origin` | Name of the index repository's remote in that clone. The URL is the clone's own remote configuration. |
| `index.branch` | the remote's `HEAD`, else `main` | The branch Seshat reads. |
| `index.file` | `PROJECTS.md` | Path of the index file in the repository. |
| `index.reviewBranch` | `seshat-survey` | The branch unattended runs push to, and the head of their PR. |
| `index.pullRequests` | `none` | `gh` to open draft PRs with the GitHub CLI in unattended runs; `none` to push the review branch only. The default is `none` because `gh` is a host-specific tool and git alone cannot tell whether the host has PRs; an index on GitHub should set `gh`. |

Patterns use shell `case` matching, in which `*` also matches `/`. Shared
exclusions can live in a file in the index repository, pulled in with
`[include] path = <clone>/survey-exclude.conf`; a relative include path is
relative to the file that includes it.

## Steps

### 1. Prepare the index clone

Let `clone`, `remote`, `branch` and `file` be the configured values. Find the
default branch, if not configured, with
`git -C "$clone" symbolic-ref --quiet --short "refs/remotes/$remote/HEAD"`
(strip the `$remote/` prefix), falling back to `main`.

```sh
git -C "$clone" fetch --prune "$remote"
```

`--prune` drops remote-tracking branches deleted on the remote, so a review
branch the owner deleted is not mistaken for one that still exists.

Interactive and migrate runs edit the clone itself:

- `git -C "$clone" status --porcelain` must be empty and the clone must be on
  `$branch`. Otherwise stop and ask the owner.
- If `git -C "$clone" rev-list --count "$remote/$branch..$branch"` is not
  zero, the clone has commits that are not pushed. Show them
  (`git -C "$clone" log --oneline "$remote/$branch..$branch"`) and ask whether
  they may be pushed with the survey. If not, stop.
- `git -C "$clone" merge --ff-only "$remote/$branch"`. If it fails, stop and
  ask.

Unattended runs leave the owner's clone as it is and work in a temporary
worktree; see [Unattended: publish](#unattended-publish) for the commit it
starts from. Remove it when done, including after a failure, with
`git -C "$clone" worktree remove --force "$tmp"`. `--force` is needed
because a failed run can leave the worktree dirty, and is allowed only for
this scratch worktree, which the run created and nothing else uses; never
use it on any other worktree.

### 2. Read the index

Read the file by [INDEX_FORMAT.md](../../docs/INDEX_FORMAT.md). For each
entry note its name, section, line, `Remote`, `Path`, `Surveyed`, which
defined fields it has and where each field's item starts and ends.

- If `Format` is not `1`, stop and report it.
- Look for the problems in the [Errors](../../docs/INDEX_FORMAT.md#errors)
  table. If `seshat check` is available (see [Signals](#signals)), run it
  instead and use its result. Errors already in the file block the push:
  interactive runs report them and offer to fix them (for an unmigrated file,
  offer [Migration](#migration)); unattended runs stop and report.
- Note any entry with a `duplicate-field` or `misplaced-field` problem on a
  laptop observation label. You will not edit that entry; report it.

### 3. Find checkouts

Strip any trailing `/` from `root`, then list its children:

```sh
root="${root%/}"
find "$root/" -mindepth 1 -maxdepth 1 \( -type d -o -type l \) | sort
```

The trailing `/` in the `find` argument makes it descend when `root` is
itself a symbolic link, which on macOS it otherwise does not. Each result
is `"$root/<name>"`; `rel` is the part after `"$root/"`, with no leading or
trailing `/`. Keep the results that are directories (`[ -d "$d" ]` follows
links). For each directory `d`:

1. If `rel` is a parent of some entry's `Path` (that `Path` starts with
   `rel/`), it holds checkouts surveyed through those entries. Skip it.
2. If `rel` matches a `survey.exclude` pattern, it is excluded.
3. Decide whether it is a checkout:

   ```sh
   top=$(git -C "$d" rev-parse --show-toplevel 2>/dev/null)
   real=$(cd "$d" && pwd -P)
   ```

   It is a checkout only if `top` is not empty and equals `real`. A
   directory inside some other repository is not a checkout.
4. For a checkout, list every fetch and push URL of every remote:

   ```sh
   for r in $(git -C "$d" remote); do
     git -C "$d" remote get-url --all "$r"
     git -C "$d" remote get-url --push --all "$r"
   done
   ```

   `get-url` applies `url.<base>.insteadOf` rewriting, so a shorthand such
   as `work:thing` is matched as the URL it stands for; reading
   `remote.*.url` from the config would give the shorthand. No output means
   no remotes. If any URL matches a `survey.excludeRemote` pattern, the
   checkout is excluded, so a work repository is caught even when its work
   remote is not `origin`. Run nothing else in an excluded directory.

Then add every entry `Path` that is not a direct child of the root, if
`"$root/$path"` exists, and apply the same exclusion and checkout tests to it.

Match each checkout to an entry:

1. The entry whose `Path` is `rel`.
2. Otherwise, the entry with no `Path` whose `Remote` matches the checkout's
   remote (see [Remote](#remote)), ignoring case. You will add the `Path`.
3. Otherwise it is a new checkout.

A checkout that matches two entries, or an entry matched by two checkouts, is
a conflict: change none of them and report it.

Also collect:

- **Missing checkouts:** entries with a `Path` where `"$root/$path"` does not
  exist.
- **Excluded entries:** entries whose `Path` matches an exclusion. Leave them
  untouched and tell the owner, so they can decide whether the entry belongs
  in the index.
- **Directories that are not checkouts and have no entry.** Interactive runs
  ask whether to add an entry with only a `Path`, in the section the file
  uses for directories that are not projects, or to add an exclusion.
  Unattended runs skip them and report only how many there were. Never look
  inside them.

### 4. Collect signals

Collect the [Signals](#signals) for every matched and new checkout that is
not excluded. Entries for missing checkouts, conflicts and directories that
are not checkouts get no new observations and keep their `Surveyed`.

### 5. Edit the file

For each matched checkout, refresh its entry:

- Set every laptop observation in the [Signals](#signals) table to the value
  collected, and set `Surveyed` to today's date (`date +%F`). If a signal
  cannot be collected (an empty repository has no `Started` or
  `Last commit`), remove that field from the entry, as
  [Writing the file](../../docs/INDEX_FORMAT.md#writing-the-file) requires.
- Add a missing `Path`. Add a missing `Remote` when [Remote](#remote) gives a
  value.
- Do not change an existing `Remote` or `Path`, `Next`, `Note`, the summary,
  the heading or the section. Changes you think are needed are proposals
  (step 6).

For each new checkout:

- Interactive: add an entry at the end of the section you propose, chosen
  from the sections in the file by the signals (for example, recent commits
  suggest the section the file uses for active work), with your reason in
  the report. The heading is the directory name. Fields are `Remote` (when
  known), `Path`, the laptop observations and `Surveyed`, in that order. You
  may propose a one-sentence summary from the first paragraph of the
  checkout's README, if it has one; it goes in only if the owner accepts it.
- Unattended: add the entry the same way, without a summary, to the section
  named by `survey.unattendedSection`. If that key is unset or names no
  section in the file, add no entries and report only how many new checkouts
  there were.

### 6. Prepare proposals

Collect these as proposals, not edits:

- An entry to delete, for each missing checkout. The default answer is keep.
- A `Remote` or `Path` change, for each `remote-mismatch`: the checkout's
  remote differs from the entry's `Remote`, the entry says `none` and the
  checkout has a remote, or the entry names a repository and the checkout
  has no remotes.
- Changes to owner judgment: a different section, a `Next` that the commits
  since the last survey seem to have done, a summary that no longer fits.
  Use the commit subjects from [Signals](#signals) as evidence. In an
  interactive session, quote them briefly. In an unattended run, describe
  the evidence without quoting subjects (for example "12 commits on
  `feature-x` since the last survey"), since the PR body or commit message
  leaves the laptop and subjects were never reviewed for that.

Interactive runs apply the proposals the owner accepts. Unattended runs never
apply them: they go in the PR body, or in the commit message body where there
is no PR.

### 7. Check

Before committing, run `seshat check "$file"` if it is available and require
exit status 0. Until it exists, check the result yourself:

- Read `git -C "$work" diff --unified=0 -- "$file"`, where `work` is the
  clone, or the scratch worktree in an unattended run. Every removed or
  changed line must be part of a laptop observation or `Surveyed` item of a
  refreshed entry, or part of a change the owner accepted. Every added line
  must be an item you were allowed to add, a new entry, or an accepted
  change. Undo anything else.
- Every `Remote`, `Path` and `Surveyed` you wrote is valid as defined under
  [Join keys](../../docs/INDEX_FORMAT.md#join-keys) and
  [Laptop observations](../../docs/INDEX_FORMAT.md#laptop-observations).
- No edit created a `duplicate-field`, `duplicate-remote`, `duplicate-path`,
  `missing-key` or `entry-outside-section` error.

Until the shared check exists, this self-check and the owner's review of the
diff together stand in for it. Say so in your report.

### 8. Interactive: review and push

1. Show the owner the full diff (`git -C "$clone" diff`), then the
   proposals, then the [report](#report). If the only changes are `Surveyed`
   dates, say so and ask whether to commit them anyway.
2. Apply the proposals the owner accepts and any corrections they ask for,
   run [Steps, step 7](#7-check) again, and show the diff again.
3. On approval, commit with the subject
   `Survey checkouts on <machine>, YYYY-MM-DD` and a body that says how many
   entries were refreshed, added and left unchanged. Use the clone's own git
   identity; do not change git config.
4. `git -C "$clone" push "$remote" "HEAD:refs/heads/$branch"`.
5. If the push is rejected because the remote moved, run
   `git -C "$clone" pull --rebase "$remote" "$branch"`. If the rebase stops on
   a conflict, run `git -C "$clone" rebase --abort`, then
   `git -C "$clone" reset --hard "$remote/$branch"` only after the owner
   agrees, and redo the run from Steps, step 2. Otherwise run Steps, step 7
   again on the rebased file, show the new diff
   (`git -C "$clone" diff "$remote/$branch" HEAD`) and ask again before
   pushing.

### Unattended: publish

Let `B` be `index.reviewBranch`. Every unattended run builds its commit
fresh from the default branch, because a survey rewrites the observations it
reports and so supersedes any earlier survey the owner has not merged. When
`B` already holds such a survey, the new commit also records the old tip of
`B` as a parent, so the push is a fast-forward and never needs force,
whatever the owner did with the earlier branch.

1. Where `index.pullRequests = gh`, let `slug` be the `owner/name` of the
   index remote's URL (`git -C "$clone" remote get-url "$remote"`, reduced as
   under [Remote](#remote)), and look for this skill's open PR:

   ```sh
   gh pr list --repo "$slug" --head "$B" --state open --json number,isDraft,url
   ```

   If this fails, push nothing and report: without it you cannot tell
   whether pushing would add unread content to a PR marked ready.
2. `tmp=$(mktemp -d)`, then
   `git -C "$clone" worktree add --detach "$tmp" "$remote/$branch"`.
3. If `refs/remotes/$remote/$B` exists and
   `git -C "$clone" merge-base --is-ancestor "$remote/$B" "$remote/$branch"`
   fails (`B` holds something the default branch lacks):
   - Find the commits added to `B` since this skill last wrote it: walk the
     first-parent chain from its tip, newest first, and stop at the first
     commit whose subject starts with `Survey checkouts on `.

     ```sh
     git -C "$clone" log --first-parent --format='%h %s' "$remote/$branch..$remote/$B" \
       | awk '/^[^ ]+ Survey checkouts on /{exit} {print}'
     ```

     Only these count as commits this skill did not make. Older commits
     reachable through the second parent of a superseding commit were
     already dealt with by the run that superseded them, and must not
     block later runs. If there are any, push nothing and report them,
     unless `index.pullRequests = gh` and step 1 found no open PR. With an
     open PR the owner is editing it; with no PR configuration the review
     branch is the only place those commits are proposed, and building on
     the default branch would drop them from its tip. With `gh` and no open
     PR, the branch belongs to a PR that was merged or closed: note the
     commits for the report, since their changes are not carried forward,
     though they stay in the branch's history.
   - `git -C "$tmp" merge --no-ff --no-commit -s ours "$remote/$B"`. This
     records `B` as a parent and keeps the default branch's file unchanged.
4. Run [Steps](#steps), steps 2 to 7, against the file in the worktree.
   If nothing but `Surveyed` dates would change, push nothing and report
   that.
5. Commit with the subject `Survey checkouts on <machine>, YYYY-MM-DD`. Where
   there is no PR, the commit body carries what a PR body would (see below).
6. With `gh`, if step 1 found a PR whose `isDraft` is false, convert it to a
   draft before pushing anything to it:
   `gh pr ready <number> --repo "$slug" --undo`. If that fails, including
   when the host or plan does not offer drafts, push nothing and report, so
   that unread content never reaches a PR marked ready.
7. `git -C "$tmp" push "$remote" "HEAD:refs/heads/$B"`. If it is rejected,
   remove the worktree, fetch and start again from step 1 of this list,
   once. If it is rejected again, stop and report.
8. With `gh`: if step 1 found a PR, rewrite its title and body to describe
   the branch as it now stands against the default branch
   (`gh pr edit <number> --repo "$slug" --title ... --body-file ...`).
   Otherwise run
   `gh pr create --repo "$slug" --draft --base "$branch" --head "$B" --title "Survey checkouts on <machine>, YYYY-MM-DD" --body-file <file>`.
   If `gh pr create` fails, including when the host refuses a draft PR,
   never open a PR that is not a draft: leave the pushed branch as a review
   branch and report the error.
9. Remove the worktree with `git -C "$clone" worktree remove --force "$tmp"`
   (see [Steps, step 1](#1-prepare-the-index-clone)).

Where the host has no PRs, the owner accepts `B` by merging it into the
default branch, or rejects it by deleting it; otherwise the next run
replaces its content. A squash merge leaves `B` not an ancestor of the
default branch, so after squash-merging a branch that holds the owner's own
commits, delete `B`, or every later run will stop at step 3 of this list.
In either mode, prefer squash merges: the `-s ours` merges on `B` do not
rebase cleanly.

The PR body (or commit body) lists the refreshed and added entries by name,
the proposals from Steps, step 6, the problems found in Steps, step 2, any
commits from step 3 of this list that were not carried forward, and how many
new checkouts and directories were skipped. It names no excluded directory.
It says that the owner's review stands in for the shared format check until
that exists.

## Signals

When the Seshat CLI is installed (`command -v seshat` succeeds and
`seshat survey --help` exits 0), run `seshat survey --json` with the survey
root and take every signal from its output, which its documentation defines.
Use the commands below only when it is not installed, and do not mix the two
in one run. Likewise use `seshat check` for [Steps, step 7](#7-check) when
it exists.

In the commands, `d` is the checkout directory.

| Field | How to collect it | What to write |
| --- | --- | --- |
| `Stack` | Names of top-level entries (`ls -A "$d"`), and the contents of manifest files only | Languages and tools, comma-separated, such as `TypeScript, Vite, Cloudflare Workers` |
| `Started` | `git -C "$d" log --branches --max-parents=0 --format=%as \| sort \| head -n 1` | The date |
| `Last commit` | `git -C "$d" for-each-ref --sort=-committerdate --count=1 --format='%(committerdate:short) on %(refname:short)' refs/heads/` | The output as is |
| `Checked out` | `git -C "$d" symbolic-ref --quiet --short HEAD`, which fails when detached | The branch, or `detached` |
| `Branches` | `git -C "$d" for-each-ref --format='%(refname:short)' refs/heads/`, less the default branch | Comma-separated, or `none` |
| `Unpushed` | See [Unpushed](#unpushed) | Such as `3 on feature-x`, or `none` |
| `Uncommitted` | See [Uncommitted](#uncommitted) | Such as `2 modified, 1 untracked`, or `none` |
| `Surveyed` | `date +%F` | Today's date |

`Started` uses author dates, which survive rebases, and `Last commit` uses
committer dates, which show when work last happened. If
`git -C "$d" rev-parse --verify --quiet HEAD` fails and there are no
branches, the repository has no commits: write `Checked out`, `Branches:
none` and `Uncommitted`, and leave out `Started`, `Last commit` and
`Unpushed`.

**Default branch:** `git -C "$d" symbolic-ref --quiet --short refs/remotes/origin/HEAD`,
without the `origin/` prefix. If that is unset, use `main` or `master` when
exactly one of them exists as a local branch. Otherwise there is no default
branch: list every branch under `Branches` and say so in the report.

**Stack:** read only these manifests, and only to name the tools they
declare: `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `Gemfile`,
`composer.json`, `mix.exs`, `pom.xml`, `build.gradle*`, `deno.json*`,
`wrangler.toml`, `wrangler.json*`. Lockfiles, `tsconfig.json`,
`Dockerfile`, `vite.config.*` and similar files count by name only. If
nothing identifies a stack, leave the field out.

### Remote

Read `git -C "$d" remote get-url origin`, then reduce it to a host, owner and
name:

```sh
printf '%s\n' "$url" \
  | sed -E -n 's#^(ssh://)?([^@/]+@)?([^/:]+)(:|/)([^/]+)/([^/]+)$#\3 \5 \6#p
               s#^https?://([^@/]+@)?([^/]+)/([^/]+)/([^/]+)/?$#\2 \3 \4#p' \
  | sed -E 's/\.git$//'
```

This prints `host owner name` for scp-style (`git@host:owner/name.git`),
`ssh://` and `https://` URLs and drops any user name or token in the URL.

- If the host is `github.com` or a `survey.githubHost` value, the remote is
  `owner/name`.
- If `git -C "$d" remote` prints nothing, the checkout has no remote: the
  value is `none`.
- Otherwise (another host, a URL the command does not parse, or remotes but
  no `origin`) format 1 cannot record the remote. Leave `Remote` as it is and
  say so in the report.

### Unpushed

```sh
git -C "$d" remote | grep -q . || echo 'no remote'
git -C "$d" for-each-ref --format='%(refname:short) %(upstream) %(upstream:track)' refs/heads/
```

If there is no remote, write `Unpushed: no remote`. Otherwise, for each
branch `b`, count the commits on it that no remote-tracking branch has:

```sh
git -C "$d" rev-list --count "refs/heads/$b" --not --remotes
```

Do not count against the configured upstream alone. A branch created from
`origin/main` often tracks it, so once the branch is pushed under its own
name every commit on it is still "ahead of upstream" although none is
unpushed.

Also count commits reachable only from a detached `HEAD`, which no branch
holds:

```sh
git -C "$d" rev-list --count HEAD --not --branches --remotes
```

Write the non-zero counts as `N on <branch>`, plus `N on detached HEAD` for
a non-zero detached count, comma-separated, or `none` if all are zero. The
annotations apply only to branches that appear with a non-zero count: add
`(upstream gone)` when its track is `[gone]`, and `(no upstream)` when its
upstream is empty or does not start with `refs/remotes/`. Counts are as of
the checkout's last fetch, which you do not run. A branch whose upstream is
gone is often one that was squash-merged and deleted on the remote; say that
in the report rather than in the file.

### Uncommitted

```sh
git -C "$d" --no-optional-locks status --porcelain=v1 --untracked-files=all
git -C "$d" stash list | wc -l
git -C "$d" worktree list --porcelain
```

In the status output, lines starting `??` are untracked files and every other
line is a modified file (staged, unstaged, renamed or deleted). Write
`N modified, M untracked`, then `, K stashed` if there are stashes. The
worktree list names the main working tree first, whichever worktree `d` is,
and gives physical paths: the checkout itself is the `worktree` line equal
to `$(cd "$d" && pwd -P)`. For each other worktree whose directory exists,
run the same status there and, if any have changes,
add `; changes in J of T other worktrees`. Write `none` when everything is
zero. Record counts only, never file names.

### For the session only

To support proposals, and only in the session, read the work since the
entry's `Surveyed` date:

```sh
git -C "$d" rev-list --count --branches --since="$surveyed"
git -C "$d" log --branches --since="$surveyed" --format='%cs %s' -n 20
```

Do not write counts or commit subjects into the file.

## Editing the file

Edit the file in place, line by line. Never regenerate it through a Markdown
formatter or rewrite an entry wholesale.

- To change a field, replace only its value. Keep the item's marker,
  indentation and label as written, including a `**Label:**` form. A value
  with continuation lines or a nested list ends where the next item at the
  same indentation, or the end of the list, begins; replace all of it.
- To remove a field, remove its whole item and nothing else.
- To add a field, insert a new item after the last item of the entry's field
  list (its first top-level bullet list, as defined in
  [Field list](../../docs/INDEX_FORMAT.md#field-list)), after any
  continuation lines of that item. Use the same list marker (`-`, `*` or `+`)
  and indentation as the existing items, since a different marker starts a
  new list. Use the plain `Label: value` form. Add fields in the order of the
  tables in [Fields](../../docs/INDEX_FORMAT.md#fields).
- If an entry has no bullet list, insert the new items as a list directly
  after the heading, with a blank line before and after.
- A new entry goes at the end of its section: before the blank lines and any
  thematic break that precede the next `##` heading, or at the end of the
  file. Leave one blank line before its `###` heading.
- Leave everything else byte for byte: other entries, unknown fields, section
  notes, summaries, blank lines and line endings. If the file uses CRLF, write
  CRLF.

## Migration

Use this when the owner asks to migrate or import their current index into
format 1, as described in
[Migrating the current file](../../docs/INDEX_FORMAT.md#migrating-the-current-file).
It is always interactive, and every step is reviewed as a diff.

1. **Repository.** The owner creates the private index repository on their
   chosen host and gives you its URL, or names an existing clone. Do not
   create remote repositories. Ask whether to keep the current file's history
   (add the remote to the repository the file lives in and push it, if that
   repository holds nothing else) or to start a new repository with one
   import commit. Write `index.clone` and `index.remote` into the
   configuration if they are missing. While the remote is still empty,
   `$remote/$branch` does not exist: skip the parts of
   [Steps, step 1](#1-prepare-the-index-clone) that use it, and the first
   push in [Steps, step 8](#8-interactive-review-and-push) creates the
   branch.
2. **Import commit.** If starting new, copy the file unchanged to
   `index.file` and commit it as `Import the project index`, so that the
   migration diff shows only the migration.
3. **Migration edits**, in one commit, `Migrate the index to format 1`:
   - Add `Path` to every entry whose heading, with inline markup removed,
     names a directory under the survey root, projects and directories that
     are not projects alike, except directories that match an exclusion
     (apply both `survey.exclude` and `survey.excludeRemote` as in
     [Steps, step 3](#3-find-checkouts)). List the entries that name no
     directory, and those whose directory is excluded, and ask the owner
     about each.
   - Reduce each `Remote` to exactly `owner/name` or `none`. Move any
     commentary into `Note`, or into `Next` if it is about what to do, and
     show each move.
   - Split items that hold two fields into one item per field.
   - Where a label differs from a defined one but means the same thing,
     propose renaming it. Leave bold labels as they are unless the owner asks
     for the plain form.
   - Find unlabelled items whose first line would parse as a label (see
     [Field list](../../docs/INDEX_FORMAT.md#field-list)) and propose a
     rewording for each, such as replacing the colon with a full stop.
   - Remove the file-wide survey date and add `Surveyed: <that date>` to each
     entry the last survey covered. Ask the owner which ones; propose the
     entries that have laptop observations.
   - Add `- Format: 1` as the preamble's first bullet list only if the owner
     wants it. Propose updated wording for any preamble text describing the
     old rules; keep a legend as it is.
4. **Check** as in [Steps, step 7](#7-check) until no errors remain, and
   show the diff.
5. **Optionally survey**: run Steps, steps 3 to 7, as a third commit, so the
   owner can review migration and survey separately.
6. **Push** after the owner approves, as in
   [Steps, step 8](#8-interactive-review-and-push). Remind the owner that
   their local script needs the same `Path` change.

## Report

End every run with a short report to the owner (unattended runs: in the
session's output):

- Mode, survey root, index clone and branch, and the commit or PR that
  carries the change, or that nothing was pushed and why.
- Entries refreshed, entries added, proposals, conflicts, missing checkouts,
  excluded entries and remotes format 1 cannot record.
- How many directories were excluded or skipped, as counts only.
- Problems found in the file, with line numbers.
- Whether `seshat survey` and `seshat check` were used or the commands in this
  skill, and that the owner's review stands in for the format check until it
  exists.
