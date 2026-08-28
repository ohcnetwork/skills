import type { Response } from "express";

/** `code` is stable and safe for clients to branch on; `message` is for humans and may be reworded. */
export interface ApiErrorBody {
  error: { code: string; message: string };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string): ApiError =>
  new ApiError(400, code, message);
export const notFound = (code: string, message: string): ApiError =>
  new ApiError(404, code, message);
export const conflict = (code: string, message: string): ApiError =>
  new ApiError(409, code, message);

function clientErrorStatus(err: unknown): number | null {
  const e = err as { status?: unknown; statusCode?: unknown };
  const status = typeof e?.status === "number" ? e.status : e?.statusCode;
  return typeof status === "number" && status >= 400 && status < 500 ? status : null;
}

/** `express.json()` rejects a malformed body with a SyntaxError carrying `body`. */
function isMalformedJson(err: unknown): boolean {
  return err instanceof SyntaxError && "body" in (err as object);
}

export function sendError(res: Response, err: unknown): void {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }

  // Middleware we did not write can still classify the caller's fault correctly. Only 4xx is
  // honoured — a dependency's 5xx is ours to own, and its message may carry internals.
  const status = clientErrorStatus(err);
  if (status !== null) {
    const malformed = isMalformedJson(err);
    res.status(status).json({
      error: {
        code: malformed ? "bad_json" : "bad_request",
        message: malformed ? "request body is not valid JSON" : "bad request",
      },
    });
    return;
  }

  // Never echo an unmodelled message: it can carry a file path or a SQL fragment.
  console.error("[service] unhandled:", err);
  res.status(500).json({ error: { code: "internal", message: "internal error" } });
}
