# Runbook

What to do when an alert fires. Each section matches a rule in
[`infra/observability/alerts.yml`](../infra/observability/alerts.yml) (its `runbook` link).
Dashboards: Grafana → **Voice platform** (`docker compose --profile observability up -d`, then
<http://localhost:3001>). Logs are JSON (pino); every request line carries `requestId`, and
signed-in requests carry `tenantId` and `userId`, so filter by those first.

Useful places:

| Where                                     | What                                                   |
| ----------------------------------------- | ------------------------------------------------------ |
| `GET /ready`                              | API can reach Postgres and Redis (503 otherwise)       |
| `GET /metrics` (private network or token) | API metrics; the worker's are on `:9464/metrics`       |
| `<API>/admin/queues`                      | Bull Board: queues, failed jobs, retry (basic auth)    |
| App → Integrations → Failed deliveries    | Per-business dead letters, with retry                  |
| App → Dashboard                           | Business alerts (plan limits, call spikes, silent SIP) |

---

## slow-replies

**HighTurnLatencyP95**: the slowest 5% of replies take longer than 1.2 s (p95 over 10 minutes).

1. Grafana → _Reply time (p50 / p95)_ split by `ai`: slow only with `ai="true"`? Then the model is
   slow. Check the provider's status page and `voice_fallbacks_total{reason="llm_timeout"}`. The
   engine skips AI wording once a turn's latency budget is spent, so callers still get an answer;
   the fix is on the provider side.
2. Every AI mode slow → the API itself: CPU on API instances, Postgres latency (slow query log),
   Redis latency (`redis-cli --latency`). Scale API instances out; calls are stateless between
   turns (state is in Redis, mirrored in Postgres), so new instances take traffic immediately.
3. Only one business slow (metrics carry no tenant labels, so start from its complaint): a large
   knowledge base or many tools. Calls → a call → timeline shows where each turn's time went.

## ai-fallbacks

**HighFallbackRate**: more than half of the replies in 15 minutes were made without the AI.
Grafana → _Fallbacks by reason_:

- `llm_auth`, `llm_rate_limited`, `llm_provider_error`, `llm_failed`, `circuit_open`: bad or revoked
  `GEMINI_API_KEY`, or quota exhausted (the circuit breaker then stops calling the model for a
  while). Rotate the key (secret store → restart the API) or raise the quota.
- `llm_timeout`: see [slow-replies](#slow-replies).
- `phrase_rejected`: the model's wording failed the meaning checks (changed numbers, dropped the
  question). A sudden rise after a model change means the new model paraphrases too freely: roll
  the model back.
- `silence`, `unclear`, `field_skipped`: callers, not the AI (bad lines, noisy places). Only a
  concern if one business has far more than others.

Calls keep working during fallbacks; they sound less natural.

## api-errors

**ApiErrorRate**: more than 2% of API requests return 5xx.

1. Logs: `level>=50` in the last 15 minutes, group by `route`. Each error has a `requestId`.
2. `GET /ready` failing → Postgres or Redis down or unreachable; see [target-down](#target-down).
3. Errors began with a deploy → roll back (previous image tag). Migrations are additive and
   backward compatible by policy, so the previous release runs against the new schema.
4. `P2024` (Prisma pool timeout) → too many connections: raise `connection_limit` in
   `DATABASE_URL` or put PgBouncer (transaction mode) in front.

## refused-calls

**CallsRefused**: more than 10 calls refused before answering in 30 minutes. `result` says why:

| `result`          | Meaning and action                                                                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `refused_blocked` | Caller on a business's block list. Expected; act only if a business reports it.                                                                       |
| `refused_loop`    | A call came back from a transfer to the business's own forwarded line (loop guard). Check that business's transfer number isn't its forwarded number. |
| `refused_busy`    | A number hit its "Max calls" limit. Raise it on Phone numbers if the business wants.                                                                  |
| `refused_limit`   | Plan limit on calls per day or minutes per month. The business sees a "Plan limit reached" alert; raise the plan's limits.                            |

Also look at `voice_calls_total{result="unknown_number"}`: calls to a number or SIP domain we
don't know. After a SIP connection was deleted, the carrier is still sending calls; otherwise a
Twilio number points at us without being added (Phone numbers → Add).

## queue-backlog

**QueueBacklog**: more than 500 jobs waiting in a queue.

1. Bull Board: which queue? Is the worker consuming (`active` > 0)?
2. Worker down → [target-down](#target-down). Worker up but slow → scale workers
   (`WORKER_CONCURRENCY`, more replicas). BullMQ distributes jobs across replicas safely.
3. `ingestion` backlog after a bulk upload is normal; it drains on its own.
4. `delayed` growing → many retries: a connected service (CRM, calendar, webhook) is down. See
   [failed-deliveries](#failed-deliveries).

## failed-deliveries

**DeadLetters**: jobs exhausted their retries (webhooks, CRM sync, emails, calendar).

1. App → Integrations → Failed deliveries (per business), or Bull Board (all).
2. The error says which service and why: expired OAuth (the business reconnects the
   integration), 4xx from the customer's webhook (their endpoint), SMTP auth (their settings).
3. After the cause is fixed, **Retry** re-queues the job with its original payload.
   Retries are idempotent (dedupe keys), so a double retry does not double-post.

## ingestion

**IngestionFailures**: more than 5 document ingestions failed in an hour.

- Documents page shows the per-document error. Common: scanned PDFs without text (needs OCR),
  password-protected files, files over `MAX_UPLOAD_MB`.
- All failing → embeddings provider: bad key or quota (`EMBEDDINGS_PROVIDER=gemini`), or the
  storage driver can't read uploads (S3 credentials, bucket policy).
- Fix, then **Reprocess** on the document.

## cost-spike

**CostSpike**: estimated cost in the last hour is more than 3× the hourly average of the past week (and over $5).

1. `voice_usage_cost_micros_total` by `kind`: telephony minutes, AI tokens or embeddings?
2. Telephony: find the business (it gets an "Unusual call volume" alert at 5× its usual hourly
   calls; the Analytics page of each business shows cost). Long calls are capped by the business's "Longest call"
   setting. A burst of short calls from few numbers is abuse or toll fraud: block the range
   (Phone numbers → Blocked callers, e.g. `+882*`), and pause the number if needed.
3. AI tokens: a very large knowledge base or a looping workflow. Check the call timelines.

## target-down

**TargetDown**: Prometheus can't scrape the API or worker.

1. Container/pod status and restarts. `docker compose ps` / `kubectl get pods`.
2. Crash on start → the logs' first lines: environment validation lists every bad variable.
3. API up but `GET /ready` 503 → Postgres or Redis. Check the managed service's status page,
   connection limits and credentials (a rotated password not yet in the secret store).
4. Redis lost (restart without persistence): live calls recover their state from the Postgres
   snapshot on the next turn; queued jobs are lost unless Redis has AOF on (use it in production).

---

## Numbers and SIP (support questions)

- **"Calls to our number don't reach the agent"** (forwarding): Phone numbers → the number →
  Forwarding → _Start test call_. "Test call not received" means the carrier isn't forwarding:
  the codes weren't confirmed on the phone, or the plan needs forwarding enabled by the carrier.
  Landlines and PBXs are forwarded by the carrier or the PBX vendor, not with codes.
- **"Leads show our own number"**: the carrier replaces the caller ID on forwarded calls. The
  test call reports this. Ask the carrier to keep the original caller ID (CLI) on forwarded calls.
- **SIP connection "Waiting for setup"**: the platform's Twilio account isn't configured
  (`TWILIO_ACCOUNT_SID` + API key); after configuring it, press **Retry setup**.
- **SIP connection "Setup failed"**: the error is shown on the connection (Twilio refused the
  domain name, bad credentials on our account, …). Fix, then **Retry setup**.
- **SIP calls rejected by Twilio**: the carrier sends from an address not in "Allowed IP
  addresses", or without the username and password. The setup sheet lists what they must send.
- **The business's SIP line went quiet**: the hourly check raises a "SIP connection quiet"
  alert when a connection that normally has calls had none for a day. Ask the carrier whether
  their side changed (IP addresses, credentials).

## Email verification

New accounts confirm their email before they can get numbers, connect WhatsApp or SIP, create API
keys or invite people (they can build and test agents meanwhile). The email needs `SMTP_URL`.

- **"I never got the email":** they choose **Send the link again** in the banner (a newer link
  replaces the older; links last 24 hours). Check the mail provider's logs and the spam folder.
- **Confirm someone by hand** (after checking who they are):
  `psql "$DATABASE_MIGRATION_URL" -c "UPDATE users SET email_verified_at = now() WHERE email = 'owner@example.com'"`
- **No email on this install:** `EMAIL_VERIFICATION=off` (then anyone who signs up can buy numbers).

## Terms of service and the AI disclosure

- Sign-up records when the terms were accepted and which `TERMS_VERSION`. When the terms change,
  raise `TERMS_VERSION`; who accepted an older version (to notify them):
  `psql "$DATABASE_MIGRATION_URL" -c "SELECT email, terms_version, terms_accepted_at FROM users WHERE terms_version IS DISTINCT FROM '2'"`
- Agents created in the app say they're an AI assistant after the greeting (Profile → "Say it's an
  AI assistant"). Agents created earlier don't until a business turns it on.

## Platform console (businesses, limits, suspending)

Platform owners see **Platform → Businesses** in the sidebar: every business with its calls,
minutes, estimated cost and failed jobs (last 30 days), searchable; each business's plan and
usage limits; **Suspend** (with a reason) and **Reactivate**. Every change is written to that
business's audit log with who made it. In production the console requires two-step sign-in.

- **Make someone a platform owner** (the seed's owner already is), with the owner connection:
  `psql "$DATABASE_MIGRATION_URL" -c "UPDATE users SET is_platform_owner = true WHERE email = 'ops@example.com'"`
- **Suspending** keeps every row. Until reactivated: calls to its numbers hear "not in
  service", WhatsApp messages get no reply (they aren't stored either), members can't sign in (the
  sign-in page says the account is suspended; open sessions land on a "suspended" page), API
  keys are refused, and queued jobs (webhooks, emails, CRM sync, replies) are dropped.
- You can't suspend the business you're signed in to (you'd lock yourself out); switch first.
