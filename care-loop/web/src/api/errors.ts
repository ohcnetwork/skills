// api/errors.ts — the error envelope the service returns on every failure ([[PLAN-loop-service]] §6).
// `code` is stable and safe to branch on; `message` is for humans and may be reworded.
export interface ApiErrorBody {
  error: { code: string; message: string };
}
