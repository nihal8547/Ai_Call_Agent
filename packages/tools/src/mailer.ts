import { type Mail, sendMail, type SmtpCredentials, type SmtpSettings, verifySmtp } from "./email";
import { ToolError, kindForStatus } from "./errors";
import { googleAccessToken, googleFetch, type GoogleDeps, SCOPES } from "./google/auth";
import { MS_GRAPH, MS_SCOPES, microsoftAccessToken, type MicrosoftDeps, msFetch } from "./microsoft";

/**
 * What an email integration holds: SMTP login details, or a mailbox connected by signing in with
 * Google (Gmail API) or Microsoft (Outlook / Microsoft 365, through Microsoft Graph).
 */
export type MailCredentials =
  | SmtpCredentials
  | { kind: "google_oauth"; refreshToken: string; email: string }
  | { kind: "microsoft_oauth"; refreshToken: string; email: string };

export type MailDeps = {
  allowPrivateNetwork: boolean;
  timeoutMs: number;
  idempotencyKey?: string;
  google?: GoogleDeps;
  microsoft?: MicrosoftDeps;
};

const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();
/** RFC 2047 for non-ASCII header text (Arabic subjects and names) */
const header = (s: string) =>
  /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;

function oauthKind(creds: MailCredentials): "google_oauth" | "microsoft_oauth" | null {
  const k = (creds as { kind?: string }).kind;
  return k === "google_oauth" || k === "microsoft_oauth" ? k : null;
}

/** Send one email through whichever kind of connection the business set up */
export async function deliverMail(
  creds: MailCredentials,
  settings: SmtpSettings,
  mail: Mail,
  deps: MailDeps,
): Promise<{ messageId: string }> {
  const kind = oauthKind(creds);
  if (!kind) return sendMail(creds as SmtpCredentials, settings, mail, deps);
  const account = (creds as { email: string }).email;
  const subject = oneLine(mail.subject).slice(0, 200);
  const text = mail.text.slice(0, 20_000);

  if (kind === "google_oauth") {
    if (!deps.google) throw new ToolError("config", "Google sign-in is not configured on this platform");
    const token = await googleAccessToken(
      { kind: "oauth", refreshToken: (creds as { refreshToken: string }).refreshToken },
      SCOPES.gmail,
      deps.google,
    );
    // Gmail sends as the signed-in account; only the display name is ours to choose
    const from = settings.fromName ? `${header(oneLine(settings.fromName))} <${account}>` : account;
    const raw = [
      `From: ${from}`,
      `To: ${mail.to.join(", ")}`,
      `Subject: ${header(subject)}`,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      ...(deps.idempotencyKey ? [`X-Idempotency-Key: ${oneLine(deps.idempotencyKey)}`] : []),
      "",
      Buffer.from(text, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n"),
    ].join("\r\n");
    const res = await googleFetch(
      deps.google,
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ raw: Buffer.from(raw, "utf8").toString("base64url") }),
      },
    );
    const data = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
    if (!res.ok)
      throw new ToolError(
        kindForStatus(res.status),
        `Gmail refused the message: ${data.error?.message ?? res.status}`,
      );
    return { messageId: String(data.id ?? "") };
  }

  if (!deps.microsoft) throw new ToolError("config", "Microsoft sign-in is not configured on this platform");
  const token = await microsoftAccessToken(
    (creds as { refreshToken: string }).refreshToken,
    MS_SCOPES.mail,
    deps.microsoft,
  );
  const res = await msFetch(deps.microsoft, `${MS_GRAPH}/me/sendMail`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: "Text", content: text },
        toRecipients: mail.to.map((address) => ({ emailAddress: { address } })),
        ...(deps.idempotencyKey
          ? { internetMessageHeaders: [{ name: "X-Idempotency-Key", value: oneLine(deps.idempotencyKey) }] }
          : {}),
      },
      saveToSentItems: true,
    }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new ToolError(
      kindForStatus(res.status),
      `Outlook refused the message: ${data.error?.message ?? res.status}`,
    );
  }
  return { messageId: "" };
}

/** Prove the connection works without sending anything */
export async function verifyMail(creds: MailCredentials, deps: MailDeps): Promise<string> {
  const kind = oauthKind(creds);
  if (!kind) {
    await verifySmtp(creds as SmtpCredentials, deps);
    return "Logged in to the mail server";
  }
  const account = (creds as { email: string }).email;
  const refreshToken = (creds as { refreshToken: string }).refreshToken;
  if (kind === "google_oauth") {
    if (!deps.google) throw new ToolError("config", "Google sign-in is not configured on this platform");
    await googleAccessToken({ kind: "oauth", refreshToken }, SCOPES.gmail, deps.google);
    return `Connected to Gmail as ${account}`;
  }
  if (!deps.microsoft) throw new ToolError("config", "Microsoft sign-in is not configured on this platform");
  await microsoftAccessToken(refreshToken, MS_SCOPES.mail, deps.microsoft);
  return `Connected to Outlook as ${account}`;
}
