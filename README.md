# AI Voice Agent Platform

A multi-tenant, configurable, RAG-powered platform for AI phone agents. Any business (real estate, clinics, hotels, restaurants, …) can create voice agents, upload its knowledge, configure qualification questions and workflows, connect tools, and monitor calls, leads, and appointments.

- Architecture: [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md)
- Build phases and progress: [`docs/DEVELOPMENT_PHASES.md`](docs/DEVELOPMENT_PHASES.md)
- Running it in production: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) and the [runbook](docs/RUNBOOK.md)
- Full project documentation (overview, architecture, how it works, stack and formats, security, build and run): [`docs/project/`](docs/project/README.md)
- What is still to be built: [`docs/REMAINING_WORK.md`](docs/REMAINING_WORK.md)

## Stack

TypeScript monorepo (npm workspaces + Turborepo):

| Path                                                                     | What                                                                                          |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `apps/api`                                                               | NestJS (Fastify) REST API + telephony webhooks                                                |
| `apps/worker`                                                            | BullMQ background workers                                                                     |
| `apps/web`                                                               | Next.js management app                                                                        |
| `packages/db`                                                            | Prisma schema, migrations (incl. Row-Level Security + pgvector), tenant-scoped client, seed   |
| `packages/shared`                                                        | zod schemas, types, and constants shared by every app                                         |
| `packages/core`, `packages/runtime`, `packages/ai`, `packages/telephony` | Conversation engine, LangGraph turn graph, Gemini adapters, Twilio                            |
| `packages/rag`                                                           | Document extraction (PDF, Word, Excel, CSV, text, images), chunking, ingestion, hybrid search |
| `packages/storage`                                                       | Uploaded files on local disk or S3-compatible storage                                         |
| `packages/tools`                                                         | Tool executor: Google Calendar/Sheets, SMTP email, signed webhooks, platform bookings         |

PostgreSQL 16 + pgvector, Redis.

## Getting started

Requirements: Node 22.12+, npm 10, Docker.

```bash
npm install
cp .env.example .env
docker compose -f infra/docker-compose.yml up -d   # postgres+pgvector, redis, minio, mailpit
npm run db:migrate                                    # apply migrations (owner connection)
npm run dev                                           # api :4000, web :3000, worker
```

- API health: http://localhost:4000/health, readiness: http://localhost:4000/ready
- Web: http://localhost:3000

## Docker

Everything in containers (Postgres + pgvector, Redis, migrations, API, worker, web):

```bash
cp .env.example .env    # set JWT_SECRET, MASTER_ENCRYPTION_KEY, POSTGRES_PASSWORD, APP_DB_PASSWORD (+ GEMINI_API_KEY, TWILIO_AUTH_TOKEN)
docker compose up -d --build
```

