import { type NextRequest, NextResponse } from "next/server";

/**
 * Content Security Policy with a fresh nonce per page: only this app's own scripts (and scripts
 * they load) run, so injected markup can't execute. The API is same-origin through /api.
 */
export function middleware(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const dev = process.env.NODE_ENV === "development";
  // WhatsApp's "Continue with Facebook" (Embedded Signup): the Facebook SDK frames and calls
  // facebook.com. Allowed on that settings page only.
  const facebook = /^\/t\/[^/]+\/settings\/whatsapp\/?$/.test(request.nextUrl.pathname);
  const fb = (sources: string) => (facebook ? ` ${sources}` : "");
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    // Tailwind and Next inject style attributes; styles can't run code
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${fb("https://*.facebook.com https://*.fbcdn.net")}`,
    "font-src 'self' data:",
    `connect-src 'self'${fb("https://*.facebook.com https://connect.facebook.net")}`,
    `frame-src 'self'${fb("https://*.facebook.com")}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      // Pages only: not the API proxy or static files
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
