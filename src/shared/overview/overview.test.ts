import { describe, expect, it } from "vitest";
import { BUCKETS, type BucketId } from "./buckets";
import {
  buildOverview,
  compareRepositoryNames,
  overviewRow,
} from "./overview";
import {
  DAY,
  NOW,
  dependabot,
  failing,
  maintainer,
  orgRepo,
  owner,
  ownedRepo,
  passing,
  pr,
  review,
  running,
} from "./testing";
import type { PrInput, RepositoryRef } from "./types";

const options = { ownerId: owner.id, now: NOW };

/** A PR whose only activity is a commit `daysAgo` days before NOW. */
function active(daysAgo: number, overrides: Partial<PrInput> = {}): PrInput {
  return pr({
    activity: {
      openedAt: NOW - 60 * DAY,
      lastCommitAt: NOW - daysAgo * DAY,
      lastCommentAt: null,
      lastStateChangeAt: null,
    },
    ...overrides,
  });
}

const repo = (fullName: string): RepositoryRef => ({
  fullName,
  ownerAccountId: owner.id,
});

const ids = (rows: readonly { pr: PrInput }[]) =>
  rows.map((row) => `${row.pr.repository.fullName}#${row.pr.number}`);

function rowsOf(
  overview: ReturnType<typeof buildOverview>,
  id: BucketId,
): readonly { pr: PrInput }[] {
  const found = overview.find((b) => b.bucket.id === id);
  if (found === undefined) throw new Error(`no bucket ${id}`);
  return found.rows;
}

