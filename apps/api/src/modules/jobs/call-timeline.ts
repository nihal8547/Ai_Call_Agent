import { redactDeep } from "@platform/core";
import type { CallEventType, Prisma, TenantTx } from "@platform/db";

/**
 * Events recorded after the conversation moved on (background jobs) take sequence numbers from
 * this range, so they never collide with the numbers live turns reserve in the call's state.
 */
export const BACKGROUND_SEQ_START = 1_000_000;

export async function appendBackgroundEvent(
  tx: TenantTx,
  e: {
    tenantId: string;
    callId: string;
    type: CallEventType;
    payload: Record<string, unknown>;
    latencyMs?: number;
  },
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`callevents:${e.callId}`}, 0))`;
  const last = await tx.callEvent.aggregate({
    where: { callId: e.callId, seq: { gte: BACKGROUND_SEQ_START } },
    _max: { seq: true },
  });
  await tx.callEvent.create({
    data: {
      tenantId: e.tenantId,
      callId: e.callId,
      seq: (last._max.seq ?? BACKGROUND_SEQ_START - 1) + 1,
      type: e.type,
      payload: redactDeep(e.payload) as Prisma.InputJsonValue,
      latencyMs: e.latencyMs ?? null,
    },
  });
}
