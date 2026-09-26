import { Inject, Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import { Redis } from "ioredis";
import { API_ENV, type ApiEnv } from "../config/env";

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;

  constructor(@Inject(API_ENV) env: ApiEnv) {
    this.client = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });
    // Without a listener ioredis reports connection errors as unhandled; readiness checks surface them instead.
    this.client.on("error", (err: Error) => this.logger.warn(`redis: ${err.message}`));
  }

  async onModuleDestroy(): Promise<void> {
    this.client.disconnect();
  }
}
