import { z } from "zod";
import { TenantSlug } from "../tenancy/defaults";
import { Permission } from "./permissions";

/** Trimmed and lower-cased before validation, so " Asha@Example.com " is accepted and stored canonically */
export const Email = z.string().trim().toLowerCase().max(254).pipe(z.email("Enter a valid email address"));

/**
 * Password policy: 10–128 characters with at least three of: lowercase, uppercase, digit, symbol.
 * (Length matters most; the class rule blocks the weakest choices like "aaaaaaaaaa".)
 */
export const Password = z
  .string()
  .min(10, "Use at least 10 characters")
  .max(128, "Use at most 128 characters")
  .refine(
    (p) => [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(p)).length >= 3,
    "Use at least three of: lowercase, uppercase, number, symbol",
  );

export const PersonName = z.string().trim().min(1, "Enter your name").max(120);
export const BusinessName = z.string().trim().min(2, "Enter your business name").max(120);
export const Timezone = z
  .string()
  .min(1)
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, "Unknown time zone");

export const RegisterBody = z.object({
  name: PersonName,
  email: Email,
  password: Password,
  businessName: BusinessName,
  slug: TenantSlug.optional(),
  industry: z.string().trim().max(60).optional(),
  timezone: Timezone.default("Asia/Kolkata"),
});
export type RegisterBody = z.input<typeof RegisterBody>;

export const LoginBody = z.object({
  email: Email,
  // Do not apply the password policy at login: old passwords may predate it
  password: z.string().min(1, "Enter your password").max(128),
  tenantSlug: TenantSlug.optional(),
});
export type LoginBody = z.input<typeof LoginBody>;

export const SwitchTenantBody = z.object({ tenantId: z.uuid() });

export const MembershipSummary = z.object({
  tenantId: z.uuid(),
  tenantName: z.string(),
  tenantSlug: z.string(),
  roleKey: z.string(),
});

export const MeResponse = z.object({
  user: z.object({ id: z.uuid(), email: z.string(), name: z.string(), isPlatformOwner: z.boolean() }),
  tenant: z.object({ id: z.uuid(), name: z.string(), slug: z.string(), timezone: z.string() }),
  role: z.object({ id: z.uuid(), key: z.string(), name: z.string() }),
  permissions: z.array(z.string()),
  memberships: z.array(MembershipSummary),
});
export type MeResponse = z.infer<typeof MeResponse>;

// ── Tenant ──────────────────────────────────────────────────────────────────
export const UpdateTenantBody = z
  .object({
    name: BusinessName,
    industry: z.string().trim().max(60).nullable(),
    timezone: Timezone,
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, "Nothing to update");

// ── Members, roles, invitations ────────────────────────────────────────────
export const UpdateMemberBody = z.object({ roleId: z.uuid() });

export const RoleKey = z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/, "UPPER_SNAKE_CASE, 2–40 characters");

export const CreateRoleBody = z.object({
  key: RoleKey,
  name: z.string().trim().min(2).max(80),
  permissions: z
    .array(Permission)
    .max(100)
    .transform((p) => [...new Set(p)]),
});
export const UpdateRoleBody = CreateRoleBody.omit({ key: true })
  .partial()
  .refine((b) => Object.keys(b).length > 0, "Nothing to update");

export const CreateInvitationBody = z.object({ email: Email, roleId: z.uuid() });

export const AcceptInvitationBody = z.object({
  token: z.string().min(20).max(200),
  /** Required when the invited email has no account yet */
  name: PersonName.optional(),
  password: z.string().min(1).max(128),
});

// ── API keys ────────────────────────────────────────────────────────────────
export const CreateApiKeyBody = z.object({
  name: z.string().trim().min(2).max(80),
  scopes: z
    .array(Permission)
    .min(1, "Choose at least one scope")
    .transform((p) => [...new Set(p)]),
  expiresAt: z.coerce
    .date()
    .refine((d) => d.getTime() > Date.now(), "Expiry must be in the future")
    .optional(),
});
