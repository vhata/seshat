import { describe, expect, it } from "vitest";
import { clearCookie, parseCookies, readCookie, serializeCookie } from "./cookies";

describe("cookies", () => {
  it("parse the Cookie header, keeping the first of duplicate names", () => {
    const cookies = parseCookies("a=1; b=two; a=3;  c = x=y ");
    expect([...cookies]).toEqual([
      ["a", "1"],
      ["b", "two"],
      ["c", "x=y"],
    ]);
    expect(parseCookies(null).size).toBe(0);
  });

  it("use the __Host- prefix and Secure over HTTPS", () => {
    expect(serializeCookie("seshat-session", "abc", { secure: true, maxAge: 60 })).toBe(
      "__Host-seshat-session=abc; Path=/; Max-Age=60; HttpOnly; SameSite=Lax; Secure",
    );
  });

  it("drop both over plain HTTP, for local development", () => {
    expect(serializeCookie("seshat-session", "abc", { secure: false, maxAge: 60 })).toBe(
      "seshat-session=abc; Path=/; Max-Age=60; HttpOnly; SameSite=Lax",
    );
  });

  it("are cleared with an empty value and no lifetime", () => {
    expect(clearCookie("seshat-session", true)).toBe(
      "__Host-seshat-session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure",
    );
  });

  it("refuse values that would need quoting", () => {
    expect(() => serializeCookie("x", "a;b", { secure: true, maxAge: 1 })).toThrow();
  });

  it("are read only under the name for the scheme in use", () => {
    expect(readCookie("__Host-x=1; x=2", "x", true)).toBe("1");
    expect(readCookie("__Host-x=1; x=2", "x", false)).toBe("2");
    expect(readCookie("x=2", "x", true)).toBeNull();
  });
});
