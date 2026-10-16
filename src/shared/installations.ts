/**
 * The installation guard's rules, as pure functions over what GitHub reports
 * about the App's installations.
 *
 * - The installation on the owner's personal account is accepted.
 * - An installation on an organization is held as pending, processing no
 *   data, until the owner accepts it.
 * - Any other installation is deleted on GitHub and never stored.
 *
 * GitHub's setup redirect carries an `installation_id` that anyone can
 * forge, so the guard works only from the App's own list of installations.
 */

export type RepositorySelection = "all" | "selected";

/** One installation as `GET /app/installations` reports it. */
export interface ReportedInstallation {
  readonly id: number;
  readonly accountId: number;
  readonly accountLogin: string;
  readonly accountType: "User" | "Organization";
  readonly repositorySelection: RepositorySelection;
}

export type InstallationStatus = "accepted" | "pending";

/** What the instance keeps about an installation. No logins, no tokens. */
export interface StoredInstallation {
  readonly id: number;
  readonly accountId: number;
  readonly accountType: "User" | "Organization";
  readonly status: InstallationStatus;
  readonly repositorySelection: RepositorySelection;
}

export function parseInstallation(value: unknown): ReportedInstallation | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const account = record.account;
  if (typeof account !== "object" || account === null) return null;
  const { id: accountId, login, type } = account as Record<string, unknown>;
  const { id, repository_selection: selection } = record;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return null;
  if (typeof accountId !== "number" || !Number.isSafeInteger(accountId) || accountId <= 0) {
    return null;
  }
  if (typeof login !== "string") return null;
  if (type !== "User" && type !== "Organization") return null;
  if (selection !== "all" && selection !== "selected") return null;
  return { id, accountId, accountLogin: login, accountType: type, repositorySelection: selection };
}

export type GuardAction =
  | { readonly kind: "keep"; readonly installation: StoredInstallation }
  | { readonly kind: "delete"; readonly installation: ReportedInstallation };

/**
 * Decides what to do with each reported installation. An organization
 * installation the owner has already accepted stays accepted.
 */
export function guardInstallations(
  reported: readonly ReportedInstallation[],
  stored: readonly StoredInstallation[],
  ownerId: number,
): GuardAction[] {
  const previous = new Map(stored.map((installation) => [installation.id, installation]));
  return reported.map((installation): GuardAction => {
    const base = {
      id: installation.id,
      accountId: installation.accountId,
      accountType: installation.accountType,
      repositorySelection: installation.repositorySelection,
    };
    if (installation.accountType === "User" && installation.accountId === ownerId) {
      return { kind: "keep", installation: { ...base, status: "accepted" } };
    }
    if (installation.accountType === "Organization") {
      const status = previous.get(installation.id)?.status === "accepted" ? "accepted" : "pending";
      return { kind: "keep", installation: { ...base, status } };
    }
    return { kind: "delete", installation };
  });
}

export function sameInstallation(a: StoredInstallation, b: StoredInstallation): boolean {
  return (
    a.id === b.id &&
    a.accountId === b.accountId &&
    a.accountType === b.accountType &&
    a.status === b.status &&
    a.repositorySelection === b.repositorySelection
  );
}
