import { describe, expect, it } from "vitest";
import { hasPermissions, PERMISSIONS, SYSTEM_ROLES } from "../src";

describe("system roles", () => {
  it("only reference catalogue permissions, with no duplicates", () => {
    for (const role of Object.values(SYSTEM_ROLES)) {
      expect(new Set(role.permissions).size).toBe(role.permissions.length);
      for (const p of role.permissions) expect(PERMISSIONS).toContain(p);
    }
  });

  it("form a strict hierarchy OWNER ⊇ ADMIN ⊇ MANAGER ⊇ STAFF", () => {
    const { OWNER, ADMIN, MANAGER, STAFF } = SYSTEM_ROLES;
    expect(hasPermissions(OWNER.permissions, ADMIN.permissions)).toBe(true);
    expect(hasPermissions(ADMIN.permissions, MANAGER.permissions)).toBe(true);
    expect(hasPermissions(MANAGER.permissions, STAFF.permissions)).toBe(true);
    expect(ADMIN.permissions).not.toContain("billing:write");
    expect(STAFF.permissions).not.toContain("calls:read_transcript");
  });
});
