# Connecting an agent to Twilio: step by step

How a phone call reaches your agent:

```
Customer dials ─▶ (existing number forwards) ─▶ Twilio number ─▶ POST {PUBLIC_BASE_URL}/telephony/twilio/voice ─▶ agent answers
```

Twilio must be able to reach the **API** (port 4000) over the internet with HTTPS, and every
request is checked against your Twilio auth token. Most "the call doesn't arrive" problems are one
of those two (see [Troubleshooting](#9-troubleshooting)).

## 1. Twilio account

1. Sign up at [twilio.com](https://www.twilio.com/try-twilio) and verify your email and phone.
2. **Upgrade the account** (add a card) before real use. On a trial account callers first hear a
   Twilio trial message and must press a key, calls can only go out to _verified_ numbers (so
   transfers to staff fail unless the staff number is verified), and some inbound calls can be
   restricted.
3. Console home → **Account Info**: copy the **Account SID** (`AC…`) and **Auth Token**.
4. Optional but recommended: **Account → API keys & tokens → Create API key** (Standard). Copy
   the **SID** (`SK…`) and **Secret** (shown once).
5. **Voice → Settings → Geo permissions**: enable the countries your agent transfers calls to
   (e.g. **Qatar**, **India**). Without this, "transfer to a staff member" fails.

## 2. Make the API reachable from the internet

**Local development:** run a tunnel to the **API port 4000** (not the web app on 3000; the web
app does not pass `/telephony` through).

```bash
# either
cloudflared tunnel --url http://localhost:4000
# or
ngrok http 4000
```

Copy the `https://…` address it prints, for example `https://abcd-12.trycloudflare.com`.

> A free tunnel gets a **new address every time it starts**. Each time: update `PUBLIC_BASE_URL`,
> restart the API, and update the Voice URL on the Twilio number (step 6).

**Production:** the API on its own HTTPS domain, e.g. `https://api.example.com` (see
[DEPLOYMENT.md](DEPLOYMENT.md)); set `TRUST_PROXY` to your load balancer's addresses.

Check it: open `https://<your-address>/health` in a browser. You should see a JSON reply.

## 3. Settings in `.env`

```bash
# The public HTTPS address from step 2: exact, no trailing slash, no /api/v1
PUBLIC_BASE_URL=https://abcd-12.trycloudflare.com

# Required: every Twilio webhook is checked with it
TWILIO_AUTH_TOKEN=<Auth Token from step 1>

# Optional: lets the app buy numbers and set their webhooks for you (recommended)
TWILIO_ACCOUNT_SID=AC...
TWILIO_API_KEY_SID=SK...
TWILIO_API_KEY_SECRET=<API key secret>

# Country code for numbers said without one (974 = Qatar, 91 = India)
DEFAULT_COUNTRY_CODE=974
```

Restart the API and the worker (`npm run dev`, or `docker compose up -d` again). The auth token
must belong to the **same Twilio account** that owns the number.

## 4. Get the agent ready

1. **Settings → Business**: set the country (calling code, currency, time zone).
2. **Agents → New agent**: pick a template (e.g. Qatar dental clinic or Qatar real estate) or
   start blank; fill in the profile, questions, hours and escalation (staff number for
   transfers).
3. Use the agent's **Test** tab to have a conversation in the browser first.
4. Click **Publish**. The first publish makes the agent **Active**. Calls only reach published,
   active agents; otherwise callers hear "this number is not in service".

## 5. Get a Twilio number

In **Settings → Phone numbers**, choose **Get a new number**.

**A. With `TWILIO_ACCOUNT_SID` set (easiest)**

1. Choose the country and type, click **Find a number**, pick one and buy it.
2. Choose the agent under **Answered by**.
3. Done: the app points the number's webhooks at `PUBLIC_BASE_URL` automatically. Skip step 6.

**B. Without it: buy in the Twilio console and add by hand**

1. Twilio Console → **Phone Numbers → Buy a number**, with **Voice** capability. Some countries
   need a regulatory bundle (address or ID documents) first. Twilio has few or no Qatar numbers:
   for a Qatar business, buy one in another country (e.g. UK or US) and forward to it (step 8).
2. In the app: **Get a new number → Add a Twilio number**: the number in international format
   (`+44…`), and the agent under **Answered by**.
3. Then do step 6: the app does **not** set the webhook for numbers added by hand.

## 6. Point the Twilio number at the platform (only for option B, or after the address changes)

Twilio Console → **Phone Numbers → Manage → Active numbers** → your number → **Voice
Configuration**:

| Setting             | Value                                                          |
| ------------------- | -------------------------------------------------------------- |
| Configure with      | Webhook, TwiML Bin, Function… → **Webhook**                    |
| A call comes in     | `https://<your-address>/telephony/twilio/voice`, **HTTP POST** |
| Call status changes | `https://<your-address>/telephony/twilio/status`               |

The address must be **exactly** `PUBLIC_BASE_URL` (the signature check compares them). There is
**no** `/api/v1` in these paths. Save.

## 7. Test with a direct call

1. From any phone, call the **Twilio number** directly.
2. The agent greets you. Talk through a short conversation.
3. In the app: **Calls** shows the call live with the transcript; after hanging up, the summary
   and the lead appear under **Leads**.

If this works, the Twilio part is right. Only then connect an existing number.

### Streaming voice (optional, recommended once calls work)

With **Agent → Profile → Conversation mode → Streaming**, calls use Twilio **ConversationRelay**:
Twilio recognises speech while the caller talks and streams the agent's reply as speech; the
caller can interrupt. Nothing changes in the number's Voice Configuration. You need:

1. Twilio Console → **Voice → Settings → General**: accept the **Predictive and Generative AI/ML
   Features Addendum** (ConversationRelay is off until it is accepted) **(confirm the menu name)**.
2. `PUBLIC_BASE_URL` on **https**: Twilio connects to `wss://<your-address>/telephony/twilio/relay`
   and signs the connection with that address. ngrok and Cloudflare Tunnel pass WebSockets; behind
   your own proxy, allow WebSocket upgrades ([DEPLOYMENT.md](DEPLOYMENT.md)).
3. Publish the agent, call the number. The call page shows **Call started · streaming voice**;
   callers who talk over the agent show **interrupted the agent**.

If the WebSocket can't be reached or breaks, Twilio asks `/telephony/twilio/relay-end` what to do
and the call carries on turn by turn (the timeline shows "Streaming stopped"). `VOICE_STREAMING=false`
switches streaming off for every agent. Streaming is billed per minute by Twilio (about $0.07,
estimated as `VOICE_STREAMING_MINUTES`); speech recognition and voice are included.

## 8. Use the business's existing number (Ooredoo, Vodafone or other)

For a Qatar number, which way to choose (forwarding, PBX over SIP or a carrier SIP trunk) and
what makes the agent sound right: [QATAR_CALL_SETUP.md](QATAR_CALL_SETUP.md).

Customers keep calling the number they already know; the carrier forwards to the Twilio number.

1. **Settings → Phone numbers → Use my existing number**.
2. **Your number**: the number customers call now, the carrier, and **Send calls to the agent**:
   - _Only when we can't answer_ (no answer after ~20 s, busy, or phone off), or
   - _Every call goes to the agent_.
3. **Forward to**: the Twilio number from step 5 (or **Get an agent number** first).
4. **Turn on forwarding**: dial each code shown, from the business phone, and press call. The
   phone confirms each one. Then click **I've turned it on**.
   - Every call: `**21*<twilio number>#`
   - No answer / busy / unreachable: `**61*<twilio number>**20#`, `**67*<twilio number>#`,
     `**62*<twilio number>#`
   - Check the status: `*#21#`, `*#61#`, `*#67#`, `*#62#`
5. **Test call**: optionally enter the phone you'll call from, click **Start test call**, then
   call the business number **from a different phone**. In "only when we can't answer" mode,
   **don't pick up** on the business phone; after about 20 seconds the call moves to the agent.
   The status turns **Connected**.
6. The agent is never set to transfer to this same business number (it would forward straight
   back); give it another staff number for transfers.

**Carrier notes (Qatar):** the Twilio number is usually abroad, so the business line pays
international forwarding rates, and many plans (especially prepaid) block international
forwarding until the carrier enables it. Call Ooredoo or Vodafone and ask for international call
forwarding. For no forwarding costs, connect over SIP instead (**Connect over SIP**).

## 9. Troubleshooting

Start at Twilio Console → **Monitor → Logs → Calls** (and **Monitor → Errors**), and look at the
API's terminal log.

| What you see                                                               | Cause and fix                                                                                                                                                                               |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No call in Twilio's log at all                                             | The call never reached Twilio: forwarding isn't on (check with `*#21#` / `*#61#`), the carrier blocks international forwarding, or you answered the phone (conditional mode)                |
| Error **11200** / **11205** "HTTP retrieval failure"                       | Twilio can't reach the API: `PUBLIC_BASE_URL` is `localhost`, the tunnel isn't running or points at port 3000, or the Voice URL has an old tunnel address                                   |
| **404** on the webhook                                                     | The Voice URL has `/api/v1` in it, or points at the web app instead of the API                                                                                                              |
| **403**; API log "rejected webhook with an invalid Twilio signature"       | The Voice URL and `PUBLIC_BASE_URL` differ (https, slash, old address), or `TWILIO_AUTH_TOKEN` is from another account                                                                      |
| **503** "Telephony is not configured"                                      | `TWILIO_AUTH_TOKEN` is missing; set it and restart the API                                                                                                                                  |
| Caller hears "this number is not in service"                               | API log "unknown number": the number in the app differs from the Twilio number (use `+` and the country code). "without an active agent": assign an agent and **Publish** it                |
| Caller hears a Twilio trial message                                        | Upgrade the Twilio account                                                                                                                                                                  |
| The call is refused straight away                                          | The number's **Max calls** is reached, the caller is blocked, or the plan limit is reached (see the dashboard alerts)                                                                       |
| Transfer to staff fails                                                    | Enable the country in **Geo permissions**; on a trial account, verify the staff number                                                                                                      |
| Streaming agent answers turn by turn / "Streaming stopped" on the timeline | The WebSocket was refused or broke: API log "rejected streaming session" (the `wss://` address or `TWILIO_AUTH_TOKEN` differs), the proxy drops upgrades, or the AI addendum isn't accepted |
| Worked yesterday, not today (development)                                  | The tunnel address changed: update `PUBLIC_BASE_URL`, restart, and update the Voice URL (step 6)                                                                                            |
