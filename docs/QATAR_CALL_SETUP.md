# Qatar number → AI agent: the complete guide

_Written 27 September 2026._ How a business in Qatar gets calls on its own number answered by
the AI agent, which way to choose, and what makes the agent sound right. Twilio details are in
[TWILIO_SETUP.md](TWILIO_SETUP.md); the design background is in
[QATAR_AND_EXISTING_NUMBERS_PLAN.md](QATAR_AND_EXISTING_NUMBERS_PLAN.md). Items marked
**(confirm)** depend on the carrier or regulator and must be checked with them.

## 1. Why the agent may not have sounded right

Checked on 27 September with the development Gemini key and the call simulator:

| What happened                                                                     | Cause                                                                                                 | Status                                                                 |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Almost every AI call failed: `rate_limited`, or `timeout` after 2.5 s             | The Gemini key is on the **free tier** (a few requests per minute); a call makes 2 AI requests a turn | **Needs a paid Gemini key** (section 7)                                |
| Without AI, "Hi, I need a cleaning" was saved as the patient's name               | The rules took any short sentence as a name                                                           | Fixed: requests, questions and answers like "tomorrow" are never names |
| "Tomorrow at 10 am" to "emergency, within a week or flexible?" was not understood | No link between a day and "within a week"                                                             | Fixed, in English and Arabic ("بكرة", weekdays, "next week")           |
| "I need a cleaning" didn't pick the service "Dental cleaning"                     | Only the full option name was recognised                                                              | Fixed: everyday names (cleaning, checkup, implant, whitening, braces…) |
| A question such as "what are your consultation charges?" could choose a service   | Early answers were read from questions too                                                            | Fixed                                                                  |

After the fixes, the same English and Arabic bookings complete **even with the AI unavailable**:
name → service → urgency → day → time → confirm → booked. With a working Gemini key the agent
also understands free, mixed answers and phrases its replies naturally.

To see this yourself: `npm run simulate -- --template qatar-clinic-ar --llm gemini --debug`
prints every AI call and whether it failed (`rate_limited`, `timeout`).

## 2. Which way to connect

Twilio has no Qatar (+974) numbers **(confirm in Twilio Console → Phone Numbers → Buy)**, so the
Qatar number stays with Ooredoo or Vodafone and calls are passed to the platform.

| Way                                                      | Good for                                                           | Cost / effort                                                               | Caller's number               |
| -------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------- | ----------------------------- |
| **A. Call forwarding** to a Twilio number                | Trying it this week; one mobile or line                            | Minutes, no hardware; the line pays **international forwarding** per minute | Usually kept **(confirm)**    |
| **B. Office phone system (PBX) → SIP**                   | Businesses with 3CX, Yeastar, Grandstream, Asterisk, Avaya, Cisco… | An afternoon with the PBX vendor; no forwarding charges; internet to Twilio | Kept (SIP `From`)             |
| **C. Ooredoo / Vodafone business SIP trunk → SBC → SIP** | Many channels, a main company number                               | Carrier contract + a small SBC; most work, best result                      | Kept, plus the dialled number |

**Recommendation:** start with **A** to prove the agent on real calls (a day), then move to
**B** (or **C** if there is no PBX) for production, so there are no international forwarding
charges and staff can still answer first.

## 3. Before any of them: platform checklist

1. The API is on a public HTTPS address and `PUBLIC_BASE_URL` is set to it
   ([TWILIO_SETUP.md §2–3](TWILIO_SETUP.md)).
2. `TWILIO_AUTH_TOKEN` (and `TWILIO_ACCOUNT_SID`) set; the Twilio account is **upgraded** (trial
   accounts play a trial message and only call verified numbers).
3. `DEFAULT_COUNTRY_CODE=974`; **Settings → Business**: country Qatar, time zone Asia/Qatar,
   Sunday–Thursday working week.
4. An agent from a Qatar template (**Qatar clinic** or **Qatar real estate**, Arabic) or an
   English one, with Gulf Arabic voice (Hala or Zayd) and language `ar-QA` for Arabic callers.
   **Publish** it and try it in **Test** first.
5. A **paid Gemini key** in `GEMINI_API_KEY` (section 7).
6. In Twilio **Voice → Settings → Geo permissions**, allow Qatar, so the agent can transfer calls
   to staff mobiles.

## 4. A — Call forwarding (quickest)

1. **Settings → Phone numbers → Get an agent number**: buy a Twilio number (UK or US voice
   numbers are the usual choice). The app points it at the platform.
2. **Use my existing number**: enter the Qatar number, carrier (Ooredoo / Vodafone), and choose
   _Only when we can't answer_ (recommended) or _Every call_.
3. Call **Ooredoo (111) or Vodafone (121)** first and ask them to enable **international call
   forwarding** on the line. Prepaid lines usually block it **(confirm)**.
4. From the Qatar phone, dial the codes the app shows:
   - Every call: `**21*+44…#`
   - No answer after 20 s: `**61*+44…**20#`, busy `**67*+44…#`, unreachable `**62*+44…#`
   - Check: `*#21#`, `*#61#`; cancel all: `##002#`
