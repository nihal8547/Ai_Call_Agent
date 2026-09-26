# Development Phases — Universal AI Voice Agent Platform

This document turns [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) into buildable phases. Each phase lists its backend, database (Prisma/PostgreSQL), frontend, server-side, validation, and test work, plus a Definition of Done.

`IMPLEMENTATION_PLAN.md` still defines **what** we build: the architecture, multi-tenancy, RAG, workflows, security, and failure handling. This document defines **how and in what order**.

---

## 0. Stack decision: TypeScript end-to-end with Prisma

Prisma is a Node.js/TypeScript ORM, and its Python client is no longer maintained. To use Prisma properly, the backend moves from Python/FastAPI to **TypeScript**. Every architectural concept from the plan carries over; only the libraries change:

| Concern                     | Earlier plan (Python)           | This plan (TypeScript)                                                   |
| --------------------------- | ------------------------------- | ------------------------------------------------------------------------ |
| API server                  | FastAPI                         | **NestJS** (modules, guards, DI, interceptors) on Fastify adapter        |
| Validation / schemas        | Pydantic v2                     | **zod** — one schema package shared by API, workers and frontend         |
| ORM / migrations            | SQLAlchemy + Alembic            | **Prisma** (schema + Prisma Migrate) + hand-written SQL for RLS/pgvector |
| Dynamic qualification model | `pydantic.create_model`         | zod schema built at runtime from field config                            |
| Orchestration               | LangGraph (Python)              | **LangGraph.js** (`@langchain/langgraph`) around a pure-TS decision core |
| Background jobs             | arq + Redis                     | **BullMQ** + Redis                                                       |
| LLM SDKs                    | google-genai, openai, anthropic | `@google/genai`, `openai`, `@anthropic-ai/sdk`                           |
| Telephony                   | twilio (py)                     | `twilio` (node)                                                          |
| Logging                     | structlog                       | **pino** (JSON) + OpenTelemetry                                          |
| Tests                       | pytest                          | **Vitest**, Supertest, Testcontainers, Playwright                        |
| Frontend                    | Next.js                         | Next.js (unchanged)                                                      |

Benefits: one language, one type system, and the **same zod schemas** validate the agent editor form in the browser, the API request, the JSONB column, and the LLM output.

---

## 1. Monorepo structure

pnpm workspaces + Turborepo.

```
Ai_Call_Agent/
├── apps/
│   ├── api/                         # NestJS: REST API + telephony webhooks
│   │   └── src/
│   │       ├── main.ts              # bootstrap: Fastify, helmet, CORS, cookie, OpenAPI
│   │       ├── app.module.ts
│   │       ├── common/              # guards, interceptors, filters, pipes, decorators
│   │       │   ├── guards/          # AuthGuard, TenantGuard, PermissionsGuard, TwilioSignatureGuard, RateLimitGuard
│   │       │   ├── filters/         # ProblemDetailsFilter (RFC 7807 errors)
│   │       │   ├── pipes/           # ZodValidationPipe
│   │       │   └── context/         # RequestContext (AsyncLocalStorage: user, tenant, requestId)
│   │       └── modules/
│   │           ├── auth/            # login, refresh, logout, invites, 2FA
│   │           ├── tenants/         # tenant profile, limits, platform-admin
│   │           ├── users/           # members, roles, permissions
│   │           ├── agents/          # agents, versions, publish, test console
│   │           ├── phone-numbers/
│   │           ├── knowledge/       # collections, documents, uploads, search
│   │           ├── integrations/    # connect/test/disconnect, OAuth callbacks
│   │           ├── calls/           # list, detail, timeline, recordings
│   │           ├── leads/           # leads, lead statuses
│   │           ├── appointments/
│   │           ├── analytics/
│   │           ├── audit/
│   │           ├── api-keys/
│   │           └── telephony/       # /telephony/twilio/* webhooks → conversation runtime
│   ├── worker/                      # BullMQ workers: ingestion, exports, CRM sync, emails, roll-ups
│   ├── web/                         # Next.js management app (App Router)
│   └── voice/                       # (Phase 13) streaming media server / LiveKit agent
├── packages/
│   ├── db/                          # Prisma schema, migrations, client, tenant-scoped client, seed
│   ├── shared/                      # zod schemas + TS types + permission catalogue + error codes
│   ├── core/                        # conversation engine: dynamic schema, decide, fallback, guards (pure, no I/O)
│   ├── runtime/                     # LangGraph graph wiring core + ai + rag + tools + state store
│   ├── ai/                          # LLMProvider + EmbeddingProvider adapters (Gemini, OpenAI, Anthropic)
│   ├── rag/                         # extractors, cleaner, chunker, retriever, grounding
│   ├── telephony/                   # TelephonyProvider interface + Twilio adapter
│   ├── tools/                       # tool registry, executor, built-in tools
│   └── crypto/                      # envelope encryption, hashing, token utils
├── templates/                       # seed agent templates (real-estate/Ava, clinic, hotel, restaurant)
├── docs/
├── infra/                           # docker-compose, Dockerfiles, deploy manifests
├── .github/workflows/
├── package.json · pnpm-workspace.yaml · turbo.json
└── .env.example
```

**Dependency rules** (enforced by ESLint `import/no-restricted-paths` / dependency-cruiser):

