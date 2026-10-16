/**
 * The pages the Worker renders itself: sign-in outcomes and setup. They are
 * plain HTML with inline styles and no script, served with a strict content
 * security policy, and never cached. None of them shows instance data
 * unless the request carried the owner's session.
 */

import { html, SafeHtml } from "../shared/html";

const STYLE = `
:root { color-scheme: dark; font-family: system-ui, sans-serif; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center;
  background: #111820; color: #d9e1ea; }
main { max-width: 40rem; padding: 2rem; text-align: center; }
main.wide { text-align: left; }
h1 { font-size: 1.4rem; margin: 0 0 1rem; }
p { line-height: 1.5; color: #a9b6c4; }
code, pre { font-family: ui-monospace, monospace; color: #e8eef5; }
pre { text-align: left; background: #0b1016; border: 1px solid #2a3542;
  border-radius: 6px; padding: 1rem; overflow-x: auto; white-space: pre-wrap;
  word-break: break-all; }
a.button, button { display: inline-block; font: inherit; font-weight: 600;
  padding: 0.6rem 1.4rem; border-radius: 6px; border: 1px solid #2a3542;
  background: #7cc4f8; color: #0b1016; text-decoration: none; cursor: pointer; }
input { font: inherit; padding: 0.5rem; border-radius: 6px; border: 1px solid #2a3542;
  background: #0b1016; color: inherit; width: 100%; box-sizing: border-box; }
label { display: block; text-align: left; margin: 1rem 0 0.3rem; }
.warning { color: #f5c26b; }
`;

/** Security headers for every Worker-rendered page. */
export const PAGE_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  // Inline styles only, no script, and forms may post only here or to
  // GitHub (the App manifest).
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self' https://github.com; base-uri 'none'; frame-ancestors 'none'",
  // The callback URL carries an authorization code; never send it onwards.
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

export function page(
  title: string,
  body: SafeHtml,
  init: { status?: number; headers?: HeadersInit; wide?: boolean } = {},
): Response {
  const document = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} - Seshat</title>
<style>${new SafeHtml(STYLE)}</style>
</head>
<body><main${init.wide ? html` class="wide"` : html``}>${body}</main></body>
</html>`;
  const headers = new Headers(PAGE_HEADERS);
  new Headers(init.headers).forEach((value, name) => headers.append(name, value));
  return new Response(document.value, { status: init.status ?? 200, headers });
}

/**
 * Shown when an account other than the owner's completes GitHub sign-in.
 * It names only the visitor's own login, from the `GET /user` response, and
 * says whether Seshat removed its authorization from their account.
 */
export function refusedPage(login: string, grantDeleted: boolean): Response {
  return page(
    "Access not allowed",
    html`<h1>Access not allowed</h1>
<p>You're signed in to GitHub as <code>@${login}</code>. This instance is private to its owner.</p>
${
  grantDeleted
    ? html`<p>Seshat has removed its authorization from your GitHub account and kept nothing about you.</p>`
    : html`<p class="warning">Seshat could not remove its authorization from your GitHub account. You can revoke it under Settings, Applications, Authorized GitHub Apps. Seshat kept nothing about you.</p>`
}
<p><a href="https://github.com/logout">Sign out of GitHub</a></p>`,
    { status: 403 },
  );
}

export function signInFailedPage(reason: string, status = 400): Response {
  return page(
    "Sign-in failed",
    html`<h1>Sign-in did not complete</h1>
<p>${reason}</p>
<p><a class="button" href="/auth/sign-in">Try again</a></p>`,
    { status },
  );
}

export function notSetUpPage(): Response {
  return page(
    "Not set up",
    html`<h1>This instance is not set up yet</h1>
<p>Its owner has not finished registering its GitHub App, so nobody can sign in.</p>`,
    { status: 503 },
  );
}
