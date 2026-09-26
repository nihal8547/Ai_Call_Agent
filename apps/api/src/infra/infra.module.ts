import { Global, Module } from "@nestjs/common";
import { PrismaService } from "./prisma.service";
import { RedisService } from "./redis.service";
import { TenantDbService } from "./tenant-db.service";

@Global()
@Module({
  providers: [PrismaService, RedisService, TenantDbService],
  exports: [PrismaService, RedisService, TenantDbService],
})
export class InfraModule {}
