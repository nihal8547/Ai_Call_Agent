/**
 * Why a tool failed. Callers never hear these; they decide retries, the integration's status
 * (auth/config problems mark it ERROR so staff see it) and what goes in the call timeline.
 */
export type ToolErrorKind =
  | "auth" // credentials rejected or access revoked
  | "config" // wrong calendar/sheet id, bad URL, missing permission on the resource
  | "unavailable" // network error or 5xx
  | "rate_limited"
  | "timeout"
  | "rejected" // the other side refused the request (4xx)
  | "blocked"; // destination not allowed (private network)

export class ToolError extends Error {
  constructor(
    readonly kind: ToolErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "ToolError";
  }

  get retryable(): boolean {
    return this.kind === "unavailable" || this.kind === "rate_limited" || this.kind === "timeout";
  }
}

/** Map an HTTP status from a provider to an error kind */
export function kindForStatus(status: number): ToolErrorKind {
  if (status === 401) return "auth";
  if (status === 403 || status === 404) return "config";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "unavailable";
  return "rejected";
}
