import { describe, expect, it } from "vitest";

import {
  adminTabIds,
  canGrantRole,
  canManagePosition,
  canManageRole,
  hasPermission,
  namesToPermissions,
  permissionsToNames,
} from "./permissions";
import { Permission } from "@/proto/rostalk/v1/state_pb";

describe("permission helpers", () => {
  it("manageServer bypasses every UI check", () => {
    expect(hasPermission(["manageServer"], "kick")).toBe(true);
    expect(hasPermission(["manageServer"], "manageInvites")).toBe(true);
    expect(hasPermission(["kick"], "ban")).toBe(false);
    expect(hasPermission(null, "kick")).toBe(false);
  });

  it("round-trips permission names and enum values", () => {
    const names = ["manageRoles", "kick", "speak"];
    const values = namesToPermissions(names);
    expect(values).toContain(Permission.MANAGE_ROLES);
    expect(values).toContain(Permission.KICK);
    expect(values).toContain(Permission.SPEAK);
    expect(permissionsToNames(values)).toEqual([...names].sort());
  });

  it("mirrors the hierarchy rule", () => {
    expect(canManagePosition(50, 10, false)).toBe(true);
    expect(canManagePosition(50, 50, false)).toBe(false);
    expect(canManagePosition(50, 80, false)).toBe(false);
    expect(canManagePosition(50, 80, true)).toBe(true);
    expect(canManageRole({ position: 100 }, 50, false)).toBe(false);
  });

  it("does not let an actor grant rights they do not hold", () => {
    const actor = {
      highest: 50,
      permissions: ["manageRoles", "kick"],
      manageServer: false,
    };
    expect(
      canGrantRole({ position: 10, permissions: ["kick"] }, actor),
    ).toBe(true);
    expect(
      canGrantRole({ position: 10, permissions: ["kick", "ban"] }, actor),
    ).toBe(false);
    expect(
      canGrantRole({ position: 100, permissions: ["kick"] }, actor),
    ).toBe(false);
    expect(
      canGrantRole(
        { position: 100, permissions: ["ban"] },
        { ...actor, manageServer: true },
      ),
    ).toBe(true);
  });
});

describe("adminTabIds", () => {
  it("shows nothing without an administrative right", () => {
    expect(adminTabIds([])).toEqual([]);
    expect(adminTabIds(["viewChannel", "speak"])).toEqual([]);
  });

  it("shows only sections the permissions cover", () => {
    expect(adminTabIds(["manageRoles"])).toEqual(["roles", "members"]);
    expect(adminTabIds(["manageInvites"])).toEqual(["invites"]);
    expect(adminTabIds(["kick"])).toEqual(["members"]);
    expect(adminTabIds(["viewAuditLog"])).toEqual(["audit"]);
    expect(adminTabIds(["ban"])).toEqual(["members"]);
  });

  it("manageServer opens every section", () => {
    expect(adminTabIds(["manageServer"])).toEqual([
      "general",
      "roles",
      "channels",
      "invites",
      "members",
      "audit",
      "tokens",
    ]);
  });
});
