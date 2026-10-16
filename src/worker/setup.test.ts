import { exports } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PATHS } from "../shared/manifest";
import { BASE, OWNER_ID, fetchWithConfig, json, ownerSession, setCookie, storedRows, stubGitHub } from "./test-helpers";

/** An instance that has its owner and setup secret but no App yet. */
const UNCONFIGURED = { OWNER_ID: String(OWNER_ID), SETUP_SECRET: "test-setup-secret" };
const SETUP_COOKIE = "__Host-seshat-setup";
const CONVERSION = "https://api.github.com/app-manifests/manifest-code/conversions";
const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEAfake\n-----END RSA PRIVATE KEY-----\n";

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

function unescapeHtml(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function postSetup(form: Record<string, string>, headers: Record<string, string> = { origin: BASE }) {
  return fetchWithConfig(UNCONFIGURED, PATHS.setup, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(form).toString(),
  });
}

describe("registration", () => {
  it("is closed once the App is configured", async () => {
    stubGitHub({});
    for (const path of [PATHS.setup, `${PATHS.registered}?code=x&state=y`]) {
      const response = await exports.default.fetch(`${BASE}${path}`);
      expect(response.status).toBe(404);
    }
  });

  it("stays locked without a setup secret", async () => {
    const response = await fetchWithConfig({ OWNER_ID: String(OWNER_ID) }, PATHS.setup);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("<form");
  });

  it("asks for the setup secret", async () => {
    const response = await fetchWithConfig(UNCONFIGURED, PATHS.setup);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toContain('name="secret"');
  });

  it("refuses the wrong setup secret", async () => {
    const response = await postSetup({ secret: "guess", name: "Seshat test" });
    expect(response.status).toBe(403);
    expect(setCookie(response, SETUP_COOKIE)).toBeNull();
    expect(await response.text()).not.toContain("manifest");
  });

  it("refuses a cross-site form post", async () => {
    const response = await postSetup(
      { secret: "test-setup-secret", name: "Seshat test" },
      { origin: "https://evil.example" },
    );
    expect(response.status).toBe(403);
  });

  it("hands GitHub a manifest for a private, read-only App", async () => {
    const response = await postSetup({ secret: "test-setup-secret", name: "Seshat test" });
    expect(response.status).toBe(200);
    const page = await response.text();
    const state = setCookie(response, SETUP_COOKIE)?.value ?? "";
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(page).toContain(`action="https://github.com/settings/apps/new?state=${state}"`);

    const manifestValue = /name="manifest" value="([^"]*)"/.exec(page)?.[1] ?? "";
    expect(JSON.parse(unescapeHtml(manifestValue))).toEqual({
      name: "Seshat test",
      url: BASE,
      hook_attributes: { url: `${BASE}/api/github/webhook`, active: true },
      redirect_url: `${BASE}/setup/registered`,
      callback_urls: [`${BASE}/auth/callback`],
      setup_url: `${BASE}/setup/installed`,
      setup_on_update: true,
      public: false,
      request_oauth_on_install: false,
      default_permissions: { metadata: "read", pull_requests: "read", checks: "read", statuses: "read" },
      default_events: [
        "check_run",
        "check_suite",
        "pull_request",
        "pull_request_review",
        "pull_request_review_comment",
        "repository",
        "status",
      ],
    });
  });

  it("refuses GitHub's redirect when the state is not this browser's", async () => {
    const github = stubGitHub({});
    const response = await fetchWithConfig(UNCONFIGURED, `${PATHS.registered}?code=manifest-code&state=forged`, {
      headers: { cookie: `${SETUP_COOKIE}=${"B".repeat(43)}` },
    });
    expect(response.status).toBe(400);
    expect(github.calls).toEqual([]);
  });

  it("shows the App's credentials once and stores none of them", async () => {
    const github = stubGitHub({
      [`POST ${CONVERSION}`]: () =>
        json(
          {
            id: 77,
            slug: "seshat-test",
            client_id: "Iv23new",
            client_secret: "new-client-secret",
            webhook_secret: "new-webhook-secret",
            pem: PEM,
            owner: { id: OWNER_ID, login: "the-owner" },
          },
          201,
        ),
    });
    const started = await postSetup({ secret: "test-setup-secret", name: "Seshat test" });
    const state = setCookie(started, SETUP_COOKIE)?.value ?? "";
    const response = await fetchWithConfig(UNCONFIGURED, `${PATHS.registered}?code=manifest-code&state=${state}`, {
      headers: { cookie: `${SETUP_COOKIE}=${state}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(setCookie(response, SETUP_COOKIE)?.attributes).toMatch(/Max-Age=0/);
    expect(github.called("POST", CONVERSION)).toHaveLength(1);
    const page = unescapeHtml(await response.text());
    for (const value of ["GITHUB_CLIENT_ID", "Iv23new", "new-client-secret", "new-webhook-secret", "seshat-test"]) {
      expect(page).toContain(value);
    }
    expect(page).toContain("https://github.com/apps/seshat-test/installations/new");
    // OWNER_ID was already set, so it is not repeated.
    expect(page).not.toContain('"OWNER_ID"');

    const dump = JSON.stringify(await storedRows());
    for (const secret of ["new-client-secret", "new-webhook-secret", "MIIEpAIBAAKCAQEAfake"]) {
      expect(dump).not.toContain(secret);
    }
  });

  it("warns when the App belongs to an account other than the configured owner", async () => {
    stubGitHub({
      [`POST ${CONVERSION}`]: () =>
        json(
          {
            id: 77,
            slug: "seshat-test",
            client_id: "Iv23new",
            client_secret: "s",
            webhook_secret: "w",
            pem: PEM,
            owner: { id: 9999, login: "someone-else" },
          },
          201,
        ),
    });
    const started = await postSetup({ secret: "test-setup-secret", name: "Seshat test" });
    const state = setCookie(started, SETUP_COOKIE)?.value ?? "";
    const response = await fetchWithConfig(UNCONFIGURED, `${PATHS.registered}?code=manifest-code&state=${state}`, {
      headers: { cookie: `${SETUP_COOKIE}=${state}` },
    });
    expect(await response.text()).toContain("Only account 1001 will be able to sign in");
  });

  it("explains when GitHub will not convert the code", async () => {
    stubGitHub({ [`POST ${CONVERSION}`]: () => json({ message: "Not Found" }, 404) });
    const started = await postSetup({ secret: "test-setup-secret", name: "Seshat test" });
    const state = setCookie(started, SETUP_COOKIE)?.value ?? "";
    const response = await fetchWithConfig(UNCONFIGURED, `${PATHS.registered}?code=manifest-code&state=${state}`, {
      headers: { cookie: `${SETUP_COOKIE}=${state}` },
    });
    expect(response.status).toBe(502);
  });
});

describe("sign-in on an instance that is not set up", () => {
  it("says so instead of sending the visitor to GitHub", async () => {
    const response = await fetchWithConfig(UNCONFIGURED, PATHS.signIn, { redirect: "manual" });
    expect(response.status).toBe(503);
    expect(response.headers.get("location")).toBeNull();
  });

  it("refuses everyone when the owner ID is not a number", async () => {
    const response = await fetchWithConfig(
      {
        OWNER_ID: "the-owner",
        GITHUB_APP_SLUG: "s",
        GITHUB_CLIENT_ID: "c",
        GITHUB_CLIENT_SECRET: "c",
        GITHUB_PRIVATE_KEY: "k",
        GITHUB_WEBHOOK_SECRET: "w",
      },
      PATHS.signIn,
      { redirect: "manual" },
    );
    expect(response.status).toBe(503);
  });
});

describe("GET /setup/installed", () => {
  it("runs the installation guard for the signed-in owner", async () => {
    stubGitHub({
      "GET https://api.github.com/app/installations": () =>
        json([
          {
            id: 10,
            account: { id: OWNER_ID, login: "the-owner", type: "User" },
            repository_selection: "selected",
          },
        ]),
    });
    const cookie = await ownerSession();
    // GitHub's redirect carries an installation_id, which is ignored.
    const response = await exports.default.fetch(`${BASE}${PATHS.installed}?installation_id=99&setup_action=install`, {
      headers: { cookie },
    });
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain("@the-owner");
    expect(page).toContain("only selected repositories");
    expect(page).not.toContain("99");
  });

  it("offers the install link when the App is not installed on the owner's account", async () => {
    stubGitHub({ "GET https://api.github.com/app/installations": () => json([]) });
    const cookie = await ownerSession();
    const response = await exports.default.fetch(`${BASE}${PATHS.installed}`, { headers: { cookie } });
    expect(await response.text()).toContain("https://github.com/apps/seshat-test/installations/new");
  });
});
