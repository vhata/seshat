import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// This dependency-free operator script deliberately runs directly in Node.
// @ts-expect-error Standalone JavaScript has no declaration file.
import { evaluate, run } from "../../scripts/monitor-instance.mjs";

const now = 1_800_000_000_000;
const secret = `__Host-seshat-session=${"a".repeat(43)}`;
const healthy = () => ({
  version: 1, serverTime: now, activeSince: now - 100_000,
  sync: { lastSuccessfulSweepAt: now - 60_000, latestAttempt: null, intervalMs: 120_000, slowedByRateLimit: false },
  oldestPendingAt: null, lastEventFailureAt: null, githubRateLimited: false,
  cloudflareCapacity: "unknown",
});
const usageSample = () => ({
  observedAt: now, workersRequests: 0, objectRequests: 0, objectDuration: 0,
  rowsRead: 0, rowsWritten: 0, storage: 0, logs: 0,
});
const json = (value: unknown) => Response.json(value);
let dir: string;
let cookie: string;
let usage: string;
const args = () => ["https://instance.example", "--cookie-file", cookie, "--usage-file", usage];

function responses(monitor: Response | (() => Response | Promise<Response>) = json(healthy()), health = json({ ok: true, schemaVersion: 0 })) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url === "https://instance.example/api/health") return health;
    if (url === "https://instance.example/api/monitoring") return typeof monitor === "function" ? monitor() : monitor;
    throw new Error("unexpected fixture request");
  });
}

beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  dir = await mkdtemp(join(tmpdir(), "seshat-monitor-"));
  cookie = join(dir, "private-cookie");
  usage = join(dir, "private-usage");
  await writeFile(cookie, secret, { mode: 0o600 });
  await writeFile(usage, JSON.stringify(usageSample()), { mode: 0o600 });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("one-shot instance monitoring", () => {
  it("checks public health before owner status and sends the cookie only to status", async () => {
    const fetch = responses();
    expect(await run(args())).toEqual({ exitCode: 0, result: { ok: true, issues: [] } });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://instance.example/api/health", "https://instance.example/api/monitoring",
    ]);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "GET", redirect: "manual", headers: { accept: "application/json" } });
    expect(fetch.mock.calls[0]?.[1]?.headers).not.toHaveProperty("cookie");
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ redirect: "manual", headers: { cookie: secret } });
    expect(fetch.mock.calls[1]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("never reports green without independent Cloudflare capacity evidence", async () => {
    responses();
    expect((await run(args().slice(0, 3))).result).toEqual({ ok: false, issues: ["cloudflare-capacity-unknown"] });
  });

  it.each([401, 302, 500])("handles status %s without following a redirect or printing body details", async (status) => {
    const fetch = responses(new Response("PRIVATE BODY", { status, headers: { location: "https://evil.example/" } }));
    expect(await run(args())).toEqual({ exitCode: 1, result: { ok: false, issues: [status === 401 ? "monitoring-auth-required" : "monitoring-unavailable"] } });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("uses fixed, ordered codes for network and health failures", async () => {
    responses(() => { throw new Error(`${secret} private URL and path`); }, new Response("private", { status: 503 }));
    expect(await run(args())).toEqual({ exitCode: 1, result: { ok: false, issues: ["health-unavailable", "monitoring-unavailable"] } });
  });

  it("aborts an unresponsive request after ten seconds", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error(secret))));
    });
    const pending = run(args());
    // The private-file reads use real I/O before the first request starts.
    await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await pending).result.issues).toEqual(["health-unavailable", "monitoring-unavailable"]);
    vi.useRealTimers();
  });

  it.each([
    new Response("private", { headers: { "content-type": "text/plain" } }),
    new Response("{private", { headers: { "content-type": "application/json" } }),
    new Response("x".repeat(65_537), { headers: { "content-type": "application/json" } }),
    new Response("{}", { headers: { "content-type": "application/json", "content-length": "999999" } }),
  ])("rejects non-JSON, malformed, or oversized status bodies", async (response) => {
    responses(response.clone());
    expect((await run(args())).result.issues).toEqual(["monitoring-invalid"]);
  });

  it.each([
    { serverTime: null }, { serverTime: -1 }, { activeSince: "yesterday" },
    { oldestPendingAt: false }, { lastEventFailureAt: -1 }, { githubRateLimited: 1 },
    { cloudflareCapacity: "low" }, { version: 2 },
    { sync: { ...healthy().sync, intervalMs: 0 } },
    { sync: { ...healthy().sync, intervalMs: "120000" } },
    { sync: { ...healthy().sync, slowedByRateLimit: null } },
    { sync: { ...healthy().sync, lastSuccessfulSweepAt: -1 } },
    { sync: { ...healthy().sync, latestAttempt: { startedAt: now, result: "surprise" } } },
    { sync: { ...healthy().sync, latestAttempt: { startedAt: -1, result: "running" } } },
    { sync: { ...healthy().sync, latestAttempt: { startedAt: now, result: "failed", reason: "secret" } } },
  ])("rejects malformed documented fields %#", async (patch) => {
    responses(json({ ...healthy(), ...patch }));
    expect((await run(args())).result.issues).toEqual(["monitoring-invalid"]);
  });

  it("ignores extra response fields without exposing private details", async () => {
    responses(json({ ...healthy(), repositoryIds: [123], token: secret, owner: "PRIVATE" }));
    expect(await run(args())).toEqual({ exitCode: 0, result: { ok: true, issues: [] } });
  });
});

