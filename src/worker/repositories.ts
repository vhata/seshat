import { REPOSITORIES_PATH } from "../shared/repositories";
import { jsonResponse, type RouteContext } from "./context";
import { instanceStub } from "./instance-stub";

export async function refreshInstallations(context: RouteContext): Promise<Response> {
  const result = await instanceStub(context.env).checkInstallations(context.now);
  return jsonResponse(result, result.ok ? 200 : 502);
}

export async function repositorySettings(context: RouteContext): Promise<Response> {
  return jsonResponse(await instanceStub(context.env).repositorySettings());
}

async function body(context: RouteContext): Promise<Record<string, unknown> | null> {
  if (!context.request.headers.get("content-type")?.startsWith("application/json")) return null;
  try {
    const data: unknown = await context.request.json();
    return data !== null && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : null;
  } catch { return null; }
}
function id(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
export async function refreshRepositories(context: RouteContext): Promise<Response> {
  const data = await body(context);
  if (!data || !id(data.installationId)) return jsonResponse({ error: "invalid request" }, 400);
  const result = await instanceStub(context.env).refreshInstallation(data.installationId, context.now);
  return jsonResponse(result, result.ok ? 200 : result.reason === "continuation" ? 202 : 502);
}
export async function changeMonitoring(context: RouteContext): Promise<Response> {
  const data = await body(context);
  if (!data || !id(data.repositoryId) || !(data.override === null || typeof data.override === "boolean")) {
    return jsonResponse({ error: "invalid request" }, 400);
  }
  const result = await instanceStub(context.env).setMonitoringOverride(data.repositoryId, data.override, context.now);
  return jsonResponse(result, result.ok ? 200 : result.reason === "not-found" ? 404 : 403);
}
export async function decideOrganization(context: RouteContext): Promise<Response> {
  const data = await body(context);
  if (!data || !id(data.installationId) || typeof data.accept !== "boolean") return jsonResponse({ error: "invalid request" }, 400);
  const result = await instanceStub(context.env).decideOrganization(data.installationId, data.accept, context.now);
  return jsonResponse(result, result.ok ? 200 : 409);
}
export { REPOSITORIES_PATH };
