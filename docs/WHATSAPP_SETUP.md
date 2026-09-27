# WhatsApp: operator setup

Businesses connect their WhatsApp number in **Settings → WhatsApp** with **Continue with
Facebook** (Meta's Embedded Signup). For that, the platform operator sets up **one Meta app**
once. This guide covers that setup, the environment variables, and how to check it.

What businesses get today (W1–W2): their number connected through the official WhatsApp Business
Cloud API; the chosen agent answers customers automatically (its questions, knowledge base,
bookings and leads, written for WhatsApp); every conversation in the **Inbox** with full
history; staff take over and hand back; customers asking for a person are handed to staff, who
are emailed (the agent's hand-off emails, through the business's email integration). Voice notes
come in W3 (see [WPIntegration.md](WPIntegration.md)).

The agent waits `WHATSAPP_REPLY_DELAY_MS` (default 2500) after a customer's last message before
answering, so several short messages get one reply.

## 1. Meta business and app

1. **Meta Business portfolio** for the platform company at
   [business.facebook.com](https://business.facebook.com/), and complete **business
   verification** (Business settings → Security centre). Needed to go beyond test numbers.
2. [developers.facebook.com](https://developers.facebook.com/) → **My apps → Create app** → use
   case **Other** → type **Business** → connect it to the business portfolio.
3. **Add product → WhatsApp**. Meta creates a test WhatsApp Business account with a **test
   phone number** (it can message up to 5 recipient numbers you register): enough to try
   everything before approval.
4. **App settings → Basic**: copy the **App ID** and **App secret**; add a privacy policy URL, a
   terms URL, an icon and the app domain (your web app's domain).

## 2. Webhook

1. Choose a random verify token (at least 16 characters), e.g. `openssl rand -hex 24`.
2. Put it and the app secret in the API's environment (section 4) and restart the API.
3. **WhatsApp → Configuration → Webhook → Edit**:
   - Callback URL: `<PUBLIC_BASE_URL>/api/v1/webhooks/whatsapp`
     (e.g. `https://api.example.com/api/v1/webhooks/whatsapp`; Settings → WhatsApp shows it)
   - Verify token: the same token.
   - **Verify and save**. Meta calls the URL; the API answers only with the right token.
4. **Webhook fields**, subscribe to:
   - **messages**: customers' messages and delivery ticks
   - **smb_message_echoes**: replies the owner types on the WhatsApp Business app (numbers that stay
     on the app); they show in the Inbox and the agent steps back from that chat
   - **account_update**: bans, restrictions, the business removing the app
   - **phone_number_quality_update**: quality flags and messaging-limit changes

   Settings → WhatsApp lists the same fields. Missing ones only lose those updates.

Every webhook is checked with `X-Hub-Signature-256` (HMAC of the raw body with the app secret);
anything unsigned is refused. Businesses' numbers are subscribed to the app automatically when
they connect.

For local development, expose the API with a tunnel (`cloudflared tunnel --url
http://localhost:4000`) and use that address as `PUBLIC_BASE_URL` and in the callback URL.

## 3. Embedded Signup ("Continue with Facebook")

1. **Add product → Facebook Login for Business**.
2. **Facebook Login for Business → Settings**: add your web app's domain to **Allowed domains
   for the JavaScript SDK** (e.g. `https://app.example.com`, and `http://localhost:3000` in
   development if Meta allows it for your app mode) and turn on **Login with the JavaScript SDK**.
3. **Facebook Login for Business → Configurations → Create configuration**:
   - Login variation: **WhatsApp Embedded Signup**
   - Assets: WhatsApp accounts; permissions **whatsapp_business_management** and
     **whatsapp_business_messaging**
   - Copy the **Configuration ID**.
4. **Become a Tech Provider** (WhatsApp → Quickstart / "Become a Tech Provider") and submit **App
   Review** for `whatsapp_business_management` and `whatsapp_business_messaging` (advanced access),
   with a short screen recording of connecting a number and replying from the Inbox.

Until App Review is approved, only people with a role on the app (and the test number) can
connect.

### Numbers on the WhatsApp Business app (coexistence)

Most small businesses already answer customers on the **WhatsApp Business app**. They don't have
to give it up: on Settings → WhatsApp they tick **"My number is on the WhatsApp Business app"**
before **Continue with Facebook**. Meta's popup then asks them to scan a QR code in the app. The
number is **not registered** again (that would log the app out); messages reach both the app and
the platform. Needs a recent version of the app and a country where Meta offers it **(confirm for
Qatar in Meta's coexistence documentation)**; the `smb_message_echoes` field above; and Meta
limits such numbers to a lower message rate.

## 4. Environment variables (API)

| Variable                         | Value                                                   |
| -------------------------------- | ------------------------------------------------------- |
| `META_APP_ID`                    | App ID (digits)                                         |
| `META_APP_SECRET`                | App secret: webhook signatures and token exchange       |
| `META_EMBEDDED_SIGNUP_CONFIG_ID` | Configuration ID from section 3                         |
| `WHATSAPP_VERIFY_TOKEN`          | The random verify token from section 2                  |
| `META_GRAPH_VERSION`             | Optional, default `v23.0` (Graph API version)           |
| `PUBLIC_BASE_URL`                | The API's public HTTPS address (already set for Twilio) |

Without `META_APP_SECRET` the webhook refuses everything; without the three Meta app values the
**Continue with Facebook** button is disabled and businesses can only use the access-token option.

Voice notes need nothing extra from Meta. They use `GEMINI_API_KEY` (transcription and the
agent's spoken replies) and object storage (`STORAGE_*`, the same as documents). Optional:

| Variable                     | Value                                                                      |
| ---------------------------- | -------------------------------------------------------------------------- |
| `WHATSAPP_MEDIA_MAX_MB`      | Largest file downloaded from Meta, default `16`                            |
| `WHATSAPP_VOICE_MAX_SECONDS` | Longest voice note transcribed, default `180`; longer ones get a polite no |
| `GEMINI_TTS_MODEL`           | Speech model, default `gemini-2.5-flash-preview-tts`                       |

Voice notes are encoded and decoded in Node.js (libopus in WebAssembly): no ffmpeg in the image.
Without `GEMINI_API_KEY` customers who send a voice note are asked to type.

## 5. Checking it

Each number's card has **Check connection**: Meta still accepts the token, the number is
registered for the Cloud API (else **Finish registration**, with the owner's two-step PIN if they
set one), the platform's app still receives the account's webhooks (it subscribes again if
someone removed it), the last update from Meta, the display-name status and the messaging limit.
It runs once automatically after connecting.

1. As a business owner: **Settings → WhatsApp → Continue with Facebook**, finish the popup, pick
   the agent. The number shows **Connected** with its quality rating.
2. **Send test message** to your own phone: Meta's "Hello World" template arrives.
3. Reply to it from your phone: the conversation appears in the **Inbox** within seconds (the
   sidebar shows the unread count).
4. Reply from the Inbox: it arrives on the phone; the ticks turn to delivered and read.
5. Hand the chat back to the agent and send a voice note: the Inbox shows a player and the
   transcript, and the agent answers with a voice note (or text, per **Voice notes** on the
   number's card in Settings → WhatsApp).

### In the Inbox

- Customers' photos, videos, stickers and documents are downloaded when they arrive (Meta's links
  expire) and kept privately; photos and videos show in the chat, documents download. Files over
  `WHATSAPP_MEDIA_MAX_MB` (default 16) are not kept.
- Staff send JPEG/PNG photos (5 MB), MP4 videos (16 MB) and PDF, Word, Excel, PowerPoint or text
  files with a caption (the paperclip). Files are checked by their content, not their name.
- After 24 hours without a customer message, **Send a template** lists the number's approved
  templates (created in WhatsApp Manager), asks for their values and shows a preview. Templates
  with a photo/video/document header or named values aren't supported from the Inbox yet.
- Opening a conversation sends blue ticks for the customer's last message.

## 6. Troubleshooting

| What you see                                                    | Cause and fix                                                                                                                                           |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Meta can't verify the callback URL                              | `WHATSAPP_VERIFY_TOKEN` differs, the API wasn't restarted, or the URL isn't reachable over HTTPS                                                        |
| Nothing arrives in the Inbox                                    | Webhook field **messages** not subscribed; `META_APP_SECRET` wrong (API log: "invalid signature"); the number was disconnected                          |
| "Continue with Facebook" is disabled                            | One of `META_APP_ID`, `META_APP_SECRET`, `META_EMBEDDED_SIGNUP_CONFIG_ID` is missing                                                                    |
| The popup opens and closes with an error                        | Your domain isn't in **Allowed domains for the JavaScript SDK**, or the app isn't live / the user has no role on it during review                       |
| Number shows **Needs attention** ("Meta registration")          | Registering the number failed (e.g. still on the WhatsApp app, or two-step PIN set elsewhere); fix it in WhatsApp Manager, then **Finish registration** |
| "This WhatsApp number is already connected to another business" | A number belongs to one business on the platform; disconnect it there first                                                                             |
| Voice notes get "Could you type your message?"                  | No `GEMINI_API_KEY`, Gemini refused the audio, or nothing was heard; API log "voice note not processed" shows why                                       |
| The agent answers a voice note with text                        | The number's setting is "A text message", the reply was long or had a link, or Gemini speech failed (the message shows "sent as text" in the Inbox)     |
| "Check connection" says the webhook wasn't subscribed           | Someone removed the app in WhatsApp Manager; the check subscribed it again. If it keeps happening, check who manages the account                        |
| "Not registered for the WhatsApp Cloud API yet"                 | The number was added in WhatsApp Manager but never registered: **Finish registration**, with the two-step PIN if one was set                            |
| Reply fails with "Re-engagement message"                        | More than 24 hours since the customer's last message: WhatsApp allows only templates (coming in W4)                                                     |
| "Meta rejected the access token" on the number                  | The business removed the app's access or the token expired: reconnect with **Continue with Facebook**                                                   |
