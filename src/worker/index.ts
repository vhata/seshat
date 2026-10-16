import type { HealthResponse } from "../shared/health";

export { InstanceObject } from "../object/instance";

/** Every instance keeps its state in one object with this name. */
const INSTANCE_NAME = "instance";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    // Static assets are served before the Worker runs; only /api/* and
    // anything else the asset handler passes on reaches this point.
    if (url.pathname === "/api/health") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return Response.json(
          { error: "method not allowed" },
          { status: 405, headers: { allow: "GET, HEAD" } },
        );
      }
      const stub = env.INSTANCE.getByName(INSTANCE_NAME);
      const { schemaVersion } = await stub.health();
      const body: HealthResponse = { ok: true, schemaVersion };
      return Response.json(body, { headers: { "cache-control": "no-store" } });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
