# Universal AI Voice Agent Platform — Implementation Plan

This is the build plan for a **multi-tenant, configurable, RAG-powered, business-agnostic AI Voice Agent SaaS platform**.
It keeps the architecture of the original "Ava" voice agent (CodeMatrix7 Voice AI Agent Playbook): the seven-layer stack, the agent loop, deterministic fallbacks, schema validation, background tool execution, and maturity levels 1–4. On top of that it adds:

- multi-tenancy
- configurable agents
- configurable qualification fields and workflows
- document upload and a knowledge base with RAG
- permission-based tools and integrations
- a full management frontend

> **Core rule:** the core code contains no business vocabulary (budget, property, financing, patient, …). Every business-specific item is tenant data: agent config, qualification schema, workflow, knowledge, and tools. Ava (real estate) becomes one **seed template**, not the product.

---

## 1. Project analysis

### 1.1 What changed from the first plan

| Area                 | Original plan (Ava)                             | Updated plan (Platform)                                                                                               |
| -------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Scope                | One real estate agent                           | Many businesses (tenants), many agents per tenant                                                                     |
| Qualification fields | Hard-coded `budget/timeline/location/financing` | Per-agent configurable fields (type, required, order, validation)                                                     |
| Flow                 | Fixed LangGraph flow                            | Generic LangGraph engine driven by a per-agent workflow config                                                        |
| Knowledge            | None; the LLM relies on general knowledge       | Document upload → extraction → chunking → embeddings → pgvector → RAG on live calls                                   |
| State storage        | Memory → Redis                                  | Redis (live call state) + PostgreSQL (system of record) + pgvector                                                    |
| Tools                | Sheets and calendar wired in code               | Tool registry + per-tenant integrations + per-agent permissions + encrypted credentials                               |
| LLM                  | Gemini                                          | Provider abstraction: Gemini / OpenAI / Claude                                                                        |
| Telephony            | Twilio                                          | Provider abstraction: Twilio first; Telnyx/Plivo/SIP later                                                            |
| UI                   | None                                            | Full management web app (dashboard, agents, knowledge, calls, leads, appointments, integrations, analytics, settings) |
| Security             | Webhook signature, rate limits                  | + auth, RBAC, tenant isolation (RLS), credential encryption, audit logs, usage limits                                 |

### 1.2 Current repo state

The repo contains only this plan, so all code is still to be written (greenfield).

### 1.3 Mapping the seven layers to components (unchanged structure, generalised)

| Layer        | Component                                          | Technology                                                                  |
| ------------ | -------------------------------------------------- | --------------------------------------------------------------------------- |
| 1. Caller    | —                                                  | Phone / PSTN / WebRTC                                                       |
| 2. Telephony | `app/telephony/` (provider interface)              | Twilio Voice → Telnyx / Plivo / SIP later                                   |
| 3. Voice     | `app/voice/`                                       | Twilio Speech + TTS (L1–L3) → Deepgram + ElevenLabs/Cartesia streaming (L4) |
| 4. AI Brain  | `app/brain/` (LLM provider interface) + `app/rag/` | Gemini / OpenAI / Claude; RAG over pgvector                                 |
| 5. State     | `app/state/`, `app/workflows/`                     | LangGraph + Pydantic (dynamic models), Redis, PostgreSQL                    |
| 6. Tools     | `app/tools/`, `app/integrations/`                  | CRM, Sheets, Calendar, Cal.com, Email, WhatsApp, Webhooks, REST             |
| 7. Outcome   | `app/outcomes/`, `app/leads/`, `app/appointments/` | Lead, booking, enquiry, human handoff                                       |

A new cross-cutting layer, **Management & Configuration** (`frontend/` + `app/api/`), feeds layers 2–7 with tenant data.

### 1.4 Key design decisions

1. **The LLM is never the source of truth.** It proposes extractions and answers. A zod schema built from the agent's qualification fields validates them, and deterministic application code decides the next step.
2. **Two execution paths on every turn.** The LLM path runs first. The deterministic fallback takes over on LLM timeout, provider failure, invalid JSON, Pydantic validation failure, RAG failure, tool failure, or a guardrail violation. The caller never hears a technical error.
3. **Configuration over code.** Agents, fields, workflows, tools, and knowledge are rows and versioned JSON documents, not Python code. Adding a new business requires no deploy.
4. **Tenant isolation at three levels:**
   - every table carries `tenant_id`
   - PostgreSQL Row-Level Security enforces the tenant filter
   - the repository layer always scopes queries by tenant

   Vectors follow the same rules.

5. **Published agent versions.** Editing an agent creates a draft, and publishing freezes a version. Each call pins the `agent_version_id` it started with, so config edits never change a call already in progress, and call records can be audited later.
6. **Grounded answers only.** Business-specific facts must come from retrieved chunks above a similarity threshold. Otherwise the agent gives a safe "I'll have someone confirm that" and creates a follow-up or handoff.
7. **Tools never block the call.** Non-critical tools (CRM push, Sheets, email, webhooks) run in the background: BullMQ queues on Redis. Critical tools such as slot lookup run with hard timeouts and have fallbacks.
8. **Start with webhooks, move to streaming later.** L1–L3 use Twilio `<Gather input="speech">`, which is simple and robust. L4 moves to streaming while reusing the same state, workflow, RAG, and guard code.

---

## 2. Target architecture

