/**
 * The GitHub App manifest that registers an instance's App, and the paths it
 * points GitHub at. Permissions and events follow the GitHub integration
 * decision: read-only Metadata, Pull requests, Checks and Commit statuses,
 * no organization or account permissions, private to start with.
 */

export const PATHS = {
  signIn: "/auth/sign-in",
  callback: "/auth/callback",
  signOut: "/auth/sign-out",
  setup: "/setup",
  registered: "/setup/registered",
  installed: "/setup/installed",
  webhook: "/api/github/webhook",
  health: "/api/health",
  session: "/api/session",
} as const;

/** GitHub limits App names to 34 characters. */
export const APP_NAME_MAX = 34;

export function validAppName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed.length <= APP_NAME_MAX && !/[\u0000-\u001f]/.test(trimmed);
}

export interface AppManifest {
  readonly name: string;
  readonly url: string;
  readonly hook_attributes?: { readonly url: string; readonly active: boolean };
  readonly redirect_url: string;
  readonly callback_urls: readonly string[];
  readonly setup_url: string;
  readonly setup_on_update: boolean;
  readonly public: boolean;
  readonly request_oauth_on_install: boolean;
  readonly default_permissions: Readonly<Record<string, "read">>;
  readonly default_events?: readonly string[];
}

/** Whether an origin is this machine, which GitHub cannot deliver webhooks to. */
export function isLoopback(origin: URL): boolean {
  const host = origin.hostname;
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    host === "[::1]"
  );
}

export function buildManifest(origin: URL, name: string): AppManifest {
  const base = origin.origin;
  const manifest: AppManifest = {
    name: name.trim(),
    url: base,
    redirect_url: `${base}${PATHS.registered}`,
    callback_urls: [`${base}${PATHS.callback}`],
    setup_url: `${base}${PATHS.installed}`,
    setup_on_update: true,
    public: false,
    request_oauth_on_install: false,
    default_permissions: {
      metadata: "read",
      pull_requests: "read",
      checks: "read",
      statuses: "read",
    },
  };
  // GitHub refuses a manifest whose hook URL it cannot reach, even with the
  // hook inactive, so an App registered from a local development server has
  // no webhook and no event subscriptions. Sign-in needs neither.
  if (isLoopback(origin)) return manifest;
  return {
    ...manifest,
    hook_attributes: { url: `${base}${PATHS.webhook}`, active: true },
    // Installation and authorization events are always delivered and need
    // no subscription.
    default_events: [
      "check_run",
      "check_suite",
      "pull_request",
      "pull_request_review",
      "pull_request_review_comment",
      "repository",
      "status",
    ],
  };
}

/** Where to send the owner to install the App on their account. */
export function installUrl(slug: string): string {
  return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`;
}
