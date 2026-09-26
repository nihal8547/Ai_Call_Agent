# AI Call Agent — Implementation Plan

Build plan for "Ava", a voice agent that answers real estate calls and qualifies leads.
It follows the CodeMatrix7 Voice AI Agent Playbook: the seven-layer stack, the agent loop,
deterministic fallbacks, and maturity levels 1 to 4.

---

## 1. Project analysis

### 1.1 What we are building

An inbound phone agent that:

1. Answers a Twilio phone number and greets the caller.
2. Collects four qualification fields in order: **budget → timeline → location → financing**.
3. Offers a consultation slot and confirms a booking.
4. Exports the structured lead (JSON) to Google Sheets or a CRM.
5. Keeps the conversation going when the LLM fails, using deterministic fallback prompts.

**Success = one completed call produces one validated `QualificationData` record plus a booked slot, or a clean handoff.**

### 1.2 Current repo state

The repository is empty, with no commits. Everything below is greenfield.

### 1.3 Mapping the seven layers to concrete components

| Layer | Component in this repo | Technology |
|---|---|---|
| 1. Caller | — | Phone / PSTN |
| 2. Telephony | `app/telephony/` | Twilio Voice (webhooks → later Media Streams) |
| 3. Voice | Twilio `<Gather input="speech">` + `<Say>` (L1) → Deepgram + Cartesia/ElevenLabs (L4 streaming) | |
| 4. AI Brain | `app/brain/` | Google Gemini 2.5 Flash (`google-genai` SDK) |
| 5. State | `app/state/` | Pydantic v2 + LangGraph; in-memory (L1) → Redis (L3) |
| 6. Tools | `app/tools/` | Google Sheets, calendar (Google Calendar / Cal.com), CRM |
| 7. Outcome | `app/outcomes/` | Lead record, booking, human transfer |

### 1.4 Key design decisions

1. **The LLM is never the source of truth.** It only proposes extractions. Pydantic validates them, and application code decides the next step.
2. **Two execution paths.** On every turn, try the LLM path first. On a timeout, exception, invalid JSON, or guardrail failure, use the deterministic path, which asks for the next missing field.
3. **Tools never block the call.** Sheets, CRM, and email writes run as background tasks: FastAPI `BackgroundTasks` at first, a durable queue (arq/Redis) later.
4. **Start with webhooks, move to streaming later.** Level 1 uses Twilio's built-in speech recognition and TTS. That path is simple, but each turn takes about 1.5 s. Streaming comes in Phase 4, after the logic is proven.

---

## 2. Target architecture

```
Caller ──PSTN──► Twilio Number
                    │  POST /voice/incoming   (TwiML: greeting + <Gather speech>)
                    │  POST /voice/turn       (SpeechResult → agent loop → TwiML)
                    │  POST /voice/status     (call ended → finalize + export)
                    ▼
            ┌──────────────── FastAPI (app/main.py) ────────────────┐
            │  Twilio signature check → rate limit → session load   │
            │                                                       │
            │   LangGraph agent loop (app/graph/)                   │
            │   ┌────────┐  ┌──────────┐  ┌────────┐  ┌──────────┐  │
            │   │ ingest │→ │ extract  │→ │ decide │→ │ respond  │  │
            │   └────────┘  │ (Gemini) │  └────────┘  │ (Gemini) │  │
            │               └────┬─────┘      │       └────┬─────┘  │
            │           fail/timeout          │    fail/timeout     │
            │                    ▼            ▼            ▼        │
            │               ┌──────────────────────────────────┐    │
            │               │ fallback (deterministic prompts) │    │
            │               └──────────────────────────────────┘    │
            │   output guard → TwiML <Say>/<Gather>                 │
            │                                                       │
            │   Session store: memory (L1) / Redis (L3)             │
            │   Background: Sheets export, calendar, CRM            │
            └───────────────────────────────────────────────────────┘
```

---

