# Design references

Visual references for the first deliverable. They show intended look and
behaviour; they are not specifications. Where a reference and
[DELIVERABLE.md](../DELIVERABLE.md) disagree, the deliverable wins until a
decision in [DECISIONS.md](../DECISIONS.md) changes it.

## PR overview prototype

An interactive prototype of the PR overview, produced in Claude Design from a
prompt derived from the deliverable and exported on 2026-10-12. All
repositories, people and pull requests in it are invented.

- [`overview-prototype/Seshat.dc.html`](overview-prototype/Seshat.dc.html) is the
  export, unmodified. Its script block holds the sample data, the bucketing
  logic (`classify()`) and the proposed ordering.
- [`overview-prototype/screenshots/`](overview-prototype/screenshots/) holds
  renders of each state, captured with headless Chrome from the export with the
  prototype control panel collapsed.

### Viewing it

The export does not run on its own. It needs Claude Design's generated runtime,
`support.js`, in the same directory, and the logo at `assets/seshat.svg`
relative to the HTML. The runtime is not committed: it is generated
third-party code with no licence statement, and this repository is MIT
licensed. To view the prototype, export the project from Claude Design again
(or reuse a previous export), place `support.js` beside the HTML, copy the
repository's [`assets/seshat.svg`](../../assets/seshat.svg) to
`assets/seshat.svg` under the HTML's directory, and serve that directory over
HTTP. The runtime loads React 18, ReactDOM and Babel from
unpkg, and the page loads its fonts from Google Fonts.

A floating "Prototype controls" panel switches screen, sample data set and sync
state, fires simulated live events, and toggles a phone-width frame. The
`theme` (dark or light) and `staleDays` properties are Claude Design editor
controls.

### Screens

| State | Screenshot |
| --- | --- |
| Overview, 25 sample PRs, desktop | [overview-desktop.png](overview-prototype/screenshots/overview-desktop.png) |
| Overview at 390 px wide | [overview-narrow.png](overview-prototype/screenshots/overview-narrow.png) |
| Sync overdue | [sync-overdue.png](overview-prototype/screenshots/sync-overdue.png) |
| Sync failed | [sync-failed.png](overview-prototype/screenshots/sync-failed.png) |
| Nothing needs you | [all-clear.png](overview-prototype/screenshots/all-clear.png) |
| Repositories | [repositories.png](overview-prototype/screenshots/repositories.png) |
| Sign-in | [sign-in.png](overview-prototype/screenshots/sign-in.png) |
| Refused | [refused.png](overview-prototype/screenshots/refused.png) |

### What it shows

- A summary strip of bucket counts per group that jumps to each bucket, then
  the two groups with every bucket, its rule in words and its rows. Empty
  buckets say "None right now"; buckets collapse.
- Rows with every field the deliverable lists, using a glyph and a word for CI,
  review and conflict state, a `bot` tag, `draft` and `stale Nd` badges, and
  "by you" or "you: older commit" beside the review state on other people's
  PRs. Rows link to the PR; the repository and author link to GitHub.
- Live changes: a changed row flashes briefly, carries an accent rail and a
  note such as "CI passed · moved from CI running · 3s ago" for two minutes,
  and the destination bucket's summary chip is highlighted.
- Sync status as a header pill. When a sync is overdue or has failed, a banner
  states the age of the data, the list is dimmed and desaturated, and the
  count line reads "As of HH:MM:SS · may be out of date". Live events pause.
- A narrow layout below 1100 px that turns rows into stacked cards.
- Empty states for no monitored repositories, no open PRs and nothing needing
  the owner.
- Repositories grouped as owned, forks and per organization, with switches;
  archived repositories are shown disabled and "Not monitored".
- Sign-in and refused screens. The refused screen names only the visitor's own
  GitHub login.

### Ordering proposal

Within the Needs you group the prototype orders rows longest waiting first
(oldest last activity first); within Waiting, latest activity first. Both are
labelled as proposals, and sortable column headers override them across all
buckets. The owner adopted both default orders on 2026-10-12; see
[Order within a bucket](../DELIVERABLE.md#order-within-a-bucket). Column
sorting is not required for the first deliverable.

### Where it differs from the deliverable

The prototype's `classify()` disagrees with the
[bucket rules](../DELIVERABLE.md#buckets) in three cases. The owner settled
each on 2026-10-12 (see [DECISIONS.md](../DECISIONS.md)); follow the
deliverable, not the prototype, in all three.

1. Someone else's non-draft PR with CI pending goes to CI running even when the
   owner has not reviewed it. Decided: it stays in Awaiting your review.
2. Mergeability still being computed ("checking") keeps a PR out of Ready to
   land, and sends the owner's own PR to CI running. Decided: checking counts
   as no conflicts.
3. Someone else's PR approved on its current head by another reviewer stays in
   Awaiting your review until the owner reviews it. Decided: an approval from
   a trusted reviewer (write, maintain or admin permission) makes it ready to
   land; an approval from anyone else is ignored, which matches the
   prototype's behaviour for that case.

The prototype also adds behaviour the deliverable does not mention: sortable
columns, collapsible buckets, the summary strip, repository and author links, a
light theme and a "Retry now" action on the sync banner.

### Notes for implementation

- Serve fonts from the instance itself. Loading them from Google Fonts sends
  every visit to a third party.
- The banner copy assumes a 30-second sync interval and a GitHub token. Neither
  is decided; take both from `choose-change-detection` and
  `choose-github-integration`.
- Rows are links containing further clickable elements (repository and
  author). Use non-nested interactive elements in the real markup.
- In the 390 px render the header, summary chips and row ages run past the
  right edge. Check the narrow layout on a real phone viewport against
  acceptance check 10.
- The prototype shows "by you" beside the review state whenever the owner has
  reviewed the current head, even when the review state itself comes from
  another reviewer. The real annotation must describe only the owner's own
  review.
- The `staleDays` editor control (1 to 30 days) exists only for exploring the
  design. The deliverable fixes the stale threshold at 7 days.
