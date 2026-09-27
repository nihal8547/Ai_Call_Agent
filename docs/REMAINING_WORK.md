# Remaining work

What is still to be built, what exists but hasn't been proven against the real service, and known
limits. Priorities: **P1** needed before selling to real businesses, **P2** important soon after,
**P3** later growth. Built so far: phases P1–P12 and Arabic agents (see
[DEVELOPMENT_PHASES.md](DEVELOPMENT_PHASES.md)).

## 1. Prove it on real services (P1)

Everything below is built and tested against fakes or simulations; this environment could not
reach the real service.

| Item                         | What to do                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Real Twilio calls end to end | Buy a number, call it from a phone: speech recognition quality, voices, transfers with whisper, status callbacks   |
| Existing numbers in Qatar    | Forward a real Ooredoo and a real Vodafone line; confirm the codes, whether the caller's number is kept, and costs |
| SIP connections              | Connect a real carrier SIP trunk or PBX to a Twilio SIP domain                                                     |
| Arabic on phone audio        | Measure Gulf Arabic recognition (`ar-QA`) and the Polly Arabic voices with real callers                            |
| Integrations                 | Real Google Calendar/Sheets, HubSpot, Zoho and SMTP accounts                                                       |
| Gemini at production load    | Paid quota (the free tier hit its per-minute limit during one call); latency from the Gulf region                  |
| Load                         | Repeat the 50-call load test on production-like infrastructure, with the AI on                                     |

## 2. Product gaps (P1–P2)

| Priority | Item                                                     | Notes                                                                                                                                                    |
| -------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1       | **Billing**                                              | Plans, subscriptions and invoices (Stripe / Razorpay), usage from `usage_records`, overage alerts. Plan limits already exist but are set by the operator |
| P1       | **Invitation and notification emails from the platform** | Invitations currently show a link to copy; password reset by email doesn't exist yet                                                                     |
| P1       | **Password reset**                                       | "Forgot password" flow                                                                                                                                   |
| P1       | **Twilio subaccount per business**                       | Today every number is on the platform account; subaccounts separate billing and limits                                                                   |
| P2       | Role editor UI                                           | Custom roles exist in the API; the web app only assigns system roles                                                                                     |
| P2       | Call recordings                                          | Record (with consent wording), store encrypted, play with signed short-lived links                                                                       |
| P2       | Virus scanning of uploads                                | ClamAV (or a cloud scanner) before processing                                                                                                            |
| P2       | Outbound calls                                           | Call back new web leads within a minute, appointment reminders, campaigns                                                                                |
| P2       | SMS / WhatsApp tools                                     | Catalogued as "coming soon"; confirmations and reminders by message                                                                                      |
| P2       | CRM workflow tools                                       | `crm.*` tools in workflows (today leads sync automatically)                                                                                              |
| P2       | Drag-and-drop workflow editor                            | Steps are reordered with buttons today                                                                                                                   |
| P2       | Live call monitoring                                     | Staff listen in, whisper or take over                                                                                                                    |
| P2       | Dark mode                                                | The app is white-and-black by design now; dark classes remain in the code and can be switched back on                                                    |

## 3. P13 — Streaming voice (P2)

Today each turn waits for the caller to stop, then Twilio recognises speech and plays the reply
(about 1–3 s per turn with AI). Streaming makes it feel like a real conversation:

- A voice service (`apps/voice`): LiveKit Agents behind a Twilio SIP trunk, or Twilio Media
  Streams over WebSocket.
- Streaming speech recognition (e.g. Deepgram), voice activity and turn detection, streaming
  LLM tokens, sentence chunking, streaming text-to-speech (e.g. Cartesia / ElevenLabs).
- Barge-in (the caller interrupts), endpointing 300–500 ms, filler audio for slow tools.
- Per-agent choice between webhook and streaming mode; latency dashboard per hop
  (target under 800 ms end to end).
- Likely needed for good Arabic and Malayalam recognition.

## 4. P14 — Advanced AI, RAG and enterprise (P3)

- **AI providers**: OpenAI and Anthropic next to Gemini, per-agent choice, automatic failover,
  small model for understanding and a larger one for answers.
- **RAG**: re-ranking, query rewriting from the conversation, FAQ fast path, per-collection
  chunking, background re-embedding when the embedding model changes.
- **Telephony**: Telnyx / Plivo adapters.
- **Integrations**: Salesforce, Cal.com, WhatsApp Business, a no-code REST tool builder.
- **Enterprise**: SSO (SAML / OIDC), white-labelling, data residency (e.g. Gulf region),
  custom retention per data type, sentiment-based escalation.
- **Languages**: Hindi and Malayalam agents (rules and templates like Arabic), bilingual agents
  that switch language mid-call.

## 5. Known limits today

- One language per agent: English callers are understood by an Arabic agent, but it replies in
  Arabic.
- Without the AI, corrections to an earlier answer ("actually make the budget 90 lakh") aren't
  understood; with the AI they are.
- Hijri dates, Ramadan and Eid hours (date-range hours) aren't supported; single-day holidays are.
- Twilio has few or no Qatar numbers: forwarding goes abroad (international forwarding rates) or
  the business connects over SIP.
- Analytics are up to ~30 s behind; latency percentiles are approximate (hourly buckets).
- Cost figures are estimates from list prices, not invoices.
- The silent-SIP-connection alert shows on the dashboard but isn't emailed.
- The system messages before an agent is known ("this number is not in service") are English only.
- Browser end-to-end checks are run by hand; they are not yet part of CI.

## 6. Operations before launch (P1)

- Pick the hosting region (Gulf data residency, if customers require it) and managed Postgres /
  Redis; follow [DEPLOYMENT.md](DEPLOYMENT.md).
- Fresh secrets per environment; rotate the Gemini key used during development.
- Set up alert delivery (email / Slack / PagerDuty) for the Prometheus rules; on-call runbook
  is in [RUNBOOK.md](RUNBOOK.md).
- Legal: privacy policy and terms; consent wording in greetings where recording or AI disclosure
  is required (Qatar PDPPL, India DPDP Act).
- First restore drill on production backups.
