# Plan: Qatar-based agents and connecting existing numbers

Status: **implemented.** Connecting existing numbers (forwarding with a test call, SIP
connections, buying Twilio numbers, Qatar as a business country) came in P12; Arabic agents
(understanding, speaking, voices, Qatar templates, Sunday–Thursday week) after it. See
[P12 and "Qatar localisation" in the phases](DEVELOPMENT_PHASES.md).
**Still open:** Twilio subaccounts per business, Ramadan hours and Hijri dates, and checks on
real Ooredoo/Vodafone lines and real Arabic phone audio (the items marked **(confirm)**).

It covers two related goals:

1. **Qatar agents.** Agents that sound and behave right for a business in Qatar: +974 numbers, Arabic and English, Qatar time and working week, and QAR.
2. **Connect an existing number.** A business keeps the phone number its customers already call, and the AI agent answers on it. No new number to advertise.

Items marked **(confirm)** depend on carrier, Twilio or regulatory details that must be checked with the provider before building. The public pages could not be fetched from the build environment.

---

## 1. Constraints that shape the design

- **Twilio may not sell Qatar numbers.** Twilio does not offer voice numbers in every country. When a country has none, it recommends using a number from another country or a verified caller ID for outbound calls, with inbound handled by the regular carrier. Qatar +974 number availability must be checked in the Twilio console **(confirm)**.
- **Qatar VoIP rules.** Qatar allows businesses to use VoIP for their own voice calls. Selling VoIP calls or services to the public needs a licence. We answer calls to the business's own number on its behalf, which fits "own use". The operating model still needs legal review before launch **(confirm)**.
- **Ooredoo SIP-T.** Ooredoo Qatar offers SIP trunking: a direct SIP connection from a business's voice system to Ooredoo's network, keeping the business's numbers. Vodafone Qatar offers comparable business voice products **(confirm)**.
- **Current code is India-first:**
  - `DEFAULT_COUNTRY_CODE` is a single environment value (91).
  - Amounts use lakh/crore.
  - The default voice is `Polly.Kajal-Neural` (en-IN), and the default time zone is Asia/Kolkata.
  - A phone number row is the Twilio number itself: `phone_numbers.e164` = the `To` of the webhook.

## 2. How an existing number can reach the agent

| Method                                     | How it works                                                                                                                                                                | Pros                                                                                                                                 | Cons                                                                                                                                                                                                         | When                         |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| **A. Call forwarding** (recommended first) | The business sets forwarding on its existing Ooredoo/Vodafone line to a platform "ingress" number (a Twilio number, possibly outside Qatar).                                | No hardware; the business can do it in minutes with star codes; works for mobile and many landlines.                                 | The business pays international forwarding per minute if the ingress is abroad; the original caller ID is usually kept but must be tested per carrier **(confirm)**; one ingress number per business number. | MVP                          |
| **B. SIP trunk / BYOC**                    | The business's SIP trunk (Ooredoo SIP-T, or its PBX/SBC) sends calls over SIP to a platform SIP endpoint: Twilio Elastic SIP Trunking/BYOC, or our own media server in P13. | Local call costs; exact caller ID and dialled number (SIP `To`/`Diversion`); many channels; the PBX can route "press 1 for a human". | Needs the business's IT/PBX vendor, IP allow-lists and SIP credentials; more support work.                                                                                                                   | Larger businesses, after MVP |
| **C. Number porting**                      | Move the number to a provider we control.                                                                                                                                   | Cleanest routing.                                                                                                                    | Usually impossible for Qatar numbers to foreign carriers **(confirm)**; slow.                                                                                                                                | Not planned                  |
| **D. Verified caller ID** (outbound only)  | Verify the business number with Twilio and use it as caller ID when the agent calls back leads.                                                                             | Customers see the familiar number.                                                                                                   | Outbound only; allowed only where the regulator and carrier accept it **(confirm)**.                                                                                                                         | With outbound calling (P11+) |

**Recommended forwarding mode:** _conditional_ forwarding. Staff get the first chance to answer, and the AI answers when nobody picks up, the line is busy or it is unreachable. "Forward everything" is offered too, for after-hours or AI-first businesses.

GSM codes (most carriers, **confirm for Ooredoo/Vodafone Qatar**):

| Forward…                | Turn on               | Turn off |
| ----------------------- | --------------------- | -------- |
| No answer (after ~20 s) | `**61*<ingress>**20#` | `##61#`  |
| Busy                    | `**67*<ingress>#`     | `##67#`  |
| Unreachable / off       | `**62*<ingress>#`     | `##62#`  |
| Everything              | `**21*<ingress>#`     | `##21#`  |
| Cancel all              |                       | `##002#` |

## 3. Design

### 3.1 Data model (migration)

Separate _the number customers dial_ from _how the call reaches us_:

