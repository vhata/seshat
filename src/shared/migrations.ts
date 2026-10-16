/**
 * Schema migrations for the instance's SQLite database, as plain data so the
 * ordering rules can be tested without the Workers runtime.
 */
export interface Migration {
  /** Versions start at 1 and increase by one per migration. */
  readonly version: number;
  readonly statements: readonly string[];
}

/** The newest version a list of migrations brings the schema to. */
export function latestVersion(migrations: readonly Migration[]): number {
  return migrations.at(-1)?.version ?? 0;
}

/**
 * Returns the migrations to apply, in order, to bring a schema at `current`
 * up to date. Throws if the list is not numbered 1, 2, 3 and so on, or if the
 * stored schema is newer than the code knows about.
 */
export function pendingMigrations(
  current: number,
  migrations: readonly Migration[],
): Migration[] {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(
        `migration at position ${index + 1} has version ${migration.version}`,
      );
    }
  });
  if (!Number.isInteger(current) || current < 0) {
    throw new Error(`stored schema version ${current} is not valid`);
  }
  const latest = latestVersion(migrations);
  if (current > latest) {
    throw new Error(
      `stored schema version ${current} is newer than the code's ${latest}`,
    );
  }
  return migrations.slice(current);
}
