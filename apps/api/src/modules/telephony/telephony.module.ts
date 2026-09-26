import { Module } from "@nestjs/common";
import { AgentConfigService } from "./agent-config.service";
import { CallRecorder } from "./call-recorder";
import { CallStateStore } from "./call-state.store";
import { TelephonyService } from "./telephony.service";
import { TwilioController } from "./twilio.controller";
import { TwilioSignatureGuard } from "./twilio-signature.guard";

@Module({
  controllers: [TwilioController],
  providers: [TelephonyService, AgentConfigService, CallStateStore, CallRecorder, TwilioSignatureGuard],
  exports: [AgentConfigService],
})
export class TelephonyModule {}
