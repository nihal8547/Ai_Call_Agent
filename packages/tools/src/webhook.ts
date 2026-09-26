import { createHmac } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { ToolError, kindForStatus } from "./errors";
import { guardedLookup, isPrivateAddress } from "./net";

export const SIGNATURE_HEADER = "x-platform-signature";

/** `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">` (receivers should reject old timestamps) */
export function signPayload(secret: string, body: string, timestamp: number): string {
  const mac = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

export type WebhookOptions = {
  allowPrivateNetwork: boolean;
  timeoutMs: number;
  idempotencyKey: string;
  now?: () => number;
};

/**
 * POST JSON to a customer's endpoint. The connection resolves the host itself and refuses
 * private addresses; redirects are not followed; the response body is read up to 64 KB.
 */
export function postWebhook(
  url: string,
  secret: string,
  payload: unknown,
  opts: WebhookOptions,
): Promise<{ status: number }> {
  const target = new URL(url);
  if (target.protocol !== "https:" && target.protocol !== "http:")
    throw new ToolError("config", "Unsupported URL");
  if (target.username || target.password)
    throw new ToolError("config", "Credentials in URLs are not allowed");
  // IP literals skip DNS (and therefore the guarded lookup): check them here
  const literal = target.hostname.replace(/^\[|\]$/g, "");
  if (isIP(literal) && !opts.allowPrivateNetwork && isPrivateAddress(literal))
    throw new ToolError("blocked", "Private addresses are not allowed");
  const body = JSON.stringify(payload);
  const timestamp = Math.floor((opts.now?.() ?? Date.now()) / 1000);
  const client = target.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const req = client.request(
      target,
      {
        method: "POST",
        lookup: guardedLookup(opts.allowPrivateNetwork) as never,
        timeout: opts.timeoutMs,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "user-agent": "VoiceAgentPlatform-Webhook/1",
          "idempotency-key": opts.idempotencyKey,
          [SIGNATURE_HEADER]: signPayload(secret, body, timestamp),
        },
      },
      (res) => {
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 64 * 1024) res.destroy();
        });
        res.on("close", () => {
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) resolve({ status });
          else if (status >= 300 && status < 400)
            reject(new ToolError("config", `Redirects are not followed (${status})`));
          else
            reject(
              new ToolError(
                status === 401 || status === 403 ? "rejected" : kindForStatus(status),
                `Webhook answered ${status}`,
              ),
            );
        });
      },
    );
    req.on("timeout", () => req.destroy(new ToolError("timeout", "Webhook timed out")));
    req.on("error", (err) =>
      reject(
        err instanceof ToolError ? err : new ToolError("unavailable", `Webhook unreachable: ${err.message}`),
      ),
    );
    req.end(body);
  });
}