- Web: http://localhost:3000 · API: http://localhost:4000 (`/health`, `/ready`; point Twilio webhooks at its public HTTPS URL).
- The `migrate` service applies database migrations before the API and worker start. The API and worker share the `storage` volume for uploaded documents (or set `STORAGE_DRIVER=s3`).
- Images come from one `Dockerfile` with the targets `api`, `worker`, `web` and `migrate`. The web image fixes its `/api` proxy target at build time (`API_INTERNAL_URL`, default `http://api:4000`).
- Behind HTTPS in production: set `COOKIE_SECURE=true`, `PUBLIC_BASE_URL`, `WEB_BASE_URL` and `TRUST_PROXY` (your load balancer's addresses).
- Builds that cannot reach Debian mirrors: `--build-arg NODE_IMAGE=node:22-bookworm --build-arg INSTALL_SYSTEM_PACKAGES=0`. Behind a TLS-intercepting proxy, pass its CA with `--secret id=ca,src=ca.pem`.
- For day-to-day development with hot reload, run only the databases (`docker compose -f infra/docker-compose.yml up -d`) and `npm run dev`.

## Everyday commands

| Command                                                                 | Does                                                                         |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `npm run build` / `npm run typecheck` / `npm run lint` / `npm run test` | Run across all packages (Turborepo)                                          |
| `npm run format`                                                        | Prettier                                                                     |
| `npm run db:migrate:dev -- --create-only --name <change>`               | Create a migration after editing `schema.prisma` (review the SQL; see below) |
| `npm run db:check`                                                      | Fail if migrations and `schema.prisma` disagree                              |
| `npm run db:seed`                                                       | Load demo tenants                                                            |

### Taking real phone calls (Twilio)

1. Expose the API over HTTPS, e.g. `cloudflared tunnel --url http://localhost:4000`, and set `PUBLIC_BASE_URL` to that URL.
2. Set `TWILIO_AUTH_TOKEN` (Twilio console → Account → API keys & tokens).
3. Attach your Twilio number to an agent: `SEED_NUMBER_CLINIC=+91… npm run db:seed`, or add it under Settings → Phone numbers.
4. In the Twilio console, for that number:
   - **A call comes in** → Webhook `POST {PUBLIC_BASE_URL}/telephony/twilio/voice`
   - **Call status changes** → `POST {PUBLIC_BASE_URL}/telephony/twilio/status`
5. Call the number. Calls, transcripts and leads appear in the web app; without `GEMINI_API_KEY` the agent runs on deterministic understanding.

With the platform's Twilio account set (`TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`,
`TWILIO_API_KEY_SECRET`), steps 3–4 happen in the app: **Settings → Phone numbers** offers three ways
for customers to call:

- **Use my existing number:** keep the number customers already call (Ooredoo, Vodafone or any
  carrier). The app shows the call-forwarding codes to dial and runs a test call.
- **Get a new number:** search and buy a Twilio number; it is pointed at the agent straight away.
- **Connect over SIP:** for a business SIP line or office phone system. The app creates a SIP
  address with an IP allow-list (and optional password) and a setup sheet for the carrier.

### Knowledge base (documents)

- Upload files under **Knowledge Base** in the web app. The **worker** must be running (`npm run dev` starts it) to process them.
- Files are stored under `STORAGE_LOCAL_DIR` (default `.data/storage`) or in S3 with `STORAGE_DRIVER=s3` and the `S3_*` settings. Use S3 when more than one server runs the API or worker.
- Search is hybrid: meaning (pgvector) plus keywords (Postgres full-text). Meaning search needs embeddings: set `GEMINI_API_KEY` (or `EMBEDDINGS_PROVIDER=hashing` for an offline stand-in). Without either, documents are searchable by keywords only. After changing the provider, **Reprocess** existing documents.
- Scanned PDFs and images need `GEMINI_API_KEY` for text recognition; without it they fail with a clear message.
- Try questions in **Knowledge Base → Search playground**, then pick collections per agent in the agent editor's **Knowledge** tab.
- On calls and in the test console, agents answer questions from their collections only. Each answer cites its sources; any number it speaks must appear in them. When nothing relevant is found, the agent says the team will confirm and records a follow-up. The call page shows which documents were used.
- **Knowledge Base → Knowledge gaps** groups the questions agents could not answer. **Add answer** saves an FAQ into a collection, and agents use it on the next call.
- Retrieval quality: `npm test -w @platform/api -- rag-eval` (offline). Add `EVAL_EMBEDDINGS=gemini REPORT=1` with `GEMINI_API_KEY` set to measure with real embeddings (about 4 minutes, paced for the free tier).

### Integrations and tools

