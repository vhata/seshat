import type { HealthResponse } from "../shared/health";
import { jsonResponse, type RouteContext } from "./context";
import { instanceStub } from "./instance-stub";

/** `GET /api/health`: the object is reachable and its schema current. */
export async function health(context: RouteContext): Promise<Response> {
  const { schemaVersion } = await instanceStub(context.env).health();
  const body: HealthResponse = { ok: true, schemaVersion };
  return jsonResponse(body);
}
