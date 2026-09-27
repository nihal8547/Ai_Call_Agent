#!/usr/bin/env node
/**
 * Load test: N simultaneous phone calls through signed Twilio webhooks against a running API,
 * each a full conversation with think time between turns. Reports reply latency (what a caller
 * waits for after speaking) and errors, and the server's own p95 from /metrics.
 *
 *   API_URL=http://localhost:4000 PUBLIC_BASE_URL=… TWILIO_AUTH_TOKEN=… node scripts/loadtest.mjs [calls=50]
 *
 * Creates its own business, agent and number (the API must allow adding a number by hand, i.e.
 * no TWILIO_ACCOUNT_SID, or run it as a platform owner).
 */
import { createHmac, randomInt } from "node:crypto";

const API = process.env.API_URL ?? "http://localhost:4000";
const PUBLIC = process.env.PUBLIC_BASE_URL ?? API;
const TOKEN = process.env.TWILIO_AUTH_TOKEN;
const CALLS = Number(process.argv[2] ?? 50);
if (!TOKEN) throw new Error("TWILIO_AUTH_TOKEN is required");

const sign = (url, params) =>
  createHmac("sha1", TOKEN)
    .update(Object.keys(params).sort().reduce((a, k) => a + k + params[k], url))
    .digest("base64");

async function webhook(path, params) {
  const started = performance.now();
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sign(`${PUBLIC}${path}`, params) },
    body: new URLSearchParams(params),
  });
  const xml = await res.text();
  const ms = performance.now() - started;
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  const next = /<Gather[^>]* action="([^"]+)"/.exec(xml)?.[1]?.replace(/&amp;/g, "&").replace(PUBLIC, "");
  return { ms, next };
}

/** A browser-like client for set-up (cookies + CSRF) */
const jar = new Map();
async function api(method, path, body) {
  const headers = { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") };
  if (body) headers["content-type"] = "application/json";
  if (jar.get("csrf_token")) headers["x-csrf-token"] = jar.get("csrf_token");
  const res = await fetch(`${API}/api/v1${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  for (const c of res.headers.getSetCookie()) {
    const [kv] = c.split(";");
    const [k, v] = kv.split("=");
    jar.set(k, v);
  }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function setup() {
  const stamp = Date.now().toString(36);
  await api("POST", "/auth/register", {
    name: "Load test",
    email: `load-${stamp}@example.com`,
    password: "Str0ng-Passw0rd!",
    businessName: `Load test ${stamp}`,
  });
  const agent = await api("POST", "/agents", { name: `Load ${stamp}`, templateKey: "clinic-reception" });
  const detail = await api("GET", `/agents/${agent.id}`);
  const config = { ...detail.draft.config, workingHours: undefined };
  await api("PUT", `/agents/${agent.id}/draft`, { config });
  await api("POST", `/agents/${agent.id}/publish`);
  const e164 = `+9180${randomInt(10_000_000, 99_999_999)}`;
  await api("POST", "/phone-numbers", { e164, agentId: agent.id });
  return e164;
}

const LINES = ["Priya Nair", "teeth cleaning", "I'm flexible", "Is there parking for patients?", "tomorrow", "11 am", "yes"];
const think = () => new Promise((r) => setTimeout(r, randomInt(800, 2000)));

async function oneCall(to, i) {
  const base = { CallSid: `CAload${Date.now()}${i}${randomInt(1e6)}`, From: `+9197${String(10_000_000 + i).slice(-8)}`, To: to, CallStatus: "in-progress" };
  const lat = [];
  let r = await webhook("/telephony/twilio/voice", base);
  lat.push(r.ms);
  for (const line of LINES) {
    if (!r.next) break;
    await think();
    r = await webhook(r.next, { ...base, SpeechResult: line, Confidence: "0.9" });
    lat.push(r.ms);
  }
  await webhook("/telephony/twilio/status", { ...base, CallStatus: "completed", CallDuration: "60" });
  return lat;
}

const pct = (a, p) => a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];

const to = await setup();
console.log(`${CALLS} simultaneous calls to ${to} …`);
const started = performance.now();
const results = await Promise.allSettled(Array.from({ length: CALLS }, (_, i) => oneCall(to, i)));
const lat = results.flatMap((r) => (r.status === "fulfilled" ? r.value : [])).sort((a, b) => a - b);
const failed = results.filter((r) => r.status === "rejected");
console.log(
  JSON.stringify(
    {
      calls: CALLS,
      failedCalls: failed.length,
      firstError: failed[0]?.reason?.message ?? null,
      replies: lat.length,
      replyMs: { p50: Math.round(pct(lat, 50)), p95: Math.round(pct(lat, 95)), p99: Math.round(pct(lat, 99)), max: Math.round(lat.at(-1)) },
      wallSeconds: Math.round((performance.now() - started) / 1000),
    },
    null,
    2,
  ),
);
if (failed.length) process.exitCode = 1;
