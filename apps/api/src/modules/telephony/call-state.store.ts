import { Injectable, Logger } from "@nestjs/common";
import type { CallSession } from "@platform/core";
import { Prisma, resolveCallSnapshot } from "@platform/db";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../../infra/prisma.service";
import { RedisService } from "../../infra/redis.service";
import { TenantDbService } from "../../infra/tenant-db.service";

/** Live state of one phone call, keyed by the provider's call id */
export type CallState = {
  callSid: string;
  tenantId: string;
  callId: string;
  agentId: string;
  agentVersionId: string;
  timezone: string;
  callerNumber: string;
  session: CallSession;
  /** Sequence number the next caller turn must carry (embedded in the webhook URL) */
  seq: number;
  /** Response to the previous request, replayed when the provider retries it */
  lastReply: string;
  eventSeq: number;
  finalized: boolean;
  /** A transfer went unanswered and the follow-up was recorded */
  missedTransfer?: boolean;
};

const TTL_SECONDS = 3 * 60 * 60;
const LOCK_MS = 15_000;
const RELEASE = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

/**
 * Call state lives in Redis so any API instance can serve the next webhook of a call, and is
 * mirrored to the call's row on every turn: if Redis loses it (restart, eviction, failover),
 * the conversation continues from the last completed turn instead of dropping the caller.
 */
@Injectable()
export class CallStateStore {
  private readonly logger = new Logger(CallStateStore.name);

  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    private readonly tenantDb: TenantDbService,
  ) {}

  private async client() {
    if (this.redis.client.status === "wait") await this.redis.client.connect();
    return this.redis.client;
  }

  async get(callSid: string): Promise<CallState | null> {
    const raw = await (await this.client()).get(`callstate:${callSid}`);
    return raw ? (JSON.parse(raw) as CallState) : this.recover(callSid);
  }

  async set(callSid: string, state: CallState): Promise<void> {
    await Promise.all([
      (await this.client()).set(`callstate:${callSid}`, JSON.stringify(state), "EX", TTL_SECONDS),
      this.tenantDb.db(state.tenantId).call.update({
        where: { id: state.callId },
        data: { sessionSnapshot: state as unknown as Prisma.InputJsonValue },
      }),
    ]);
  }

  /** The call is over: forget its live state everywhere */
  async delete(callSid: string, state?: Pick<CallState, "tenantId" | "callId">): Promise<void> {
    await (await this.client()).del(`callstate:${callSid}`);
    if (state)
      await this.tenantDb.db(state.tenantId).call.update({
        where: { id: state.callId },
        data: { sessionSnapshot: Prisma.DbNull },
      });
  }

  /** Rebuild a live call's state from its last mirrored turn */
  private async recover(callSid: string): Promise<CallState | null> {
    const found = await resolveCallSnapshot(this.prisma.client, callSid);
    const state = found?.snapshot as CallState | undefined;
    if (!found || !state || state.callSid !== callSid || state.tenantId !== found.tenantId) return null;
    await (await this.client()).set(`callstate:${callSid}`, JSON.stringify(state), "EX", TTL_SECONDS, "NX");
    this.logger.warn({ callId: state.callId }, "call state recovered from the database");
    return state;
  }

  /** Serialise work on one call across instances; returns null if the lock stays busy */
  async withLock<T>(callSid: string, fn: () => Promise<T>, waitMs = 3000): Promise<T | null> {
    const redis = await this.client();
    const key = `lock:call:${callSid}`;
    const token = randomUUID();
    const deadline = Date.now() + waitMs;
    while ((await redis.set(key, token, "PX", LOCK_MS, "NX")) !== "OK") {
      if (Date.now() > deadline) return null;
      await new Promise((r) => setTimeout(r, 50));
    }
    try {
      return await fn();
    } finally {
      await redis.eval(RELEASE, 1, key, token);
    }
  }
}
