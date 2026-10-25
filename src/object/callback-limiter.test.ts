import { describe, expect, it } from "vitest";
import { CallbackLimiter, CALLBACK_CLIENTS } from "./callback-limiter";

describe("callback counters", () => {
  it("limits ten attempts for ten minutes, without extending a blocked window", () => {
    const limiter = new CallbackLimiter();
    for (let i = 0; i < 10; i++) expect(limiter.attempt("a", 1000)).toBe(0);
    expect(limiter.attempt("a", 2000)).toBe(599);
    expect(limiter.attempt("b", 2000)).toBe(0);
    expect(limiter.attempt("a", 600999)).toBe(1);
    expect(limiter.attempt("a", 601000)).toBe(0);
  });
  it("bounds identities without evicting active counters, and reclaims expired slots", () => {
    const limiter = new CallbackLimiter();
    for (let i = 0; i < CALLBACK_CLIENTS; i++) expect(limiter.attempt(String(i), 0)).toBe(0);
    expect(limiter.attempt("overflow", 1)).toBe(600);
    for (let i = 1; i < 10; i++) expect(limiter.attempt("0", 1)).toBe(0);
    expect(limiter.attempt("0", 1)).toBe(600);
    expect(limiter.attempt("overflow", 600000)).toBe(0);
  });
});
