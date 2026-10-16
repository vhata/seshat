# Public view

Status: **proposed on 2026-10-15** for the `define-public-view` queue entry.
The decision entry in
[DECISIONS.md](../DECISIONS.md#2026-10-15--public-view) records it as it
takes effect when accepted; the owner may accept it or amend it, and the
choices most worth a look are under [Questions for the
owner](#questions-for-the-owner). Facts about GitHub and Cloudflare were
checked against their documentation on 2026-10-15 and 2026-10-16; each
claim links to its source, and points the documentation does not settle
are under [Not verified](#not-verified).

The [brief](../BRIEF.md#open-design-questions) asks for public-view consent
and filtering and says that private repository names, PRs, summaries and
local context must not become public by accident. It treats a public view as
optional and later. This document decides whether to offer one, what it may
show, how it is served and withdrawn, and what current work must do so it
stays possible.

## Recommendation

- **Offer a public view, later and opt-in.** It is not part of the first
  deliverable. It is built after the PR overview (`build-public-view`), and
  publishing project index entries waits for `show-project-index`
  (`publish-index-entries`). Until then, current work only has to respect the
  [constraints](#constraints-for-current-work) below.
- **Nothing is public by default.** The public view is off until the owner
  turns it on, and turning it on publishes nothing until the owner publishes a
  repository. Consent is given per repository, by the signed-in owner, and
  only for a repository GitHub reports as public. Repositories that become
  public later are not published without the owner's action.
- **Public only while recently confirmed public.** A published repository is
  withheld from the page unless a GitHub read confirmed it public within the
  last 24 hours. A lost `privatized` delivery therefore leaves earlier PRs on
  the page for at most a day, with no timer and no reads started by visitors.
- **A fixed list of fields, not per-field settings.** For a published
  repository the view shows its open PRs with the facts GitHub already shows
  anyone on that PR's page: repository, number and link, title, author, draft
  state, when it was opened and last active, and the combined CI result. No
  buckets, review state, reviewers, branch names, check details, settings or
  sync errors. Private and internal repositories never appear, not even as a
  count.
- **Index entries need their own consent, bound to the text.** When index
  publication exists, an entry joined to a published repository may show its
  name, classification and summary once the owner publishes it. A later change
  to any of those withholds the entry until the owner confirms the new text.
  `Next`, `Note`, `Path`, laptop observations and local-only entries are never
  public.
- **Served by the same Worker, with no visitor sign-in, as a snapshot.** A
  public route returns a filtered projection of the model, built by one
  allowlist function in the Durable Object. It opens no socket, never makes
  the object sweep and writes nothing to storage. The page says that each
  repository's visibility was confirmed with GitHub within the last day and
  that changes GitHub notified since are included, but not when the owner
  last had Seshat open. Where the owner has a domain on Cloudflare, it
  is served from that rather than `workers.dev`, which would disclose the
  account's subdomain.
- **Withdrawal takes effect on the next request.** Unpublishing a repository,
  turning the view off, rotating its link or the repository leaving public
  visibility removes the data from the next response. Responses are not put in
  any Cloudflare cache, so there is nothing at the edge to purge, and a
  visitor's own browser may keep a copy for at most a minute. Copies other
  people already made cannot be recalled, and the settings say so before
  anything is published.

## What the brief and earlier decisions require

- **The brief.** Only the configured owner signs in; a public view may follow;
  private repository names, PRs, summaries and local context must not become
  public by accident ([brief](../BRIEF.md#intended-outcome)).
- **The GitHub integration.** Data is read with installation tokens, so a
  public page needs no GitHub sign-in, and for the same reason GitHub's
  permissions do no filtering for it: the installation reads every private
  repository ([spec](2026-10-12-github-integration.md#public-view)). The owner
  gate stays as it is.
- **The project index.** Nothing from the index appears in a public view
  without explicit per-project consent, and owner notes, next actions,
  local-only repository names and laptop observations stay out even then
  unless consent names them ([spec](2026-10-12-projects-index.md#privacy-and-the-public-view)).
- **The stack.** One Worker and one Durable Object per instance on Workers
  Free, no other storage product, and quotas shared with every other Worker on
  the owner's Cloudflare account ([decision](../DECISIONS.md#2026-10-13--cloudflare-stack)).
- **Change detection.** The object sweeps only while something reads the data,
  and a public view would need a rule of its own for whether it counts as a
  reader ([spec](2026-10-14-change-detection.md#when-the-object-sweeps)).
- **The evidence boundary.** The overview shows only what GitHub reports and
  must not suggest local evidence was inspected
  ([deliverable](../DELIVERABLE.md#evidence-boundary)). A public page is held
  to the same rule.

A repository being public on GitHub is necessary for its data to be
published, not sufficient. Public repositories are "accessible to everyone on
the internet" ([about repositories][gh-about-repos]), but a page that gathers
all of the owner's open work in one place is a disclosure GitHub does not make
for them, and parts of Seshat's model (buckets, the trusted-reviewer
judgment, which repositories are monitored) are Seshat's own inferences, not
public records.

## Consent

### Who consents and where it is kept

Only the signed-in owner gives or withdraws consent, on a settings screen
behind the owner gate. Consent records are instance settings, kept in the
Durable Object beside the monitoring overrides, keyed by repository ID so a
rename keeps them.

The [index decision](../DECISIONS.md#2026-10-12--project-index-source-of-truth)
keeps Cloudflare storage to a cache rebuildable from GitHub and the index file.
Consent records are not index data and cannot be rebuilt, like the monitoring
overrides. If they are lost the instance fails closed: nothing is published
until the owner publishes again.

Consent is not recorded in the index file. The laptop agent writes that file
and a hosted refresh may one day propose changes to it, so a field there could
publish an entry without the owner deciding to.

### Granularity

Three levels, each off by default:

1. **The public view itself.** Off, the public route answers 404, the same as
   a path that never existed.
2. **Per repository.** A repository is published only while all of these
   hold: the owner published it, Seshat monitors it, and GitHub reports its
   visibility as public. Publishing is offered only for monitored public
   repositories.
3. **Per index entry**, once `publish-index-entries` exists. See [Index
   entries](#index-entries).

Field-level consent is not offered. The [field list](#what-a-published-repository-shows)
is fixed in code and short enough that one decision per repository covers it;
adding a field later is a code change with its own review.

### Visibility changes

Seshat already learns about visibility changes: the `repository` event
reports `privatized`, `publicized`, `transferred` and `deleted`, and every
webhook payload about activity in a repository carries the `repository`
object ([webhook events][gh-wh-events]). REST repository objects carry
`private` and `visibility` ([repositories API][gh-rest-repos]), and in GraphQL
`Repository.visibility` is one of `PUBLIC`, `PRIVATE` or `INTERNAL`, internal
meaning "visible only to users in the same enterprise"
([GraphQL schema][gh-gql-schema]).

- Only `public` counts as public. Internal repositories are treated as
  private.
- Every GitHub read that stores PR data also reads the repository's
  visibility and stores the two together, with the time of the read, so data
  that arrives after a repository went private arrives already marked
  private. The re-read and sweep queries in the [change detection
  design](2026-10-14-change-detection.md#re-reads) can select the field at
  no extra request, and the sweep's repository listing reports it for every
  repository.
- A delivery whose `repository` object is not public withdraws the
  repository at once, before any re-read. A delivery that says public does
  not count as confirmation by itself; the re-read it triggers does.
- A repository that stops being public, is transferred to another account or
  is deleted loses its consent, not just its place on the page. Making it
  public again does not republish it; the owner decides again. Archiving it or
  turning monitoring off removes it from the page and keeps the consent, since
  it is still public.
- Consent records the repository ID and its owner's account ID. A transfer
  keeps the repository ID, so a lost `transferred` delivery is caught by the
  next read that reports a different owner account, which clears the
  consent, and a transfer to an account outside the installation is caught
  by the next repository listing that no longer includes it, which clears
  it too. The same listing check clears consent when the repository leaves
  an installation for any other reason, such as the owner deselecting it
  from an organization installation. Only a complete, successful listing,
  every page of it, counts; a failed or partial listing clears nothing.
  Until then the [confirmation bound](#confirmation-bound) applies.
- One gap is left: if both the `privatized` and the `publicized` deliveries
  are lost and the repository is public again by the next read, Seshat
  cannot tell it was ever private, since a repository object reports its
  current visibility and no history of it. The consent then survives,
  against the rule that making a repository public again does not
  republish it. Everything shown was public at both reads; the cost is only
  that the owner is not asked again. Accepted rather than adding reads.

### Confirmation bound

GitHub does not redeliver a failed webhook on its own (see [Webhook
events](2026-10-12-github-integration.md#webhook-events)), and the object
sweeps only while an owner overview is visible. Without a bound, a lost
`privatized` delivery for a quiet repository would leave its PRs on the
public page for as long as the owner stayed away.

So the public projection includes a published repository only if a GitHub
read reported it public within the last 24 hours. Any read counts: a re-read
of one PR after a delivery, the sweep's count query, which can select
`visibility` for every monitored repository at no extra request, or the
repository listing. A conditional listing answered `304 Not Modified` counts
as well, since GitHub returns 304 only when the stored representation,
`visibility` included, is still current ([conditional
requests][gh-conditional]). Requiring a read of the repository's whole PR
list instead would withhold active repositories more often without
confirming visibility any better; freshness of the rows is a separate
claim, which the page words accordingly (see [What a published repository
shows](#what-a-published-repository-shows)). Otherwise it is withheld,
without clearing its consent, and returns on the next read that confirms it:
a re-read after any delivery about it, or the catch-up sweep when the owner
next opens the overview. This fails closed and needs no timer, so the change
detection rule that nothing runs on a schedule while nobody is looking still
holds.

- The residual exposure is bounded: PRs that were public until the change
  stay on the page for at most 24 hours after the last confirming read.
  Nothing read after the change is shown.
- The cost is that a quiet published repository drops off the public page
  after a day in which the owner did not open the overview and nothing
  happened in it. A visitor who watches the page could infer that much about
  the owner's absence.
- 24 hours is a judgment, not a measurement: shorter withdraws faster and
  drops quiet repositories sooner. [Question 6](#questions-for-the-owner)
  asks the owner, with the alternative of an alarm that confirms published
  repositories' visibility while any are published.

## What is never public

Whatever the consent:

- Private and internal repositories: their names, IDs, PRs, and any count,
  total or placeholder that reveals they exist. GitHub itself answers 404
  rather than 403 for an unauthorized request to a private resource "to avoid
  confirming the existence of private repositories"
  ([troubleshooting][gh-troubleshooting]).
- Owner-centred judgments: buckets, review state, "awaiting your review" and
  the stale flag.
- Reviewers, requested reviewers, their permissions, and the reviews
  themselves. Review state depends on permission lookups made with the
  installation's access, which are Seshat's inference rather than a public
  record.
- Branch names, PR bodies, comments, labels, check run names, details and
  logs, and commit statuses beyond the combined result.
- Conflict state, until it is confirmed that GitHub shows it to visitors
  without write access (see [Not verified](#not-verified)).
- Instance state: which repositories are monitored or excluded, organization
  installations and their acceptance, setup state, sessions, sync errors and
  their messages, and quota failures.
- From the project index: `Next`, `Note`, `Path`, every laptop observation
  (`Stack`, `Started`, `Last commit`, `Checked out`, `Branches`, `Unpushed`,
  `Uncommitted`, `Surveyed`), unknown fields, the preamble, entries with
  `Remote: none` or no `Remote`, and entries not joined to a published
  repository ([index format](../INDEX_FORMAT.md#fields)).

## What a published repository shows

For each published repository: its `owner/name`, a link to it, and its open
PRs, whoever opened them. Each PR shows its number and a link to it, title,
author login with bots marked, draft state, when it was opened, its last
activity and its combined CI result (passing, failing, pending or none, as
defined in [Terms](../DELIVERABLE.md#terms)).

These are facts GitHub shows anyone on a public repository's PR page. The
Checks API, for one, needs the `repo` scope only for private repositories
([check runs][gh-checks]). Rows are ordered by last activity, newest first,
grouped by repository; the owner's bucket order is not used, since it encodes
what the owner should do next.

The page says, in words as plain as the overview's, that each repository's
visibility was confirmed with GitHub within the last day, that changes GitHub
notified since then are included, that changes GitHub did not report may be
missing until Seshat next checks the whole repository, and that it is a
snapshot that a reload refreshes. It does not claim that every row was read
within the last day: a delivery about one PR re-reads that PR and confirms
the repository's visibility, but not the repository's other PRs. It gives no
exact sync time either: sweeps run only while an owner overview is visible,
so the time of the last one says when the owner last had Seshat open. The
visibility statement is true of everything shown by the [confirmation
bound](#confirmation-bound), so it reveals nothing beyond that. Like the
overview, the page claims nothing about local checkouts.

## Index entries

Built by `publish-index-entries` after `show-project-index`. An entry may be
published only if its `Remote` joins to a repository that is itself published.
What may be shown is the entry's name (its heading), its classification (the
section it sits under) and its summary.

The owner publishes an entry after seeing exactly what will be shown.
Consent records those three values as they stood. When the index changes any
of them, the entry drops back to showing nothing from the index until the
owner confirms the new text, because a summary can be edited by the laptop
agent or a refresh PR the owner reviewed for other reasons, and a new section
name can say more than the old one. The repository's PRs stay published
regardless.

## Serving

### The route

The public view is a route on the instance's one Worker, for example
`/p/<link-id>/`, where `<link-id>` is a random value the instance generates
when the owner turns the view on. Rotating it, from the settings screen,
retires every copy of the old link at once. The link is not a secret in any
strong sense, since it is meant to be shared and links leak; filtering assumes
the whole world sees the page. What the random segment adds is that the page
is not found by guessing, and that the owner can cut off one audience without
turning the view off.

- The route needs no sign-in and ignores the owner's session: it returns the
  same response whoever asks, so the owner's own view of it is an exact
  preview.
- The Worker asks the Durable Object for the public projection over RPC and
  renders it, or returns 404 when the view is off or the link ID does not
  match.
- The projection is one pure function from the model and the consent records
  to a separate public type, which holds only the fields above. Nothing else
  serves the public route, and the owner snapshot's serializer is never
  reused for it.
- The public page loads no owner API and opens no WebSocket. Responses carry
  `X-Robots-Tag: noindex`, which asks search engines not to list the page
  ([robots meta tag][google-robots]), so a withdrawn page does not linger in
  search results, and `Referrer-Policy: no-referrer`, so following a link to
  GitHub does not send the page's address, link ID included
  ([Referrer-Policy][mdn-referrer]).

### Cost on the shared quotas

Every request that runs the Worker counts towards the account's 100,000
Worker requests a day, and the RPC call counts towards its 100,000 Durable
Object requests ([Workers limits][cf-limits-requests]; [Durable Objects
pricing][do-pricing]). Static assets are free and unlimited unless the Worker
runs first for them ([static assets billing][cf-assets-billing]). A public
page therefore hands every visitor a small share of a budget the owner's
overview and other Workers on the same account also draw on. Going over it
stops all of them until the daily reset.

The design keeps that exposure small and bounded:

- One Worker request and one object request per page view, with no socket,
  no polling and no follow-up requests. Any page assets are static files.
- A public request writes nothing to storage, so it cannot spend the daily
  rows-written quota, the one whose exhaustion the [stack
  spike](2026-10-13-cloudflare-stack.md#measurements) saw take objects down
  for reads too. If building the projection reads storage rather than memory,
  each view also spends a few of the 5,000,000 rows read a day
  ([Durable Objects pricing][do-pricing]), far less binding than the request
  quotas.
- A public view never makes the object active. Only a visible owner overview
  starts sweeps, so visitors cannot spend the installation's GitHub budget or
  trigger reads. This settles the reader rule the change detection design left
  open.
- `Cache-Control: private, max-age=60` lets a visitor's browser reuse the
  page for a minute without a request. `private` keeps shared caches, such
  as a proxy or Cloudflare's Workers Cache if it were ever enabled, from
  storing it ([Workers Cache][cf-workers-cache]).
- A rate limit on the route, if the Workers Rate Limiting binding is available
  on Free (see [Not verified](#not-verified)), keeps a single client from
  spending the object's quota. The Worker still runs, and counts, for a
  request it refuses, so this protects the object, not the Worker request
  quota.
- The settings screen says that the page draws on the account's free quota,
  and the off switch and link rotation take effect at once.

Publishing the link also advertises the instance's address, and with it the
sign-in page and webhook endpoint. Those are already built to face strangers:
the installation guard deletes unknown installations, the account-ID check
refuses other accounts and the setup page turns itself off
([registration](2026-10-12-github-integration.md#registration-and-installation)).
The GitHub spec's advice to rate-limit the sign-in callback
([rate limits](2026-10-12-github-integration.md#rate-limits)) matters more
once the address is public.

On `workers.dev` the address is `<worker-name>.<account-subdomain>.workers.dev`
([workers.dev][cf-workers-dev]), so a published link also discloses the
account's subdomain, and with it the likely addresses of the owner's other
Workers on the same account, which can then be probed by name. The
recommendation is to serve the public view only from a custom domain, which
needs a zone the owner has on Cloudflare ([custom domains][cf-custom-domains]),
and to turn the instance's `workers.dev` route off with `workers_dev = false`
and its preview URLs off with `preview_urls = false`, so the account
subdomain is not reachable through either. Preview URLs take the form
`<version-prefix>-<worker-name>.<subdomain>.workers.dev`, and Wrangler
leaves an existing setting unchanged when `preview_urls` is omitted, so it
is set explicitly ([preview URLs][cf-previews]). An owner without a
domain can still publish on `workers.dev`, accepting that disclosure; the
settings screen says so ([question 7](#questions-for-the-owner)).

### Caching and withdrawal

Seshat puts public responses in no Cloudflare cache: it does not use the Cache
API or Workers Cache for them. That is deliberate.

- **Cache API.** It is per data center, and `cache.delete` "only purges
  content of the cache in the data center that the Worker was invoked"
  ([Cache API][cf-cache]). A global purge goes through Cloudflare's purge
  options ([how the cache works][cf-how-cache]), which would need a
  Cloudflare API token, and the [GitHub integration
  decision](../DECISIONS.md#2026-10-12--github-integration) chose not to
  give the instance one.
- **Workers Cache.** It is enabled in the Worker's configuration and can be
  purged from inside the Worker with `ctx.cache.purge()`, whose purges
  "propagate globally with the same guarantees as zone-level purges"
  ([Workers Cache purge][cf-workers-cache-purge]), so a token is not the
  obstacle. It buys little here: every request is billed as a Worker request
  "whether the response comes from cache or from your Worker"
  ([Workers Cache][cf-workers-cache]), so it would save only the Durable
  Object request. Against that, it always uses the Free tier's purge limits
  whatever the plan ([Workers Cache purge][cf-workers-cache-purge]), which
  allow five tag or prefix purge requests a minute ([purge
  limits][cf-purge]); no
  propagation time is documented, and a successful purge call means only
  that the request was received; and every withdrawal path would have to
  purge correctly, where without a cache there is nothing to get wrong.

Without a cache, withdrawal needs no purge and takes effect on the next
request.

| Event | Effect on the next public response |
| --- | --- |
| Owner unpublishes a repository | Its PRs are gone |
| Owner turns the public view off | 404 |
| Owner rotates the link | 404 on the old link |
| Repository becomes private or internal, is transferred or deleted | Gone, and its consent is cleared |
| Repository leaves the installation's repository list (transferred out, or deselected from an installation), seen in a complete listing | Gone, and its consent is cleared |
| Repository archived or monitoring turned off in Seshat | Gone; consent kept |
| No read has confirmed the repository public for 24 hours | Withheld until a read does; consent kept |
| An index entry's published text changes | Its index fields are withheld until confirmed |
| Consent records lost | Nothing published |

A browser that loaded the page in the last minute may show its copy until it
reloads. Copies others have saved, forwarded or archived are outside Seshat's
reach, and the settings screen says so before the first publication.

## Constraints for current work

These keep a public view possible without building any of it now. They are
added to the queue entries that own them.

- **`owner-sign-in`:** every route requires the owner's session unless it is
  on one explicit, tested list of unauthenticated routes (setup, sign-in and
  its callback, the webhook, static assets). A public route is then an
  addition to that list rather than an exception scattered through handlers.
- **`build-pr-overview`:** store each repository's visibility, and the time
  a GitHub read last reported it, with every read that stores its PRs and
  with each repository listing; update it from every delivery's `repository`
  object and from `privatized`, `publicized`, `transferred` and `deleted`;
  and treat anything other than `public` as private. Keep the owner snapshot
  and the owner API reachable only through the owner's session. This is the
  one constraint that adds work now, a field in queries already made; it is
  what the [confirmation bound](#confirmation-bound) rests on, and
  [question 8](#questions-for-the-owner) asks whether to take it now.
- **`show-project-index`:** nothing from the index is served on an
  unauthenticated route. Publishing entries is `publish-index-entries`.

None of these adds a GitHub permission, a storage product or a credential.
The public view itself adds none either: it shows data the owner overview
already reads.

## Rejected alternatives

- **Publishing every public repository automatically**, or by a standing
  rule such as "all my public repositories, including new ones". New public
  repositories would appear without the owner deciding, which is the
  accident the brief warns about. Left as an option for the owner; see
  [question 2](#questions-for-the-owner).
- **Configurable field-level consent.** More settings to build and explain
  than a short fixed list needs.
- **Showing private repositories in redacted form** (counts, "a private
  repository" rows). It reveals that they exist and when they are active,
  which GitHub itself declines to do.
- **Publishing buckets and review state.** They describe what the owner
  should do next and rest on permission lookups that are not public records.
- **Live updates for visitors over WebSockets.** Each socket open is a
  Durable Object request and incoming messages are billed at 20 to 1
  ([Durable Objects pricing][do-pricing]), visitors could hold sockets open
  indefinitely, and their visibility would have to be kept from starting
  sweeps.
- **Counting a public page as a reader that starts sweeps.** Strangers would
  decide when Seshat spends its GitHub and Cloudflare budgets.
- **A separate GitHub read for the public view with an installation token
  narrowed to published repositories.** Tokens can be limited to given
  repositories at creation ([installation tokens][gh-install-token]), so
  GitHub would then do part of the filtering, but it doubles the reads, and
  the risk it addresses is in Seshat's model and serializer, which the
  allowlist projection and its tests cover.
- **Hosting the public page elsewhere** (GitHub Pages, a gist, Cloudflare
  Pages) to keep visitors off the account's quotas. Each needs a write
  credential the integration avoided: Contents write, a user token, or a
  Cloudflare API token.
- **Edge caching with a purge on withdrawal.** The Cache API's
  `cache.delete` reaches one data center and a global purge would need a
  Cloudflare API token. Workers Cache can purge globally from the Worker,
  but still bills every hit as a Worker request, runs under the Free tier's
  purge limits with no documented propagation time, and makes every
  withdrawal path depend on a purge succeeding. See [Caching and
  withdrawal](#caching-and-withdrawal).
- **A timer that confirms published repositories' visibility.** An alarm
  every few hours while anything is published would keep quiet repositories
  on the page, at one small GitHub query each time, but would run while
  nobody is looking, which the change detection decision chose against.
  Offered as the alternative in [question 6](#questions-for-the-owner).
- **Consent recorded in the index file.** Agents write that file.

## Questions for the owner

1. **Whether and when.** Offer a public view, opt-in, after the PR overview,
   with index publication after `show-project-index`, both unprioritized?
   *Recommended.* The alternative is to rule it out now and keep only the
   constraints.
2. **Consent per repository, default deny.** Publish only repositories the
   owner names, and never a repository that becomes public later without the
   owner's action? *Recommended.* The alternative is a standing rule such as
   "all my public repositories", which is less to manage and publishes new
   ones automatically.
3. **What a published repository shows.** All its open PRs, whoever opened
   them, with the fixed field list and no buckets or review state?
   *Recommended.* Alternatives: only the owner's own PRs, or adding buckets
   for a view that shows what the owner is waiting on.
4. **The link.** A rotatable random path rather than a fixed one such as
   `/public`? *Recommended*, since rotation withdraws a shared link without
   turning the view off.
5. **Index entries bound to their text.** Withhold an entry's index fields
   when its name, classification or summary changes until the owner confirms?
   *Recommended.* The alternative, consent that follows the entry whatever its
   text, is less friction but lets an edit nobody read for this purpose
   become public.
6. **The confirmation bound.** Withhold a published repository unless a
   GitHub read confirmed it public within the last 24 hours? *Recommended*,
   since it bounds how long a lost `privatized` delivery can leave PRs public
   without running anything on a timer. The cost is that quiet repositories
   drop off the page after a day without owner visits or activity, which a
   watcher could read as owner absence. Alternatives: a shorter or longer
   bound, or an alarm that confirms visibility every few hours while
   anything is published.
7. **Custom domain.** Serve the public view only from a custom domain, with
   the `workers.dev` route off, so a published link does not disclose the
   account subdomain and the likely addresses of the owner's other Workers?
   *Recommended where the owner has a domain on Cloudflare.* The alternative
   is publishing on `workers.dev` and accepting that disclosure.
8. **Visibility storage now.** Have `build-pr-overview` store each
   repository's visibility and when a read last confirmed it, though the
   overview itself does not need it? *Recommended*, since it is one field in
   queries already made and retrofitting it means re-reading every
   repository. The alternative is leaving it to `build-public-view`.

## Not verified

- **Whether the Workers Rate Limiting binding is available on Workers Free.**
  Its page documents limits local to a Cloudflare location, "permissive,
  eventually consistent", with periods of 10 or 60 seconds, but not plan
  availability ([rate limiting][cf-rate-limit]). The design does not depend
  on it.
- **Whether GitHub shows conflict state to visitors without write access on
  a public repository.** Until checked, conflicts stay off the public page.
- **Whether a change from public to internal sends `privatized`.** The
  `repository` event lists no action for internal visibility
  ([webhook events][gh-wh-events]). The design copes either way: payloads
  and reads carry `visibility`, anything not `public` withdraws the
  repository, and the [confirmation bound](#confirmation-bound) covers a
  change nothing reports.
- **Whether a `privatized` delivery and the visibility in later payloads
  arrive promptly.** The design does not depend on timing beyond the
  [confirmation bound](#confirmation-bound).

## Sources

GitHub documentation, read 2026-10-15:

- [About repositories][gh-about-repos]
- [Webhook events and payloads][gh-wh-events]
- [REST API endpoints for repositories][gh-rest-repos]
- [GraphQL public schema][gh-gql-schema] (`RepositoryVisibility`)
- [Troubleshooting the REST API][gh-troubleshooting]
- [REST API endpoints for check runs][gh-checks]
- [Authenticating as a GitHub App installation][gh-install-token]
- [Best practices for using the REST API: conditional requests][gh-conditional]

Cloudflare documentation, read 2026-10-15 and 2026-10-16:

- [Workers limits: daily requests][cf-limits-requests]
- [Durable Objects pricing][do-pricing]
- [Static assets: billing and limitations][cf-assets-billing]
- [Cache API][cf-cache]
- [How the cache works][cf-how-cache]
- [Rate limiting binding][cf-rate-limit]
- [Workers Cache][cf-workers-cache] and [its purge][cf-workers-cache-purge]
- [Purge cache: availability and limits][cf-purge]
- [workers.dev][cf-workers-dev]
- [Custom domains][cf-custom-domains]
- [Preview URLs][cf-previews]

Other:

- [Google Search Central: robots meta tag and X-Robots-Tag][google-robots]
- [MDN: Referrer-Policy][mdn-referrer]

[gh-about-repos]: https://docs.github.com/en/repositories/creating-and-managing-repositories/about-repositories
[gh-wh-events]: https://docs.github.com/en/webhooks/webhook-events-and-payloads
[gh-rest-repos]: https://docs.github.com/en/rest/repos/repos
[gh-gql-schema]: https://docs.github.com/public/fpt/schema.docs.graphql
[gh-troubleshooting]: https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api
[gh-checks]: https://docs.github.com/en/rest/checks/runs
[gh-install-token]: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation
[cf-limits-requests]: https://developers.cloudflare.com/workers/platform/limits/#daily-requests
[do-pricing]: https://developers.cloudflare.com/durable-objects/platform/pricing/
[cf-assets-billing]: https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/#billing
[cf-cache]: https://developers.cloudflare.com/workers/runtime-apis/cache/
[cf-how-cache]: https://developers.cloudflare.com/workers/reference/how-the-cache-works/
[cf-rate-limit]: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
[cf-workers-cache]: https://developers.cloudflare.com/workers/cache/
[cf-workers-cache-purge]: https://developers.cloudflare.com/workers/cache/purge/
[cf-purge]: https://developers.cloudflare.com/cache/how-to/purge-cache/#availability-and-limits
[cf-workers-dev]: https://developers.cloudflare.com/workers/configuration/routing/workers-dev/
[cf-custom-domains]: https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
[cf-previews]: https://developers.cloudflare.com/workers/configuration/previews/
[gh-conditional]: https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests
[google-robots]: https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag
[mdn-referrer]: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referrer-Policy
