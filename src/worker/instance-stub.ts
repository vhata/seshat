import type { InstanceObject } from "../object/instance";

/** Every instance keeps its state in one object with this name. */
export const INSTANCE_NAME = "instance";

/**
 * The stub for the instance's Durable Object. Routes reach the object only
 * through this, so none can skip the location hint, which is honoured only on
 * the object's first request.
 */
export function instanceStub(
  env: Pick<Env, "INSTANCE" | "INSTANCE_LOCATION_HINT">,
): DurableObjectStub<InstanceObject> {
  return env.INSTANCE.getByName(INSTANCE_NAME, {
    locationHint: env.INSTANCE_LOCATION_HINT,
  });
}