```
                         BUSINESS USERS
                               │  HTTPS (JWT cookie / API key)
                               ▼
               ┌──────── MANAGEMENT UI (Next.js) ────────┐
               │ Dashboard · Agents · Knowledge · Calls  │
               │ Leads · Appointments · Integrations     │
               │ Analytics · Settings                    │
               └──────────────────┬──────────────────────┘
                                  ▼
┌────────────────────── NestJS API + workers ───────────────────────────┐
│  api/ ─ auth/RBAC ─ tenant context (sets RLS tenant) ─ audit log      │
│                                                                       │
│  Management APIs: agents, documents, knowledge, leads, calls,         │
│                   appointments, integrations, analytics, settings     │
│                                                                       │
│  Telephony webhooks ── signature check ── rate limit ── number→agent  │
│        │                                                              │
│        ▼                                                              │
│  AI ORCHESTRATOR (LangGraph, config-driven)                           │
│   ingest → understand(intent+extract) ─┬→ retrieve(RAG) ─┐            │
│                                        └────────────────┐│            │
│                 decide (pure Python, workflow + schema) ◄┘            │
│                   │            │             │                        │
│               respond      run_tool      handoff/end                  │
│                   │            │                                      │
│        ┌──────────┴──── fallback (deterministic) ◄── any failure      │
│        ▼                                                              │
│      output guard → TwiML / audio                                     │
│                                                                       │
│  Live call state: Redis    System of record: PostgreSQL + pgvector    │
│  Background workers (BullMQ): document ingestion, exports, CRM, email,   │
│                            webhooks, analytics roll-ups               │
└───────────────────────────────────────────────────────────────────────┘
         ▲                                      │
       Twilio ◄── PSTN ◄── CALLER               ▼
                              Object storage (S3/GCS/MinIO) for documents, recordings
```

---

## 3. Technology stack

