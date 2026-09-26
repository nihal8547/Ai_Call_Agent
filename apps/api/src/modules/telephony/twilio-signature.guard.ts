import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { AppException } from "../../common/filters/problem-details.filter";
import { API_ENV, type ApiEnv } from "../../config/env";
import { TelephonyService } from "./telephony.service";

/**
 * Rejects any webhook not signed by Twilio with our auth token. The signed URL is the public URL
 * Twilio called, so PUBLIC_BASE_URL must match what is configured in Twilio exactly.
 */
@Injectable()
export class TwilioSignatureGuard implements CanActivate {
  private readonly logger = new Logger(TwilioSignatureGuard.name);

  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly telephony: TelephonyService,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const adapter = this.telephony.adapter();
    const params = toStringRecord(req.body);
    const signature = req.headers["x-twilio-signature"];
    const url = `${this.env.PUBLIC_BASE_URL}${req.url}`;
    if (
      !adapter.verifySignature({
        url,
        params,
        signature: typeof signature === "string" ? signature : undefined,
      })
    ) {
      this.logger.warn({ url, ip: req.ip }, "rejected webhook with an invalid Twilio signature");
      throw new AppException(HttpStatus.FORBIDDEN, "FORBIDDEN", "Invalid signature");
    }
    return true;
  }
}

export function toStringRecord(body: unknown): Record<string, string> {
  if (!body || typeof body !== "object") return {};
  return Object.fromEntries(
    Object.entries(body).map(([k, v]) => [k, Array.isArray(v) ? String(v[0] ?? "") : String(v ?? "")]),
  );
}
