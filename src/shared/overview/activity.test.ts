import { describe, expect, it } from "vitest";
import { STALE_AFTER_MS, isStale, lastActivityAt } from "./activity";
import {
  DAY,
  HEAD,
  NOW,
  dependabot,
  owner,
  passerBy,
  pr,
  review,
} from "./testing";
import type { PrActivity } from "./types";

const activity = (overrides: Partial<PrActivity>): PrActivity => ({
  openedAt: NOW - 30 * DAY,
  lastCommitAt: null,
  lastCommentAt: null,
  lastStateChangeAt: null,
  ...overrides,
});

describe("lastActivityAt", () => {
  it("is the opening time when nothing else has happened", () => {
    expect(lastActivityAt(pr({ activity: activity({}), reviews: [] }))).toBe(
      NOW - 30 * DAY,
    );
  });

  it.each([
    ["a commit", { lastCommitAt: NOW - 2 * DAY }],
    ["a comment", { lastCommentAt: NOW - 2 * DAY }],
    ["a state change", { lastStateChangeAt: NOW - 2 * DAY }],
  ])("takes %s when it is the latest", (_label, overrides) => {
    const input = pr({
      activity: activity({
        lastCommitAt: NOW - 20 * DAY,
        lastCommentAt: NOW - 20 * DAY,
        lastStateChangeAt: NOW - 20 * DAY,
        ...overrides,
      }),
      reviews: [review(owner, "commented", HEAD, NOW - 10 * DAY)],
    });
    expect(lastActivityAt(input)).toBe(NOW - 2 * DAY);
  });

  it("takes a review when it is the latest, whoever submitted it", () => {
    for (const author of [owner, passerBy, dependabot, null]) {
      const input = pr({
        activity: activity({ lastCommitAt: NOW - 20 * DAY }),
        reviews: [
          review(owner, "approved", HEAD, NOW - 15 * DAY),
          review(author, "commented", HEAD, NOW - 2 * DAY),
        ],
      });
      expect(lastActivityAt(input)).toBe(NOW - 2 * DAY);
    }
  });

  it("ignores pending reviews", () => {
    const input = pr({
      activity: activity({ lastCommitAt: NOW - 20 * DAY }),
      reviews: [
        review(owner, "pending", HEAD, null),
        { ...review(owner, "commented", HEAD, NOW), state: "pending" },
      ],
    });
    expect(lastActivityAt(input)).toBe(NOW - 20 * DAY);
  });

  it("never goes earlier than the opening time", () => {
    // A commit authored before the PR was opened.
    const input = pr({
      activity: activity({ lastCommitAt: NOW - 40 * DAY }),
      reviews: [],
    });
    expect(lastActivityAt(input)).toBe(NOW - 30 * DAY);
  });
});

describe("isStale", () => {
  it("uses a 7-day threshold", () => {
    expect(STALE_AFTER_MS).toBe(7 * DAY);
  });

  it.each([
    ["just now", 0, false],
    ["6 days ago", 6 * DAY, false],
    ["1 ms short of 7 days ago", 7 * DAY - 1, false],
    ["exactly 7 days ago", 7 * DAY, true],
    ["1 ms over 7 days ago", 7 * DAY + 1, true],
    ["30 days ago", 30 * DAY, true],
    ["in the future (clock skew)", -60 * 1000, false],
  ])("treats last activity %s as stale: %s", (_label, age, want) => {
    expect(isStale(NOW - age, NOW)).toBe(want);
  });

  it("depends only on the times given", () => {
    const last = NOW - 7 * DAY;
    expect(isStale(last, NOW - 1)).toBe(false);
    expect(isStale(last, NOW)).toBe(true);
  });

  it("flags a whole PR from its latest activity of any kind", () => {
    const quiet = pr({
      activity: activity({ lastCommitAt: NOW - 8 * DAY }),
      reviews: [review(owner, "approved", HEAD, NOW - 9 * DAY)],
    });
    const commented = pr({
      activity: activity({
        lastCommitAt: NOW - 8 * DAY,
        lastCommentAt: NOW - 6 * DAY,
      }),
    });
    const reviewed = pr({
      activity: activity({ lastCommitAt: NOW - 8 * DAY }),
      reviews: [review(passerBy, "commented", HEAD, NOW - 1 * DAY)],
    });
    expect(isStale(lastActivityAt(quiet), NOW)).toBe(true);
    expect(isStale(lastActivityAt(commented), NOW)).toBe(false);
    expect(isStale(lastActivityAt(reviewed), NOW)).toBe(false);
  });
});
