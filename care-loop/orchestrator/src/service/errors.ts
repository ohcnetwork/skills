// service/errors.ts — one error shape for the whole API ([[PLAN-loop-service]] §6).
//
// `code` is a stable string the frontend may branch on; `message` is for humans and may be reworded
// freely. Keeping them separate is what lets the wording improve without breaking a client.

import type { Response } from "express";

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

export function sendError(res: Response, err: unknown): void {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }

  // Errors thrown by middleware we did not write, which still carry a meaningful status — chiefly
  // `express.json()`'s SyntaxError on a malformed body, which arrives with `status: 400`. Mapping it
  // to 500 told the caller the server was broken when in fact they sent garbage, and §6 promises
  // "400 malformed". Only 4xx is honoured: a 5xx from a dependency is still ours to own, and its
  // message may carry internals.
  const status = (err as { status?: unknown; statusCode?: unknown })?.status
    ?? (err as { statusCode?: unknown })?.statusCode;
  if (typeof status === "number" && status >= 400 && status < 500) {
    const isJson = err instanceof SyntaxError && "body" in (err as object);
    res.status(status).json({
      error: {
        code: isJson ? "bad_json" : "bad_request",
        message: isJson ? "request body is not valid JSON" : "bad request",
      },
    });
    return;
  }
  // Anything unmodelled is ours, not the caller's. The message is deliberately NOT echoed: it can
  // carry a file path or a SQL fragment, and this API is read-only to a whole team.
  console.error("[service] unhandled:", err);
  res.status(500).json({
    error: { code: "internal", message: "internal error" },
  });
}
