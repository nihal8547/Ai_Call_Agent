import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../infra/prisma.service';
import { QueueService } from '../../infra/queue.service';
import { QUEUES, WhatsappInboundJob } from '@platform/shared';

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService
  ) {}

  async processInboundMessage(payload: any) {
    this.logger.debug('Received WhatsApp webhook payload:', JSON.stringify(payload));
    
    // Example: parse Meta webhook payload (simplified)
    const entry = payload.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;

    if (!messages || messages.length === 0) {
      return;
    }

    const message = messages[0];
    const customerNumber = message.from;
    const phoneNumberId = value.metadata.phone_number_id;

    // 1. Find tenant by phone_number_id in integrations
    const integration = await this.prisma.client.integration.findFirst({
      where: {
        type: 'WHATSAPP',
        // In real code, config is JSON, so we need a raw query or similar,
        // or just assume the webhook url contains the tenant ID.
      },
    });

    if (!integration) {
      this.logger.warn(`No WHATSAPP integration found for phone_number_id ${phoneNumberId}`);
      return;
    }

    const tenantId = integration.tenantId;

    // 2. Find or Create ChatSession
    let session = await (this.prisma.client as any).chatSession.findFirst({
      where: { tenantId, customerNumber, status: 'ACTIVE' }
    });

    if (!session) {
      session = await (this.prisma.client as any).chatSession.create({
        data: {
          tenantId,
          customerNumber,
        }
      });
    }

    // 3. Save ChatMessage
    const chatMessage = await (this.prisma.client as any).chatMessage.create({
      data: {
        sessionId: session.id,
        direction: 'INBOUND',
        type: 'TEXT',
        content: message.text?.body || '',
      }
    });

    // 4. Enqueue for AI Processing
    const job: WhatsappInboundJob = {
      tenantId,
      kind: 'whatsapp_inbound',
      sessionId: session.id,
      messageId: chatMessage.id,
      label: `Process incoming WhatsApp message from ${customerNumber}`
    };

    await this.queueService.add(QUEUES.whatsapp_inbound, job, chatMessage.id);
  }


  async verifyWebhook(mode: string, token: string, challenge: string) {
    // TODO: Verify against integration config or env
    const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      this.logger.log('WhatsApp webhook verified.');
      return challenge;
    }
    throw new Error('Invalid verification token');
  }
}
