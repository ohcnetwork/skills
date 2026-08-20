// api/client.ts — the one place that talks to the service.
//
// Every request is same-origin (`/api/...`): in development Vite proxies to the service, and in
// production the service serves these assets itself. That is deliberate — it means the session
// cookie needs no cross-origin handling and no CORS policy exists to get wrong.

import type { ApiErrorBody } from "./errors";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      // The cookie is same-origin, but being explicit means a future move to a separate API host
      // fails loudly at CORS rather than silently dropping the session.
      credentials: "same-origin",
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
      ...init,
    });
  } catch (cause) {
    // fetch only rejects for network-level failures — the service being down is the common one, and
    // it deserves a clearer message than "Failed to fetch".
    throw new ApiError(0, "unreachable", "cannot reach the care-loop service");
  }

  if (res.status === 204) return undefined as T;

  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const envelope = body as ApiErrorBody | null;
    throw new ApiError(
      res.status,
      envelope?.error?.code ?? "unknown",
      envelope?.error?.message ?? `request failed (${res.status})`,
    );
  }
  return body as T;
}

/** Serialize filters, dropping empties so the URL reflects only what is actually filtered — a
 *  querystring full of `&repo=` is noise in the address bar and in the query cache key alike. */
export function qs(params: object): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params) as [string, unknown][]) {
    if (v === undefined || v === null || v === "") continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export const api = {
  get: <T,>(path: string) => request<T>(path),
  post: <T,>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) }),
};