## 3. Repository layout

```
Ai_Call_Agent/
├── app/
│   ├── main.py                 # FastAPI app factory, routers, lifespan
│   ├── config.py               # pydantic-settings: env vars, timeouts, feature flags
│   ├── telephony/
│   │   ├── routes.py           # /voice/incoming, /voice/turn, /voice/status
│   │   ├── twiml.py            # TwiML builders (say + gather, hangup, dial)
│   │   └── security.py         # X-Twilio-Signature validation dependency
│   ├── state/
│   │   ├── models.py           # QualificationData, CallSession, Stage enum
│   │   └── store.py            # SessionStore protocol: MemoryStore, RedisStore
│   ├── brain/
│   │   ├── llm.py              # Gemini client wrapper with timeout + retries
│   │   ├── prompts.py          # System persona, extraction prompt, response prompt
│   │   └── schemas.py          # LLM structured-output schema (ExtractionResult)
│   ├── graph/
│   │   ├── nodes.py            # ingest, extract, decide, respond, fallback, finalize
│   │   ├── builder.py          # LangGraph StateGraph wiring + conditional edges
│   │   └── fallback.py         # Deterministic per-field prompts
│   ├── guards/
│   │   ├── output_guard.py     # Length, banned content, no raw errors, domain scope
│   │   └── pii.py              # Redaction before persistence/logging
│   ├── tools/
│   │   ├── sheets.py           # Google Sheets export (background)
│   │   ├── calendar.py         # Slot availability + booking
│   │   └── crm.py              # CRM adapter (stub → HubSpot/Zoho later)
│   └── observability/
│       └── logging.py          # structlog JSON logs, per-hop latency timers
├── tests/
│   ├── unit/                   # models, fallback, guards, decide logic
│   ├── graph/                  # full conversations with a fake LLM
│   └── api/                    # webhook tests with signed Twilio requests
├── scripts/
│   └── simulate_call.py        # Text-mode CLI conversation with the agent
├── docs/IMPLEMENTATION_PLAN.md
├── .env.example
├── pyproject.toml              # uv-managed; ruff, mypy, pytest config
├── Dockerfile
├── docker-compose.yml          # app + redis
└── .github/workflows/ci.yml
```

---

## 4. Core data model (Phase 1)

This extends the playbook's `QualificationData` with the fields needed for control flow:

```python
from enum import StrEnum
from typing import Literal, Optional
from pydantic import BaseModel, Field, field_validator

class Stage(StrEnum):
    GREETING = "greeting"
    QUALIFYING = "qualifying"
    BOOKING = "booking"
    CONFIRMED = "confirmed"
    HANDOFF = "handoff"
    ENDED = "ended"

REQUIRED_FIELDS = ("budget", "timeline", "location", "financing")

class QualificationData(BaseModel):
    budget: Optional[str] = Field(None, description="e.g. '80 lakh'")
    timeline: Optional[str] = Field(None, description="e.g. 'next month'")
    location: Optional[str] = Field(None, description="e.g. 'Baner, Wakad'")
    financing: Optional[Literal["bank_loan", "cash", "needs_assistance"]] = None
    bookingSlot: Optional[str] = None
    callCompleted: bool = False

    @field_validator("budget", "timeline", "location")
    @classmethod
    def strip_nonempty(cls, v):
        if v is None:
            return v
        v = v.strip()
        return v or None

    def missing_fields(self) -> list[str]:
        return [f for f in REQUIRED_FIELDS if getattr(self, f) is None]

class CallSession(BaseModel):
    call_sid: str
    caller_number: str
    stage: Stage = Stage.GREETING
    data: QualificationData = QualificationData()
    history: list[dict] = []           # [{"role": "user"|"agent", "text": ...}] (last N turns)
    attempts: dict[str, int] = {}      # re-ask counter per field
    silent_turns: int = 0
    llm_failures: int = 0
    offered_slots: list[str] = []
```