5. Click **Start test call** and call the Qatar number **from another phone**. The number turns
   **Connected** when the call reaches the agent.

Limits: every forwarded minute is an international call on the business's bill; the caller's
number may be replaced by the business number on some plans **(confirm)**; the agent must not
transfer back to the same number (it would forward again).

## 5. B — Office phone system (PBX) over SIP

The business keeps its lines on the PBX; the PBX sends the calls the AI should take to the
platform over the internet.

1. In the app: **Settings → Phone numbers → Connect over SIP**, carrier "Another SIP provider"
   (or Ooredoo / Vodafone if the trunk is theirs), the **public IP address** of the PBX, and the
   Qatar number(s) it will send. You get a **SIP address** (`…sip.twilio.com`), and optionally a
   username and password, plus a setup sheet for the PBX vendor.
2. On the PBX, add a **SIP trunk** (in 3CX: "Add SIP Trunk → Generic"; in Yeastar: "VoIP
   Trunk → Peer" or "Register"):
   - Host / proxy: the SIP address from step 1, port 5060 (UDP/TCP) or 5061 (TLS)
   - Authentication: IP address (the one you gave), or the username and password
   - Codecs: **G.711 A-law (PCMA)** and **µ-law (PCMU)**
   - Send the **dialled Qatar number in the To header** (in E.164, `+974…`) and the caller in
     **From**: the platform uses the To number to pick the agent.
3. Add an **outbound route** from the PBX to this trunk for the calls the agent should take:
   - After hours (time condition), or
   - No answer after N seconds on the reception ring group, or
   - An IVR option ("press 1 for our assistant"), or
   - Every call to the main number.
4. Call the main number from a mobile: the call reaches the agent; the app shows it live under
   **Calls**. For transfers, give the agent a staff mobile (not the PBX number that sends to the
   agent).

Firewall: allow outbound SIP to Twilio's signalling IPs and RTP media ports (Twilio publishes the
ranges under "Twilio IP addresses for SIP") **(confirm the current list)**.

## 6. C — Ooredoo / Vodafone business SIP trunk

1. Ask **Ooredoo Business** ("SIP Trunk") or **Vodafone Qatar Business** for a SIP trunk with the
   company's numbers. Ask specifically: _can the trunk deliver calls to our own SBC on the
   internet or a cloud server, or only to equipment on your private link?_ **(confirm)**
2. Most carrier trunks end on equipment at the business (a private link). Put a small **SBC**
   there (or on a Qatar-hosted server, e.g. Azure Qatar Central or Google Cloud Doha): FreeSWITCH,
   Asterisk, Kamailio or a commercial SBC. It receives the carrier's calls and forwards them over
   SIP to the platform's SIP address, as a PBX does in section 5.
3. Continue from section 5, step 1 with the SBC's public IP.
4. Before launch, confirm with the carrier and a local adviser that passing calls to a cloud
   service fits the CRA rules for the business's own use **(confirm)**.

## 7. Making the voice agent sound right

| Change                                       | Why                                                                                                                                                                                                                                                       |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Paid Gemini key** (billing on the project) | The free tier allows a few requests a minute; a call needs 2 per turn. Without it the agent falls back to its rules every turn (works, but understands less).                                                                                             |
| Timeout 2500 → 3500 ms if needed             | **Agent → Profile → AI model → Timeout (ms)**. Only if `--debug` or the call log shows `timeout`; longer means slower replies.                                                                                                                            |
| Host the API near Twilio                     | Twilio processes calls in the US by default; each turn is a webhook round trip. Hosting the API in US East (or Twilio's region) cuts ~0.3–0.5 s per turn.                                                                                                 |
| Arabic: `ar-QA`, Gulf voices, hints          | The Qatar templates set these; add service and place names to the knowledge base so they're recognised and answered.                                                                                                                                      |
| Short greeting and questions                 | Each reply is spoken in full before the caller can answer; keep them to one sentence.                                                                                                                                                                     |
| **Streaming voice** (built)                  | **Agent → Profile → Conversation mode → Streaming**: replies start sooner and callers can interrupt. Arabic uses Google recognition and the same Gulf voice. See [TWILIO_SETUP.md](TWILIO_SETUP.md#streaming-voice-optional-recommended-once-calls-work). |

## 8. Test plan before real customers

1. Simulator with `--llm gemini --debug`: no `rate_limited` or `timeout`.
2. A direct call to the Twilio number (English, then Arabic): booking completes; the call,
   transcript, lead and appointment appear in the app.
3. Through the Qatar number (A, B or C): caller's number shown correctly under **Calls**.
4. "Talk to a person": the transfer reaches the staff mobile with the whisper summary.
5. Ten calls in a row from different phones: no failures in **Calls** or Twilio **Monitor →
   Errors**.

Troubleshooting for each error Twilio shows: [TWILIO_SETUP.md §9](TWILIO_SETUP.md).
