import { z } from "zod";
import { TenantLimits } from "../tenancy/defaults";

/** Platform console: the businesses list */
export const PlatformTenantsQuery = z.object({
  q: z.string().trim().max(80).optional(),
  status: z.enum(["all", "ACTIVE", "SUSPENDED"]).default("all"),
});

/** Suspend (with the reason, shown to the operator) or reactivate a business */
export const PlatformStatusBody = z
  .object({
    status: z.enum(["ACTIVE", "SUSPENDED"]),
    reason: z.string().trim().max(500).optional(),
  })
  .refine((b) => b.status !== "SUSPENDED" || (b.reason?.length ?? 0) >= 3, {
    message: "Say why the business is suspended",
    path: ["reason"],
  });

/** A business's plan name and usage limits (limits left out keep their value) */
export const PlatformPlanBody = z.object({
  plan: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{1,39}$/, "lowercase letters, numbers and hyphens")
    .optional(),
  limits: TenantLimits.partial().optional(),
});
