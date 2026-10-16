# survey-projects

An agent skill that surveys the git checkouts on a laptop and updates the
owner's project index, the Markdown file defined in
[docs/INDEX_FORMAT.md](../../docs/INDEX_FORMAT.md). It is optional: Seshat's
dashboard works without it, but local-only evidence (unpushed commits,
uncommitted changes, local branches and repositories with no remote) reaches
the index only through a survey. Why it works the way it does is recorded in
the [project index decision](../../docs/specs/2026-10-12-projects-index.md#laptop-agent-workflow).

[SKILL.md](SKILL.md) holds the instructions the agent follows, including the
configuration keys. This file says how to install and run it.

## Install

The skill reads `docs/INDEX_FORMAT.md` from the Seshat checkout it lives in,
so install it by linking to a checkout rather than copying it.

For Claude Code, or another harness that loads
[Agent Skills](https://agentskills.io) from a directory:

```sh
mkdir -p ~/.claude/skills
ln -s /path/to/seshat/skills/survey-projects ~/.claude/skills/survey-projects
```

For a harness without skills, give the agent `SKILL.md` as its prompt, or
tell it to read and follow that file from the checkout.

## Configure

Clone the private index repository somewhere on the laptop, then write
`~/.config/seshat/survey.conf` (or set `SESHAT_SURVEY_CONFIG` to another
path). It uses git's config syntax:

```ini
[survey]
	root = ~/src
	exclude = .*
	exclude = work-*
	excludeRemote = *[:/]my-employer/*
[index]
	clone = ~/src/projects-index
```

Work checkouts must be excluded here, by directory pattern or by remote
URL pattern. A run records nothing about an excluded directory. To share
exclusions between machines, keep them in a file in the index repository and
add `[include] path = ~/src/projects-index/survey-exclude.conf`. Every key is
described under
[Configuration](SKILL.md#configuration).

If the index repository sits inside the survey root, as in the example,
exclude it or give it an entry under a section for directories that are not
projects.

## Run

Interactive, with the owner present: ask the agent to survey the projects
(in Claude Code, `/survey-projects`). It shows the diff and its proposals,
applies the proposals you accept, and pushes to the index's default branch
only after you approve the final diff.

Migration of an existing index file: ask the agent to migrate it, naming the
file. It commits the file unchanged, then the format 1 changes, and pushes
after you approve the diff.

Unattended, for example from cron or launchd: run the harness
non-interactively with a prompt that names the skill and says
`unattended`. With Claude Code, for example:

```sh
claude -p 'Run the survey-projects skill in unattended mode.'
```

The harness must be allowed to run git without prompting. An unattended run
never pushes the default branch. It pushes a review branch
(`index.reviewBranch`, default `seshat-survey`) for you to merge or delete,
or, with `index.pullRequests = gh`, opens or updates one draft PR. New
checkouts get entries in unattended runs only if
`survey.unattendedSection` names a section to put them in.

Until the Seshat CLI exists, the skill collects signals with the git commands
in SKILL.md and checks the file itself, and your review of the diff stands
in for the shared format check. Once `seshat survey` and `seshat check` are
installed, it uses those instead.
