# One-click integrations: OAuth app setup

Businesses connect Google, Microsoft, HubSpot and Zoho by clicking **Continue with …**, signing in
on the provider's own page and coming back already connected. No keys or passwords are copied.

For that to work, the **platform operator** registers one OAuth app per provider, once, and puts
its client ID and secret in the API's environment. A provider without an app shows its button
disabled with a note, and businesses can still use the manual option (service-account key,
private-app token, Zoho Self Client, SMTP).

All callbacks go through the web app (same origin as the sign-in cookie), so the redirect URI is:

```
<WEB_BASE_URL>/api/v1/integrations/oauth/<provider>/callback
```

For production with `WEB_BASE_URL=https://app.example.com`, the Google one is
`https://app.example.com/api/v1/integrations/oauth/google/callback`. For local development, add the
`http://localhost:3000/...` URI too (Microsoft and Google allow `http` only for localhost).

| Provider  | Connects                               | Env variables                                          |
| --------- | -------------------------------------- | ------------------------------------------------------ |
| Google    | Calendar, Sheets, email via Gmail      | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` |
| Microsoft | Email via Outlook / Microsoft 365      | `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`       |
| HubSpot   | HubSpot CRM (contacts)                 | `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`           |
| Zoho      | Zoho CRM (leads), any Zoho data centre | `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`                 |

Restart the API after setting them. The Integrations page then shows the buttons enabled.

## How it works (security)

- **Start**: the API checks the business's settings first (e.g. email recipients), stores a
  random one-time `state` in Redis for 10 minutes, sets an httpOnly cookie that binds the flow to
  this browser, and sends the browser to the provider.
- **Callback**: the state must exist, not be used before, and match the cookie of the browser
  that started it; it is deleted on first use. The connection is created for the business and
  user recorded in the state (and audited). Declining on the provider's page shows
  "… access was not granted" and creates nothing.
- Only the **refresh token** is kept, encrypted with the business's own key (envelope encryption,
  bound to the integration). Access tokens live in memory only.
- Microsoft rotates refresh tokens on every use; the new one is re-encrypted and saved.
- Scopes are the smallest that do the job: email is **send-only** (the platform can't read the
  mailbox).
- Revoking access at the provider (Google account permissions, Microsoft "My apps", HubSpot or
  Zoho connected apps) makes **Test** fail with an authentication error; the business signs in
  again.

## Google (Calendar, Sheets, Gmail)

1. [Google Cloud console](https://console.cloud.google.com/) → create or pick a project.
2. **APIs & Services → Library**: enable **Google Calendar API**, **Google Sheets API** and
   **Gmail API**.
3. **OAuth consent screen**: user type **External**; app name, support email, logo, privacy policy
   and terms links; add the scopes below; while in "Testing", add test users.
4. **Credentials → Create credentials → OAuth client ID** → type **Web application** →
   authorised redirect URI `<WEB_BASE_URL>/api/v1/integrations/oauth/google/callback`.
5. Set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`.

Scopes requested (one set per connection, never all at once):

| Connection | Scope                                                                    |
| ---------- | ------------------------------------------------------------------------ |
| Calendar   | `https://www.googleapis.com/auth/calendar.events`, `…/calendar.readonly` |
| Sheets     | `https://www.googleapis.com/auth/spreadsheets`                           |
| Gmail      | `https://www.googleapis.com/auth/gmail.send`, `openid`, `email`          |

**Verification:** Calendar and Sheets are _sensitive_ scopes, and `gmail.send` is also sensitive.
While the app is in "Testing", only listed test users can sign in and refresh tokens expire after
7 days. Before offering it to customers, publish the app and complete Google's **app
verification** (privacy policy on your domain, a short video of the consent flow, justification of
each scope). `gmail.send` is not a _restricted_ scope, so no third-party security assessment is
needed.

## Microsoft (Outlook / Microsoft 365 email)

1. [Microsoft Entra admin centre](https://entra.microsoft.com/) → **App registrations → New
   registration**.
2. Supported account types: **Accounts in any organizational directory and personal Microsoft
   accounts** (the platform uses the `common` endpoint, so both work-school and outlook.com
   accounts can sign in).
3. Redirect URI: platform **Web**, `<WEB_BASE_URL>/api/v1/integrations/oauth/microsoft/callback`.
4. **Certificates & secrets → New client secret**; copy the _value_ (not the ID). Secrets expire
   (at most 24 months), so put the renewal date in the calendar.
5. **API permissions → Microsoft Graph → Delegated**: `Mail.Send`, `User.Read`, `offline_access`,
   `openid`, `email`. None needs admin consent, but some organisations require it for any
   app; their admin can grant it from the same page or when the first user signs in.
6. Set `MICROSOFT_CLIENT_ID` (the "Application (client) ID") and `MICROSOFT_CLIENT_SECRET`.
7. Optional: **Branding & properties** → publisher domain and **publisher verification** (a
   Microsoft Partner ID), which removes the "unverified" label on the consent page.

Scopes requested: `offline_access openid email User.Read Mail.Send`. Mail is sent with Graph
`POST /me/sendMail` and saved to the mailbox's Sent Items.

## HubSpot

1. [HubSpot developer account](https://developers.hubspot.com/) → **Apps → Create app** (public
   app, OAuth).
2. **Auth → Redirect URL**: `<WEB_BASE_URL>/api/v1/integrations/oauth/hubspot/callback`.
3. Scopes: `crm.objects.contacts.read`, `crm.objects.contacts.write`,
   `crm.schemas.contacts.read`.
4. Set `HUBSPOT_CLIENT_ID` and `HUBSPOT_CLIENT_SECRET`.

Businesses that prefer can still paste a private-app access token instead.

## Zoho CRM

1. [Zoho API Console](https://api-console.zoho.com/) → **Add client → Server-based
   Applications**.
2. Homepage URL: `WEB_BASE_URL`; authorised redirect URI:
   `<WEB_BASE_URL>/api/v1/integrations/oauth/zoho/callback`.
3. Set `ZOHO_CLIENT_ID` and `ZOHO_CLIENT_SECRET`.
4. Under **Settings**, enable **Multi-DC** so accounts in other Zoho data centres (EU, IN, AU,
   SA …) can use the same client. The platform follows the `accounts-server` Zoho returns.

Scopes requested: `ZohoCRM.modules.leads.ALL,ZohoCRM.settings.fields.READ`.

## Checking it

1. Open **Integrations → Add** as a business owner. The provider buttons are enabled.
2. Click **Continue with …**, sign in, allow. You come back to Integrations with the new
   connection marked connected (email shows "via Gmail" / "via Outlook" and the account).
3. Click **Test**: "Connected to Gmail as …" / "Connected to Outlook as …", or the calendar /
   CRM check.

Common errors on the provider's page:

| Error                                    | Fix                                                           |
| ---------------------------------------- | ------------------------------------------------------------- |
| `redirect_uri_mismatch` / `AADSTS50011`  | The redirect URI in the app must match `WEB_BASE_URL` exactly |
| `access_denied` (Google, "Testing" mode) | Add the account as a test user, or publish and verify the app |
| `AADSTS65001` consent required           | The organisation's admin grants consent for the app           |
| `invalid_client`                         | Wrong or expired client secret (Microsoft secrets expire)     |
