# WhatsApp AI chat agent: plan

_Written 27 September 2026, after reviewing commits `fb860a9` and `1d3c770`._

**Status:** W0 and W1 done. W0 fixed every problem in section 1. W1: `@platform/whatsapp`
(signatures, webhook parsing, Graph client), the data model with RLS, the signed webhook,
Continue with Facebook (Embedded Signup) and access-token connect, Settings → WhatsApp and the
Inbox with staff replies, take over / hand back and delivery ticks. Operator guide:
[WHATSAPP_SETUP.md](WHATSAPP_SETUP.md). W2: the agent answers automatically with the same
runtime as calls (knowledge, questions, workflow, bookings, leads), written for WhatsApp, with
hand-over to staff. Next: W3 (voice notes in and out).

**Goal:** a business connects its WhatsApp number (official WhatsApp Business Cloud API) with a
few clicks. Customers' messages, text or voice, get answered automatically by the same agent that
answers the phone: the same questions, knowledge base (RAG), tools, working hours, leads and
appointments. A voice note gets a voice note back. Staff see every conversation with its full
history in an Inbox, and can take over from the AI at any time.

Contents:

1. [Review of the current WhatsApp code](#1-review-of-the-current-whatsapp-code)
2. [How it will work](#2-how-it-will-work)
3. [Connecting WhatsApp (official Cloud API)](#3-connecting-whatsapp-official-cloud-api)
4. [Data model](#4-data-model)
5. [The agent in chat](#5-the-agent-in-chat)
6. [Voice messages in and out](#6-voice-messages-in-and-out)
7. [Inbox and settings UI](#7-inbox-and-settings-ui)
8. [Security, privacy and WhatsApp rules](#8-security-privacy-and-whatsapp-rules)
9. [Phases](#9-phases)
10. [Testing](#10-testing)
11. [Configuration](#11-configuration)
12. [Decisions to confirm](#12-decisions-to-confirm)

---

## 1. Review of the current WhatsApp code

The first WhatsApp commits are a useful sketch (queue, worker slot, chat tables, Inbox page), but
they don't work yet and two parts are unsafe. Checks on the latest code:

| Check            | Result                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------- |
| Typecheck, build | Pass                                                                                     |
| Lint             | **10 errors** (`any`, `import type`) in the WhatsApp files                               |
| Format           | **18 files** not formatted                                                               |
| `db:check`       | **Fails**: no migration for `chat_sessions`, `chat_messages` and the new tenant defaults |
| API tests        | **1 failure**: the WhatsApp webhook routes declare no access policy                      |
| Other tests      | Pass (core 174, db 121, tools 51, API 142 of 143, …)                                     |

### Problems and how each is fixed

| #   | Where                                               | Problem                                                                                                                                                                 | Fix                                                                                                                              |
| --- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `schema.prisma` chat models                         | **No row-level security.** `chat_messages` has no `tenant_id`; any signed-in user who knows a chat id can read it or add messages to another business's chat            | New tables with `tenant_id` on every row, RLS policy like every other table, isolation tests (section 4)                         |
| 2   | `whatsapp.service.ts`                               | `integration.findFirst({ type: 'WHATSAPP' })` ignores the phone number id: messages go to whichever business comes first (or nowhere, under RLS)                        | Look up the business by `phone_number_id` through a `SECURITY DEFINER` function, like `resolve_phone_number` for calls           |
| 3   | `whatsapp.controller.ts`                            | No check of Meta's `X-Hub-Signature-256`: anyone could post fake messages. Verify token check passes when `WHATSAPP_VERIFY_TOKEN` is unset (`undefined === undefined`)  | HMAC-SHA256 of the **raw body** with the Meta app secret, constant-time compare; refuse verification when no token is configured |
| 4   | `whatsapp.controller.ts`                            | No `@Public()`: Meta gets **401** (the failing test)                                                                                                                    | `@Public()` + signature guard + rate limit                                                                                       |
| 5   | `whatsapp.controller.ts`                            | Work done after replying (`.catch(console.error)`): lost on restart, errors only in the console                                                                         | Verify, store and enqueue **before** answering 200; the worker does the rest                                                     |
| 6   | `whatsapp.service.ts`                               | Only `entry[0].changes[0].messages[0]`; no de-duplication (Meta resends); status updates ignored                                                                        | Loop over every entry, change, message and status; unique `wamid`; statuses update ticks                                         |
| 7   | `whatsapp.service.ts`                               | Sessions are created without an agent, so the worker always stops at "no agent assigned"                                                                                | The WhatsApp number is linked to an agent; the conversation takes it                                                             |
| 8   | `apps/worker/src/processors/whatsapp.ts`            | Stub: no AI reply, no sending                                                                                                                                           | Real processor (section 5)                                                                                                       |
| 9   | `chats.controller.ts`                               | `as any`, no input validation, `throw new Error` (500 instead of 404), sending needs only `calls:read`, message saved but never sent                                    | Zod schemas, proper errors, new `chats:read` / `chats:reply` permissions, send through the queue                                 |
| 10  | `inbox/page.tsx`                                    | Mockup: hard-coded "Sure, here is the document… info-brochure.pdf" shown for every chat; selecting a chat and sending don't work; blue styles outside the design system | New Inbox (section 7)                                                                                                            |
| 11  | `packages/shared/src/agent/tools.ts`                | `whatsapp.send` and `whatsapp.send_document` marked available, but there is no handler: an agent using them fails                                                       | Keep them "coming soon" until the handlers exist (phase W4)                                                                      |
| 12  | `slots.ts` (appointments)                           | New Ramadan / Eid date ranges are used for "are we open" but **not** for booking slots: the agent books normal hours during Ramadan                                     | Use the same override lookup in `openingRanges`; tests for both                                                                  |
| 13  | `telephony.service.ts`, `job-processors.service.ts` | `"974"` hard-coded as a fallback (wrong for Indian businesses); jobs queued before the change have no `callingCode`                                                     | Fall back to the business's calling code, then `DEFAULT_COUNTRY_CODE`                                                            |
| 14  | `packages/db/scratch_*.ts/js` (7 files)             | Scratch scripts committed; one deletes data, one writes around RLS                                                                                                      | Remove; add `scratch_*` to `.gitignore`                                                                                          |
| 15  | `.env.example`                                      | A real Twilio number un-commented as `SEED_NUMBER_CLINIC`                                                                                                               | Back to the commented placeholder                                                                                                |
| 16  | `app-shell.tsx`                                     | Inbox uses the Bot icon and `calls:read`                                                                                                                                | `MessageCircle` icon, `chats:read`, unread badge                                                                                 |

Kept as they are (good changes): Qatar as the default country, `callingCode` passed to background
tools and the test console, Ramadan / Eid date ranges in working hours (with fix 12).

---

## 2. How it will work

```
Customer (WhatsApp)
      │ text / voice / image / document
      ▼
Meta Cloud API ──POST──▶ /api/v1/webhooks/whatsapp          (API)
                          1. check X-Hub-Signature-256 (raw body, app secret)
                          2. phone_number_id ─▶ business, WhatsApp number, agent
                          3. store the message once (unique wamid), update the 24-hour window
                          4. enqueue "reply" for this conversation (debounced ~2 s)
                          5. answer 200 quickly
      ▼
whatsapp queue ─────────▶ Worker (one conversation at a time, in order)
                          6. voice note? download ─▶ transcribe (Gemini) ─▶ transcript saved
                          7. AI paused (staff took over)? stop here
                          8. same agent runtime as calls: understanding, RAG, tools, workflow
                          9. mark read + typing indicator, send the reply (text, or voice note)
                         10. lead / appointment / handoff, usage metering
      ▼
Meta ──POST status──▶ sent / delivered / read / failed ticks
      ▼
Inbox (web) ◀── polling every 3 s (SSE later): full history, transcripts, take over, reply
```

**Reuse, not a second engine.** The call runtime (`packages/runtime`) already takes a text turn
(`turn(config, session, { transcript }, ctx)`) and is what the test console uses. WhatsApp uses
it the same way, so agent settings, knowledge, qualification, tools and guards apply to chat with
no duplication. The engine session is saved on the conversation after each turn.

**Where it runs.** The webhook stays tiny and fast (Meta retries slow or failing webhooks). All
slow work (downloads, transcription, AI, speech, sending) happens in the worker, with retries and
the existing failed-jobs list.

---

## 3. Connecting WhatsApp (official Cloud API)

### 3.1 Operator: one-time Meta setup

Done once by the platform operator (a guide like [OAUTH_SETUP.md](OAUTH_SETUP.md) will be
written: `docs/WHATSAPP_SETUP.md`):

1. A **Meta Business portfolio**, verified (business verification in Meta Business Settings).
2. [developers.facebook.com](https://developers.facebook.com/) → **Create app** → type
   **Business** → add the **WhatsApp** product.
3. Become a **Tech Provider** (so other businesses can connect their numbers to this app) and
   submit **App Review** for `whatsapp_business_management` and `whatsapp_business_messaging`.
4. **Facebook Login for Business → Configurations**: create one for **WhatsApp Embedded
   Signup**; note its **configuration ID**.
5. **WhatsApp → Configuration → Webhook**: callback
   `https://<api-domain>/api/v1/webhooks/whatsapp`, verify token = `WHATSAPP_VERIFY_TOKEN`;
   subscribe to **messages** (includes statuses).
6. Put `META_APP_ID`, `META_APP_SECRET`, `META_EMBEDDED_SIGNUP_CONFIG_ID`,
   `WHATSAPP_VERIFY_TOKEN` in the API environment.

Until App Review is approved, only the operator's own business and Meta's **test number** (with
up to 5 registered recipient phones) work: enough for development and demos.

### 3.2 Business: "Continue with Facebook" (Embedded Signup)

In **Settings → WhatsApp** (or Integrations → WhatsApp):

1. **Continue with Facebook** opens Meta's Embedded Signup popup (Facebook JS SDK, the
   configuration ID above).
2. The owner signs in, picks or creates their WhatsApp Business account, adds the phone number,
   verifies it by SMS or call, sets the display name.
3. The popup returns a **code** and the **WABA id** and **phone number id** (session info
   message). The browser sends them to the API.
4. The API, in order:
   - exchanges the code for a business token (`/oauth/access_token`), seals it with the
     business's key (like other integrations);
   - `POST /{waba-id}/subscribed_apps`: this app receives the number's webhooks;
   - `POST /{phone-number-id}/register` with a generated 6-digit PIN (two-step verification);
   - reads the number (display number, verified name, quality rating, messaging limit);
   - saves the WhatsApp number linked to the agent the owner chose.
5. The page shows **Connected** with the number and a **Send test message** button.

The same flow is protected like the other OAuth sign-ins: one-time state, bound to the browser,
audited, owners only (`integrations:manage`).

**The number:** a number used on the WhatsApp or WhatsApp Business **app** must be deleted from
the app first (or migrated with Meta's coexistence option, if the business wants to keep using the
app on the same number). The page says this before starting.

### 3.3 Manual option (for testing or businesses with their own Meta app)

"Other ways to connect": paste a **permanent System User token**, **WABA id** and **phone number
id**. The API checks them with Meta (`GET /{phone-number-id}`), subscribes and saves. The webhook
still comes to the platform's URL; the page shows it and the verify token if the business's own
app must point there.

### 3.4 Disconnecting

**Disconnect** unsubscribes the app from the WABA, deletes the sealed token and stops replies;
conversations stay (until retention removes them).

---

## 4. Data model

Replaces `ChatSession` / `ChatMessage` from the sketch (they have no migration yet, so nothing to
migrate). Every table has `tenant_id` and the standard RLS policy; one migration, reviewed by hand
like the others.

**`whatsapp_numbers`** (one per connected number)

| Column                                    | Notes                                                             |
| ----------------------------------------- | ----------------------------------------------------------------- |
| `tenant_id`, `integration_id`             | The sealed token lives on the `WHATSAPP` integration              |
| `waba_id`, `phone_number_id` (**unique**) | Webhook routing key                                               |
| `display_number`, `verified_name`         |                                                                   |
| `agent_id`                                | Which agent answers                                               |
| `status`                                  | `CONNECTED`, `PENDING`, `DISCONNECTED`, `FLAGGED`, `RESTRICTED`   |
| `quality_rating`, `messaging_limit`       | From Meta (updated by webhook `phone_number_quality_update`)      |
| `settings` (JSON)                         | Reply mode, voice replies, greeting, off-hours behaviour, handoff |

**`conversations`**

| Column                                                               | Notes                                         |
| -------------------------------------------------------------------- | --------------------------------------------- |
| `tenant_id`, `whatsapp_number_id`, `agent_id`                        |                                               |
| `contact_wa_id`, `contact_phone` (E.164), `contact_name`             | From the webhook's `contacts[]` profile name  |
| `mode`                                                               | `AI`, `HUMAN` (staff took over), `CLOSED`     |
| `engine_session` (JSON), `agent_version_id`                          | The runtime's saved state between messages    |
| `last_inbound_at`                                                    | Start of the 24-hour customer service window  |
| `last_message_at`, `last_message_preview`, `unread_count`            | For the Inbox list                            |
| `assignee_id`, `lead_id`                                             | Who handles it; the lead it created           |
| unique (`whatsapp_number_id`, `contact_wa_id`) per open conversation | One open conversation per customer per number |

**`messages`**

| Column                                                    | Notes                                                                                                           |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `tenant_id`, `conversation_id`                            |                                                                                                                 |
| `wamid` (**unique**)                                      | Meta's message id: de-duplicates retries                                                                        |
| `direction`                                               | `INBOUND`, `OUTBOUND`                                                                                           |
| `sender`                                                  | `CUSTOMER`, `AI`, `STAFF` (+ `sent_by_member_id`), `SYSTEM`                                                     |
| `type`                                                    | `TEXT`, `AUDIO`, `IMAGE`, `DOCUMENT`, `VIDEO`, `LOCATION`, `CONTACTS`, `INTERACTIVE`, `TEMPLATE`, `UNSUPPORTED` |
| `text`                                                    | Body or caption                                                                                                 |
| `media_key`, `media_mime`, `media_bytes`, `media_seconds` | File in object storage (never Meta's short-lived URL)                                                           |
| `transcript`, `transcript_language`                       | Voice notes                                                                                                     |
| `status`, `error_code`, `error_title`                     | `RECEIVED`, `QUEUED`, `SENT`, `DELIVERED`, `READ`, `FAILED`                                                     |
| `reply_to_wamid`                                          | Quoted replies                                                                                                  |
| `meta` (JSON)                                             | Sources used, tool calls, latency: shown to staff only                                                          |

**Lookup without a tenant:** `resolve_whatsapp_number(phone_number_id)` → tenant, number, agent,
published version, as a `SECURITY DEFINER` function granted to `app_user` (same pattern as
`resolve_phone_number`).

**Elsewhere:**

- `leads.source = "whatsapp"`, `leads.conversation_id` (new, nullable) next to `call_id`.
- `appointments.conversation_id` (new, nullable).
- `UsageKind`: add `WHATSAPP_MESSAGES`; voice uses the existing `STT_SECONDS` and
  `TTS_CHARACTERS`.
- Retention purge: conversations, messages and their media files older than the business's
  retention period.
- Permissions: `chats:read`, `chats:reply`, `chats:manage` (settings). Owner and manager get all;
  agent role gets read and reply.

---

## 5. The agent in chat

**Per conversation, in order.** Messages for one conversation are processed one at a time (Redis
lock per conversation + a job id per message). Messages that arrive within about **2 seconds** of
each other ("Hi" … "I want a 2BHK" … "in Lusail") are answered together in one reply.

**A turn:**

1. Load the conversation, the agent's published version (pinned per conversation like a call,
   refreshed when a new conversation starts), the business settings.
2. Text for the runtime: the message text; a voice note's transcript; an image or document's
   caption plus a note ("the customer sent a PDF named …"). Unsupported types get a polite
   "please send it as text".
3. `runtime.turn(config, engineSession, { transcript }, ctx)` with the real retriever and the
   real tool executor (same as calls). Channel `whatsapp` goes into the context so prompts can
   adapt.
4. Save the new engine session, the reply, sources and tool calls (staff-only details).
5. Send the reply; follow the engine's control output:
   - **transfer** (the customer wants a person) → mode `HUMAN`, notify staff (email / dashboard
     alert), tell the customer someone will reply; the AI stops answering until staff hand it
     back.
   - **end** → the conversation is `CLOSED`; the next customer message starts a new one.

**Differences from a phone call** (a `channel: "chat"` option in the runtime and prompts):

- Written style: short paragraphs, WhatsApp formatting (`*bold*`, lists), no "I didn't catch
  that"; numbers written, not spelled out. Arabic replies in Arabic script.
- Several questions can be asked in one message only where the workflow allows; otherwise one
  at a time, like calls.
- No silence timeouts. A conversation idle for **24 hours** (configurable) closes itself; a
  new message starts a new one, with the previous summary kept as context.
- Language: detected per message; the agent's language rules from Arabic support apply.

**What it can use:**

- **Knowledge base (RAG):** the agent's collections, grounded answers, same "I'll ask the team"
  fallback and knowledge-gap logging as calls. Sources aren't shown to the customer.
- **Qualification and leads:** answers fill the same fields; a lead is created or updated with
  `source = whatsapp`, the customer's number and name, linked to the conversation. CRM sync runs
  as for calls.
- **Tools:** check availability, book / cancel appointments, save lead, notify staff, webhook,
  email: the existing tool bindings. New in W4: `whatsapp.send_document` (a knowledge document
  marked "shareable", e.g. a brochure) and `whatsapp.send_location`.
- **Working hours:** off-hours behaviour per number: answer normally, take a message, or send the
  closed message. Ramadan / Eid date ranges apply (fix 12).

**Guards:** the existing guards (numbers must come from sources, no promises the business didn't
configure, PII rules) apply. Customer text is data for the model, never instructions (the
existing prompt structure). A per-customer rate limit (e.g. 30 messages / 10 min) stops floods.
"STOP" / "إيقاف" opts the customer out of further automated messages.

---

## 6. Voice messages in and out

### In

1. Webhook: `type: audio` with a media id (voice notes are OGG / Opus).
2. Worker: `GET /{media-id}` → a URL valid for about 5 minutes → download with the business token.
   Size limit (e.g. 16 MB) and duration limit (e.g. 3 minutes; longer: "please send a shorter
   message or type it").
3. Store the file in object storage (`STORAGE_DRIVER`, private), key saved on the message.
4. **Transcribe with Gemini** (audio as inline data, the agent's language as a hint; Gulf Arabic,
   English, Malayalam, Hindi). If Gemini rejects OGG / Opus, convert to FLAC with `ffmpeg` first.
5. The transcript is saved and shown under the voice note in the Inbox, then used as the turn's
   text.
6. Metered as `STT_SECONDS`.

### Out

Setting per number: **reply to voice with voice** (default on), **always text**, or
**voice and text**.

1. The runtime's reply text (short replies only: above ~500 characters, lists or links, the reply
   goes as text).
2. **Text to speech:** Gemini TTS (supports Arabic and English; voice per language, chosen in
   settings) returns PCM audio.
3. `ffmpeg` converts it to **OGG / Opus, mono, 48 kHz** (what WhatsApp plays as a voice note).
4. Upload to Meta (`POST /{phone-number-id}/media`), then send `type: audio` (as a voice note).
5. Stored in object storage too, so staff can play what the AI said. Metered as
   `TTS_CHARACTERS`.

**Needs:** `ffmpeg` in the worker Docker image (`apt-get install ffmpeg`) and on developer
machines. If TTS fails, the reply is sent as text (never silence).

---

## 7. Inbox and settings UI

All in the app's design system (white background, black text, Geist / IBM Plex Sans Arabic,
lucide icons, the existing `Button`, `TextField`, `Alert`, `Badge` components), responsive, right
to left for Arabic text.

### Inbox (`/t/[tenant]/inbox`, sidebar "Inbox" with an unread badge)

```
┌───────────────────────┬────────────────────────────────────────┬──────────────────────┐
│ Search  [All|AI|Needs │  Ahmed Al-Kuwari  +974 5512 3456       │ Contact              │
│  person|Unread]       │  ● AI replying     [Take over]          │  name, number        │
│───────────────────────│────────────────────────────────────────│  lead → status       │
│ ● Ahmed Al-Kuwari 2m  │            ── Today ──                  │  collected answers   │
│   🎤 Voice message    │  ┌ Hi, is the villa in Lusail still ─┐  │  appointments        │
│ ○ +974 3344… 1h       │  └ available?              10:02 ─────┘  │  assignee            │
│   Thanks!             │  ┌─ AI ─────────────────────────────┐  │  notes               │
│ ○ Sara  (Needs person)│  │ Yes, the 4-bedroom villa…  ✓✓ 10:02│  │                      │
│   …                   │  └──────────────────────────────────┘  │  Knowledge used ▸    │
│                       │  ┌ ▶ ▁▃▅▂▆▃ 0:14  (voice) ────────┐    │  (staff only)        │
│                       │  │ "What's the price?" transcript  │    │                      │
│                       │  └─────────────────────────────────┘    │                      │
│                       │────────────────────────────────────────│                      │
│                       │ [ Type a reply…            ] [📎][Send] │                      │
│                       │ Window closes in 21 h                   │                      │
└───────────────────────┴────────────────────────────────────────┴──────────────────────┘
```

- **List:** search by name or number, filters (All, AI handling, Needs a person, Unread, by
  number), last message preview with type icon, time, unread dot, "Needs a person" badge.
- **Thread:** full history with day separators; bubbles for customer / AI / staff (labelled);
  delivery ticks (sent, delivered, read, failed with the reason); voice notes with a player and
  transcript; images and documents with preview / download (signed short-lived links); quoted
  replies; system lines ("Ahmed took over", "Handed back to the AI", "Lead created").
- **Composer:** staff reply as text or with a file. Sending while the AI is on asks to **take
  over** first. **Hand back to AI** resumes automatic replies. After 24 hours without a customer
  message, free text is blocked and a **template** picker appears (W4).
- **Details panel:** contact, lead (link, status, collected answers), appointments, assignee,
  notes; for staff, what the AI used (knowledge sources, tools) per reply.
- **Live:** the list and the open thread refresh every 3 seconds (React Query polling, like live
  calls); server-sent events later.
- **Mobile:** list → thread → details as separate screens.

### Settings → WhatsApp

- Not connected: explanation, **Continue with Facebook** (Embedded Signup), "Other ways to
  connect" (manual token), what's needed (a number not in use on the WhatsApp app).
- Connected: number, verified name, status, quality rating, messaging limit; **answered by**
  (agent); reply mode (text / voice / both), voice for each language; greeting for new
  customers; off-hours behaviour; hand-off rules (keywords, notify whom); **Send test message**;
  **Disconnect**.

### Elsewhere

- Agent editor: a **Channels** note showing which phone numbers and WhatsApp numbers use this
  agent; the test console gets a **Chat style** toggle to preview WhatsApp replies.
- Lead page and list: source badge "WhatsApp" with a link to the conversation.
- Dashboard / analytics: WhatsApp conversations, AI-resolved vs handed over, reply time, voice
  notes; alerts for a quality rating drop or a number flagged by Meta.

---

## 8. Security, privacy and WhatsApp rules

**Security**

- Webhook signature: HMAC-SHA256 over the **raw request body** with `META_APP_SECRET`; the API
  needs a raw-body capture for this route (Fastify content-type parser keeping the buffer; today
  none exists). Constant-time compare; failures logged and counted.
- Verify handshake only when `WHATSAPP_VERIFY_TOKEN` is set, compared in constant time.
- Routing only by `phone_number_id` through the definer function; unknown ids are ignored (200,
  so Meta doesn't retry forever) and logged.
- RLS on all new tables; isolation tests added to the existing suite (another business can't
  read, reply to or list a conversation).
- Tokens sealed with the business's data key; never logged; only the worker decrypts them.
- Media stored privately; the Inbox gets signed links valid for minutes. File type checked by
  content, size limits, no active content served inline.
- Staff replies audited (`chat.reply`, `chat.take_over`, `chat.hand_back`); settings changes
  audited.
- Rate limits: webhook per IP, replies per conversation, staff sends per user.

**Privacy**

- Logs keep the conversation id, never message text or phone numbers (the existing PII rules).
- Retention purge includes messages and media; "Delete conversation" for a data request.
- Greeting can include the AI disclosure required by the business's rules (Qatar PDPPL, India
  DPDP).

**WhatsApp rules (Meta policy)**

- **24-hour customer service window:** free-form replies (AI or staff) only within 24 hours of
  the customer's last message. Auto-replies always are. After 24 hours only approved **message
  templates** can be sent (W4).
- Businesses must follow the WhatsApp Business and Commerce policies; opt-out ("STOP") is
  honoured.
- Pricing is Meta's (per message category; replies within the service window are currently free,
  templates are charged); check Meta's pricing page. Usage is metered so it can be billed.
- Quality rating and messaging limits come from Meta; the settings page shows them, and a drop
  raises a dashboard alert.

---

## 9. Phases

Sizes: **S** about a day, **M** a few days, **L** a week or more.

| Phase  | Size | What                                                                                                                                                                                                                                                                                                                        | Done when                                                                                                     |
| ------ | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **W0** | S    | Fix the current code (section 1): remove the unsafe routes and mock Inbox for now, WhatsApp tools back to "coming soon", Ramadan slots fix, calling-code fallbacks, scratch files, `.env.example`, lint / format / tests / `db:check` green                                                                                 | CI green; no route exposes chat data without RLS                                                              |
| **W1** | L    | Data model + migration + RLS + definer function; webhook with raw-body signature, routing, de-duplication, statuses; Graph client in `packages/whatsapp` (send text, media upload / download, mark read, typing); Embedded Signup + manual connect + disconnect; Settings → WhatsApp; Inbox (read + staff reply, take over) | A message to the connected number appears in the Inbox within seconds; staff can reply; isolation tests pass  |
| **W2** | L    | Worker: per-conversation ordering + debounce; runtime turns with RAG, tools, workflow, working hours; chat style in prompts; leads with source WhatsApp; hand-off to a person with notifications; idle close; usage metering; test console "chat style"                                                                     | Customers get correct, grounded answers; a lead is created; "talk to a person" pauses the AI and alerts staff |
| **W3** | M    | Voice: download, store, transcribe (Gemini), transcript in Inbox; replies as voice notes (Gemini TTS + ffmpeg → OGG / Opus), reply mode and voice settings, fallback to text; `ffmpeg` in the Docker image                                                                                                                  | A Malayalam, Arabic or English voice note gets a correct voice note back; the transcript shows in the Inbox   |
| **W4** | M    | Images and documents in and out; `whatsapp.send_document` (shareable knowledge documents) and `send_location`; message templates (sync approved templates, picker after 24 h); opt-out                                                                                                                                      | The agent can send the brochure; staff can re-open an old conversation with a template                        |
| **W5** | M    | Analytics and dashboard cards, quality alerts, server-sent events for the Inbox, retention purge, docs (`WHATSAPP_SETUP.md`, project docs), load test (100 conversations)                                                                                                                                                   | Numbers match the database; purge removes media; docs let a new operator set it up                            |

Order: W0 first (small, makes the branch safe and green), then W1 → W2 give a working text agent;
W3 adds voice; W4 and W5 complete it.

---

## 10. Testing

- **Unit (`packages/whatsapp`):** payload parsing for every message type and status, signature
  check (good, bad, missing, altered body), 24-hour window, Graph client requests (fake fetch),
  OGG / Opus conversion call.
- **API (`apps/api/test/whatsapp*.test.ts`):** signed webhook → stored once (repeat ignored) →
  job queued; unknown number ignored; bad signature 401; verify handshake; Embedded Signup with a
  faked Graph (token exchange, subscribe, register); staff reply, take over, hand back;
  isolation (another business gets 404); permissions.
- **Worker:** a text message → runtime reply → Graph send (faked); debounce joins quick messages;
  order kept under concurrency; hand-off pauses the AI; voice note → transcript (fake Gemini) →
  TTS (fake) → ffmpeg → media upload → audio sent; TTS failure → text.
- **Browser (Playwright):** connect with a stand-in for Meta's popup, a conversation appears live,
  take over, reply, hand back, voice note plays with its transcript, Arabic right to left, mobile
  layout, no CSP violations.
- **Real:** Meta's test number and the operator's own business number: text, voice in Arabic and
  English, a booking, a hand-off. Not possible from this development environment (network
  policy); to be done on a machine with internet access.

---

## 11. Configuration

New environment variables (API and worker):

| Variable                         | Where       | Purpose                                                      |
| -------------------------------- | ----------- | ------------------------------------------------------------ |
| `META_APP_ID`                    | api, web    | Embedded Signup and token exchange                           |
| `META_APP_SECRET`                | api         | Token exchange and webhook signatures                        |
| `META_EMBEDDED_SIGNUP_CONFIG_ID` | api, web    | Facebook Login for Business configuration                    |
| `WHATSAPP_VERIFY_TOKEN`          | api         | Webhook verification handshake (random, ≥ 32 characters)     |
| `META_GRAPH_VERSION`             | api, worker | Graph API version (e.g. `v23.0`), so upgrades are one change |
| `WHATSAPP_MEDIA_MAX_MB`          | worker      | Largest media downloaded (default 16)                        |
| `FFMPEG_PATH`                    | worker      | Optional, when `ffmpeg` isn't on the `PATH`                  |

Gemini (`GEMINI_API_KEY`) is used for transcription and speech; without it, voice notes get a
text reply asking the customer to type, and replies are text only.

The web app's Content Security Policy must allow Facebook's SDK and popup
(`connect.facebook.net`, `www.facebook.com`) on the WhatsApp settings page only.

---

## 12. Decisions to confirm

1. **Speech provider:** Gemini TTS (one key, Arabic supported) is the plan. ElevenLabs or Azure
   give more natural Gulf Arabic voices at extra cost; the TTS step is behind an interface so it
   can change later.
2. **Coexistence:** should businesses be able to keep using the WhatsApp Business app on the same
   number (Meta's coexistence onboarding), or only the API?
3. **Tech Provider:** the operator registers as a Meta Tech Provider (needed for other businesses
   to connect). Until approved, only the operator's own numbers work.
4. **Human replies after 24 hours:** templates only (Meta's rule); which templates to prepare
   first (follow-up, appointment reminder)?
5. **Billing:** WhatsApp usage per business will be metered; how it is charged is part of the
   Billing item in [REMAINING_WORK.md](REMAINING_WORK.md).
