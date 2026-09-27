# 2. Architecture and structure

## The big picture

```
                          ┌──────────────── Twilio (phone network, SIP) ────────────────┐
 Caller ── phone call ──▶ │ speech recognition · text-to-speech · <Gather>/<Say>/<Dial> │
                          └───────────────────────────┬──────────────────────────────────┘
                                                      │ signed HTTPS webhooks (form data → TwiML XML)
 Business staff ─ browser ─▶ web (Next.js) ── /api ──▶│
                                                      ▼
                                   api (NestJS on Fastify) ─── Gemini (understanding, phrasing,
                                     │   │   │                  answers, embeddings, OCR)
                  ┌──────────────────┘   │   └─────────────────────┐
                  ▼                      ▼                         ▼
     Postgres 16 + pgvector      Redis 7 (call state,      External services: Google Calendar /
     (all data, RLS per tenant)   locks, rate limits,       Sheets, HubSpot, Zoho, SMTP, webhooks
                  ▲               BullMQ queues)
                  │                      │
                  └────── worker ◀───────┘  documents, analytics roll-ups, retention, schedules
```

- **web** is only a UI. It never talks to the database; everything goes through the API.
- **api** is stateless: any instance can take any request, including the next turn of a call.
- **worker** does slow or scheduled work from queues.
- **Postgres** holds everything; **Redis** holds short-lived state (a live call's memory, locks,
  rate limits, queues). Losing Redis doesn't lose a call: the call's state is also saved in
  Postgres every turn.

## Repository layout (monorepo, npm workspaces + Turborepo)

```
Ai_Call_Agent/
├── apps/
│   ├── api/           NestJS API: REST for the web app, Twilio webhooks, API keys
│   │   ├── src/
│   │   │   ├── main.ts, bootstrap.ts, tracing.ts, app.module.ts
│   │   │   ├── config/          environment validation (zod)
│   │   │   ├── common/          auth (tokens, guards, CSRF), errors (RFC 7807), pipes, rate limits
│   │   │   ├── infra/           Prisma, per-tenant DB access, Redis, tenant keys, Twilio REST, storage
│   │   │   ├── observability/   Prometheus metrics
│   │   │   ├── admin/           queue dashboard (Bull Board)
│   │   │   └── modules/         one folder per feature (see below)
│   │   └── test/                integration tests against real Postgres + Redis
│   ├── web/           Next.js 15 dashboard (App Router, React 19, Tailwind 4)
│   │   └── src/
│   │       ├── app/             routes: (auth)/login, register, invite; t/[tenant]/…
│   │       ├── components/      pages and UI pieces per area (agents, calls, settings …)
│   │       ├── lib/             API client, formatting, types
│   │       └── middleware.ts    Content Security Policy with a nonce per request
│   └── worker/        BullMQ worker: ingestion, analytics, system jobs (retention, SIP health)
├── packages/          shared libraries (built to dist/, used by the apps)
│   ├── shared/        zod schemas and types shared by API and web: agent config, API bodies,
│   │                  permissions, countries, languages and voices, queues, usage prices
│   ├── core/          the conversation engine (pure, no I/O): workflow, fields, normalisers
│   │                  (numbers, dates, times, phones, names, English + Arabic), guards
│   ├── runtime/       runs a turn: engine + AI understanding/phrasing + knowledge + tools, with budgets
│   ├── ai/            LLM and embedding providers (Gemini REST, local hashing embeddings, OCR)
│   ├── rag/           document extraction, chunking, embeddings, hybrid search, grounded answers
│   ├── tools/         tool registry and executor: calendar, sheets, CRM, email, webhooks, slots
│   ├── telephony/     Twilio adapter (signatures, TwiML), REST client, SIP helpers, forwarding codes
│   ├── db/            Prisma schema, migrations, RLS helpers, seed, maintenance jobs, analytics roll-up
│   ├── crypto/        envelope encryption, password hashing (argon2id), TOTP, tokens
│   ├── storage/       file storage drivers (local disk, S3-compatible)
│   └── templates/     ready-made agent templates
├── infra/
│   ├── postgres/init.sql        database roles for Docker
│   └── observability/           Prometheus config and alert rules (+ tests), Grafana dashboard
├── scripts/           audit gate, backup, restore drill, load test
├── docs/              plans, phase log, deployment, runbook, this documentation
├── Dockerfile         one multi-stage file: targets api, worker, web, migrate
├── docker-compose.yml the whole stack on one machine (+ optional monitoring profile)
├── turbo.json         task graph (build → typecheck/lint/test)
└── .github/           CI workflow, Dependabot
```

