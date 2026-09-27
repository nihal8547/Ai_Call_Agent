import { Controller, Get, Post, Body, Query, HttpCode, HttpStatus, ForbiddenException } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';

@Controller('webhooks/whatsapp')
export class WhatsappController {
  constructor(private readonly whatsappService: WhatsappService) {}

  @Get()
  async verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string
  ) {
    try {
      const verifiedChallenge = await this.whatsappService.verifyWebhook(mode, token, challenge);
      return verifiedChallenge;
    } catch (error) {
      throw new ForbiddenException('Verification failed');
    }
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  async handleIncoming(@Body() body: any) {
    // Process asynchronously
    this.whatsappService.processInboundMessage(body).catch(console.error);
    return 'EVENT_RECEIVED';
  }
}

