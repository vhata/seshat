# Project index format

Accepted by the owner on 2026-10-15 for the `define-index-format` queue entry,
with the [owner decisions](#owner-decisions) answered as recorded below and in
[DECISIONS.md](DECISIONS.md#2026-10-15--project-index-format).

This is the one definition of the project index file. Seshat's ingestion, the
Seshat CLI (`ship-projects-cli`) and the laptop agent (`write-survey-prompt`)
all read and check the file by these rules, and any tool that writes it
follows [Writing the file](#writing-the-file). Why the index is a Markdown
file, who writes which fields and how Seshat shows them are decided in
[specs/2026-10-12-projects-index.md](specs/2026-10-12-projects-index.md); this
document turns that decision into a format. It sits beside
[DELIVERABLE.md](DELIVERABLE.md) rather than under `specs/` because
implementations follow it for as long as format 1 lasts.

## Principles

- The format fixes only what software has to compute on: the structure, the
  entry key, the survey date and the format version. Every other value is
  Markdown text, kept and shown as written. Parsers cannot drift on value
  syntax that no parser reads.
- Absence means "not reported", never "none". A field that was surveyed and
  found nothing says so, for example `Unpushed: none`.
- The file holds owner judgment, join keys and laptop observations. Nothing
  GitHub supplies is stored in it.
- Readers are tolerant. Unknown fields, unknown sections and stray content are
  kept and reported, not dropped. Only a file whose meaning is ambiguous is
  rejected; see [Severity](#severity).
- Checking the file is a pure function of its bytes: no clock, network or disk.
  The same file always gives the same parse and the same problems, which is
  what lets Seshat rebuild its cache exactly. Checks against the disk belong to
  the CLI and are listed separately under
  [CLI disk check](#cli-disk-check).

## File

- One UTF-8 Markdown file. The default is `PROJECTS.md` at the root of the
  index repository; the path is configuration. A leading byte-order mark is
  ignored, and lines may end in LF or CRLF. In the parse, every line ending is
  LF.
- Markdown is CommonMark as GitHub renders it. Parsers read the block
  structure with a CommonMark parser rather than matching lines, so a `##`
  line inside a fenced code block is not a heading.
- Only top-level ATX headings (`#`, `##`, `###`) define structure. Top-level
  means a direct child of the document, so a heading inside a blockquote or a
  list item is content. A top-level setext heading (text underlined with `===`
  or `---`) is an error, because a stray `---` under a paragraph would
  otherwise create a section by accident.
- The text of a heading is its content with inline markup removed and runs of
  whitespace collapsed to one space, so `` ### `kiln` `` names the entry
  `kiln`.
- Top-level thematic breaks (such as `---` after a blank line) are dividers
  with no meaning. They are left out of the preamble, section notes
  and summaries.

## Structure

```text
preamble            everything before the first ## heading
## Section          a classification
section notes       anything between the ## heading and its first ### heading
### Entry           a project, or a directory that is not one
entry body          a field list and a summary
```

### Preamble

Everything before the first second-level heading. It may hold a first-level
title, prose, and a file field list: the preamble's first bullet list whose
first item is labelled, read like an entry's [field list](#field-list). Lists
whose first item has no label, such as a list of rules or a legend, are
ordinary preamble content. One file field is defined:

| Label | Value | Meaning |
| --- | --- | --- |
| `Format` | `1` | The format version. Absent means `1`. |

A reader that meets a version it does not support reports an error instead of
guessing. Everything else in the preamble, including any unlabelled items of
the file field list with their list markers, is kept as the preamble's
Markdown source and has no meaning to the format, so a legend describing the
sections can stay there as prose. There is no file-level survey date; the old file-wide line is
replaced by per-entry `Surveyed:` lines (see
[Migration](#migrating-the-current-file)).

### Sections

A second-level heading starts a section, and its text is the classification of
every entry under it. Any non-empty name is accepted and shown as written; the
set of classifications belongs to `design-project-classifications`, not to
this format. Names are compared exactly after the heading text rules above.

Two sections with the same name are one classification, and the check warns.
A section with no entries is allowed. Content between a section heading and its
first entry is section notes, kept and shown with the section; it holds no
fields.

A section for directories that are not projects, as the owner's current file
has, needs no special name. Its entries record a `Path` so that the
[CLI disk check](#cli-disk-check) does not report the directory as a checkout
with no entry.

### Entries

A third-level heading starts an entry, which runs to the next second- or
third-level heading or the end of the file. The heading text is the entry's
name, used for display and by the CLI. It is not the key, so it can be renamed
freely. A third-level heading before any section is an error, since the entry
would have no classification.

Headings of level four and below inside an entry are part of its summary. A
first-level heading after the preamble is kept as content of whatever contains
it, and the check warns.

## Entry body

### Field list

An entry's field list is its first top-level bullet list (`-`, `*` or `+`),
wherever it appears in the entry, where top-level again means a direct child
of the document. Fields should come directly after the heading. A labelled
item has the form

```markdown
- Label: value
```

- The rules below apply to the raw Markdown source of the item's first line,
  after the list marker. If that text starts with `**Label:**` or
  `**Label**:`, the two `**` are removed first, so `- **Stack:** TypeScript`
  is the `Stack` field, as hand-written lists often have it. Tools that write
  the file use the plain form.
- The label is that text up to its first colon. It must start with an ASCII
  letter and contain only ASCII letters, digits, spaces and hyphens, and the
  colon must be followed by a space or the end of the line. Otherwise the item
  has no label; the search does not move on to a later colon.
- Labels match case-insensitively, with runs of whitespace treated as one
  space. Files use the case shown in the tables below.
- The value is the Markdown source after the label and its colon: the rest of
  the item's first line, any continuation lines of the same paragraph, and any
  nested lists or paragraphs under the item, with the item's content indent
  removed from every line after the first. Leading and trailing whitespace is
  trimmed. A field with an empty value is ignored entirely: it is not in the parse and
  does not count as a repeat.
- An item in the field list that does not start with a label is part of the
  summary, as hand-written entries often put a one-line description among
  their fields. Because the label rule is strict, a description such as
  `A kiln scheduler. Rewritten 2026-09: ...` has no label, but one that opens
  with a short phrase and a colon does, and is reported as an unknown field.
- A defined field appears at most once per entry; a repeat is an error,
  because two readers could reasonably keep different copies.

### Summary

The summary is everything in the entry that is not a field: the unlabelled
items of the field list, and all other prose, lists, code blocks and
lower-level headings, kept as Markdown source in order. It is built from the
entry's source lines after its heading. The labelled items are removed;
each unlabelled item becomes a paragraph of its own, with its list marker and
content indent removed; the remaining parts are joined by one blank line; and
leading and trailing blank lines are removed. The summary is owner judgment.

## Fields

### Join keys

| Label | Value |
| --- | --- |
| `Remote` | The project's GitHub repository as `owner/name`, or `none` |
| `Path` | Where the checkout is, relative to the survey root |

`Remote` is `owner/name` as GitHub spells it, optionally in backticks. The
owner is 1 to 39 letters, digits and hyphens; the name is letters, digits,
`.`, `-` and `_`, and is not `.` or `..`. It is compared case-insensitively,
as GitHub compares it. `none`, in any case, records that the project has no
remote repository, which differs from an absent field: absent means nobody
recorded one. Any other value, including `owner/name` or `none` followed by
commentary, is an error; commentary belongs in `Next` or `Note`. Repositories
on other hosts are not defined in format 1.

`Path` is relative to the survey root, which each machine configures for the
CLI and the laptop agent. It uses forward slashes, optionally in backticks, and
has no leading `/` or `~`, no trailing `/`, and no `.` or `..` segments. It is
compared exactly. A relative path works on machines whose roots differ and
keeps home directory names out of the index and Seshat's storage.

The entry key is `Remote` when it is `owner/name`, lower-cased, and `Path`
otherwise. A `Remote` or `Path` with an `invalid-remote` or `invalid-path`
error does not count towards the key, and an invalid `Path` takes no part in
`duplicate-path`. An entry with neither, or with `Remote: none` and no `Path`,
is an error. Two entries may not name the same repository, and two entries may
not name the same path even when one is keyed by its remote, since one
checkout cannot belong to two entries. An entry may have both fields, or only
`Remote` when the project is not checked out on the surveyed machine. The entry
name never stands in for a missing `Path`, so an entry for a directory under
the survey root records its path even when the path is the same as the name.

Only `Remote` joins to GitHub. Seshat resolves it to GitHub's repository
ID and follows renames from there, as the
[decision](specs/2026-10-12-projects-index.md#joining-entries-to-repositories)
requires; a renamed repository keeps its evidence even before the owner updates
the field. Changing an entry's heading or moving it to another section never
changes its key.

After a rename, two entries can name the old and the new name of one
repository. The check cannot see this, since it does not ask GitHub. Seshat
finds it when it joins: it joins GitHub evidence to the entry that names the
repository's current name and shows the other from the file alone. If neither
names the current name, both are shown from the file alone. Either way it
warns about both on its index status, as it does for a repository it cannot
resolve.

### Owner judgment

| Label | Value |
| --- | --- |
| `Next` | What the owner means to do next |
| `Note` | Anything else the owner wants recorded |

Free text. The classification (the section) and the summary are owner
judgment too. The laptop agent may propose changes to these; the owner
decides.

### Laptop observations

| Label | Value, with the suggested form |
| --- | --- |
| `Stack` | Languages and tooling as built, from toolchain files and lockfiles |
| `Started` | Date of the first commit, `YYYY-MM-DD` |
| `Last commit` | Most recent commit on any local branch, `YYYY-MM-DD on <branch>` |
| `Checked out` | The branch checked out, or `detached` |
| `Branches` | Local branches other than the default, comma-separated or as a nested list |
| `Unpushed` | Commits not on their upstream, such as `3 on feature-x`, or `none` |
| `Uncommitted` | Changed and untracked files, such as `2 modified, 1 untracked`, or `none` |
| `Surveyed` | `YYYY-MM-DD`, the date of the survey that wrote these fields |

Apart from `Surveyed`, values are free text and the suggested forms are a
convention for the laptop agent, not something the check enforces. Seshat
shows each observation as written, with the entry's survey date and the label
"laptop survey", and never merges it into a GitHub value.

`Surveyed` must be a real calendar date in the form `YYYY-MM-DD`, optionally in
backticks; anything else is an error. It dates every laptop observation in the
entry, which is why a survey that refreshes an entry rewrites all of its
observations or removes the ones it no longer reports (see
[Writing the file](#writing-the-file)). An entry with observations and no
`Surveyed` gets a warning. Because the
[decision](specs/2026-10-12-projects-index.md#keeping-the-evidence-boundary)
never shows an observation without its date, Seshat does not show those
observations; it says the entry has laptop observations with no survey date,
and the CLI shows them. An entry with neither observations nor `Surveyed` has
no laptop survey, and Seshat says so.

Commit counts, if a later version adds them, count commits reachable from
named branches only
([decision](specs/2026-10-12-projects-index.md#survey-signals)).

### Unknown fields

A label not defined above is an unknown field. It is kept, in order, shown as
an unrecognised field of unknown source rather than as an owner note, and
reported as a warning. Writers preserve unknown fields exactly, so the owner's
own additions survive surveys and a newer tool's fields survive an older one.

## The format check

One check, shared by every reader, keeps their parsers from drifting. Seshat
runs it on ingestion, the CLI runs it as `check`, the laptop agent runs it
before it pushes, and the index repository's CI can run it through the CLI.
Until the CLI or the shared module exists, the laptop agent follows these rules
itself and the owner's review of its diff stands in for the check.

The check reads the file and produces the parse below and a list of problems.
Each problem has:

- `code`: a stable identifier from the tables below; tools match on it.
- `severity`: `error` or `warning`.
- `line`: the 1-based line where the offending construct starts.
- `entry`: the name of the entry it is in, if any.
- `message`: a human-readable explanation, free to change between versions.

A problem about a repeat (a duplicate field, key, section or name) is reported
once for each later occurrence, at that occurrence's line. Problems are sorted
by line, then by code.

For people the CLI prints one line per problem, in the form

```text
PROJECTS.md:14: error duplicate-path: "kiln" and "kiln-old" both have Path kiln
```

and for tools it prints the parse and problems as JSON. Its exit status is 0
when there are no errors, 1 when there are, and 2 when it could not run, for
example because the file is missing. With `--strict`, warnings also give 1.

### Severity

An error means the file is ambiguous: two careful readers could build
different indexes from it. Seshat keeps its last good parse, shows that the
index failed to parse with the commit and line, and shows the commit time of
the last good parse. The laptop agent does not push a file with errors.

A warning means the file has a clear meaning but something in it is probably
a mistake. Seshat accepts the parse and lists the warnings on its index
status, and the CLI reports them without failing unless `--strict` is given.

### Errors

| Code | Problem |
| --- | --- |
| `not-utf8` | The file is not valid UTF-8 |
| `unsupported-format` | `Format` is not a version the reader supports |
| `setext-heading` | A heading uses the setext form |
| `empty-heading` | A section or entry heading has no text |
| `entry-outside-section` | An entry comes before any section |
| `duplicate-field` | A defined field appears twice in one entry, or `Format` twice in the preamble |
| `invalid-remote` | `Remote` is not exactly `owner/name` or `none` |
| `invalid-path` | `Path` is absolute, starts with `~`, ends with `/`, uses backslashes or has `.` or `..` segments |
| `invalid-survey-date` | `Surveyed` is not a real date in the form `YYYY-MM-DD` |
| `missing-key` | An entry has no `owner/name` remote and no path |
| `duplicate-remote` | Two entries name the same repository, ignoring case |
| `duplicate-path` | Two entries name the same path |

### Warnings

| Code | Problem |
| --- | --- |
| `unknown-field` | A field label is not defined, in an entry or the preamble |
| `misplaced-field` | A defined field label appears as a list item outside a field list (in section notes or a later list in the entry), or as `**Label:**` or `**Label**:` inside another field's value |
| `missing-survey-date` | An entry has laptop observations and no `Surveyed` |
| `duplicate-section` | Two sections have the same name |
| `duplicate-name` | Two entries have the same name |
| `stray-title` | A first-level heading appears after the preamble |

The check does not judge free-text values, whether a section name is one of
the brief's classifications, or whether a repository exists. Seshat reports an
unresolvable repository when it joins, as the decision requires; that depends
on GitHub, so it is not part of this check.

### Parsed form

The parse is the same in every implementation. As JSON, for the start of the
[example](#example) with most fields left out:

```json
{
  "format": 1,
  "preamble": "# Projects",
  "fields": [{ "label": "Format", "kind": "file", "value": "1", "line": 3 }],
  "sections": [
    {
      "name": "Active",
      "line": 5,
      "notes": "",
      "entries": [
        {
          "name": "lighthouse",
          "line": 7,
          "key": "remote:example-owner/lighthouse",
          "fields": [
            { "label": "Remote", "kind": "key", "value": "example-owner/lighthouse", "line": 9 },
            { "label": "Surveyed", "kind": "survey-date", "value": "2026-10-14", "line": 17 }
          ],
          "summary": "A static site generator for project pages."
        }
      ]
    }
  ],
  "problems": []
}
```

- `kind` is `file`, `key`, `owner`, `laptop`, `survey-date` or `unknown`.
- `label` is the label as defined for defined fields and as written for
  unknown ones.
- `value` is the Markdown source as written, except that `Remote`, `Path` and
  `Surveyed` have backticks removed, and `Remote` is lower-cased in `key` but
  not in `value`.
- `key` is `remote:<owner/name>` or `path:<path>`, and is absent on an entry
  with a `missing-key` error.
- `preamble`, `notes` and `summary` are Markdown source with leading and
  trailing blank lines removed. `preamble` leaves out the file field list,
  joining what came before and after it as a summary does.
- Sections and entries are in file order. Two sections with the same name stay
  two sections in the parse; display may group them.

A parse with errors still carries everything that could be read, so the CLI
can show it; Seshat does not store it.

## CLI disk check

The CLI's `check` can also compare the file with the checkouts under the
survey root. This needs the disk, so it is not part of the shared check and
Seshat never runs it. Its problems use the same shape and are warnings:

| Code | Problem |
| --- | --- |
| `checkout-without-entry` | A directory directly under the survey root is neither an entry's `Path` nor a parent of one |
| `missing-checkout` | An entry's `Path` does not exist under the survey root |
| `remote-mismatch` | A checkout's origin remote does not match its entry's `Remote`, including a remote where the entry says `none` or no remote where it names one |

The decision's "duplicate entries" check is `duplicate-remote` and
`duplicate-path` in the shared check. Directories excluded by the owner's
survey settings, such as work checkouts, are not reported. Symbolic links
under the survey root are followed, so a `Path` may name a link to a checkout
kept elsewhere. Since one entry
names one checkout, a second checkout of the same repository is reported as
`checkout-without-entry` unless the survey settings exclude it.

## Writing the file

These rules bind any tool that writes the file: the laptop agent, any later
hosted refresh, and the CLI if it gains a command that writes.

- Change only what you own, and leave every other byte as it was: ordering,
  formatting, blank lines, unknown fields, section notes and summaries,
  including summary items inside the field list.
- The laptop agent writes laptop observations and `Surveyed`. It may add a
  missing `Remote` or `Path`, and only proposes changes to an existing
  one, which `remote-mismatch` can prompt. It only proposes changes to owner
  judgment, including the section an entry sits under, and never deletes an
  entry for a checkout it did not find without the owner's confirmation
  ([decision](specs/2026-10-12-projects-index.md#laptop-agent-workflow)).
- When it sets an entry's `Surveyed`, every defined laptop observation left in
  the entry must be as of that date. It rewrites the observations it reports
  and removes the ones it no longer reports, rather than leaving old values
  under a new date. Unknown fields are left alone.
- New fields are written in the plain label form, in the order of the tables
  above, after any existing fields, one field per item. New entries go at the
  end of their section.
- Run the check before committing, and do not push a file with errors.

## Example

A fictional index:

```markdown
# Projects

- Format: 1

## Active

### lighthouse

- Remote: example-owner/lighthouse
- Path: lighthouse
- Next: Publish the draft theme.
- Stack: TypeScript, Vite
- Last commit: 2026-10-13 on theme-draft
- Checked out: theme-draft
- Unpushed: 2 on theme-draft
- Uncommitted: none
- Surveyed: 2026-10-14

A static site generator for project pages.

## Stranded

### kiln

- Path: kiln
- Remote: none
- A firing scheduler for a pottery kiln controller.
- Branches: scheduler-rewrite
- Next: Decide whether the scheduler rewrite is worth finishing.
- Surveyed: 2026-09-30

## Not projects

### scratch

- Path: scratch
- Throwaway files, not a project.
```

`lighthouse` is keyed by its remote and joins to GitHub. `kiln` is local-only
and keyed by its path, and its unlabelled item is its summary. `scratch`
records only its path and a summary, so the disk check does not report the
directory; it has no `Remote`, so nobody has recorded whether it has a remote,
and no `Surveyed`, so Seshat says it has no laptop survey.

## Migrating the current file

The owner's current file already has this structure: sections by
classification, entries by checkout directory, bold `Label:` fields and
one-line descriptions among them, and mostly the labels used here. The
[follow-up step](specs/2026-10-12-projects-index.md#follow-up-work) of moving
it into the private index repository also brings it to format 1:

- Add `Path` to every entry for a directory under the survey root, projects
  and non-projects alike. The current file implies the path from the heading,
  which this format does not, so most entries gain a `Path` equal to their
  name.
- Reduce each `Remote` to exactly `owner/name` or `none`, dropping a trailing
  full stop and moving any commentary into `Next` or `Note`.
- Split items that hold two fields, such as `Started` and `Last commit` on one
  line, into one item each; `misplaced-field` finds them.
- Reword descriptions that open with a short phrase and a colon, which would
  otherwise be read as unknown fields.
- Replace the file-wide survey date with `Surveyed` on each entry the last
  survey covered.
- Add `- Format: 1` as the preamble's first bullet list, or leave it out,
  which means the same. The preamble's description of the current script's
  rules needs updating for `Path`; its legend can stay.

The laptop agent can do this in one session with the owner reviewing the diff,
running the check, once it exists, until it reports no errors. The owner's
local script needs the same `Path` change. Its rule that every section must
appear in the legend is the script's own and is not part of this format.

## Implementation

The parser and check should exist once, as a TypeScript module with no
dependency beyond a CommonMark parser, so that the Worker uses it on ingestion
and the CLI uses it if the CLI is built in TypeScript. Its tests are a set of
conformance fixtures, each an input file with its expected parse and problems,
which a second implementation in another language would have to pass too.
Whichever of `show-project-index` and `ship-projects-cli` starts first builds
the module and its fixtures.

## Owner decisions

The owner answered all four on 2026-10-15.

1. **Entry key.** An entry is keyed by `Remote` when it names a repository
   and by `Path` otherwise, and the heading is a display name only. Keying by
   heading, as the current file does, would drop the join whenever a heading
   is renamed and would tie display names to directory names.
2. **Paths.** `Path` is relative to a survey root each machine configures.
   Absolute or `~/` paths would differ between machines and put home
   directory layouts in the index and Seshat's storage. Seshat itself never
   knows the root. A checkout kept outside the root needs a symbolic link
   under it to have a path.
3. **Labels.** The proposed labels stand except where the current file
   already uses another: `Remote`, `Next` and `Note` replace the proposed
   `Repository`, `Next action` and `Notes`.
4. **What blocks ingestion.** Only the errors listed above stop Seshat
   accepting a new version of the file; everything else is a warning. Each
   error is a case where two readers could disagree about what the file says,
   and a stricter list would leave the dashboard on an old parse for problems
   that have an obvious reading.
