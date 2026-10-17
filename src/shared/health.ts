/** Body of `GET /api/health`, shared by the Worker and the frontend. */
export interface HealthResponse {
  readonly ok: true;
  /** Schema version of the instance's Durable Object database. */
  readonly schemaVersion: number;
}

export function isHealthResponse(value: unknown): value is HealthResponse {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.ok === true &&
    typeof record.schemaVersion === "number" &&
    Number.isInteger(record.schemaVersion) &&
    record.schemaVersion >= 0
  );
}
