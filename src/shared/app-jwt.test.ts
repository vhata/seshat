import { describe, expect, it } from "vitest";
import { privateKeyToPkcs8, signAppJwt } from "./app-jwt";
import { base64UrlDecode, utf8 } from "./encoding";

/** Reads one DER element's header: tag, content start and content length. */
function element(der: Uint8Array, offset: number): { tag: number; start: number; length: number } {
  const tag = der[offset] ?? 0;
  let length = der[offset + 1] ?? 0;
  let start = offset + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    length = 0;
    for (let i = 0; i < count; i++) length = (length << 8) | (der[start + i] ?? 0);
    start += count;
  }
  return { tag, start, length };
}

/** The PKCS#1 key inside a PKCS#8 one, as GitHub would issue it. */
function pkcs8ToPkcs1(pkcs8: Uint8Array): Uint8Array {
  const outer = element(pkcs8, 0);
  const version = element(pkcs8, outer.start);
  const algorithm = element(pkcs8, version.start + version.length);
  const key = element(pkcs8, algorithm.start + algorithm.length);
  expect(key.tag).toBe(0x04);
  return pkcs8.slice(key.start, key.start + key.length);
}

function pem(label: string, der: Uint8Array): string {
  let binary = "";
  for (const byte of der) binary += String.fromCharCode(byte);
  const lines = btoa(binary).match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

async function testKeys() {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  return { pkcs8, pkcs1Pem: pem("RSA PRIVATE KEY", pkcs8ToPkcs1(pkcs8)), publicKey: pair.publicKey };
}

async function verify(jwt: string, publicKey: CryptoKey) {
  const [header = "", payload = "", signature = ""] = jwt.split(".");
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    base64UrlDecode(signature) ?? new Uint8Array(),
    utf8(`${header}.${payload}`),
  );
  const decode = (part: string) => JSON.parse(new TextDecoder().decode(base64UrlDecode(part) ?? new Uint8Array())) as unknown;
  return { valid, header: decode(header), payload: decode(payload) };
}

describe("the App's private key", () => {
  it("is rewrapped from PKCS#1 into the PKCS#8 Web Crypto imports", async () => {
    const { pkcs8, pkcs1Pem } = await testKeys();
    expect(privateKeyToPkcs8(pkcs1Pem)).toEqual(pkcs8);
  });

  it("is accepted with escaped newlines, as pasted into a one-line variable", async () => {
    const { pkcs8, pkcs1Pem } = await testKeys();
    expect(privateKeyToPkcs8(pkcs1Pem.replace(/\n/g, "\\n"))).toEqual(pkcs8);
  });

  it("is accepted in PKCS#8 form as well", async () => {
    const { pkcs8 } = await testKeys();
    expect(privateKeyToPkcs8(pem("PRIVATE KEY", pkcs8))).toEqual(pkcs8);
  });

  it("is refused when it is not a PEM private key", () => {
    expect(() => privateKeyToPkcs8("not a key")).toThrow(/PEM/);
    expect(() => privateKeyToPkcs8("-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----")).toThrow();
  });
});

describe("signAppJwt", () => {
  it("signs an RS256 JWT that GitHub would accept for nine minutes", async () => {
    const { pkcs1Pem, publicKey } = await testKeys();
    const jwt = await signAppJwt("Iv23test", pkcs1Pem, 1_760_000_000);
    const { valid, header, payload } = await verify(jwt, publicKey);
    expect(valid).toBe(true);
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(payload).toEqual({ iat: 1_759_999_940, exp: 1_760_000_540, iss: "Iv23test" });
  });
});
