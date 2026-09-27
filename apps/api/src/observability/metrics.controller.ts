import { Controller, Get, Header, HttpStatus, Inject, Req } from "@nestjs/common";
import { safeEqual } from "@platform/crypto";
import type { FastifyRequest } from "fastify";
import { isIP } from "node:net";
import { Public } from "../common/auth/decorators";
import { AppException } from "../common/filters/problem-details.filter";
import { API_ENV, type ApiEnv } from "../config/env";
import { MetricsService } from "./metrics.service";

/** Private or loopback address (Prometheus inside the cluster) */
function internal(ip: string): boolean {
  const v4 = ip.replace(/^::ffff:/, "");
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return ip === "::1" || /^f[cd]/i.test(ip);
}

/**
 * Prometheus scrape endpoint. With METRICS_TOKEN set it needs `Authorization: Bearer <token>`;
 * without, only private-network callers get an answer (everyone else sees 404).
 */
@Public()
@Controller()
export class MetricsController {
  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly metrics: MetricsService,
  ) {}

  @Get("metrics")
  @Header("content-type", "text/plain; version=0.0.4; charset=utf-8")
  @Header("cache-control", "no-store")
  async scrape(@Req() req: FastifyRequest): Promise<string> {
    const token = this.env.METRICS_TOKEN;
    const allowed = token
      ? safeEqual(req.headers.authorization ?? "", `Bearer ${token}`)
      : internal(req.socket.remoteAddress ?? "");
    if (!allowed) throw new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "Not found");
    return this.metrics.registry.metrics();
  }
}
