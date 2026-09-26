import "reflect-metadata";
import fastifyCookie from "@fastify/cookie";
import fastifyHelmet from "@fastify/helmet";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { randomUUID } from "node:crypto";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module";
import { type ApiEnv } from "./config/env";

/** Builds the fully configured app; shared by main.ts and integration tests */
export async function createApp(
  env: ApiEnv,
  options: { logger?: boolean } = {},
): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    trustProxy: env.TRUST_PROXY.length ? env.TRUST_PROXY : false,
    bodyLimit: 1024 * 1024,
    genReqId: (req: { headers: Record<string, string | string[] | undefined> }) => {
      const incoming = req.headers["x-request-id"];
      return typeof incoming === "string" && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    },
  });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule.register(env), adapter, {
    bufferLogs: true,
    logger: options.logger === false ? false : undefined,
  });
  if (options.logger !== false) app.useLogger(app.get(Logger));

  await app.register(fastifyHelmet);
  await app.register(fastifyCookie);
  app.enableCors({ origin: env.CORS_ORIGINS, credentials: true });
  // Provider webhooks keep stable, unversioned URLs (they are configured in the provider console)
  app.setGlobalPrefix("api/v1", { exclude: ["health", "ready", "telephony/{*path}"] });
  app.enableShutdownHooks();

  // Echo the request id so clients and logs can be correlated
  app
    .getHttpAdapter()
    .getInstance()
    .addHook("onSend", async (req, reply) => {
      void reply.header("x-request-id", req.id);
    });

  return app;
}
