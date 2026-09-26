import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Injectable,
  Logger,
  SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyRequest } from "fastify";
import { RedisService } from "../../infra/redis.service";
import { AppException } from "../filters/problem-details.filter";

export type RateLimitRule = {
  /** Bucket name, e.g. "login" */
  name: string;
  limit: number;
  windowSeconds: number;
  /** What to count by: client IP, or a body field (e.g. email) */
  by: "ip" | { bodyField: string };
};

const RATE_LIMITS = "rate-limits";

/** Fixed-window limits backed by Redis. Several rules may apply to one route. */
export const RateLimit = (...rules: RateLimitRule[]) => SetMetadata(RATE_LIMITS, rules);

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly redis: RedisService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const rules = this.reflector.get<RateLimitRule[] | undefined>(RATE_LIMITS, ctx.getHandler());
    if (!rules?.length) return true;
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();

    for (const rule of rules) {
      const subject = rule.by === "ip" ? req.ip : this.bodyValue(req, rule.by.bodyField);
      if (!subject) continue;
      const window = Math.floor(Date.now() / 1000 / rule.windowSeconds);
      const key = `rl:${rule.name}:${subject}:${window}`;
      let count: number;
      try {
        if (this.redis.client.status === "wait") await this.redis.client.connect();
        const results = await this.redis.client.multi().incr(key).expire(key, rule.windowSeconds).exec();
        count = Number(results?.[0]?.[1] ?? 0);
      } catch (err) {
        // Fail open: an unavailable Redis must not lock every user out; it is alerted on via /ready
        this.logger.warn(`rate limit check skipped: ${(err as Error).message}`);
        return true;
      }
      if (count > rule.limit) {
        throw new AppException(
          HttpStatus.TOO_MANY_REQUESTS,
          "RATE_LIMITED",
          "Too many attempts, try again later",
        );
      }
    }
    return true;
  }

  private bodyValue(req: FastifyRequest, field: string): string | undefined {
    const value = (req.body as Record<string, unknown> | undefined)?.[field];
    return typeof value === "string" ? value.trim().toLowerCase().slice(0, 254) : undefined;
  }
}
