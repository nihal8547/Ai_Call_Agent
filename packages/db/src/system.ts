import { type PrismaClient } from "@prisma/client";

/**
 * Typed wrappers around the SECURITY DEFINER functions from the RLS migration.
 * These are the only queries that run before the tenant is known.
 */

export type PhoneRoute = {
  tenantId: string;
  agentId: string | null;
  agentVersionId: string | null;
  phoneNumberId: string;
};

/** Inbound call routing: "To" Twilio number → tenant, agent and its published version (null when inactive) */
export async function resolvePhoneNumber(prisma: PrismaClient, e164: string): Promise<PhoneRoute | null> {
  const rows = await prisma.$queryRaw<
    { tenant_id: string; agent_id: string | null; agent_version_id: string | null; phone_number_id: string }[]
  >`
    SELECT tenant_id, agent_id, agent_version_id, phone_number_id FROM resolve_phone_number(${e164})`;
  const r = rows[0];
  return r
    ? {
        tenantId: r.tenant_id,
        agentId: r.agent_id,
        agentVersionId: r.agent_version_id,
        phoneNumberId: r.phone_number_id,
      }
    : null;
}

/** SIP calls: the platform SIP domain label a call arrived on → its trunk and business */
export async function resolveSipTrunk(
  prisma: PrismaClient,
  domainName: string,
): Promise<{ tenantId: string; sipTrunkId: string; callingCode: string } | null> {
  const rows = await prisma.$queryRaw<{ tenant_id: string; sip_trunk_id: string; calling_code: string }[]>`
    SELECT tenant_id, sip_trunk_id, calling_code FROM resolve_sip_trunk(${domainName})`;
  const r = rows[0];
  return r ? { tenantId: r.tenant_id, sipTrunkId: r.sip_trunk_id, callingCode: r.calling_code } : null;
}

/** Every active tenant with its retention setting (nightly jobs) */
export async function activeTenants(
  prisma: PrismaClient,
): Promise<{ tenantId: string; retentionDays: number }[]> {
  const rows = await prisma.$queryRaw<{ tenant_id: string; retention_days: number }[]>`
    SELECT tenant_id, retention_days FROM active_tenants()`;
  return rows.map((r) => ({ tenantId: r.tenant_id, retentionDays: r.retention_days }));
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

/** A live call's mirrored state by the provider's call id (Redis lost it); null when the call is over */
export async function resolveCallSnapshot(
  prisma: PrismaClient,
  callSid: string,
): Promise<{ tenantId: string; snapshot: unknown } | null> {
  const rows = await prisma.$queryRaw<{ tenant_id: string; snapshot: unknown }[]>`
    SELECT tenant_id, snapshot FROM resolve_call_snapshot(${callSid})`;
  const r = rows[0];
  return r ? { tenantId: r.tenant_id, snapshot: r.snapshot } : null;
}

/** Tenants with calls started or ended since a moment (analytics sweeps work per tenant) */
export async function tenantsWithCallsSince(prisma: PrismaClient, since: Date): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ tenant_id: string }[]>`
    SELECT tenant_id FROM tenants_with_calls_since(${since})`;
  return rows.map((r) => r.tenant_id);
}
