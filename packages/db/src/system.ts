import { type PrismaClient } from "@prisma/client";

/**
 * Typed wrappers around the SECURITY DEFINER functions from the RLS migration.
 * These are the only queries that run before the tenant is known.
 */

export type PhoneRoute = { tenantId: string; agentId: string | null; agentVersionId: string | null };

/** Inbound call routing: "To" number → tenant, agent and its published version (null when inactive) */
export async function resolvePhoneNumber(prisma: PrismaClient, e164: string): Promise<PhoneRoute | null> {
  const rows = await prisma.$queryRaw<
    { tenant_id: string; agent_id: string | null; agent_version_id: string | null }[]
  >`
    SELECT tenant_id, agent_id, agent_version_id FROM resolve_phone_number(${e164})`;
  const r = rows[0];
  return r ? { tenantId: r.tenant_id, agentId: r.agent_id, agentVersionId: r.agent_version_id } : null;
}

export type UserMembership = {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  roleKey: string;
  permissions: string[];
};

export async function userMemberships(prisma: PrismaClient, userId: string): Promise<UserMembership[]> {
  const rows = await prisma.$queryRaw<
    { tenant_id: string; tenant_name: string; tenant_slug: string; role_key: string; permissions: string[] }[]
  >`SELECT * FROM user_memberships(${userId}::uuid)`;
  return rows.map((r) => ({
    tenantId: r.tenant_id,
    tenantName: r.tenant_name,
    tenantSlug: r.tenant_slug,
    roleKey: r.role_key,
    permissions: r.permissions,
  }));
}

export type ApiKeyPrincipal = { apiKeyId: string; tenantId: string; scopes: string[] };

export async function resolveApiKey(prisma: PrismaClient, keyHash: string): Promise<ApiKeyPrincipal | null> {
  const rows = await prisma.$queryRaw<{ api_key_id: string; tenant_id: string; scopes: string[] }[]>`
    SELECT * FROM resolve_api_key(${keyHash})`;
  const r = rows[0];
  return r ? { apiKeyId: r.api_key_id, tenantId: r.tenant_id, scopes: r.scopes } : null;
}

export type PendingInvitation = { invitationId: string; tenantId: string; email: string; roleId: string };

export async function resolveInvitation(
  prisma: PrismaClient,
  tokenHash: string,
): Promise<PendingInvitation | null> {
  const rows = await prisma.$queryRaw<
    { invitation_id: string; tenant_id: string; email: string; role_id: string }[]
  >`
    SELECT * FROM resolve_invitation(${tokenHash})`;
  const r = rows[0];
  return r
    ? { invitationId: r.invitation_id, tenantId: r.tenant_id, email: r.email, roleId: r.role_id }
    : null;
}
