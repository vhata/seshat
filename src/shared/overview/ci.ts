import type { CiResult } from "./types";

/** The combined CI result defined under Terms in docs/DELIVERABLE.md. */
export type CiState = "failing" | "pending" | "passing" | "none";

/** How a single result counts towards the combined CI state. */
export type CiOutcome = "failing" | "pending" | "passing" | "neither";

/** Classifies one check run or commit status. */
export function ciOutcome(result: CiResult): CiOutcome {
  if (result.kind === "commit_status") {
    switch (result.state) {
      case "error":
      case "failure":
        return "failing";
      case "pending":
      case "expected":
        return "pending";
      case "success":
        return "passing";
    }
  }
  if (result.status !== "completed") return "pending";
  switch (result.conclusion) {
    case "failure":
    case "timed_out":
    case "cancelled":
    case "startup_failure":
    case "action_required":
      return "failing";
    case "success":
      return "passing";
    case "neutral":
    case "skipped":
    case "stale":
      return "neither";
    case null:
      // GitHub always sets a conclusion on a completed run. Without one there
      // is no result to count, the same as neutral.
      return "neither";
  }
}

/**
 * Combines every result on the head commit: failing if any fails, otherwise
 * pending if any is pending, otherwise passing if any passed, otherwise none.
 * Whether branch protection requires a check makes no difference.
 */
export function deriveCi(results: readonly CiResult[]): CiState {
  const outcomes = new Set(results.map(ciOutcome));
  if (outcomes.has("failing")) return "failing";
  if (outcomes.has("pending")) return "pending";
  if (outcomes.has("passing")) return "passing";
  return "none";
}
