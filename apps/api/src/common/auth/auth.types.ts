import type { Permission } from "@platform/shared";

/** Who is making the request, resolved by AuthGuard and attached to the request */
export type AuthContext =
  | {
      kind: "user";
      userId: string;
      tenantId: string;
      roleId: string;
      roleKey: string;
      permissions: readonly Permission[];
      /** The signed-in session (device) */
      familyId?: string;
    }
  | {
      kind: "api_key";
      apiKeyId: string;
      tenantId: string;
      permissions: readonly Permission[];
    };

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export const COOKIE = {
  access: "access_token",
  refresh: "refresh_token",
  csrf: "csrf_token",
} as const;

export const CSRF_HEADER = "x-csrf-token";
