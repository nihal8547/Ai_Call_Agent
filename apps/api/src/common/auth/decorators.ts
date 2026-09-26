import { createParamDecorator, type ExecutionContext, SetMetadata } from "@nestjs/common";
import type { Permission } from "@platform/shared";
import type { FastifyRequest } from "fastify";
import type { AuthContext } from "./auth.types";

export const IS_PUBLIC = "auth:public";
export const REQUIRED_PERMISSIONS = "auth:permissions";
export const ANY_AUTHENTICATED = "auth:any";
export const USER_ONLY = "auth:user-only";

/** No authentication (login, register, webhooks with their own signature checks) */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Caller must hold every listed permission. Routes are deny-by-default without this or @AnyAuthenticated. */
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(REQUIRED_PERMISSIONS, permissions);

/** Any signed-in member of the tenant (e.g. GET /auth/me) */
export const AnyAuthenticated = () => SetMetadata(ANY_AUTHENTICATED, true);

/** Reject API keys: the route acts on behalf of a person (sessions, invitations, API key management) */
export const UserOnly = () => SetMetadata(USER_ONLY, true);

export const CurrentAuth = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthContext => {
  const req = ctx.switchToHttp().getRequest<FastifyRequest>();
  if (!req.auth) throw new Error("CurrentAuth used on a route without authentication");
  return req.auth;
});

export function userAuth(auth: AuthContext): Extract<AuthContext, { kind: "user" }> {
  if (auth.kind !== "user") throw new Error("Expected a user session");
  return auth;
}
