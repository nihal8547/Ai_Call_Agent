# Deploying to production

The platform is four processes built from one [`Dockerfile`](../Dockerfile) (targets `api`,
`worker`, `web`, `migrate`) plus Postgres 16 with pgvector and Redis 7.
[`docker-compose.yml`](../docker-compose.yml) runs the whole stack on one machine and is the
reference for every setting below.

```
Twilio ──HTTPS webhooks──▶ api (NestJS, stateless, ≥ 2 instances) ──▶ Postgres (RLS) + pgvector
browsers ──HTTPS──▶ web (Next.js) ──/api proxy──▶ api                 └──▶ Redis (call state, queues)
                                     worker (BullMQ: ingestion, analytics, retention, CRM, email)
```

## 1. Managed services

| Service  | Use                                                                                                                               |
| -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Postgres | 16 with the `vector` extension (RDS, Cloud SQL, Azure Flexible Server, Neon, Supabase). Point-in-time recovery on.                |
| Redis    | 7, **AOF persistence on**, `maxmemory-policy noeviction` (BullMQ needs it). ElastiCache, Memorystore, Upstash (TLS: `rediss://`). |
| Storage  | S3-compatible bucket for uploaded documents (`STORAGE_DRIVER=s3`), private, versioning on.                                        |
| Secrets  | Secret Manager / Parameter Store / Vault; inject as environment variables.                                                        |

Database roles (the same as [`infra/postgres/init.sql`](../infra/postgres/init.sql)):

- `voice_owner`: owns the schema, runs migrations (`DATABASE_MIGRATION_URL`). Never used by the API at runtime.
- `voice_app`: the runtime login, member of `app_user`. Row-Level Security applies to it on every
  tenant table, so one business can never read another's rows even through a bug.
