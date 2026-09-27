# Remaining work

_Last updated: 27 September 2026, after WhatsApp W3 (voice notes)._

What is still to be built, what exists but hasn't been proven against the real service, and known
limits. What has been built is logged phase by phase in
[DEVELOPMENT_PHASES.md](DEVELOPMENT_PHASES.md).

**Priorities:** **P1** needed before selling to real businesses, **P2** important soon after,
**P3** later growth. **Size** is a rough guide: **S** about a day, **M** a few days, **L** a week
or more.

## 0. Where the project stands

| Area                                                                                 | State                   |
| ------------------------------------------------------------------------------------ | ----------------------- |
| Multi-tenant platform, sign-in, 2FA, roles, invitations, password reset, audit log   | Built                   |
| Agents: editor, versions, workflows, test console, templates (incl. Qatar / Arabic)  | Built                   |
| Phone calls through Twilio (webhook mode), existing numbers by forwarding and SIP    | Built, not on real line |
| Knowledge base (RAG) with live-call answers and knowledge gaps                       | Built                   |
| Leads, appointments, lead board, CRM sync (HubSpot, Zoho)                            | Built                   |
| Integrations with one-click sign-in (Google, Microsoft, HubSpot, Zoho) or manual     | Built, not on real APIs |
| Queues, retries, failed deliveries, analytics, usage metering, cost estimates        | Built                   |
| Security hardening, observability, Docker deployment, backups, runbook               | Built                   |
| Streaming voice (Twilio ConversationRelay, per agent)                                | Built, not on real line |
| Platform console: businesses, usage and cost, plans and limits, suspend / reactivate | Built                   |
| Email verification at sign-up (numbers, WhatsApp, SIP, API keys, invites wait)       | Built                   |
| Terms accepted at sign-up; agents say they're an AI assistant (EN / AR)              | Built                   |
| Billing                                                                              | **Not built**           |

## 1. Before launch: must build (P1)

| Item                               | Size | What to build                                                                                                                                                                                                                |
| ---------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Billing**                        | L    | Plans, subscriptions and invoices (Stripe; Razorpay for India), payment webhooks, usage from `usage_records` charged as overage, trial period, "payment failed" grace period then calls refused. A Billing page in Settings. |
| **Twilio subaccount per business** | M    | Every number is on the platform account today; subaccounts separate billing, limits and suspension.                                                                                                                          |
| **Browser tests in CI**            | M    | The Playwright checks are run by hand today; put the main flows (sign up, create agent, test call, connect an integration) in CI.                                                                                            |

## 2. Before launch: prove on real services (P1)

Everything below is built and tested against fakes or simulations; this environment could not
reach the real service. Step by step, with `npm run check:live` for the automatic part:
[LIVE_CHECKS.md](LIVE_CHECKS.md). First run (27 September): the Gemini key is free tier with its
daily quota used up, the Twilio token and SID in `.env` aren't real ones yet, no Meta values.

| Item                         | What to do                                                                                                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real Twilio calls end to end | Buy a number, call it from a phone: speech recognition quality, voices, transfers with whisper, status callbacks                                                |
| Existing numbers in Qatar    | Forward a real Ooredoo and a real Vodafone line; confirm the codes, whether the caller's number is kept, and costs ([QATAR_CALL_SETUP.md](QATAR_CALL_SETUP.md)) |
| SIP connections              | Connect a real carrier SIP trunk or PBX to a Twilio SIP domain                                                                                                  |
| Arabic on phone audio        | Measure Gulf Arabic recognition (`ar-QA`) and the Polly Arabic voices with real callers                                                                         |
| Integrations                 | Register the OAuth apps ([OAUTH_SETUP.md](OAUTH_SETUP.md)); connect real Google Calendar / Sheets / Gmail, Outlook, HubSpot, Zoho and SMTP accounts             |
| Google app verification      | Needed before customers can use Google sign-in outside "Testing" mode (sensitive scopes, including `gmail.send`)                                                |
| Platform email delivery      | A real mail provider for `SMTP_URL`; SPF, DKIM and DMARC for the sending domain                                                                                 |
| WhatsApp on real Meta        | Connect a real number; text, voice notes (Gemini transcription and speech in Arabic, Malayalam, English), delivery ticks, App Review                            |
| Gemini at production load    | Paid quota (the free tier hit its per-minute limit during one call); latency from the Gulf region                                                               |
| Load                         | Repeat the 50-call load test on production-like infrastructure, with the AI on                                                                                  |

## 3. Operations before launch (P1)

- Pick the hosting region (Gulf data residency, if customers require it) and managed Postgres /
  Redis; follow [DEPLOYMENT.md](DEPLOYMENT.md).
- Fresh secrets per environment; **rotate the Gemini key used during development**.
- Register the OAuth apps; put the Microsoft client secret's expiry date in the calendar.
- Set up alert delivery (email / Slack / PagerDuty) for the Prometheus rules; the on-call runbook
  is in [RUNBOOK.md](RUNBOOK.md).
- First restore drill on production backups.
- Align the ports in `.env.example` with `infra/docker-compose.yml` (now 5441 for Postgres and
  6381 for Redis locally).

## 4. Product gaps soon after launch (P2)

