import { describe, expect, it, vi } from "vitest";
import { FIXTURE_NOW, FIXTURE_REPOSITORY } from "../shared/overview/fixtures";
import type { CheckAttempt } from "../shared/overview/protocol";
import { repositoryRefreshAttempt, requestRepositoryRefresh } from "./repository-refresh";

const receipt: CheckAttempt = { id: 8, startedAt: FIXTURE_NOW, result: "queued" };

describe("repository refresh requests", () => {
  it("requests only the selected repository and its observed owner and returns a work receipt", async () => {
    const request = vi.fn(async () => Response.json({ ok: true, attempt: receipt }, { status: 202 }));
    vi.stubGlobal("fetch", request);
    expect(await requestRepositoryRefresh(FIXTURE_REPOSITORY)).toEqual(receipt);
    expect(request.mock.calls).toEqual([["/api/repositories/refresh-one", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repositoryId: FIXTURE_REPOSITORY.id, ownerAccountId: FIXTURE_REPOSITORY.ownerAccountId }),
    }]]);
  });

  it("reports refused requests and expired sessions without claiming work completed", async () => {
    for (const status of [401, 403, 404, 500]) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status })));
      await expect(requestRepositoryRefresh(FIXTURE_REPOSITORY)).rejects.toThrow(
        status === 401 ? "Your session ended" : status === 403 || status === 404
          ? "cannot be refreshed" : "Could not confirm",
      );
    }
  });

  it("treats transport and malformed acknowledgments as unknown outcomes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("connection lost"); }));
    await expect(requestRepositoryRefresh(FIXTURE_REPOSITORY)).rejects.toThrow("Could not confirm the refresh request");
    for (const value of [{ ok: true }, { ok: true, attempt: { ...receipt, id: -1 } }, { ok: true, attempt: null }, { ok: false, attempt: receipt }]) {
      vi.stubGlobal("fetch", vi.fn(async () => Response.json(value)));
      await expect(requestRepositoryRefresh(FIXTURE_REPOSITORY)).rejects.toThrow("Could not confirm the refresh request");
    }
  });

  it("waits for the acknowledged work rather than accepting an older completion", () => {
    const old = { ...receipt, id: 7, result: "success" as const };
    expect(repositoryRefreshAttempt(receipt, old)).toEqual(receipt);
    expect(repositoryRefreshAttempt(receipt, null)).toEqual(receipt);
    const running = { ...receipt, result: "running" as const };
    expect(repositoryRefreshAttempt(receipt, running)).toEqual(running);
    expect(repositoryRefreshAttempt(running, receipt)).toEqual(running);
    const complete = { ...receipt, result: "success" as const };
    expect(repositoryRefreshAttempt(receipt, complete)).toEqual(complete);
    expect(repositoryRefreshAttempt(complete, running)).toEqual(complete);
    const newer = { ...receipt, id: 9 };
    expect(repositoryRefreshAttempt(receipt, newer)).toEqual(newer);
    expect(repositoryRefreshAttempt(null, complete)).toEqual(complete);
  });
});
