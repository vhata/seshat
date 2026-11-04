import type { CheckStatus } from "./protocol";

/** Owner-private GitHub Actions evidence, independent of PR check results. */
export type RepositoryCiTrigger = "push" | "schedule";
export type RepositoryCiIssue = "permission-required" | "history-limited" | "github-unavailable" | "rate-limited";
export interface RepositoryCiRun {
  readonly id: number;
  readonly attempt: number;
  readonly number: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly startedAt: number | null;
  readonly headSha: string;
  readonly url: string;
  readonly status: string;
  readonly conclusion: string | null;
}
export interface RepositoryCiStream {
  readonly workflowId: number;
  readonly name: string;
  readonly state: string;
  readonly trigger: RepositoryCiTrigger;
  readonly completed: RepositoryCiRun | null;
  /** Latest run, when newer than (or a rerun of) the completed outcome. */
  readonly pending: RepositoryCiRun | null;
}
export interface RepositoryCiData {
  readonly defaultBranch: string | null;
  readonly streams: readonly RepositoryCiStream[];
  readonly coverage: "complete" | "incomplete";
}
export interface RepositoryCiRecord extends RepositoryCiData {
  readonly repositoryId: number;
  readonly installationId: number;
  readonly ownerAccountId: number;
  readonly check: CheckStatus;
  readonly issue: RepositoryCiIssue | null;
}
