"use client";

import { ApiError, toApiError } from "./errors";

const BASE = "/api/v1";

function csrfToken(): string | undefined {
  return document.cookie
    .split("; ")
    .find((c) => c.startsWith("csrf_token="))
    ?.slice("csrf_token=".length);
}

let refreshing: Promise<boolean> | null = null;

/** One refresh at a time, shared by every request that hit a 401 */
export function refreshSession(): Promise<boolean> {
  refreshing ??= fetch(`${BASE}/auth/refresh`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "x-csrf-token": csrfToken() ?? "" },
  })
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

type Options = { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown; retry?: boolean };

/**
 * Browser API client: same-origin (proxied to the API), sends the CSRF header on writes,
 * refreshes the session once on 401 and retries.
 */
export async function api<T>(path: string, { method = "GET", body, retry = true }: Options = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") headers["x-csrf-token"] = csrfToken() ?? "";

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    credentials: "same-origin",
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  if (res.status === 401 && retry && !path.startsWith("/auth/")) {
    if (await refreshSession()) return api<T>(path, { method, body, retry: false });
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
    throw new ApiError(401, { detail: "Session expired" });
  }
  if (!res.ok) throw await toApiError(res);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/**
 * Multipart upload with progress (fetch cannot report upload progress).
 * Same CSRF and refresh-once behaviour as `api`.
 */
export function upload<T>(
  path: string,
  form: FormData,
  onProgress?: (fraction: number) => void,
  retry = true,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${BASE}${path}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader("accept", "application/json");
    xhr.setRequestHeader("x-csrf-token", csrfToken() ?? "");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onerror = () =>
      reject(new ApiError(0, { detail: "Network error. Check your connection and try again." }));
    xhr.onload = async () => {
      if (xhr.status === 401 && retry) {
        if (await refreshSession()) return upload<T>(path, form, onProgress, false).then(resolve, reject);
        window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
        return reject(new ApiError(401, { detail: "Session expired" }));
      }
      const res = new Response(xhr.responseText || null, {
        status: xhr.status,
        headers: { "content-type": xhr.getResponseHeader("content-type") ?? "application/json" },
      });
      if (!res.ok) return reject(await toApiError(res));
      resolve((await res.json()) as T);
    };
    xhr.send(form);
  });
}
