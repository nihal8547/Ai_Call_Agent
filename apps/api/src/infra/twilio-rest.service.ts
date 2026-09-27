import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { TwilioRest, TwilioRestError } from "@platform/telephony";
import { AppException } from "../common/filters/problem-details.filter";
import { API_ENV, type ApiEnv } from "../config/env";

/** The platform's Twilio account, when configured (buying numbers, SIP domains) */
@Injectable()
export class TwilioRestService {
  readonly client: TwilioRest | null;

  constructor(@Inject(API_ENV) private readonly env: ApiEnv) {
    const sid = env.TWILIO_ACCOUNT_SID;
    const [username, password] =
      env.TWILIO_API_KEY_SID && env.TWILIO_API_KEY_SECRET
        ? [env.TWILIO_API_KEY_SID, env.TWILIO_API_KEY_SECRET]
        : [sid, env.TWILIO_AUTH_TOKEN];
    this.client =
      sid && username && password
        ? new TwilioRest({ accountSid: sid, username, password, baseUrl: env.TWILIO_API_BASE_URL })
        : null;
  }

  /** Webhook URLs every platform number and SIP domain points at */
  get webhooks() {
    return {
      voiceUrl: `${this.env.PUBLIC_BASE_URL}/telephony/twilio/voice`,
      statusCallback: `${this.env.PUBLIC_BASE_URL}/telephony/twilio/status`,
    };
  }

  require(): TwilioRest {
    if (!this.client)
      throw new AppException(
        HttpStatus.CONFLICT,
        "CONFLICT",
        "Buying numbers and SIP connections need the platform's Twilio account (TWILIO_ACCOUNT_SID).",
      );
    return this.client;
  }

  /** Twilio's refusal as a problem the user can act on */
  static toProblem(err: unknown, what: string): AppException {
    if (err instanceof TwilioRestError)
      return new AppException(
        err.status === 400 || err.status === 404 ? HttpStatus.BAD_REQUEST : HttpStatus.BAD_GATEWAY,
        "INTEGRATION_ERROR",
        `${what}: ${err.message}`,
      );
    return new AppException(HttpStatus.BAD_GATEWAY, "INTEGRATION_ERROR", `${what} failed`);
  }
}