```
phone_numbers
  e164                 → unchanged meaning for platform-owned numbers
+ connection           enum PLATFORM | FORWARDED | SIP_TRUNK
+ business_number      E.164 customers dial (for FORWARDED/SIP; = e164 for PLATFORM)
+ ingress_number       E.164 of the platform number that receives the forwarded calls (FORWARDED)
+ forwarding_mode      NO_ANSWER_BUSY_UNREACHABLE | ALL
+ verification_status  PENDING | VERIFIED | FAILED
+ verified_at, last_call_at
+ carrier              text (ooredoo, vodafone_qa, other), for instructions and support

sip_trunks (tenant-scoped, RLS)
  id, tenant_id, name, inbound_ip_allowlist[], auth_username, auth_secret (sealed with the tenant key),
  twilio_trunk_sid / sip_domain, status, last_seen_at
```

**Routing.** `resolve_phone_number()` (SECURITY DEFINER) resolves on:

- `ingress_number` for forwarded calls (the webhook `To` is the ingress number);
- `business_number` for SIP calls (the SIP `To` is the business number).

Uniqueness: an ingress number belongs to exactly one business number, and a business number is unique across the platform.

### 3.2 Ingress number pool

- Forwarded calls need a platform number to forward to. MVP: an admin-managed pool of Twilio numbers (bought in the Twilio console, stored with `providerSid`).
- On "connect existing number", the platform assigns a free pool number to the business number and releases it on disconnect, after a cooling period so stray forwarded calls don't reach another tenant.
- Later: buy automatically through the Twilio REST API. That needs `TWILIO_ACCOUNT_SID` and a Twilio API key, a country preference (a Qatar number if Twilio offers one, else the cheapest reliable nearby country, **confirm**) and a monthly-cost warning.

### 3.3 Verification: prove forwarding works, safely

1. The staff member clicks **Test forwarding**.
2. The platform opens a 10-minute window and shows: "Call <business number> from another phone and let it ring."
3. The next call on the ingress number during the window is answered with "Your number is connected to <agent>. You can hang up." It is recorded as the verification call, and the status becomes VERIFIED, with the time and the caller ID the carrier passed.
4. The card then shows what the carrier actually sent:
   - caller ID kept or replaced;
   - `ForwardedFrom` present or not (Twilio passes it when the carrier provides it).

   This tells the business whether leads will have the real caller's number **(confirm per carrier)**.

Ownership: forwarding can only be set up from the line itself, so a successful verification call is reasonable proof of control. Twilio's verified-caller-ID flow (a spoken code) is added with outbound calling.

### 3.4 SIP trunk (BYOC)

- **Platform side:** a Twilio Elastic SIP trunk (or BYOC trunk) whose origination points at our voice webhook. The per-tenant trunk config holds the IP allow-list and credentials. In P13 an alternative is direct SIP into our own media server (LiveKit SIP / FreeSWITCH) with no Twilio in between, which lowers cost and latency.
- **Business side:** we produce a setup sheet for their PBX/SBC vendor or Ooredoo account manager. It lists the SIP URI, transport (TLS preferred), codecs (G.711 A-law/PCMA for Qatar, **confirm**), the IPs to allow, credentials, and "send the dialled number in `To`, the original caller in `From`/`P-Asserted-Identity`".
- **Health:** last-seen time, calls per day, and a "no calls in 24 h during business hours" alert.

### 3.5 API

```
POST   /phone-numbers/connect            { method: FORWARDED|SIP_TRUNK, businessNumber, carrier, forwardingMode, agentId, label }
         → FORWARDED: { ingressNumber, instructions[] (carrier-specific codes), verification: PENDING }
POST   /phone-numbers/:id/verify         opens the 10-minute test window
GET    /phone-numbers/:id                status, last call, what the carrier passed (caller ID kept? ForwardedFrom?)
DELETE /phone-numbers/:id                disconnect; the ingress number goes back to the pool after a cooling period
POST   /sip-trunks  GET/PATCH/DELETE     trunk config (secrets write-only, like integrations)
```

Permissions: `phone_numbers:write`. Audit entries for connect, verify and disconnect. Rate-limit the verify endpoint.

### 3.6 Web

**Settings → Phone numbers** gets a **"Connect your existing number"** wizard:

1. Your number (+974 …) and carrier (Ooredoo / Vodafone Qatar / other).
2. When the AI should answer: only when nobody answers, is busy or unreachable (recommended), or always.
3. Codes to dial, pre-filled with the ingress number (copy / tap-to-dial on mobile), plus how to turn it off.
4. Test: call your number now; a live status tick appears when the test call arrives.
5. Choose the agent. Done.

SIP option: a form for trunk details and a downloadable setup sheet for the IT vendor.

### 3.7 Telephony changes

- The inbound webhook records `ForwardedFrom` and `CallerName` (when present) on the call.
- The lead's phone uses the real caller, and "via forwarding from <business number>" is kept on the call record.
- **Loop protection:** a forwarded call that the agent then transfers to a staff mobile that itself forwards back to the AI must not loop. Detect repeated `From`/`ForwardedFrom` within seconds, and never transfer to the business number itself.
- **Transfers:** on a forwarded number, "transfer to a person" must dial a _different_ staff number, never the business number (which would forward straight back). This is validated in the agent editor.

