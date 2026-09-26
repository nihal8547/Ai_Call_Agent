import type { FieldError, ProblemDetails } from "@platform/shared";

/** Error thrown by the API clients; carries the RFC 7807 body from the server */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: Partial<ProblemDetails>,
  ) {
    super(problem.detail ?? problem.title ?? `Request failed (${status})`);
    this.name = "ApiError";
  }

  get fieldErrors(): FieldError[] {
    return this.problem.errors ?? [];
  }
}

export async function toApiError(res: Response): Promise<ApiError> {
  let body: Partial<ProblemDetails> = {};
  try {
    body = (await res.json()) as Partial<ProblemDetails>;
  } catch {
    // non-JSON error (proxy/network)
  }
  return new ApiError(res.status, body);
}

/** Human message for any thrown value */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) return "Too many attempts. Please wait a moment and try again.";
    if (err.status >= 500) return "Something went wrong on our side. Please try again.";
    return err.message;
  }
  return "Network error. Check your connection and try again.";
}
