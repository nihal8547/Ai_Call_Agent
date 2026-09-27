import { Global, Module } from "@nestjs/common";
import { PrismaService } from "./prisma.service";
import { QueueService } from "./queue.service";
import { StorageService } from "./storage.service";
import { RedisService } from "./redis.service";
import { TenantDbService } from "./tenant-db.service";
import { TenantKeysService } from "./tenant-keys.service";
import { TwilioRestService } from "./twilio-rest.service";

@Global()
@Module({
  providers: [PrismaService, RedisService, TenantDbService, StorageService, QueueService, TenantKeysService, TwilioRestService],
  exports: [PrismaService, RedisService, TenantDbService, StorageService, QueueService, TenantKeysService, TwilioRestService],
})
export class InfraModule {}
