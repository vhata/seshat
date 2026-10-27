import { generateKeyPairSync } from "node:crypto";
import { request } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { parseCredentials, registerGithubApp } from "./site-registration.ts";
import type { SiteRuntime } from "./site-types.ts";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 1024, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
const conversion = { id: 17, slug: "test-seshat", client_id: "client-id", client_secret: "sensitive-client-secret",
  pem: privateKey, webhook_secret: "sensitive-webhook-secret", owner: { id: 42, login: "owner", type: "User" } };
function get(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; cookie?: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode!, body, cookie: response.headers["set-cookie"]?.[0]?.split(";")[0] }));
    });
    req.on("error", reject); req.end();
  });
}
async function landing(url: string) {
  const page = await get(url);
  const state = /apps\/new\?state=([a-f0-9]+)/.exec(page.body)![1]!;
  const manifest = JSON.parse(/name="manifest" value="([^"]+)"/.exec(page.body)![1]!.replaceAll("&quot;", '"').replaceAll("&amp;", "&"));
  return { page, state, manifest, callback: `${new URL(url).origin}/registered?code=temporary-code&state=${state}` };
}
function runtime(open: SiteRuntime["open"]): SiteRuntime {
  return { root: "/checkout", configDir: "/checkout/.seshat", open,
    request: vi.fn(async () => Response.json(conversion, { status: 201 })), writePrivate: vi.fn(async () => {}),
  } as unknown as SiteRuntime;
}

describe("GitHub App local registration", () => {
  it("keeps hosted App URLs and webhook events while redirecting registration locally", async () => {
    let body = "";
    const client = runtime(async url => {
      const started = await landing(url);
      expect(started.manifest.url).toBe("https://example.workers.dev");
      expect(started.manifest.hook_attributes.url).toBe("https://example.workers.dev/api/github/webhook");
      expect(started.manifest.callback_urls).toEqual(["https://example.workers.dev/auth/callback"]);
      expect(started.manifest.default_events).toContain("pull_request_review");
      expect(started.manifest.redirect_url).toBe(`${new URL(url).origin}/registered`);
      expect(started.page.body).not.toContain("sensitive");
      body = (await get(started.callback, { Cookie: started.page.cookie! })).body;
    });
    const result = await registerGithubApp(client, "https://example.workers.dev", "Seshat test");
    expect(result.ownerId).toBe(42);
    expect(client.writePrivate).toHaveBeenCalledWith("credentials.json", result);
    expect(body).not.toContain("sensitive");
    expect(body).not.toContain("PRIVATE KEY");
    expect(client.request).toHaveBeenCalledWith("https://api.github.com/app-manifests/temporary-code/conversions", expect.objectContaining({ method: "POST" }));
  });

  it("refuses incorrect Host, state and browser cookie without exchanging the code", async () => {
    const client = runtime(async url => {
      const started = await landing(url);
      expect((await get(started.callback)).status).toBe(403);
      expect((await get(started.callback, { Cookie: "seshat-site=wrong" })).status).toBe(403);
      expect((await get(started.callback.replace(started.state, "wrong"), { Cookie: started.page.cookie! })).status).toBe(403);
      expect((await get(started.callback, { Cookie: started.page.cookie!, Host: "attacker.example" })).status).toBe(403);
      expect(client.request).not.toHaveBeenCalled();
      expect((await get(started.callback, { Cookie: started.page.cookie! })).status).toBe(200);
    });
    await registerGithubApp(client, "https://example.workers.dev", "Seshat test");
    expect(client.request).toHaveBeenCalledTimes(1);
  });

  it("consumes the callback once before exchanging its one-use code", async () => {
    let release!: () => void;
    let called!: () => void;
    const began = new Promise<void>(resolve => { called = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const client = runtime(async url => {
      const started = await landing(url);
      const first = get(started.callback, { Cookie: started.page.cookie! });
      await began;
      expect((await get(started.callback, { Cookie: started.page.cookie! })).status).toBe(403);
      release();
      expect((await first).status).toBe(200);
    });
    client.request = vi.fn(async () => { called(); await wait; return Response.json(conversion, { status: 201 }); });
    await registerGithubApp(client, "https://example.workers.dev", "Seshat test");
    expect(client.request).toHaveBeenCalledTimes(1);
  });

  it("keeps concurrent checkout registrations separate in the browser cookie jar", async () => {
    const starts: Awaited<ReturnType<typeof landing>>[] = [];
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    const open = async (url: string) => {
      const started = await landing(url);
      starts.push(started);
      if (starts.length === 2) release();
      await ready;
      const cookies = starts.map(item => item.page.cookie!).join("; ");
      expect((await get(started.callback, { Cookie: cookies })).status).toBe(200);
    };
    const first = runtime(open); const second = runtime(open);
    await Promise.all([registerGithubApp(first, "https://first.example", "Seshat first"),
      registerGithubApp(second, "https://second.example", "Seshat second")]);
    expect(starts[0]!.page.cookie!.split("=")[0]).not.toBe(starts[1]!.page.cookie!.split("=")[0]);
    expect(first.writePrivate).toHaveBeenCalledOnce(); expect(second.writePrivate).toHaveBeenCalledOnce();
  });

  it("does not report registration success when private persistence fails", async () => {
    const client = runtime(async url => {
      const started = await landing(url);
      expect((await get(started.callback, { Cookie: started.page.cookie! })).status).toBe(502);
    });
    client.writePrivate = vi.fn(async () => { throw new Error("disk full"); });
    await expect(registerGithubApp(client, "https://example.workers.dev", "Seshat test")).rejects.toThrow("App may already exist");
    expect(client.request).toHaveBeenCalledTimes(1);
  });

  it("times out and closes the loopback listener", async () => {
    let start = "";
    const client = runtime(async url => { start = url; });
    await expect(registerGithubApp(client, "https://example.workers.dev", "Seshat test", { timeoutMs: 10 })).rejects.toThrow("timed out");
    await expect(get(start)).rejects.toThrow();
    expect(client.request).not.toHaveBeenCalled();
  });

  it("rejects malformed credentials and strips unrelated values before upload", () => {
    const saved = { origin: "https://example.workers.dev", appId: 17, appSlug: "test-seshat", ownerId: 42, ownerLogin: "owner", ownerType: "User",
      values: { OWNER_ID: "42", GITHUB_APP_SLUG: "test-seshat", GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret", GITHUB_PRIVATE_KEY: privateKey, GITHUB_WEBHOOK_SECRET: "webhook", UNRELATED_SECRET: "leave alone" } };
    expect(parseCredentials(saved).values).not.toHaveProperty("UNRELATED_SECRET");
    expect(() => parseCredentials({ ...saved, ownerId: 43 })).toThrow("incomplete");
    expect(() => parseCredentials({ ...saved, values: { ...saved.values, GITHUB_PRIVATE_KEY: "broken" } })).toThrow("private key");
  });
});