| Item                             | Size | Notes                                                                                                                                                                                                                                              |
| -------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Role editor UI                   | S    | Custom roles exist in the API (`/roles`); the web app only assigns the built-in roles                                                                                                                                                              |
| Lead detail page                 | S    | `/leads/[id]` with all answers, calls, appointments, CRM sync history and notes                                                                                                                                                                    |
| Outbound event webhooks          | M    | Settings → Webhooks: signed `call.completed`, `lead.created`, `appointment.booked` events to the business's own systems (today only the per-agent webhook tool exists)                                                                             |
| Business-wide AI defaults        | S    | Default language, voice, AI on/off and tone for new agents (today set per agent)                                                                                                                                                                   |
| Call recordings                  | M    | Record with consent wording, store encrypted, play with signed short-lived links, retention                                                                                                                                                        |
| Outbound calls                   | L    | Call back new web leads within a minute, appointment reminders, campaigns (with do-not-call checks)                                                                                                                                                |
| WhatsApp agent (rest of W4, W5)  | M    | Connecting (incl. WhatsApp Business app numbers), the Inbox with files and templates, staff and agent replies, voice notes are built. Next: the agent sending documents, opt-out, analytics, media retention: [WPIntegration.md](WPIntegration.md) |
| SMS tools                        | M    | Shown as "coming soon" in the agent tools list; confirmations and reminders by message                                                                                                                                                             |
| Outlook / Microsoft 365 Calendar | M    | The Microsoft sign-in exists; add calendar scopes, free/busy and booking like Google Calendar                                                                                                                                                      |
| CRM workflow tools               | S    | `crm.*` tools inside workflows (today leads sync automatically after the call)                                                                                                                                                                     |
| Alerts by email                  | S    | Plan-limit, call-spike and silent-SIP alerts show on the dashboard only; email them to owners                                                                                                                                                      |
| Virus scanning of uploads        | S    | ClamAV (or a cloud scanner) before a document is processed                                                                                                                                                                                         |
| Drag-and-drop workflow editor    | M    | Steps are reordered with buttons today                                                                                                                                                                                                             |
| Live call monitoring             | L    | Staff listen in, whisper or take over (needs streaming voice, section 5)                                                                                                                                                                           |
| Arabic dashboard (web UI)        | M    | Agents speak Arabic, but the web app itself is English only; add translations and a right-to-left layout                                                                                                                                           |
| Dark mode                        | S    | The app is white-and-black by design; dark classes remain in the code and can be switched back on                                                                                                                                                  |

## 5. P13 — Streaming voice (P2)

**Built (phase 1):** per-agent **Streaming** mode on Twilio ConversationRelay: Twilio's streaming
recognition (Deepgram / Google) and voices, barge-in, keypad input, silence re-prompts, "one
moment" on slow replies, turn-by-turn fallback if the stream breaks, per-minute metering and
reply-latency metrics. **Not verified on a real Twilio call** (no network access here).

Still open:

- Measure real latency and Arabic recognition on real calls; tune `RELAY_*` settings.
- Stream the AI's reply as it's written (token by token, sentence chunks) instead of after the
  whole turn; today a turn with AI takes the understanding + phrasing time (about 1–2 s on a paid
  Gemini key; turning off "Natural rephrasing" halves it).
- Own media pipeline for more control and lower cost: Twilio Media Streams (or LiveKit) with
  Gemini Live or Deepgram + ElevenLabs/Cartesia; latency dashboard per hop (target under 800 ms).
- Live call monitoring (listen in, whisper, take over) builds on the streaming session.

## 6. P14 — Advanced AI, RAG and enterprise (P3)

- **AI providers**: OpenAI and Anthropic next to Gemini, per-agent choice, automatic failover,
  small model for understanding and a larger one for answers.
- **RAG**: re-ranking, query rewriting from the conversation, FAQ fast path, per-collection
  chunking, background re-embedding when the embedding model changes.
- **Telephony**: Telnyx / Plivo adapters.
- **Integrations**: Salesforce, Cal.com, WhatsApp Business, a no-code REST tool builder.
- **Enterprise**: SSO (SAML / OIDC), white-labelling, data residency (e.g. Gulf region), custom
  retention per data type, sentiment-based escalation.
- **Languages**: Hindi and Malayalam agents (rules and templates like Arabic), bilingual agents
  that switch language mid-call.

## 7. Known limits today

- One language per agent: English callers are understood by an Arabic agent, but it replies in
  Arabic.
- Without the AI, corrections to an earlier answer ("actually make the budget 90 lakh") aren't
  understood; with the AI they are.
- Hijri dates, Ramadan and Eid hours (date-range hours) aren't supported; single-day holidays are.
- Twilio has few or no Qatar numbers: forwarding goes abroad (international forwarding rates) or
  the business connects over SIP.
- Analytics are up to ~30 s behind; latency percentiles are approximate (hourly buckets).
- Cost figures are estimates from list prices, not invoices.
- The system messages before an agent is known ("this number is not in service") are English only.
- Google sign-in in "Testing" mode: only listed test users, and connections expire after 7 days.

## 8. Suggested order

1. Operations basics and real-service checks (sections 2 and 3), so problems show up early.
2. Billing and Twilio subaccounts (the platform console, email verification and terms are built).
3. Browser tests in CI; then launch to the first businesses.
4. P2 items by customer demand (recordings, outbound calls and WhatsApp are usually asked for
   first), then streaming voice on real calls and its next phases (section 5).