## 4. Qatar localisation

| Area              | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant settings   | `country` (QA), `defaultCountryCode` (974), `currency` (QAR), `locale`, time zone `Asia/Qatar` (UTC+3, no DST): per tenant instead of the single `DEFAULT_COUNTRY_CODE` env var. Registration pre-fills them from the chosen country.                                                                                                                                                                                                                                               |
| Phone numbers     | +974 with 8-digit national numbers (mobiles commonly start with 3/5/6/7, landlines with 4 **(confirm)**). Normaliser: accept "974…", "00974…", 8-digit local, spaces, Arabic-Indic digits (٠١٢٣٤٥٦٧٨٩).                                                                                                                                                                                                                                                                             |
| Amounts           | Currency fields in QAR; words: "thousand", "million", "k", Arabic "ألف"/"آلاف", "مليون"; `formatAmount` says "50,000 riyals" / "50 ألف ريال". Lakh/crore only for INR.                                                                                                                                                                                                                                                                                                              |
| Dates and times   | Working week Sunday–Thursday (Friday–Saturday weekend) in templates; Arabic day names and relative dates (بكرة، بعد بكرة، الأحد الجاي), times (الساعة خمسة العصر), AM/PM words (الصبح، المسا). Ramadan and Eid hours: date-range overrides for working hours (today only single-day holidays exist).                                                                                                                                                                                |
| Language on calls | Agents per language (Arabic or English), or bilingual: detect the caller's language on the first turn and switch prompts and voice. Twilio `<Gather language="ar-QA">` (or ar-AE) for speech recognition **(confirm supported codes)**; Arabic voices (e.g. Amazon Polly Arabic voices via Twilio `<Say>` **(confirm names/availability)**). Gulf Arabic STT quality must be tested with real callers; P13 streaming voice (Gemini Live / other STT) may be needed for good Arabic. |
| LLM prompts       | Understanding and phrasing prompts get an Arabic variant; `checkPhrase` and `guardOutput` must treat Arabic-Indic digits as numbers (so the "facts unchanged" check still works).                                                                                                                                                                                                                                                                                                   |
| Templates         | Qatar versions: real estate (areas such as Lusail, The Pearl, West Bay, Al Wakrah), clinic, restaurant, car service, in English and Arabic, with QAR budgets and Sun–Thu hours.                                                                                                                                                                                                                                                                                                     |
| Privacy           | Qatar's Personal Data Privacy Protection Law (Law No. 13 of 2016): consent wording in the greeting ("this call may be recorded"), retention settings, and hosting region. A Gulf-region deployment may be preferred **(confirm with legal)**; the Docker setup makes region choice a deployment decision.                                                                                                                                                                           |
| Latency           | Twilio media for Qatar callers may route through a distant Twilio region; measure end-to-end turn latency from Qatar. With Gemini at ~1.3–2 s per understanding call, keep phrasing off or budgeted (the runtime already caps each turn at ~3 s of LLM time).                                                                                                                                                                                                                       |

## 5. Phases and estimates

| Step | Scope                                                                                                                                                                          | Estimate                                  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| Q1   | Tenant country/locale/currency/time zone settings; +974 phone normaliser; QAR amounts; Sun–Thu defaults; Arabic-Indic digits in normalisers and guards                         | 4–5 days                                  |
| Q2   | Existing number via **forwarding**: migration, ingress pool, connect/verify/disconnect API, routing by ingress, ForwardedFrom capture, loop and transfer protection, wizard UI | 1–1.5 weeks                               |
| Q3   | Arabic agents: Arabic prompts, STT/TTS language settings, Qatar templates (EN + AR), Arabic dates/times/amounts                                                                | 1.5–2 weeks (plus tuning with real calls) |
| Q4   | **SIP trunk/BYOC**: trunk model and API, Twilio trunk provisioning, setup sheet, health alerts                                                                                 | 1–1.5 weeks                               |
| Q5   | Ramadan/Eid hour overrides; outbound verified caller ID (with the P11 callback features)                                                                                       | 3–4 days                                  |

**Tests:**

- Normaliser property tests for +974 and Arabic digits.
- Routing tests: ingress → tenant, SIP `To` → tenant, a released number going through its cooling period.
- RLS tests for `sip_trunks`.
- A simulated forwarded call with `ForwardedFrom`; loop detection; transfer-to-self rejected.
- The verification window's expiry and rate limit.
- An end-to-end Arabic conversation in the simulator.
- A manual pilot with one real Ooredoo line and one Vodafone line before general release.

## 6. Decisions needed from you

1. **Carrier and line type** of the first business: Ooredoo or Vodafone Qatar, mobile or landline, or a PBX with SIP? This decides forwarding vs SIP first.
2. **AI answers when:** only when staff don't answer, or always?
3. **Languages:** English only first, Arabic only, or both from day one?
4. **Ingress numbers:** is a non-Qatar ingress number acceptable (the business pays international forwarding), or must we source a Qatar-based number or SIP route first?
5. **Hosting and data:** any requirement to keep call data in Qatar or the GCC?
