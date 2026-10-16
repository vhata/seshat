import type { Migration } from "../shared/migrations";

/**
 * The instance database's migrations. Append new versions; never edit one
 * that has run on a deployed instance.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    statements: [
      // Instance-wide settings and bookkeeping, one value per key.
      "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT",
    ],
  },
  {
    version: 2,
    statements: [
      // Owner sessions, keyed by the SHA-256 of the cookie value so the
      // table holds nothing a browser could present. Only the owner ever
      // gets a row; nothing is written for a sign-in until the visitor is
      // known to be the owner. Times are milliseconds since the epoch.
      `CREATE TABLE sessions (
        key TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT`,
      // The App's installations that the guard keeps: the owner's personal
      // one, accepted, and organization ones, pending until the owner
      // accepts them. Account IDs only; logins are read live from GitHub.
      `CREATE TABLE installations (
        id INTEGER PRIMARY KEY,
        account_id INTEGER NOT NULL,
        account_type TEXT NOT NULL CHECK (account_type IN ('User', 'Organization')),
        status TEXT NOT NULL CHECK (status IN ('accepted', 'pending')),
        repository_selection TEXT NOT NULL CHECK (repository_selection IN ('all', 'selected'))
      ) STRICT`,
    ],
  },
];
