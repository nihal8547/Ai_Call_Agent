import { Global, Module } from "@nestjs/common";
import { PrismaService } from "./prisma.service";
import { QueueService } from "./queue.service";
import { StorageService } from "./storage.service";
import { RedisService } from "./redis.service";
import { TenantDbService } from "./tenant-db.service";

@Global()
@Module({
  providers: [PrismaService, RedisService, TenantDbService, StorageService, QueueService],
  exports: [PrismaService, RedisService, TenantDbService, StorageService, QueueService],
})
export class InfraModule {}
