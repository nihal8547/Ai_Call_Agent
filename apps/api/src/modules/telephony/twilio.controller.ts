import { Body, Controller, Header, HttpCode, Post, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { Public } from "../../common/auth/decorators";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RateLimit } from "../../common/rate-limit/rate-limit";
import { TelephonyService } from "./telephony.service";
import { toStringRecord, TwilioSignatureGuard } from "./twilio-signature.guard";

const TurnQuery = z.object({ seq: z.coerce.number().int().min(1).max(10_000) });
const WhisperQuery = z.object({ sid: z.string().regex(/^[\w-]{1,64}$/) });

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

  /** A transfer ended: over if answered; otherwise take a message and schedule a follow-up */
  @Post("dial-status")
  @HttpCode(200)
  @Header("content-type", "text/xml")
  dialStatus(@Body() body: unknown): Promise<string> {
    return this.telephony.dialStatus(this.telephony.adapter().parse(toStringRecord(body)));
  }

  /** A streaming session ended (the agent finished, or the stream broke): what the call does next */
  @Post("relay-end")
  @HttpCode(200)
  @Header("content-type", "text/xml")
  relayEnd(@Body() body: unknown): Promise<string> {
    return this.telephony.relayEnded(this.telephony.adapter().parse(toStringRecord(body)));
  }

  /** Spoken to the staff member answering a transfer, before the caller is connected */
  @Post("whisper")
  @HttpCode(200)
  @Header("content-type", "text/xml")
  whisper(@Query(new ZodValidationPipe(WhisperQuery)) q: z.output<typeof WhisperQuery>): Promise<string> {
    return this.telephony.whisper(q.sid);
  }
}
