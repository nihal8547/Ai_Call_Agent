import "server-only";
import type { MeResponse } from "@platform/shared";
import { cookies } from "next/headers";
import { toApiError } from "./errors";

const API = process.env.API_INTERNAL_URL ?? "http://localhost:4000";

/** Server-side GET to the API, forwarding the user's cookies. Returns null on 401. */
export async function serverGet<T>(path: string): Promise<T | null> {
  const cookieHeader = (await cookies()).toString();
  const res = await fetch(`${API}/api/v1${path}`, {
    headers: { cookie: cookieHeader, accept: "application/json" },
    cache: "no-store",
  });
  if (res.status === 401) return null;
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as T;
}

export const getMe = () => serverGet<MeResponse>("/auth/me");