The LLM returns only an `ExtractionResult` (all fields optional, plus `intent`: `answer | question | wants_human | not_interested | off_topic`). Values are merged into `QualificationData` only when they pass validation.

---

## 5. Agent loop as a LangGraph

| Node | Responsibility | On failure |
|---|---|---|
| `ingest` | Take the Twilio `SpeechResult` and `Confidence`. An empty transcript or low confidence increments `silent_turns`. | → `fallback` |
| `extract` | Call Gemini with structured output (`response_schema=ExtractionResult`) and a hard timeout (~2 s). | exception/timeout/invalid → `fallback` |
| `decide` | **Pure Python.** Merge valid fields, then choose the next action: ask for the next missing field → booking → confirm → end. Handle `wants_human` → handoff, and too many retries → handoff. | — |
| `respond` | Gemini writes one or two short spoken sentences that confirm what it heard and ask for exactly one thing. | → `fallback` |
| `fallback` | Deterministic template for the next missing field, e.g. *"Got it, Baner and Wakad. Will you be paying with a bank loan, or directly?"* | never fails |
| `guard` | Output guard: max length, no JSON, no error text, stays in the real estate domain. If a check fails, use the fallback text. | → fallback text |
| `finalize` | Set `callCompleted`, then enqueue the Sheets/CRM export as a background task. | logged, never blocks |

Budgets: at most 2 LLM calls per turn. After 2 consecutive LLM failures, switch the rest of the call to fallback-only mode (a circuit breaker per call). After 3 silent turns, say goodbye politely and hang up.

---

## 6. Phased implementation

### Phase 0 — Prerequisites (½ day)

- [ ] Twilio account, an Indian or test number, account SID + auth token
- [ ] Gemini API key (Google AI Studio)
- [ ] A Google Cloud service account with the Sheets API enabled, and the sheet shared with it
- [ ] Python 3.12, `uv`, Docker, `ngrok` (or cloudflared) for local webhooks
- [ ] `.env.example`: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `GOOGLE_SHEETS_ID`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `PUBLIC_BASE_URL`, `REDIS_URL`, `LLM_TIMEOUT_S`

### Phase 1 — Level 1: Working Starter (3–5 days)

Goal: a real phone call completes the Ava flow end to end.

1. **Scaffold**: `uv init`, then add dependencies: `fastapi uvicorn[standard] pydantic pydantic-settings twilio google-genai langgraph gspread structlog httpx`.
2. **State models** (§4) with unit tests for `missing_fields` and validators.
3. **Fallback engine** (`graph/fallback.py`): a template per field and per retry attempt (a shorter rephrase on the second attempt). Write this before the LLM code so a working path always exists.
4. **Decide node**: pure function `decide(session, extraction) -> Action`. It gets the most tests.
5. **Gemini wrapper**: `extract()` and `respond()` with `asyncio.wait_for` timeouts and JSON schema output. Unit-test them against a `FakeLLM`.
6. **LangGraph wiring** (§5), with conditional edges to `fallback`.
7. **Text simulator** (`scripts/simulate_call.py`): talk to the graph from the terminal. The whole flow can be tested without a phone.
8. **Twilio routes**:
   - `/voice/incoming` → create the session, then `<Say>` greeting + `<Gather input="speech" speechTimeout="auto" language="en-IN" action="/voice/turn">`
   - `/voice/turn` → run the graph, return `<Say>` + `<Gather>`, or `<Hangup>` / `<Dial>`
   - `/voice/status` → finalize the session and export it
   - If no speech arrives, `<Gather>` falls through to a `<Redirect>` back to `/voice/turn` with an empty result, so silence is handled.
9. **Booking v0**: offer two fixed slots from config (the real calendar comes in Phase 5).
10. **Sheets export** as a FastAPI `BackgroundTask`.
11. Run locally behind ngrok, point the Twilio number's webhook at it, and make 10 real test calls.

