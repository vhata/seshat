import type { RepositoryRecord } from "../shared/overview/protocol";
import { REPOSITORIES_PATH } from "../shared/repositories";

/** Include the observed owner so a stale page cannot change a new owner's choice. */
export async function setRepositoryMuted(repository: RepositoryRecord, muted: boolean): Promise<void> {
  const response = await fetch(`${REPOSITORIES_PATH}/mute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repositoryId: repository.id, ownerAccountId: repository.ownerAccountId, muted }),
  });
  if (!response.ok) throw new Error(response.status === 401
    ? "Your session ended. Sign in again."
    : "Could not change muting. Reload to check the current repository settings.");
}
