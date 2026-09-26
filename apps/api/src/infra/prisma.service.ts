import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { createPrismaClient, type PrismaClient } from "@platform/db";
import { API_ENV, type ApiEnv } from "../config/env";

/** Owns the process-wide Prisma client */
@Injectable()
export class PrismaService implements OnModuleDestroy {
  readonly client: PrismaClient;

  constructor(@Inject(API_ENV) env: ApiEnv) {
    this.client = createPrismaClient({ url: env.DATABASE_URL });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