describe("monitoring policy", () => {
  it("uses server time and reports failures in fixed policy order", () => {
    const value = healthy();
    const result = evaluate({
      ...value, serverTime: now + 900_000, activeSince: now - 900_000,
      sync: { ...value.sync, latestAttempt: { startedAt: now, result: "failed", reason: "github-unavailable" } },
      oldestPendingAt: now, lastEventFailureAt: now, githubRateLimited: true,
    });
    expect(result).toEqual(["sync-failed", "sync-overdue", "background-work-overdue", "event-read-failed", "github-budget-low"]);
  });

  it("treats dormant sync as idle while preserving an explicit failed attempt", () => {
    expect(evaluate({ ...healthy(), activeSince: null, sync: { ...healthy().sync, lastSuccessfulSweepAt: null } })).toEqual([]);
    expect(evaluate({ ...healthy(), activeSince: null, sync: { ...healthy().sync, latestAttempt: { startedAt: 0, result: "failed", reason: "rate-limited" } } })).toEqual(["sync-failed"]);
  });

  it("allows recovery grace after reactivation even with a much older successful sweep", () => {
    const value = { ...healthy(), activeSince: now - 60_000, sync: { ...healthy().sync, lastSuccessfulSweepAt: 0 } };
    expect(evaluate(value)).toEqual([]);
    expect(evaluate({ ...value, serverTime: now + 1 })).toEqual(["sync-overdue"]);
  });

  it("requires the first successful sweep after a minute of visible activity", () => {
    const value = { ...healthy(), activeSince: now - 60_000, sync: { ...healthy().sync, lastSuccessfulSweepAt: null } };
    expect(evaluate(value)).toEqual([]);
    expect(evaluate({ ...value, serverTime: now + 1 })).toEqual(["sync-overdue"]);
  });

  it("respects the two-interval floor and the ten-minute running-attempt threshold", () => {
    const value = { ...healthy(), activeSince: now - 900_000, sync: { ...healthy().sync, intervalMs: 300_000, lastSuccessfulSweepAt: now - 600_000, latestAttempt: { startedAt: now - 600_000, result: "running" } } };
    expect(evaluate(value)).toEqual([]);
    expect(evaluate({ ...value, serverTime: now + 1 })).toEqual(["sync-overdue", "sync-stalled"]);
    expect(evaluate({ ...value, activeSince: null, serverTime: now + 1 })).toEqual([]);
  });

  it.each([900_001, -1])("marks stale or future usage unknown (age %s)", async (age) => {
    await writeFile(usage, JSON.stringify({ ...usageSample(), observedAt: now - age }));
    responses();
    expect((await run(args())).result.issues).toEqual(["cloudflare-capacity-unknown"]);
  });

  it.each(["workersRequests", "objectRequests", "objectDuration", "rowsRead", "rowsWritten", "storage", "logs"])("warns at 80 percent of %s", async (field) => {
    await writeFile(usage, JSON.stringify({ ...usageSample(), [field]: 0.8 }));
    responses();
    expect((await run(args())).result.issues).toEqual(["cloudflare-capacity-low"]);
  });
});

describe("private local configuration", () => {
  it.each([
    "http://instance.example", "https://user:password@instance.example", "https://instance.example/path",
    "https://instance.example/?secret", "https://instance.example/#secret", "file:///private",
    "https://instance.example/../", " https://instance.example", "http://127.1",
  ])("rejects unsafe instance URL %s before sending requests", async (origin) => {
    const fetch = vi.spyOn(globalThis, "fetch");
    expect(await run([origin, ...args().slice(1)])).toEqual({ exitCode: 2, result: { ok: false, issues: ["config-invalid"] } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"])("accepts a local development cookie for %s", async (origin) => {
    await writeFile(cookie, secret.replace("__Host-", ""));
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => String(input).endsWith("/api/health") ? json({ ok: true, schemaVersion: 0 }) : json(healthy()));
    expect((await run([origin, ...args().slice(1)])).exitCode).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(["seshat-session=" + "a".repeat(43), `${secret}\r\nInjected: private`, `${secret}\n`, `${secret}; extra=private`, "Cookie: " + secret, "a".repeat(4097)])("rejects invalid cookie header %#", async (value) => {
    await writeFile(cookie, value);
    expect((await run(args())).result.issues).toEqual(["config-invalid"]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([0o640, 0o604, 0o666])("rejects cookie files with mode %s", async (mode) => {
    await chmod(cookie, mode);
    expect((await run(args())).exitCode).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects symbolic links and nonregular files", async () => {
    const link = join(dir, "link");
    await symlink(cookie, link);
    expect((await run([args()[0], "--cookie-file", link])).exitCode).toBe(2);
    expect((await run([args()[0], "--cookie-file", dir])).exitCode).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["{}", "null", '{"observedAt":1e999}', JSON.stringify({ ...usageSample(), logs: -1 }), "x".repeat(16_385)])("rejects malformed or oversized usage samples %#", async (value) => {
    await writeFile(usage, value);
    expect((await run(args())).exitCode).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("checks usage file privacy independently", async () => {
    await chmod(usage, 0o644);
    expect((await run(args())).exitCode).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([[], ["--cookie", "private"], ["--cookie-file"], ["--cookie-file", "x", "--cookie-file", "y"], ["--cookie-file", "x", "--unknown", "private"]].map((tail) => [tail]))("rejects invalid arguments %#", async (tail) => {
    expect((await run(["https://instance.example", ...tail])).exitCode).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("prints exactly one safe JSON line and exits two for local configuration errors", () => {
    const result = spawnSync(process.execPath, ["scripts/monitor-instance.mjs", "https://private-user:private-secret@private.example", "--cookie-file", "/private/path"], { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('{"ok":false,"issues":["config-invalid"]}\n');
    expect(result.stderr).toBe("");
  });
});
