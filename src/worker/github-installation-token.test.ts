import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { InstallationTokens } from "./github-installation-token";
import { readReviewerPermission } from "./github-permissions";

const NOW = Date.UTC(2026, 9, 17);
const bindings = env as unknown as Record<string, string>;
const app = { clientId: bindings.GITHUB_CLIENT_ID!, privateKey: bindings.GITHUB_PRIVATE_KEY! };
const repo = { id: 1, fullName: "owner/repo" };
const account = { id: 2, login: "reviewer" };
const previous = { repositoryId: 1, accountId: 2, login: "reviewer", permission: "write" as const, etag: '"old"' };

describe("installation credentials", () => {
  it("constructs a real Workers Request and refuses redirects without following credentials", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const request = new Request(url, init);
      expect(request.redirect).toBe("manual");
      expect(request.headers.get("authorization")).toMatch(/^Bearer ey/);
      return new Response(null, { status: 302, headers: { location: "https://other.example/token" } });
    });
    expect(await new InstallationTokens(app).get(3, NOW)).toEqual({ ok: false, reason: "github-failed" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent mints, caches in memory and renews three minutes early", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toMatch(/^Bearer ey/);
      return Response.json({ token: "installation-token", expires_at: new Date(NOW + 3_600_000).toISOString() }, { status: 201 });
    });
    const tokens = new InstallationTokens(app);
    const [a, b] = await Promise.all([tokens.get(3, NOW), tokens.get(3, NOW)]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ ok: true, token: "installation-token" });
    await tokens.get(3, NOW + 3_419_999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await tokens.get(3, NOW + 3_420_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    tokens.forget(3);
    await tokens.get(3, NOW);
    expect(fetcher).toHaveBeenCalledTimes(3);
    await tokens.get(4, NOW);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("does not cache failures or malformed expiry and never returns an expired token", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ token: "secret", expires_at: "invalid" }, { status: 201 }));
    const tokens = new InstallationTokens(app);
    expect(await tokens.get(3, NOW)).toEqual({ ok: false, reason: "github-failed" });
    fetcher.mockResolvedValue(Response.json({}, { status: 403 }));
    expect(await tokens.get(3, NOW)).toEqual({ ok: false, reason: "github-failed" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await tokens.get(-1, NOW)).toEqual({ ok: false, reason: "invalid-installation" });
    expect(await new InstallationTokens({ ...app, privateKey: "invalid" }).get(3, NOW)).toEqual({ ok: false, reason: "signing-failed" });
  });
  it("distinguishes rate limits, suspended installations and removed installations", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}, { status: 429 }));
    const tokens = new InstallationTokens(app);
    expect(await tokens.get(3, NOW)).toEqual({ ok: false, reason: "rate-limited" });
    fetcher.mockResolvedValue(Response.json({ message: "This installation has been suspended." }, { status: 403 }));
    expect(await tokens.get(3, NOW)).toEqual({ ok: false, reason: "installation-suspended" });
    fetcher.mockResolvedValue(Response.json({}, { status: 404 }));
    expect(await tokens.get(3, NOW)).toEqual({ ok: false, reason: "installation-removed" });
  });

});

describe("collaborator permission reads", () => {
  it("uses conditional requests and preserves the last known permission on 304 or failure", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      expect(new Headers(init?.headers).get("if-none-match")).toBe('"old"');
      return new Response(null, { status: 304 });
    });
    expect(await readReviewerPermission("token", repo, account, previous)).toEqual({ ok: true, entry: previous });
    fetcher.mockResolvedValue(Response.json({}, { status: 429 }));
    expect(await readReviewerPermission("token", repo, account, previous)).toEqual({ ok: false, entry: previous, reason: "rate-limited" });
  });

  it("uses base permission for custom roles, maps 404 to none, and rejects a custom role name as proof of trust", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ user: { id: 2 }, permission: "write", role_name: "release captain" }, { headers: { etag: '"new"' } }));
    expect((await readReviewerPermission("token", repo, account)).entry).toMatchObject({ permission: "write", etag: '"new"' });
    fetcher.mockResolvedValue(Response.json({}, { status: 404 }));
    expect((await readReviewerPermission("token", repo, account, previous)).entry?.permission).toBe("none");
    fetcher.mockResolvedValue(Response.json({ user: { id: 2 }, permission: "maintain", role_name: "custom" }));
    expect(await readReviewerPermission("token", repo, account, previous)).toEqual({ ok: false, entry: previous });
  });

  it("does not report a successful no-access 404 as a GitHub failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ message: "private-upstream-message" }, { status: 404 }));
    expect(await readReviewerPermission("private-token", repo, account)).toEqual({
      ok: true, entry: { repositoryId: repo.id, accountId: account.id, login: account.login, permission: "none", etag: null },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("refuses a reused login's permission and preserves the requested identity's last known permission", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ user: { id: 999 }, permission: "admin" }));
    expect(await readReviewerPermission("token", repo, account, previous)).toEqual({ ok: false, entry: previous });
    expect(await readReviewerPermission("token", repo, account)).toEqual({ ok: false, entry: null });
  });

  it("does not send another identity's ETag, or an old login's ETag", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      expect(new Headers(init?.headers).has("if-none-match")).toBe(false);
      return Response.json({}, { status: 500 });
    });
    expect((await readReviewerPermission("token", { ...repo, id: 4 }, account, previous)).entry).toBeNull();
    expect((await readReviewerPermission("token", repo, { ...account, login: "renamed" }, previous)).entry).toEqual(previous);
  });
});
