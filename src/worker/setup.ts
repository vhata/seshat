/**
 * Registering and installing the instance's GitHub App.
 *
 * Registration uses GitHub's manifest flow and is open only while the App's
 * credentials are not yet configured, and only to someone who knows the
 * one-time setup secret set at deploy time; otherwise a stranger who found
 * an unconfigured instance could attach their own App to it. GitHub hands
 * the credentials to the instance, which shows them once for the owner to
 * store as Worker secrets: the instance itself never stores them.
 *
 * Installation lands on `/setup/installed`, which needs the owner's session
 * and runs the installation guard against GitHub's own list of the App's
 * installations, never the spoofable `installation_id` in the redirect.
 */

import { CONFIG_NAMES, setupOpen } from "../shared/config";
import { clearCookie, readCookie, serializeCookie } from "../shared/cookies";
import { randomToken, secretsEqual } from "../shared/encoding";
import { html, type SafeHtml } from "../shared/html";
import { APP_NAME_MAX, PATHS, buildManifest, installUrl, isLoopback, validAppName } from "../shared/manifest";
import { type RouteContext } from "./context";
import { instanceStub } from "./instance-stub";
import { GITHUB_WEB, convertManifest } from "./github";
import { page } from "./pages";

const SETUP_COOKIE = "seshat-setup";
/** GitHub's manifest codes expire after an hour. */
const SETUP_COOKIE_SECONDS = 60 * 60;

function setupClosed(context: RouteContext): Response {
  if (context.config.app !== null) {
    return page(
      "Setup finished",
      html`<h1>Setup is finished</h1><p>This instance's GitHub App is configured.</p>`,
      { status: 404 },
    );
  }
  return page(
    "Setup locked",
    html`<h1>Setup is locked</h1>
<p>Set the <code>${CONFIG_NAMES.setupSecret}</code> secret on this instance to open setup.</p>`,
    { status: 503 },
  );
}

/** `GET /setup`: ask for the setup secret and the App's name. */
export async function setupForm(context: RouteContext): Promise<Response> {
  if (!setupOpen(context.config)) return setupClosed(context);
  return setupFormPage();
}

function setupFormPage(error?: string, status = 200): Response {
  return page(
    "Register the GitHub App",
    html`<h1>Register this instance's GitHub App</h1>
<p>GitHub will show a prefilled registration for a private App with read-only access to metadata, pull requests, checks and commit statuses.</p>
${error ? html`<p class="warning">${error}</p>` : html``}
<form method="post" action="${PATHS.setup}">
<label for="secret">Setup secret</label>
<input id="secret" name="secret" type="password" autocomplete="off" required>
<label for="name">App name (unique on GitHub, at most ${APP_NAME_MAX} characters)</label>
<input id="name" name="name" maxlength="${APP_NAME_MAX}" placeholder="Seshat for your-login" required>
<p><button type="submit">Continue</button></p>
</form>`,
    // The form posts back here, so the browser must send the real Origin.
    { status, wide: true, referrerPolicy: "same-origin" },
  );
}

/** `POST /setup`: check the secret, then hand the manifest to GitHub. */
export async function startRegistration(context: RouteContext): Promise<Response> {
  const { config, request, url, secure } = context;
  if (!setupOpen(config)) return setupClosed(context);
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return setupFormPage("The form could not be read.", 400);
  }
  const secret = form.get("secret");
  const name = form.get("name");
  if (typeof secret !== "string" || !(await secretsEqual(secret, config.setupSecret))) {
    return setupFormPage("That is not this instance's setup secret.", 403);
  }
  if (typeof name !== "string" || !validAppName(name)) {
    return setupFormPage(`Give the App a name of 1 to ${APP_NAME_MAX} characters.`, 400);
  }
  const state = randomToken(32);
  const manifest = buildManifest(url, name);
  const action = `${GITHUB_WEB}/settings/apps/new?state=${encodeURIComponent(state)}`;
  return page(
    "Continue to GitHub",
    html`<h1>Continue on GitHub</h1>
<p>GitHub will ask you to confirm the App <code>${manifest.name}</code>, then send you back here with its credentials.</p>
${
  isLoopback(url)
    ? html`<p class="warning">This instance runs on this machine, which GitHub cannot reach, so the App's webhook starts inactive. Sign-in works without it.</p>`
    : html``
}
<form method="post" action="${action}">
<input type="hidden" name="manifest" value="${JSON.stringify(manifest)}">
<p><button type="submit">Continue to GitHub</button></p>
</form>`,
    {
      wide: true,
      // The form posts to GitHub; send it the instance's origin only.
      referrerPolicy: "strict-origin",
      headers: {
        "set-cookie": serializeCookie(SETUP_COOKIE, state, { secure, maxAge: SETUP_COOKIE_SECONDS }),
      },
    },
  );
}

/**
 * `GET /setup/registered`: exchange GitHub's code for the App's
 * credentials and show them once.
 */
export async function finishRegistration(context: RouteContext): Promise<Response> {
  const { config, request, url, secure } = context;
  if (!setupOpen(config)) return setupClosed(context);
  const cookieState = readCookie(request.headers.get("cookie"), SETUP_COOKIE, secure);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const clear = { "set-cookie": clearCookie(SETUP_COOKIE, secure) };
  if (cookieState === null || state === null || !(await secretsEqual(state, cookieState))) {
    return page(
      "Setup expired",
      html`<h1>This registration did not start here</h1>
<p>Start again from <a href="${PATHS.setup}">setup</a>.</p>`,
      { status: 400, headers: clear },
    );
  }
  if (code === null || !/^[A-Za-z0-9_-]{1,100}$/.test(code)) {
    return page("Setup failed", html`<h1>GitHub sent no registration code</h1>`, {
      status: 400,
      headers: clear,
    });
  }
  const credentials = await convertManifest(code);
  if (credentials === null) {
    return page(
      "Setup failed",
      html`<h1>GitHub did not return the App's credentials</h1>
