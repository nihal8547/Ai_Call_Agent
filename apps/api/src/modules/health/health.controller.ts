import { Controller, Get, HttpStatus } from "@nestjs/common";
import { pingDatabase } from "@platform/db";
import { Public } from "../../common/auth/decorators";
import { AppException } from "../../common/filters/problem-details.filter";
import { PrismaService } from "../../infra/prisma.service";
import { RedisService } from "../../infra/redis.service";

type CheckResult = "ok" | "error";

@Public()
@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /** Liveness: the process is up */
  @Get("health")
  health(): { status: "ok" } {
    return { status: "ok" };
  }

  /** Readiness: dependencies reachable. 503 if any check fails. */
  @Get("ready")
  async ready(): Promise<{ status: "ok"; checks: Record<string, CheckResult> }> {
    const [database, redis] = await Promise.all([
      withTimeout(pingDatabase(this.prisma.client)),
      withTimeout(this.pingRedis()),
    ]);
    const checks = { database, redis };
    if (Object.values(checks).some((c) => c === "error")) {
      throw new AppException(
        HttpStatus.SERVICE_UNAVAILABLE,
        "SERVICE_UNAVAILABLE",
        `Dependencies unavailable: ${Object.entries(checks)
          .filter(([, v]) => v === "error")
          .map(([k]) => k)
          .join(", ")}`,
      );
    }
    return { status: "ok", checks };
  }

  private async pingRedis(): Promise<void> {
    if (this.redis.client.status === "wait") await this.redis.client.connect();
    await this.redis.client.ping();
  }
}

async function withTimeout(p: Promise<unknown>, ms = 2000): Promise<CheckResult> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      p,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), ms);
      }),
    ]);
    return "ok";
  } catch {
    return "error";
  } finally {
    clearTimeout(timer);
  }
}
