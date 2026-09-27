#!/usr/bin/env node
/* eslint-disable no-console -- a command-line report */
/**
 * Live checks against the real services, run from where the platform runs (server or laptop with
 * the tunnel up):  npm run check:live   (reads .env; --burst also probes Gemini's rate limit)
 *
 * Checks the public address, Twilio (credentials, numbers pointed at this API, webhook
 * signatures end to end), Meta (app secret, WhatsApp webhook subscription, verify token, signed
 * webhook end to end) and Gemini (key, quota tier, latency, speech model). Never prints secrets.
 * Exits 1 if anything failed.
 */
import { createHmac } from "node:crypto";

const env = process.env;
const burst = process.argv.includes("--burst");
const results = [];
const add = (area, name, status, detail = "", fix = "") => results.push({ area, name, status, detail, fix });
const timeout = (ms) => AbortSignal.timeout(ms);

async function get(url, init = {}) {
  const t = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: timeout(init.ms ?? 15_000) });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    return { ok: res.ok, status: res.status, text, json, ms: Date.now() - t };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      text: "",
      json: null,
      ms: Date.now() - t,
      error: err.cause?.code ?? err.name,
    };
  }
}

const unreachable = (r) => r.status === 0;
const base = (env.PUBLIC_BASE_URL ?? "").replace(/\/$/, "");

// ── 1. Public address ─────────────────────────────────────────────────────────
async function publicAddress() {
  if (!base)
    return add(
      "Public address",
      "PUBLIC_BASE_URL",
      "fail",
      "not set",
      "Set it to the API's public HTTPS address",
    );
  const local = /\/\/(localhost|127\.|10\.|192\.168\.|0\.0\.0\.0)/.test(base);
  if (local || !base.startsWith("https://"))
    add(
      "Public address",
      "PUBLIC_BASE_URL",
      "fail",
      local ? "points at this machine; Twilio and Meta can't reach it" : "not HTTPS",
      "Use the tunnel or server address, e.g. https://abc.trycloudflare.com (no /api/v1, no trailing slash)",
    );
  else add("Public address", "PUBLIC_BASE_URL", "ok", "public HTTPS address");
  const h = await get(`${base}/health`);
  if (h.ok && h.json?.status === "ok")
    add("Public address", "Reachable from the internet", "ok", `${h.ms} ms`);
  else
    add(
      "Public address",
      "Reachable from the internet",
      "fail",
      unreachable(h) ? `no answer (${h.error})` : `HTTP ${h.status}`,
      "Start the API and the tunnel; the tunnel must point at the API port (4000), not the web app",
    );
}

