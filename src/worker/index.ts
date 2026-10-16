import { readConfig } from "../shared/config";
import { findSession } from "./auth";
import type { RouteContext } from "./context";
import { dispatch, isPublic, unauthenticated } from "./routes";

export { InstanceObject } from "../object/instance";

export default {
  async fetch(request, env): Promise<Response> {
    // Static assets are served before the Worker runs; only the paths listed
    // under `run_worker_first` in wrangler.jsonc reach this point.
    const url = new URL(request.url);
    const secure = url.protocol === "https:";
    const now = Date.now();
    const session = await findSession(request, env, secure, now);
    if (session === null && !isPublic(url.pathname)) {
      return unauthenticated(url, request.method);
    }
    const context: RouteContext = {
      request,
      env,
      url,
      config: readConfig(env as unknown as Record<string, unknown>),
      secure,
      session,
      now,
    };
    return dispatch(context);
  },
} satisfies ExportedHandler<Env>;
