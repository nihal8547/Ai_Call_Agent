import {
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Post,
  Query,
  Req,
  type RawBodyRequest,
} from "@nestjs/common";
import { safeEqual } from "@platform/crypto";
import { parseWebhook, verifyWebhookSignature } from "@platform/whatsapp";
import type { FastifyRequest } from "fastify";
import { Public } from "../../common/auth/decorators";
import { AppException } from "../../common/filters/problem-details.filter";
import { RateLimit } from "../../common/rate-limit/rate-limit";
import { API_ENV, type ApiEnv } from "../../config/env";
import { MetricsService } from "../../observability/metrics.service";
import { WhatsAppAgentService } from "./whatsapp-agent.service";
import { WhatsAppInboundService } from "./whatsapp-inbound.service";

/**
 * Meta's WhatsApp webhook: one URL for every business (routed by phone_number_id). Authenticated by
 * the X-Hub-Signature-256 HMAC with the app secret, never by a session.
 */
@Public()
@Controller("webhooks/whatsapp")
export class WhatsAppWebhookController {
  private readonly logger = new Logger(WhatsAppWebhookController.name);

  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly inbound: WhatsAppInboundService,
    private readonly agent: WhatsAppAgentService,
    private readonly metrics: MetricsService,
  ) {}

  /** Meta checks the URL once when it is configured: echo the challenge for the right token */
  @Get()
  @Header("content-type", "text/plain")
  @RateLimit({ name: "whatsapp-verify", limit: 30, windowSeconds: 60, by: "ip" })
  verify(
    @Query("hub.mode") mode?: string,
    @Query("hub.verify_token") token?: string,
    @Query("hub.challenge") challenge?: string,
  ): string {
    const expected = this.env.WHATSAPP_VERIFY_TOKEN;
    if (
      !expected ||
      mode !== "subscribe" ||
      !token ||
      !safeEqual(token, expected) ||
      !challenge ||
      !/^[\w-]{1,200}$/.test(challenge)
    )
      throw new AppException(HttpStatus.FORBIDDEN, "FORBIDDEN", "Verification failed");
    return challenge;
  }

  @Post()
  @HttpCode(200)
  @RateLimit({ name: "whatsapp-webhook", limit: 1200, windowSeconds: 60, by: "ip" })
  async receive(@Req() req: RawBodyRequest<FastifyRequest>): Promise<{ ok: true }> {
    const secret = this.env.META_APP_SECRET;
    if (!secret)
      throw new AppException(
        HttpStatus.SERVICE_UNAVAILABLE,
        "SERVICE_UNAVAILABLE",
        "WhatsApp is not configured",
      );
    const signature = req.headers["x-hub-signature-256"];
    if (
      !req.rawBody ||
      !verifyWebhookSignature(req.rawBody, typeof signature === "string" ? signature : undefined, secret)
    ) {
      this.metrics.whatsapp.inc({ event: "webhook", result: "bad_signature" });
      this.logger.warn({ ip: req.ip }, "rejected WhatsApp webhook with an invalid signature");
      throw new AppException(HttpStatus.UNAUTHORIZED, "UNAUTHENTICATED", "Invalid signature");
    }
    // Stored before answering: if this fails, Meta retries and the unique wamid drops repeats
    const stored = await this.inbound.handle(parseWebhook(req.body));
    await this.agent.schedule(stored);
    return { ok: true };
  }
}
