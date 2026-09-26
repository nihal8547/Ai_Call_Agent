import nodemailer from "nodemailer";
import { ToolError } from "./errors";
import { resolvePublic } from "./net";

export type SmtpCredentials = {
  host: string;
  port: number;
  secure: boolean;
  username?: string;
  password?: string;
};
export type SmtpSettings = { from: string; fromName?: string; defaultTo: string[] };
export type Mail = { to: string[]; subject: string; text: string };

/** Header values never carry line breaks (header injection) */
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

async function transport(creds: SmtpCredentials, opts: { allowPrivateNetwork: boolean; timeoutMs: number }) {
  // Connect to the address we validated; TLS still verifies the certificate for the real host name
  const address = await resolvePublic(creds.host, opts.allowPrivateNetwork);
  return nodemailer.createTransport({
    host: address,
    port: creds.port,
    secure: creds.secure,
    requireTLS: !creds.secure && !opts.allowPrivateNetwork,
    ...(creds.username ? { auth: { user: creds.username, pass: creds.password ?? "" } } : {}),
    tls: { servername: creds.host },
    connectionTimeout: opts.timeoutMs,
    greetingTimeout: opts.timeoutMs,
    socketTimeout: opts.timeoutMs,
  });
}

function mapError(err: unknown): ToolError {
  if (err instanceof ToolError) return err;
  const e = err as { code?: string; responseCode?: number; message?: string };
  if (e.code === "EAUTH" || e.responseCode === 535)
    return new ToolError("auth", "The mail server rejected the username or password");
  if (e.code === "ETIMEDOUT" || e.code === "ETIMEOUT")
    return new ToolError("timeout", "The mail server did not answer in time");
  if (e.responseCode && e.responseCode >= 500)
    return new ToolError("rejected", `The mail server refused the message (${e.responseCode})`);
  if (e.responseCode && e.responseCode >= 400)
    return new ToolError("unavailable", `The mail server is busy (${e.responseCode})`);
  return new ToolError("unavailable", `Could not reach the mail server${e.code ? ` (${e.code})` : ""}`);
}

export async function sendMail(
  creds: SmtpCredentials,
  settings: SmtpSettings,
  mail: Mail,
  opts: { allowPrivateNetwork: boolean; timeoutMs: number; idempotencyKey?: string },
): Promise<{ messageId: string }> {
  try {
    const t = await transport(creds, opts);
    const info = await t.sendMail({
      from: settings.fromName ? { name: oneLine(settings.fromName), address: settings.from } : settings.from,
      to: mail.to,
      subject: oneLine(mail.subject).slice(0, 200),
      text: mail.text.slice(0, 20_000),
      ...(opts.idempotencyKey ? { headers: { "X-Idempotency-Key": oneLine(opts.idempotencyKey) } } : {}),
    });
    t.close();
    return { messageId: String(info.messageId ?? "") };
  } catch (err) {
    throw mapError(err);
  }
}

/** Connect and authenticate without sending anything */
export async function verifySmtp(
  creds: SmtpCredentials,
  opts: { allowPrivateNetwork: boolean; timeoutMs: number },
): Promise<void> {
  try {
    const t = await transport(creds, opts);
    await t.verify();
    t.close();
  } catch (err) {
    throw mapError(err);
  }
}
