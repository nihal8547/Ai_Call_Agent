import { Module } from "@nestjs/common";
import { KnowledgeModule } from "../knowledge/knowledge.module";
import { AgentConfigService } from "./agent-config.service";
import { CallGate } from "./call-gate";
import { CallRouter } from "./call-router";
import { TenantSettingsService } from "./tenant-settings.service";
import { CallRecorder } from "./call-recorder";
import { CallStateStore } from "./call-state.store";
import { RelayGateway } from "./relay.gateway";
import { TelephonyService } from "./telephony.service";
import { TwilioController } from "./twilio.controller";
import { TwilioSignatureGuard } from "./twilio-signature.guard";

@Module({
  imports: [KnowledgeModule],
  controllers: [TwilioController],
  providers: [
    TelephonyService,
    AgentConfigService,
    CallStateStore,
    CallRecorder,
    TwilioSignatureGuard,
    CallRouter,
    CallGate,
    TenantSettingsService,
    RelayGateway,
  ],
  exports: [AgentConfigService, TenantSettingsService],
})
export class TelephonyModule {}