> **Updated:** the platform is built in **TypeScript end-to-end with Prisma + PostgreSQL**. Full details, and the Python → TypeScript mapping, are in [`DEVELOPMENT_PHASES.md` §0](./DEVELOPMENT_PHASES.md#0-stack-decision-typescript-end-to-end-with-prisma). Pydantic snippets in this document describe the schema shape; they are implemented as zod schemas in `packages/shared`.

| Concern                     | Choice                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| API server                  | NestJS (Fastify adapter), REST `/api/v1`, OpenAPI generated from zod                                               |
| Validation                  | zod, shared by API, workers and frontend                                                                           |
| Database / ORM              | PostgreSQL 16 + Prisma (schema: `packages/db/prisma/schema.prisma`); RLS + pgvector in hand-written SQL migrations |
| Vector store                | pgvector (HNSW, cosine) in the same database                                                                       |
| Cache / live state / queues | Redis + BullMQ                                                                                                     |
| Orchestration               | LangGraph.js around a pure-TypeScript decision core (`packages/core`)                                              |
| LLM / embeddings            | Provider interfaces: Gemini (default), OpenAI, Anthropic                                                           |
| Document extraction         | unpdf/pdf.js, mammoth, papaparse, exceljs, tesseract.js (or LLM vision)                                            |
| Object storage              | S3-compatible (MinIO locally)                                                                                      |
| Telephony / speech          | Twilio (provider interface) → Deepgram + Cartesia/ElevenLabs streaming, LiveKit Agents                             |
| Frontend                    | Next.js (App Router) + TypeScript, Tailwind, shadcn/ui, TanStack Query, react-hook-form + zod                      |
| Auth                        | argon2id, JWT access + rotating refresh tokens in httpOnly cookies, API keys                                       |
| Observability               | pino, OpenTelemetry, Prometheus/Grafana                                                                            |
| Tests                       | Vitest, Supertest, Testcontainers, Playwright                                                                      |

---

## 4. Repository layout

A pnpm + Turborepo monorepo. The full tree and dependency rules are in [`DEVELOPMENT_PHASES.md` §1](./DEVELOPMENT_PHASES.md#1-monorepo-structure).

```
apps/      api (NestJS) · worker (BullMQ) · web (Next.js) · voice (streaming, L4)
packages/  db (Prisma) · shared (zod) · core (engine) · runtime (graph) · ai · rag · telephony · tools · crypto
templates/ seed agent templates (real-estate/Ava, clinic, hotel, restaurant)
```

**Layer boundaries:**

- `core` is pure logic.
- `runtime` is the only package that combines `core`, `ai`, `rag`, `tools`, and state.
- `telephony` knows nothing about LLMs.
- `web` never imports `db`.

---

## 5. Multi-tenant data model

Implemented in [`packages/db/prisma/schema.prisma`](../packages/db/prisma/schema.prisma), with RLS in `packages/db/prisma/migrations/*_rls`.

Every table below has `tenant_id` (except `tenants` and `users`). RLS policy: `tenant_id = current_setting('app.tenant_id')::uuid`.

| Table                        | Key columns                                                                                                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenants`                    | id, name, slug, industry, timezone, plan, status, usage_limits                                                                                                    |
| `users`                      | id, email, password_hash, is_platform_owner                                                                                                                       |
| `memberships`                | user_id, tenant_id, role_id                                                                                                                                       |
| `roles` / `role_permissions` | role name, permission strings (e.g. `agents:write`, `calls:read_transcript`)                                                                                      |
| `agents`                     | id, tenant_id, name, status (active/inactive), current_version_id                                                                                                 |
| `agent_versions`             | id, agent_id, version, `config` JSONB (validated by `AgentConfig`), status (draft/published), published_by                                                        |
| `phone_numbers`              | e164, provider, provider_sid, tenant_id, agent_id                                                                                                                 |
| `knowledge_collections`      | id, tenant_id, name, description                                                                                                                                  |
| `agent_collections`          | agent_id, collection_id                                                                                                                                           |
| `documents`                  | id, tenant_id, collection_id, filename, mime, size, storage_key, checksum, status, error, enabled, version, metadata JSONB                                        |
| `document_agents`            | document_id, agent_id (optional: restrict a document to specific agents)                                                                                          |
| `document_chunks`            | id, tenant_id, collection_id, document_id, ordinal, text, tokens, metadata JSONB (page, heading, sheet/row), `embedding vector(768)`, embedding_model             |
| `integrations`               | id, tenant_id, type (crm_hubspot, google_calendar, …), `credentials_encrypted`, config JSONB, status                                                              |
| `agent_tools`                | agent_id, tool_name, integration_id, config JSONB, enabled                                                                                                        |
| `calls`                      | id, tenant_id, agent_id, agent_version_id, provider_call_sid, from/to, started/ended, duration, status, outcome, qualification_status, recording_key, cost fields |
| `call_events`                | call_id, seq, type (turn_user, turn_agent, extraction, rag_retrieval, tool_call, fallback, guard, handoff), payload JSONB, latency_ms                             |
| `leads`                      | id, tenant_id, call_id, agent_id, customer_name, phone, `data` JSONB (validated against the agent's field schema), status_id, source, follow_up_at                |
| `lead_statuses`              | tenant-configurable list, order, is_terminal                                                                                                                      |
| `appointments`               | id, tenant_id, lead_id, call_id, agent_id, start/end, status (upcoming/completed/cancelled/rescheduled), external_ref                                             |
| `usage_records`              | tenant_id, call_id, kind (llm_tokens, embed_tokens, telephony_minutes, tts_chars), qty, cost                                                                      |
| `audit_logs`                 | tenant_id, actor, action, entity, before/after, ip, at                                                                                                            |
| `api_keys`                   | tenant_id, hashed_key, scopes, last_used                                                                                                                          |

Indexes:

- `document_chunks`: HNSW on `embedding`, plus a btree on `(tenant_id, collection_id)`.
- `calls`: `(tenant_id, started_at)`.
- `leads`: `(tenant_id, status_id)`.

---

## 6. Agent configuration (business-agnostic)

`agent_versions.config` holds this document. It is validated by the zod `AgentConfig` schema and edited in the UI.

```python
class QualificationField(BaseModel):
    key: str                          # slug, e.g. "service_required"
    label: str                        # "Service required"
    question: str                     # "Which service are you looking for?"
    type: Literal["text","number","select","multiselect","boolean","date","time","phone","email"]
    options: list[str] = []           # for select/multiselect
    required: bool = True
    order: int
    validation: dict = {}             # min/max, regex, min_length, date_in_future...
    reask_prompts: list[str] = []     # deterministic re-ask texts (fallback)
    confirm_back: bool = False        # read the value back to the caller

class AgentConfig(BaseModel):
    name: str
    language: str = "en-IN"
    voice: VoiceConfig                # provider voice id, speed
    greeting: str
    persona: str                      # personality/tone
    instructions: str                 # system instructions
    business_rules: list[str]         # "Never quote prices not in the knowledge base", ...
    qualification_fields: list[QualificationField]
    workflow: WorkflowDefinition      # §8
    knowledge: KnowledgeConfig        # collection ids, top_k, min_score, allow_general_knowledge=False
    tools: list[str]                  # tool names the agent MAY call (must match agent_tools)
    allowed_actions: list[str]        # "book_appointment", "create_lead", "transfer"...
    escalation: EscalationRules       # triggers → handoff target
    handoff: HandoffConfig            # number / SIP URI, whisper summary, off-hours behaviour
    working_hours: WorkingHours       # per weekday, holidays, timezone; off-hours message/flow
    appointment: AppointmentConfig | None  # duration, buffer, calendar tool, lead time, slots offered
    llm: LLMConfig                    # provider, model, temperature, timeout_s
    limits: CallLimits                # max duration, max turns, max tokens
```

`AgentConfig.validate_publish()` checks that referenced tools are connected, collections exist, workflow steps reference real fields and tools, and working hours are valid.

### 6.1 Dynamic qualification schema

`state/dynamic_schema.py` turns `qualification_fields` into:

1. **A runtime zod schema**, built from the field list, with one validator per field type (number parsing incl. "80 lakh"/"1.2 crore"/"50k" normalisers, date parsing, select → closest option match, phone → E.164).
2. **A JSON schema for LLM structured output**: every field optional, plus `intent`, `question_text`, `wants_human`, `sentiment`.
3. **Fallback prompts**: `field.question` and `field.reask_prompts`.

The LLM output is validated field by field, so valid fields are kept and invalid ones are dropped and re-asked. A single bad field never corrupts the whole state.

### 6.2 Generic call session

```python
class CallSession(BaseModel):
    call_id: UUID
    tenant_id: UUID
    agent_version_id: UUID
    caller: str
    step_id: str                      # current workflow step
    collected: dict[str, Any] = {}    # only validated values
    attempts: dict[str, int] = {}
    history: list[Turn] = []          # last N turns
    rag_sources: list[ChunkRef] = []
    pending_questions: list[str] = []  # unanswered business questions → follow-up
    silent_turns: int = 0
    llm_failures: int = 0             # per-call circuit breaker
    tokens_used: int = 0
    outcome: Outcome | None = None
```

---

## 7. RAG knowledge system

### 7.1 Document ingestion pipeline (background job)

```
Upload (presigned PUT to object storage)   status=uploading
  → register document                     status=processing
  → extract (by MIME type)                status=extracting
      pdf: pdfplumber (text + tables); scanned pages → OCR
      docx: python-docx (headings, tables); txt: decode/normalise
      csv/xlsx: each row → "Header: value; ..." record (keep sheet/row metadata)
      images: OCR (Tesseract or LLM vision)
  → clean (whitespace, headers/footers, boilerplate, dedupe)
  → chunk (structure-aware: split on headings, ~300–500 tokens, 10–15% overlap;
           tables/rows kept whole; metadata: page, heading path, sheet, row)
  → embed (batched, with rate limit + retry)  status=embedding
  → upsert chunks in one transaction; swap old version's chunks atomically on replace
                                          status=ready | failed(error message)
```

- Upload rules: an allowlist of MIME types, a size limit per plan, a checksum dedupe per tenant, and a malware scan hook (ClamAV) before extraction.
- Replace: a new document version is ingested first, then the old chunks are deleted in the same transaction, so the knowledge base never has a gap.
- Disable: `documents.enabled=false`. The retriever filters it out immediately, with no re-embedding.
- Delete: removes chunks, the storage object, and the row, and writes an audit log entry.
- Status changes are pushed to the UI via polling (L2) or Server-Sent Events (L3).

### 7.2 Retrieval (tenant-aware)

```sql
SELECT c.id, c.text, c.metadata, 1 - (c.embedding <=> :q) AS score
FROM document_chunks c
JOIN documents d ON d.id = c.document_id
WHERE c.tenant_id = :tenant_id                -- also enforced by RLS
  AND c.collection_id = ANY(:agent_collection_ids)
  AND d.enabled
  AND (NOT EXISTS (SELECT 1 FROM document_agents da WHERE da.document_id = d.id)
       OR EXISTS (SELECT 1 FROM document_agents da WHERE da.document_id = d.id AND da.agent_id = :agent_id))
ORDER BY c.embedding <=> :q
LIMIT :top_k;
```

pgvector ≥ 0.8 iterative index scans keep filtered HNSW queries accurate.

### 7.3 RAG during live calls

```
Transcript → understand (intent: answer_field | question | both | wants_human | off_topic)
   ├─ question? → retrieve (parallel with extraction, timeout ~400 ms)
   │      ├─ best score ≥ min_score → grounded answer (LLM gets only these chunks,
   │      │                            must cite chunk ids; guard checks the citations)
   │      └─ nothing relevant / timeout / error → SAFE RESPONSE:
   │             "I don't have that detail right now — I'll have our team confirm it for you."
   │             + add to pending_questions → follow-up task / handoff per escalation rules
   └─ then continue the workflow (ask the next missing field)
```

- Voice answers are kept short (1–2 sentences) and never read raw tables aloud.
- Every retrieval is logged as a `call_events` row (query, chunk ids, scores, used/unused). The call detail page shows this as "RAG sources used".
- The prompt says the model must not answer business-specific questions from general knowledge. The output guard rejects answers containing prices, dates, or numbers that are not in the retrieved context. A rejected answer falls back to the safe response.

---

## 8. Configurable workflow engine

A workflow is a list of typed steps stored in the agent config. **LangGraph is compiled once. It executes this config and does not generate code from it.**

```yaml
steps:
  - id: greet          type: greeting
  - id: collect        type: collect_fields   fields: [customer_name, service_required, preferred_date]
  - id: check_slots    type: tool             tool: calendar.find_slots   on_error: offer_callback
  - id: book           type: confirm_and_act  action: calendar.book       requires: [preferred_date]
  - id: lead           type: tool             tool: crm.create_lead       background: true
  - id: offer_callback type: say              text: "Our team will call you back within the day."
  - id: end            type: end
global:
  answer_questions: true      # RAG Q&A allowed at any step
  handoff_on: [wants_human, frustration>=2, reask_limit, out_of_hours_urgent]
```

Step types:

- `greeting`
- `collect_fields`
- `tool`
- `confirm_and_act`
- `say`
- `branch`, with conditions on collected values, e.g. `urgency == "high"` → handoff
- `handoff`
- `end`

Graph nodes (all generic):

| Node         | Responsibility                                                                                                                                                                                                     | On failure                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| `ingest`     | Normalise the transcript. Empty or low-confidence input increments `silent_turns`.                                                                                                                                 | → `fallback`                  |
| `understand` | One LLM call: intent + field extraction (dynamic JSON schema), with a hard timeout                                                                                                                                 | → `fallback`                  |
| `retrieve`   | RAG when the intent includes a question                                                                                                                                                                            | → safe response               |
| `decide`     | **Pure Python.** Merges validated fields, evaluates the workflow step, and selects the next action (ask field / answer / run tool / confirm / handoff / end). Applies escalation rules, working hours, and limits. | —                             |
| `run_tool`   | Tool executor (permission-checked)                                                                                                                                                                                 | → step `on_error` or fallback |
| `respond`    | The LLM phrases the reply: acknowledgement + (grounded answer) + exactly one next question                                                                                                                         | → `fallback`                  |
| `fallback`   | Deterministic text from config (field question / re-ask / safe response / goodbye)                                                                                                                                 | never fails                   |
| `guard`      | Length, no JSON or error text, no secrets, scope, citation check, PII                                                                                                                                              | → fallback text               |
| `finalize`   | Resolve the outcome, persist the lead/appointment, enqueue exports                                                                                                                                                 | background, retried           |

Budgets and circuit breakers (from the original plan):

- At most 2 LLM calls per turn.
- After 2 consecutive LLM failures, the rest of the call runs in fallback-only mode.
- After 3 silent turns, the agent says goodbye politely.
- Per-call token and duration ceilings apply.
- Per-tenant daily spend ceilings apply.

---

## 9. Tools & integrations

- **Tool definition** (`tools/registry.py`): name, description, JSON input/output schema, `side_effect` (read / write), `critical` (runs inline with a timeout) vs `background`.
- **Executor**:
  1. Check that the tool is in `agent_tools` for this agent version and enabled.
  2. Load and decrypt the integration credentials.
  3. Validate the input.
  4. Apply a timeout and retry with backoff.
  5. Attach an idempotency key (`call_id + step_id`).
  6. Write a `call_events` row and an audit record.
- **Built-in tools**: Google Sheets append, Google Calendar (free/busy, book, cancel), Cal.com, email (SMTP/SendGrid), WhatsApp (Twilio/Meta), generic outbound webhook (HMAC-signed), generic REST API tool (tenant-defined endpoint + schema), CRM adapters (HubSpot, Zoho, Salesforce) behind one `CRMProvider` interface, and the internal DB (leads/appointments).
- **Connection flow**: Settings → Integrations → Connect → OAuth or API key → test connection → configure → enable per agent.
- **Credential security**: envelope encryption. A per-tenant data key encrypts the credentials, and a master key held in KMS or the secret manager encrypts the data keys. Credentials are never returned by any API; the UI sees only `connected`, the last 4 characters, and `expires_at`. OAuth refresh tokens are rotated.
- **The LLM never picks tools freely.** `decide` + the workflow choose the tool. The LLM only fills the typed arguments, which are validated before execution.

---

## 10. Telephony, voice & LLM abstractions

- `TelephonyProvider` protocol: `parse_inbound(request) → InboundTurn`, `render(reply) → Response`, `transfer(call, target)`, `hangup`, `verify_signature`, `provision_number`. Twilio comes first. The Telnyx/Plivo adapters only have to implement this interface.
- Number routing: the inbound `To` number → `phone_numbers` → tenant + active agent version. Unknown numbers get a polite hang-up and an alert.
- Twilio account model:
  - L1–L2: one platform account.
  - L3: **Twilio subaccounts per tenant**, for isolation, per-tenant billing, and toll-fraud containment.
- `LLMProvider` protocol: `generate(messages, schema?, timeout)`, `stream(...)`, and token accounting. Implementations for Gemini, OpenAI, and Anthropic. Provider fallback order is configurable per agent (L4).
- `VoiceProvider`: Twilio built-in first; streaming ASR/TTS in L4.

---

## 11. Management frontend

Next.js app (`frontend/`), responsive, talking only to `/api/v1`, with the tenant chosen via a switcher for multi-tenant users.

| Section                                  | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Dashboard**                            | KPI tiles: total/answered/completed/failed calls, qualified leads, appointments, human transfers, avg duration, AI usage, estimated cost, conversion; trends by day; per-agent breakdown                                                                                                                                                                                                                                                                                            |
| **AI Agents**                            | List, create (from a template: real estate / clinic / hotel / restaurant / blank), edit, delete, activate/deactivate. Tabs: Profile (name, voice, language, greeting), Behaviour (persona, instructions, business rules, allowed actions), Qualification (drag-and-drop field builder), Workflow (step list editor), Knowledge (assign collections), Tools, Working hours, Escalation & handoff. Draft → **Test in browser** (text simulator) → Publish; version history + rollback |
| **Knowledge Base**                       | Collections (Company info, Products, Services, Pricing, FAQs, Policies, Locations, Hours…), document upload (drag-and-drop, multi-file), live status (Uploading → Processing → Extracting → Embedding → Ready / Failed), view/preview, metadata, replace, delete, enable/disable, assign to agents, full-text + semantic **search playground** showing retrieved chunks and scores, RAG settings (top_k, min_score)                                                                 |
| **Calls**                                | Filterable table (caller, date, duration, agent, status, qualification status, outcome, recording). Detail page: call info → transcript → timeline (turns, extractions, fallbacks, guards) → extracted data → RAG sources used → tools executed → final outcome; audio player                                                                                                                                                                                                       |
| **Leads**                                | Table with dynamic columns from the agent's fields, configurable statuses (Kanban + table), follow-up dates, notes, CSV export                                                                                                                                                                                                                                                                                                                                                      |
| **Appointments**                         | Calendar + list views; upcoming/completed/cancelled/rescheduled; reschedule/cancel (synced to the calendar tool)                                                                                                                                                                                                                                                                                                                                                                    |
| **Integrations**                         | Telephony, CRM, Calendar, Sheets, Email, WhatsApp, Webhooks: connect, test, status, last error                                                                                                                                                                                                                                                                                                                                                                                      |
| **Analytics**                            | Call volume, success, qualification rate, booking rate, transfer rate, avg duration, AI latency (p50/p95 per hop), tool failures, RAG stats (hit rate, not-found rate, top unanswered questions), cost usage                                                                                                                                                                                                                                                                        |
| **Settings**                             | Business profile, users & invites, roles & permissions, phone numbers, AI defaults, security (2FA, session policy), API keys, outbound webhooks, billing & usage limits, audit log viewer                                                                                                                                                                                                                                                                                           |
| **Platform admin** (platform owner only) | Tenants, plans, global usage, provider health                                                                                                                                                                                                                                                                                                                                                                                                                                       |

Frontend rules:

- No secrets in the browser.
- Access tokens are kept in httpOnly cookies, with CSRF protection.
- Every page checks permissions both in the UI and in the API.
- Transcripts and recordings require the `calls:read_transcript` permission.

---

## 12. Roles & permissions (RBAC)

Default roles, with permissions editable per tenant:

| Role           | Scope                                                                             |
| -------------- | --------------------------------------------------------------------------------- |
| Platform Owner | All tenants, plans, provider settings, impersonation (audited)                    |
| Business Owner | Everything in their tenant incl. billing, deleting the tenant                     |
| Business Admin | Agents, knowledge, integrations, users (except owner), settings                   |
| Manager        | Calls, transcripts, leads, appointments, analytics; read-only agents              |
| Agent / Staff  | Assigned leads and appointments, limited call view (no recordings unless granted) |

Permissions are strings like `resource:action`, checked by a NestJS guard `@RequirePermissions("agents:write")`. The tenant comes from the membership, never from the request body.

---

## 13. Security requirements → implementation

| Requirement                  | Implementation                                                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tenant isolation             | `tenant_id` everywhere + PostgreSQL RLS (`SET LOCAL app.tenant_id` per request/job) + scoped repositories + automated **cross-tenant isolation tests** in CI |
| Authentication               | argon2 hashes, JWT access (≈15 min) + rotating refresh, optional TOTP 2FA, email invites                                                                     |
| API authentication           | Hashed, scoped API keys per tenant                                                                                                                           |
| RBAC                         | Permission dependency on every route                                                                                                                         |
| Webhook signature validation | Twilio HMAC-SHA1 `X-Twilio-Signature` (per-subaccount token); outbound webhooks signed with HMAC-SHA256                                                      |
| Secret management            | Platform secrets in the cloud secret manager; nothing in images or repo                                                                                      |
| Credential encryption        | Envelope encryption (§9); never serialised to API responses                                                                                                  |
| PII protection               | Redaction in logs; transcripts encrypted at rest; per-tenant retention policy + scheduled purge                                                              |
| Call data access             | Separate permissions for transcripts and recordings; signed short-lived URLs for audio                                                                       |
| Rate limiting                | Per IP, per caller number, per tenant (Redis)                                                                                                                |
| Usage limits                 | Plan limits: minutes, calls/day, documents, storage, tokens; hard stop + alert                                                                               |
| Toll-fraud protection        | Twilio geo permissions, blocklist, per-number concurrency limit, max call duration, anomaly alerts                                                           |
| Audit logs                   | Every config change, publish, integration connect, export, and role change                                                                                   |
| Prompt injection             | Retrieved text and caller speech are treated as data; schema-only extraction; tools selected by code, not by the LLM; output guard                           |

---

## 14. Failure handling (two-path architecture, extended)

```
                ┌── LLM path (understand → retrieve → respond) ──→ continue
Customer ───────┤
                └── Fallback path (deterministic, config-driven) ──→ safe flow
```

| Failure                     | Detection                            | Fallback behaviour                                                                                        |
| --------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| LLM timeout / provider down | `asyncio.wait_for`, exceptions       | Next field's configured question; after 2 failures, fallback-only mode for the call (L4: switch provider) |
| Invalid JSON                | Parse error                          | Same as above                                                                                             |
| Pydantic validation failure | Per-field validation                 | Keep the valid fields, re-ask the invalid field with `reask_prompts`                                      |
| RAG failure / no knowledge  | Timeout, error, score < threshold    | Safe response + follow-up task                                                                            |
| Tool failure                | Timeout / error                      | Step `on_error` (e.g. offer callback); background retry via BullMQ                                        |
| Guardrail violation         | Output guard                         | Replace with fallback text                                                                                |
| ASR empty / noisy           | Empty `SpeechResult`, low confidence | "Sorry, I didn't catch that", then goodbye after 3                                                        |
| Redis unavailable           | Connection error                     | Serve the turn from a Postgres snapshot; alert                                                            |

The caller never hears stack traces, provider names, or "error".

---

## 15. Phased implementation (Levels 1–4)

> The detailed, step-by-step execution plan (P0–P14, with backend, Prisma, frontend, validation, tests, and Definition of Done per phase) is in [`DEVELOPMENT_PHASES.md`](./DEVELOPMENT_PHASES.md). This section is the level-by-level summary.

Multi-tenancy (`tenant_id` + RLS) and the dynamic field schema are built **from Level 1**, even though the UI to edit them comes later. Retrofitting either one afterwards would mean rewriting every table and the core loop.

### Phase 0 — Prerequisites (1–2 days)

- [ ] Twilio account + test number; Gemini API key (OpenAI/Anthropic keys optional)
- [ ] Node 22, pnpm, Docker, ngrok/cloudflared
- [ ] `docker-compose.yml`: postgres (pgvector image), redis, minio
- [ ] `.env.example`: DB/Redis/S3 URLs, `TWILIO_*`, `GEMINI_API_KEY`, `JWT_SECRET`, `MASTER_ENCRYPTION_KEY`, `PUBLIC_BASE_URL`, timeouts

### Phase 1 — Level 1: Working voice agent + basic qualification + basic frontend (3–4 weeks)

Backend:

1. Scaffold the monorepo (§4), env config, Prisma + migrations, Redis.
2. Tables: tenants, users, memberships, roles, agents, agent_versions, phone_numbers, calls, call_events, leads, with **RLS on**.
3. `AgentConfig` + `QualificationField` + `dynamic_schema.py` (create_model, JSON schema, normalisers) + unit tests.
4. Deterministic fallback engine, written **before** the LLM code.
5. `decide()` as a pure function, with the most tests.
6. `LLMProvider` interface + Gemini implementation (structured output, timeout).
7. Generic LangGraph with a default linear workflow (greeting → collect_fields → end); the `retrieve` node is stubbed.
8. `scripts/simulate_call.py --agent <id>`: a text-mode conversation.
9. Twilio: `/telephony/twilio/incoming`, `/turn`, `/status`; number → agent routing; signature validation; `<Gather input="speech" hints=...>` from the field options.
10. Finalize: save the lead (`data` JSONB) + transcript events; Sheets export as a `BackgroundTask` (optional per agent).
11. Auth: email/password login, JWT cookies, basic roles (Owner, Admin, Viewer).
12. Seed templates: **Ava real estate** and a **clinic reception** agent, both as pure config. This proves the core is business-agnostic.

Frontend: 13. Next.js scaffold, login, tenant layout, generated API client. 14. Pages: Dashboard (basic counts), Agents (list + edit a form for greeting/persona/instructions + a simple field list editor), Calls (list + transcript), Leads (list).

**Exit criteria:**

- Two different businesses (real estate + clinic) run on the same deploy with different numbers, fields, and greetings, with no code changes.
- A real call completes qualification and creates a lead visible in the UI.
- With an invalid LLM key, the call still completes on fallback prompts.
- The cross-tenant isolation test passes.

### Phase 2 — Level 2: Dynamic configuration + tools + validation + knowledge/document management (4–5 weeks)

- [ ] Full agent editor: drag-and-drop qualification builder (types, options, validation, order, re-ask prompts), workflow step editor, working hours, escalation/handoff rules, allowed actions
- [ ] Agent draft/publish/versioning + rollback; calls pin `agent_version_id`
- [ ] **Browser test console**: chat with a draft agent in text mode, showing extracted state live
- [ ] Workflow engine: all step types (`tool`, `confirm_and_act`, `branch`, `say`, `handoff`)
- [ ] Tool registry + executor + `agent_tools` permissions + integrations table with **encrypted credentials**
- [ ] Integrations v1: Google Sheets, Google Calendar (free/busy + book), generic webhook, email
- [ ] Appointments module + UI (list/calendar, cancel/reschedule)
- [ ] Human handoff via `<Dial>` + SMS/WhatsApp summary to staff
- [ ] **Document management**: object storage, presigned upload, `documents` + `knowledge_collections` + `document_chunks` (pgvector) tables, ingestion pipeline (§7.1) for PDF/DOCX/TXT/CSV/XLSX, status machine + UI status badges (polling), view/delete/replace/enable/disable/assign, metadata view
- [ ] Knowledge Base UI: collections, document list, **search playground** (semantic search over the tenant's chunks)
- [ ] Configurable lead statuses; lead detail page
- [ ] Full RBAC (5 roles, permission matrix UI), user invites
- [ ] Test suite (§17), ESLint/tsc/Vitest + frontend lint/typecheck/build in GitHub Actions; Docker images for api, worker, frontend

**Exit criteria:** a new business can be onboarded fully from the UI (create agent from a template, edit fields, upload documents, connect a calendar, attach a phone number, publish) and take calls without any engineer involved.

### Phase 3 — Level 3: RAG + Redis + production state + CRM + analytics + security hardening (4–6 weeks)

- [ ] **Live-call RAG** (§7.3): `retrieve` node, parallel with extraction, grounding prompt, citation guard, min-score threshold, safe "not found" path, `pending_questions` → follow-up tasks
- [ ] RAG sources on the call detail page; RAG stats (hit rate, not-found rate, top unanswered questions → "add to knowledge" suggestions)
- [ ] OCR for images and scanned PDFs; SSE live document status
- [ ] **RedisStore** for live sessions (TTL, per-call lock), idempotent turn handling (replay cached reply on Twilio retries)
- [ ] **BullMQ workers**: ingestion, exports, CRM sync, emails, webhooks, analytics roll-ups; retries + dead-letter + a failed-job view in the UI
- [ ] CRM adapters: HubSpot + Zoho (OAuth), field mapping UI (agent field → CRM property)
- [ ] Analytics: daily roll-up tables, full Analytics page, per-hop latency, tool failure rates, cost per call/tenant
- [ ] Security hardening (§13): Twilio subaccounts per tenant, rate limits, usage limits, toll-fraud controls, PII redaction + retention purge, audit log UI, 2FA, API keys
- [ ] Observability: pino + OpenTelemetry traces per call, Grafana dashboards, alerts (fallback rate, error rate, p95 latency, failed ingestions)
- [ ] Deployment: managed Postgres (pgvector) + Redis, Cloud Run/Kubernetes with min instances ≥ 1, separate worker service, backups + restore drill

**Exit criteria:** the production readiness checklist (§18) passes; load test at 50 concurrent calls with p95 turn processing under 1.2 s on the webhook path; zero cross-tenant leaks in the isolation test suite.

### Phase 4 — Level 4: Streaming voice + advanced RAG + multi-provider AI + advanced integrations + billing + enterprise (6–8 weeks)

- [ ] **Streaming voice**: Twilio Media Streams (WebSocket) or **LiveKit Agents via SIP** (recommended), with Deepgram streaming ASR, streaming LLM tokens → sentence-chunked Cartesia/ElevenLabs TTS, VAD + barge-in, endpointing 300–500 ms, filler audio for slow tools. Target: under 800 ms from the caller stopping speaking to the first audio. It reuses the `state`, `workflows`, `rag`, `tools`, and `guards` code unchanged.
- [ ] **Advanced RAG**: hybrid search (Postgres full-text + vector, reciprocal rank fusion), re-ranking, query rewriting from conversation context, FAQ fast-path cache (pre-computed answers for top questions), per-collection chunking strategies, RAG evaluation set per tenant
- [ ] **Multi-provider AI**: OpenAI + Anthropic providers, per-agent provider/model choice, automatic provider failover, cost-aware routing (a small model for extraction, a larger one for answers)
- [ ] Telnyx/Plivo telephony adapters; outbound campaigns (call-back web leads within 60 s, reminders)
- [ ] More integrations: Salesforce, Cal.com, WhatsApp Business (Meta), generic REST tool builder in the UI
- [ ] **Billing**: plans, metered usage (minutes, tokens, storage), Stripe/Razorpay, invoices, overage alerts
- [ ] Enterprise: SSO (SAML/OIDC), data residency options, custom retention, white-labelling, visual workflow builder, multilingual agents (Hindi/Malayalam/…), sentiment-based escalation, live call monitoring + whisper/barge by staff

---

## 16. Example: same core, different businesses

|           | ABC Real Estate — Sales Agent (Ava template)                                                      | XYZ Clinic — Reception Agent                                                                            |
| --------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Fields    | property_type (select), budget (number, lakh/crore), timeline, preferred_area, financing (select) | patient_name, service_required (select), preferred_date (date), preferred_time (time), urgency (select) |
| Knowledge | Projects, price sheets (XLSX), FAQs, locations                                                    | Services list, doctors, timings, insurance policy PDF                                                   |
| Workflow  | greet → collect → offer site-visit slots → book → CRM lead                                        | greet → collect → urgency=high? handoff : find slots → book → WhatsApp confirmation                     |
| Tools     | calendar, hubspot.create_lead, sheets                                                             | calcom, whatsapp.send, email                                                                            |
| Handoff   | "Talk to a person" / budget > configured limit → sales desk                                       | Emergency keywords → front desk immediately                                                             |

Both are rows in the database. Neither exists as Python code.

---

## 17. Testing strategy

| Level            | What                                                                                                                                                                                | How                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Unit             | Dynamic schema + normalisers, `decide`, fallback, guards, chunker, extractors, permission checks, encryption                                                                        | Vitest, no network                                        |
| Workflow         | Full multi-turn conversations per template (happy path, out-of-order answers, corrections, silence, off-topic, wants human, LLM timeout, invalid JSON, RAG not found, tool failure) | Scripted `FakeLLM` + `FakeRetriever` + fake tools         |
| RAG              | Ingestion of sample PDF/DOCX/XLSX; retrieval accuracy on a Q&A set per template; grounding (no answer without sources)                                                              | Vitest + eval script tracked per prompt/embedding version |
| Tenant isolation | Every repository/API endpoint called as tenant B tries to read tenant A's agents, documents, chunks, calls, leads, integrations                                                     | Dedicated `tests/isolation/`; must always pass            |
| API              | Auth, RBAC matrix, Twilio signature rejection, idempotent retries, upload limits                                                                                                    | Supertest + Testcontainers Postgres/Redis                 |
| Frontend         | Components, forms (zod), key flows: login → create agent → upload document → publish                                                                                                | Vitest + Playwright                                       |
| Failure drills   | LLM down, embeddings down, Redis restart, Sheets/CRM down, 10 s silence, noisy audio                                                                                                | Chaos flags (`FORCE_LLM_FAILURE`, `FORCE_RAG_FAILURE`, …) |
| Load             | Concurrent calls, ingestion throughput                                                                                                                                              | Locust against webhook + simulator endpoints              |
| Live             | Real calls from multiple phones/networks per template                                                                                                                               | Release checklist                                         |

---

## 18. Production readiness checklist

- [ ] Tenant isolation suite green; RLS enabled on every tenant table
- [ ] Twilio signature validation on every telephony webhook
- [ ] No secrets in code, images, logs, or API responses; integration credentials encrypted
- [ ] RBAC enforced server-side on every route; audit log on every config change
- [ ] PII redacted in logs; transcript/recording retention configured
- [ ] Live state in Redis; survives restarts and scale-out; idempotent turns
- [ ] Rate limits, usage limits, max call duration, toll-fraud controls
- [ ] Deterministic fallback verified with the LLM, RAG, and tools each disabled
- [ ] "Knowledge not found" path verified (no invented business facts)
- [ ] Human handoff tested end to end
- [ ] Dashboards + alerts for latency, fallback rate, tool failures, ingestion failures, cost
- [ ] Backups + tested restore
- [ ] AI disclosure / recording-consent line configurable in greetings (legal compliance)

---

## 19. Risks & mitigations

| Risk                                      | Mitigation                                                                                          |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Cross-tenant data leak                    | RLS + scoped repositories + isolation test suite + tenant filter in every vector query              |
| RAG hallucination of business facts       | Score threshold, grounded prompt, citation check, numeric-fact guard, safe not-found path           |
| RAG adds latency to calls                 | Retrieval only on question intent, run in parallel with extraction, ~400 ms timeout, FAQ cache (L4) |
| Twilio ASR weak on Indian accents / names | `hints` built from field options and knowledge keywords; Deepgram in L4                             |
| LLM mis-normalises values (e.g. "80L")    | Type normalisers in the dynamic schema + confirm-back option per field                              |
| Config errors break live agents           | Draft/publish with validation, test console, version pinning, rollback                              |
| Duplicate webhooks corrupt state          | Idempotency per turn + Redis lock                                                                   |
| Integration outages                       | Background queue with retries; `on_error` steps; never block the call                               |
| Prompt injection via speech or documents  | Retrieved text and speech treated as data; code-selected tools; output guard                        |
| Runaway cost                              | Per-call token/duration limits, per-tenant daily ceilings, usage alerts                             |
| Scope is large                            | Strict level gating; each level has exit criteria and ships independently                           |

---

## 20. Timeline summary (one full-stack developer; roughly halve it with two)

| Phase | Deliverable                                                                        | Estimate  |
| ----- | ---------------------------------------------------------------------------------- | --------- |
| 0     | Accounts, tooling, docker-compose                                                  | 1–2 days  |
| 1     | L1: multi-tenant core, dynamic fields, working phone agent, basic UI               | 3–4 weeks |
| 2     | L2: full config UI, workflows, tools, integrations, documents & knowledge base     | 4–5 weeks |
| 3     | L3: live RAG, Redis, BullMQ, CRM, analytics, security hardening, production deploy | 4–6 weeks |
| 4     | L4: streaming voice, advanced RAG, multi-provider, billing, enterprise             | 6–8 weeks |

**Recommended next step:** start Phase 1 steps 1–8. Build the multi-tenant DB with RLS, `AgentConfig`, the dynamic schema, fallback, `decide`, the generic graph, and the text simulator, and run it against both the real estate and clinic templates. Then connect Twilio and the frontend.
