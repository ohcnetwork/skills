// opencode runner — the §4 worker boundary, minimal seed (Phase-2 spike).
//
// One judgment spawn = one opencode session, model-pinned, returning a schema-validated JobResult
// via opencode's native structured output. This is the first real brick of runner.ts: prove that
// opencode + GitHub Copilot drives a pinned judgment role headlessly and hands back a typed result.
//
// Deliberately thin: no FSM, no journal, no retry ladder yet (those are later phases). It only
// stands up the transport + the schema boundary + the model-pin cross-check (IMP-1, belt+suspenders).

import { createOpencode } from "@opencode-ai/sdk";
import { createServer } from "node:net";
import {
  JOBRESULT_SCHEMA,
  validateJobResult,
  type JobResult,
} from "./jobresult.js";

export interface SpawnSpec {
  role: JobResult["role"];
  providerID: string; // e.g. "github-copilot"
  modelID: string; // e.g. "claude-opus-4.8"
  system: string; // role prompt (the guide content)
  task: string; // user message: instructions + inline diff
  runId: string;
  round: number;
  timeoutMs?: number; // per-spawn wall-clock cap override (default JUDGMENT_TIMEOUT_MS)
}

/** Per-spawn usage/cost, extracted best-effort from opencode's message info (IMP-14 → rubric dim 3). */
export interface SpawnCost {
  usdEst?: number;
  inputTokens?: number;
  outputTokens?: number;
}

/** Pull cost + tokens off an opencode assistant-message `info` (both are best-effort; absent on some
 *  providers → undefined, which the caller treats as "cost unknown", never zero). */
function extractCost(info: any): SpawnCost | undefined {
  const usdEst = typeof info?.cost === "number" ? info.cost : undefined;
  const tk = info?.tokens ?? {};
  const inputTokens = typeof tk.input === "number" ? tk.input : undefined;
  const outputTokens = typeof tk.output === "number" ? tk.output : undefined;
  if (
    usdEst === undefined &&
    inputTokens === undefined &&
    outputTokens === undefined
  )
    return undefined;
  return { usdEst, inputTokens, outputTokens };
}

export interface SpawnOutcome {
  jobResult: JobResult;
  modelReported: string | undefined; // opencode's own report, for the pin cross-check
  modelPinSatisfied: boolean;
  cost?: SpawnCost;
  sessionId: string;
}

// opencode SDK responses come back as { data, ... } (responseStyle "fields"); tolerate both.
function unwrap<T>(x: any): T {
  return (x && typeof x === "object" && "data" in x ? x.data : x) as T;
}

/** Generic structured spawn: one model-pinned opencode session that returns JSON matching `schema`.
 *  The single opencode transport used by every role skill; the per-role shape is the caller's schema.
 *  Retries transient transport failures (a fresh embedded server per spawn can lose a startup race —
 *  "fetch failed" / ECONNREFUSED) so a flaky connection doesn't crash the whole run. */
const isTransient = (e: unknown): boolean =>
  /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|EADDRINUSE|and could not connect|terminated/i.test(
    String((e as Error)?.message ?? e),
  );

// Wall-clock cap for a judgment spawn. Without it a spawn can hang FOREVER — the live ENG-613 reviewer
// hung on opencode's headless permission prompt (below) with no timeout, wedging the whole run. A
// timeout turns an unbounded hang into a bounded, journaled failure. Override via env for slow models.
const JUDGMENT_TIMEOUT_MS =
  Number(process.env.OC_JUDGMENT_TIMEOUT_MS) || 240_000;

// Read-only judgment permission policy. The model MAY read files for review context — crucially
// `external_directory: "allow"` so it never blocks on opencode's headless "can I read this path?"
// prompt (the ENG-613 reviewer hang: it tried to open the changed source file, hit
// external_directory=ask, and waited forever for an answer no one could give). It may NOT edit, run
// bash, or fetch — judgment roles own no side effects.
const JUDGMENT_PERMISSION = {
  edit: "deny",
  bash: "deny",
  webfetch: "deny",
  external_directory: "allow",
} as const;

/** Reject if `p` doesn't settle within `ms` — the un-hang backstop for a judgment spawn. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// The SDK hardcodes `--port=4096` for every embedded server, and `opencode serve --port=0` ignores 0
// and also binds 4096 — so concurrent OR retried spawns (and stale/zombie servers left by a killed run)
// COLLIDE on 4096, which the live ENG-613 reviewer hit: its server attached to a broken 4096 listener →
// schema rejections + hang. Fix: pick a known-free ephemeral port in Node and pass it explicitly, so
// every judgment server is isolated. (Tiny TOCTOU window between close+bind is covered by the retry.)
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Start an embedded opencode server on a free port, retrying on a bind race. getFreePort() asks the OS
 * for a currently-free port (so N PARALLEL loops each get a distinct one), but there's a TOCTOU window
 * between our close() and opencode's bind() where a concurrent spawn could steal it → EADDRINUSE /
 * "Server exited". So we retry with a fresh port a few times. Deterministic outcome: a working server
 * on some free port, or a thrown error after exhausting tries.
 */
