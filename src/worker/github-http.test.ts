import { describe, expect, it, vi } from "vitest";
import { githubRequest, reportGithubFailure, responseJson, type GithubFailureOperation, type GithubFailureReason } from "./github-http";

const SECRET = "private-token-private-repository-private-upstream-message";

describe("sanitized GitHub diagnostics", () => {
  it("reports failed HTTP status without retaining requests, headers or response bodies", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ message: SECRET }, {
      status: 403, headers: { "x-private": SECRET },
    }));
    const response = await githubRequest(SECRET, `/repos/${SECRET}`, {
      method: "POST", body: SECRET, headers: { "x-private": SECRET },
    });
    expect(response?.status).toBe(403);
    expect(fetch).toHaveBeenCalledOnce();
    expect(warn.mock.calls).toEqual([["seshat.github.failure", { operation: "transport", reason: "http", status: 403 }]]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET);
  });

  it("keeps successful reads and conditional 304s quiet, but reports unexpected 304s", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true }));
    await githubRequest(SECRET, "/anything");
    fetch.mockResolvedValue(new Response(null, { status: 304 }));
    await githubRequest(SECRET, "/anything", { headers: { "if-none-match": SECRET } });
    expect(warn).not.toHaveBeenCalled();
    await githubRequest(SECRET, "/anything");
    expect(warn.mock.calls).toEqual([["seshat.github.failure", { operation: "transport", reason: "http", status: 304 }]]);
  });

  it("reports unexpected 404s and suppresses only the caller's accepted 404", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
    expect((await githubRequest(SECRET, "/anything", {}, { expectedStatus: 404 }))?.status).toBe(404);
    expect(warn).not.toHaveBeenCalled();
    expect((await githubRequest(SECRET, "/anything"))?.status).toBe(404);
    expect(warn.mock.calls).toEqual([["seshat.github.failure", { operation: "transport", reason: "http", status: 404 }]]);
    warn.mockClear();
    fetch.mockResolvedValue(new Response(null, { status: 503 }));
    await githubRequest(SECRET, "/anything", {}, { expectedStatus: 404 });
    expect(warn.mock.calls).toEqual([["seshat.github.failure", { operation: "transport", reason: "http", status: 503 }]]);
  });

  it("classifies rejection using its own timeout signal rather than exception names", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockRejectedValue({ name: "TimeoutError", message: SECRET });
    expect(await githubRequest(SECRET, "/anything")).toBeNull();
    expect(warn.mock.calls).toEqual([["seshat.github.failure", { operation: "transport", reason: "network" }]]);
    warn.mockClear();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort());
    expect(await githubRequest(SECRET, "/anything")).toBeNull();
    expect(warn.mock.calls).toEqual([["seshat.github.failure", { operation: "transport", reason: "timeout" }]]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET);
  });

  it("reports unreadable JSON without its text and preserves null/success semantics", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await responseJson(null)).toBeNull();
    expect(await responseJson(Response.json({ ok: true }))).toEqual({ ok: true });
    expect(warn).not.toHaveBeenCalled();
    expect(await responseJson(new Response(SECRET, { status: 502 }))).toBeNull();
    expect(warn.mock.calls).toEqual([["seshat.github.failure", { operation: "response-json", reason: "invalid-json", status: 502 }]]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET);
  });

  it("rejects arbitrary runtime vocabulary, unsafe statuses and attempt values", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    reportGithubFailure(SECRET as GithubFailureOperation, SECRET as GithubFailureReason,
      NaN, { attempt: SECRET as unknown as 1 });
    reportGithubFailure("sync-count", "github-unavailable", 503, { attempt: 2 });
    for (const status of [99, 600, 403.5, Infinity]) reportGithubFailure("transport", "http", status);
    expect(warn.mock.calls).toEqual([
      ["seshat.github.failure", { operation: "unknown", reason: "unexpected" }],
      ["seshat.github.failure", { operation: "sync-count", reason: "github-unavailable", status: 503, attempt: 2 }],
      ...Array.from({ length: 4 }, () => ["seshat.github.failure", { operation: "transport", reason: "http" }]),
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET);
  });
});
