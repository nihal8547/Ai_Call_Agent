import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { FastifyAdapter } from "@bull-board/fastify";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { safeEqual } from "@platform/crypto";
import { QUEUES } from "@platform/shared";
import type { ApiEnv } from "../config/env";
import { QueueService } from "../infra/queue.service";

export const QUEUE_BOARD_PATH = "/admin/queues";

/**
 * Bull Board for platform operators: every queue across all tenants, so it is not part of the
 * tenant app or its roles. Off unless ADMIN_BOARD_PASSWORD is set; HTTP basic auth (user "admin").
 */
export async function mountQueueBoard(app: NestFastifyApplication, env: ApiEnv): Promise<void> {
  const password = env.ADMIN_BOARD_PASSWORD;
  if (!password) return;
  const queues = app.get(QueueService);
  const serverAdapter = new FastifyAdapter();
  serverAdapter.setBasePath(QUEUE_BOARD_PATH);
  createBullBoard({
    queues: Object.values(QUEUES).map((q) => new BullMQAdapter(queues.queue(q))),
    serverAdapter,
    options: { uiConfig: { boardTitle: "Voice platform queues" } },
  });
  const expected = `Basic ${Buffer.from(`admin:${password}`).toString("base64")}`;
  await app
    .getHttpAdapter()
    .getInstance()
    .register(async (scope) => {
      scope.addHook("onRequest", async (req, reply) => {
        const given = req.headers.authorization ?? "";
        if (!safeEqual(given, expected)) {
          await reply
            .code(401)
            .header("www-authenticate", 'Basic realm="queues", charset="UTF-8"')
            .send({ title: "Unauthorized", status: 401 });
        }
      });
      await scope.register(serverAdapter.registerPlugin() as never, { prefix: QUEUE_BOARD_PATH });
    });
}
