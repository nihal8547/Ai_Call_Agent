import { Injectable } from "@nestjs/common";
import type { CallSession } from "@platform/core";
import { randomUUID } from "node:crypto";
import { RedisService } from "../../infra/redis.service";

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
 * Call state lives in Redis so any API instance can serve the next webhook of a call,
 * and a restart does not lose calls in progress.
 */
@Injectable()
export class CallStateStore {
  constructor(private readonly redis: RedisService) {}

  private async client() {
    if (this.redis.client.status === "wait") await this.redis.client.connect();
    return this.redis.client;
  }

  async get(callSid: string): Promise<CallState | null> {
    const raw = await (await this.client()).get(`callstate:${callSid}`);
    return raw ? (JSON.parse(raw) as CallState) : null;
  }

  async set(callSid: string, state: CallState): Promise<void> {
    await (await this.client()).set(`callstate:${callSid}`, JSON.stringify(state), "EX", TTL_SECONDS);
  }

  async delete(callSid: string): Promise<void> {
    await (await this.client()).del(`callstate:${callSid}`);
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