**Exit criteria:** a real call collects all four fields, books a slot, and writes a row to the sheet. With `GEMINI_API_KEY` set to an invalid value, the call still completes on fallback prompts alone.

### Phase 2 — Level 2: Developer-Ready (2–3 days)

- [ ] `config.py` with `pydantic-settings`: every timeout, model name, and prompt version comes from env
- [ ] Test suite: unit tests, graph conversation tests (scripted transcripts → expected final state), API tests using `twilio.request_validator` to sign requests
- [ ] **Conversation fixtures**: happy path, answers out of order ("budget 80L, want Wakad"), corrections ("actually make it 1 crore"), silence, off-topic, "talk to a human", LLM timeout, LLM invalid JSON
- [ ] `ruff`, `mypy --strict` on `app/state` and `app/graph`, and `pytest` in GitHub Actions CI
- [ ] `Dockerfile` (slim, non-root) + `docker-compose.yml` (app + redis)
- [ ] Prompt versioning: prompts live in `prompts.py` with a `PROMPT_VERSION` that gets logged every turn

### Phase 3 — Level 3: Production-Ready (4–6 days)

- [ ] **Twilio signature validation** (HMAC-SHA1 `X-Twilio-Signature`) as a FastAPI dependency on every `/voice/*` route. Reject with 403.
- [ ] **RedisStore**: sessions keyed by `CallSid`, 1h TTL, optimistic locking (`WATCH` or a per-call lock) so duplicate or retried webhooks do not race
- [ ] **Idempotency**: store the last processed turn per call and replay the cached TwiML on Twilio retries
- [ ] **Rate limiting** per caller number and per IP (e.g. `slowapi` + Redis). Block known-bad numbers.
- [ ] **PII redaction** (phone numbers, emails, card and Aadhaar-like numbers) before logs and transcript storage
- [ ] **Durable background jobs**: move the exports to `arq` (Redis queue) with retries and a dead-letter log
- [ ] **Observability**: structlog JSON with `call_sid`, per-hop timings (`llm_extract_ms`, `llm_respond_ms`, `turn_total_ms`), fallback-used flag, token counts. OpenTelemetry traces are optional.
- [ ] **Metrics / SLOs**: call completion rate, fallback rate, p95 turn latency, drop-off field
- [ ] Secrets from the platform secret manager (Cloud Run Secret Manager / AWS SSM); no `.env` in images
- [ ] Deploy: Cloud Run (or Fly.io/Render) with min instances ≥ 1 to avoid cold starts, plus managed Redis

### Phase 4 — Low-latency streaming voice (1–2 weeks)

The webhook design costs about 1.5 s or more per turn. The target is under 800 ms from when the caller stops speaking to the first audio byte. Two options:

| Option | Path | Trade-off |
|---|---|---|
| **A. Twilio Media Streams** | `<Connect><Stream>` → FastAPI WebSocket → Deepgram streaming ASR → Gemini streaming → Cartesia/ElevenLabs streaming TTS → μ-law 8 kHz back to Twilio | Full control; barge-in and buffering must be written by hand |
| **B. LiveKit Agents** (recommended) | Twilio SIP trunk → LiveKit SIP → LiveKit Agent (Silero VAD, Deepgram, Gemini, Cartesia plugins) | Built-in VAD, turn detection, barge-in, interruption handling |

Work items (the same for either option):
- [ ] Reuse `state/`, `graph/decide`, `fallback`, and `guards` unchanged. Only the transport and voice layers change. The layer separation from Phase 1 is what makes this possible.
- [ ] Stream LLM tokens and send them to TTS in sentence- or clause-sized chunks
- [ ] Barge-in: when VAD detects speech, stop TTS playback and clear buffers (Twilio `clear` message / LiveKit interruption)
- [ ] Endpointing tuned to 300–500 ms of silence; echo handling
- [ ] Filler audio ("One moment…") pre-recorded for slow tool calls
- [ ] Latency dashboard per hop against the budget table (ASR ≤250, LLM TTFT ≤300, TTS ≤150 ms)

