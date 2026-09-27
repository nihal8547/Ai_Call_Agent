import { z } from "zod";
import { COUNTRY_CODES } from "../tenancy/countries";
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
  /** Sets the calling code, currency and (unless given) the time zone */
  country: z.enum(COUNTRY_CODES).default("IN"),
  timezone: Timezone.optional(),
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

// ── Two-step sign-in (TOTP) and sessions ────────────────────────────────────
/** A 6-digit authenticator code, or a recovery code like 7GQ4-X2MP-KT9A */
const MfaCode = z.string().trim().min(6).max(20);
/** "Forgot password": always answered the same way, whether or not the account exists */
export const ForgotPasswordBody = z.object({ email: Email });
/** The token from the emailed link, and the new password */
export const ResetPasswordBody = z.object({
  token: z.string().trim().min(20).max(200),
  password: Password,
});

export const LoginMfaBody = z.object({ mfaToken: z.string().min(20).max(100), code: MfaCode });
export const EnableTotpBody = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "Enter the 6-digit code"),
});
export const DisableTotpBody = z.object({ password: z.string().min(1).max(128), code: MfaCode });

export const MembershipSummary = z.object({
  tenantId: z.uuid(),
  tenantName: z.string(),
  tenantSlug: z.string(),
  roleKey: z.string(),
});

export const MeResponse = z.object({
  user: z.object({
    id: z.uuid(),
    email: z.string(),
    name: z.string(),
    isPlatformOwner: z.boolean(),
    totpEnabled: z.boolean(),
  }),
  tenant: z.object({
    id: z.uuid(),
    name: z.string(),
    slug: z.string(),
    timezone: z.string(),
    country: z.string(),
    callingCode: z.string(),
    currency: z.string(),
  }),
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
    /** Changes the calling code and currency with it */
    country: z.enum(COUNTRY_CODES),
    retentionDays: z.number().int().min(30).max(3650),
    maxCallMinutes: z.number().int().min(2).max(120),
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
