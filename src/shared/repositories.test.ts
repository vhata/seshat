import { describe, expect, it } from "vitest";
import { FIXTURE_REPOSITORY, FIXTURE_OWNER_ID } from "./overview/fixtures";
import { canMonitorRepository, monitoredRepository } from "./repositories";

describe("monitoring rules", () => {
  const ownerId = FIXTURE_OWNER_ID;
  it("defaults only personal, non-fork, non-archived repositories on", () => {
    expect(monitoredRepository(FIXTURE_REPOSITORY, ownerId, false)).toBe(true);
    for (const changes of [{ isFork: true }, { isArchived: true }, { ownerAccountId: 3003 }, { ownerPermission: "none" as const }]) {
      expect(monitoredRepository({ ...FIXTURE_REPOSITORY, ...changes }, ownerId, true)).toBe(false);
    }
  });
  it("honors off, allows opted-in owned forks and accepted orgs, but never archives or inaccessible repositories", () => {
    expect(monitoredRepository({ ...FIXTURE_REPOSITORY, monitorOverride: false }, ownerId, false)).toBe(false);
    expect(monitoredRepository({ ...FIXTURE_REPOSITORY, isFork: true, monitorOverride: true }, ownerId, false)).toBe(true);
    const org = { ...FIXTURE_REPOSITORY, ownerAccountId: 3003, monitorOverride: true };
    expect(monitoredRepository(org, ownerId, false)).toBe(false);
    expect(monitoredRepository(org, ownerId, true)).toBe(true);
    expect(monitoredRepository({ ...org, isArchived: true }, ownerId, true)).toBe(false);
    expect(monitoredRepository({ ...org, ownerPermission: "none" }, ownerId, true)).toBe(false);
  });
  it("disables the switch without accepted installation and owner's read permission", () => {
    const installation = { id: 9, accountId: ownerId, accountType: "User" as const, status: "accepted" as const, repositorySelection: "all" as const };
    const settings = { ownerId, repositories: [FIXTURE_REPOSITORY], installations: [installation] };
    expect(canMonitorRepository(FIXTURE_REPOSITORY, settings)).toBe(true);
    expect(canMonitorRepository(FIXTURE_REPOSITORY, { ...settings, installations: [] })).toBe(false);
    expect(canMonitorRepository({ ...FIXTURE_REPOSITORY, ownerPermission: "none" }, settings)).toBe(false);
    expect(canMonitorRepository({ ...FIXTURE_REPOSITORY, isArchived: true }, settings)).toBe(false);
  });
});
