import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { ChatsController } from "./chats.controller";
import { ChatsService } from "./chats.service";
import { WhatsAppAccountsService } from "./whatsapp-accounts.service";
import { WhatsAppController } from "./whatsapp.controller";
import { WhatsAppInboundService } from "./whatsapp-inbound.service";
import { WhatsAppSenderService } from "./whatsapp-sender.service";
import { WhatsAppWebhookController } from "./whatsapp-webhook.controller";

/** WhatsApp Business (Cloud API): connecting numbers, the webhook, the Inbox and sending */
@Module({
  imports: [AuditModule],
  controllers: [WhatsAppWebhookController, WhatsAppController, ChatsController],
  providers: [WhatsAppAccountsService, WhatsAppInboundService, WhatsAppSenderService, ChatsService],
  exports: [WhatsAppAccountsService, WhatsAppInboundService],
})
export class WhatsAppModule {}
