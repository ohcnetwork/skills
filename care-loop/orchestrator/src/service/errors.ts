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
  // Anything unmodelled is ours, not the caller's. The message is deliberately NOT echoed: it can
  // carry a file path or a SQL fragment, and this API is read-only to a whole team.
  console.error("[service] unhandled:", err);
  res.status(500).json({
    error: { code: "internal", message: "internal error" },
  });
}