## API modules (`apps/api/src/modules`)

| Module                                  | Responsibility                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------- |
| `auth`                                  | Register, sign in (with 2FA), refresh, sign out, sessions, invitations accepted             |
| `users`, `tenants`                      | Members and roles; business settings (country, retention, call limits)                      |
| `agents`                                | Agents, drafts, publishing, versions, tool bindings, templates                              |
| `test-console`                          | Typed test calls against a draft or published agent                                         |
| `telephony`                             | Twilio webhooks: routing, call gate, turns, transfers, status, call state                   |
| `phone-numbers`                         | Twilio numbers (buy/release), forwarding and test calls, SIP trunks, blocked callers        |
| `calls`, `leads`, `appointments`        | Call history and timelines; leads and statuses; appointments                                |
| `knowledge`                             | Collections, document upload and processing, search playground, knowledge gaps              |
| `tools`, `integrations`, `crm`          | Tool execution during calls; connected services (OAuth or keys); CRM field mapping and sync |
| `jobs`                                  | Queue producers and consumers, dead letters (failed deliveries)                             |
| `usage`, `analytics`                    | Usage metering and cost; reports and CSV export                                             |
| `alerts`, `audit`, `api-keys`, `health` | Business alerts; audit log; API keys; `/health` and `/ready`                                |

## Database (Postgres 16 + pgvector)

29 tables. Every table holding a business's data carries `tenant_id` and is protected by Row-Level
Security (users and sessions are global; memberships link them to businesses).

| Area               | Tables                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenancy and access | `tenants`, `users`, `memberships`, `roles`, `invitations`, `refresh_tokens`, `api_keys`, `audit_logs`                                                   |
| Agents             | `agents`, `agent_versions` (the whole configuration as JSON, one row per version), `agent_tools`                                                        |
| Telephony          | `phone_numbers`, `sip_trunks`, `blocked_callers`, `calls`, `call_events` (the timeline)                                                                 |
| Knowledge          | `knowledge_collections`, `agent_collections`, `documents`, `document_agents`, `document_chunks` (text + `vector(768)` embedding + full-text `tsvector`) |
| Business           | `leads`, `lead_statuses`, `appointments`, `integrations` (credentials encrypted)                                                                        |
| Operations         | `usage_records`, `analytics_hourly`, `failed_jobs`, `tenant_alerts`                                                                                     |

Migrations live in `packages/db/prisma/migrations` (6 so far). Some SQL can't be expressed in
Prisma and is written by hand in the migrations: RLS policies, the HNSW vector index, and a few
`SECURITY DEFINER` lookup functions (e.g. "which tenant owns this phone number?", used before the
tenant is known).

## How the pieces depend on each other

```
shared ◀── core ◀── runtime ◀── api
   ▲         ▲         ▲         │
   │         └── tools ┘         ├── telephony, rag, ai, db, crypto, storage, templates
   └──────────── web (types and schemas only)
worker ──▶ db, rag, ai, storage, shared
```

- `core` is pure: given the agent's configuration, the call so far and what the caller said, it
  returns what to say and do. It has no network, database or clock of its own, which makes it
  fully testable (174 tests).
- `runtime` wraps `core` with the slow, unreliable parts (AI, search, tools) and their time
  budgets, falling back to the pure engine whenever they fail.
