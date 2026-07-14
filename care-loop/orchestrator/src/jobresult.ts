// JobResult@1 — the schema-validated worker boundary (PLAN-orchestrator-architecture §3).
//
// In the headless design the orchestrator never trusts agent prose: every spawn returns a typed
// JobResult, validated at the runner. With opencode this is a NATIVE feature — `session.prompt`
// with `format: { type: "json_schema", schema: JOBRESULT_SCHEMA }` makes opencode return a
// validated `structured_output` (with its own retry), so a malformed result is the runner's
// problem, not ours. This file is the single source of that schema + its TS type + an ajv guard
// (belt-and-suspenders: we re-validate what opencode hands back, and cross-check model_used).
//
// This is the reviewer-shaped v1 used by the Phase-2 spike. The generic multi-role JobResult
// (roles.ts verdict/reason_code tables) generalises this once more roles land.

import Ajv, { type ValidateFunction } from "ajv";

export const JOBRESULT_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  additionalProperties: false,
  required: [
    "schema",
    "role",
    "run_id",
    "round",
    "terminal_state",
    "verdict",
    "reason_code",
    "findings",
    "model_used",
  ],
  properties: {
    schema: { type: "string", const: "care-loop/jobresult@1" },
    role: { type: "string", enum: ["care-reviewer"] },
    run_id: { type: "string", minLength: 1 },
    round: { type: "integer", minimum: 1 },
    terminal_state: {
      type: "string",
      enum: ["done", "needs_input", "blocked", "failed"],
    },
    // reviewer verdict vocabulary (roles.ts in the full build)
    verdict: { type: "string", enum: ["pass", "findings", "blocked"] },
    reason_code: { type: "string", minLength: 1 },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["class", "file", "line_hint", "note"],
        properties: {
          class: {
            type: "string",
            enum: ["correctness", "overengineering", "legibility", "other"],
          },
          file: { type: "string", minLength: 1 },
          line_hint: { type: "string" },
          note: { type: "string", minLength: 1 },
        },
      },
    },
    evidence: { type: "array", items: { type: "string" } },
    model_used: { type: "string", minLength: 1 },
  },
} as const;

export interface Finding {
  class: "correctness" | "overengineering" | "legibility" | "other";
  file: string;
  line_hint: string;
  note: string;
}

export interface JobResult {
  schema: "care-loop/jobresult@1";
  role: "care-reviewer";
  run_id: string;
  round: number;
  terminal_state: "done" | "needs_input" | "blocked" | "failed";
  verdict: "pass" | "findings" | "blocked";
  reason_code: string;
  findings: Finding[];
  evidence?: string[];
  model_used: string;
}

const ajv = new Ajv({ allErrors: true });
export const validateJobResult: ValidateFunction<JobResult> =
  ajv.compile<JobResult>(JOBRESULT_SCHEMA);