### Phase 5 — Level 4: Business-Ready (1–2 weeks)

- [ ] **Real calendar**: Google Calendar free/busy or the Cal.com API. Offer two real slots, book, and send SMS confirmation via Twilio.
- [ ] **CRM integration** (HubSpot / Zoho / Salesforce adapter behind `tools/crm.py`)
- [ ] **Human handoff**: `<Dial>` to the sales line (or SIP REFER), whisper a summary of the collected fields to the human agent, and post the summary to Slack/WhatsApp
- [ ] **Sentiment / frustration triggers** for handoff (repeated re-asks, negative intent)
- [ ] **Cost controls**: per-call token ceiling, max call duration (e.g. 6 min), a global daily spend circuit breaker
- [ ] **Analytics**: a funnel dashboard (answered → budget → timeline → location → financing → booked)
- [ ] **Outbound calling** (optional): call back web-form leads within 60 s
- [ ] **Multilingual** (optional): Hindi/Malayalam via `language` config + multilingual ASR/TTS

---

## 7. Testing strategy

| Level | What | How |
|---|---|---|
| Unit | Models, `decide`, fallback templates, guards, PII redaction | pytest, no network |
| Graph | Full multi-turn conversations | Scripted `FakeLLM` returning fixed extractions/errors |
| API | TwiML output, signature rejection, idempotent retries | `httpx.AsyncClient` + signed requests |
| LLM eval | Extraction accuracy on ~50 real-style Indian English transcripts ("80 L", "around one crore", "Wakad side") | Nightly job; tracks field accuracy per prompt version |
| Failure drills | LLM down, Sheets down, Redis restart, 10 s silence, background noise | Chaos flags in config (`FORCE_LLM_FAILURE=1`) |
| Live | Real calls from 3+ phones/networks | Manual checklist before each release |

---

## 8. Production readiness checklist (gate before real customers)

- [ ] Twilio signature validation on every webhook
- [ ] No secrets in code or images; keys rotated
- [ ] PII redacted in logs; transcript retention policy defined
- [ ] Session state in Redis; survives restart / scale-out
- [ ] Rate limiting + max call duration
- [ ] Per-hop latency, fallback rate, and completion rate dashboards with alerts
- [ ] Deterministic fallback verified with the LLM fully disabled
- [ ] Human handoff tested end-to-end
- [ ] Per-call and daily cost ceilings enforced
- [ ] Call recording / AI disclosure consent line in the greeting (legal compliance)

---

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Twilio ASR is weak on Indian accents and place names | `hints="Baner,Wakad,Hinjewadi,lakh,crore"` on `<Gather>`; Deepgram in Phase 4 |
| LLM mis-normalises money ("80L" vs "8 crore") | Echo-confirm every captured value; validator + normaliser for lakh/crore |
| Webhook latency feels slow | Accept it for L1; Phase 4 streaming |
| Duplicate webhooks corrupt state | Idempotency key per turn + Redis lock |
| Sheets quota / outage | Background queue with retries; never on the call path |
| Prompt injection via caller speech | Extraction is schema-only; output guard; the LLM has no tool that is directly exposed |

---

## 10. Timeline summary

| Phase | Deliverable | Estimate |
|---|---|---|
| 0 | Accounts, keys, tooling | ½ day |
| 1 | Level 1 working phone agent | 3–5 days |
| 2 | Tests, CI, Docker | 2–3 days |
| 3 | Redis, security, observability, deploy | 4–6 days |
| 4 | Streaming low-latency voice | 1–2 weeks |
| 5 | Calendar, CRM, handoff, cost controls | 1–2 weeks |

**Recommended next step:** start Phase 1 steps 1–7. Build the models, fallback, decide logic, and graph first, and test them with the text simulator. Twilio comes after that.
