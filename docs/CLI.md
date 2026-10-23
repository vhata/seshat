# Seshat CLI

The CLI reads the project index and surveys local directories without a
hosted Seshat instance or a credential. `list`, `check` and `survey` read
only; `each` runs the command you give it. The CLI does not fetch, update
the index, push, call GitHub or write survey results into a checkout.

## Install from a checkout

Use Git, Bash and Node.js 24 or later. From a Seshat checkout:

```sh
bash scripts/setup.sh
./bin/seshat --help
```

Setup installs the locked npm dependencies with install scripts disabled,
generates the app's local types and installs this repository's hooks. It
does not deploy anything. The launcher runs TypeScript directly in Node;
there is no CLI build or published npm package. Keep the checkout and its
`node_modules` directory in place. To put it on your PATH, create a symlink
in a directory you already use for local commands, for example:

```sh
mkdir -p "$HOME/.local/bin"
ln -s "$PWD/bin/seshat" "$HOME/.local/bin/seshat"
```

The launcher resolves the symlink while preserving your working directory.
Alternatively, use `npm run --silent cli -- <command>` from the checkout.

## Settings

The CLI reads the laptop skill's existing
[survey settings](../skills/survey-projects/SKILL.md#configuration), with
Git's include support and shell `case` exclusion patterns. It uses:

- `survey.root`: the root directory for local `Path` values.
- `survey.exclude`: repeatable exclusions matched against relative paths
  and their ancestors; `*` also matches `/`.
- `survey.excludeRemote`: repeatable exclusions matched against every
  remote's fetch and push URLs, after Git's URL rewriting.
- `survey.githubHost`: repeatable host aliases whose origins can be
  represented as `owner/name` in format 1.
- `index.clone` and `index.file`: the index clone and relative filename.

The configuration file is `$SESHAT_SURVEY_CONFIG` when set; otherwise it is
`${XDG_CONFIG_HOME:-$HOME/.config}/seshat/survey.conf`. For example:

```ini
[survey]
root = ~/src
exclude = employer/*
excludeRemote = *company.example*
[index]
clone = ~/project-index
file = PROJECTS.md
```

`survey.root` and `index.clone` expand `~`. Relative values are relative to
the configuration file's directory; relative include paths follow Git's
rules. `index.file` defaults to `PROJECTS.md` and must be a relative path
inside the clone. Without `index.clone`, the default file is in your
current directory. CLI settings do not change Git configuration.

Every command accepts `--config FILE`, `--file FILE` and `--root DIRECTORY`.
These flags override the settings and resolve relative paths against your
current directory. A missing explicitly selected settings file is an
error. Without a settings file, flags can supply the needed values;
format-only checks and listing the index do not need a survey root.

The CLI has no publishing command, so `index.remote`, `index.branch`,
`index.reviewBranch`, `index.pullRequests`, `survey.machine` and
`survey.unattendedSection` remain settings for the agent skill. The index
repository's host is determined by its own Git remotes.

## List

```sh
seshat list Active Cooling
seshat list Active --paths
seshat list --json
```

Classifications are exact section names, including unknown sections and
names containing spaces (quote them). Omitting them selects all sections.
A name absent from the file is an error. Selection preserves file order;
repeated section names form one selection without duplicating entries.

The default table has tab-separated `CLASSIFICATION`, `PROJECT` and `PATH`
columns. `--paths` prints absolute local paths, one per line, and needs a
root; entries without a `Path` are omitted. It does not check whether a path
exists. Control characters are escaped in text output, so use `--json` for
paths containing tabs or newlines.

JSON is an array of the [parsed entries](INDEX_FORMAT.md#parsed-form), each
with `classification` and, when the entry has a `Path` and a root is known,
an absolute `path`. It retains the entry's fields, summary, key and line.
Listing describes the index, including entries excluded from disk surveys.

## Each

```sh
seshat each Active Cooling -- git status --short
seshat each Active -- sh -c 'printf "%s: %s\n" "$SESHAT_PROJECT" "$SESHAT_CLASSIFICATION"'
```

Commands run sequentially in file order. The CLI passes the executable and
arguments directly, without shell expansion; invoke `sh -c` explicitly when
you need a shell. It adds these environment variables:

| Variable | Value |
| --- | --- |
| `SESHAT_PROJECT` | Entry name |
| `SESHAT_CLASSIFICATION` | Section name |
| `SESHAT_PATH` | Entry's relative `Path` |

The command inherits standard input, output and error. Progress goes to
standard error, leaving command output on standard output. Entries without
a local `Path` are skipped with a message. Path and remote exclusions also
apply; excluded entries produce no name or command invocation. Both indexed
parents and nested entries are visited when selected. All selected local
paths are checked before the first command, and a missing path stops the
run. A failing command does not prevent later selected projects from
running, but makes the final status 1. An interrupt stops the run.

Repository-local Git environment overrides inherited from a calling hook
(such as `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and injected config
parameters) are removed for CLI Git reads and commands run by `each`, so
the selected checkout determines the repository. Global Git configuration
and other environment variables remain available.

## Check

```sh
seshat check
seshat check ./PROJECTS.md --json
seshat check --strict
seshat check ./PROJECTS.md --format-only
```

This runs the shared [format check](INDEX_FORMAT.md#the-format-check), then
the [disk check](INDEX_FORMAT.md#cli-disk-check). `--format-only` skips disk
access and needs no root. A positional filename and `--file` are
alternatives. Problems are sorted by line then code, and text output has
one problem per line:

```text
PROJECTS.md:14: error duplicate-path: Path kiln appears more than once.
```

`--json` prints the complete parse with its `problems`, including disk
problems. `checkout-without-entry` uses line 1; problems belonging to an
entry use that entry's heading line. Unknown or unrecorded remotes are
different from an explicit `Remote: none`: only a recorded `Remote` is
checked, and credentials and raw URLs never appear in diagnostics.

Directories and directory symlinks directly under the root are checked,
including non-project directories. Nested `Path` values are checked too;
their parent containers do not need separate entries. Excluded paths and
checkouts are omitted, including missing paths under an excluded ancestor.
A file in place of a checkout is reported as missing. A second checkout of
the same remote still needs its own `Path` coverage.

Status is 0 with no errors, 1 with any error, and 2 when the command could
not run (for example missing input or unreadable directories). `--strict`
also makes warnings return 1. Format errors block `list`, `each` and
`survey`, which return 2 and direct you to `check`.

## Survey

```sh
seshat survey
seshat survey --json
seshat survey --root ~/src --file ~/project-index/PROJECTS.md --json
```

Survey discovers directories by the skill's
[checkout discovery rules](../skills/survey-projects/SKILL.md#3-find-checkouts).
It reads the configured index for nested `Path` values; a root-only survey
also works when neither an index clone nor an explicit file is configured
and no `PROJECTS.md` exists in the current directory. An explicitly
configured missing index is an error. Ordinary directories have no Git
signals, and their contents are not inspected. Direct children that are
parents of nested entries are omitted from survey output by the skill's
container rule, even when the parent has its own entry. `check` and `each`
include explicitly indexed parents.

The default table has a fixed tab-separated header:

```text
PATH    REMOTE    CHECKED OUT    BRANCHES    UNPUSHED    UNCOMMITTED
```

It prints one row per non-excluded directory, ordered by relative path;
control characters are escaped. Warnings and an excluded-directory count
go to standard error. `not reported` means there is no observation; `none`
means Git was inspected and found nothing.

JSON is a versioned object, with `surveyed` as the laptop's local calendar
date. No absolute checkout paths, raw remote URLs, changed filenames or
file contents appear in it:

```json
{
  "version": 1,
  "surveyed": "2026-10-18",
  "projects": [
    {
      "path": "lighthouse",
      "checkout": true,
      "remote": "example/lighthouse",
      "remoteStatus": "supported",
      "signals": {
        "checkedOut": "main",
        "branches": "theme",
        "unpushed": "2 on theme (no upstream)",
        "uncommitted": "0 modified, 1 untracked"
      }
    }
  ],
  "excluded": 0
}
```

Each project has `path`, `checkout`, `remoteStatus`, `signals`, and optional
`remote` and `warnings`. `remoteStatus` is `none` when no remotes exist,
`supported` when origin reduces to `owner/name`, or `unsupported` otherwise
(including remotes with no origin). A local-only checkout has `remote:
"none"`; an unsupported remote has no `remote` field. Non-checkouts have
`checkout: false`, `remoteStatus: "none"` and empty `signals`.

The optional signal strings match the skill's
[observation conventions](../skills/survey-projects/SKILL.md#signals):

| Signal | Meaning |
| --- | --- |
| `stack` | Tools inferred from allowed manifest contents and top-level names |
| `started` | Earliest author date among root commits reachable from local named branches |
| `lastCommit` | Newest local branch tip's committer date and branch |
| `checkedOut` | Checked-out branch, or `detached` |
| `branches` | Local branches other than the resolved default, or `none` |
| `unpushed` | Commits per local branch absent from every remote-tracking branch, detached-only commits, `none` or `no remote` |
| `uncommitted` | Modified and untracked file counts, stash count and changed other-worktree count, or `none` |

Default resolution uses origin's symbolic HEAD, then `main` or `master`
when exactly one exists. Otherwise every local branch is listed and a
warning explains why. Unpushed branch annotations distinguish no upstream
from a gone upstream; a warning notes that the latter may have been
squash-merged and deleted. Counts reflect the last fetch already present
on disk. Commits under hidden refs never enter named-branch counts; only
the checked-out detached HEAD gets a separate count. Empty repositories
omit `started`, `lastCommit` and `unpushed`. Manifest reads skip symlinks
and secret-looking filenames, and return inferred tool names only.

The [survey-projects skill](../skills/survey-projects/README.md) consumes
these signals and proposes index updates through its own approval flow.