// ── 2. Twilio ────────────────────────────────────────────────────────────────
async function twilio() {
  const token = env.TWILIO_AUTH_TOKEN ?? "";
  const sid = env.TWILIO_ACCOUNT_SID ?? "";
  if (!token)
    return add(
      "Twilio",
      "TWILIO_AUTH_TOKEN",
      "fail",
      "not set",
      "Twilio Console → Account info → Auth Token",
    );
  add(
    "Twilio",
    "TWILIO_AUTH_TOKEN format",
    /^[0-9a-f]{32}$/.test(token) ? "ok" : "fail",
    /^[0-9a-f]{32}$/.test(token)
      ? "32 hex characters"
      : `${token.length} characters; a Twilio auth token is 32 hex characters`,
    "Copy the Auth Token again (not the SID, not a placeholder)",
  );
  if (!/^AC[0-9a-f]{32}$/.test(sid))
    add(
      "Twilio",
      "TWILIO_ACCOUNT_SID",
      sid ? "fail" : "warn",
      sid ? "not an AC… id" : "not set: numbers can't be checked or bought from the app",
      "Twilio Console → Account info → Account SID",
    );
  // Webhook signatures end to end, through the public address (unknown call: nothing is changed)
  if (base) {
    const url = `${base}/telephony/twilio/status`;
    const params = {
      CallSid: "CAlivecheck00000000000000000000000",
      CallStatus: "completed",
      From: "+10000000000",
      To: "+10000000001",
    };
    const sig = createHmac("sha1", token)
      .update(
        Object.keys(params)
          .sort()
          .reduce((a, k) => a + k + params[k], url),
      )
      .digest("base64");
    const signed = await get(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig },
      body: new URLSearchParams(params).toString(),
    });
    add(
      "Twilio",
      "Signed webhook accepted",
      signed.status === 204 ? "ok" : "fail",
      signed.status === 204
        ? "the API checks Twilio's signature with this token and URL"
        : unreachable(signed)
          ? "public address unreachable"
          : `HTTP ${signed.status}`,
      signed.status === 403
        ? "The API runs with a different TWILIO_AUTH_TOKEN or PUBLIC_BASE_URL than this file: restart it after changing .env"
        : signed.status === 503
          ? "The API has no TWILIO_AUTH_TOKEN: set it and restart"
          : "",
    );
  }
  if (!/^AC[0-9a-f]{32}$/.test(sid)) return;
  const api = (env.TWILIO_API_BASE_URL ?? "https://api.twilio.com").replace(/\/$/, "");
  const user =
    env.TWILIO_API_KEY_SID && env.TWILIO_API_KEY_SECRET
      ? `${env.TWILIO_API_KEY_SID}:${env.TWILIO_API_KEY_SECRET}`
      : `${sid}:${token}`;
  const auth = { authorization: `Basic ${Buffer.from(user).toString("base64")}` };
  const acct = await get(`${api}/2010-04-01/Accounts/${sid}.json`, { headers: auth });
  if (!acct.ok)
    return add(
      "Twilio",
      "Credentials",
      "fail",
      unreachable(acct) ? `can't reach Twilio (${acct.error})` : `HTTP ${acct.status}`,
      acct.status === 401 ? "SID and token don't match" : "",
    );
  add(
    "Twilio",
    "Account",
    acct.json.status === "active" ? (acct.json.type === "Trial" ? "warn" : "ok") : "fail",
    `${acct.json.status}, ${acct.json.type}`,
    acct.json.type === "Trial"
      ? "Trial accounts play a trial message and call verified numbers only: upgrade"
      : "",
  );
  const nums = await get(`${api}/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json?PageSize=100`, {
    headers: auth,
  });
  const list = nums.json?.incoming_phone_numbers ?? [];
  if (!list.length)
    return add(
      "Twilio",
      "Numbers",
      "warn",
      "no numbers on this account",
      "Buy one in the app (Settings → Phone numbers) or in the Console",
    );
  const want = `${base}/telephony/twilio/voice`;
  for (const n of list) {
    const right = n.voice_url === want && (n.voice_method ?? "POST").toUpperCase() === "POST";
    add(
      "Twilio",
      `Number ${n.phone_number}`,
      right ? "ok" : "fail",
      right ? "calls come to this API" : `Voice URL is ${n.voice_url || "(empty)"}`,
      right ? "" : `Set "A call comes in" to ${want} (HTTP POST), or reconnect the number in the app`,
    );
  }
}