- `core` depends on nothing but `shared`. It is pure logic and 100% unit-testable.
- `runtime` is the only package that combines `core`, `ai`, `rag`, `tools`, and the state store.
- `telephony` knows nothing about LLMs. `apps/api/modules/telephony` connects `telephony` to `runtime`.
- `apps/web` imports only `shared` (schemas/types), plus the generated API client. It never imports `db`.
- Only `db`, `apps/api`, and `apps/worker` touch Prisma.

---

## 2. Engineering conventions

### 2.1 Backend layering (per NestJS module)

```
Controller  (HTTP only: route, guards, ZodValidationPipe, maps to DTO)
   ↓
Service     (business rules, transactions, audit log, emits jobs)
   ↓
Repository  (Prisma queries via the tenant-scoped client; no business rules)
```

- Controllers never call Prisma directly.
- Services never read `req`. They get the tenant and user from `RequestContext`.

### 2.2 Validation: seven layers, one source of truth (`packages/shared`)

| #   | Where          | What                                                                                                                          | Tool                                          |
| --- | -------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 1   | Environment    | All env vars parsed at boot; the process exits on invalid config                                                              | zod `EnvSchema`                               |
| 2   | Frontend forms | Same schemas as the API, inline errors                                                                                        | react-hook-form + `zodResolver`               |
| 3   | API boundary   | Body, query, params, and responses validated; unknown keys stripped                                                           | `ZodValidationPipe`, `nestjs-zod` for OpenAPI |
| 4   | Domain rules   | E.g. a publish needs ≥1 field and existing tools/collections; slot within working hours                                       | Service layer + `AgentConfig.superRefine`     |
| 5   | Database       | NOT NULL, FK, unique, enums, CHECK constraints, RLS `WITH CHECK`                                                              | Prisma schema + SQL migration                 |
| 6   | JSONB columns  | Every `Json` column has a zod schema and is parsed on read and write (`AgentConfig`, `CallEventPayload`, `TenantLimits`, ...) | `packages/db` typed helpers                   |
| 7   | LLM output     | Dynamic zod schema from qualification fields; validated per field; invalid fields are dropped and re-asked                    | `packages/core/dynamic-schema.ts`             |

Example (`packages/shared/src/agent/qualification-field.ts`):

```ts
export const FieldType = z.enum([
  "text",
  "number",
  "select",
  "multiselect",
  "boolean",
  "date",
  "time",
  "phone",
  "email",
]);

export const QualificationField = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/, "lowercase_snake_case, 2–40 chars"),
    label: z.string().min(1).max(80),
    question: z.string().min(5).max(300),
    type: FieldType,
    options: z.array(z.string().min(1).max(80)).max(50).default([]),
    required: z.boolean().default(true),
    order: z.number().int().min(0),
    validation: z
      .object({
        min: z.number().optional(),
        max: z.number().optional(),
        pattern: z.string().max(200).optional(),
        futureOnly: z.boolean().optional(),
      })
      .default({}),
    reaskPrompts: z.array(z.string().min(5).max(300)).max(3).default([]),
    confirmBack: z.boolean().default(false),
  })
  .superRefine((f, ctx) => {
    if ((f.type === "select" || f.type === "multiselect") && f.options.length < 2)
      ctx.addIssue({ code: "custom", path: ["options"], message: "Select fields need at least 2 options" });
  });
```

### 2.3 Database access and tenant isolation

- **Two connection strings:**
  - `DATABASE_URL` uses the `app_user` role (RLS enforced) and is used by the API and workers.
  - `DATABASE_MIGRATION_URL` uses the owner role and is used by migrations only.
- The **tenant-scoped client** runs every operation inside a transaction that first sets `app.tenant_id`:

```ts
// packages/db/src/tenant-client.ts
export function tenantClient(prisma: PrismaClient, tenantId: string) {
  return prisma.$extends({
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          const [, result] = await prisma.$transaction([
            prisma.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, TRUE)`,
            query(args),
          ]);
          return result;
        },
      },
    },
  });
}

