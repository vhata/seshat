import { isBuildIdentity, isWorkerVersionId, type BuildIdentity } from "../shared/health";

declare const __SESHAT_BUILD_IDENTITY__: BuildIdentity;

export function buildIdentity(): BuildIdentity {
  if (typeof __SESHAT_BUILD_IDENTITY__ === "undefined" || !isBuildIdentity(__SESHAT_BUILD_IDENTITY__)) {
    return { commit: null, dirty: null };
  }
  // Explicit projection keeps even build metadata limited to public fields.
  return { commit: __SESHAT_BUILD_IDENTITY__.commit, dirty: __SESHAT_BUILD_IDENTITY__.dirty };
}

export function workerVersion(metadata: Env["CF_VERSION_METADATA"] | undefined): { id: string | null } {
  const id = metadata?.id;
  return { id: isWorkerVersionId(id) && id !== "00000000-0000-0000-0000-000000000000" ? id : null };
}