- Connect services under **Integrations**: Google Calendar and Google Sheets (a service-account key, or "Connect with Google" when `GOOGLE_OAUTH_CLIENT_ID`/`SECRET` are set), email over SMTP, and signed webhooks.
- Credentials are encrypted with the business's own key (envelope encryption with `MASTER_ENCRYPTION_KEY`). They are never returned by the API, and a webhook's signing secret is shown once.
- In an agent's **Workflow & tools** tab, tick the tools it may use and pick the integration each one runs through. Publishing is refused until every ticked tool has one.
- Webhooks and SMTP cannot reach private or loopback addresses. `ALLOW_PRIVATE_NETWORK_TOOLS=true` lifts this for local development only.
- Webhook requests carry `x-platform-signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.body">` and an `idempotency-key`.
- Background work (webhook steps, emails, sheet rows, CRM syncs) runs on BullMQ queues with retries and exponential backoff. Anything that still fails appears under **Integrations → Failed deliveries**, where staff can send it again once the cause is fixed. The API process consumes these queues (`QUEUE_CONSUMERS=false` turns that off on request-only instances); the worker runs ingestion and analytics.
- **CRMs:** connect HubSpot (a private app token, or "Connect with HubSpot" with `HUBSPOT_CLIENT_ID`/`SECRET`) or Zoho CRM (a Self Client in your data center, or "Connect with Zoho" with `ZOHO_CLIENT_ID`/`SECRET`). Under **Field mapping**, choose which CRM field each answer goes to; types and choices are checked against the CRM. Leads are sent after each call and when staff edit them, and each lead shows its sync state.
- **Operators:** set `ADMIN_BOARD_PASSWORD` to open the queue dashboard at `<API>/admin/queues` (basic auth, user `admin`). It shows every tenant's jobs, so it is for platform operators, not businesses.

### Analytics and usage

- **Analytics** shows calls, outcomes, the qualification funnel, busiest hours, per-step latency (p50/p95), tool failures, knowledge answers and (for people with billing access) estimated cost, per date range and agent, with a CSV export.
- Figures come from hourly roll-ups (`analytics_hourly`, in the business's time zone). The worker refreshes them about 30 s after each call and sweeps recent hours every `ANALYTICS_SWEEP_MINUTES`. They can be rebuilt at any time from calls and events.
- Every call meters phone minutes, speech recognition, text-to-speech characters, AI tokens and embeddings (`usage_records`). Cost estimates use public list prices; set `USAGE_PRICES` to your own rates.

### Database rules

- The app connects as `voice_app` (member of `app_user`), so **Row-Level Security isolates tenants**. Migrations use the owner connection (`DATABASE_MIGRATION_URL`).
- Prisma cannot model the pgvector HNSW index. When a generated migration contains `DROP INDEX "document_chunks_embedding_hnsw_idx"`, delete that line. `npm run db:check` catches any other drift.

### Arabic agents (Qatar and the Gulf)

- Pick **Arabic (Qatar)** as the agent's language (or start from a Qatar Arabic template). The
  agent speaks Arabic with an Arabic voice and understands Gulf Arabic, standard Arabic and English.
- Without an AI key it still understands Arabic yes/no, names, amounts, dates and times.

### Security and monitoring

- Two-step sign-in and the list of signed-in devices: **Settings → Security**.
- Country, time zone, longest call and how long call records are kept: **Settings → Business**.
- Blocked callers, per-number call limits, plan limits and unusual-volume alerts protect against
  abuse and toll fraud; alerts show on the dashboard.
- Metrics: API `/metrics` and worker `:9464/metrics`; Prometheus and Grafana with
  `docker compose --profile observability up -d` (Grafana on port 3001). Traces go to
  `OTEL_EXPORTER_OTLP_ENDPOINT` when set.
- `npm run audit:prod` checks production dependencies; `scripts/backup.sh` and
  `scripts/restore-drill.sh` take and test backups; `scripts/loadtest.mjs` simulates concurrent calls.

### Deployment notes

Full guide: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

- **Client IPs and rate limits:** the web app proxies `/api/*` to the API and passes `X-Forwarded-For` through unchanged. In production, run the web app behind a load balancer that appends the real client IP (Cloud Run, Vercel, ALB, nginx all do), and list the load balancer and web server addresses in `TRUST_PROXY`. The API only honours `X-Forwarded-For` from those peers.
- **Cookies:** sessions use httpOnly cookies scoped to the web origin. Set `COOKIE_SECURE=true` (the default in production) and serve over HTTPS.
