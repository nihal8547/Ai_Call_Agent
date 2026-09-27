# 6. Build and run

## Requirements

- Node.js 22.12 or newer, npm 10
- Docker (for Postgres 16 + pgvector and Redis 7, or the whole stack)
- Optional: a Gemini API key (the platform works without one, on deterministic wording),
  a Twilio account (real phone calls), SMTP / Google / HubSpot / Zoho for integrations

## 1. Local development (hot reload)

```bash
npm install                                        # all workspaces
cp .env.example .env                               # then set secrets (see below)
docker compose -f infra/docker-compose.yml up -d   # Postgres+pgvector, Redis, MinIO, Mailpit
npm run db:migrate                                 # apply migrations (owner connection)
npm run db:seed                                    # optional: demo businesses and agents
npm run dev                                        # api :4000, web :3000, worker (watch mode)
```

Open http://localhost:3000, create a business, pick a template, publish the agent, and use the
**Test** tab to talk to it. Health checks: http://localhost:4000/health and `/ready`.

Secrets to set in `.env` (generate fresh ones, never commit `.env`):

```bash
node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))'   # MASTER_ENCRYPTION_KEY
node -e 'console.log(require("crypto").randomBytes(48).toString("base64url"))' # JWT_SECRET
```

Every variable is validated when a process starts; a wrong value stops it with a clear list of
problems. The full list with explanations is in [`.env.example`](../../.env.example).

## 2. Real phone calls in development

1. Expose the API over HTTPS (e.g. `cloudflared tunnel --url http://localhost:4000`) and set
   `PUBLIC_BASE_URL` to that URL (Twilio signs requests with it).
2. Set `TWILIO_AUTH_TOKEN`; optionally `TWILIO_ACCOUNT_SID` + an API key to buy numbers and create
   SIP domains from the app.
3. Add or buy a number under **Phone numbers**, choose the agent, call it.

## 3. Everything in Docker

```bash
cp .env.example .env     # JWT_SECRET, MASTER_ENCRYPTION_KEY, POSTGRES_PASSWORD, APP_DB_PASSWORD, …
docker compose up -d --build
docker compose --profile observability up -d     # optional: Prometheus :9090, Grafana :3001
```

One multi-stage `Dockerfile` builds four images:

| Target    | Contains                                      | Runs                                                 |
| --------- | --------------------------------------------- | ---------------------------------------------------- |
| `migrate` | Prisma and migrations                         | `prisma migrate deploy`, then exits                  |
| `api`     | API + packages (production dependencies only) | `node dist/main.js` on :4000 (health check built in) |
| `worker`  | Worker + packages                             | `node dist/main.js` (metrics :9464)                  |
| `web`     | Next.js standalone build                      | `node server.js` on :3000                            |

Build stages: `deps` (install once, cached) → `build` (Turborepo builds every package) → `prod`
(prune dev dependencies) → the small runtime images, running as the non-root `node` user.

## 4. How the code is built

- **Packages** (`packages/*`) compile TypeScript to `dist/` with `tsc`; apps import them as
  `@platform/<name>` through npm workspaces.
- **Turborepo** runs tasks in dependency order and caches results: `build` depends on the
  packages' builds; `typecheck`, `lint` and `test` depend on those builds (the web typecheck also
  waits for the web build, which generates route types).
- **API and worker**: `tsc` → `dist/`, started with `node --enable-source-maps dist/main.js`.
- **Web**: `next build` (all pages render per request so each gets its CSP nonce).
- **Database**: `prisma generate` builds the typed client; migrations are SQL files in
  `packages/db/prisma/migrations`.

## 5. Everyday commands

| Command                                                   | Does                                                         |
| --------------------------------------------------------- | ------------------------------------------------------------ |
| `npm run build` / `typecheck` / `lint` / `test`           | Across all workspaces (Turborepo)                            |
| `npm run format` / `format:check`                         | Prettier                                                     |
| `npm run db:migrate`                                      | Apply migrations                                             |
| `npm run db:migrate:dev -- --create-only --name <change>` | New migration after editing `schema.prisma` (review the SQL) |
| `npm run db:check`                                        | Fail if migrations and the schema disagree                   |
| `npm run db:seed`                                         | Demo data                                                    |
| `npm run simulate`                                        | Talk to an agent in the terminal                             |
| `npm run audit:prod`                                      | Dependency security gate                                     |
| `node scripts/loadtest.mjs 50`                            | 50 simultaneous simulated calls against an API               |
| `scripts/backup.sh` / `scripts/restore-drill.sh <dump>`   | Backup; prove a backup restores                              |

## 6. Tests

- **Unit tests** per package (engine, normalisers in English and Arabic, parsers, tools, RAG, AI
  adapter with a fake network).
- **Integration tests** in `apps/api/test`: the real application against real Postgres and Redis
  (`TEST_DATABASE_URL`, `TEST_APP_DATABASE_URL`, `REDIS_URL`), including simulated phone calls
  with signed Twilio webhooks, a fake Twilio REST server, fake SMTP and webhook receivers.
- **Database tests** in `packages/db/test`: tenant isolation on every table, migrations.
- Current count: about 600 tests (API 133, core 174, db 121, tools 47, rag 25, and more).
- Browser checks with Playwright were run by hand for each phase (not in CI yet).

## 7. Continuous integration (`.github/workflows/ci.yml`)

On every push and pull request:

1. Install, create database roles, apply migrations, check migrations match the schema
2. Format check, lint, typecheck, tests (with Postgres + pgvector and Redis services), build
3. Security job: dependency audit gate, gitleaks secret scan, Prometheus rules check and tests

## 8. Releasing to production

See [DEPLOYMENT.md](../DEPLOYMENT.md): build and push images tagged by commit, run `migrate` as a
release step, roll out API/worker/web (calls in progress continue), watch dashboards, roll back
by redeploying the previous tag.
