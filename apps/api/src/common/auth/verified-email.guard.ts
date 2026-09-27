import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
  UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { API_ENV, type ApiEnv } from "../../config/env";
import { PrismaService } from "../../infra/prisma.service";
import { AppException } from "../filters/problem-details.filter";

/**
 * Runs after the global guards on routes marked @RequireVerifiedEmail(): the signed-in person
 * must have confirmed their email. Keeps throwaway sign-ups from spending money or reaching
 * customers. API keys pass: creating one needs a confirmed email already.
 */
@Injectable()
export class VerifiedEmailGuard implements CanActivate {
  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.env.EMAIL_VERIFICATION === "off") return true;
    const auth = ctx.switchToHttp().getRequest<FastifyRequest>().auth;
    if (auth?.kind !== "user") return true;
    const user = await this.prisma.client.user.findUnique({
      where: { id: auth.userId },
      select: { emailVerifiedAt: true },
    });
    if (user?.emailVerifiedAt) return true;
    throw new AppException(
      HttpStatus.FORBIDDEN,
      "EMAIL_NOT_VERIFIED",
      "Confirm your email first: open the link we emailed you (or send a new one from the banner at the top).",
    );
  }
}

/** Only for people who confirmed their email (see VerifiedEmailGuard) */
export const RequireVerifiedEmail = () => UseGuards(VerifiedEmailGuard);
