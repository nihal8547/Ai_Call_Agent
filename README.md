# AI Voice Agent Platform

A multi-tenant, configurable, RAG-powered platform for AI phone agents. Any business (real estate, clinics, hotels, restaurants, …) can create voice agents, upload its knowledge, configure qualification questions and workflows, connect tools, and monitor calls, leads, and appointments.

- Architecture: [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md)
- Build phases and progress: [`docs/DEVELOPMENT_PHASES.md`](docs/DEVELOPMENT_PHASES.md)

## Stack

TypeScript monorepo (pnpm + Turborepo):

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

Requirements: Node 22.12+, pnpm 10, Docker.

```bash
pnpm install
cp .env.example .env
docker compose -f infra/docker-compose.yml up -d   # postgres+pgvector, redis, minio, mailpit
pnpm db:migrate                                    # apply migrations (owner connection)
pnpm dev                                           # api :4000, web :3000, worker
```

- API health: http://localhost:4000/health, readiness: http://localhost:4000/ready
- Web: http://localhost:3000

## Everyday commands

| Command                                                     | Does                                                                         |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `pnpm build` / `pnpm typecheck` / `pnpm lint` / `pnpm test` | Run across all packages (Turborepo)                                          |
| `pnpm format`                                               | Prettier                                                                     |
| `pnpm db:migrate:dev --create-only --name <change>`         | Create a migration after editing `schema.prisma` (review the SQL; see below) |
| `pnpm db:check`                                             | Fail if migrations and `schema.prisma` disagree                              |
| `pnpm db:seed`                                              | Load demo tenants                                                            |

### Taking real phone calls (Twilio)

1. Expose the API over HTTPS, e.g. `cloudflared tunnel --url http://localhost:4000`, and set `PUBLIC_BASE_URL` to that URL.
2. Set `TWILIO_AUTH_TOKEN` (Twilio console → Account → API keys & tokens).
3. Attach your Twilio number to an agent: `SEED_NUMBER_CLINIC=+91… pnpm db:seed`, or add it under Settings → Phone numbers.
4. In the Twilio console, for that number:
   - **A call comes in** → Webhook `POST {PUBLIC_BASE_URL}/telephony/twilio/voice`
   - **Call status changes** → `POST {PUBLIC_BASE_URL}/telephony/twilio/status`
5. Call the number. Calls, transcripts and leads appear in the web app; without `GEMINI_API_KEY` the agent runs on deterministic understanding.

### Knowledge base (documents)

- Upload files under **Knowledge Base** in the web app. The **worker** must be running (`pnpm dev` starts it) to process them.
- Files are stored under `STORAGE_LOCAL_DIR` (default `.data/storage`) or in S3 with `STORAGE_DRIVER=s3` and the `S3_*` settings. Use S3 when more than one server runs the API or worker.
- Search is hybrid: meaning (pgvector) plus keywords (Postgres full-text). Meaning search needs embeddings: set `GEMINI_API_KEY` (or `EMBEDDINGS_PROVIDER=hashing` for an offline stand-in). Without either, documents are searchable by keywords only. After changing the provider, **Reprocess** existing documents.
- Scanned PDFs and images need `GEMINI_API_KEY` for text recognition; without it they fail with a clear message.
- Try questions in **Knowledge Base → Search playground**, then pick collections per agent in the agent editor's **Knowledge** tab.

### Integrations and tools

- Connect services under **Integrations**: Google Calendar and Google Sheets (a service-account key, or "Connect with Google" when `GOOGLE_OAUTH_CLIENT_ID`/`SECRET` are set), email over SMTP, and signed webhooks.
- Credentials are encrypted with the business's own key (envelope encryption with `MASTER_ENCRYPTION_KEY`). They are never returned by the API, and a webhook's signing secret is shown once.
- In an agent's **Workflow & tools** tab, tick the tools it may use and pick the integration each one runs through. Publishing is refused until every ticked tool has one.
- Webhooks and SMTP cannot reach private or loopback addresses. `ALLOW_PRIVATE_NETWORK_TOOLS=true` lifts this for local development only.
- Webhook requests carry `x-platform-signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.body">` and an `idempotency-key`.

### Database rules

- The app connects as `voice_app` (member of `app_user`), so **Row-Level Security isolates tenants**. Migrations use the owner connection (`DATABASE_MIGRATION_URL`).
- Prisma cannot model the pgvector HNSW index. When a generated migration contains `DROP INDEX "document_chunks_embedding_hnsw_idx"`, delete that line. `pnpm db:check` catches any other drift.

### Deployment notes

- **Client IPs and rate limits:** the web app proxies `/api/*` to the API and passes `X-Forwarded-For` through unchanged. In production, run the web app behind a load balancer that appends the real client IP (Cloud Run, Vercel, ALB, nginx all do), and list the load balancer and web server addresses in `TRUST_PROXY`. The API only honours `X-Forwarded-For` from those peers.
- **Cookies:** sessions use httpOnly cookies scoped to the web origin. Set `COOKIE_SECURE=true` (the default in production) and serve over HTTPS.
