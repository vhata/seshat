# GitHub integration

Status: **proposal awaiting the owner's decision.** Nothing here is decided
until [DECISIONS.md](../DECISIONS.md) records it. This answers the queue entry
`choose-github-integration` in [TODO.md](../../TODO.md) and is judged against
[DELIVERABLE.md](../DELIVERABLE.md). Facts about GitHub were checked against
GitHub's documentation on 2026-10-12; each claim links to its source, and
points the documentation does not settle are listed under
[Not verified](#not-verified).

This document does not choose how changes are detected (webhooks, polling or
reconciliation; `choose-change-detection`) or which Cloudflare products are
used (`choose-cloudflare-stack`). It states what each GitHub option makes
available to those decisions.

## Recommendation

Each instance owner registers their own **GitHub App** and installs it on
their personal account with access to all repositories.

- **Sign-in** uses the app's user authorization flow. Seshat exchanges the
  code, reads the account ID from `GET /user`, compares it with the configured
  owner ID, and then discards the user token. A refused account's
  authorization is deleted on GitHub before the refusal page is shown. No user
  token is stored for anyone, the owner included.
- **Data** is read with short-lived installation tokens, minted on demand from
  the app's private key. The app requests read-only access to four repository
  permissions (Metadata, Pull requests, Checks, Commit statuses), and no
  organization or account permissions.
- **Events** arrive on the app's single webhook, which covers every
  repository in every installation, including, as far as the documentation
  indicates, repositories created after setup (to be confirmed; see
  [Not verified](#not-verified)).
- **Organization repositories** become reachable when the app is installed on
  the organization, by an organization owner or by an admin of the repository,
  which requires the app to be public. Nothing from an installation is
  monitored until the owner opts each repository in.
- **Setup** uses GitHub's app manifest flow, so the owner names the app and
  clicks through instead of copying a dozen settings by hand.

The main reasons are that only a GitHub App can get events for a personal
account's new repositories without polling (no webhook can be created on a
user account), that it can be limited to
read-only access where an OAuth App needs the `repo` scope's full read and
write access, and that its credentials are either short-lived (installation
tokens expire after an hour) or stay inside the instance (the private key).
The cost is a heavier one-time setup and an organization-access wrinkle,
described below and put to the owner as [question 1](#questions-for-the-owner).

## What the integration must support

From [DELIVERABLE.md](../DELIVERABLE.md):

- Owner-only sign-in by GitHub account ID; a refused account sees nothing and
  leaves no stored credential (acceptance check 1).
- Discovery of every repository the owner's personal account owns, public or
  private; new repositories monitored without owner action; archived
  repositories dropped; forks and organization repositories opt-in
  (acceptance check 2).
- Per PR: author, draft state, head commit, every check run and commit status
  on the head commit, mergeability, every review with its author, state and
  commit, and the current repository permission of each reviewer for the
  trusted-reviewer rule.
- Notification of the Freshness changes within 60 seconds: PR opened, closed,
  merged, converted to or from draft, pushed to; review submitted; CI result
  on the head commit. Convergence after missed notifications is the
  change-detection decision's job, but it needs the data to be readable on
  demand.
- No paid Cloudflare service and no other paid dependency.

## Options

### A. GitHub App

A GitHub App has its own identity, fine-grained permissions and a single
webhook. It is installed on accounts (the owner's personal account, and
optionally organizations), and each installation chooses "All repositories"
or "Only select repositories" ([installing an app][app-installing]).

**Tokens.**

- *Installation access tokens* act as the app on one installation. The
  instance mints one by signing a JWT with the app's private key (RS256,
  expiry no more than 10 minutes ahead; [JWT][app-jwt]) and calling
  `POST /app/installations/{id}/access_tokens`. The token expires after one
  hour and can be narrowed to particular repositories or permissions at
  creation ([installation tokens][app-install-token]).
- *User access tokens* (`ghu_` prefix) act as a user, limited to what both the
  user and the app can access ([user tokens][app-user-token]). With the
  default setting they expire after eight hours and come with a six-month
  refresh token; using a refresh token invalidates it and the old access token
  ([refreshing][app-refresh]). An app owner can opt out of expiry, which GitHub
  advises against ([token expiration][token-expiry]).

**Owner-only sign-in.** The web flow (with `state` and PKCE, both recommended
by GitHub; [user tokens][app-user-token]) yields a user token. `GET /user`
works with a user access token and needs no permissions
([users API][rest-users]); its `id` is compared with the owner ID configured at
deploy time. The comparison happens before any instance data is rendered.

**What is stored.** App ID and client ID (not secret), client secret, private
key, webhook secret, the owner account ID, and installation IDs with their
account IDs. Installation tokens can be cached for under an hour or minted per
request. No user token needs to be kept (see
[Sign-in and the owner boundary](#sign-in-and-the-owner-boundary)).

**What a refused account leaves behind.** On GitHub, authorizing an app
records a grant visible under the user's "Authorized GitHub Apps"
([revoking authorization][app-revoke]). Seshat can remove it at once with
`DELETE /applications/{client_id}/grant`, authenticated with the app's client
ID and secret, which also deletes every token for that user and app
([OAuth authorizations API][rest-oauth-auth]). Seshat then discards the token.
Nothing is written to storage for the refused account.

Whether a refused account can authorize at all depends on the app's
visibility. A private app can be installed only on the account that owns it,
and GitHub's documentation says only members of the owning organization can
authorize it; a public app can be installed and authorized by anyone
([visibility][app-visibility]). The documentation does not say how this
applies to a private app owned by a personal account; see
[Not verified](#not-verified). The account-ID check is required either way.

**Repositories.** With "All repositories" on the personal account, the
installation covers every repository the account owns, public and private,
forks and archived repositories included; Seshat applies the monitoring rules
itself. `GET /installation/repositories` lists them with an installation token
and needs no extra permission ([installations API][rest-installations]). Each
repository object carries `fork` and `archived`. That an "All repositories"
installation also covers repositories created later is how GitHub Apps are
widely used, but the pages cited here do not state it outright; see
[Not verified](#not-verified).

**Organizations.** The app reaches an organization's repositories only through
an installation on that organization. Organization owners can install apps.
Repository admins can install an app on the repositories they administer if
the app requests no organization permissions and not the "Repository
administration" permission, unless the organization has turned that off.
Members and outside collaborators who cannot install can send the
organization owner a request instead ([installing an app][app-installing]).
A private app cannot be installed on any account other than its owner, so
installing on an organization requires the app to be public, or a separate
app owned by that organization ([visibility][app-visibility]). A public app
can be made private again only while it has no installations on other
accounts ([modifying an app][app-modify]).

**Webhooks.** The app has exactly one webhook, created by GitHub, which
receives subscribed events from every repository and organization the app can
access ([webhook types][wh-types]). Each event needs a matching permission;
see [Webhook events](#webhook-events).

### B. OAuth App

An OAuth App acts only on behalf of a user who has authorized it, with
coarse scopes, and has no webhook of its own
([GitHub Apps and OAuth Apps compared][app-vs-oauth]).

**Owner-only sign-in.** The same web flow, with `state` and PKCE
([authorizing OAuth Apps][oauth-authorizing]), then `GET /user` and the ID
check. Any GitHub user can authorize an OAuth App.

**What is stored.** Client ID, client secret, and, because the OAuth App has
no identity of its own, the owner's user token, which is the instance's only
way to read private data. OAuth tokens are long-lived unless the app opts in
to expiring tokens (eight hours, with a refresh token that expires after six
months without use; [authorizing OAuth Apps][oauth-authorizing]). GitHub
revokes OAuth tokens unused for a year ([token expiration][token-expiry]).
Each repository webhook the instance creates also has a secret.

**What a refused account leaves behind.** The same grant-deletion endpoint
applies to OAuth Apps (`gho_` tokens;
[OAuth authorizations API][rest-oauth-auth]).

**Permissions.** Reading private repositories requires the `repo` scope,
which grants full read and write access to code, commit statuses,
collaborators and repository webhooks on all public and private repositories
the user can reach, and also manages some organization resources
([OAuth scopes][oauth-scopes]). There is no read-only scope for private
repositories. An authorized OAuth App has access to all of the user's
accessible resources ([compared][app-vs-oauth]).

**Organizations.** Access to an organization's private resources depends on
OAuth app access restrictions, which are on by default for new organizations;
with them on, members and outside collaborators must request owner approval,
and hook deliveries from private organization repositories stop for
unapproved apps ([OAuth app access restrictions][oauth-restrictions]). Without
restrictions, the token reaches every organization repository the owner can
access.

**Webhooks.** An OAuth App must create webhooks on each repository or
organization ([compared][app-vs-oauth]). Repository webhooks need admin access
to the repository; organization webhooks need an organization owner; and
webhooks cannot be created for user accounts at all ([webhook types][wh-types]).
So nothing tells the instance that the owner created a repository: it has to
find new repositories by listing them, and only then add a webhook.

**Rate limit.** The owner's personal 5,000 requests per hour, shared with every
other app, OAuth App and personal access token acting as the owner
([REST rate limits][rate-rest]).

### C. Fine-grained personal access token

The owner creates a token in GitHub settings and pastes it into the instance.

- It is not a sign-in mechanism; Seshat would still need option A or B for
  sign-in.
- Each token has one resource owner: the personal account or one
  organization. Repository access can be all or selected repositories of that
  owner; organizations can require approval; expiry is 1 to 366 days or none,
  subject to organization policy ([managing PATs][pat]).
- GitHub lists gaps: no access to repositories where the user is an outside or
  repository collaborator, no access to several organizations at once, and no
  Checks API ([managing PATs][pat]). The REST reference for listing check runs
  does list fine-grained tokens as supported ([check runs][rest-checks]); the
  two pages disagree.
- Webhooks: same per-repository problem as option B.
- Rotation is manual: the owner creates a new token and replaces the secret
  before expiry, or picks no expiry.
- Rate limit: the owner's personal limit, as option B.

### D. Hybrids

- **GitHub App for data and webhooks, OAuth App for sign-in.** No gain: the
  GitHub App's user authorization already provides sign-in, and a second
  registration doubles setup and secrets.
- **GitHub App plus a stored, refreshed owner user token.** The owner's token
  would let Seshat act as the owner, for example to list review requests or
  PRs in repositories where the app is not installed (`show-review-requests`,
  `track-upstream-prs`). It is not needed for the first deliverable and adds a
  long-lived credential (a six-month refresh token). The recommended design
  leaves room to add it later; see [question 4](#questions-for-the-owner).
- **GitHub App plus a fine-grained token for organizations the app cannot be
  installed on.** Possible, but brings back manual rotation and per-repository
  webhooks for those repositories. Not recommended unless the owner has such an
  organization.
- **An identity layer in front of the instance** (for example a Cloudflare
  product with GitHub as the identity provider). This is a Cloudflare stack
  question and is not evaluated here.

## Comparison

| Requirement | A. GitHub App | B. OAuth App | C. Fine-grained PAT |
| --- | --- | --- | --- |
| Owner-only sign-in by ID | Yes | Yes | No; needs A or B |
| Read-only access to private repositories | Yes | No; `repo` is read and write | Yes |
| All owned repositories, private included | Yes ("All repositories") | Yes | Yes (all repositories of one owner) |
| New repository noticed without polling | Yes (`repository` event; see [Not verified](#not-verified)) | No; no user-account webhooks | No |
| Archive noticed | `repository` `archived` event | Per-repository hook, if created | Per-repository hook, if created |
| Organization repositories | App installed on the org (owner, repo admin, or approved request); app must be public | Token reaches them unless OAuth restrictions block; per-repo or org hooks need admin | One token per organization; collaborator repos not supported |
| PRs, reviews, check runs, statuses, mergeability | Yes | Yes | Checks support disputed in GitHub's docs |
| Reviewer permission | Yes (Metadata) | Yes | Yes |
| Stored long-lived credential | Private key (never leaves the instance) | Owner's user token | The PAT |
| Rate limit | Per installation, from 5,000/hour; separate from the owner's own | Owner's 5,000/hour, shared | Owner's 5,000/hour, shared |
| Owner setup | Register app (manifest flow), install | Register OAuth App | Create token, renew it |

## Recommended design

### Registration and installation

The owner registers a GitHub App under their personal account with the
manifest flow. A page on the instance posts a manifest to
`https://github.com/settings/apps/new`; GitHub shows the prefilled
registration, the owner confirms, and GitHub redirects back with a code that
the instance exchanges within one hour at
`POST /app-manifests/{code}/conversions` for the app ID, client ID, client
secret, webhook secret and private key ([manifest flow][app-manifest];
[apps API][rest-apps]). The
manifest sets the webhook URL, callback URL, setup URL, permissions, events
and `public: false` ([manifest flow][app-manifest]).

The setup page must not be open to anyone who finds an unconfigured instance,
or a stranger could attach their own app to it. It should require a one-time
setup secret supplied at deploy time, and turn itself off once the app exists.

The owner then installs the app on their personal account with
**All repositories**. "Only select repositories" would hide new repositories,
which [DELIVERABLE.md](../DELIVERABLE.md#monitored-repositories) does not
allow.

The installation's `installation_id` in the setup redirect can be spoofed, so
the instance confirms installations through the API or webhook rather than the
query string ([setup URL][app-setup-url]).

**Installation guard.** The instance accepts an installation on the owner's
personal account (account ID equal to the owner ID). An installation on an
organization is recorded as pending and processes no data until the owner
accepts it on the repositories screen. Any other installation is deleted with
`DELETE /app/installations/{id}` ([apps API][rest-apps]). Webhook deliveries
from installations that are not accepted are dropped after signature
verification. This guard is what makes a public app safe to run; it costs
little, so it should exist even while the app is private.

### Sign-in and the owner boundary

1. The visitor is redirected to GitHub's authorize URL with `state` and a
   PKCE challenge. The code returned expires after 10 minutes
   ([authorizing OAuth Apps][oauth-authorizing]).
2. The instance exchanges the code for a user token and calls `GET /user`.
3. If `id` differs from the configured owner ID, the instance calls
   `DELETE /applications/{client_id}/grant`, discards the token, and shows the
   refusal page with the login from that response, which is not stored. A
   test feeds a `GET /user` response whose login matches the owner's and whose
   ID does not (acceptance check 1).
4. If `id` matches, the instance calls `DELETE /applications/{client_id}/token`
   to revoke that one token, keeping the grant so the next sign-in needs no
   consent screen, and starts its own session.

No GitHub user token outlives the request. Everything the overview shows is
read with installation tokens, so the owner's session is purely Seshat's own
(session format and lifetime belong to implementation). Authorizing creates
no installation and an installation needs no authorization
([authorizing apps][app-authorizing]), so sign-in never grants the instance
access to anything.

The app requests no account permissions, so authorizing it grants no access
to account resources such as email addresses or gists
([choosing permissions][app-perms]).

### Repository discovery and monitoring

- **Owned repositories.** `GET /installation/repositories` on the personal
  installation, filtered by `owner.id` equal to the owner ID, `fork` false and
  `archived` false for the default set.
- **New repositories.** The `repository` event with action `created`, and
  `installation_repositories` with `added`, are available to the app
  ([webhook events][wh-events]); listing the installation's repositories again
  catches any that are missed.
- **Archive.** `repository` with `archived` and `unarchived`, and the
  `archived` flag when the list is read again. Seshat shows archived
  repositories as not monitored.
- **Other repository changes.** `repository` also reports `deleted`,
  `renamed`, `transferred`, `privatized` and `publicized`
  ([webhook events][wh-events]); the instance should key repositories by ID,
  not name.
- **Forks the owner owns** are in the personal installation and stay off until
  opted in.
- **Organization repositories** come from accepted organization installations.
  Seshat offers an organization repository for opt-in only if the owner's own
  permission on it, read through the collaborator permission endpoint, is at
  least read. Otherwise an installation made by an organization owner could
  show the owner repositories they cannot see on GitHub.

### PR signals

All of these work with installation tokens and the permissions in the next
section.

| Signal | Source | Permission |
| --- | --- | --- |
| Open PRs, author, draft, head SHA | `GET /repos/{o}/{r}/pulls` ([pulls][rest-pulls]) | Pull requests: read |
| Mergeability | `GET /repos/{o}/{r}/pulls/{n}`; `mergeable` is `null` while GitHub computes it, and the GET starts the computation ([pulls][rest-pulls]) | Pull requests: read |
| Reviews with author, state and `commit_id` | `GET /repos/{o}/{r}/pulls/{n}/reviews` ([reviews][rest-reviews]) | Pull requests: read |
| Check runs on the head | `GET /repos/{o}/{r}/commits/{sha}/check-runs` ([check runs][rest-checks]) | Checks: read |
| Commit statuses on the head | `GET /repos/{o}/{r}/commits/{sha}/status` or `.../statuses` ([statuses][rest-statuses]) | Commit statuses: read |
| Reviewer permission | `GET /repos/{o}/{r}/collaborators/{user}/permission` ([collaborators][rest-collab]) | Metadata: read |
| Last activity (comments) | Issue comments and review comments on the PR ([issue comments][rest-issue-comments]) | Pull requests: read |

**The trusted-reviewer rule.** The collaborator permission endpoint works with
installation tokens and needs only Metadata read ([collaborators][rest-collab];
[permissions required][perms-required]). It returns:

- `permission`: one of `admin`, `write`, `read`, `none`, with maintain mapped to
  `write` and triage to `read`;
- `role_name`: the exact role, including custom roles;
- the highest role from every source of grant: repository, teams,
  organization and enterprise.

So it covers organization members with access through teams or base
permissions, and outside collaborators. Trusted means `permission` is `write`
or `admin`, which takes in maintain and any custom role whose base role is
write or higher. For a reviewer with no access the documentation lists only a
404; Seshat should treat 404, `read` and `none` alike as untrusted. Bot and
app reviewers are excluded by the review author's account type before any
permission lookup.

`author_association` on a review is not a substitute: `COLLABORATOR` means
only that the author was invited to collaborate, at any permission
([GraphQL schema][gql-schema], `CommentAuthorAssociation`).

GraphQL offers a shortcut worth testing in implementation:
`PullRequest.latestOpinionatedReviews(writersOnly: true)` returns each user's
latest approving or changes-requested review, limited to users with write
access, and `PullRequestReview.authorCanPushToRepository` reports push access
per review ([GraphQL schema][gql-schema]). One query per repository could then
replace many REST calls. The schema's definition of "write access" has to be
confirmed against the collaborator permission endpoint before relying on it,
and dismissed reviews and bot authors still need filtering.

### Minimum permissions

| Permission | Level | Why | Webhook events it unlocks |
| --- | --- | --- | --- |
| Metadata (repository) | read | Repository list, `fork` and `archived`, collaborator permission | `repository` |
| Pull requests (repository) | read | PRs, mergeability, reviews, PR comments | `pull_request`, `pull_request_review`, `pull_request_review_comment` |
| Checks (repository) | read | Check runs on the head commit | `check_run` (`created`, `completed`), `check_suite` (`completed`) |
| Commit statuses (repository) | read | Commit statuses on the head commit | `status` |
| Organization permissions | none | Keeps repository-admin installs possible on organizations | (none) |
| Account permissions | none | Sign-in needs only `GET /user` | (none) |

Sources: endpoint pages linked in [PR signals](#pr-signals),
[permissions required][perms-required] and [webhook events][wh-events].
Write access to Checks is needed only for the `requested`, `rerequested` and
`requested_action` actions, which Seshat does not use
([webhook events][wh-events]). Adding a repository or organization permission
later requires every installation to approve it, and the installation keeps
the old permissions until then ([modifying an app][app-modify]).

Deliberately left out:

- **Contents.** Needed for the `push` event ([webhook events][wh-events]).
  No `pull_request` action reports a change in mergeability, so conflicts
  introduced by a push to a PR's base branch would otherwise be visible only
  as that push. Without Contents they are found when Seshat next reads the PR.
  Contents read also grants reading all code, which the overview does not
  need.
- **Issues.** Needed for the `issue_comment` event, which carries top-level PR
  comments ([webhook events][wh-events]). The comments themselves are
  readable with Pull requests read ([issue comments][rest-issue-comments]).
  Comments affect only the stale flag and last-activity time, not the
  Freshness list.
- **Members (organization).** Needed for the `member` event that reports
  collaborator changes ([webhook events][wh-events]). Requesting any
  organization permission stops repository admins from installing the app on
  their repositories ([installing an app][app-installing]), and as an
  organization permission it does not obviously cover collaborators on
  personal repositories. Permission is read when a PR is bucketed instead, as
  [DELIVERABLE.md](../DELIVERABLE.md#terms) already says.

Leaving these out is [question 2](#questions-for-the-owner).

### Webhook events

What each option makes available. Choosing between webhooks, polling and
reconciliation is `choose-change-detection`.

| Change | Event and actions | GitHub App | OAuth App or PAT (repository webhook) |
| --- | --- | --- | --- |
| PR opened, closed, merged, reopened | `pull_request`: `opened`, `closed` (merged when `pull_request.merged` is true), `reopened` | Yes | Yes, per repository |
| Converted to or from draft | `pull_request`: `converted_to_draft`, `ready_for_review` | Yes | Yes, per repository |
| Pushed to | `pull_request`: `synchronize` | Yes | Yes, per repository |
| Review submitted or dismissed | `pull_request_review`: `submitted`, `dismissed`, `edited` | Yes | Yes, per repository |
| Check run started or finished | `check_run`: `created`, `completed` | Yes | Yes (repository webhooks get only these two) |
| Check suite finished | `check_suite`: `completed` | Yes | Yes (only `completed`) |
| Commit status | `status` | Yes | Yes, per repository |
| Repository created | `repository`: `created` | Yes (see [Not verified](#not-verified)) | No (no user-account webhooks) |
| Archived or unarchived | `repository`: `archived`, `unarchived` | Yes | Yes, once a hook exists |
| Installation changes | `installation`: `created`, `deleted`, `suspend`, `unsuspend`, `new_permissions_accepted`; `installation_repositories`: `added`, `removed` | Always delivered | Not applicable |
| User revoked authorization | `github_app_authorization` | Always delivered | Not applicable |
| Account renamed | `installation_target` | Always delivered | Not applicable |

Source for every row: [webhook events][wh-events].

Constraints relevant to change detection, all from GitHub's documentation:

- GitHub does not redeliver failed deliveries; a delivery fails if the
  receiver takes longer than 10 seconds to respond
  ([failed deliveries][wh-failed]; [webhook best practices][wh-best]). Failed
  deliveries can be listed and redelivered through the API, for the app
  webhook with a JWT ([failed deliveries][wh-failed]). The redelivery window
  is 3 days in most of the redelivery page and 7 days in its introduction
  ([redelivering][wh-redeliver]).
- A redelivery keeps the original `X-GitHub-Delivery` ID, which suits
  de-duplication ([webhook best practices][wh-best]). Payloads are signed
  with the webhook secret in `X-Hub-Signature-256`
  ([validating deliveries][wh-validate]).
- `check_run` and `check_suite` payloads have an empty `pull_requests` array
  and a null `head_branch` when the PR's head is in a fork, so CI events for
  PRs from forks have to be matched to PRs by head SHA
  ([webhook events][wh-events]).
- The `sender` of `check_run` and `check_suite` can be the placeholder `ghost`
  user ([webhook events][wh-events]).
- The `status` payload lists at most 10 branches containing the SHA
  ([webhook events][wh-events]); matching by SHA avoids depending on it.
- No event in the table reports that GitHub finished computing mergeability.
- Payloads over 25 MB are not delivered ([webhook events][wh-events]).

### Credential storage and lifecycle

| Credential | Lifetime | Where it lives | Rotation and revocation |
| --- | --- | --- | --- |
| Private key | Until deleted | Instance secret | Up to 25 keys per app, so a new key can be deployed before the old one is deleted; an app must always keep one ([private keys][app-keys]) |
| JWT | 10 minutes at most | Memory | Minted per use ([JWT][app-jwt]) |
| Installation token | 1 hour | Memory or short-lived cache | Minted on demand ([installation tokens][app-install-token]) |
| Client secret | Until replaced | Instance secret | Regenerated in app settings |
| Webhook secret | Until replaced | Instance secret | Changed in app settings and on the instance together; deliveries in between fail verification and need redelivery |
| User token | Seconds (revoked after the identity check) | Not stored | `DELETE /applications/{client_id}/token` or `/grant` ([OAuth authorizations API][rest-oauth-auth]) |
| Session | Set by implementation | Instance | Owner signs out or session expires |

**Private key format.** GitHub issues the key as a PKCS#1 PEM
([private keys][app-keys]). The Web Crypto `importKey` accepts `pkcs8` but
not PKCS#1 ([MDN][mdn-importkey]), and Workers implements Web Crypto, so
either setup converts the key to PKCS#8 once or the runtime uses a library
that parses PKCS#1. GitHub recommends a sign-only key vault over an
environment variable ([private keys][app-keys]); no free-tier equivalent is
assumed here.

**Workers secrets.** On Workers, secrets are encrypted, not readable in the
dashboard or Wrangler after they are set, added with `wrangler secret put` or
the dashboard, and setting one deploys a new version ([Workers
secrets][cf-secrets]). The free plan allows 64 variables per Worker at up to
5 KB each ([Workers limits][cf-limits]); PEM-encoded RSA keys of 2048 or
4096 bits are smaller than that.
The manifest flow returns the credentials to the instance, not to the owner's
shell, so either the setup page shows them once for the owner to store as
secrets, or the instance stores them itself. Which is possible depends on
`choose-cloudflare-stack`; [question 3](#questions-for-the-owner) asks the
owner's preference.

**When things are revoked.**

- *Owner uninstalls the app from their account.* `installation` `deleted`
  arrives; installation tokens can no longer be minted. The overview shows a
  failed sync with the reason and the setup page offers to reinstall. Stored
  PR data for that installation should be cleared.
- *Owner suspends the installation.* `installation` `suspend`; same display,
  data kept, resumes on `unsuspend` ([installed apps][app-installed]).
- *Owner revokes their authorization.* `github_app_authorization` arrives
  ([webhook events][wh-events]). Seshat holds no user token, so data access is
  unaffected; the next sign-in shows the consent screen again.
- *An organization uninstalls.* Only that installation's repositories go.
- *Owner deletes the app registration.* Everything stops; the setup flow must
  run again.
- *A credential leaks.* Generate a new private key and delete the old one;
  regenerate the client secret and webhook secret. A leaked user token is
  covered by GitHub's credential revocation API
  ([token expiration][token-expiry]), though Seshat keeps none.

### Rate limits

- **Installation tokens.** Each installation has its own limit, separate from
  the owner's personal limit: at least 5,000 requests per hour, plus 50 per
  repository above 20 (and 50 per organization user above 20), capped at
  12,500 ([REST rate limits][rate-rest]). As arithmetic on that formula, a
  personal installation with 100 repositories gets 9,000 requests per hour.
  GraphQL has a parallel points budget with the same scaling
  ([GraphQL rate limits][rate-graphql]).
- **Conditional requests.** A request with `If-None-Match` that returns
  `304 Not Modified` does not count against the primary limit when it is
  authorized ([REST best practices][rest-best]).
- **Secondary limits.** No more than 100 concurrent requests, 900 points per
  minute per REST endpoint, 2,000 per minute for GraphQL, and 2,000 OAuth token
  requests per hour per app ([REST rate limits][rate-rest]).
- **User-token options** (B, C, or a stored owner token) draw on the owner's
  5,000 per hour shared with the GitHub CLI and every other tool the owner
  uses ([REST rate limits][rate-rest]).

A full REST read of one PR is about five requests (PR, reviews, check runs,
statuses, plus one permission lookup per new reviewer). As an estimate, a
few dozen open PRs re-read every few minutes is a few thousand requests an
hour, within the installation limit; ETags and GraphQL bring it down. The
Cloudflare free plan allows 50 subrequests per invocation
([Workers limits][cf-limits]), which a REST pass over many PRs in one
invocation would exceed. That is for `choose-change-detection` and
`choose-cloudflare-stack` to settle; it favours GraphQL or spreading the work
over several invocations.

### Setup burden

Each owner deploys their own instance, so each owner registers their own app.
With the manifest flow:

1. Find their numeric account ID (`GET /users/{username}`;
   [users API][rest-users]) and set it in deploy configuration with a one-time
   setup secret.
2. Deploy the instance and open its setup page.
3. Name the app and confirm on GitHub (the manifest fills in URLs,
   permissions and events).
4. Store the returned credentials as instance secrets, if the stack requires
   that step (converting the key to PKCS#8 if the runtime needs it).
5. Install the app on their personal account with All repositories.
6. Sign in.

For an organization: make the app public if it is private, install it on the
organization (or ask an organization owner to), choose repositories, and
accept the installation in Seshat.

Without the manifest flow, the owner fills in the registration form by hand:
name, homepage, callback URL, setup URL, webhook URL and secret, four
permissions, about seven events, and visibility, then generates and downloads a
private key. That is error-prone enough that the manifest flow is worth
building, with the manual steps documented as a fallback.

Option B is lighter to register (an OAuth App has a name, homepage and
callback URL) but moves the work into the instance, which must create and
maintain a webhook on every repository and poll for new ones.

### Public view

Nothing here precludes a later public view (`define-public-view`). Data is
read with installation tokens rather than a visitor's credentials, so a
public page needs no GitHub sign-in. The flip side is that GitHub's
permissions do no filtering for such a page: the installation can read every
private repository, so a public view must filter explicitly, as the
[brief](../BRIEF.md#open-design-questions) already requires. The owner gate
applies to the owner's session and stays unchanged.

## Rejected alternatives

- **OAuth App.** Needs the `repo` scope, which is full read and write on every
  private repository the owner can reach; keeps the owner's token as the only
  credential, so a leak exposes the owner's whole account to that scope; has
  no way to hear about new repositories on a personal account; must create
  and maintain webhooks on each repository; and spends the owner's personal
  rate limit.
- **Fine-grained personal access token.** Not a sign-in mechanism, one token
  per account or organization, manual rotation, documented gaps for
  collaborator repositories and possibly the Checks API, and the same webhook
  problem as an OAuth App.
- **GitHub App with a stored owner user token.** Adds a long-lived refresh
  token without serving any first-deliverable requirement.
- **GitHub App installed on "Only select repositories" for the personal
  account.** Hides repositories created after setup.
- **Requesting Contents, Issues or Members** for more events. See
  [Minimum permissions](#minimum-permissions).
- **A shared, centrally hosted app** that every Seshat instance installs.
  Every instance would depend on one registrant's private key and webhook
  URL, which contradicts self-hosting.

## Effect on DELIVERABLE.md

Suggested amendments, to make after the owner decides:

1. **Monitored repositories.** "Any organization repository they can access"
   should read as any organization repository the instance's app has been
   installed on and the owner can access. The app reaches an organization only
   once an organization owner or repository admin installs it, or approves a
   request, and only if the app is public (see
   [question 1](#questions-for-the-owner)). An OAuth App faces the same gate
   when OAuth app access restrictions are on, which is the default for new
   organizations.
2. **Acceptance check 1.** If GitHub refuses a non-owner's authorization of a
   private app, a second account cannot "complete sign-in"; the refusal then
   happens at GitHub. The check should accept refusal either by GitHub or by
   Seshat, with the account-ID test automated against a stubbed `GET /user`
   response. With a public app the check works as written.
3. **Trusted reviewer.** Worth one sentence: trust follows the base role GitHub
   reports, so a custom repository role based on write counts as write.

No requirement in DELIVERABLE.md is unmeetable with the recommended option.

## Not verified

These need confirming with a real app before implementation relies on them.

- Whether a private app owned by a **personal account** can be authorized by
  other GitHub users. GitHub's page states the rule for organization-owned
  apps only ([visibility][app-visibility]).
- Whether an "All repositories" installation on a personal account delivers
  `repository` `created` and `installation_repositories` `added` for a
  repository created afterwards, and includes it in
  `GET /installation/repositories` without any owner action.
- What the collaborator permission endpoint returns for a user with no access
  to a public repository (404, `none` or `read`).
- Whether `latestOpinionatedReviews(writersOnly: true)` counts maintain, admin
  and custom roles the same way as the collaborator permission endpoint.
- Whether fine-grained personal access tokens can call the Checks API (the two
  GitHub pages disagree). This matters only if option C is reconsidered.
- The redelivery window, given as both 3 and 7 days.

The first two can be checked in the `choose-cloudflare-stack` spike, which
already receives a GitHub webhook.

## Questions for the owner

1. **App visibility and organizations.** A private app owned by the owner's
   personal account cannot be installed on an organization, and a public app
   can be installed and authorized by anyone (the installation guard deletes
   strangers' installations and the ID check refuses their sign-in).
   Options: keep the app private and make it public only when the first
   organization is added; make it public from the start; or register a
   separate app per organization.
   *Recommended:* register it private, make it public when an organization is
   added, and ship the installation guard from the start so either state is
   safe. Acceptance check 2 then needs a test app switched to public.
2. **Minimum permissions.** Keep to Metadata, Pull requests, Checks and Commit
   statuses, all read-only, leaving out Contents, Issues and Members. Without
   them, conflicts caused by pushes to a base branch, top-level PR comments and
   collaborator changes are found when Seshat next reads the PR, not pushed by
   a webhook. *Recommended:* yes, keep the minimum; revisit if
   `choose-change-detection` shows that reconciliation cannot meet the
   catch-up bound.
3. **Where setup credentials go.** The manifest flow hands the app's
   credentials to the instance. Either the setup page shows them once for the
   owner to store as secrets (one manual step, no extra credential), or the
   instance stores them itself (no manual step, but the private key then sits
   in instance storage, or the instance needs a Cloudflare API token to write
   its own secrets). *Recommended:* show once for the owner to store, unless
   `choose-cloudflare-stack` finds encrypted storage that is as good.
4. **Owner user token.** Discard the owner's user token after each sign-in, or
   keep and refresh it to enable later features that must act as the owner
   (`show-review-requests`, `track-upstream-prs`). *Recommended:* discard it
   now; those entries can add a stored token, with its own lifecycle, if they
   need one.

## Sources

GitHub documentation, read 2026-10-12:

- [Generating a user access token for a GitHub App][app-user-token]
- [Refreshing user access tokens][app-refresh]
- [Authenticating as a GitHub App installation][app-install-token]
- [Generating a JSON Web Token (JWT) for a GitHub App][app-jwt]
- [Managing private keys for GitHub Apps][app-keys]
- [Making a GitHub App public or private][app-visibility]
- [Modifying a GitHub App registration][app-modify]
- [Registering a GitHub App from a manifest][app-manifest]
- [Differences between GitHub Apps and OAuth apps][app-vs-oauth]
- [Authorizing GitHub Apps][app-authorizing]
- [Reviewing and revoking authorization of GitHub Apps][app-revoke]
- [Installing a GitHub App from a third party][app-installing]
- [Reviewing and modifying installed GitHub Apps][app-installed]
- [About the setup URL][app-setup-url]
- [Choosing permissions for a GitHub App][app-perms]
- [Permissions required for GitHub Apps][perms-required]
- [REST API endpoints for GitHub Apps][rest-apps]
- [REST API endpoints for GitHub App installations][rest-installations]
- [REST API endpoints for OAuth authorizations][rest-oauth-auth]
- [REST API endpoints for collaborators][rest-collab]
- [REST API endpoints for pull requests][rest-pulls]
- [REST API endpoints for pull request reviews][rest-reviews]
- [REST API endpoints for check runs][rest-checks]
- [REST API endpoints for commit statuses][rest-statuses]
- [REST API endpoints for issue comments][rest-issue-comments]
- [REST API endpoints for users][rest-users]
- [Rate limits for the REST API][rate-rest]
- [Rate limits and query limits for the GraphQL API][rate-graphql]
- [Best practices for using the REST API][rest-best]
- [GraphQL public schema][gql-schema]
- [Webhook events and payloads][wh-events]
- [Types of webhooks][wh-types]
- [Handling failed webhook deliveries][wh-failed]
- [Best practices for using webhooks][wh-best]
- [Redelivering webhooks][wh-redeliver]
- [Validating webhook deliveries][wh-validate]
- [Authorizing OAuth apps][oauth-authorizing]
- [Scopes for OAuth apps][oauth-scopes]
- [About OAuth app access restrictions][oauth-restrictions]
- [Token expiration and revocation][token-expiry]
- [Managing your personal access tokens][pat]

Other:

- [Cloudflare Workers secrets][cf-secrets]
- [Cloudflare Workers limits][cf-limits]
- [MDN: SubtleCrypto.importKey()][mdn-importkey]

[app-user-token]: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app
[app-refresh]: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens
[app-install-token]: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation
[app-jwt]: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
[app-keys]: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps
[app-visibility]: https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/making-a-github-app-public-or-private
[app-modify]: https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration
[app-manifest]: https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
[app-vs-oauth]: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps
[app-authorizing]: https://docs.github.com/en/apps/using-github-apps/authorizing-github-apps
[app-revoke]: https://docs.github.com/en/apps/using-github-apps/reviewing-and-revoking-authorization-of-github-apps
[app-installing]: https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party
[app-installed]: https://docs.github.com/en/apps/using-github-apps/reviewing-and-modifying-installed-github-apps
[app-setup-url]: https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url
[app-perms]: https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app
[perms-required]: https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps
[rest-apps]: https://docs.github.com/en/rest/apps/apps
[rest-installations]: https://docs.github.com/en/rest/apps/installations
[rest-oauth-auth]: https://docs.github.com/en/rest/apps/oauth-applications
[rest-collab]: https://docs.github.com/en/rest/collaborators/collaborators
[rest-pulls]: https://docs.github.com/en/rest/pulls/pulls
[rest-reviews]: https://docs.github.com/en/rest/pulls/reviews
[rest-checks]: https://docs.github.com/en/rest/checks/runs
[rest-statuses]: https://docs.github.com/en/rest/commits/statuses
[rest-issue-comments]: https://docs.github.com/en/rest/issues/comments
[rest-users]: https://docs.github.com/en/rest/users/users
[rate-rest]: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
[rate-graphql]: https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api
[rest-best]: https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api
[gql-schema]: https://docs.github.com/public/fpt/schema.docs.graphql
[wh-events]: https://docs.github.com/en/webhooks/webhook-events-and-payloads
[wh-types]: https://docs.github.com/en/webhooks/types-of-webhooks
[wh-failed]: https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries
[wh-best]: https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks
[wh-redeliver]: https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks
[wh-validate]: https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
[oauth-authorizing]: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
[oauth-scopes]: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps
[oauth-restrictions]: https://docs.github.com/en/organizations/managing-oauth-access-to-your-organizations-data/about-oauth-app-access-restrictions
[token-expiry]: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/token-expiration-and-revocation
[pat]: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
[cf-secrets]: https://developers.cloudflare.com/workers/configuration/secrets/
[cf-limits]: https://developers.cloudflare.com/workers/platform/limits/
[mdn-importkey]: https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/importKey
