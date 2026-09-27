# Live checks: Twilio, WhatsApp and Gemini on the real services

_Written 27 September 2026._ Everything is built and tested against stand-ins; this is how to
prove it on the real services before the first customer. Run it where the platform runs (your
server, or your laptop with a tunnel): the development cloud environment can reach Gemini but not
Twilio or Meta, and nothing on the internet can call into it.

## What the first check found (27 September)

| Service | Finding                                                                                                    | What to do                                                       |
| ------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Gemini  | Key accepted, speech model available, but **free tier with today's quota used up**: 0 of 12 calls answered | Turn on billing (section 1); agents run on rules only until then |
| Twilio  | `TWILIO_AUTH_TOKEN` is 29 characters (a real one is 32 hex); no `TWILIO_ACCOUNT_SID`                       | Copy both from the Twilio Console                                |
| Meta    | No `META_*` values                                                                                         | docs/WHATSAPP_SETUP.md                                           |
| Address | `PUBLIC_BASE_URL` is `localhost`: Twilio and Meta can't reach it                                           | A tunnel or the server's HTTPS address                           |

## 0. The automatic check

```bash
npm run check:live            # add -- --burst to probe Gemini's rate limit (20 quick calls)
```

It checks, and prints ✓ / ! / ✕ with the fix for each (never the secrets):

- **Public address**: `PUBLIC_BASE_URL` is public HTTPS and `/health` answers through it.
- **Twilio**: token and SID format, the account (active, not trial), every number's "A call
  comes in" URL is this API, and a **signed test webhook through the public address** is
  accepted (proves the token and URL the API runs with match Twilio's signing).
- **Meta**: app id and secret, the WhatsApp webhook's callback URL and fields, the verify token
  answered through the public address, a **signed test webhook** accepted.
- **Gemini**: key, speech model, quota tier (a free-tier limit is reported as such) and latency.

Fix every ✕ and run it again before the manual tests. Restart the API after changing `.env`.

## 1. Gemini with billing

1. [Google AI Studio](https://aistudio.google.com) → **API keys** → the key's project →
   **Set up billing** (a Google Cloud billing account). The key stays the same.
2. `npm run check:live -- --burst`: **Replies ✓**, no "free tier", median under ~1.5 s.
3. While at it, **rotate the key** used during development and put the new one in `.env`.

## 2. Twilio: a real call

Prerequisites: an upgraded Twilio account, `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN`, the
tunnel or server address in `PUBLIC_BASE_URL`, `npm run check:live` clean for Twilio.

1. In the app: **Settings → Phone numbers → Get an agent number** (or point an existing Twilio
   number at `<PUBLIC_BASE_URL>/telephony/twilio/voice`). Assign a published agent.
2. Call the number from your phone and go through a booking. Then:

| #   | Try                                                      | Expect                                                                                      |
| --- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| T1  | The greeting                                             | Within ~2 s of answering, in the agent's voice                                              |
| T2  | Answer every question normally                           | Booking confirmed; the call, transcript, lead and appointment in the app                    |
| T3  | Say your name with a greeting ("Hi, this is Ahmed")      | Name captured correctly                                                                     |
| T4  | Ask a question from the knowledge base                   | A grounded answer; the source shown on the call page                                        |
| T5  | "Can I talk to a person?"                                | Transfer rings the staff number with the whisper summary                                    |
| T6  | Stay silent twice                                        | Re-prompt, then a polite goodbye                                                            |
| T7  | Arabic agent: "أبغى موعد تنظيف بكرة الساعة عشرة"         | Understood (service, day, time) and answered in Gulf Arabic                                 |
| T8  | Agent set to **Streaming** (Profile → Conversation mode) | Replies start sooner; talking over the agent stops it; the call page says "streaming voice" |

For each: the time the agent took (call page shows ms per turn) and anything wrong. Twilio
Console → **Monitor → Logs → Errors** lists webhook problems.

Streaming needs the **AI addendum** accepted in Twilio (Voice → Settings) and WebSockets through
the tunnel or proxy ([TWILIO_SETUP.md](TWILIO_SETUP.md)).

## 3. Qatar number (after section 2 works)

Follow [QATAR_CALL_SETUP.md](QATAR_CALL_SETUP.md) section 4 (forwarding) with **Start test
call**: the number turns **Connected**. Note: whether your number or the business number shows
as the caller on the call page (caller ID kept?), and the forwarding cost on the next bill.

## 4. WhatsApp: a real number

Prerequisites: the Meta app ([WHATSAPP_SETUP.md](WHATSAPP_SETUP.md)), `check:live` clean for
Meta. Meta's **test number** works before App Review; a real business number needs the app live.

| #   | Try                                                            | Expect                                                                              |
| --- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| W1  | Settings → WhatsApp → Continue with Facebook (or access token) | Connected; **Check connection** all ✓                                               |
| W2  | Send test message to your phone                                | Meta's "Hello World" arrives                                                        |
| W3  | Write "Hi, I need a cleaning tomorrow" from your phone         | Agent reply within ~5 s; the conversation in the Inbox                              |
| W4  | Send a voice note (English, then Arabic)                       | Transcript in the Inbox; a voice note back                                          |
| W5  | Send a photo and a PDF                                         | Both viewable in the Inbox                                                          |
| W6  | Reply from the Inbox with a photo                              | Arrives on the phone; ticks turn blue when you read it                              |
| W7  | Business app number: tick "on the WhatsApp Business app" first | Connected without logging the app out; replies typed on the phone show in the Inbox |
| W8  | A day later, **Send a template**                               | The approved template arrives                                                       |

## 5. What to send back

For every ✕ from `check:live` and every row that didn't behave: the row id (T3, W4 …), what
happened, the time it happened, and the call or conversation link from the app. The API log
around that time helps (`docker compose logs api --since 10m`, secrets are never logged).

## Letting the development environment reach Twilio and Meta

Only needed if you want checks run from the development cloud environment too: add
`api.twilio.com` and `graph.facebook.com` to the environment's allowed domains (environment
settings → Network access). Real calls and WhatsApp messages still need a public address, so the
tests above run on your server or laptop either way.