<p>The code may have expired or been used already. If GitHub created the App, delete it under Settings, Developer settings, GitHub Apps, then start again from <a href="${PATHS.setup}">setup</a>.</p>`,
      { status: 502, headers: clear },
    );
  }

  const webhookSecret = credentials.webhookSecret ?? randomToken(32);
  const values: [string, string][] = [
    [CONFIG_NAMES.appSlug, credentials.slug],
    [CONFIG_NAMES.clientId, credentials.clientId],
    [CONFIG_NAMES.clientSecret, credentials.clientSecret],
    [CONFIG_NAMES.privateKey, credentials.pem],
    [CONFIG_NAMES.webhookSecret, webhookSecret],
  ];
  if (config.ownerId === null && credentials.ownerId !== null) {
    values.unshift([CONFIG_NAMES.ownerId, String(credentials.ownerId)]);
  }
  const bulk = JSON.stringify(Object.fromEntries(values), null, 2);
  const devVars = values.map(([name, value]) => `${name}=${JSON.stringify(value)}`).join("\n");

  const notes: SafeHtml[] = [];
  if (credentials.ownerId !== null && config.ownerId !== null && credentials.ownerId !== config.ownerId) {
    notes.push(
      html`<p class="warning">The App belongs to account ${credentials.ownerId}${credentials.ownerLogin ? html` (<code>@${credentials.ownerLogin}</code>)` : html``}, but <code>${CONFIG_NAMES.ownerId}</code> is ${config.ownerId}. Only account ${config.ownerId} will be able to sign in.</p>`,
    );
  }
  if (config.ownerId === null && credentials.ownerId !== null) {
    notes.push(
      html`<p><code>${CONFIG_NAMES.ownerId}</code> is not set, so the values below include the ID of the account that registered the App${credentials.ownerLogin ? html`, <code>@${credentials.ownerLogin}</code>` : html``}. Only that account will be able to sign in.</p>`,
    );
  }
  if (credentials.webhookSecret === null) {
    notes.push(
      html`<p class="warning">GitHub created the App without a webhook secret, so Seshat generated one. When you activate the App's webhook, set this same secret in the App's settings on GitHub.</p>`,
    );
  }

  return page(
    "Store the App's credentials",
    html`<h1>Store these credentials now</h1>
<p>GitHub registered the App <a href="https://github.com/settings/apps/${encodeURIComponent(credentials.slug)}"><code>${credentials.slug}</code></a>. This page is the only time Seshat shows its credentials, and it keeps no copy. Setup closes once they are set.</p>
${notes}
<p>For a deployed instance, save this JSON to a file outside the repository, run <code>npx wrangler secret bulk &lt;file&gt;</code> (one deploy for all of them), then delete the file:</p>
<pre>${bulk}</pre>
<p>For local development, add these lines to <code>.dev.vars</code> and restart <code>npm run dev</code>:</p>
<pre>${devVars}</pre>
<p>Then install the App on your personal account with <strong>All repositories</strong>, which lets repositories created later be monitored without any action from you:</p>
<p><a class="button" href="${installUrl(credentials.slug)}">Install the App</a></p>`,
    { wide: true, headers: clear },
  );
}

/** `GET /setup/installed`: the installation guard, for the signed-in owner. */
export async function checkInstallation(context: RouteContext): Promise<Response> {
  const { config, env, now } = context;
  const result = await instanceStub(env).checkInstallations(now);
  if (!result.ok) {
    const reason =
      result.reason === "not-configured"
        ? "The App's credentials are not fully configured on this instance."
        : "GitHub did not list the App's installations. Try again shortly.";
    return page("Installation", html`<h1>Installation not checked</h1><p>${reason}</p>`, {
      status: result.reason === "not-configured" ? 503 : 502,
    });
  }
  const personal = result.kept.find(
    (installation) => installation.accountType === "User" && installation.status === "accepted",
  );
  const organizations = result.kept.filter((installation) => installation.accountType === "Organization");
  const slug = config.app?.slug;
  return page(
    "Installation",
    html`<h1>GitHub App installation</h1>
${
  personal
    ? html`<p>Installed on your account <code>@${personal.accountLogin}</code>.</p>
${
  personal.repositorySelection === "selected"
    ? html`<p class="warning">The installation covers only selected repositories, so repositories you create later will not be monitored. Switch it to All repositories in the installation's settings on GitHub.</p>`
    : html`<p>It covers all repositories, including ones you create later.</p>`
}`
    : html`<p class="warning">The App is not installed on your personal account yet.</p>
${slug ? html`<p><a class="button" href="${installUrl(slug)}">Install the App</a></p>` : html``}`
}
${
  organizations.length > 0
    ? html`<p>Organization installations, held as pending, which process no data until you accept them:</p>
<ul>${organizations.map((installation) => html`<li><code>${installation.accountLogin}</code>: ${installation.status}</li>`)}</ul>`
    : html``
}
${
  result.deleted.length > 0
    ? html`<p>Removed installations on accounts other than yours: ${result.deleted.map((installation) => html`<code>${installation.accountLogin}</code> `)}</p>`
    : html``
}
${
  result.undeleted.length > 0
    ? html`<p class="warning">GitHub refused to remove installations on other accounts: ${result.undeleted.map((installation) => html`<code>${installation.accountLogin}</code> `)}. Seshat ignores them.</p>`
    : html``
}
<p><a href="/">Back to Seshat</a></p>`,
    { wide: true },
  );
}