- The migration creates the `vector` extension: on managed Postgres, allow it for the owner first
  (e.g. `rds_superuser`, or enable it in the provider's extension list).

## 2. Where to run the containers

Any container platform works: Cloud Run, ECS Fargate, Kubernetes, Fly.io, a VM with Compose.

| Process | Instances                                 | Notes                                                                                                                                   |
| ------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| api     | **min 2**, scale on CPU and request count | Callers wait on every webhook: **no scale-to-zero** (cold starts break calls). Health `GET /health`, readiness `GET /ready`. Port 4000. |
| worker  | min 1, scale on queue depth               | No inbound traffic except `:9464/metrics`.                                                                                              |
| web     | min 1                                     | Port 3000. `API_INTERNAL_URL` points at the API's internal address.                                                                     |
| migrate | one-off job per release                   | `prisma migrate deploy`, then exits.                                                                                                    |

Put a load balancer with TLS in front of `api` (Twilio webhooks) and `web` (browsers). Set:

- `PUBLIC_BASE_URL` to the exact public HTTPS URL of the API as Twilio sees it. Twilio signs each
  webhook with this URL; a mismatch rejects every call.
- `WEB_BASE_URL`, `CORS_ORIGINS` (the web origin), `TRUST_PROXY` (your load balancer's range, so
  rate limits see real client IPs), `COOKIE_SECURE=true` (the default in production).
- **Streaming voice:** the load balancer must pass **WebSocket upgrades** to the API for
  `/telephony/twilio/relay` (nginx: `proxy_http_version 1.1`, `Upgrade` and `Connection` headers;
  most cloud load balancers do it by default) and allow idle connections of at least 10 minutes
  (a call's session stays open while the caller talks). Without it, set `VOICE_STREAMING=false`:
  every agent then answers turn by turn.

With `QUEUE_CONSUMERS=false` an API instance only serves requests; keep it `true` on at least one
(or run the call-side consumers on dedicated API instances).

## 3. Releasing

1. Build and push the four images, tagged with the commit SHA.
2. Run the `migrate` image as a release step against the owner connection. Migrations are
   additive (new columns nullable or defaulted, no renames in one step), so the running release
   keeps working on the new schema.
3. Roll out `api`, `worker`, `web` (rolling or blue/green). Calls in progress survive: their state
   is in Redis and mirrored to Postgres each turn, so any instance can take the next turn.
4. Watch the dashboards for 15 minutes (reply time, 5xx share, refused calls).
5. **Rollback** = redeploy the previous tag. No down-migrations are needed thanks to step 2.

CI ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) gates every change on lint,
typecheck, tests against real Postgres and Redis, the dependency audit (`npm run audit:prod`),
gitleaks, and `promtool` checks of the alert rules.

## 4. Configuration reference

Every variable is validated at start-up; a bad value stops the process with a list of problems.
Full list with comments: [`.env.example`](../.env.example). The ones that matter in production:

| Variable                                                                                    | Process     | Notes                                                                                                                                          |
| ------------------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                                              | api, worker | `voice_app` login. Add `?connection_limit=10` per instance, or use PgBouncer (transaction mode).                                               |
| `DATABASE_MIGRATION_URL`                                                                    | migrate     | `voice_owner` login.                                                                                                                           |
| `REDIS_URL`, `QUEUE_PREFIX`                                                                 | api, worker | Same values on both. One prefix per environment sharing a Redis.                                                                               |
| `MASTER_ENCRYPTION_KEY`                                                                     | api, worker | 32 random bytes, base64. Encrypts every business's data key. **Losing it loses every stored credential.** Keep two copies in the secret store. |
| `JWT_SECRET`                                                                                | api         | ≥ 32 random characters. Rotating it signs everyone out.                                                                                        |
| `TWILIO_AUTH_TOKEN`                                                                         | api         | Verifies webhook signatures.                                                                                                                   |
| `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`                         | api         | Optional. Businesses buy numbers and get SIP domains automatically. Without them the operator adds numbers and SIP domains by hand.            |
| `GEMINI_API_KEY`                                                                            | api, worker | Optional; calls work without it (deterministic wording).                                                                                       |
| `STORAGE_DRIVER=s3`, `S3_*`                                                                 | api, worker | Required with more than one instance (local disk isn't shared).                                                                                |
| `METRICS_TOKEN`                                                                             | api         | Needed if Prometheus scrapes from outside the private network.                                                                                 |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                                                               | api, worker | OTLP/HTTP collector for traces (Tempo, Honeycomb, Datadog…).                                                                                   |
| `ADMIN_BOARD_PASSWORD`                                                                      | api         | Enables the queue dashboard at `/admin/queues`. Put it behind your VPN too.                                                                    |
| `SMTP_URL`, `MAIL_FROM`                                                                     | api         | Platform email (invitations, password reset). Businesses' own email is separate, in Integrations.                                              |
| `GOOGLE_OAUTH_*`, `MICROSOFT_*`, `HUBSPOT_*`, `ZOHO_*`                                      | api         | Optional OAuth apps for one-click "Continue with …" integrations; see [OAUTH_SETUP.md](OAUTH_SETUP.md).                                        |
| `META_APP_ID`, `META_APP_SECRET`, `META_EMBEDDED_SIGNUP_CONFIG_ID`, `WHATSAPP_VERIFY_TOKEN` | api         | WhatsApp (Cloud API) and "Continue with Facebook"; see [WHATSAPP_SETUP.md](WHATSAPP_SETUP.md).                                                 |

## 5. Telephony

- **Twilio numbers**: bought in the app (with the platform account configured) are pointed at the
  API automatically: voice URL `PUBLIC_BASE_URL/telephony/twilio/voice`, status callback
  `…/telephony/twilio/status`. Numbers bought in the Twilio console need those two URLs set.
- **A business's existing number** (Ooredoo, Vodafone, any carrier) is forwarded to one of its
  Twilio numbers. The app shows the GSM codes and runs a test call. Forwarding abroad is charged
  by the business's carrier at its international rate. Twilio has few or no Qatar numbers, so a
  Qatar business either forwards to a number in another country or connects over SIP.
- **SIP connections**: each gets its own Twilio SIP domain `<name>.sip.twilio.com` with an IP
  allow-list and optional username and password, created by the API. The carrier or PBX sends
  calls to `sip:+974XXXXXXXX@<name>.sip.twilio.com`; the app's setup sheet has the details.
  Twilio's SIP address ranges must be allowed in the carrier's or PBX's firewall.
- Twilio subaccounts per business are not used yet: all numbers live on the platform account,
  and costs are attributed per business by the usage meter.

## 6. Observability

- Prometheus scrapes `api:4000/metrics` and `worker:9464/metrics`
  ([`infra/observability/prometheus.yml`](../infra/observability/prometheus.yml)). Alert rules
  with tests: [`alerts.yml`](../infra/observability/alerts.yml),
  [`alerts.test.yml`](../infra/observability/alerts.test.yml). Every alert links to the
  [runbook](RUNBOOK.md).
- Grafana dashboard: [`voice-platform.json`](../infra/observability/grafana/dashboards/voice-platform.json).
  Locally: `docker compose --profile observability up -d` → Grafana on <http://localhost:3001>.
- Logs are JSON on stdout: ship them with your platform's collector. Each line has `requestId`;
  signed-in requests add `tenantId` and `userId`. Authorization headers and cookies are redacted.

## 7. Backups and the restore drill

- Managed Postgres point-in-time recovery is the first line (keep ≥ 7 days).
- A portable copy nightly: [`scripts/backup.sh`](../scripts/backup.sh) (`pg_dump` custom format +
  SHA-256), uploaded to a bucket in another account or region with object lock.
- **Monthly restore drill**: [`scripts/restore-drill.sh`](../scripts/restore-drill.sh) restores a
  backup into a scratch database and checks migrations, row counts, that RLS is forced on every
  tenant table and that the app role sees nothing without a tenant. Record the time it took
  (your recovery time).
- Back up `MASTER_ENCRYPTION_KEY` separately from the database: a dump without the key can't
  decrypt stored credentials, and the key without the dump is useless (that's the point).
- Retention: each business chooses how long call records are kept (Business settings, default
  365 days); the worker removes transcripts and caller numbers from older calls every night.

## 8. Capacity

[`scripts/loadtest.mjs`](../scripts/loadtest.mjs) runs N concurrent simulated calls with signed
webhooks (`node scripts/loadtest.mjs 50` against a staging API). Measured on one API instance
(development machine, without an AI key): 50 simultaneous calls, 400 replies, no failures, p95
reply 376 ms, p99 440 ms, measured at the client. With Gemini, each AI-worded reply adds roughly
1.3–1.8 s, which is why the engine has a per-turn latency budget. Size API instances for your peak
simultaneous calls with headroom for one instance failing.

## 9. Security checklist

- [ ] Fresh `MASTER_ENCRYPTION_KEY` and `JWT_SECRET` per environment, only in the secret store.
- [ ] `ALLOW_PRIVATE_NETWORK_TOOLS` unset (the API refuses to start with it in production).
- [ ] Postgres and Redis on private networks only; TLS where the provider supports it.
- [ ] `/metrics`, `:9464` and `/admin/queues` not reachable from the internet.
- [ ] Platform owners use two-step sign-in (Security page).
- [ ] Dependabot PRs reviewed weekly; `npm run audit:prod` allow-list entries renewed before they expire.
- [ ] Restore drill done this month.
