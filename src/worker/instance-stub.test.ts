import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { INSTANCE_NAME, instanceStub } from "./instance-stub";

describe("instanceStub", () => {
  it("asks for the instance object with the configured location hint", () => {
    const getByName = vi.fn();
    instanceStub({
      INSTANCE: { getByName } as unknown as Env["INSTANCE"],
      INSTANCE_LOCATION_HINT: "wnam",
    });
    expect(getByName).toHaveBeenCalledExactlyOnceWith(INSTANCE_NAME, {
      locationHint: "wnam",
    });
  });

  it("reaches the one named instance object through the real binding", async () => {
    expect(env.INSTANCE_LOCATION_HINT).toBe("wnam");
    const stub = instanceStub(env);
    expect(stub.id.equals(env.INSTANCE.idFromName(INSTANCE_NAME))).toBe(true);
    expect(await stub.health()).toHaveProperty("schemaVersion");
  });
});