// ── 3. Meta (WhatsApp) ───────────────────────────────────────────────────────
async function meta() {
  const id = env.META_APP_ID ?? "";
  const secret = env.META_APP_SECRET ?? "";
  const verify = env.WHATSAPP_VERIFY_TOKEN ?? "";
  if (!id && !secret)
    return add(
      "WhatsApp (Meta)",
      "Meta app",
      "skip",
      "META_APP_ID / META_APP_SECRET not set",
      "Needed for WhatsApp: docs/WHATSAPP_SETUP.md",
    );
  for (const [k, v] of Object.entries({
    META_APP_ID: id,
    META_APP_SECRET: secret,
    WHATSAPP_VERIFY_TOKEN: verify,
    META_EMBEDDED_SIGNUP_CONFIG_ID: env.META_EMBEDDED_SIGNUP_CONFIG_ID ?? "",
  }))
    if (!v)
      add(
        "WhatsApp (Meta)",
        k,
        k === "META_EMBEDDED_SIGNUP_CONFIG_ID" ? "warn" : "fail",
        "not set",
        k === "META_EMBEDDED_SIGNUP_CONFIG_ID"
          ? "Without it, businesses connect with an access token only"
          : "docs/WHATSAPP_SETUP.md",
      );
  const graph = `${(env.META_GRAPH_BASE_URL ?? "https://graph.facebook.com").replace(/\/$/, "")}/${env.META_GRAPH_VERSION ?? "v23.0"}`;
  if (id && secret) {
    const appToken = `${id}|${secret}`;
    const app = await get(`${graph}/${id}?fields=name&access_token=${encodeURIComponent(appToken)}`);
    if (!app.ok)
      add(
        "WhatsApp (Meta)",
        "App ID and secret",
        "fail",
        unreachable(app)
          ? `can't reach Meta (${app.error})`
          : (app.json?.error?.message ?? `HTTP ${app.status}`),
        "Meta app → App settings → Basic",
      );
    else {
      add("WhatsApp (Meta)", "App ID and secret", "ok", `app "${app.json.name}"`);
      const subs = await get(`${graph}/${id}/subscriptions?access_token=${encodeURIComponent(appToken)}`);
      const wa = subs.json?.data?.find((s) => s.object === "whatsapp_business_account");
      const want = `${base}/api/v1/webhooks/whatsapp`;
      if (!wa)
        add(
          "WhatsApp (Meta)",
          "Webhook",
          "fail",
          "no WhatsApp webhook on the app",
          `WhatsApp → Configuration → Webhook: ${want}`,
        );
      else {
        add(
          "WhatsApp (Meta)",
          "Webhook callback URL",
          wa.callback_url === want && wa.active ? "ok" : "fail",
          wa.callback_url === want ? (wa.active ? "this API" : "not active") : `is ${wa.callback_url}`,
          `Set it to ${want} and verify`,
        );
        const fields = (wa.fields ?? []).map((f) => f.name ?? f);
        const missing = [
          "messages",
          "smb_message_echoes",
          "account_update",
          "phone_number_quality_update",
        ].filter((f) => !fields.includes(f));
        add(
          "WhatsApp (Meta)",
          "Webhook fields",
          missing.includes("messages") ? "fail" : missing.length ? "warn" : "ok",
          missing.length ? `missing: ${missing.join(", ")}` : "all subscribed",
          "WhatsApp → Configuration → Webhook fields → Subscribe",
        );
      }
    }
  }
  if (base && verify) {
    const r = await get(
      `${base}/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(verify)}&hub.challenge=livecheck123`,
    );
    add(
      "WhatsApp (Meta)",
      "Verify token",
      r.text === "livecheck123" ? "ok" : "fail",
      r.text === "livecheck123"
        ? "the API answers Meta's check"
        : unreachable(r)
          ? "public address unreachable"
          : `HTTP ${r.status}`,
      "Restart the API after setting WHATSAPP_VERIFY_TOKEN",
    );
  }
  if (base && secret) {
    const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
    const r = await get(`${base}/api/v1/webhooks/whatsapp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`,
      },
      body: raw,
    });
    add(
      "WhatsApp (Meta)",
      "Signed webhook accepted",
      r.ok ? "ok" : "fail",
      r.ok
        ? "the API checks Meta's signature with this secret"
        : unreachable(r)
          ? "public address unreachable"
          : `HTTP ${r.status}`,
      r.status === 401 ? "The API runs with a different META_APP_SECRET: restart it" : "",
    );
  }
}