// Multi-statement work: withTenant(tenantId, async (tx) => { ... })  — sets the config once, then runs the callback.
```

- Before the tenant is known, code calls the SQL functions `resolve_phone_number`, `user_memberships`, `resolve_api_key`, and `resolve_invitation` (already in the RLS migration). No code path uses a superuser connection.
- pgvector reads and writes use `$queryRaw` with typed wrappers in `packages/rag/retriever.ts`.
- Every JSON column goes through `parseJson(schema, value)` helpers. Code never reads raw `Json` directly.
- Migrations: `prisma migrate dev --create-only`, review the SQL, then commit. `scripts/check-migrations.sh` runs in CI.

### 2.4 API conventions

- Base path `/api/v1`, JSON, camelCase, plural nouns: `/agents/:id/versions`.
- Pagination is cursor-based: `?cursor=&limit=` (max 100) → `{ items, nextCursor }`.
- Filtering and sorting use an allow-list per endpoint, validated by zod.
- Errors use RFC 7807 `application/problem+json`: `{ type, title, status, code, detail, errors[] }`. `code` comes from a shared enum, so the frontend can map it to messages.
- Writes that can be retried, such as uploads, publishes, and bookings, accept an `Idempotency-Key` header.
- The OpenAPI spec is generated from zod. `apps/web` generates its typed client (`openapi-typescript` + `openapi-fetch`) in CI and fails on drift.
- Every mutating endpoint writes an `audit_logs` row in the same transaction.

### 2.5 Server side (Next.js)

- **Same-origin API.** A Next.js `rewrites()` rule proxies `/api/*` to the NestJS API, so auth cookies are first-party (`HttpOnly; Secure; SameSite=Lax`). Tokens never go to JS.
- **Server Components** fetch initial page data on the server, forwarding the request cookies to the API. The first render has no loading spinners, and data never waits on client JS.
- **Client Components** use TanStack Query for interactive data such as tables, filters, polling document status, and mutations.
- **`middleware.ts`** redirects unauthenticated users to `/login` and resolves the tenant slug in the URL (`/t/[tenant]/…`).
- **CSRF protection:** double-submit token header on mutations, plus `SameSite` cookies.
- Server-only modules (`import "server-only"`) hold anything that must never reach the browser bundle. The web app has **no provider secrets at all**.

### 2.6 Git and CI

- One branch per phase (`phase/03-conversation-core`) and small PRs into `main`.
- CI gates on every PR:
  1. `pnpm lint`
  2. `pnpm typecheck`
  3. `pnpm test` (unit + integration with Testcontainers Postgres/Redis)
  4. `check-migrations.sh`
  5. OpenAPI client drift check
  6. `next build`
  7. Docker build
- Every phase ends with a tagged release (`v0.<phase>.0`) and a short demo checklist.

---

## 3. Phase overview

| Phase  | Name                                                    | Level | Estimate                          |
| ------ | ------------------------------------------------------- | ----- | --------------------------------- |
| P0     | Foundation & tooling                                    | L1    | 3–4 days                          |
| P1     | Database & tenant isolation                             | L1    | 3–4 days (**started, see below**) |
| P2     | Auth, RBAC, tenant & user management                    | L1    | 1 week                            |
| P3     | Shared schemas & conversation core                      | L1    | 1 week                            |
| P4     | AI providers & runtime orchestration                    | L1    | 1 week                            |
| P5     | Telephony, calls & leads                                | L1    | 1 week                            |
| P6     | Frontend foundation & Level 1 screens                   | L1    | 1.5 weeks                         |
| **M1** | **Level 1 milestone: working multi-tenant voice agent** |       |                                   |
| P7     | Agent editor, versioning, workflow engine, test console | L2    | 2 weeks                           |
| P8     | Documents & knowledge base (ingestion)                  | L2    | 2 weeks                           |
| P9     | Tools, integrations, appointments, handoff              | L2    | 2 weeks                           |
| **M2** | **Level 2 milestone: self-serve configurable platform** |       |                                   |
| P10    | Live-call RAG                                           | L3    | 1.5 weeks                         |
| P11    | Production state, queues, CRM, analytics                | L3    | 2 weeks                           |
| P12    | Security hardening, observability, deployment           | L3    | 1.5 weeks                         |
| **M3** | **Level 3 milestone: production-ready**                 |       |                                   |
| P13    | Streaming voice                                         | L4    | 2–3 weeks                         |
| P14    | Advanced RAG, multi-provider AI, billing, enterprise    | L4    | 4–5 weeks                         |
| **M4** | **Level 4 milestone: business-ready SaaS**              |       |                                   |

---

## P0 — Foundation & tooling ✅

**Goal:** an empty but fully wired monorepo where every later phase only adds code.

**Status: done.**

- [x] **Repo:**
  - pnpm workspace + Turborepo pipelines (`build`, `dev`, `lint`, `typecheck`, `test`)
  - root `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`); this replaces a separate `packages/config`
  - ESLint flat config (typescript-eslint + layer-boundary import rules), Prettier, `.editorconfig`, `.nvmrc`
- [x] **apps/api:**
  - NestJS 11 + Fastify adapter
  - `/health` and `/ready` (DB + Redis ping with timeouts → problem+json 503)
  - pino logging with request id (`x-request-id` echoed back) and redaction of auth headers and cookies
  - `ProblemDetailsFilter` (RFC 7807, internal errors never leaked), `AppException`, `ZodValidationPipe`
  - helmet, cookies, CORS allow-list, `/api/v1` prefix
- [x] **apps/worker:** BullMQ bootstrap, a `system` queue with a zod-validated `noop` job, graceful shutdown.
- [x] **apps/web:** Next.js 15 App Router, Tailwind 4, TanStack Query provider, `/api/*` same-origin proxy to the API, security headers, `/login` placeholder.
- [x] **Config:** `parseEnv` + `envPrimitives` in `@platform/shared`; a zod env schema per app; `.env.example`.
- [x] **Local infra:** `infra/docker-compose.yml` (pgvector pg16, redis 7, minio, mailpit) + `infra/postgres/init.sql` (`app_user` role, `voice_app` login, shadow and test databases).
- [x] **CI:** `.github/workflows/ci.yml` runs the following against Postgres + Redis service containers:
  - install
  - roles
  - `migrate deploy`
  - migration drift check
  - format
  - lint
  - typecheck
  - test
  - build
- Moved to later phases:
  - OpenAPI docs → P2, once real endpoints exist
  - shadcn/ui components → P6
  - Docker images → P12
  - commitlint/husky → optional

**Verified:**

- `pnpm build`, `typecheck`, `lint`, `test`, and `format:check` are all green.
- The API against real Postgres 16 + Redis: `/ready` → `{"database":"ok","redis":"ok"}`, and unknown routes → problem+json 404.
- The worker consumed an enqueued `noop` job.

**Definition of Done**

- `pnpm i && docker compose -f infra/docker-compose.yml up -d && pnpm db:migrate && pnpm dev` starts api, worker, and web.
- `/health` is green.
- CI passes.

---

## P1 — Database & tenant isolation

**Goal:** the complete data model with enforced tenant isolation.

**Already done in this repository:**

- [x] `packages/db/prisma/schema.prisma`: all 24 models (tenancy, auth, agents, versions, phone numbers, knowledge, documents, chunks with `vector(768)` + generated `tsvector`, integrations, agent tools, calls, call events, leads, lead statuses, appointments, usage, audit), enums, indexes, snake_case mapping.
- [x] Migration `…_init`: Prisma-generated SQL + HNSW index + CHECK constraints (time ranges, E.164, progress, sizes).
- [x] Migration `…_rls`:
  - `app_user` role
  - `FORCE ROW LEVEL SECURITY` + `tenant_isolation` policy on all 22 tenant tables
  - `app_current_tenant()`
  - SECURITY DEFINER lookups `resolve_phone_number`, `user_memberships`, `resolve_api_key`, `resolve_invitation`
  - `_prisma_migrations` hidden from the app role
- [x] `packages/db/scripts/check-migrations.sh`: drift check (allows only the known HNSW false-positive).
- [x] Verified on PostgreSQL 16 + pgvector:
  - migrations apply cleanly
  - with no tenant set, 0 rows are visible
  - tenant A sees only its own rows
  - an insert for tenant B is rejected by RLS
  - an update of B's rows affects 0 rows
  - phone routing works before the tenant is known
  - the app role cannot read `_prisma_migrations`

**Remaining:**

- [ ] `packages/db` package: `package.json` scripts (`generate`, `migrate:dev`, `migrate:deploy`, `seed`, `check`), `src/client.ts` (singleton), `src/tenant-client.ts` + `withTenant()`, `src/json.ts` (typed JSON parse helpers), `src/system.ts` (typed wrappers for the SECURITY DEFINER functions).
- [ ] Seed script (`prisma/seed.ts`), idempotent:
  - platform owner user
  - two demo tenants: **ABC Real Estate** (Ava template) and **XYZ Clinic**
  - system roles + default lead statuses per tenant
  - one agent + published version each
  - demo phone numbers
- [ ] **Isolation test suite** (`packages/db/test/isolation.test.ts`, Testcontainers). For every tenant model, check that tenant B cannot select, update, delete, or insert tenant A's rows through `tenantClient`, and that a missing tenant context returns nothing.

**Definition of Done**

- `pnpm --filter @platform/db migrate:deploy && pnpm --filter @platform/db seed` works on a fresh database.
- The isolation suite is green in CI.

---

## P2 — Auth, RBAC, tenant & user management

**Goal:** secure login, tenant context on every request, permission checks.

**Backend (`modules/auth`, `users`, `tenants`, `api-keys`, `audit`)**

| Method                | Endpoint                                                               | Permission                     |
| --------------------- | ---------------------------------------------------------------------- | ------------------------------ |
| POST                  | `/auth/register` (creates tenant + owner, seeds roles & lead statuses) | public, rate-limited           |
| POST                  | `/auth/login` · `/auth/refresh` · `/auth/logout`                       | public / cookie                |
| GET                   | `/auth/me` → user + memberships (`user_memberships()`)                 | authenticated                  |
| POST                  | `/auth/switch-tenant`                                                  | member of target               |
| GET/PATCH             | `/tenant` (profile, timezone, industry)                                | `tenant:read` / `tenant:write` |
| GET/POST/PATCH/DELETE | `/members`, `/invitations`, `/roles`                                   | `users:*`, `roles:*`           |
| POST                  | `/invitations/:token/accept`                                           | public (token)                 |
| GET/POST/DELETE       | `/api-keys`                                                            | `api_keys:*`                   |
| GET                   | `/audit-logs`                                                          | `audit:read`                   |

- **Passwords:** argon2id; minimum 10 characters + zxcvbn score ≥ 3 (validated in `shared`).
- **Tokens:**
  - Access JWT (15 min, `jose`, EdDSA) in an httpOnly cookie.
  - Refresh token (30 days, rotating, family revocation on reuse), stored hashed in `refresh_tokens`.
- **Guards:** `AuthGuard` (cookie or `Authorization: ApiKey …`) → `TenantGuard` (membership check, sets `RequestContext.tenantId`) → `PermissionsGuard` (`@RequirePermissions('agents:write')`).
- **Permission catalogue:** `packages/shared/permissions.ts` is the single source, with default role matrices for OWNER / ADMIN / MANAGER / STAFF. The platform owner is handled separately (`isPlatformOwner`).
- **Rate limits:** `@nestjs/throttler` with Redis storage. Login: 5/min/IP + 10/hour/email.

**Frontend**

- `/login`, `/register`, `/invite/[token]`, and a tenant switcher.
- Settings → Users (invite, change role, remove), Roles (permission matrix editor), API keys (create shows the key once), Audit log.

**Tests**

- Auth flows, refresh-token reuse detection, RBAC matrix test (every endpoint × every role → expected 2xx/403), cross-tenant access → 404.

**Definition of Done**

- A new business can register, invite a teammate with the Manager role, and that user sees only permitted menus. Forbidden API calls return 403.

---

## P3 — Shared schemas & conversation core

**Goal:** the business-agnostic brain logic, testable without network, DB, or phone.

**`packages/shared`**

- `AgentConfig` (§6 of the plan) and its parts: `QualificationField`, `WorkflowDefinition` (step union: `greeting | collect_fields | tool | confirm_and_act | say | branch | handoff | end`), `KnowledgeConfig`, `EscalationRules`, `HandoffConfig`, `WorkingHours`, `AppointmentConfig`, `LLMConfig`, `CallLimits`.
- `AgentConfig.superRefine` does cross-checks: unique field keys, workflow steps reference existing fields/tools, `branch` conditions reference valid fields and operators, and working hours are in order.
- `CallEventPayload` discriminated union, `CallSession`, `Outcome`.

**`packages/core`** (pure functions)

- `buildFieldSchema(fields)` → zod object with type normalisers:
  - number: "80 lakh", "1.2 crore", "50k", "fifty thousand"
  - date and time: relative expressions ("next Monday", "tomorrow evening") in the tenant timezone
  - select: fuzzy match to options
  - phone: E.164 via libphonenumber-js
  - email, boolean ("yes/yeah/sure/nope")
- `buildExtractionJsonSchema(fields)`: all fields optional, plus `intent`, `question`, `wantsHuman`, `sentiment`.
- `mergeExtraction(session, raw)`: validates per field, keeps the valid values, records the invalid ones, and returns events.
- `decide(session, config, now)` → `Action` (`ask_field | answer_question | run_tool | confirm | handoff | say | end`). Handles workflow position, attempts, escalation, working hours, limits, and the circuit breaker.
- `fallbackText(action, session, config)`: deterministic phrasing from config, never throws.
- `guardOutput(text, context)`: length, JSON/markup/error text, secrets, a numeric-fact check against sources, and a domain scope check.
- `redactPII(text)`.

**Templates**

- `templates/real-estate-ava.json`, `templates/clinic-reception.json`, `templates/hotel-reservations.json`, `templates/restaurant-booking.json`, all validated by `AgentConfig` in a test.

**Tests**

- More than 150 unit tests are expected: normalisers (table-driven), `decide` for every step type and escalation rule, fallback coverage for every field and attempt, and guard cases.
- Property tests (fast-check): `decide` always returns a valid action, and `fallbackText` never returns an empty string.

**Definition of Done**

- 95%+ line coverage on `packages/core`.
- `pnpm simulate --template clinic-reception --llm off` completes a full conversation in the terminal using fallbacks only.

---

## P4 — AI providers & runtime orchestration

**Goal:** the LLM path on top of the core, with the fallback path wired in for every failure type.

- **`packages/ai`**
  - `LLMProvider` interface: `generateStructured(messages, jsonSchema, {timeoutMs})`, `generateText`, `stream`, and usage reporting.
  - `GeminiProvider` first. `OpenAIProvider` and `AnthropicProvider` are added in P14; the interface is fixed now.
  - `EmbeddingProvider` interface + Gemini embeddings (768 dims).
  - Every call gets an `AbortController` timeout and returns a typed `Result`. Providers never throw into the graph.
- **`packages/runtime`**
  - LangGraph.js `StateGraph` with the nodes `ingest → understand → (retrieve) → decide → run_tool | respond → guard → finalize`, plus `fallback` edges from every node.
  - The `retrieve` node is stubbed until P10.
  - Prompt builders: persona + instructions + business rules + collected state + missing field + (context) → messages. Prompt version constant logged on every turn.
  - `SessionStore` interface with a `MemoryStore` implementation (the Redis implementation comes in P11).
  - Per-call circuit breaker: after 2 LLM failures the call switches to fallback-only mode. Token and turn limits are enforced.
  - Every turn emits typed `CallEvent`s through an `EventSink` interface.
- **CLI:** `pnpm simulate --template real-estate-ava` runs an interactive chat against Gemini, and `--fault llm_timeout|invalid_json|provider_error` injects failures.

**Tests**

- Graph tests with a scripted `FakeLLM`: happy path, answers out of order, corrections, silence, off-topic input, "talk to a human", each fault type → fallback, and the circuit breaker opening.

**Definition of Done**

- Both demo templates complete in the simulator with Gemini.
- With `GEMINI_API_KEY` invalid, the same scripts complete via fallback.
- The caller never sees a technical error string (asserted by the guard test).

---

## P5 — Telephony, calls & leads

**Goal:** real phone calls, persisted end to end.

- **`packages/telephony`:** `TelephonyProvider` interface (`parseInbound`, `renderReply`, `transfer`, `hangup`, `verifySignature`) and `TwilioProvider` (TwiML builders, `<Gather input="speech" speechTimeout="auto" language hints>`).
- **`modules/telephony`:**
  - `POST /telephony/twilio/voice`: `TwilioSignatureGuard` → `resolve_phone_number(To)` → create `Call` (pinned `agentVersionId`) → greeting TwiML.
  - `POST /telephony/twilio/turn`: load session → run the graph → persist events → TwiML. Idempotent on `CallSid` + turn sequence.
  - `POST /telephony/twilio/status`: final status, duration, `finalize` → lead upsert, usage records.
  - An unknown number or inactive agent gets a polite message and a hang-up, plus an alert log.
- **`modules/calls`:** `GET /calls` (filters: date range, agent, status, outcome, qualification), `GET /calls/:id`, `GET /calls/:id/events`. Transcript access requires `calls:read_transcript`.
- **`modules/leads`:**
  - `GET/PATCH /leads`, `GET /leads/:id`, `GET/POST/PATCH /lead-statuses`.
  - Lead `data` is validated against the **agent version's** field schema on write.
  - Dedupe by `(tenant, phone)` within 24 h: the lead is updated rather than duplicated.
- **`modules/phone-numbers`:** CRUD + assign to agent (manual SID entry for now; provisioning comes in P12).
- **Local dev:** `pnpm tunnel` (cloudflared/ngrok) + a script that sets the Twilio number's webhook URL.

**Tests**

- Signed and unsigned webhook tests (unsigned → 403), idempotent retry replays the same TwiML, full call via simulated webhooks → lead row with validated data.

**Definition of Done**

- A real call to the ABC Real Estate number and a real call to the XYZ Clinic number each complete their own qualification flow on the same deployment, with calls and leads stored in the correct tenant.

---

## P6 — Frontend foundation & Level 1 screens

**Goal:** a usable control centre for Level 1 features.

- **App shell:** responsive sidebar layout, tenant switcher, user menu, dark/light theme, breadcrumb, toast system, error boundary, empty states, and skeletons. Menu items are filtered by permissions.
- **Routes (`/t/[tenant]/…`):**
  - `dashboard`: KPI tiles (calls, answered, completed, qualified leads, transfers, failed, avg duration) + a 30-day calls chart (`/analytics/summary` endpoint).
  - `agents`: list with status toggle. `agents/[id]` is a basic edit form for greeting, persona, and instructions, plus a simple field list editor. It saves a new draft version, and a Publish button publishes it.
  - `calls`: data table (server-side pagination, filters, URL-synced state). `calls/[id]` shows call info → transcript → timeline → extracted data → outcome.
  - `leads`: table with **dynamic columns** from the agent's fields, a status dropdown, and notes.
  - `settings/phone-numbers`: list and assign to an agent.
- **Data layer:** generated OpenAPI client, TanStack Query hooks per resource, Server Components for the first render, and zod form schemas imported from `@platform/shared`.
- **Accessibility:** keyboard navigation, labelled inputs, contrast AA, and a responsive table → cards layout on mobile.

**Tests**

- Component tests (Vitest + Testing Library) and a Playwright E2E test: register → edit agent → publish → simulated call via webhooks → lead appears.

### ✅ M1 — Level 1 milestone

- Two businesses on one deployment, configured purely by data.
- Real phone calls qualify leads that are visible in the UI.
- The fallback-only mode works.
- The isolation suite and RBAC matrix are green.

---

## P7 — Agent editor, versioning, workflow engine, test console

- **Backend**
  - `GET /agents/:id/versions`, `POST /agents/:id/versions` (new draft from current or from a template), `PATCH /agent-versions/:id` (draft only), `POST /agent-versions/:id/publish` (runs `AgentConfig` + domain validation: tools connected, collections exist, phone number assigned), `POST /agents/:id/rollback/:versionId`, `POST /agents/from-template`.
  - Config diff endpoint between versions.
  - **Test console**: `POST /agent-versions/:id/test-sessions` and `POST /test-sessions/:id/messages` run the real runtime in text mode against a **draft**, and return the reply plus live state and events.
  - Workflow engine: all step types, `branch` conditions (`eq, neq, in, gt, lt, exists`), `on_error` routing, and working-hours behaviour (off-hours message / take message / handoff).
- **Frontend: agent editor tabs**
  - Profile: name, voice, language, greeting.
  - Behaviour: persona, instructions, business rules, allowed actions.
  - **Qualification builder:** drag-and-drop ordering (dnd-kit), type-specific inputs, options editor, validation rules, re-ask prompts, and a live preview of the question sequence.
  - Workflow: a step list editor with a condition builder.
  - Working hours: a weekly grid + holidays.
  - Escalation & handoff.
  - Versions: history, diff, rollback.
  - **Test console:** a chat panel with the extracted-state inspector and event timeline.
  - Unsaved-changes guard; client + server validation errors mapped to fields via problem+json `errors[]`.
- **Tests:** a publish with invalid references is rejected with field-level errors; calls pin the version (editing a draft during a call does not change that call); workflow branch tests.

---

## P8 — Documents & knowledge base (ingestion)

- **Storage:** S3-compatible (MinIO locally). `POST /documents/upload-url` → a presigned PUT, with content-type and size restrictions per plan → client uploads → `POST /documents/:id/complete` enqueues ingestion.
- **Validation:**
  - MIME allow-list (pdf, docx, txt, csv, xlsx, png, jpg, webp) + magic-byte sniffing (`file-type`).
  - Size limits per plan.
  - SHA-256 dedupe per collection (409 on duplicate).
  - Filename sanitisation.
  - ClamAV scan hook (optional in dev).
- **Worker pipeline (BullMQ `ingestion` queue)**, with status and progress updated at each step:
  1. `EXTRACTING`: pdf (`unpdf`/pdf.js text + page numbers; pages with no text → OCR), docx (`mammoth` → structured HTML → text with headings), txt, csv (`papaparse`), xlsx (`exceljs`: one record per row, `Header: value`), images (`tesseract.js`, with Gemini vision as the fallback).
  2. Cleaning: whitespace normalisation, repeated header/footer removal, dedupe.
  3. Chunking: heading-aware, 300–500 tokens, 10–15% overlap; tables and rows kept whole; metadata `{page, headingPath, sheet, row}`.
  4. `EMBEDDING`: batched embeddings, retry with backoff, rate-limit aware.
  5. Chunks inserted with `$queryRaw` (vector). On **replace**, old chunks are deleted in the same transaction once the new version is ready.
  6. `READY`, or `FAILED` with a user-readable `statusMessage`. Jobs are idempotent and resumable.
- **API:** collections CRUD; `GET /documents` (filters: collection, status, enabled, search by title); `GET /documents/:id` (metadata, chunk count, preview of the first chunks); `PATCH` (title, enabled, agent assignment); `POST /documents/:id/replace`; `DELETE`; `GET /documents/:id/download` (signed URL); `GET /documents/events` (SSE status stream); `POST /knowledge/search` (semantic search playground, tenant and collection scoped).
- **Frontend: Knowledge section**
  - Collections list and create/edit.
  - Drag-and-drop multi-upload with per-file progress.
  - Documents table with live status badges (`Uploading → Processing → Extracting → Embedding → Ready / Failed`), enable toggle, assign to agents, replace, delete (confirm), and a metadata drawer.
  - Search playground showing chunks with scores and source page.
  - Agent editor → Knowledge tab: assign collections, `topK`, `minScore`.
- **Tests:** a fixture file of each type → expected chunk counts and metadata; a failed extraction → `FAILED` with a message; replacing keeps old chunks until the new version is ready; the isolation test covers chunks and search.

---

## P9 — Tools, integrations, appointments, handoff

- **`packages/crypto`:** envelope encryption (per-tenant DEK stored in `tenants.encrypted_dek`, master key from env/KMS, AES-256-GCM). Credentials are decrypted only inside the tool executor.
- **`packages/tools`:**
  - Registry of tools: name, zod input/output, `sideEffect`, `critical|background`, and the required integration type.
  - Executor steps:
    1. Check the agent version's `agent_tools` grant.
    2. Validate input.
    3. Decrypt credentials.
    4. Apply a timeout and retries.
    5. Use an idempotency key (`callId:stepId`).
    6. Emit a `TOOL_CALL` event + audit entry.
- **Built-in tools (v1):** `sheets.append_row`, `calendar.find_slots`, `calendar.book`, `calendar.cancel` (Google Calendar), `email.send` (SMTP/Resend), `webhook.post` (HMAC-SHA256 signed), `leads.create` (internal), `appointments.create` (internal).
- **Integrations API:** `GET /integrations`, `POST /integrations` (API-key types), `GET /integrations/oauth/:type/start` and `/callback` (Google), `POST /integrations/:id/test`, `PATCH`, `DELETE`. **Responses never include credentials**, only `status`, `lastError`, and `expiresAt`.
- **Appointments:**
  - `GET /appointments` (range, status), `PATCH /appointments/:id` (reschedule/cancel → synced to the calendar tool).
  - Validation: within working hours, lead time, no overlaps (DB CHECK + service check).
- **Human handoff:** a `handoff` step → Twilio `<Dial>` to the configured number/SIP with a whisper summary; if the transfer is not answered → take a message + create a follow-up lead; an SMS/email summary goes to staff.
- **Frontend:**
  - Integrations page: cards per type, connect wizard, test button, status.
  - Agent editor → Tools tab: enable the tools that have a connected integration.
  - Appointments page: calendar (week/month) + list, with reschedule/cancel dialogs.
  - Lead statuses editor (Kanban columns).
- **Tests:** permission denial (tool not granted → fallback, never executed); a calendar tool timeout → the `on_error` step; credentials never appear in any API response (a snapshot test over all integration endpoints).

### ✅ M2 — Level 2 milestone

A new business onboards entirely from the UI, without an engineer:

1. Register.
2. Create an agent from a template.
3. Customise fields and workflow.
4. Upload documents.
5. Connect a calendar.
6. Assign a number.
7. Test in the console.
8. Publish.
9. Take real calls that book appointments.

---

## P10 — Live-call RAG

- `retrieve` node:
  - Runs only when `intent ∈ {question, both}`, in parallel with extraction.
  - Timeout of about 400 ms.
  - Tenant, collection, enabled, and agent-restriction filters (the SQL in plan §7.2).
  - pgvector `hnsw.ef_search` tuned, with iterative scan enabled.
- Grounding:
  - Context packing (top-k within a token budget).
  - The answer prompt requires chunk-id citations.
  - The guard verifies the citations and checks that numbers, prices, and dates appear in the sources.
  - Below `minScore`, or on a timeout or error, the agent uses the **safe response** and adds the question to `pendingQuestions` → follow-up task/handoff according to the escalation rules.
- Voice-friendly answers: 1–2 sentences, no tables read aloud, and "Would you like me to send the details on WhatsApp?" when the answer is long.
- Events: `RAG_RETRIEVAL` with the query, chunk ids, scores, and used flags. The call detail page shows "RAG sources used" with links to the document and page.
- Knowledge gaps report: unanswered questions grouped by similarity, with an "Add to FAQ" action.
- **Tests:** a RAG eval set per template (30+ Q&A pairs): retrieval hit-rate ≥ 90%, and **zero** invented business facts on out-of-knowledge questions. Latency budget test.

---

## P11 — Production state, queues, CRM, analytics

- `RedisSessionStore`: `session:{callId}` with a 2 h TTL, a per-call lock (Redlock-lite), a turn sequence for idempotency, and a Postgres snapshot on every turn for recovery.
- BullMQ in production:
  - Queues: `ingestion`, `exports`, `crm`, `notifications`, `analytics`, `webhooks`.
  - Retries with exponential backoff and dead-letter queues.
  - Bull Board (admin only) and a "Failed jobs" view per tenant.
- CRM adapters: HubSpot + Zoho (OAuth), with a field-mapping UI (agent field → CRM property, validated types), and sync status on leads.
- Analytics:
  - Hourly/daily roll-up tables (calls, outcomes, qualification funnel per field, bookings, transfers, latency p50/p95 per hop, tool failures, RAG stats, cost).
  - The full Analytics page with date range and agent filters, plus CSV export.
- Usage metering: `usage_records` on every LLM, embedding, telephony, and TTS use, and cost estimates from a price table.

---

## P12 — Security hardening, observability, deployment

- Twilio subaccount per tenant (provisioned on tenant creation), with number search and purchase from the UI; geo permissions and a per-number concurrency cap.
- Usage limits enforced at call start and on uploads (plan limits) → graceful refusal message + an owner alert.
- Toll-fraud and abuse controls: blocklists, per-caller rate limits, max call duration, and anomaly alerts.
- PII redaction before persisting events and logs; per-tenant retention policy + a nightly purge job; signed short-lived URLs for recordings.
- 2FA (TOTP) and a session management page (revoke sessions).
- Security headers (helmet, CSP on web), CORS allow-list, dependency scanning (`pnpm audit`, Dependabot), secret scanning, and `/security-review` before release.
- Observability:
  - pino JSON logs with `tenantId` and `callId`.
  - OpenTelemetry traces across api → runtime → providers → db.
  - Prometheus metrics and Grafana dashboards.
  - Alerts on fallback rate, error rate, p95 turn latency, ingestion failures, queue depth, and cost spikes.
- Deployment:
  - Docker images (api, worker, web).
  - Managed Postgres 16 + pgvector (Neon/RDS/Cloud SQL) and managed Redis.
  - API/worker on Cloud Run/ECS/Kubernetes with min instances ≥ 1; web on Vercel or the same platform.
  - `prisma migrate deploy` as a release step.
  - Blue/green deploys; nightly backups + a restore drill.
- Load test: 50 concurrent calls (k6 against webhooks + simulator).

### ✅ M3 — Level 3 milestone

- The production readiness checklist (plan §18) passes.
- p95 turn processing is under 1.2 s on the webhook path.
- The isolation, RBAC, and credential-leak suites are green.

---

## P13 — Streaming voice

- `apps/voice`:
  - Recommended: **LiveKit Agents (Node)** behind a Twilio SIP trunk.
  - Alternative: Twilio Media Streams over WebSocket.
- Pipeline: Silero VAD + turn detection → Deepgram streaming ASR → runtime (the same graph) with streaming LLM tokens → sentence/clause chunker → Cartesia/ElevenLabs streaming TTS.
- Barge-in (stop playback and clear buffers on speech onset), endpointing at 300–500 ms, filler audio for tools taking over 700 ms, and echo handling.
- Per-agent choice between `webhook` and `streaming` mode.
- A latency dashboard per hop against the budget (ASR ≤ 250 ms, LLM time-to-first-token ≤ 300 ms, TTS ≤ 150 ms; end to end under 800 ms).

## P14 — Advanced RAG, multi-provider AI, billing, enterprise

- Hybrid search (the `search_vector` GIN index already exists + vector, reciprocal rank fusion), re-ranking, query rewriting from conversation context, an FAQ fast-path cache, per-collection chunking strategies, and an embedding-model migration job (re-embed in the background, then switch atomically).
- OpenAI and Anthropic providers, per-agent provider and model choice, automatic failover order, and cost-aware routing (a small model for extraction, a larger one for answers).
- Telnyx/Plivo adapters; outbound campaigns (call back new web leads within 60 s, appointment reminders).
- More integrations: Salesforce, Cal.com, WhatsApp Business (Meta), and a REST tool builder (tenant-defined endpoint + zod-validated schema).
- Billing: plans, metered usage from `usage_records`, Stripe/Razorpay subscriptions and invoices, overage alerts, and hard limits.
- Enterprise: SSO (SAML/OIDC), white-labelling, data-residency option, custom retention, a visual workflow builder, multilingual agents (Hindi/Malayalam/…), sentiment-based escalation, and live call monitoring with whisper/barge by staff.

### ✅ M4 — Level 4 milestone

A business-ready, multi-tenant, RAG-powered voice agent SaaS.

---

## 4. Frontend route map (final)

```
/login  /register  /invite/[token]
/t/[tenant]/dashboard
/t/[tenant]/agents                 /agents/new (from template)   /agents/[id]/{profile,behaviour,qualification,workflow,
                                                                   knowledge,tools,hours,escalation,versions,test}
/t/[tenant]/knowledge              /knowledge/collections/[id]   /knowledge/documents/[id]   /knowledge/search   /knowledge/gaps
/t/[tenant]/calls                  /calls/[id]
/t/[tenant]/leads                  /leads/[id]
/t/[tenant]/appointments
/t/[tenant]/integrations           /integrations/[id]
/t/[tenant]/analytics
/t/[tenant]/settings/{profile,users,roles,phone-numbers,ai-defaults,security,api-keys,webhooks,billing,audit-log}
/admin/{tenants,usage,providers}   (platform owner only)
```

## 5. How to start each phase

1. Create the branch `phase/NN-name` from `main`.
2. Write the zod schemas and DB migration first, then services with tests, then controllers, then UI.
3. Keep CI green on every push; open a PR per coherent slice (not one giant PR per phase).
4. Close the phase with its Definition of Done checklist + a demo, tag `v0.NN.0`, and update the checkboxes in this document.

**Next up:** finish **P0** (monorepo scaffold, docker-compose, CI), then the remaining **P1** items (db package, seed, isolation test suite).