/** Every ordering of a short list, to show the input order does not matter. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map(
      (rest) => [item, ...rest],
    ),
  );
}

describe("compareRepositoryNames", () => {
  it("orders by full name, ignoring case", () => {
    const names = ["vhata/zeta", "Acme/widgets", "vhata/Alpha", "acme/api"];
    expect([...names].sort(compareRepositoryNames)).toEqual([
      "acme/api",
      "Acme/widgets",
      "vhata/Alpha",
      "vhata/zeta",
    ]);
  });

  it("separates names that differ only in case, deterministically", () => {
    expect(compareRepositoryNames("vhata/Seshat", "vhata/seshat")).toBeLessThan(
      0,
    );
    expect(
      compareRepositoryNames("vhata/seshat", "vhata/Seshat"),
    ).toBeGreaterThan(0);
    expect(compareRepositoryNames("vhata/seshat", "vhata/seshat")).toBe(0);
  });

  it("separates repositories with the same name under different owners", () => {
    expect(compareRepositoryNames("acme/seshat", "vhata/seshat")).toBeLessThan(
      0,
    );
  });
});

describe("order within a bucket", () => {
  it("puts the longest waiting first in Needs you", () => {
    const prs = [
      active(1, { number: 1 }),
      active(9, { number: 2 }),
      active(3, { number: 3 }),
    ];
    const overview = buildOverview(prs, options);
    expect(ids(rowsOf(overview, "awaiting-your-review"))).toEqual([
      "vhata/seshat#2",
      "vhata/seshat#3",
      "vhata/seshat#1",
    ]);
  });

  it("puts the latest activity first in Waiting", () => {
    const prs = [
      active(1, { number: 1, isDraft: true }),
      active(9, { number: 2, isDraft: true }),
      active(3, { number: 3, isDraft: true }),
    ];
    const overview = buildOverview(prs, options);
    expect(ids(rowsOf(overview, "draft"))).toEqual([
      "vhata/seshat#1",
      "vhata/seshat#3",
      "vhata/seshat#2",
    ]);
  });

  it.each(BUCKETS.map((b) => [b.id, b.group] as const))(
    "orders %s by the %s rule",
    (id, group) => {
      const inBucket: Record<BucketId, Partial<PrInput>> = {
        "ready-to-land": { author: owner, ci: [passing] },
        broken: { author: owner, ci: [failing] },
        "awaiting-your-review": {},
        "changes-requested-on-yours": {
          author: owner,
          reviews: [review(maintainer, "changes_requested")],
        },
        "ci-running": { author: owner, ci: [running] },
        "waiting-on-the-author": { reviews: [review(owner, "commented")] },
        draft: { isDraft: true },
      };
      const prs = [2, 5, 1].map((daysAgo, index) =>
        active(daysAgo, { number: index + 1, ...inBucket[id] }),
      );
      const rows = rowsOf(buildOverview(prs, options), id);
      // 5 days ago is #2, 2 days ago #1, 1 day ago #3.
      const oldestFirst = ["vhata/seshat#2", "vhata/seshat#1", "vhata/seshat#3"];
      expect(ids(rows)).toEqual(
        group === "needs-you" ? oldestFirst : [...oldestFirst].reverse(),
      );
    },
  );

  it("breaks ties by repository name, then PR number", () => {
    const prs = [
      active(2, { repository: repo("vhata/zeta"), number: 1 }),
      active(2, { repository: repo("vhata/alpha"), number: 7 }),
      active(2, { repository: repo("Vhata/beta"), number: 3 }),
      active(2, { repository: repo("vhata/alpha"), number: 2 }),
      active(2, { repository: orgRepo, number: 40 }),
    ];
    const expected = [
      "acme/widgets#40",
      "vhata/alpha#2",
      "vhata/alpha#7",
      "Vhata/beta#3",
      "vhata/zeta#1",
    ];
    const needsYou = rowsOf(buildOverview(prs, options), "awaiting-your-review");
    expect(ids(needsYou)).toEqual(expected);
    // Ties break the same way in Waiting, where activity runs the other way.
    const drafts = prs.map((p) => ({ ...p, isDraft: true }));
    expect(ids(rowsOf(buildOverview(drafts, options), "draft"))).toEqual(
      expected,
    );
  });

  it("uses ties only after activity", () => {
    const prs = [
      active(2, { repository: repo("vhata/alpha"), number: 1 }),
      active(4, { repository: repo("vhata/zeta"), number: 9 }),
    ];
    expect(
      ids(rowsOf(buildOverview(prs, options), "awaiting-your-review")),
    ).toEqual(["vhata/zeta#9", "vhata/alpha#1"]);
  });

  it("gives the same order whatever order the PRs arrive in", () => {
    const prs = [
      active(3, { repository: repo("vhata/b"), number: 1 }),
      active(3, { repository: repo("vhata/a"), number: 2 }),
      active(3, { repository: repo("vhata/a"), number: 1 }),
      active(8, { repository: repo("vhata/c"), number: 5 }),
      active(1, { repository: repo("vhata/a"), number: 3 }),
    ];
    const orders = new Set(
      permutations(prs).map((input) =>
        buildOverview(input, options)
          .map((b) => ids(b.rows).join(","))
          .join("|"),
      ),
    );
    expect(orders.size).toBe(1);
  });

  it("orders by the latest activity of any kind", () => {
    const commented = active(9, {
      number: 1,
      activity: {
        openedAt: NOW - 60 * DAY,
        lastCommitAt: NOW - 9 * DAY,
        lastCommentAt: NOW - 1 * DAY,
        lastStateChangeAt: null,
      },
    });
    const quiet = active(5, { number: 2 });
    expect(
      ids(rowsOf(buildOverview([commented, quiet], options), "awaiting-your-review")),
    ).toEqual(["vhata/seshat#2", "vhata/seshat#1"]);
  });
});

describe("buildOverview", () => {
  it("returns every bucket in table order, empty ones included", () => {
    const overview = buildOverview([], options);
    expect(overview.map((b) => b.bucket.id)).toEqual(BUCKETS.map((b) => b.id));
    expect(overview.every((b) => b.rows.length === 0)).toBe(true);
  });

  it("places every PR exactly once, in the bucket the rules assign", () => {
    const prs: PrInput[] = [
      active(1, { number: 1, author: owner, ci: [passing] }),
      active(1, { number: 2, author: owner, mergeable: "conflicting" }),
      active(1, { number: 3, author: dependabot }),
      active(1, {
        number: 4,
        author: owner,
        reviews: [review(maintainer, "changes_requested")],
      }),
      active(1, { number: 5, author: owner, ci: [running] }),
      active(1, { number: 6, reviews: [review(owner, "commented")] }),
      active(1, { number: 7, isDraft: true }),
      active(1, { number: 8, reviews: [review(maintainer, "approved")] }),
    ];
    const overview = buildOverview(prs, options);
    const placed = overview.flatMap((b) =>
      b.rows.map((row) => [row.pr.number, b.bucket.id] as const),
    );
    expect(placed).toHaveLength(prs.length);
    expect(new Map(placed)).toEqual(
      new Map<number, BucketId>([
        [1, "ready-to-land"],
        [2, "broken"],
        [3, "awaiting-your-review"],
        [4, "changes-requested-on-yours"],
        [5, "ci-running"],
        [6, "waiting-on-the-author"],
        [7, "draft"],
        [8, "ready-to-land"],
      ]),
    );
    for (const b of overview) {
      for (const row of b.rows) expect(row.bucket).toBe(b.bucket);
    }
  });

  it("flags stale PRs in whichever bucket they are in", () => {
    const prs = [
      active(10, { number: 1, author: owner }),
      active(10, { number: 2 }),
      active(10, { number: 3, isDraft: true }),
      active(2, { number: 4 }),
    ];
    const stale = buildOverview(prs, options).flatMap((b) =>
      b.rows.map((row) => [row.pr.number, b.bucket.id, row.stale] as const),
    );
    expect(stale).toEqual([
      [1, "ready-to-land", true],
      [2, "awaiting-your-review", true],
      [4, "awaiting-your-review", false],
      [3, "draft", true],
    ]);
  });

  it("takes the current time from its options", () => {
    const input = active(6, { number: 1 });
    expect(overviewRow(input, options).stale).toBe(false);
    expect(overviewRow(input, { ...options, now: NOW + DAY }).stale).toBe(true);
  });

  it("keeps extra fields on the caller's PRs", () => {
    const input = { ...active(1), title: "Add the overview", url: "https://example.test/1" };
    const [row] = buildOverview([input], options).flatMap((b) => b.rows);
    expect(row?.pr.title).toBe("Add the overview");
    expect(row?.pr).toBe(input);
  });

  it("exposes the facts behind each row's bucket", () => {
    const row = overviewRow(
      active(1, { repository: ownedRepo, mergeable: "unknown", ci: [running] }),
      options,
    );
    expect(row.facts).toEqual({
      isOwners: false,
      isDraft: false,
      ci: "pending",
      mergeable: "unknown",
      reviewState: "none",
      ownerReviewedHead: false,
    });
    expect(row.lastActivityAt).toBe(NOW - DAY);
  });
});
