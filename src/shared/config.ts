/**
 * The instance's deploy-time configuration, read from Worker variables and
 * secrets. Values are set by the owner with `wrangler secret put` (or in
 * `.dev.vars` locally), so any of them may be missing; nothing here trusts
 * the generated `Env` type to say otherwise.
 */

/** Variable and secret names, in the order the owner sets them. */
export const CONFIG_NAMES = {
  ownerId: "OWNER_ID",
  setupSecret: "SETUP_SECRET",
  appSlug: "GITHUB_APP_SLUG",
  clientId: "GITHUB_CLIENT_ID",
  clientSecret: "GITHUB_CLIENT_SECRET",
  privateKey: "GITHUB_PRIVATE_KEY",
  webhookSecret: "GITHUB_WEBHOOK_SECRET",
} as const;

/** The GitHub App's credentials, all present or none. */
export interface AppConfig {
  readonly slug: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** PEM as GitHub issued it (PKCS#1), or PKCS#8. */
  readonly privateKey: string;
  readonly webhookSecret: string;
}

export interface InstanceConfig {
  /** The owner's numeric GitHub account ID, or null if unset or invalid. */
  readonly ownerId: number | null;
  /** The one-time secret that opens the setup page, or null if unset. */
  readonly setupSecret: string | null;
  /** Null until every app credential is set. */
  readonly app: AppConfig | null;
}

/**
 * Parses a GitHub account ID: a positive decimal integer with no sign,
 * leading zeros or surrounding text. Usernames are refused outright, since
 * they can be renamed and reassigned.
 */
export function parseAccountId(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^[1-9][0-9]{0,15}$/.test(trimmed)) return null;
  const id = Number(trimmed);
  return Number.isSafeInteger(id) ? id : null;
}

function text(source: Readonly<Record<string, unknown>>, name: string): string | null {
  const value = source[name];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function readConfig(source: Readonly<Record<string, unknown>>): InstanceConfig {
  const slug = text(source, CONFIG_NAMES.appSlug);
  const clientId = text(source, CONFIG_NAMES.clientId);
  const clientSecret = text(source, CONFIG_NAMES.clientSecret);
  const privateKey = text(source, CONFIG_NAMES.privateKey);
  const webhookSecret = text(source, CONFIG_NAMES.webhookSecret);
  const app =
    slug && clientId && clientSecret && privateKey && webhookSecret
      ? { slug, clientId, clientSecret, privateKey, webhookSecret }
      : null;
  return {
    ownerId: parseAccountId(source[CONFIG_NAMES.ownerId]),
    setupSecret: text(source, CONFIG_NAMES.setupSecret),
    app,
  };
}

/** Whether sign-in can run: the owner and the app are both configured. */
export function signInReady(
  config: InstanceConfig,
): config is InstanceConfig & { ownerId: number; app: AppConfig } {
  return config.ownerId !== null && config.app !== null;
}

/**
 * Whether the registration page is open: only before the app's credentials
 * are set, and only when a setup secret exists to guard it.
 */
export function setupOpen(
  config: InstanceConfig,
): config is InstanceConfig & { setupSecret: string } {
  return config.app === null && config.setupSecret !== null;
}
