import { z } from "zod";

/**
 * Permission catalogue: `resource:action`. The only list of permissions in the system —
 * API guards, role editor UI and seeds all read from here.
 */
export const PERMISSIONS = [
  "tenant:read",
  "tenant:write",
  "tenant:delete",
  "users:read",
  "users:write",
  "roles:read",
  "roles:write",
  "agents:read",
  "agents:write",
  "agents:publish",
  "knowledge:read",
  "knowledge:write",
  "phone_numbers:read",
  "phone_numbers:write",
  "calls:read",
  "calls:read_transcript",
  "calls:read_recording",
  "leads:read",
  "leads:write",
  "leads:export",
  "appointments:read",
  "appointments:write",
  "chats:read",
  "chats:reply",
  "chats:manage",
  "integrations:read",
  "integrations:write",
  "analytics:read",
  "api_keys:read",
  "api_keys:write",
  "audit:read",
  "billing:read",
  "billing:write",
] as const;

export const Permission = z.enum(PERMISSIONS);
export type Permission = z.infer<typeof Permission>;

export const SYSTEM_ROLE_KEYS = ["OWNER", "ADMIN", "MANAGER", "STAFF"] as const;
export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number];

const all = [...PERMISSIONS];
const without = (...excluded: Permission[]) => all.filter((p) => !excluded.includes(p));

/** Default permission sets for the roles created with every tenant (editable per tenant afterwards) */
export const SYSTEM_ROLES: Record<SystemRoleKey, { name: string; permissions: Permission[] }> = {
  OWNER: { name: "Business Owner", permissions: all },
  ADMIN: { name: "Business Admin", permissions: without("tenant:delete", "billing:write") },
  MANAGER: {
    name: "Manager",
    permissions: [
      "tenant:read",
      "users:read",
      "agents:read",
      "knowledge:read",
      "phone_numbers:read",
      "calls:read",
      "calls:read_transcript",
      "calls:read_recording",
      "leads:read",
      "leads:write",
      "leads:export",
      "appointments:read",
      "appointments:write",
      "chats:read",
      "chats:reply",
      "integrations:read",
      "analytics:read",
    ],
  },
  STAFF: {
    name: "Agent / Staff",
    permissions: [
      "tenant:read",
      "calls:read",
      "leads:read",
      "leads:write",
      "appointments:read",
      "appointments:write",
      "chats:read",
      "chats:reply",
    ],
  },
};

export function hasPermissions(granted: readonly string[], required: readonly Permission[]): boolean {
  return required.every((p) => granted.includes(p));
}
