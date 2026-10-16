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
];
