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

### Database rules

- The app connects as `voice_app` (member of `app_user`), so **Row-Level Security isolates tenants**. Migrations use the owner connection (`DATABASE_MIGRATION_URL`).
- Prisma cannot model the pgvector HNSW index. When a generated migration contains `DROP INDEX "document_chunks_embedding_hnsw_idx"`, delete that line. `pnpm db:check` catches any other drift.
