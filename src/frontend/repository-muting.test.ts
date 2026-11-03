import { describe, expect, it, vi } from "vitest";
import { FIXTURE_REPOSITORY } from "../shared/overview/fixtures";
import { setRepositoryMuted } from "./repository-muting";

describe("repository mute requests", () => {
  it("sends the observed owner identity with explicit mute and unmute choices", async () => {
    const request = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", request);
    await setRepositoryMuted(FIXTURE_REPOSITORY, true);
    await setRepositoryMuted(FIXTURE_REPOSITORY, false);
    expect(request.mock.calls).toEqual([true, false].map((muted) => ["/api/repositories/mute", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repositoryId: FIXTURE_REPOSITORY.id, ownerAccountId: FIXTURE_REPOSITORY.ownerAccountId, muted }),
    }]));
  });
  it("reports expired sessions and stale or refused repository choices", async () => {
    for (const status of [401, 403, 404, 500]) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status })));
      await expect(setRepositoryMuted(FIXTURE_REPOSITORY, false)).rejects.toThrow(
        status === 401 ? "Your session ended" : "Could not change muting",
      );
    }
  });
});
