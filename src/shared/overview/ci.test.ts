import { describe, expect, it } from "vitest";
import { ciOutcome, deriveCi, type CiOutcome } from "./ci";
import type {
  CheckRunConclusion,
  CheckRunStatus,
  CiResult,
  CommitStatusState,
} from "./types";

const run = (
  status: CheckRunStatus,
  conclusion: CheckRunConclusion | null = null,
): CiResult => ({ kind: "check_run", status, conclusion });

const completed = (conclusion: CheckRunConclusion | null): CiResult =>
  run("completed", conclusion);

const status = (state: CommitStatusState): CiResult => ({
  kind: "commit_status",
  state,
});

// One row per value GitHub reports, with the outcome Terms assigns it.
const conclusions: [CheckRunConclusion, CiOutcome][] = [
  ["failure", "failing"],
  ["timed_out", "failing"],
  ["cancelled", "failing"],
  ["startup_failure", "failing"],
  ["action_required", "failing"],
  ["success", "passing"],
  ["neutral", "neither"],
  ["skipped", "neither"],
  ["stale", "neither"],
];

const unfinished: CheckRunStatus[] = [
  "queued",
  "in_progress",
  "waiting",
  "requested",
  "pending",
];

const statuses: [CommitStatusState, CiOutcome][] = [
  ["error", "failing"],
  ["failure", "failing"],
  ["pending", "pending"],
  ["expected", "pending"],
  ["success", "passing"],
];

describe("ciOutcome", () => {
  it.each(conclusions)("counts a completed %s check run as %s", (c, want) => {
    expect(ciOutcome(completed(c))).toBe(want);
  });

  it.each(unfinished)("counts a %s check run as pending", (s) => {
    expect(ciOutcome(run(s))).toBe("pending");
  });

  it("counts a completed check run with no conclusion as neither", () => {
    expect(ciOutcome(completed(null))).toBe("neither");
  });

  it.each(statuses)("counts a %s commit status as %s", (s, want) => {
    expect(ciOutcome(status(s))).toBe(want);
  });
});

describe("deriveCi", () => {
  it("is none with no results", () => {
    expect(deriveCi([])).toBe("none");
  });

  it("is none when every result is neutral, skipped or stale", () => {
    expect(
      deriveCi([completed("neutral"), completed("skipped"), completed("stale")]),
    ).toBe("none");
  });

  it("is passing when one success sits among neither results", () => {
    expect(
      deriveCi([completed("skipped"), status("success"), completed("neutral")]),
    ).toBe("passing");
  });

  it("is pending over passing", () => {
    expect(deriveCi([completed("success"), run("in_progress")])).toBe(
      "pending",
    );
    expect(deriveCi([status("success"), status("pending")])).toBe("pending");
  });

  it("is failing over pending and passing", () => {
    expect(
      deriveCi([completed("success"), run("queued"), completed("cancelled")]),
    ).toBe("failing");
    expect(deriveCi([status("expected"), status("error")])).toBe("failing");
  });

  it("combines check runs and commit statuses", () => {
    expect(deriveCi([completed("success"), status("failure")])).toBe("failing");
    expect(deriveCi([status("success"), run("waiting")])).toBe("pending");
  });

  // Every pair of single results, against the precedence failing > pending >
  // passing > none, so no combination of the two kinds is missed.
  const everyResult: CiResult[] = [
    ...conclusions.map(([c]) => completed(c)),
    completed(null),
    ...unfinished.map((s) => run(s)),
    ...statuses.map(([s]) => status(s)),
  ];
  const rank = { failing: 3, pending: 2, passing: 1, neither: 0 } as const;
  const state = ["none", "passing", "pending", "failing"] as const;

  it("follows the precedence for every pair of results", () => {
    for (const a of everyResult) {
      for (const b of everyResult) {
        const want = state[Math.max(rank[ciOutcome(a)], rank[ciOutcome(b)])];
        expect(deriveCi([a, b]), JSON.stringify([a, b])).toBe(want);
      }
    }
  });
});
