import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { CrmModule } from "../crm/crm.module";
import { KnowledgeModule } from "../knowledge/knowledge.module";
import { TelephonyModule } from "../telephony/telephony.module";
import { ToolsModule } from "../tools/tools.module";
import { UsageModule } from "../usage/usage.module";
import { ChatsController } from "./chats.controller";
import { ChatsService } from "./chats.service";
import { WhatsAppAccountsService } from "./whatsapp-accounts.service";
import { WhatsAppAgentService } from "./whatsapp-agent.service";
import { WhatsAppController } from "./whatsapp.controller";
import { WhatsAppInboundService } from "./whatsapp-inbound.service";
import { WhatsAppSenderService } from "./whatsapp-sender.service";
import { WhatsAppWebhookController } from "./whatsapp-webhook.controller";

/** WhatsApp Business (Cloud API): connecting numbers, the webhook, the Inbox and sending */
@Module({
  imports: [AuditModule, TelephonyModule, ToolsModule, KnowledgeModule, CrmModule, UsageModule],
  controllers: [WhatsAppWebhookController, WhatsAppController, ChatsController],
  providers: [
    WhatsAppAccountsService,
    WhatsAppInboundService,
    WhatsAppSenderService,
    WhatsAppAgentService,
    ChatsService,
  ],
  exports: [WhatsAppAccountsService, WhatsAppInboundService],
})
export class WhatsAppModule {}
