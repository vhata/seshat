import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupSite } from "./site-setup.ts";
import { deploySite, verifySite } from "./site-deploy.ts";
import { registerGithubApp } from "./site-registration.ts";
import type { SiteConfig, SiteRuntime } from "./site-types.ts";

vi.mock("./site-deploy.ts", () => ({ deploySite: vi.fn(), verifySite: vi.fn(async () => ({})), verifyAnonymousSite: vi.fn(async () => {}) }));
vi.mock("./site-registration.ts", async () => {
  const actual = await vi.importActual<typeof import("./site-registration.ts")>("./site-registration.ts");
  return { ...actual, registerGithubApp: vi.fn() };
});
const accountId = "a".repeat(32);
const config: SiteConfig = { format: 1, accountId, workerName: "seshat", origin: "https://seshat.owner.workers.dev", stage: "bootstrap" };
const privateKey = generateKeyPairSync("rsa", { modulusLength: 1024, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
const credentials = { origin: config.origin, appId: 17, ownerId: 42, ownerLogin: "owner", ownerType: "User", appSlug: "test-seshat",
  values: { OWNER_ID: "42", GITHUB_APP_SLUG: "test-seshat", GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret", GITHUB_PRIVATE_KEY: privateKey, GITHUB_WEBHOOK_SECRET: "hook" } };
const configured = ["OWNER_ID", "GITHUB_APP_SLUG", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "GITHUB_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET"];
function fixture(initial: SiteConfig | null = null) {
  let saved = initial;
  const privateFiles = new Map<string, unknown>();
  let workerExists = initial?.stage !== "selected" && initial !== null;
  let secrets: string[] = [];
  let externalBinding = false;
  const runtime: SiteRuntime = {
    root: "/checkout", configDir: "/checkout/.seshat",
    readConfig: vi.fn(async () => saved), writeConfig: vi.fn(async value => { saved = value; }),
    readPrivate: vi.fn(async name => privateFiles.get(name) ?? null),
    writePrivate: vi.fn(async (name, value) => { privateFiles.set(name, value); }),
    removePrivate: vi.fn(async name => { privateFiles.delete(name); }),
    command: vi.fn(async () => JSON.stringify({ id: 42, login: "owner", type: "User" })),
    wrangler: vi.fn(async args => {
      if (args[0] === "whoami") return JSON.stringify({ loggedIn: true, accounts: [{ id: accountId, name: "Personal" }] });
      if (args[0] === "auth") return JSON.stringify({ type: "oauth", token: "sensitive-management-token" });
      if (args[0] === "secret") { secrets = configured; return "uploaded"; }
      return "";
    }),
    prompt: vi.fn(async (_message, defaultValue) => defaultValue ?? ""), confirm: vi.fn(async () => {}), open: vi.fn(async () => {}),
    request: vi.fn(async (url, init) => {
      expect((init?.headers as Record<string, string>)?.Authorization).toBe("Bearer sensitive-management-token");
      let result: unknown;
      if (url.endsWith("/workers/scripts")) result = workerExists ? [{ id: "seshat" }] : [];
      else if (url.endsWith("/workers/domains")) result = [];
      else if (url.endsWith("/workers/subdomain")) result = { subdomain: "owner" };
      else if (url.endsWith("/subdomain")) result = { enabled: true };
      else if (url.endsWith("/settings")) result = { bindings: [{ type: "durable_object_namespace", name: "INSTANCE", class_name: "InstanceObject", namespace_id: "namespace-1", ...(externalBinding ? { script_name: "other", environment: "prod" } : {}) }] };
      else if (url.endsWith("/secrets")) result = secrets.map(name => ({ name, type: "secret_text" }));
      else throw new Error(`Unexpected URL: ${url}`);
      return Response.json({ success: true, result });
    }), fetchJson: vi.fn(async () => ({ ok: true, schemaVersion: 4 })),
  };
  vi.mocked(deploySite).mockImplementation(async (_runtime, target) => {
    workerExists = true;
    saved = { ...target, stage: "bootstrap" };
    return {} as Awaited<ReturnType<typeof deploySite>>;
  });
  vi.mocked(registerGithubApp).mockImplementation(async () => {
    privateFiles.set("credentials.json", credentials);
    return credentials;
  });
  return { runtime, privateFiles, saved: () => saved, setSecrets: (value: string[]) => { secrets = value; },
    setExists: (value: boolean) => { workerExists = value; }, external: () => { externalBinding = true; } };
}
beforeEach(() => { vi.clearAllMocks(); vi.spyOn(process.stdout, "write").mockImplementation(() => true); });
afterEach(() => { vi.restoreAllMocks(); });

describe("guided site setup", () => {
  it("provisions a locked bootstrap, uploads privately, and requires billable confirmation despite --yes", async () => {
    const f = fixture();
    await setupSite(f.runtime, true);
    expect(deploySite).toHaveBeenCalledWith(f.runtime, expect.objectContaining({ stage: "selected" }), { yes: true, bootstrap: true });
    expect(f.runtime.confirm).toHaveBeenCalledWith(expect.stringContaining("Cloudflare usage may be billable"), false);
    const bulk = vi.mocked(f.runtime.wrangler).mock.calls.find(([args]) => args[0] === "secret");
    expect(bulk?.[0]).toEqual(["secret", "bulk", "--name", "seshat"]);
    expect(JSON.parse(bulk![1]!.input!)).toEqual(credentials.values);
    expect(f.saved()).toMatchObject({ stage: "configured", ownerId: 42, appSlug: "test-seshat" });
    expect(f.privateFiles.size).toBe(0);
    expect(f.runtime.open).toHaveBeenCalledWith("https://github.com/apps/test-seshat/installations/new");
    expect(JSON.stringify(vi.mocked(f.runtime.writeConfig).mock.calls)).not.toContain("sensitive-management-token");
  });

  it("adopts a configured existing Worker without deploying or downloading/replacing secrets", async () => {
    const f = fixture(); f.setExists(true); f.setSecrets(configured);
    await setupSite(f.runtime, true);
    expect(f.saved()).toEqual({ ...config, stage: "configured", namespaceId: "namespace-1" });
    expect(f.runtime.confirm).toHaveBeenCalledWith(expect.stringContaining("Adopt existing Worker"), false);
    expect(deploySite).not.toHaveBeenCalled(); expect(registerGithubApp).not.toHaveBeenCalled();
    expect(vi.mocked(f.runtime.wrangler).mock.calls.some(([args]) => args[0] === "secret")).toBe(false);
    expect(vi.mocked(f.runtime.request).mock.calls.every(([url]) => !url.includes("/secrets/"))).toBe(true);
  });

  it("refuses an existing Worker with partial credentials instead of recreating its App", async () => {
    const f = fixture(); f.setExists(true); f.setSecrets(["GITHUB_CLIENT_ID"]);
    await expect(setupSite(f.runtime, true)).rejects.toThrow("not fully configured");
    expect(f.runtime.writeConfig).not.toHaveBeenCalled(); expect(deploySite).not.toHaveBeenCalled();
    expect(registerGithubApp).not.toHaveBeenCalled();
  });

  it("refuses adoption of an external Durable Object binding", async () => {
    const f = fixture(); f.setExists(true); f.setSecrets(configured); f.external();
    await expect(setupSite(f.runtime, true)).rejects.toThrow("will not be adopted or replaced");
    expect(f.runtime.writeConfig).not.toHaveBeenCalled(); expect(deploySite).not.toHaveBeenCalled();
    expect(registerGithubApp).not.toHaveBeenCalled();
  });

  it("resumes a selected target when the Worker was not created yet", async () => {
    const f = fixture({ ...config, stage: "selected" });
    await setupSite(f.runtime, true);
    expect(deploySite).toHaveBeenCalledTimes(1);
    expect(f.saved()?.stage).toBe("configured");
  });

  it("adopts its verified locked bootstrap if deployment succeeded before the checkpoint", async () => {
    const f = fixture({ ...config, stage: "selected" }); f.setExists(true);
    await setupSite(f.runtime, true);
    expect(deploySite).not.toHaveBeenCalled();
    expect(f.runtime.confirm).toHaveBeenCalledWith(expect.stringContaining("Adopt this unconfigured bootstrap"), false);
  });

  it("does not recreate a missing configured Worker", async () => {
    const f = fixture({ ...config, stage: "configured" }); f.setExists(false);
    await expect(setupSite(f.runtime, true)).rejects.toThrow("will not silently recreate");
    expect(deploySite).not.toHaveBeenCalled(); expect(registerGithubApp).not.toHaveBeenCalled();
  });

  it("resumes saved credentials without creating another App or asking for its name", async () => {
    const f = fixture(config); f.privateFiles.set("credentials.json", credentials);
    await setupSite(f.runtime, false);
    expect(registerGithubApp).not.toHaveBeenCalled(); expect(f.runtime.prompt).not.toHaveBeenCalled();
    expect(f.saved()?.stage).toBe("configured");
  });

  it("retains pending credentials and upload checkpoint when upload fails, then retries the same values", async () => {
    const f = fixture(config); f.privateFiles.set("credentials.json", credentials);
    const original = f.runtime.wrangler;
    f.runtime.wrangler = vi.fn(async (args, options) => {
      if (args[0] === "secret") throw new Error("upload interrupted");
      return original(args, options);
    });
    await expect(setupSite(f.runtime, true)).rejects.toThrow("upload interrupted");
    expect(f.saved()?.stage).toBe("credentials"); expect(f.privateFiles.get("credentials.json")).toEqual(credentials);
    f.runtime.wrangler = original;
    await setupSite(f.runtime, true);
    expect(registerGithubApp).not.toHaveBeenCalled(); expect(f.privateFiles.size).toBe(0);
  });

  it("retains credentials if post-upload verification fails, then verifies without re-uploading", async () => {
    const f = fixture(config); f.privateFiles.set("credentials.json", credentials);
    vi.mocked(verifySite).mockRejectedValueOnce(new Error("unverified"));
    await expect(setupSite(f.runtime, true)).rejects.toThrow("unverified");
    expect(f.privateFiles.has("credentials.json")).toBe(true);
    expect(f.saved()?.stage).toBe("credentials");
    await setupSite(f.runtime, true);
    expect(vi.mocked(f.runtime.wrangler).mock.calls.filter(([args]) => args[0] === "secret")).toHaveLength(1);
    expect(f.privateFiles.size).toBe(0);
  });

  it("does not automatically restart an interrupted one-use registration", async () => {
    const f = fixture(config); f.privateFiles.set("registration.json", { startedAt: "yesterday" });
    await expect(setupSite(f.runtime, true)).rejects.toThrow("Registration was left unchanged");
    expect(registerGithubApp).not.toHaveBeenCalled();
    expect(f.privateFiles.has("registration.json")).toBe(true);
  });

  it("retains the registration checkpoint when converted credentials could not be saved", async () => {
    const f = fixture(config);
    vi.mocked(registerGithubApp).mockRejectedValueOnce(new Error("persistence failed"));
    await expect(setupSite(f.runtime, true)).rejects.toThrow("persistence failed");
    expect(f.privateFiles.has("registration.json")).toBe(true);
    await expect(setupSite(f.runtime, true)).rejects.toThrow("Registration was left unchanged");
    expect(registerGithubApp).toHaveBeenCalledTimes(1);
  });

  it("refuses a mismatched registering owner before uploading and retains recovery credentials", async () => {
    const f = fixture({ ...config, ownerId: 7 }); f.privateFiles.set("credentials.json", credentials);
    await expect(setupSite(f.runtime, true)).rejects.toThrow("different account");
    expect(f.privateFiles.has("credentials.json")).toBe(true);
    expect(vi.mocked(f.runtime.wrangler).mock.calls.some(([args]) => args[0] === "secret")).toBe(false);
  });

  it("refuses pending credentials created for another origin", async () => {
    const f = fixture(config); f.privateFiles.set("credentials.json", { ...credentials, origin: "https://other.example" });
    await expect(setupSite(f.runtime, true)).rejects.toThrow("another instance origin");
    expect(f.privateFiles.has("credentials.json")).toBe(true);
    expect(vi.mocked(f.runtime.wrangler).mock.calls.some(([args]) => args[0] === "secret")).toBe(false);
  });

  it("preserves credentials if another registration configures the Worker during the browser flow", async () => {
    const f = fixture(config);
    vi.mocked(registerGithubApp).mockImplementationOnce(async () => {
      f.privateFiles.set("credentials.json", credentials);
      f.setSecrets(configured);
      return credentials;
    });
    await expect(setupSite(f.runtime, true)).rejects.toThrow("credentials appeared");
    expect(f.privateFiles.has("credentials.json")).toBe(true);
    expect(vi.mocked(f.runtime.wrangler).mock.calls.some(([args]) => args[0] === "secret")).toBe(false);
  });

  it("does not replace partial credentials found when resuming an attempted upload", async () => {
    const f = fixture({ ...config, stage: "credentials" }); f.privateFiles.set("credentials.json", credentials);
    f.setSecrets(["GITHUB_CLIENT_ID"]);
    await expect(setupSite(f.runtime, true)).rejects.toThrow("credentials appeared");
    expect(f.privateFiles.has("credentials.json")).toBe(true);
    expect(vi.mocked(f.runtime.wrangler).mock.calls.some(([args]) => args[0] === "secret")).toBe(false);
  });

  it("refuses an organization App owner", async () => {
    const f = fixture(config); f.privateFiles.set("credentials.json", { ...credentials, ownerType: "Organization" });
    await expect(setupSite(f.runtime, true)).rejects.toThrow("organization");
    expect(vi.mocked(f.runtime.wrangler).mock.calls.some(([args]) => args[0] === "secret")).toBe(false);
  });

  it("works without gh authentication", async () => {
    const f = fixture(config); f.runtime.command = vi.fn(async () => { throw new Error("gh absent"); });
    await setupSite(f.runtime, true);
    expect(f.saved()?.ownerId).toBe(42);
  });

  it("starts browser login when whoami returns loggedIn false with exit zero", async () => {
    const f = fixture(config); f.privateFiles.set("credentials.json", credentials);
    const original = f.runtime.wrangler;
    let first = true;
    f.runtime.wrangler = vi.fn(async (args, options) => {
      if (args[0] === "whoami" && first) { first = false; return JSON.stringify({ loggedIn: false, accounts: [] }); }
      return original(args, options);
    });
    await setupSite(f.runtime, true);
    expect(f.runtime.wrangler).toHaveBeenCalledWith(["login"], { interactive: true });
  });
});
