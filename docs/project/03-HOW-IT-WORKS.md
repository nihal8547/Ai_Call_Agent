# 3. How it works

## A phone call, step by step

```
Caller dials ─▶ Twilio ─▶ POST /telephony/twilio/voice  (signed)
                             │
                             ├─ 1. Verify Twilio's signature (reject anything unsigned)
                             ├─ 2. Route: which business and agent own this number?
                             │     Twilio number (by "To"), forwarded line ("ForwardedFrom"),
                             │     or SIP domain (sip:+974…@name.sip.twilio.com)
                             ├─ 3. Test call? ("Your number is connected") → done
                             ├─ 4. Call gate: blocked caller? transfer loop? number busy?
                             │     plan limits reached? → polite refusal or reject
                             ├─ 5. Create the call, start the engine → greeting + first question
                             └─ 6. Reply with TwiML: <Gather input="speech"><Say>…</Say></Gather>
Caller speaks ─▶ Twilio speech recognition ─▶ POST /telephony/twilio/turn  (SpeechResult, turn number)
                             │
                             ├─ Lock the call (one turn at a time), load its state from Redis
                             │  (or rebuild it from Postgres if Redis lost it)
                             ├─ Runtime runs the turn (below), within ~3 s
                             ├─ Save state (Redis + Postgres snapshot), write the timeline
                             └─ Reply: the next question, a transfer (<Dial>) or goodbye (<Hangup/>)
Call ends ─▶ POST /telephony/twilio/status
                             └─ Close the call: outcome, summary, lead, usage and cost,
                                analytics roll-up, CRM sync and notifications (queued)
```

Retries are safe: every turn has a sequence number, so a webhook Twilio sends twice returns the
same reply instead of running the turn again.

## One turn inside the runtime

```
caller's words
   │
   ├─▶ Understanding (AI, 2.5 s max) ──────┐  intent + fields as JSON, e.g.
   │       fails or slow? → rules          │  {intent:"answer", fields:{budget:2500000}}
   ├─▶ Knowledge search (in parallel, 0.9 s)│
   │                                       ▼
   │                         Core engine (pure, deterministic)
   │                           · validates every value (a date is a real date, …)
   │                           · updates the call: collected fields, attempts, step
   │                           · runs the workflow: next question, branch, confirm, tool, handoff
   │                           · answers questions only from knowledge (or "our team will confirm")
   │                           · writes the reply as sentences ("segments")
   │                                       │
   ├─▶ Tools the step needs (book, check slots, save lead …) — blocking or queued
   ├─▶ Phrasing (AI, with what is left of the 3 s budget) makes the reply sound natural
   │       rejected if it changes any number, drops the question, or sounds like an error
   └─▶ Guard: no technical words, markup, links or secrets ever reach the caller
```

Key idea: **the AI helps, but never decides alone.** The engine is the single source of truth
for what was collected and what happens next. When the AI is slow, down or wrong, the call
continues on deterministic rules (English, Hindi-English and Arabic) and sounds a little less
natural. After two AI failures in a call, a circuit breaker stops calling the AI for that call.

## The agent configuration

An agent is one JSON document (validated with zod) stored per version:

- identity: business name, agent name, greeting, persona, language, voice
- `qualificationFields`: questions with type, options, validation, re-ask wording
- `workflow.steps`: `greeting`, `collect_fields`, `branch`, `confirm_and_act`, `tool`, `say`,
  `handoff`, `end`, each pointing to the next by id
- knowledge collections, tools, handoff number and messages, working hours, escalation rules,
  appointment rules, AI model settings, call limits, fallback sentences

Publishing freezes a version; calls always run on the version they started with.

## Understanding without AI (the rules path)

The `core` normalisers turn speech into values: "80 lakh" → 8000000, "مليون ونص" → 1500000,
"next Saturday" / "الأحد الجاي" → a date in the business's time zone, "half past five" /
"خمس ونص العصر" → 17:30, spoken digits → an E.164 phone number, "my name is …" / "اسمي …" → a
name, and free speech → the closest configured option (with synonyms). Yes/no, "I want a
person", "not interested" and questions are recognised in English, Hindi-English and Arabic.

## Knowledge (RAG)

1. **Upload** → the file type is checked from its bytes; text is extracted (PDF, Word, Excel,
   CSV, text, OCR for images).
2. **Chunking** into passages of a target size with overlap, keeping headings and tables.
3. **Embedding** with Gemini (or local hashing embeddings offline) into `vector(768)`.
4. **Search** during a call: vector search (HNSW index) and keyword search (Postgres full text),
   filtered by business, collection and agent, merged and ranked.
5. **Answer**: the AI writes an answer only from the passages found, citing them; every number in
   the answer must appear in a passage. Otherwise the agent gives the safe answer and records a
   knowledge gap.

## Tools and queues

- A **blocking** tool (check availability, book, cancel) runs during the turn; the engine gets its
  result and continues ("that time is taken; I have 11 AM or 3 PM").
- A **background** tool (save lead, email staff, webhook, CRM, Google Sheets) goes to a BullMQ
  queue and never delays the caller.
- Each queue has retries with growing waits (webhooks and CRM 6 tries, email 4, analytics 3).
  Jobs that use up their retries land in **Failed deliveries**, where they can be sent again
  (idempotency keys stop duplicates).
- Tools only run if the agent has them enabled and the business has connected the service;
  outbound requests to private networks are blocked.

## The worker

| Job                                                  | When                                                 |
| ---------------------------------------------------- | ---------------------------------------------------- |
| Document ingestion (extract, chunk, embed)           | On upload / reprocess                                |
| Analytics roll-up per hour                           | ~30 s after each call, plus a sweep every 10 minutes |
| Retention purge (old transcripts and caller numbers) | Nightly 02:30                                        |
| Quiet SIP connection check                           | Hourly                                               |

## Sign-in and permissions

- Signing in sets two httpOnly cookies: a short **access token** (15 minutes) and a
  **refresh token** (30 days, rotated on every use; reuse of an old one revokes the session).
- With two-step sign-in, the password step returns a one-time ticket; the code step finishes it.
- Every API route declares the permissions it needs (e.g. `agents:write`, `billing:write`);
  roles are sets of permissions; the web app hides what you can't do, and the API enforces it.

## Multi-tenancy

Each request resolves the business from the session (or API key) and runs its queries inside a
transaction that sets `app.tenant_id`. Postgres Row-Level Security then only shows that
business's rows, even if application code forgets a filter.