// ── 4. Gemini ────────────────────────────────────────────────────────────────
async function gemini() {
  const key = (env.GEMINI_API_KEY ?? "").trim();
  if (!key)
    return add(
      "Gemini",
      "GEMINI_API_KEY",
      "warn",
      "not set: agents use rules only, no voice notes",
      "Google AI Studio → Get API key",
    );
  const api = "https://generativelanguage.googleapis.com/v1beta";
  const headers = { "x-goog-api-key": key, "content-type": "application/json" };
  const models = await get(`${api}/models?pageSize=200`, { headers });
  if (!models.ok)
    return add(
      "Gemini",
      "API key",
      "fail",
      unreachable(models)
        ? `can't reach Google (${models.error})`
        : (models.json?.error?.message ?? `HTTP ${models.status}`),
      "Check the key in Google AI Studio",
    );
  add("Gemini", "API key", "ok", "accepted");
  const names = (models.json.models ?? []).map((m) => m.name);
  const tts = env.GEMINI_TTS_MODEL || "gemini-2.5-flash-preview-tts";
  add(
    "Gemini",
    `Speech model ${tts}`,
    names.includes(`models/${tts}`) ? "ok" : "warn",
    names.includes(`models/${tts}`) ? "available" : "not listed for this key",
    "Set GEMINI_TTS_MODEL to a speech model the key lists",
  );
  const model = "gemini-flash-latest";
  const call = () =>
    get(`${api}/models/${model}:generateContent`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Reply with OK" }] }],
        generationConfig: { maxOutputTokens: 5, temperature: 0, thinkingConfig: { thinkingBudget: 0 } },
      }),
    });
  const runs = [];
  for (let i = 0; i < (burst ? 20 : 3); i++) runs.push(await call());
  const quota = runs
    .map((r) =>
      r.json?.error?.details
        ?.find((d) => String(d["@type"]).includes("QuotaFailure"))
        ?.violations?.map((v) => v.quotaId)
        .join(","),
    )
    .find(Boolean);
  const ok = runs
    .filter((r) => r.ok)
    .map((r) => r.ms)
    .sort((a, b) => a - b);
  if (quota?.includes("FreeTier"))
    add(
      "Gemini",
      "Quota",
      "fail",
      `free tier, limit reached (${quota})${ok.length ? `; ${ok.length}/${runs.length} calls passed first` : ""}`,
      "Turn on billing for the key's Google Cloud project (AI Studio → API keys → the project → Set up billing); without it calls fall back to rules",
    );
  else if (!ok.length)
    add(
      "Gemini",
      "Replies",
      "fail",
      runs.map((r) => r.json?.error?.status ?? r.status).join(", "),
      "Try again later; if it keeps failing, check the key's project in Google Cloud",
    );
  else
    add(
      "Gemini",
      "Replies",
      ok[Math.floor(ok.length / 2)] > 1500 ? "warn" : "ok",
      `${ok.length}/${runs.length} passed, median ${ok[Math.floor(ok.length / 2)]} ms${burst ? " (burst)" : ""}`,
      burst
        ? ""
        : "A free-tier key works until its per-minute/day limit: run with --burst, and make sure billing is on",
    );
}

await publicAddress();
await twilio();
await meta();
await gemini();

const icon = { ok: "✓", warn: "!", fail: "✕", skip: "–" };
let area = "";
for (const r of results) {
  if (r.area !== area) console.log(`\n${(area = r.area)}`);
  console.log(`  ${icon[r.status]} ${r.name}${r.detail ? `: ${r.detail}` : ""}`);
  if (r.fix && r.status !== "ok") console.log(`      → ${r.fix}`);
}
const fails = results.filter((r) => r.status === "fail").length;
const warns = results.filter((r) => r.status === "warn").length;
console.log(`\n${fails ? `${fails} to fix` : "Nothing to fix"}${warns ? `, ${warns} to look at` : ""}.`);
process.exitCode = fails ? 1 : 0;
