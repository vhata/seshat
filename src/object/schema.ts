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
  {
    version: 3,
    statements: [
      // JSON is an explicit DTO, never a raw PrInput (which contains a Map).
      // Indexed columns support listing/monitoring without decoding every row.
      `CREATE TABLE repositories (
        id INTEGER PRIMARY KEY,
        installation_id INTEGER NOT NULL,
        monitored INTEGER NOT NULL CHECK (monitored IN (0, 1)),
        data TEXT NOT NULL CHECK (json_valid(data))
      ) STRICT`,
      "CREATE INDEX repositories_installation ON repositories (installation_id)",
      `CREATE TABLE pull_requests (
        node_id TEXT PRIMARY KEY,
        repository_id INTEGER NOT NULL,
        data TEXT NOT NULL CHECK (json_valid(data))
      ) STRICT`,
      "CREATE INDEX pull_requests_repository ON pull_requests (repository_id)",
      `CREATE TABLE overview_sync (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data TEXT NOT NULL CHECK (json_valid(data))
      ) STRICT`,
    ],
  },
  {
    version: 4,
    statements: [
      // Legacy sessions cannot prove which owner signed in. Keep the new
      // identity nullable so those rows fail closed until pruned/sign-out.
      "ALTER TABLE sessions ADD COLUMN owner_id INTEGER",
    ],
  },
];
