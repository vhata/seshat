# Self-hosting the project index repository

Status: **proposed on 2026-10-13, awaiting the owner.** This answers the queue
entry `self-host-index-repo`: prove or rule out hosting the project index's
git repository on Cloudflare instead of GitHub. The trade-offs it tests are
under
[Where the repository is hosted](2026-10-12-projects-index.md#where-the-repository-is-hosted)
in the project index spec. The work ran on the same Workers Free account and
on the same days as the [Cloudflare stack spike](2026-10-13-cloudflare-stack.md),
using only made-up index content.

## Recommendation

**Rule it out for now, and keep the index on GitHub.** A git server on
Durable Objects does run on the Free plan, serves a small index with little
CPU, and can be made to require a token for reads as well as pushes. Against
that:

- Only one of the two candidate servers runs on Free at all, and its public
  history is four days of commits by one author, two months ago.
- Gating reads took a wrapper around it, because by default it serves a new
  repository publicly and lists repository names without authentication.
- A single bulk push exhausted the account's daily Durable Object write quota
  and took that Worker's objects down, reads included, for some minutes into
  the next day. A git server sharing an account, and possibly a quota, with
  Seshat's own state is a risk the index does not need.
- Everything GitHub gives the index (web and mobile editing, CI checks on the
  format, PRs for unattended laptop-agent runs and hosted refresh) would have
  to be rebuilt or done without.

The saving would mostly be the index-specific Contents grant, which, as the
project index spec notes, `show-project-index` needs across monitored
repositories anyway. The design rule that only Seshat's ingestion knows the
host still stands, so the index can move later with a remote change if a
better-maintained server appears.

## What ran

- **git-on-cloudflare** ([repository][goc]) was not deployed. It keeps pack
  data in R2, and its configuration also binds D1, KV and Queues, with private
  repositories behind its own OIDC sign-in. R2 needs a subscription and a
  payment method (see [Options considered](2026-10-13-cloudflare-stack.md#options-considered)
  in the stack spec), and moving its storage to Durable Objects is not a small
  change.
- **durable-git** ([repository][dgit]), version 0.0.8 under the MIT licence,
  whose public history is nine commits by one author between 2026-08-18 and
  2026-08-21. It stores each repository in a SQLite-backed Durable Object
  (`RepoCell`) with a registry object beside it. It deployed on Free after
  removing its R2 binding, custom domain and CPU-limit setting, which Free
  refuses. Two Workers ran: the server as shipped, and the same server behind
  a wrapper of about 50 lines that requires a token for every request.

With real `git` against the deployed Workers, push, clone, fetch, pull and
force-push all worked, through five rounds of commit, fetch and clone. Push
and read authentication used a random token stored as a Worker secret and
sent as the HTTP Basic password through a stock git credential helper; git
makes one unauthenticated request first, receives 401 and then asks the
helper.

## Reads and authentication

- As shipped, a newly pushed repository is public: an anonymous clone straight
  after the first push succeeded. Flagging it private gates reads, but only
  after a window in which it is readable, and the cached flag can stay stale
  for up to 20 seconds.
- The site-wide repository listing does not go through the server's
  authorization hook, so it showed repository names to anonymous callers.
- The wrapper requires the token for every repository request, closes the
  listing and turns the web interface off. With it, anonymous and wrong-token
  `info/refs`, clone, push and listing requests all returned 401. It also
  drops the server's per-IP rate limiting, which a real deployment would need
  back, since every anonymous request to a public endpoint spends the Free
  plan's 100,000 daily Worker requests.

## CPU and storage

From `wrangler tail` on the deployed Workers. The Worker only forwards to the
object and stayed at 6 ms of CPU or less throughout.

| Case | Object CPU |
| --- | --- |
| Small repository: `info/refs` | 0–4 ms |
| Small repository: clone or fetch | 1–15 ms |
| Small repository: push | 11–41 ms |
| 1,000 commits of a 60 KB file: first push | 534 ms |
| Same: full clone | 281 ms |
| Same: incremental push or fetch | 1–28 ms |
| Same: garbage collection | 5,674 ms |
| Same: full clone after garbage collection | 7,177 ms |
| 20,000 commits, 27 MiB: push | stopped at 32,500 ms |

A small index fits easily within the 30 seconds an object gets on Free (see
[Measurements](2026-10-13-cloudflare-stack.md#measurements) in the stack
spec). The large push was stopped with "Durable Object exceeded its CPU time
limit and was reset"; no ref was created, 31.8 MB of unreferenced data stayed
behind, and garbage collection on it was stopped at the same limit.

The small repository took about 100 KB of SQLite. The 1,000-commit one took
1.2 MB after pushing and 7.8 MB after garbage collection, which discards the
pushed pack's delta compression; that is why a full clone afterwards cost
25 times the CPU. The server also collects garbage on its own five minutes
after any force-push.

## The write-quota failure

Cloudflare's analytics show the wrapper Worker's repository objects writing
135,882 rows in the 23:00 UTC hour of 2026-10-13, past the 100,000 rows a day
allowed on Free; the server writes at least one row per git object, and
garbage collection writes more. From 00:05 to 00:18 UTC on 2026-10-14 every
request to that Worker's objects failed with "Exceeded allowed rows written
in Durable Objects free tier", reads included, because the server creates
its tables in the object's constructor and that counts as a write. The stack
spike's object on the same account kept writing without error in that
window, so enforcement did not reach every Worker on the account this time.
The quota is documented per account
([Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)),
so an import or garbage collection of an index repository could, at worst,
stop Seshat's own state for the rest of the day. Ordinary pushes of a small
index write a few rows each.

## What would be lost compared with GitHub

- **Editing on the web and on a phone.** The server's API is read-only, so
  Seshat would have to build commits itself to offer editing.
- **Format checks.** There is a post-push hook but nothing that can reject a
  push, so CI checks on the index format move to the laptop or to Seshat's
  ingestion.
- **PRs and review.** Unattended laptop-agent runs and hosted refresh would
  push to review branches and need a review view in Seshat, as the project
  index spec anticipated.
- **Access control and audit.** One shared token, with no fine-grained tokens,
  expiry or audit log, and no SSH access.
- **Durability.** GitHub's backups and availability; every clone remains a
  backup, as it does now.

## Not verified

- Rows written per ordinary push, which would size a safe daily budget.
- Whether deleting the repository frees the unreferenced data the failed push
  left behind; the server's API cannot remove it.
- The per-object storage limit on Free, which Cloudflare's limits page gives
  as both 10 GB and 1 GB.

## Questions for the owner

1. Rule out self-hosting the index for now and keep it on GitHub, leaving the
   host-agnostic interface in place? Recommended.
2. Teardown: delete the two spike Workers, `seshat-spike-git-dgit` and
   `seshat-spike-git-gated`, and their data.

[goc]: https://github.com/zllovesuki/git-on-cloudflare
[dgit]: https://github.com/littledivy/durable-git
