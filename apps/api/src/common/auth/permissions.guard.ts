import { type CanActivate, type ExecutionContext, HttpStatus, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { hasPermissions, type Permission } from "@platform/shared";
import type { FastifyRequest } from "fastify";
import { AppException } from "../filters/problem-details.filter";
import { ANY_AUTHENTICATED, IS_PUBLIC, REQUIRED_PERMISSIONS, USER_ONLY } from "./decorators";

/**
 * Global guard, runs after AuthGuard. Deny by default: a non-public route without
 * @RequirePermissions or @AnyAuthenticated is a programming error and returns 403.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const auth = ctx.switchToHttp().getRequest<FastifyRequest>().auth;
    if (!auth) throw new AppException(HttpStatus.UNAUTHORIZED, "UNAUTHENTICATED", "Sign in required");

    if (this.reflector.getAllAndOverride<boolean>(USER_ONLY, targets) && auth.kind !== "user") {
      throw new AppException(HttpStatus.FORBIDDEN, "FORBIDDEN", "This action requires a signed-in user");
    }
    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(
      REQUIRED_PERMISSIONS,
      targets,
    );
    if (required) {
      if (hasPermissions(auth.permissions, required)) return true;
      throw new AppException(HttpStatus.FORBIDDEN, "FORBIDDEN", `Missing permission: ${required.join(", ")}`);
    }
    if (this.reflector.getAllAndOverride<boolean>(ANY_AUTHENTICATED, targets)) return true;
    throw new AppException(HttpStatus.FORBIDDEN, "FORBIDDEN", "Route has no access policy");
  }
}
