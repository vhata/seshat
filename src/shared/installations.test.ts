import { describe, expect, it } from "vitest";
import { guardInstallations, parseInstallation, type ReportedInstallation, type StoredInstallation } from "./installations";

const OWNER = 1001;

function reported(id: number, accountId: number, accountType: "User" | "Organization"): ReportedInstallation {
  return { id, accountId, accountLogin: `login-${accountId}`, accountType, repositorySelection: "all" };
}

describe("parseInstallation", () => {
  it("reads what the guard needs from GitHub's installation object", () => {
    expect(
      parseInstallation({
        id: 10,
        account: { id: OWNER, login: "the-owner", type: "User" },
        repository_selection: "selected",
        permissions: {},
      }),
    ).toEqual({ id: 10, accountId: OWNER, accountLogin: "the-owner", accountType: "User", repositorySelection: "selected" });
  });

  it("refuses anything malformed", () => {
    for (const value of [
      null,
      { id: 10 },
      { id: "10", account: { id: 1, login: "x", type: "User" }, repository_selection: "all" },
      { id: 10, account: { id: 1, login: "x", type: "Enterprise" }, repository_selection: "all" },
      { id: 10, account: { id: 1, login: "x", type: "User" }, repository_selection: "some" },
    ]) {
      expect(parseInstallation(value)).toBeNull();
    }
  });
});

describe("guardInstallations", () => {
  it("accepts the owner's personal installation, holds organizations and deletes the rest", () => {
    const actions = guardInstallations(
      [reported(1, OWNER, "User"), reported(2, 3003, "Organization"), reported(3, 4004, "User")],
      [],
      OWNER,
    );
    expect(actions.map((action) => [action.kind, action.installation.id])).toEqual([
      ["keep", 1],
      ["keep", 2],
      ["delete", 3],
    ]);
    expect(actions[0]?.kind === "keep" && actions[0].installation.status).toBe("accepted");
    expect(actions[1]?.kind === "keep" && actions[1].installation.status).toBe("pending");
  });

  it("never accepts an organization because its ID equals the owner's", () => {
    const [action] = guardInstallations([reported(1, OWNER, "Organization")], [], OWNER);
    expect(action?.kind === "keep" && action.installation.status).toBe("pending");
  });

  it("keeps an organization the owner accepted earlier", () => {
    const stored: StoredInstallation = {
      id: 2,
      accountId: 3003,
      accountType: "Organization",
      status: "accepted",
      repositorySelection: "all",
    };
    const [action] = guardInstallations([reported(2, 3003, "Organization")], [stored], OWNER);
    expect(action?.kind === "keep" && action.installation.status).toBe("accepted");
  });
});
