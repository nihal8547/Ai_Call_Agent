import { Body, Controller, Header, HttpCode, Post, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { Public } from "../../common/auth/decorators";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RateLimit } from "../../common/rate-limit/rate-limit";
import { TelephonyService } from "./telephony.service";
import { toStringRecord, TwilioSignatureGuard } from "./twilio-signature.guard";

const TurnQuery = z.object({ seq: z.coerce.number().int().min(1).max(10_000) });

/** Twilio Voice webhooks. Authenticated by Twilio's request signature, not by user sessions. */
@Public()
@UseGuards(TwilioSignatureGuard)
@Controller("telephony/twilio")
export class TwilioController {
  constructor(private readonly telephony: TelephonyService) {}

  @Post("voice")
  @HttpCode(200)
  @Header("content-type", "text/xml")
  @RateLimit({ name: "inbound-call", limit: 30, windowSeconds: 60, by: { bodyField: "From" } })
  voice(@Body() body: unknown): Promise<string> {
    return this.telephony.inbound(this.telephony.adapter().parse(toStringRecord(body)));
  }

  @Post("turn")
  @HttpCode(200)
  @Header("content-type", "text/xml")
  turn(
    @Body() body: unknown,
    @Query(new ZodValidationPipe(TurnQuery)) q: z.output<typeof TurnQuery>,
  ): Promise<string> {
    return this.telephony.turn(this.telephony.adapter().parse(toStringRecord(body)), q.seq);
  }

  @Post("status")
  @HttpCode(204)
  async status(@Body() body: unknown): Promise<void> {
    await this.telephony.status(this.telephony.adapter().parse(toStringRecord(body)));
  }

  /** After a transfer ends the call is over */
  @Post("dial-status")
  @HttpCode(200)
  @Header("content-type", "text/xml")
  dialStatus(): string {
    return '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>';
  }
}
