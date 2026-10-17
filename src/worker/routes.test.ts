import { exports } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PATHS } from "../shared/manifest";
import { PUBLIC_PATHS, ROUTES } from "./routes";
import { BASE, ownerSession, stubGitHub } from "./test-helpers";

let github: ReturnType<typeof stubGitHub>;

beforeEach(() => {
  github = stubGitHub({});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("the public allowlist", () => {
  it("is exactly health, sign-in and its callback, sign-out, setup and the webhook", () => {
    expect([...PUBLIC_PATHS].sort()).toEqual(
      [
        PATHS.health,
        PATHS.signIn,
        PATHS.callback,
        PATHS.signOut,
        PATHS.setup,
        PATHS.registered,
        PATHS.webhook,
      ].sort(),
    );
  });

  it("names only routes that exist", () => {
    for (const path of PUBLIC_PATHS) expect(Object.keys(ROUTES)).toContain(path);
  });
});

describe("every other route", () => {
  const protectedRoutes = Object.entries(ROUTES)
    .filter(([path]) => !PUBLIC_PATHS.has(path))
    .flatMap(([path, methods]) => Object.keys(methods).map((method) => ({ path, method })));

  it("includes the session API and the installation check", () => {
    const paths = protectedRoutes.map((route) => route.path);
    expect(paths).toContain(PATHS.session);
    expect(paths).toContain(PATHS.installed);
  });

  for (const { path, method } of protectedRoutes) {
    it(`${method} ${path} refuses a request without the owner's session`, async () => {
      const response = await exports.default.fetch(`${BASE}${path}`, {
        method,
        headers: { origin: BASE },
        redirect: "manual",
      });
      if (path === "/api" || path.startsWith("/api/") || method !== "GET") {
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: "sign-in required" });
      } else {
        expect(response.status).toBe(303);
        expect(response.headers.get("location")).toBe(
          `${PATHS.signIn}?return_to=${encodeURIComponent(path)}`,
        );
      }
      expect(github.calls).toEqual([]);
    });

    it(`${method} ${path} refuses a forged session cookie`, async () => {
      const response = await exports.default.fetch(`${BASE}${path}`, {
        method,
        headers: { origin: BASE, cookie: `__Host-seshat-session=${"A".repeat(43)}` },
        redirect: "manual",
      });
      expect([401, 303]).toContain(response.status);
    });
  }

  it("treats unknown paths as protected, so their existence is not revealed", async () => {
    for (const path of ["/api", "/api/nothing-here", "/api/repositories", "/setup/other", "/auth/other"]) {
      const response = await exports.default.fetch(`${BASE}${path}`, { redirect: "manual" });
      expect([401, 303]).toContain(response.status);
    }
  });

  it("answers 404 for unknown API paths once signed in", async () => {
    const cookie = await ownerSession();
    const response = await exports.default.fetch(`${BASE}/api/nothing-here`, { headers: { cookie } });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not found" });
  });

  it("refuses unsafe cross-site requests even with the owner's session", async () => {
    const cookie = await ownerSession();
    const response = await exports.default.fetch(`${BASE}${PATHS.signOut}`, {
      method: "POST",
      headers: { cookie },
    });
    expect(response.status).toBe(403);
  });
});
