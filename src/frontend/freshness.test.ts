import { describe, expect, it } from "vitest";
import { FIXTURE_NOW as now, SYNC_FIXTURES } from "../shared/overview/fixtures";
import { freshness, isOverdue, relativeTime } from "./freshness";

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
