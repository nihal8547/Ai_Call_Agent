# 4. Tech stack and formats

## Stack

| Layer                   | Technology                                                      | Version            | Why                                                                       |
| ----------------------- | --------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------- |
| Language                | **TypeScript** (strict) everywhere                              | 5.9                | One language for API, web, worker and shared schemas                      |
| Runtime                 | **Node.js**                                                     | ≥ 22.12            | LTS; native `fetch`, `--env-file`                                         |
| Monorepo                | **npm workspaces** + **Turborepo**                              | npm 10, turbo 2    | Shared packages, cached builds and tests                                  |
| API framework           | **NestJS** on **Fastify**                                       | Nest 11, Fastify 5 | Modules, guards, DI; Fastify for speed                                    |
| Web                     | **Next.js** (App Router) + **React**                            | 15.5, 19           | Server-rendered dashboard, per-request CSP nonce                          |
| Styling                 | **Tailwind CSS**                                                | 4                  | Utility classes; white and black theme                                    |
| Fonts and icons         | **Geist** (Latin), **IBM Plex Sans Arabic**, **Lucide** icons   | —                  | Self-hosted, no external font requests                                    |
| Data fetching / forms   | **TanStack Query**, **React Hook Form**                         | 5, 7               | Caching and polling; forms validated with the same zod schemas as the API |
| Validation              | **zod**                                                         | 4                  | One schema = runtime check + TypeScript type, shared by API and web       |
| Database                | **PostgreSQL** + **pgvector**                                   | 16, 0.6+           | Relational data, Row-Level Security, vector search, full-text search      |
| ORM                     | **Prisma**                                                      | 6.19               | Schema, migrations, typed queries                                         |
| Cache / queues          | **Redis** + **BullMQ**                                          | 7, 5               | Call state, locks, rate limits, background jobs with retries              |
| Orchestration           | **LangGraph** (`@langchain/langgraph`)                          | —                  | The turn pipeline: understand → search → engine → tools → phrase          |
| AI                      | **Google Gemini** (REST, no SDK)                                | flash / flash-lite | Understanding, phrasing, grounded answers, embeddings, OCR                |
| Telephony               | **Twilio** (voice webhooks, TwiML, REST, SIP domains)           | —                  | Real phone numbers, speech recognition, Polly voices                      |
| Documents               | unpdf, mammoth, exceljs, papaparse                              | —                  | PDF, Word, Excel, CSV extraction                                          |
| Storage                 | Local disk or **S3-compatible** (AWS SDK v3)                    | —                  | Uploaded documents                                                        |
| Email                   | nodemailer (each business's own SMTP)                           | —                  | Staff notifications                                                       |
| Security libs           | argon2 (passwords), jose (JWT), Node crypto (AES-256-GCM, TOTP) | —                  | See [security](05-SECURITY.md)                                            |
| Logs / metrics / traces | pino, prom-client, OpenTelemetry                                | —                  | JSON logs, Prometheus, OTLP traces                                        |
| Tests                   | **Vitest**, Playwright (browser checks)                         | 3                  | Unit and integration tests against real Postgres and Redis                |
| Quality                 | ESLint 9 (typescript-eslint), Prettier 3                        | —                  | Lint and formatting, enforced in CI                                       |
| Containers              | Docker (multi-stage), Docker Compose                            | —                  | Same images in development and production                                 |
| Monitoring              | Prometheus, Grafana                                             | 2.55, 11.3         | Dashboards and alert rules                                                |

## Formats used

| Where                      | Format                                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API requests and responses | JSON; field names camelCase                                                                                                                                   |
| API errors                 | **RFC 7807 Problem Details** (`application/problem+json`): `type`, `title`, `status`, `code`, `detail`, `errors[{path, message}]`, `requestId`                |
| Pagination                 | Cursor based: `{ items: [...], nextCursor }`                                                                                                                  |
| Twilio webhooks in         | `application/x-www-form-urlencoded`, signed with `X-Twilio-Signature` (HMAC-SHA1)                                                                             |
| Replies to Twilio          | **TwiML** (XML): `<Gather input="speech">`, `<Say voice language>`, `<Dial>`, `<Hangup/>`, `<Reject/>`                                                        |
| Phone numbers              | **E.164** (`+97455123456`); SIP URIs `sip:+974…@name.sip.twilio.com`                                                                                          |
| Dates and times            | Stored as UTC timestamps (`timestamptz`); collected dates as `YYYY-MM-DD`, times as `HH:MM`, interpreted in the business's IANA time zone (e.g. `Asia/Qatar`) |
| Money                      | Usage cost in **micro-dollars** (integers); amounts collected from callers as plain numbers with the field's currency (`QAR`, `INR` …)                        |
| Agent configuration        | One JSON document per version (validated by the `AgentConfig` zod schema)                                                                                     |
| Placeholders in agent text | `{{agent_name}}`, `{{business_name}}`, `{{field_key}}`                                                                                                        |
| Embeddings                 | `vector(768)` in pgvector, cosine distance, HNSW index                                                                                                        |
| Sessions                   | JWT (HS256) access token + opaque refresh token, both in httpOnly cookies                                                                                     |
| Secrets at rest            | AES-256-GCM envelope encryption (a data key per business, wrapped by the master key)                                                                          |
| Logs                       | JSON lines (pino) with `requestId`, `tenantId`, `userId`                                                                                                      |
| Metrics                    | Prometheus text format at `/metrics`                                                                                                                          |
| Traces                     | OTLP over HTTP                                                                                                                                                |
| CSV export                 | UTF-8 CSV with formula-injection protection                                                                                                                   |
| Configuration              | Environment variables, validated at start-up (`.env` in development)                                                                                          |

## Code conventions

- Strict TypeScript, no `any` in application code; shared types come from zod schemas.
- Every external input (HTTP body, query, webhook, AI output, file) is parsed with zod or a
  dedicated parser before use.
- Tests live next to each package in `test/`; integration tests hit real services.
- Prettier formats everything; ESLint runs in CI; the web app has no inline scripts (CSP).