async function startOpencodeOnFreePort(
  config: object,
  maxTries = 5,
): Promise<Awaited<ReturnType<typeof createOpencode>>> {
  let lastErr: unknown;
  for (let i = 0; i < maxTries; i++) {
    const port = await getFreePort();
    try {
      return await createOpencode({ port, config: config as any });
    } catch (e) {
      lastErr = e;
      if (
        !/EADDRINUSE|address already in use|Server exited|listen/i.test(
          String((e as Error)?.message ?? e),
        )
      )
        throw e;
    }
  }
  throw lastErr;
}

export async function promptStructured(
  spec: {
    role: string;
    providerID: string;
    modelID: string;
    system: string;
    task: string;
    round: number;
    timeoutMs?: number;
  },
  schema: object,
): Promise<{
  data: any;
  modelReported: string | undefined;
  modelPinSatisfied: boolean;
  cost?: SpawnCost;
}> {
  const maxAttempts = 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await promptStructuredOnce(spec, schema);
    } catch (e) {
      lastErr = e;
      if (!isTransient(e) || attempt === maxAttempts) throw e;
      await new Promise((r) => setTimeout(r, 1000 * attempt)); // brief backoff, then a fresh server
    }
  }
  throw lastErr;
}

async function promptStructuredOnce(
  spec: {
    role: string;
    providerID: string;
    modelID: string;
    system: string;
    task: string;
    round: number;
    timeoutMs?: number;
  },
  schema: object,
): Promise<{
  data: any;
  modelReported: string | undefined;
  modelPinSatisfied: boolean;
  cost?: SpawnCost;
}> {
  const oc = await startOpencodeOnFreePort({ permission: JUDGMENT_PERMISSION });
  const timeoutMs = spec.timeoutMs ?? JUDGMENT_TIMEOUT_MS;
  try {
    return await withTimeout(
      (async () => {
        const session = unwrap<any>(
          await oc.client.session.create({
            body: { title: `${spec.role} r${spec.round}` },
          }),
        );
        const sessionId = session.id ?? session.sessionID;
        if (!sessionId)
          throw new Error("opencode: session.create returned no id");

        const res = unwrap<any>(
          await oc.client.session.prompt({
            path: { id: sessionId },
            // `format` (structured output) is in the runtime API + docs but missing from this SDK
            // version's published body type, so the body is cast. Proven live (spike-reviewer).
            body: {
              model: { providerID: spec.providerID, modelID: spec.modelID },
              system: spec.system,
              parts: [{ type: "text", text: spec.task }],
              format: { type: "json_schema", schema },
            } as any,
          }),
        );

        const info = res?.info ?? res;
        if (info?.error?.name === "StructuredOutputError") {
          throw new Error(
            `opencode StructuredOutputError after retries: ${info.error.message ?? "unknown"}`,
          );
        }
        const structured = info?.structured ?? info?.structured_output;
        if (structured == null) {
          throw new Error(
            `opencode returned no structured output. info keys: ${Object.keys(info ?? {}).join(", ")}`,
          );
        }
        const modelReported: string | undefined =
          info?.modelID ?? info?.model?.modelID ?? info?.providerModel;
        const modelPinSatisfied = modelReported
          ? modelReported.includes(spec.modelID)
          : true;
        return {
          data: structured,
          modelReported,
          modelPinSatisfied,
          cost: extractCost(info),
        };
      })(),
      timeoutMs,
      `opencode judgment spawn (${spec.role})`,
    );
  } finally {
    await oc.server?.close?.();
  }
}

export async function runJudgmentSpawn(spec: SpawnSpec): Promise<SpawnOutcome> {
  const { data, modelReported, modelPinSatisfied, cost } =
    await promptStructured(spec, JOBRESULT_SCHEMA);
  if (!validateJobResult(data)) {
    throw new Error(
      `JobResult failed schema validation: ${JSON.stringify(validateJobResult.errors, null, 2)}\n` +
        `got: ${JSON.stringify(data, null, 2)}`,
    );
  }
  return {
    jobResult: data,
    modelReported,
    modelPinSatisfied,
    cost,
    sessionId: "",
  };
}
