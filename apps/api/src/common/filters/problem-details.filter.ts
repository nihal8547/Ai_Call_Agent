import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import { type ErrorCode, type FieldError, type ProblemDetails } from "@platform/shared";
import type { FastifyReply, FastifyRequest } from "fastify";

/** Throw this from services/controllers to return a specific problem code */
export class AppException extends HttpException {
  constructor(
    status: number,
    readonly code: ErrorCode,
    detail?: string,
    readonly fieldErrors?: FieldError[],
  ) {
    super(detail ?? code, status);
  }
}

const STATUS_TO_CODE: Record<number, ErrorCode> = {
  400: "VALIDATION_FAILED",
  401: "UNAUTHENTICATED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  415: "UNSUPPORTED_MEDIA_TYPE",
  429: "RATE_LIMITED",
  503: "SERVICE_UNAVAILABLE",
};

/**
 * Every error leaves the API as RFC 7807 `application/problem+json`.
 * Unexpected errors are logged with their stack and returned as a generic 500 — internals never leak.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<FastifyRequest>();
    const reply = ctx.getResponse<FastifyReply>();

    let body: ProblemDetails;
    if (exception instanceof AppException) {
      body = this.problem(
        exception.getStatus(),
        exception.code,
        exception.message,
        req,
        exception.fieldErrors,
      );
    } else if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = STATUS_TO_CODE[status] ?? (status >= 500 ? "INTERNAL_ERROR" : "VALIDATION_FAILED");
      const detail = status >= 500 ? undefined : exception.message;
      body = this.problem(status, code, detail, req);
    } else if (isFastifyClientError(exception)) {
      const status = exception.statusCode;
      body = this.problem(status, STATUS_TO_CODE[status] ?? "VALIDATION_FAILED", exception.message, req);
    } else {
      this.logger.error({ err: exception, requestId: req.id }, "Unhandled error");
      body = this.problem(HttpStatus.INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", undefined, req);
    }

    void reply.status(body.status).header("content-type", "application/problem+json").send(body);
  }

  private problem(
    status: number,
    code: ErrorCode,
    detail: string | undefined,
    req: FastifyRequest,
    errors?: FieldError[],
  ): ProblemDetails {
    return {
      type: `https://errors.voice-platform.dev/${code.toLowerCase().replaceAll("_", "-")}`,
      title: code
        .toLowerCase()
        .split("_")
        .map((w) => w[0]?.toUpperCase() + w.slice(1))
        .join(" "),
      status,
      code,
      ...(detail ? { detail } : {}),
      instance: req.url,
      requestId: String(req.id),
      ...(errors?.length ? { errors } : {}),
    };
  }
}

function isFastifyClientError(e: unknown): e is { statusCode: number; message: string } {
  return (
    typeof e === "object" &&
    e !== null &&
    "statusCode" in e &&
    typeof (e as { statusCode: unknown }).statusCode === "number" &&
    (e as { statusCode: number }).statusCode >= 400 &&
    (e as { statusCode: number }).statusCode < 500
  );
}
