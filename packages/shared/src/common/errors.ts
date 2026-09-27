import { z } from "zod";

/**
 * Stable machine-readable error codes. The frontend maps these to messages;
 * never change the meaning of an existing code.
 */
export const ErrorCode = z.enum([
  "VALIDATION_FAILED",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMITED",
  "PAYLOAD_TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE",
  "USAGE_LIMIT_EXCEEDED",
  "INVALID_CREDENTIALS",
  "TOKEN_EXPIRED",
  "TENANT_SUSPENDED",
  "INTERNAL_ERROR",
  "SERVICE_UNAVAILABLE",
  /** A connected service (calendar, CRM, …) refused or failed the request */
  "INTEGRATION_ERROR",
  /** WhatsApp: more than 24 hours since the customer's last message; only templates may be sent */
  "WHATSAPP_WINDOW_CLOSED",
  "EMAIL_NOT_VERIFIED",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** One field-level problem, `path` is a dotted path into the request body/query */
export const FieldError = z.object({
  path: z.string(),
  message: z.string(),
  code: z.string().optional(),
});
export type FieldError = z.infer<typeof FieldError>;

/** RFC 7807 problem details body returned by the API for every error */
export const ProblemDetails = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: ErrorCode,
  detail: z.string().optional(),
  instance: z.string().optional(),
  requestId: z.string().optional(),
  errors: z.array(FieldError).optional(),
});
export type ProblemDetails = z.infer<typeof ProblemDetails>;

/** Convert zod issues into API field errors */
export function zodIssuesToFieldErrors(issues: readonly z.core.$ZodIssue[]): FieldError[] {
  return issues.map((i) => ({
    path: i.path.map(String).join("."),
    message: i.message,
    code: i.code,
  }));
}
