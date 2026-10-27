import { describe, expect, it, vi } from "vitest";
import { assertWorkerAbsent, cloudflareDiscovery, inspectWorkerTarget } from "./site-cloudflare.ts";
import type { SiteConfig, SiteRuntime } from "./site-types.ts";

const accountId = "a".repeat(32);
const config: SiteConfig = { format: 1, accountId, workerName: "seshat", origin: "https://seshat.owner.workers.dev", stage: "configured", namespaceId: "namespace-1" };
function fixture(options: { binding?: Record<string, unknown>; domains?: unknown[]; enabled?: boolean; scripts?: unknown[]; secrets?: string[]; account?: string } = {}) {
  const runtime = {
    wrangler: vi.fn(async (args: string[]) => JSON.stringify(args[0] === "whoami" ? { loggedIn: true, accounts: [{ id: options.account ?? accountId, name: "Personal" }] } : { type: "oauth", token: "secret-token" })),
    request: vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.headers).toEqual({ Authorization: "Bearer secret-token" });
      let result: unknown;
      if (url.endsWith("/settings")) result = { bindings: [{ name: "INSTANCE", type: "durable_object_namespace", class_name: "InstanceObject", namespace_id: "namespace-1", ...options.binding }] };
      else if (url.endsWith("/domains")) result = options.domains ?? [];
      else if (url.endsWith("/workers/subdomain")) result = { subdomain: "owner" };
      else if (url.endsWith("/subdomain")) result = { enabled: options.enabled ?? true };
      else if (url.endsWith("/scripts")) result = options.scripts ?? [{ id: "seshat" }];
      else if (url.endsWith("/secrets")) result = (options.secrets ?? ["OWNER_ID", "GITHUB_APP_SLUG", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "GITHUB_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET"]).map(name => ({ name }));
      else throw new Error("Unexpected discovery URL");
      return Response.json({ success: true, result });
    }), confirm: vi.fn(async () => {}),
  } as unknown as SiteRuntime;
  return runtime;
}

describe("Cloudflare target discovery", () => {
  it("accepts the saved local namespace and enabled workers.dev origin", async () => {
    const runtime = fixture();
    expect(await inspectWorkerTarget(runtime, config)).toEqual({ namespaceId: "namespace-1", configured: true });
    expect(vi.mocked(runtime.request).mock.calls.some(([url]) => url.includes("/secrets/"))).toBe(false);
  });
  it("accepts an explicitly same-script class binding returned by Cloudflare", async () => {
    expect((await inspectWorkerTarget(fixture({ binding: { script_name: "seshat" } }), config)).namespaceId).toBe("namespace-1");
  });
  it("refuses a cross-script or named-environment namespace", async () => {
    await expect(inspectWorkerTarget(fixture({ binding: { script_name: "other" } }), config)).rejects.toThrow("locally owned");
    await expect(inspectWorkerTarget(fixture({ binding: { environment: "staging" } }), config)).rejects.toThrow("locally owned");
  });
  it("refuses namespace drift and missing namespace identity", async () => {
    await expect(inspectWorkerTarget(fixture({ binding: { namespace_id: "namespace-2" } }), config)).rejects.toThrow("namespace changed");
    await expect(inspectWorkerTarget(fixture({ binding: { namespace_id: "" } }), config)).rejects.toThrow("locally owned");
  });
  it("refuses a disabled workers.dev domain and a domain mapped to another Worker", async () => {
    await expect(inspectWorkerTarget(fixture({ enabled: false }), config)).rejects.toThrow("does not map");
    await expect(inspectWorkerTarget(fixture({ domains: [{ hostname: "site.example", service: "other" }] }), { ...config, origin: "https://site.example" })).rejects.toThrow("does not map");
  });
  it("accepts a matching production custom domain", async () => {
    expect((await inspectWorkerTarget(fixture({ domains: [{ hostname: "site.example", service: "seshat", environment: "production" }] }), { ...config, origin: "https://site.example" })).configured).toBe(true);
  });
  it("does not equate partial App secrets with a configured instance", async () => {
    expect((await inspectWorkerTarget(fixture({ secrets: ["OWNER_ID", "GITHUB_CLIENT_ID"] }), config)).configured).toBe(false);
  });
  it("refuses a saved account unavailable under current authentication", async () => {
    const runtime = fixture({ account: "b".repeat(32) });
    await expect(inspectWorkerTarget(runtime, config)).rejects.toThrow("not available");
    expect(runtime.request).not.toHaveBeenCalled();
  });
  it("refuses bootstrap over a Worker that already exists", async () => {
    await expect(assertWorkerAbsent(fixture(), config)).rejects.toThrow("already exists");
    await expect(assertWorkerAbsent(fixture({ scripts: [] }), config)).resolves.toBeUndefined();
  });
  it("reads API-key authentication into request headers without returning or storing it", async () => {
    const runtime = fixture();
    runtime.wrangler = vi.fn(async args => JSON.stringify(args[0] === "whoami" ? { loggedIn: true, accounts: [] } : { type: "api_key", key: "private-key", email: "person@example.test" }));
    runtime.request = vi.fn(async (_url, options) => {
      expect(options?.headers).toEqual({ "X-Auth-Key": "private-key", "X-Auth-Email": "person@example.test" });
      expect(options?.redirect).toBe("error");
      return Response.json({ success: true, result: [] });
    });
    const discovery = await cloudflareDiscovery(runtime);
    expect(JSON.stringify(discovery)).not.toContain("private-key");
    await discovery.api("/accounts");
  });
});
