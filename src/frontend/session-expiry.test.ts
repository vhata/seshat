import { describe, expect, it, vi } from "vitest";
import { watchSessionExpiry } from "./session-expiry";

function harness(expiresAt: number, clockSkew = 0) {
  let now = clockSkew;
  let timer = () => {};
  let visibility = () => {};
  const expired = vi.fn();
  const cancelTimer = vi.fn();
  const cancelVisibility = vi.fn();
  const delays: number[] = [];
  const stop = watchSessionExpiry({ expiresAt, serverTime: 0 }, expired, {
    clock: () => now,
    later: (callback, delay) => {
      timer = callback;
      delays.push(delay);
      return cancelTimer;
    },
    onVisibility: (callback) => {
      visibility = callback;
      return cancelVisibility;
    },
  });
  return {
    expired, stop, delays, cancelTimer, cancelVisibility,
    time: (value: number) => { now = value; },
    timer: () => timer(),
    visibility: () => visibility(),
  };
}

describe("session expiry", () => {
  it("expires a quiet page and ignores late callbacks after expiry", () => {
    const h = harness(60_000);
    expect(h.delays).toEqual([60_000]);
    h.time(60_000);
    h.timer();
    expect(h.expired).toHaveBeenCalledOnce();
    expect(h.cancelTimer).toHaveBeenCalled();
    expect(h.cancelVisibility).toHaveBeenCalledOnce();
    h.visibility();
    h.timer();
    expect(h.expired).toHaveBeenCalledOnce();
  });
  it("catches expiry on visibility after a suspended timer and cancels on unmount", () => {
    const h = harness(60_000);
    h.time(90_000);
    h.visibility();
    expect(h.expired).toHaveBeenCalledOnce();
    const unmounted = harness(60_000);
    unmounted.stop();
    unmounted.time(90_000);
    unmounted.timer();
    unmounted.visibility();
    expect(unmounted.expired).not.toHaveBeenCalled();
  });
  it("clamps long timers and rechecks the clock rather than expiring early", () => {
    const h = harness(30 * 86_400_000);
    expect(h.delays).toEqual([2_147_483_647]);
    h.time(2_147_483_647);
    h.timer();
    expect(h.expired).not.toHaveBeenCalled();
    expect(h.delays.at(-1)).toBe(30 * 86_400_000 - 2_147_483_647);
    h.time(30 * 86_400_000);
    h.timer();
    expect(h.expired).toHaveBeenCalledOnce();
  });
  it.each([-9_000_000, 9_000_000])("corrects browser clock skew of %s milliseconds", (skew) => {
    const h = harness(60_000, skew);
    expect(h.delays).toEqual([60_000]);
    h.time(skew + 60_000);
    h.visibility();
    expect(h.expired).toHaveBeenCalledOnce();
  });
});
