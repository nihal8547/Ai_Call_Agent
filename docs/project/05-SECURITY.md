# 5. Security

## Tenant isolation (one business can never see another's data)

- **Row-Level Security in Postgres** on every business table, `FORCE`d so it applies even to the
  table owner. The API connects as `voice_app` (member of `app_user`), which has no way around RLS.
- Every query runs in a transaction that sets `app.tenant_id` from the signed-in session or API
  key; the policies compare each row's `tenant_id` with it.
- The few lookups needed before the business is known (which business owns this phone number,
  SIP domain or live call) are narrow `SECURITY DEFINER` functions returning only ids.
- Migrations run as a separate owner role (`voice_owner`), never used at runtime.
- An isolation test suite checks every table with two businesses.

## Accounts and sessions

| Control          | Detail                                                                                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Passwords        | **argon2id** (OWASP parameters: 19 MiB memory, 2 iterations); strength policy on sign-up                                                                              |
| Sessions         | Access token: JWT (HS256), 15 minutes. Refresh token: random, stored hashed, **rotated on every use**; using an old one revokes the whole session (theft detection)   |
| Cookies          | `httpOnly`, `SameSite=Lax`, `Secure` in production; the refresh cookie is only sent to `/api/v1/auth`                                                                 |
| CSRF             | Double-submit token: a readable `csrf_token` cookie must match the `x-csrf-token` header on every write                                                               |
| Two-step sign-in | TOTP (RFC 6238) with an authenticator app; secret encrypted; 10 one-time recovery codes stored hashed; a code can't be used twice; 5 tries per sign-in ticket         |
| Sessions page    | See every signed-in device; sign out one or all others; takes effect immediately (revoked sessions are checked on every request)                                      |
| Rate limits      | Sign-in 20/min per IP and 10/hour per email; registration 5/hour per IP; 2FA, number verification, Twilio search/buy, SIP creation and more are limited too           |
| Permissions      | Fine-grained (`calls:read_transcript`, `billing:write` …); roles are sets of permissions; every API route declares what it needs; buying numbers needs billing access |
| API keys         | Shown once; stored as SHA-256 hashes with a visible prefix (`vk_…`); scoped to permissions the creator holds; expiry and revoke                                       |
| Audit log        | Every configuration change: who, what, before/after, IP, user agent                                                                                                   |

## Secrets and personal data

- **Envelope encryption** (AES-256-GCM): each business has its own data key, wrapped by the
  platform master key (`MASTER_ENCRYPTION_KEY`). Integration credentials (Google, HubSpot, Zoho,
  SMTP, webhook secrets), SIP passwords and TOTP secrets are stored encrypted, bound to what they
  belong to (additional authenticated data), so a value can't be moved to another record.
- Platform emails go through a queue with retries; jobs holding links are deleted as soon as they
  are sent (failed ones within an hour), and logs record only the recipient.
- Secrets are never returned by the API after creation, and never logged (authorization headers
  and cookies are redacted from logs).
- The **call timeline is redacted before it is stored**: email addresses, phone numbers, card
  numbers (Luhn-checked) and Indian PAN/Aadhaar numbers are replaced with placeholders.
- **Retention**: each business chooses how long call records are kept (default 365 days); a
  nightly job removes transcripts, caller numbers, collected data and summaries of older calls.
- `calls:read_transcript` is a separate permission: staff can see call outcomes without
  transcripts.

## Telephony and abuse

- Every Twilio webhook is checked against its **HMAC signature** (the exact public URL); unsigned
  or wrong requests are refused.
- **Call gate** before answering: blocked numbers and ranges (e.g. `+882*` satellite ranges used
  for toll fraud), a simultaneous-call cap per number, plan limits (calls per day, minutes per
  month), and the **transfer loop guard** (a transfer can't ring the business's own forwarded
  line and come back).
- **Longest call** per business (default 20 minutes); unusual volume (≥ 20 calls in an hour and
  5× the usual) raises an alert.
- SIP connections accept calls only from the carrier's listed public IP addresses (and optionally
  a username and password).
- Manual phone number entry is limited to platform operators once the platform's Twilio account
  is set up, so nobody can claim a number they don't pay for.

## AI safety

- The caller's words are treated as **data**: the prompt tells the model never to follow
  instructions in them, and its output must match a JSON schema.
- Every value the AI extracts is validated again by the engine (types, options, ranges, dates).
- The AI's wording is accepted only if it keeps every number, keeps the question and stays short;
  a final **output guard** blocks technical errors, markup, links and secret-like strings from
  ever being spoken.
- Knowledge answers must be grounded: numbers not found in the retrieved documents are refused,
  and unknown answers become a follow-up instead of a guess.

## Tools and integrations

- Outbound requests (webhooks, SMTP) to private or internal addresses are blocked (SSRF
  protection, checked after DNS resolution); only allowed in development with an explicit flag,
  which the API refuses in production.
- Uploaded files are identified by their content (magic bytes), size-limited, parsed in the
  worker, and only downloaded back as attachments.
- Background jobs carry idempotency keys; retries never double-book or double-post.
- CSV exports neutralise spreadsheet formulas.

## Web security

- **Content Security Policy** with a fresh nonce per request: only the app's own scripts run
  (`script-src 'self' 'nonce-…' 'strict-dynamic'`), no inline scripts, `frame-ancestors 'none'`,
  `object-src 'none'`; fonts self-hosted.
- HSTS, `Permissions-Policy` (camera, microphone, geolocation off), `Cross-Origin-Opener-Policy`,
  `X-Content-Type-Options`, referrer policy; the API uses helmet.
- CORS allow-list for the API; the web app reaches the API same-origin through `/api`.

## Operations and supply chain

- `/metrics`, the worker's metrics port and the queue dashboard are not public (private network,
  bearer token, basic auth).
- CI: lint, typecheck, tests, **dependency audit gate** (`npm run audit:prod`, reviewed
  exceptions expire), **gitleaks** secret scanning, Prometheus rule tests.
- Dependabot opens weekly update PRs.
- Backups with checksums and a monthly **restore drill** that also re-checks RLS.
- Checklist for production: [DEPLOYMENT.md §9](../DEPLOYMENT.md#9-security-checklist).
