import { jsonResponse, type RouteContext } from "./context";
import { instanceStub } from "./instance-stub";

export async function monitoring(context: RouteContext): Promise<Response> {
  return jsonResponse(await instanceStub(context.env).monitoringStatus(context.now));
}
