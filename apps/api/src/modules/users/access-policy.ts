import { HttpStatus } from "@nestjs/common";
import type { TenantTx } from "@platform/db";
import { hasPermissions, type Permission } from "@platform/shared";
import type { AuthContext } from "../../common/auth/auth.types";
import { AppException } from "../../common/filters/problem-details.filter";

/**
 * Privilege-escalation rules shared by members, roles, invitations and API keys:
 * nobody can grant (to a role, a person or a key) a permission they do not hold themselves.
 */
export function assertCanGrant(auth: AuthContext, permissions: readonly string[]): void {
  if (!hasPermissions(auth.permissions, permissions as Permission[])) {
    throw new AppException(
      HttpStatus.FORBIDDEN,
      "FORBIDDEN",
      "You cannot grant permissions you do not have yourself",
    );
  }
}

/** A business must always keep at least one OWNER */
export async function assertNotLastOwner(tx: TenantTx, membershipId: string): Promise<void> {
  const member = await tx.membership.findUniqueOrThrow({
    where: { id: membershipId },
    include: { role: true },
  });
  if (member.role.key !== "OWNER") return;
  const owners = await tx.membership.count({ where: { role: { key: "OWNER" } } });
  if (owners <= 1) {
    throw new AppException(HttpStatus.CONFLICT, "CONFLICT", "A business must keep at least one owner");
  }
}
