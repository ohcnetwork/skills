// Shared guard for the live suite.
//
// These tests spawn REAL opencode sessions against a real provider: they cost paid requests, need
// credentials, and take tens of seconds. They are deliberately excluded from `npm test` (which globs
// `test/*.test.ts`, not this directory) and gated on CARE_LIVE=1 on top of that, so an accidental
// `node --test` sweep skips them instead of quietly spending the budget.
//
// Run them with `npm run test:live`, which sets the flag.

export const LIVE = process.env.CARE_LIVE === "1";
export const SKIP = LIVE ? false : "set CARE_LIVE=1 (or use `npm run test:live`) — spends real requests";

export const PROVIDER = process.env.PROBE_PROVIDER ?? "github-copilot";
export const MODEL = process.env.PROBE_MODEL ?? "claude-sonnet-4.6";
