# Optional LLM refresh of the project index

Written 2026-10-15 for the `evaluate-optional-llm-refresh` queue entry. Its
recommendation is recorded in
[DECISIONS.md](../DECISIONS.md#2026-10-15--hosted-llm-refresh-waits). It works
within the [project index decision](2026-10-12-projects-index.md), the
[GitHub integration](2026-10-12-github-integration.md), the
[Cloudflare stack](2026-10-13-cloudflare-stack.md) and
[change detection](2026-10-14-change-detection.md). Facts about GitHub,
Cloudflare, Anthropic and OpenAI were checked against their documentation on
2026-10-15 and each links to its source. Nothing here was measured; every cost
figure is an estimate from stated assumptions.

## Recommendation

**Do not build hosted LLM refresh now.** Record the design it would follow, so
that adopting it later is a build decision rather than a new evaluation, and
revisit it when the conditions under
[What would make it worthwhile](#what-would-make-it-worthwhile) hold.

- Refresh can only propose changes to owner judgment: summaries, next actions,
  classifications and entries for repositories that have none. GitHub
  evidence is already shown live beside the index and never written to it, so
  refresh adds nothing to the facts the dashboard shows.
- The laptop agent (`write-survey-prompt`) already proposes the same owner
  field changes, with the owner present, using the owner's own credentials and
  whatever LLM tooling they already pay for. It sees local signals that a
  hosted refresh never can, and through the CLI's optional GitHub signals it
  can see most of what a hosted bundle would.
- Hosted refresh needs Contents write and Pull requests write on the index
  repository. Under the single GitHub App chosen for the instance, that write
  access would reach the code of every repository the owner owns; confining
  it takes a second App. Its default bundle needs no new read permission
  beyond reading the index, but the richer bundle (commits, branches, READMEs,
  queue files) needs Contents read across every repository in the
  installation. It also puts a provider key in Cloudflare and sends private
  repository content to the provider.
- Nothing reads the index yet. `show-project-index` waits for the PR overview,
  and until the owner uses it there is no evidence that owner fields go stale
  between laptop surveys, which is the only problem refresh solves.

Seshat therefore keeps writing nothing to the index, as the
[index decision](../DECISIONS.md#2026-10-12--project-index-source-of-truth)
required until this entry was decided. The basic dashboard is unaffected
either way: refresh is optional, owner-funded and never required, as the
[brief](../BRIEF.md#intended-outcome) says.

## What refresh would be

A run that Seshat starts at the owner's request or on a schedule. It gathers
the index entries for monitored repositories and a bundle of GitHub context,
sends them with a prompt to an LLM provider using the owner's key, receives
proposed changes to owner fields, applies them to the index file and opens or
updates a single PR on the index repository for the owner to merge or close.

## Is it useful?

### What it would add

The index holds owner judgment, join keys and laptop observations, and Seshat
shows GitHub evidence beside it without storing it in the file
([field ownership](2026-10-12-projects-index.md#field-ownership-and-provenance)).
Refresh may not change laptop observations, which it cannot verify, or join
keys ([hosted writes](2026-10-12-projects-index.md#hosted-writes-and-self-pr-behaviour)).
What is left for it is prose and judgment:

- a summary rewritten after a README or the project's direction changed;
- a next action updated after the work it named was merged;
- a proposal to move an entry to another section, such as Active to Cooling;
- a new entry for a monitored repository with no index entry.

These are useful only if they go stale faster than the owner or the laptop
agent updates them. Deterministic suggestions, such as a classification
computed from activity dates, belong to `design-project-classifications` and
need no LLM.

### Against the laptop agent

| | Laptop agent with the CLI | Hosted refresh |
| --- | --- | --- |
| Local-only signals (unpushed, uncommitted, local-only repositories) | Yes | No |
| GitHub signals (commits, branches, PRs, CI, READMEs) | Optionally, through the owner's own GitHub CLI login ([Seshat CLI](2026-10-12-projects-index.md#seshat-cli)) | Yes |
| Runs while the laptop is off | No | Yes |
| Owner present | Usually; unattended runs open a draft PR | No; the PR is the review |
| PR author | The owner, so unattended PRs are drafts | The App's bot, so the PR lands in Awaiting your review when the index repository is monitored |
| New GitHub permissions for Seshat | None | Contents and Pull requests write on the index repository; Contents read across the installation for the richer bundle |
| Where the LLM credential lives | The owner's existing tool | A Worker secret on the instance |
| Who pays | The owner, through their existing tool | The owner, per call, through their own provider account |

Hosted refresh wins on running without the laptop and on authoring as someone
other than the owner. The laptop agent wins on local evidence, on presence,
and on needing nothing new from Seshat. The owner's current index is
maintained by exactly this kind of laptop agent
([the index today](2026-10-12-projects-index.md#the-index-today)), so the
laptop path is the one already in use.

### What it would cost

- **Contents read across the installation, for the richer bundle.** Commits,
  branches, READMEs and other files all need Contents read
  ([permissions required][perms-required]). A GitHub App's permissions apply
  to every repository in an installation, and the owner's installation covers
  all repositories, so Seshat could read all of the owner's code, monitored or
  not. `show-project-index` may add this anyway for branch and commit
  evidence; if it does, refresh adds nothing here.
- **Write access.** Creating a branch, blob, tree, commit or file needs
  Contents write, and opening or editing a PR needs Pull requests write
  ([permissions required][perms-required]). On the instance's one App, both
  would cover every repository in the installation. A leaked private key
  would then allow pushing to any of them, where today it allows only reading
  PRs and CI. Only a second App installed on the index repository alone keeps
  write access off the rest.
- **A second automated writer of the index.** Unattended laptop runs already
  open draft PRs on the same file. Two PR sources editing one file can
  conflict at merge, and the owner reviews both.
- **A provider key on the instance** and private content leaving it, both
  covered under [Design if adopted](#design-if-adopted).
- **Build and setup.** Bundle gathering, a provider client, consent and cost
  settings, PR writing through the index format's writing rules, and a second
  App registration for the owner.

### Conclusion

The value depends on evidence nobody has yet, because nothing shows the
index, and the cost includes the widest permission change Seshat would make.
The laptop agent covers the same ground for a single-machine owner with no
new permissions. That points to not now.

## What would make it worthwhile

Revisit when all of these hold:

1. `show-project-index` is built and the owner uses it.
2. `write-survey-prompt` is in use, and the owner finds that owner fields
   still go stale between laptop surveys: for example, work done from other
   machines or on GitHub alone that no survey sees, or surveys that run too
   rarely to keep up.
3. The Contents read question is settled by `show-project-index`. If it has
   added Contents read across monitored repositories, the richer bundle costs
   no new read permission.
4. The owner is willing to register a second GitHub App for writes to the
   index repository, or accepts the draft-PR fallback described under
   [GitHub permissions](#github-permissions).

If the owner wants refresh sooner, the design below can be built as it
stands; the [questions](#owner-decisions) say which choices change.

## Design if adopted

### Trigger and flow

1. A run starts when the owner asks for one on the settings page, or when a
   scheduled run is due and an overview is visible. A due run waits for a
   visible overview rather than waking the instance on a timer, which keeps
   the [change detection](../DECISIONS.md#2026-10-15--change-detection) rule
   that nothing runs on a timer while no page is visible. The schedule is off
   by default and at most weekly.
2. Nothing else starts a run: not a push to the index repository, not a
   merged refresh PR, not any webhook. Merging a refresh PR therefore never
   triggers the next refresh, which settles the self-PR behaviour the
   [brief](../BRIEF.md#open-design-questions) asks to be decided and avoids
   the loop the [index decision](2026-10-12-projects-index.md#hosted-writes-and-self-pr-behaviour)
   rules out.
3. Seshat checks its preconditions: a provider key is set, the owner's consent
   covers the current bundle definition, the index repository is private, the
   last good parse of the index has no errors, and the run and token caps
   allow another run. If any fails, the run does not start and the settings
   page says why.
4. Seshat gathers the bundle, sends one request to the provider and receives
   structured proposals.
5. Seshat validates each proposal, applies the valid ones to the index file
   with the shared parser and writer, runs the shared format check, and opens
   or updates the refresh PR.

### Context bundle

The bundle is gathered by Seshat, not by the model. The model gets no tools
and makes no requests of its own.

**Always sent.** Beyond reading the index repository itself, which
`show-project-index` adds or the index App below holds, this needs only the
Metadata, Pull requests, Checks and Commit statuses read the instance already
has:

- the prompt (below);
- the index entries for monitored repositories, keyed by `Remote`, with
  their section, owner fields and survey date;
- for each monitored repository: name, description, topics, visibility,
  archived and fork flags, primary language and last push date;
- open PRs and PRs merged since the last run: title, state, draft flag, CI
  result and whether the owner opened them. Titles of PRs opened by other
  accounts are left out and counted instead, since anyone can open a PR on a
  public repository and its title is text Seshat would be handing to a model.

**Sent only with Contents read on the main App and the owner's consent for
it**, and only for repositories with commits since the last run, each item
capped in size:

- default-branch commit subjects since the last run, counted on named
  branches only, as the [survey signals](2026-10-12-projects-index.md#survey-signals)
  require;
- branches other than the default, with ahead and behind counts;
- the start of the README;
- named queue files such as `TODO.md`, if present.

**Never sent:** entries with `Remote: none` or no `Remote`, entries for
repositories that are not monitored, laptop observations, source code, diffs,
issue or PR bodies, comments, and anything from a repository the owner has
excluded from refresh. Entries the model never sees cannot be changed, which
also enforces the rule that refresh never touches local-only entries.

**The prompt** has a generic default in this repository. The owner can
override it with a file in the index repository, read with the same access as
the index, so a private prompt stays private and versioned with the index.

**Proposals** come back in a fixed structure: entry key, field or section,
proposed value and a one-line reason. Seshat discards any proposal that names
an entry it did not send, changes a join key, a laptop observation or
`Surveyed`, or deletes an entry. A proposed new entry must be for a monitored
repository with no entry, keyed by `Remote` with only owner fields filled in,
and goes at the end of its section. Seshat applies the rest by the
[writing rules](../INDEX_FORMAT.md#writing-the-file), leaving every other
byte as it was, and does not open or update the PR if the result has format
errors. Text in the bundle can try to steer the model; because Seshat only
applies proposals of this shape to owner fields, and the owner reviews the
PR, steered output can at worst propose bad prose for the owner to reject.

### GitHub permissions

**Main App, for the richer bundle: Contents read.** Consequences, all from
GitHub's documentation:

- The permission is set on the App registration. Every installation is asked
  to approve it and keeps its old permissions until it does
  ([approving updated permissions][app-approve]), so refresh must detect a
  missing grant and fall back to the smaller bundle.
- Once approved, it covers every repository in the installation, monitored or
  not. Seshat can narrow each installation token to chosen repositories and
  permissions ([installation tokens][app-install-token]), which limits
  Seshat's own use but not what a leaked private key could reach
  ([minimum permissions](2026-10-12-github-integration.md#minimum-permissions)).
- It makes the `push` event available ([webhook events][wh-events]), which
  change detection does not need but could use.

**Writing: a second App, the index App.** Registered by the owner through the
same manifest flow, installed on the personal account with only the index
repository selected ([installing your own App][app-installing]), with Metadata
read, Contents read and write and Pull requests read and write, and no
webhook events. Its private key is a second set of Worker secrets. Requests
made with its installation token are attributed to the App
([installation tokens][app-install-token]), so the refresh PR's author is the
App's bot. The index App could also be how Seshat reads the index, which is
`show-project-index`'s call.

**Where the owner sees the PR.** When the index repository is monitored,
which is the default for a non-fork repository the personal account owns
([index repository](2026-10-12-projects-index.md#index-repository)), the
refresh PR is someone else's PR in the overview and lands in Awaiting your
review, as the [index decision](2026-10-12-projects-index.md#github-access-needs)
intends. The owner may turn monitoring off for it, and the
[deliverable](../DELIVERABLE.md#monitored-repositories) says that removes its
PRs from the overview; refresh does not override that choice. Instead the
open refresh PR is always shown, with a link, where `show-project-index`
shows the index and on the refresh settings page, since those are where the
owner reads index content and refresh needs `show-project-index` to exist.

Putting Contents write and Pull requests write on the main App instead would
grant both on every repository the owner owns, and is rejected. If the owner
declines a second App, the remaining option within the decided constraints is
a PR authored as the owner, which needs a stored owner token that the
[GitHub integration](../DECISIONS.md#2026-10-12--github-integration) does not
keep, and which would then open as a draft. That is a worse trade than the
second App.

**The refresh branch and PR.** Seshat keeps one branch, such as
`seshat/refresh`, and at most one open PR from it. Each run rebuilds the
branch from the current head of the default branch and updates that PR's
title and body, or opens one if none is open. It never writes to the default
branch or any other branch. If anyone else has pushed to the refresh branch,
Seshat leaves it alone and says so, so the owner's edits to a refresh PR are
never overwritten. The PR body lists what was sent (repositories, items and
sizes), the token usage the provider reported and the proposals Seshat
discarded.

### Provider keys

- **Who supplies them.** The owner, from their own Anthropic or OpenAI
  account, as the [brief](../BRIEF.md#open-design-questions) names. Seshat
  ships no key and calls no provider until one is set. Without a key the
  refresh settings are hidden and nothing else changes.
- **Where they are stored.** A Worker secret set by the owner with
  `wrangler secret put`, beside the provider name and model as plain
  variables, as the [stack decision](../DECISIONS.md#2026-10-13--cloudflare-stack)
  chose for every credential. Secrets cannot be read back after they are set,
  and setting one deploys a new version, which disconnects open pages
  ([Workers secrets][cf-secrets];
  [constraints](2026-10-13-cloudflare-stack.md#constraints-for-implementation)).
  The key is never written to Durable Object storage, never shown in the page
  and never sent anywhere but the provider's API.
- **A dedicated key with a spend limit.** The owner should create the key in a
  dedicated Anthropic workspace, which can have a monthly spend limit (the
  Default Workspace cannot) ([workspaces][anthropic-workspaces]), or a
  dedicated OpenAI project with a hard spend limit, which returns an error once
  reached but is "not instantaneous" ([spend limits][openai-spend]). That
  limit is the backstop; Seshat's own caps below come first.
- **Model.** Configured by the owner. Seshat does not hard-code a model or a
  price, since both change.

### Consent and approval

- **Turning refresh on is an explicit act.** The settings page shows the
  provider, which bundle parts will be sent, how many monitored repositories
  are private, and a preview of the actual bundle for the next run. The owner
  confirms, and Seshat records the consent with a version of the bundle
  definition.
- **What the provider receives** is private: index entries with owner notes
  and next actions, private repository names, and, with the richer bundle,
  commit subjects, READMEs and queue files from private repositories. The
  consent screen says how each provider handles it. Anthropic deletes API
  inputs and outputs within 30 days, with exceptions including usage policy
  enforcement, where flagged content can be kept for up to 2 years
  ([Anthropic retention][anthropic-retention]). OpenAI does not train on API
  data unless the customer opts in, and keeps abuse monitoring logs for up to
  30 days; some endpoints also keep application state, 30 days by default for
  the Responses API ([OpenAI data controls][openai-data]). Seshat should
  request no stored state where a provider offers that choice.
- **Re-consent.** Any widening of what is sent (a new bundle part, the richer
  bundle, a different provider) asks again. Repositories that become
  monitored later are included under the existing consent, and the consent
  screen says so; per-repository exclusions are kept.
- **Public index repository.** Refresh does not run while the index
  repository is public, since the PR would publish summaries drawn from
  private repositories.
- **Approval of content** is the PR itself. Nothing reaches the index until
  the owner merges it, and closing it discards the run.

### Cost bounds

Seshat enforces these before each request, as settings with these defaults:

| Bound | Default |
| --- | --- |
| Input per run | 150,000 tokens, estimated from the bundle's size before sending; lower-priority items are dropped to fit, starting with the richer bundle's oldest repositories |
| Output per run | 16,000 tokens, sent as the request's maximum |
| Scheduled runs | Off; at most one a week when on |
| All runs | At most 3 a day, so a stuck button or a retry loop cannot spend more |
| Retries | One, after a timeout or server error only; none after any other error |

Each run's reported token usage is kept in a bounded log and shown on the
settings page with the PR it produced.

**Estimated cost.** Assumptions, not measurements: the owner's 48 monitored
repositories ([measured](2026-10-14-change-detection.md#measurements)) at a
few hundred tokens each for the entry and repository facts, for roughly
20,000 input tokens with the default bundle. The richer bundle adds about ten
repositories active since the last run at a few thousand tokens each, for
roughly 55,000. Either way, about 4,000 output tokens of proposals.
Newer Claude models' tokenizer produces about 30% more tokens for the same
text ([Anthropic pricing][anthropic-pricing]), which these rough figures do not
try to separate.

| Price tier, per million tokens in and out | Examples | Default bundle | Richer bundle | Run at the caps |
| --- | --- | --- | --- | --- |
| $0.10 and $0.50 | Claude Haiku 5.5 up to 100,000-token prompts; gpt-6-luna | under 1 cent | under 1 cent | about 2 cents for gpt-6-luna; about 12 cents for Haiku 5.5, which charges $0.50 and $2.50 above 100,000 tokens |
| $2 and $10 | Claude Sonnet 5.5; gpt-6.1-sol | about 8 cents | about 15 cents | about 46 cents |
| $10 and $50 | Claude Fable 5.1; gpt-6-astra | about 40 cents | about 75 cents | about $2.30 |

Prices are from [Anthropic pricing][anthropic-pricing] and
[OpenAI pricing][openai-pricing], read 2026-10-15. A weekly mid-tier run
would come to under a dollar a month on these assumptions, and the caps
bound a month of the maximum 3 runs a day at the mid tier to about $40.

### Cloudflare fit

- Runs in the Durable Object, like other GitHub work. Waiting on the provider
  is I/O, which does not count as CPU time, and a request has no wall-time
  limit while its caller stays connected; an alarm handler has 15 minutes
  ([Durable Objects limits][do-limits]). A run therefore needs a provider
  timeout well under 15 minutes.
- Gathering takes a few GraphQL queries, the provider call one subrequest and
  writing a handful of REST calls, within the 50 external subrequests per
  invocation the stack measured.
- Storage is a consent record, settings and a bounded run log. No other
  Cloudflare product is needed.

### Constraints carried from the index decision

| Constraint | How the design meets it |
| --- | --- |
| Changes only through PRs, never direct commits | The index App writes only its refresh branch; nothing writes the default branch |
| At most one open refresh PR; a new refresh updates it | One branch, one PR, rebuilt each run |
| Never triggered by a push to the index repository | Only the owner's request or a due schedule starts a run; no webhook does |
| Authored by a non-owner identity, otherwise a draft | The index App's bot authors it, so it lands in Awaiting your review when the index repository is monitored and is shown beside the index either way; the owner-authored fallback would open as a draft |
| Proposes owner fields, never laptop observations | Proposals for anything but owner fields and sections are discarded |
| New entries only for monitored repositories without one; never changes a join key; never touches local-only entries | Validated per proposal; local-only entries are never sent |
| Decide what is sent and get consent | [Context bundle](#context-bundle) and [consent](#consent-and-approval) |

## Rejected alternatives

- **Adopting now on the instance's one App.** Contents and Pull requests
  write on every repository the owner owns, for a benefit not yet shown.
- **Letting the model rewrite the whole file.** It would see local-only
  entries and laptop observations and could change bytes it does not own;
  structured proposals applied by Seshat cannot.
- **Running refresh on a bare timer.** It would wake the instance while
  nobody is looking, which change detection deliberately stopped doing; a due
  run waits for a visible overview instead.
- **A fine-grained personal access token for the index repository.** It
  authors as the owner, so PRs would be drafts, and it needs manual rotation
  ([GitHub integration](2026-10-12-github-integration.md#c-fine-grained-personal-access-token)).
- **Keeping the key in Durable Object storage, entered on the settings
  page.** Easier to set, but it puts a credential in instance storage, which
  the GitHub and stack decisions avoided for the App's own key.
- **Workers AI's free allocation.** It needs no owner key, and Free includes
  10,000 Neurons a day with operations failing past that
  ([Workers AI pricing][cf-workers-ai]). It serves open-weight models rather
  than the Anthropic and OpenAI APIs the brief names, would be one more
  Cloudflare product beside the single Worker and Durable Object the stack
  decision chose, and shares the account's quotas with the owner's other
  Workers. It is worth a look when refresh is revisited if a free option
  matters more than model choice.

## Owner decisions

1. **Build hosted refresh now?** Recommended: no; revisit under
   [What would make it worthwhile](#what-would-make-it-worthwhile). Choosing
   yes means building the design above after `show-project-index`, which it
   needs to read and write the index.
2. **Writes through a second App?** When refresh is built, a separate index
   App installed only on the index repository holds Contents and Pull
   requests write. Recommended: yes. The alternative within the decided
   constraints is an owner-authored draft PR and a stored owner token.
3. **What is sent by default?** The smaller bundle, needing no read
   permission beyond the index repository, with the richer one only where Contents read exists and the
   owner consents to it. Recommended: yes.
4. **Keys and costs.** An owner-supplied Anthropic or OpenAI key as a Worker
   secret, the caps above as defaults, and the schedule off by default.
   Recommended: yes.

## Follow-up work

`build-hosted-refresh` in [TODO.md](../../TODO.md) waits for
`show-project-index` and `write-survey-prompt` and for the owner's judgment
that a gap remains, and builds to this design.

## Sources

Read 2026-10-15:

- [Permissions required for GitHub Apps][perms-required]
- [Approving updated permissions for a GitHub App][app-approve]
- [Authenticating as a GitHub App installation][app-install-token]
- [Installing your own GitHub App][app-installing]
- [Webhook events and payloads][wh-events]
- [Cloudflare Workers secrets][cf-secrets]
- [Cloudflare Durable Objects limits][do-limits]
- [Cloudflare Workers AI pricing][cf-workers-ai]
- [Anthropic pricing][anthropic-pricing]
- [Anthropic workspaces][anthropic-workspaces]
- [Anthropic: how long do you store my organization's data?][anthropic-retention]
- [OpenAI pricing][openai-pricing]
- [OpenAI spend limits][openai-spend]
- [OpenAI data controls][openai-data]

[perms-required]: https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps
[app-approve]: https://docs.github.com/en/apps/using-github-apps/approving-updated-permissions-for-a-github-app
[app-install-token]: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation
[app-installing]: https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app
[wh-events]: https://docs.github.com/en/webhooks/webhook-events-and-payloads
[cf-secrets]: https://developers.cloudflare.com/workers/configuration/secrets/
[do-limits]: https://developers.cloudflare.com/durable-objects/platform/limits/
[cf-workers-ai]: https://developers.cloudflare.com/workers-ai/platform/pricing/
[anthropic-pricing]: https://platform.claude.com/docs/en/about-claude/pricing
[anthropic-workspaces]: https://platform.claude.com/docs/en/manage-claude/workspaces
[anthropic-retention]: https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data
[openai-pricing]: https://developers.openai.com/api/docs/pricing
[openai-spend]: https://developers.openai.com/api/docs/guides/spend-limits
[openai-data]: https://developers.openai.com/api/docs/guides/your-data
