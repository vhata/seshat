/** A dirty build identifies its base commit, not an exact source snapshot. */
export interface BuildIdentity {
  readonly commit: string | null;
  readonly dirty: boolean | null;
}

/** Body of `GET /api/health`, shared by the Worker and the frontend. */
export interface HealthResponse {
  readonly ok: true;
  /** Schema version of the instance's Durable Object database. */
  readonly schemaVersion: number;
  readonly build: BuildIdentity;
  /** Cloudflare's immutable ID for the Worker version serving this request. */
  readonly version: { readonly id: string | null };
}

export function isBuildIdentity(value: unknown): value is BuildIdentity {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.commit === null
    ? record.dirty === null
    : typeof record.commit === "string" && /^[a-f0-9]{40}$/.test(record.commit) && typeof record.dirty === "boolean";
}

export function isWorkerVersionId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
}

export function isHealthResponse(value: unknown): value is HealthResponse {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.ok === true &&
    typeof record.schemaVersion === "number" &&
    Number.isInteger(record.schemaVersion) &&
    record.schemaVersion >= 0 &&
    isBuildIdentity(record.build) &&
    typeof record.version === "object" && record.version !== null &&
    ((record.version as Record<string, unknown>).id === null || isWorkerVersionId((record.version as Record<string, unknown>).id))
  );
}
