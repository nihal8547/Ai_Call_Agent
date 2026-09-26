import { HttpStatus } from "@nestjs/common";
import { safeEqual } from "@platform/crypto";
import type { FastifyRequest } from "fastify";
import { AppException } from "../filters/problem-details.filter";
import { COOKIE, CSRF_HEADER } from "./auth.types";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Double-submit CSRF check for cookie-authenticated, state-changing requests:
 * the `x-csrf-token` header must equal the (JS-readable) `csrf_token` cookie.
 * A cross-site page can make the browser send cookies but cannot read them to set the header.
 */
export function assertCsrf(req: FastifyRequest): void {
  if (SAFE_METHODS.has(req.method)) return;
  const cookie = req.cookies[COOKIE.csrf];
  const header = req.headers[CSRF_HEADER];
  if (!cookie || typeof header !== "string" || !safeEqual(cookie, header)) {
    throw new AppException(HttpStatus.FORBIDDEN, "FORBIDDEN", "Missing or invalid CSRF token");
  }
}
