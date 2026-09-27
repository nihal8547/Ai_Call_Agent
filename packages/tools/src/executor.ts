import type { ToolCall, ToolResult } from "@platform/core";
import { TOOL_SPECS, type ToolName } from "@platform/shared";
import { ToolError, type ToolErrorKind } from "./errors";
import type { GoogleDeps } from "./google/auth";
import { type BookingStore, HANDLERS, TOOL_INPUTS, type ToolBinding, type ToolContext } from "./handlers";

/** Remembers finished tool calls so a retried webhook/turn never repeats a side effect */
export interface ResultCache {
  get(key: string): Promise<ToolResult | null>;
  set(key: string, result: ToolResult): Promise<void>;
}

export type ToolRunEvent = {
  tool: ToolName;
  stepId: string;
  ok: boolean;
  /** Short machine code (e.g. not_connected, slot_unavailable, auth) */
  error?: string;
  /** Technical detail for staff (never spoken to callers) */
  detail?: string;
  integrationId: string | null;
  attempts: number;
  latencyMs: number;
  cached: boolean;
};

export type ExecutorDeps = {
  /** The integration this agent uses for the tool, decrypted (null = none bound or not connected) */
  binding: (tool: ToolName) => Promise<ToolBinding | null>;
  bookings: BookingStore;
  saveLead: (collected: Record<string, unknown>) => Promise<{ leadId: string }>;
  cache?: ResultCache;
  onEvent?: (e: ToolRunEvent) => void;
  /** Credentials or settings were rejected: the integration should show as needing attention */
  onIntegrationError?: (integrationId: string, error: ToolError) => Promise<void> | void;
  fetch?: typeof fetch;
  googleOAuth?: { clientId: string; clientSecret: string };
  microsoftOAuth?: { clientId: string; clientSecret: string };
  /** A provider issued a new refresh token (Microsoft rotates them): store it on the integration */
  onRefreshToken?: (integrationId: string, refreshToken: string) => Promise<void> | void;
  /** Development/tests only: let webhooks and SMTP reach private addresses */
  allowPrivateNetwork?: boolean;
  /** Per attempt */
  timeoutMs?: number;
};

/** Safe to repeat after a timeout: reads, and writes that are idempotent by design */
const RETRYABLE: ReadonlySet<ToolName> = new Set([
  "calendar.find_slots",
  "calendar.book", // deterministic event id
  "calendar.cancel",
  "appointments.create", // idempotent per call and start time
  "leads.create", // upsert per call
]);
const MAX_ATTEMPTS = 2;

export function createToolExecutor(ctx: ToolContext, deps: ExecutorDeps) {
  const timeoutMs = deps.timeoutMs ?? 6000;
  const google: GoogleDeps = {
    fetch: deps.fetch ?? fetch,
    timeoutMs,
    ...(deps.googleOAuth ? { oauthClient: deps.googleOAuth } : {}),
  };

  async function run(call: ToolCall): Promise<ToolResult> {
    const started = Date.now();
    const spec = TOOL_SPECS[call.tool];
    let attempts = 0;
    let integrationId: string | null = null;
    const finish = (result: ToolResult, extra: { detail?: string; cached?: boolean } = {}): ToolResult => {
      deps.onEvent?.({
        tool: call.tool,
        stepId: call.stepId,
        ok: result.ok,
        ...(result.ok ? {} : { error: result.error }),
        ...(extra.detail ? { detail: extra.detail.slice(0, 300) } : {}),
        integrationId,
        attempts,
        latencyMs: Date.now() - started,
        cached: extra.cached ?? false,
      });
      return result;
    };

    // 1. Grant: only tools enabled in the agent's published configuration ever run
    if (!ctx.config.tools.includes(call.tool)) return finish({ ok: false, error: "tool_not_enabled" });
    const handler = HANDLERS[call.tool];
    if (!spec.available || !handler) return finish({ ok: false, error: "tool_not_available" });

    // 2. Same call, same decision: never run twice
    const cacheKey = `${ctx.tenantId}:${call.tool}:${call.idempotencyKey}`;
    const cached = await deps.cache?.get(cacheKey).catch(() => null);
    if (cached) return finish(cached, { cached: true });

    // 3. Input
    const schema = TOOL_INPUTS[call.tool];
    const parsed = schema ? schema.safeParse(call.input) : { success: true as const, data: call.input };
    if (!parsed.success)
      return finish({ ok: false, error: "invalid_input" }, { detail: parsed.error.issues[0]?.message ?? "" });
    const input = { ...parsed.data, collected: call.input.collected ?? {} };

    // 4. Integration
    let binding: ToolBinding | null = null;
    if (spec.integration) {
      binding = await deps.binding(call.tool);
      if (!binding || binding.type !== spec.integration) return finish({ ok: false, error: "not_connected" });
      integrationId = binding.integrationId;
    }

    // 5. Execute with a timeout, retrying only what is safe to repeat
    let lastError: ToolError | null = null;
    while (attempts < (RETRYABLE.has(call.tool) ? MAX_ATTEMPTS : 1)) {
      attempts++;
      try {
        const result = await withTimeout(
          handler(
            {
              call,
              ctx,
              binding,
              bookings: deps.bookings,
              saveLead: deps.saveLead,
              google,
              microsoft: {
                fetch: deps.fetch ?? fetch,
                timeoutMs,
                ...(deps.microsoftOAuth ? { oauthClient: deps.microsoftOAuth } : {}),
                ...(binding && deps.onRefreshToken
                  ? { onRefreshToken: (t: string) => deps.onRefreshToken!(binding.integrationId, t) }
                  : {}),
              },
              allowPrivateNetwork: deps.allowPrivateNetwork ?? false,
              timeoutMs,
            },
            input,
          ),
          timeoutMs * 2,
        );
        // Definitive answers are remembered (a taken slot is not: the caller will pick another time)
        if (result.ok) await deps.cache?.set(cacheKey, result).catch(() => undefined);
        return finish(result);
      } catch (err) {
        lastError =
          err instanceof ToolError
            ? err
            : new ToolError("unavailable", (err as Error).message ?? "tool failed");
        if (!lastError.retryable) break;
        if (attempts < MAX_ATTEMPTS) await sleep(250 * attempts);
      }
    }
    const e = lastError!;
    if (binding && (e.kind === "auth" || e.kind === "config"))
      await Promise.resolve(deps.onIntegrationError?.(binding.integrationId, e)).catch(() => undefined);
    return finish({ ok: false, error: errorCode(e.kind) }, { detail: e.message });
  }

  return { run };
}

function errorCode(kind: ToolErrorKind): string {
  return kind === "auth" || kind === "config" ? "integration_error" : kind;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ToolError("timeout", `Tool took longer than ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
