export type WhatsAppErrorKind =
  /** Token expired or revoked: the business must connect again */
  | "auth"
  /** The token lacks a permission, or the app isn't allowed on this account */
  | "permission"
  /** Too many messages; try again later */
  | "rate_limited"
  /** More than 24 hours since the customer's last message: only templates can be sent */
  | "window_closed"
  /** The recipient can't receive it (not on WhatsApp, blocked the business …) */
  | "recipient"
  /** Meta blocked the account or message for policy reasons */
  | "policy"
  /** Bad request (wrong id, unsupported content, template problem) */
  | "invalid"
  /** Meta or the network failed; retrying may work */
  | "transient";

const RETRYABLE: ReadonlySet<WhatsAppErrorKind> = new Set(["rate_limited", "transient"]);

export class WhatsAppError extends Error {
  override readonly name = "WhatsAppError";
  readonly retryable: boolean;

  constructor(
    readonly kind: WhatsAppErrorKind,
    message: string,
    readonly code: number | null = null,
    readonly status: number | null = null,
  ) {
    super(message);
    this.retryable = RETRYABLE.has(kind);
  }
}

/** Meta's error codes (Graph and Cloud API) to what the platform does about them */
export function kindForGraphError(status: number, code: number | undefined): WhatsAppErrorKind {
  if (code === 190 || status === 401) return "auth";
  if (code === 131047) return "window_closed";
  if (code !== undefined && [4, 80007, 130429, 131048, 131056].includes(code)) return "rate_limited";
  if (code !== undefined && [131026, 131021].includes(code)) return "recipient";
  if (code !== undefined && [368, 131031, 131045].includes(code)) return "policy";
  if (code === 3 || code === 10 || (code !== undefined && code >= 200 && code < 300) || status === 403)
    return "permission";
  if (code !== undefined && [1, 2, 131000, 131016].includes(code)) return "transient";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "transient";
  return "invalid";
}
