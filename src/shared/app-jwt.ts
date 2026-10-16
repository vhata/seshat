/**
 * Signs the JSON Web Tokens that authenticate Seshat as its GitHub App.
 *
 * GitHub issues the App's private key as a PKCS#1 PEM ("BEGIN RSA PRIVATE
 * KEY"), which Web Crypto cannot import. The key is wrapped in a PKCS#8
 * structure here instead, so the owner can paste the key unchanged. A key
 * already in PKCS#8 form is accepted too.
 */

import { base64UrlEncode, utf8 } from "./encoding";

/** DER encoding of a length, short or long form. */
function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

function der(tag: number, content: Uint8Array | number[]): number[] {
  return [tag, ...derLength(content.length), ...content];
}

/** AlgorithmIdentifier for rsaEncryption (1.2.840.113549.1.1.1), NULL parameters. */
const RSA_ALGORITHM = [
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
];

/** Wraps a DER PKCS#1 RSAPrivateKey in a PKCS#8 PrivateKeyInfo (RFC 5208). */
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
  const version = [0x02, 0x01, 0x00];
  const body = [...version, ...RSA_ALGORITHM, ...der(0x04, pkcs1)];
  return new Uint8Array(der(0x30, body));
}

function decodeBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Reads a PEM private key into PKCS#8 DER. Tolerates the escaped `\n`
 * newlines a key picks up when it is pasted into a one-line variable.
 */
export function privateKeyToPkcs8(pem: string): Uint8Array<ArrayBuffer> {
  const normalized = pem.replace(/\\n/g, "\n").trim();
  const match = /^-----BEGIN (RSA PRIVATE KEY|PRIVATE KEY)-----([\s\S]*?)-----END \1-----$/.exec(
    normalized,
  );
  if (!match) throw new Error("the GitHub App private key is not a PEM private key");
  const body = decodeBase64((match[2] ?? "").replace(/\s+/g, ""));
  return match[1] === "RSA PRIVATE KEY" ? pkcs1ToPkcs8(body) : body;
}

export async function importAppKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    privateKeyToPkcs8(pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/**
 * An RS256 JWT for the App, as GitHub specifies: issued 60 seconds in the
 * past to allow for clock drift, expiring 9 minutes later (GitHub allows at
 * most 10), with the App's client ID as issuer.
 */
export async function signAppJwt(
  clientId: string,
  privateKeyPem: string,
  nowSeconds: number,
): Promise<string> {
  const header = base64UrlEncode(utf8(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64UrlEncode(
    utf8(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: clientId })),
  );
  const key = await importAppKey(privateKeyPem);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    utf8(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}
