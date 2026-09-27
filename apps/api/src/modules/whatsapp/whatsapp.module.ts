import { Module } from '@nestjs/common';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappService } from './whatsapp.service';
import { InfraModule } from '../../infra/infra.module';

import { ChatsController } from './chats.controller';

@Module({
  imports: [InfraModule],
  controllers: [WhatsappController, ChatsController],
  providers: [WhatsappService],
  exports: [WhatsappService],
})
export class WhatsappModule {}
