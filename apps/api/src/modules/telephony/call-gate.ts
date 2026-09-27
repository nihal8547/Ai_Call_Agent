import { Injectable, Logger } from "@nestjs/common";
import { RedisService } from "../../infra/redis.service";
import { TenantDbService } from "../../infra/tenant-db.service";
import { AlertsService } from "../alerts/alerts.service";
import type { CallRoute } from "./call-router";
import { type CallSettings, isBlocked } from "./tenant-settings.service";

export type GateResult =
  | { ok: true }
  | { ok: false; reason: "blocked" | "loop" | "busy" | "limit"; reject?: "busy" | "rejected"; say?: string };

const LIMIT_MESSAGE =
  "Sorry, we can't take calls on this line right now. Please call again later or contact us another way. Goodbye.";
/**
 * A transfer of this caller is ringing: a call in from them right now is that transfer looping back
 * through a forwarded line. Cleared when the transfer or the call ends; the TTL is only a backstop
 * (the <Dial> rings for 20 s).
 */
const TRANSFER_TTL_SECONDS = 45;
const ACTIVE_TTL_MS = 3 * 3600_000;

/**
 * Checks before a call is answered: blocked callers, forwarding loops, the number's concurrency
 * cap and the plan's usage limits. Also watches for unusual call volume (toll fraud, a campaign
 * hitting the line) without blocking.
 */
@Injectable()
export class CallGate {
  private readonly logger = new Logger(CallGate.name);

  constructor(
    private readonly redis: RedisService,
    private readonly tenantDb: TenantDbService,
    private readonly alerts: AlertsService,
  ) {}

  async check(route: CallRoute, callSid: string, settings: CallSettings): Promise<GateResult> {
    if (isBlocked(route.callerNumber, settings.blocked)) return { ok: false, reason: "blocked", reject: "rejected" };
    if (await this.redis.client.exists(transferKey(route.tenantId, route.callerNumber)))
      return { ok: false, reason: "loop", reject: "busy" };
    if (route.maxConcurrentCalls !== null) {
      const key = activeKey(route.phoneNumberId);
      await this.redis.client.zremrangebyscore(key, 0, Date.now() - ACTIVE_TTL_MS);
      if ((await this.redis.client.zcard(key)) >= route.maxConcurrentCalls)
        return { ok: false, reason: "busy", reject: "busy" };
    }
    const limit = await this.overLimit(route.tenantId, settings);
    if (limit) {
      await this.alerts.raise(route.tenantId, {
        kind: "usage_limit",
        dedupeKey: limit.key,
        message: limit.message,
        data: { limit: limit.limit },
      });
      return { ok: false, reason: "limit", say: LIMIT_MESSAGE };
    }
    await this.redis.client.zadd(activeKey(route.phoneNumberId), Date.now(), callSid);
    return { ok: true };
  }

  /** The call ended (or was never answered): free its place on the number */
  async release(phoneNumberId: string, callSid: string): Promise<void> {
    await this.redis.client.zrem(activeKey(phoneNumberId), callSid);
  }

  /** About to transfer this caller: calls from them in the next moments are the transfer coming back */
  async markTransfer(tenantId: string, callerNumber: string): Promise<void> {
    await this.redis.client.set(transferKey(tenantId, callerNumber), "1", "EX", TRANSFER_TTL_SECONDS);
  }

  async clearTransfer(tenantId: string, callerNumber: string): Promise<void> {
    await this.redis.client.del(transferKey(tenantId, callerNumber));
  }

  private async overLimit(tenantId: string, s: CallSettings) {
    const db = this.tenantDb.db(tenantId);
    const now = new Date();
    const day = new Date(now.getTime() - 86_400_000);
    const callsToday = await db.call.count({ where: { startedAt: { gte: day } } });
    if (callsToday >= s.limits.maxCallsPerDay)
      return {
        key: `calls-per-day-${now.toISOString().slice(0, 10)}`,
        limit: "maxCallsPerDay",
        message: `Calls are being refused: the plan allows ${s.limits.maxCallsPerDay} calls in 24 hours.`,
      };
    const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const used = await db.call.aggregate({ where: { startedAt: { gte: month } }, _sum: { durationSec: true } });
    if ((used._sum.durationSec ?? 0) / 60 >= s.limits.maxCallMinutesPerMonth)
      return {
        key: `minutes-${now.toISOString().slice(0, 7)}`,
        limit: "maxCallMinutesPerMonth",
        message: `Calls are being refused: this month's ${s.limits.maxCallMinutesPerMonth} call minutes are used up.`,
      };
    return null;
  }

  /**
   * More calls in the last hour than usual (≥ 20 and 5× the hourly average of the past week) may
   * be toll fraud or a flood: tell the owner. Never blocks a call.
   */
  async watchVolume(tenantId: string): Promise<void> {
    try {
      const db = this.tenantDb.db(tenantId);
      const hour = await db.call.count({ where: { startedAt: { gte: new Date(Date.now() - 3_600_000) } } });
      if (hour < 20) return;
      const week = await db.call.count({ where: { startedAt: { gte: new Date(Date.now() - 7 * 86_400_000) } } });
      const average = week / (7 * 24);
      if (hour < average * 5) return;
      await this.alerts.raise(tenantId, {
        kind: "call_spike",
        dedupeKey: `spike-${new Date().toISOString().slice(0, 13)}`,
        message: `Unusual call volume: ${hour} calls in the last hour (usually about ${Math.max(1, Math.round(average))}).`,
        data: { lastHour: hour, hourlyAverage: average },
      });
    } catch (err) {
      this.logger.warn({ err, tenantId }, "call volume check failed");
    }
  }
}

const activeKey = (phoneNumberId: string) => `active:number:${phoneNumberId}`;
const transferKey = (tenantId: string, caller: string) => `xfer:${tenantId}:${caller}`;
