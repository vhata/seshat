import {
  isCheckStatus,
  type CheckAttempt,
  type RepositoryRecord,
} from "../shared/overview/protocol";
import { REPOSITORIES_PATH } from "../shared/repositories";

/** The returned token acknowledges work; only its terminal status confirms it. */
export async function requestRepositoryRefresh(repository: RepositoryRecord): Promise<CheckAttempt> {
  let response: Response;
  try {
    response = await fetch(`${REPOSITORIES_PATH}/refresh-one`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repositoryId: repository.id, ownerAccountId: repository.ownerAccountId }),
    });
  } catch {
    throw new Error("Could not confirm the refresh request. Check its reported status before trying again.");
  }
  if (!response.ok) throw new Error(response.status === 401
    ? "Your session ended. Sign in again."
    : response.status === 403 || response.status === 404
      ? "This repository cannot be refreshed. Check its current access and monitoring settings."
      : "Could not confirm the refresh request. Check its reported status before trying again.");
  try {
    const result: unknown = await response.json();
    if (result === null || typeof result !== "object" || !("ok" in result) || result.ok !== true
      || !("attempt" in result) || !isCheckStatus({ lastSuccessfulCheckAt: null, latestAttempt: result.attempt })
      || result.attempt === null) throw new Error("invalid receipt");
    return result.attempt as CheckAttempt;
  } catch {
    throw new Error("Could not confirm the refresh request. Check its reported status before trying again.");
  }
}

/** A stale snapshot cannot replace a newly acknowledged request. */
export function repositoryRefreshAttempt(receipt: CheckAttempt | null, reported: CheckAttempt | null): CheckAttempt | null {
  if (receipt && (!reported || receipt.id > reported.id)) return receipt;
  if (receipt && reported && receipt.id === reported.id) {
    const progress = (attempt: CheckAttempt) => attempt.result === "queued" ? 0 : attempt.result === "running" ? 1 : 2;
    if (progress(receipt) > progress(reported)) return receipt;
  }
  return reported;
}
