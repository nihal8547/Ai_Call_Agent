# AI Voice Agent Platform

A multi-tenant, configurable, RAG-powered platform for AI phone agents. Any business (real estate, clinics, hotels, restaurants, …) can create voice agents, upload its knowledge, configure qualification questions and workflows, connect tools, and monitor calls, leads, and appointments.

- Architecture: [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md)
- Build phases and progress: [`docs/DEVELOPMENT_PHASES.md`](docs/DEVELOPMENT_PHASES.md)

## Stack

TypeScript monorepo (pnpm + Turborepo):

| Path              | What                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------- |
| `apps/api`        | NestJS (Fastify) REST API + telephony webhooks                                              |
| `apps/worker`     | BullMQ background workers                                                                   |
| `apps/web`        | Next.js management app                                                                      |
| `packages/db`     | Prisma schema, migrations (incl. Row-Level Security + pgvector), tenant-scoped client, seed |
| `packages/shared` | zod schemas, types, and constants shared by every app                                       |

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

### Database rules

- The app connects as `voice_app` (member of `app_user`), so **Row-Level Security isolates tenants**. Migrations use the owner connection (`DATABASE_MIGRATION_URL`).
- Prisma cannot model the pgvector HNSW index. When a generated migration contains `DROP INDEX "document_chunks_embedding_hnsw_idx"`, delete that line. `pnpm db:check` catches any other drift.

### Deployment notes

- **Client IPs and rate limits:** the web app proxies `/api/*` to the API and passes `X-Forwarded-For` through unchanged. In production, run the web app behind a load balancer that appends the real client IP (Cloud Run, Vercel, ALB, nginx all do), and list the load balancer and web server addresses in `TRUST_PROXY`. The API only honours `X-Forwarded-For` from those peers.
- **Cookies:** sessions use httpOnly cookies scoped to the web origin. Set `COOKIE_SECURE=true` (the default in production) and serve over HTTPS.
