import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { base64UrlDecode, utf8 } from "../shared/encoding";
import { instanceStub } from "../worker/instance-stub";
import { CLIENT_ID, OWNER_ID, json, noContent, storedRows, stubGitHub } from "../worker/test-helpers";

const LIST = "https://api.github.com/app/installations";
const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

function installation(id: number, accountId: number, type: "User" | "Organization", login: string, selection = "all") {
  return { id, account: { id: accountId, login, type }, repository_selection: selection };
}

const PERSONAL = installation(10, OWNER_ID, "User", "the-owner");
const ORGANIZATION = installation(20, 3003, "Organization", "some-org");
const STRANGER = installation(30, 4004, "User", "stranger");

async function verifyJwt(authorization: string | null): Promise<Record<string, unknown>> {
  const [scheme, jwt = ""] = (authorization ?? "").split(" ");
  expect(scheme).toBe("Bearer");
  const [header = "", payload = "", signature = ""] = jwt.split(".");
  const pem = (env as unknown as Record<string, string>).TEST_APP_PUBLIC_KEY ?? "";
  const der = Uint8Array.from(
    atob(pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "")),
    (char) => char.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey("spki", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
    "verify",
  ]);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlDecode(signature) ?? new Uint8Array(),
    utf8(`${header}.${payload}`),
  );
  expect(valid).toBe(true);
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(payload) ?? new Uint8Array())) as Record<string, unknown>;
}

describe("the installation guard", () => {
  it("lists installations as the App, signed with the configured private key", async () => {
    const github = stubGitHub({ [`GET ${LIST}`]: () => json([PERSONAL]) });
    await instanceStub(env).checkInstallations(NOW);
    const [list] = github.called("GET", LIST);
    const claims = await verifyJwt(list?.headers.get("authorization") ?? null);
    const nowSeconds = NOW / 1000;
    expect(claims).toEqual({ iss: CLIENT_ID, iat: nowSeconds - 60, exp: nowSeconds + 540 });
  });

  it("keeps the owner's installation, holds organizations and deletes strangers'", async () => {
    const github = stubGitHub({
      [`GET ${LIST}`]: () => json([PERSONAL, ORGANIZATION, STRANGER]),
      "DELETE https://api.github.com/app/installations/30": () => noContent(),
    });
    const result = await instanceStub(env).checkInstallations(NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kept.map((kept) => [kept.id, kept.status])).toEqual([
      [10, "accepted"],
      [20, "pending"],
    ]);
    expect(result.deleted.map((deleted) => deleted.id)).toEqual([30]);
    expect(github.called("DELETE", "https://api.github.com/app/installations/30")).toHaveLength(1);

    const rows = await storedRows();
    expect(rows.installations).toEqual([
      { id: 10, account_id: OWNER_ID, account_type: "User", status: "accepted", repository_selection: "all" },
      { id: 20, account_id: 3003, account_type: "Organization", status: "pending", repository_selection: "all" },
    ]);
    // Logins are shown from GitHub's answer, never stored.
    expect(JSON.stringify(rows)).not.toMatch(/the-owner|some-org|stranger/);
  });

  it("does not store a stranger's installation even when GitHub refuses to delete it", async () => {
    stubGitHub({
      [`GET ${LIST}`]: () => json([STRANGER]),
      "DELETE https://api.github.com/app/installations/30": () => json({}, 500),
    });
    const result = await instanceStub(env).checkInstallations(NOW);
    expect(result.ok && result.undeleted.map((item) => item.id)).toEqual([30]);
    expect((await storedRows()).installations).toEqual([]);
  });

  it("does not trust a user installation whose account only shares the owner's login", async () => {
    stubGitHub({
      [`GET ${LIST}`]: () => json([installation(40, 5005, "User", "the-owner")]),
      "DELETE https://api.github.com/app/installations/40": () => noContent(),
    });
    const result = await instanceStub(env).checkInstallations(NOW);
    expect(result.ok && result.deleted.map((item) => item.id)).toEqual([40]);
  });

  it("writes nothing when nothing changed, and forgets uninstalled ones", async () => {
    let listed = [PERSONAL, ORGANIZATION];
    stubGitHub({ [`GET ${LIST}`]: () => json(listed) });
    const stub = instanceStub(env);
    await stub.checkInstallations(NOW);

    const statements = await runInDurableObject(stub, async (instance, state) => {
      const exec = vi.spyOn(state.storage.sql, "exec");
      await instance.checkInstallations(NOW);
      return exec.mock.calls.map(([query]) => query.trimStart());
    });
    for (const statement of statements) expect(statement).toMatch(/^SELECT /);

    listed = [ORGANIZATION];
    await stub.checkInstallations(NOW);
    expect(((await storedRows()).installations as { id: number }[]).map((row) => row.id)).toEqual([20]);
  });

  it("keeps an organization the owner accepted, and records a switch to selected repositories", async () => {
    const stub = instanceStub(env);
    stubGitHub({ [`GET ${LIST}`]: () => json([ORGANIZATION]) });
    await stub.checkInstallations(NOW);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE installations SET status = 'accepted' WHERE id = 20");
    });
    vi.restoreAllMocks();
    stubGitHub({
      [`GET ${LIST}`]: () => json([{ ...ORGANIZATION, repository_selection: "selected" }]),
    });
    await stub.checkInstallations(NOW);
    expect((await storedRows()).installations).toEqual([
      { id: 20, account_id: 3003, account_type: "Organization", status: "accepted", repository_selection: "selected" },
    ]);
  });

  it("changes nothing when the list fills every page it reads", async () => {
    const stub = instanceStub(env);
    stubGitHub({ [`GET ${LIST}`]: () => json([PERSONAL]) });
    await stub.checkInstallations(NOW);
    vi.restoreAllMocks();
    // Every page full of strangers: the list may continue past the last
    // page, so the guard neither deletes nor forgets anything.
    const pages: number[] = [];
    stubGitHub({
      [`GET ${LIST}`]: (call) => {
        const page = Number(call.url.searchParams.get("page"));
        pages.push(page);
        return json(
          Array.from({ length: 100 }, (_, index) => installation(100_000 + page * 100 + index, 9_000 + index, "User", "stranger")),
        );
      },
    });
    expect(await stub.checkInstallations(NOW)).toEqual({ ok: false, reason: "too-many-installations" });
    expect(pages).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(((await storedRows()).installations as { id: number }[]).map((row) => row.id)).toEqual([10]);
  });

  it("changes nothing when GitHub's list fails", async () => {
    stubGitHub({ [`GET ${LIST}`]: () => json({ message: "Bad credentials" }, 401) });
    const stub = instanceStub(env);
    expect(await stub.checkInstallations(NOW)).toEqual({ ok: false, reason: "github-failed" });
  });
});

describe("session storage", () => {
  it("checks a session without writing", async () => {
    const stub = instanceStub(env);
    await stub.createSession("c".repeat(64), NOW, OWNER_ID);
    const statements = await runInDurableObject(stub, async (instance, state) => {
      const exec = vi.spyOn(state.storage.sql, "exec");
      expect(await instance.sessionExpiry("c".repeat(64), NOW + 1)).not.toBeNull();
      expect(await instance.sessionExpiry("d".repeat(64), NOW + 1)).toBeNull();
      await instance.endSession("d".repeat(64));
      return exec.mock.calls.map(([query]) => query.trimStart());
    });
    for (const statement of statements) expect(statement).toMatch(/^SELECT /);
  });
});
