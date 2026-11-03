import { describe, expect, it } from "vitest";
import { FIXTURE_NOW as now, SYNC_FIXTURES } from "../shared/overview/fixtures";
import { checkFreshness, freshness, isOverdue, relativeTime } from "./freshness";
import type { CheckStatus } from "../shared/overview/protocol";

describe("page freshness", () => {
  const base = { connected: true, now, visibleSince: now - 60_000 };
  it("uses strict five-minute threshold and first-minute catch-up", () => {
    expect(
      isOverdue(
        { ...SYNC_FIXTURES.live, lastSuccessfulSweepAt: now - 300_000 },
        now,
      ),
    ).toBe(false);
    expect(freshness({ ...base, sync: SYNC_FIXTURES.overdue })).toBe("Overdue");
    expect(
      freshness({
        ...base,
        visibleSince: now - 59_999,
        sync: SYNC_FIXTURES.overdue,
      }),
    ).toBe("Checking");
    expect(
      freshness({ ...base, visibleSince: now, sync: SYNC_FIXTURES.initial }),
    ).toBe("Checking");
  });
  it("does not show old failures in catch-up but shows fresh failed retries immediately", () => {
    expect(
      freshness({ ...base, visibleSince: now, sync: SYNC_FIXTURES.failed }),
    ).toBe("Checking");
    expect(
      freshness({
        ...base,
        visibleSince: now - 20_000,
        sync: SYNC_FIXTURES.failed,
      }),
    ).toBe("Sync failed");
    expect(freshness({ ...base, sync: SYNC_FIXTURES.failed })).toBe(
      "Sync failed",
    );
    expect(freshness({ ...base, sync: SYNC_FIXTURES.live })).toBe("Live");
    expect(freshness({ ...base, sync: SYNC_FIXTURES.rateLimited })).toBe(
      "Live",
    );
  });
  it("gives disconnection precedence and preserves unknown times", () => {
    expect(
      freshness({ ...base, connected: false, sync: SYNC_FIXTURES.failed }),
    ).toBe("Disconnected");
    expect(relativeTime(null, now)).toBe("unknown");
    expect(relativeTime(NaN, now)).toBe("unknown");
    expect(relativeTime(now + 1000, now)).toBe("0s");
    expect(relativeTime(now - 604_800_000, now)).toBe("7d");
  });
});

describe("scoped GitHub freshness", () => {
  const visibleSince = now - 60_000;
  const checked: CheckStatus = {
    lastSuccessfulCheckAt: now - 300_000,
    latestAttempt: { id: 1, startedAt: now - 300_000, result: "success" },
  };
  it("uses the same strict five-minute bound without deriving success from activity", () => {
    expect(checkFreshness(checked, now, visibleSince)).toBe("Checked");
    expect(checkFreshness(checked, now + 1, visibleSince)).toBe("Check overdue");
    expect(checkFreshness(undefined, now, visibleSince)).toBe("Check overdue");
    expect(checkFreshness(undefined, now, now)).toBe("Not checked");
  });
  it("shows pending work while keeping overdue evidence explicit", () => {
    for (const result of ["queued", "running"] as const) {
      const status = { ...checked, latestAttempt: { id: 2, startedAt: now, result } };
      expect(checkFreshness(status, now, visibleSince)).toContain("Checking");
      expect(checkFreshness(status, now + 1, visibleSince)).toContain("overdue");
      expect(checkFreshness(status, now + 1, now)).not.toContain("overdue");
    }
  });
  it("shows failures independently of previous successful evidence and visibility grace", () => {
    const status: CheckStatus = { ...checked, latestAttempt: {
      id: 2, startedAt: now, result: "failed", reason: "github-unavailable",
    } };
    expect(checkFreshness(status, now, now)).toBe("Check failed");
    expect(checkFreshness(status, now + 600_000, visibleSince)).toBe("Check failed");
    expect(checkFreshness({ ...checked, latestAttempt: {
      id: 2, startedAt: now, result: "interrupted",
    } }, now, visibleSince)).toBe("Check interrupted");
  });
});
