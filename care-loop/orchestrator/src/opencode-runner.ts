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
  tools?: Record<string, boolean>; // per-spawn tool gate (default { task: false }). A structured-
  // output spawn that also has exploration tools (read/grep/glob) collapses into non-converging
  // serial single-tool turns under `format` (see promptStructured); an inline-only role passes
  // NO_EXPLORE_TOOLS to make that impossible rather than only forbidding it in the prompt.
}

// Disable every exploration / side-effect tool for a spawn that must reason from its INLINE inputs
// only (the reviewer). Structured emit needs no tools, so an empty toolset lets `format` emit directly
// instead of fighting an agentic loop — the hard-capability version of the reviewer's "review the
// inline diff only" prompt bound.
export const NO_EXPLORE_TOOLS: Record<string, boolean> = {
  task: false,
  read: false,
  grep: false,
  glob: false,
  list: false,
  write: false,
  edit: false,
  bash: false,
  patch: false,
  webfetch: false,
};

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

// Edit-enabled permission for the END-OF-RUN DOCTOR only (auto-doctor.ts). Unlike judgment roles, the
// doctor's job IS to edit skill prose + write diagnosis/fixture files, so `edit: "allow"`. It still may
// NOT run bash or fetch — every OTHER side effect (git/gh/tests/evals) stays with the deterministic
// orchestrator scaffold, off the autonomous agent. `external_directory: "allow"` lets it reach the
// skills repo by absolute path (the orchestrator process runs from orchestrator/, the skills live in
// the repo root). NOTE (Phase-3 live smoke): confirm new-file creation (diagnoses/*, new fixtures)
// isn't gated by a separate opencode `write` permission on the deployed SDK version; widen here if so.
const DOCTOR_PERMISSION = {
  edit: "allow",
  bash: "deny",
  webfetch: "deny",
  external_directory: "allow",
} as const;

// Transport model: `session.prompt` (POST /session/{id}/message) is a BLOCKING request — the server
// holds the connection open for the entire agentic run and sends response headers only when it's done.
// Node's global fetch (undici) caps that at a default `headersTimeout` of 300s, so any spawn whose run
// exceeds ~5 min was killed with `TypeError: fetch failed` — indistinguishable from a real network drop,
// so `isTransient` retried it, turning one slow recon into a ~15-min, 3× money-burn (the ENG-747 planner
// hang). The SDK's `req.timeout = false` is a no-op: undici's timeouts live on the dispatcher, not the
// Request. So we DON'T use the blocking prompt. `driveToCompletion` uses the async pattern opencode ships
// for exactly this: `promptAsync` (returns 204 immediately) + subscribe to the `/event` SSE bus, wait for
// `session.idle`, then fetch the finished message. The SSE connection streams continuously (headers arrive
// at once; the bus emits frequently, and createSseClient auto-reconnects with Last-Event-ID), so no undici
// timeout ever trips. The only wall-clock cap is our own explicit deadline — a bounded, journaled timeout
// (we also `session.abort` the server-side run) rather than a silent fetch-failed storm.

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

/**
 * Start a warm opencode server for the care-evals `opencode` adapter, which POSTs to
 * `$OPENCODE_SERVER_URL/session/.../message`. REUSES the same embedded-server infra as the judgment
 * spawns (getFreePort + createOpencode, bind-race retry) instead of shelling a separate `opencode
 * serve` — no binary resolution, no readiness polling (createOpencode resolves once listening), one
 * code path. Returns the URL to hand run_eval.py as OPENCODE_SERVER_URL, plus a close(). The
 * auto-doctor's `runEvals` seam brackets the eval sweep with start → run → close.
 */
export async function startEvalServer(
  maxTries = 5,
): Promise<{ url: string; close: () => Promise<void> }> {
  let lastErr: unknown;
  for (let i = 0; i < maxTries; i++) {
    const port = await getFreePort();
    try {
      const oc = await startOpencodeOnFreePortAt(port);
      return {
        url: `http://127.0.0.1:${port}`,
        close: async () => {
          await oc.server?.close?.();
        },
      };
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

/** createOpencode on a specific port (the eval server needs no special permission/tools — the eval
 *  adapter sets tools-off per call and inlines all inputs into the prompt, so no file access). */
function startOpencodeOnFreePortAt(
  port: number,
): Promise<Awaited<ReturnType<typeof createOpencode>>> {
  return createOpencode({ port, config: {} as any });
}

/** Drive ONE prompt to completion via opencode's async transport (see the transport-model note above):
 *  subscribe to the `/event` bus, fire `promptAsync` (returns immediately), wait for `session.idle`,
 *  then fetch the finished assistant message. Returns that message's `info` (carries `structured`,
 *  `modelID`, `tokens`, `cost`, `error`). Rejects on `session.error`, on our own `timeoutMs` deadline
 *  (best-effort `session.abort` first, so the server-side run stops burning tokens), or if the event
 *  stream ends before idle. `client` is the opencode client — injectable, so this is unit-testable with
 *  a fake event stream (no live server). Exported for that reason. */
export async function driveToCompletion(
  client: any,
  sessionId: string,
  body: any,
  timeoutMs: number,
): Promise<any> {
  const ac = new AbortController();
  let assistantMsgId: string | undefined;
  let settle!: () => void;
  let fail!: (e: unknown) => void;
  const done = new Promise<void>((res, rej) => {
    settle = res;
    fail = rej;
  });

  const deadline = setTimeout(() => {
    // Stop the server-side run (best-effort) so a hung/slow spawn stops accruing cost, then reject.
    void client.session?.abort?.({ path: { id: sessionId } }).catch?.(() => {});
    fail(
      new Error(`opencode session ${sessionId} timed out after ${timeoutMs}ms`),
    );
  }, timeoutMs);

  // Inactivity watchdog: the hard `timeoutMs` above only bounds the WORST case — a stream that stalls
  // (server stops emitting `message.part.updated` / never sends `session.idle`) would otherwise sit
  // dead until that full deadline (observed: a plan draft stalled ~7 min against a 480s wall). This
  // arms a shorter timer that resets on every SSE event; if the stream goes silent for
  // `inactivityMs`, we abort the run and reject with a `stalled` error the spawn retries on a fresh
  // server. So a stochastic transport stall becomes a fast, self-healing failure, not a long dead wait.
  const inactivityMs = Number(process.env.OC_INACTIVITY_TIMEOUT_MS) || 90_000;
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  const armInactivity = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      void client.session
        ?.abort?.({ path: { id: sessionId } })
        .catch?.(() => {});
      fail(
        new Error(
          `opencode session ${sessionId} stalled: no stream activity for ${inactivityMs}ms`,
        ),
      );
    }, inactivityMs);
  };
  armInactivity();

  // Subscribe BEFORE prompting so we can't miss session.idle. `/event` is a GLOBAL bus — filter by
  // sessionID. createSseClient auto-reconnects on transient drops (Last-Event-ID), so a flaky SSE
  // connection resumes rather than failing the spawn; only our ac.abort() ends it.
  const sub = await client.event.subscribe({ signal: ac.signal });
  const pump = (async () => {
    try {
      for await (const ev of sub.stream as AsyncIterable<any>) {
        armInactivity(); // any event = the stream is live; reset the silence timer
        const type = ev?.type;
        const props = ev?.properties ?? {};
        const info = props.info;
        // Capture the assistant message id as it streams (avoids a post-idle list lookup).
        if (
          info?.role === "assistant" &&
          info?.sessionID === sessionId &&
          info?.id
        )
          assistantMsgId = info.id;
        const sid = props.sessionID ?? info?.sessionID;
        if (sid !== sessionId) continue;
        if (type === "session.error") {
          fail(
            new Error(
              `opencode session.error: ${JSON.stringify(props).slice(0, 300)}`,
            ),
          );
          return;
        }
        if (type === "session.idle") {
          settle();
          return;
        }
      }
      fail(new Error("opencode event stream ended before session.idle"));
    } catch (e) {
      fail(e);
    }
  })();

  try {
    await client.session.promptAsync({ path: { id: sessionId }, body });
    await done;
  } finally {
    clearTimeout(deadline);
    if (inactivityTimer) clearTimeout(inactivityTimer);
    ac.abort(); // end the SSE stream
    void pump.catch(() => {});
  }

  // Resolve the finished assistant message: prefer the id captured from the stream, else list + take
  // the last assistant message (covers the race where idle beats our message.updated capture).
  let mid = assistantMsgId;
  if (!mid) {
    const list = unwrap<any[]>(
      await client.session.messages({ path: { id: sessionId } }),
    );
    const assistants = (list ?? [])
      .map((m: any) => m?.info ?? m)
      .filter((i: any) => i?.role === "assistant");
    mid = assistants[assistants.length - 1]?.id;
  }
  if (!mid)
    throw new Error("opencode: no assistant message id after session.idle");
  const msg = unwrap<any>(
    await client.session.message({ path: { id: sessionId, messageID: mid } }),
  );
  return msg?.info ?? msg;
}

/** Generic structured spawn: one model-pinned opencode session that returns JSON matching `schema`,
 *  driven over the async transport (driveToCompletion). The single opencode transport used by every
 *  role skill; the per-role shape is the caller's schema. No retry ladder — startOpencodeOnFreePort
 *  handles server-startup races, the SSE bus auto-reconnects transient drops, and a real failure
 *  (session.error / timeout) fails fast and journaled rather than silently re-running an expensive spawn. */
/** A transport STALL (inactivity watchdog fired), a dropped connection, or a server-start race — all
 *  transient, all fixed by re-running the whole spawn on a FRESH server. A genuine model/schema failure
 *  does NOT match and propagates immediately (fail fast + journaled, never loop on a real error). */
const STALL_RE =
  /stalled|fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|Server exited|EADDRINUSE|other side closed|terminated/i;
async function withStallRetry<T>(
  fn: () => Promise<T>,
  attempts = 2,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (!STALL_RE.test(msg) || i === attempts) throw e;
      // transient stall/drop — loop and retry on a fresh server
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
    tools?: Record<string, boolean>;
  },
  schema: object,
): Promise<{
  data: any;
  modelReported: string | undefined;
  modelPinSatisfied: boolean;
  cost?: SpawnCost;
}> {
  return withStallRetry(() => promptStructuredImpl(spec, schema));
}

async function promptStructuredImpl(
  spec: {
    role: string;
    providerID: string;
    modelID: string;
    system: string;
    task: string;
    round: number;
    timeoutMs?: number;
    tools?: Record<string, boolean>;
  },
  schema: object,
): Promise<{
  data: any;
  modelReported: string | undefined;
  modelPinSatisfied: boolean;
  cost?: SpawnCost;
}> {
  // `tools: { task: false }` disables the subagent-spawn tool for judgment spawns. SSE-traced: the
  // planner recon spent ~90s of a 146s run inside two serial `task` subagents (each its own slow agentic
  // loop) — pure latency the planner doesn't need (direct batched grep/glob/read is faster). Harmless for
  // the reviewer/triager, which don't spawn subagents anyway. Combined with the batch directive in the
  // planner prompt, this is the "explore in parallel like Claude Code" fix (no index, no accuracy loss).
  // A caller may pass its own `spec.tools` to gate further — the reviewer passes NO_EXPLORE_TOOLS so a
  // structured-output spawn can't enter the format+tools serial-tool death-spiral (see NO_EXPLORE_TOOLS).
  const oc = await startOpencodeOnFreePort({
    permission: JUDGMENT_PERMISSION,
    tools: spec.tools ?? { task: false },
  });
  const timeoutMs = spec.timeoutMs ?? JUDGMENT_TIMEOUT_MS;
  try {
    const session = unwrap<any>(
      await oc.client.session.create({
        body: { title: `${spec.role} r${spec.round}` },
      }),
    );
    const sessionId = session.id ?? session.sessionID;
    if (!sessionId) throw new Error("opencode: session.create returned no id");

    // `format` (structured output) is in the runtime API + docs but missing from this SDK version's
    // published body type, so the body is cast. Proven live (spike-reviewer + probe-async-prompt).
    const info = await driveToCompletion(
      oc.client,
      sessionId,
      {
        model: { providerID: spec.providerID, modelID: spec.modelID },
        system: spec.system,
        parts: [{ type: "text", text: spec.task }],
        format: { type: "json_schema", schema },
      },
      timeoutMs,
    );

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
  } finally {
    await oc.server?.close?.();
  }
}

/** Sum two best-effort SpawnCosts (either may be undefined) into one, so a two-turn spawn reports the
 *  combined cost/tokens. Returns undefined only if BOTH are unknown. */
function sumCost(a?: SpawnCost, b?: SpawnCost): SpawnCost | undefined {
  if (!a) return b;
  if (!b) return a;
  const add = (x?: number, y?: number) =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
  return {
    usdEst: add(a.usdEst, b.usdEst),
    inputTokens: add(a.inputTokens, b.inputTokens),
    outputTokens: add(a.outputTokens, b.outputTokens),
  };
}

/**
 * Two-turn spawn: AGENTIC exploration, THEN structured emit — same session, same model.
 *
 * WHY (measured 2026-07-17, care_fe formatPatientAge recon, opus & sonnet on Copilot): running an
 * exploratory tool-heavy turn UNDER a `format: json_schema` constraint collapses the agentic loop into
 * strictly serial single-tool turns that don't converge — 126 turns / 358s / killed with no output.
 * The IDENTICAL recon with NO `format` runs a normal agentic loop (batches 2 tools/turn) and converges
 * in 7 turns / ~26–61s with richer findings. Structured output and the agentic tool loop fight each
 * other; normal opencode never explores under `format`. So: Turn A explores with NO format (converges
 * like normal opencode), Turn B — same warm session — re-states the result as schema-valid JSON with
 * `format` set and nothing left to explore. (Validated as the "agentic turn then structured turn"
 * pattern by the 2026-07-14 skill-composition probe.)
 *
 * Turn A `reconSystem`/`task` do the exploration; Turn B `emitSystem`/`emitInstruction` do the emit.
 * Cost is summed across both turns. Same permission/tools as promptStructured (read-only, no subagent).
 */
export async function promptAgenticThenStructured(
  spec: {
    role: string;
    providerID: string;
    modelID: string;
    reconSystem: string; // Turn A — agentic exploration prompt (no format)
    task: string; // Turn A — user message
    emitSystem: string; // Turn B — "emit as JSON, don't explore further"
    emitInstruction: string; // Turn B — user message
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
  return withStallRetry(() => promptAgenticThenStructuredImpl(spec, schema));
}

async function promptAgenticThenStructuredImpl(
  spec: {
    role: string;
    providerID: string;
    modelID: string;
    reconSystem: string; // Turn A — agentic exploration prompt (no format)
    task: string; // Turn A — user message
    emitSystem: string; // Turn B — "emit as JSON, don't explore further"
    emitInstruction: string; // Turn B — user message
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
  const oc = await startOpencodeOnFreePort({
    permission: JUDGMENT_PERMISSION,
    tools: { task: false },
  });
  const timeoutMs = spec.timeoutMs ?? JUDGMENT_TIMEOUT_MS;
  try {
    const session = unwrap<any>(
      await oc.client.session.create({
        body: { title: `${spec.role} r${spec.round}` },
      }),
    );
    const sessionId = session.id ?? session.sessionID;
    if (!sessionId) throw new Error("opencode: session.create returned no id");

    // Turn A — AGENTIC recon, NO `format`. This is the whole fix: let the tool loop run unconstrained.
    const reconInfo = await driveToCompletion(
      oc.client,
      sessionId,
      {
        model: { providerID: spec.providerID, modelID: spec.modelID },
        system: spec.reconSystem,
        parts: [{ type: "text", text: spec.task }],
      },
      timeoutMs,
    );
    if (reconInfo?.error?.name) {
      throw new Error(
        `opencode recon turn error: ${reconInfo.error.name}: ${reconInfo.error.message ?? "unknown"}`,
      );
    }
    const reconCost = extractCost(reconInfo);

    // Turn B — SAME warm session, WITH `format`. No exploration left: it serialises Turn A's findings.
    const emitInfo = await driveToCompletion(
      oc.client,
      sessionId,
      {
        model: { providerID: spec.providerID, modelID: spec.modelID },
        system: spec.emitSystem,
        parts: [{ type: "text", text: spec.emitInstruction }],
        format: { type: "json_schema", schema },
      },
      timeoutMs,
    );
    if (emitInfo?.error?.name === "StructuredOutputError") {
      throw new Error(
        `opencode StructuredOutputError after retries: ${emitInfo.error.message ?? "unknown"}`,
      );
    }
    const structured = emitInfo?.structured ?? emitInfo?.structured_output;
    if (structured == null) {
      throw new Error(
        `opencode returned no structured output on emit turn. info keys: ${Object.keys(emitInfo ?? {}).join(", ")}`,
      );
    }
    const modelReported: string | undefined =
      emitInfo?.modelID ?? emitInfo?.model?.modelID ?? emitInfo?.providerModel;
    const modelPinSatisfied = modelReported
      ? modelReported.includes(spec.modelID)
      : true;
    return {
      data: structured,
      modelReported,
      modelPinSatisfied,
      cost: sumCost(reconCost, extractCost(emitInfo)),
    };
  } finally {
    await oc.server?.close?.();
  }
}

/**
 * The END-OF-RUN DOCTOR spawn (auto-doctor.ts): a two-turn, EDIT-ENABLED agentic run. Turn A explores
 * the run dir and EDITS skill/diagnosis/fixture files in place (DOCTOR_PERMISSION, no `format`); Turn B
 * — same warm session — emits the structured `DoctorOutput` manifest that the deterministic scaffold
 * acts on. Mirrors `promptAgenticThenStructured`, but with edit allowed and `task: false` kept (the
 * doctor explores directly; no subagents). The scaffold owns git/gh/tests/evals — this only edits +
 * reports. Not covered by unit tests (it needs a live opencode server + a real run dir); it is exercised
 * by the Phase-3 `--doctor-dry` live smoke.
 */
export async function driveDoctorSpawn(
  spec: {
    providerID: string;
    modelID: string;
    editSystem: string; // Turn A — the inlined doctor SKILL (autonomous-mode) + the run dir path
    editInstruction: string; // Turn A — "diagnose this run and apply the covered-skill edits"
    emitSystem: string; // Turn B — "now emit the DoctorOutput manifest as JSON"
    emitInstruction: string;
    timeoutMs?: number;
  },
  schema: object,
): Promise<{ data: any; modelReported: string | undefined; cost?: SpawnCost }> {
  const oc = await startOpencodeOnFreePort({
    permission: DOCTOR_PERMISSION,
    tools: { task: false },
  });
  const timeoutMs = spec.timeoutMs ?? JUDGMENT_TIMEOUT_MS;
  try {
    const session = unwrap<any>(
      await oc.client.session.create({ body: { title: "auto-doctor" } }),
    );
    const sessionId = session.id ?? session.sessionID;
    if (!sessionId) throw new Error("opencode: session.create returned no id");

    // Turn A — agentic + EDIT. The model reads the run dir and writes its file changes here.
    const editInfo = await driveToCompletion(
      oc.client,
      sessionId,
      {
        model: { providerID: spec.providerID, modelID: spec.modelID },
        system: spec.editSystem,
        parts: [{ type: "text", text: spec.editInstruction }],
      },
      timeoutMs,
    );
    if (editInfo?.error?.name) {
      throw new Error(
        `opencode doctor edit turn error: ${editInfo.error.name}: ${editInfo.error.message ?? "unknown"}`,
      );
    }
    const editCost = extractCost(editInfo);

    // Turn B — SAME session, structured emit of the manifest describing what it just did.
    const emitInfo = await driveToCompletion(
      oc.client,
      sessionId,
      {
        model: { providerID: spec.providerID, modelID: spec.modelID },
        system: spec.emitSystem,
        parts: [{ type: "text", text: spec.emitInstruction }],
        format: { type: "json_schema", schema },
      },
      timeoutMs,
    );
    if (emitInfo?.error?.name === "StructuredOutputError") {
      throw new Error(
        `opencode StructuredOutputError after retries: ${emitInfo.error.message ?? "unknown"}`,
      );
    }
    const structured = emitInfo?.structured ?? emitInfo?.structured_output;
    if (structured == null) {
      throw new Error(
        `opencode returned no structured output on doctor emit turn. info keys: ${Object.keys(emitInfo ?? {}).join(", ")}`,
      );
    }
    const modelReported: string | undefined =
      emitInfo?.modelID ?? emitInfo?.model?.modelID ?? emitInfo?.providerModel;
    return {
      data: structured,
      modelReported,
      cost: sumCost(editCost, extractCost(emitInfo)),
    };
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

// ── forkedFanOut — run-scoped warm fan-out (PLAN-forked-fanout.md) ────────────────────────────────
// N independent structured judgments over ONE large shared context, fired within the prompt-cache
// TTL: warm a base session with `base.system` (+ optional big `base.context`) ONCE → `cacheWrite`;
// `session.fork` per map task so each inherits that warm prefix (`cacheRead`, verified live 2026-07-15)
// and stays isolated from sibling forks; optional reduce off the same base. One server per call (one
// port, killable-on-hang deadline), so no persistent-pool / Tier-A prerequisite. Consumers: the
// triager (per file-cluster) and — later — the care-review lenses. `map.model` is what the prefix is
// warmed under, so map forks read the cache; a `reduce.model` that differs runs cold vs the base
// prefix (fine — reduce reads no code).

export interface FanOutTask {
  id: string;
  prompt: string; // the ONLY per-fork-unique text; the shared prefix lives in base.system/context
}
export interface FanOutCache {
  read?: number;
  write?: number;
}
export interface FanOutMapResult {
  id: string;
  data: any; // null when error is set (the fork failed after retries)
  error?: string; // degrade-and-flag (PLAN-forked-fanout.md §6): one bad fork never aborts the run
  modelReported?: string;
  cost?: SpawnCost;
  cache: FanOutCache;
  ms: number; // wall time of this fork (fork + prompt), for the parallel-vs-serial check
}
export interface ForkedFanOutSpec {
  provider: string; // e.g. "github-copilot"
  base: { system: string; context?: string };
  map: {
    model: string;
    schema: object;
    tasks: FanOutTask[];
    forkTimeoutMs?: number;
  };
  reduce?: {
    model: string;
    schema: object;
    prompt: (results: FanOutMapResult[]) => string;
    timeoutMs?: number; // hard cap for the reduce spawn (default 90_000); the reduce runs cold vs the
    // warm base prefix when reduce.model differs from map.model, so a large diff + judgment-tier model
    // can legitimately exceed 90s — give it headroom rather than degrade-and-flatten.
  };
  concurrency?: number; // fork cap (default 5)
  timeoutMs?: number; // run-scoped wall-clock deadline
}
export interface ForkedFanOutResult {
  map: FanOutMapResult[];
  reduce?: { data: any; cost?: SpawnCost; cache: FanOutCache };
  baseCache: FanOutCache;
  baseMs: number; // warm-up duration (serial, before the fan-out) — separates warm cost from map parallelism
}

function cacheTokens(res: any): FanOutCache {
  const info = res?.info ?? res;
  const c = info?.tokens?.cache ?? {};
  return {
    read: typeof c.read === "number" ? c.read : undefined,
    write: typeof c.write === "number" ? c.write : undefined,
  };
}

/** Fork the warm base and run one map task over the async transport (driveToCompletion). Single
 *  attempt: on ANY failure it degrades-and-flags (returns { data: null, error }) so one bad fork never
 *  aborts the fan-out. No retry — the SSE bus auto-reconnects transient drops, and a real fork failure
 *  is terminal for this fork only, not the run. */
async function fanOutMapOne(
  oc: Awaited<ReturnType<typeof createOpencode>>,
  baseId: string,
  system: string,
  spec: ForkedFanOutSpec,
  task: FanOutTask,
): Promise<FanOutMapResult> {
  const forkTimeoutMs = spec.map.forkTimeoutMs ?? 45_000;
  const started = Date.now();
  try {
    const fk = unwrap<any>(
      await oc.client.session.fork({ path: { id: baseId } } as any),
    );
    const forkId = fk.id ?? fk.sessionID;
    if (!forkId) throw new Error("session.fork returned no id");
    const info = await driveToCompletion(
      oc.client,
      forkId,
      {
        model: { providerID: spec.provider, modelID: spec.map.model },
        system,
        parts: [{ type: "text", text: task.prompt }],
        format: { type: "json_schema", schema: spec.map.schema },
      },
      forkTimeoutMs,
    );
    const structured = info?.structured ?? info?.structured_output;
    if (structured == null) throw new Error("no structured output");
    return {
      id: task.id,
      data: structured,
      modelReported:
        info?.modelID ?? info?.model?.modelID ?? info?.providerModel,
      cost: extractCost(info),
      cache: cacheTokens(info),
      ms: Date.now() - started,
    };
  } catch (e) {
    return {
      id: task.id,
      data: null,
      error: String((e as Error)?.message ?? e).slice(0, 160),
      cache: {},
      ms: Date.now() - started,
    };
  }
}

export async function forkedFanOut(
  spec: ForkedFanOutSpec,
): Promise<ForkedFanOutResult> {
  const concurrency = Math.max(1, spec.concurrency ?? 5);
  const timeoutMs = spec.timeoutMs ?? JUDGMENT_TIMEOUT_MS;
  // The shared prefix MUST be byte-identical across the base warm-up and every fork prompt — that
  // identity is what earns the cacheRead. The big context rides in `system` (verified path).
  const system = spec.base.context
    ? `${spec.base.system}\n\n=== SHARED CONTEXT (read-only) ===\n${spec.base.context}\n=== END SHARED CONTEXT ===`
    : spec.base.system;

  // Start the shared server with a bounded timeout — `createOpencode` spawns an opencode subprocess
  // and waits for it to be ready; if the subprocess hangs at startup (observed: 15-min stall when
  // called right after a large parallel fan-out exhausted Copilot connections), this blocks forever.
  // 30s is generous — normal startup is 1-2s.
  const startServer = () =>
    Promise.race([
      startOpencodeOnFreePort({
        permission: JUDGMENT_PERMISSION,
        tools: { task: false },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("opencode server startup timed out")),
          30_000,
        ),
      ),
    ]);
  const oc = await startServer();
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    void oc.server?.close?.();
  }, timeoutMs);
  try {
    // 1. Warm the base under the MAP model (the model the forks read the cache with). Serial — the
    //    cacheWrite must land before the forks fan out, or a fork storm races it and misses. Single
    //    attempt: the base is load-bearing, so a failure here aborts the fan-out (fails fast, journaled)
    //    — the old server-replacement retry existed to recover from a hung blocking session.prompt,
    //    which the async transport no longer produces.
    const baseStart = Date.now();
    const base = unwrap<any>(
      await oc.client.session.create({ body: { title: "fanout-base" } }),
    );
    const baseId = base.id ?? base.sessionID;
    if (!baseId) throw new Error("opencode: session.create returned no id");
    const warm = await driveToCompletion(
      oc.client,
      baseId,
      {
        model: { providerID: spec.provider, modelID: spec.map.model },
        system,
        parts: [
          {
            type: "text",
            text: "Acknowledge the shared context above with the single word READY.",
          },
        ],
      },
      90_000,
    );
    const baseCache: FanOutCache = cacheTokens(warm);
    const baseMs = Date.now() - baseStart;
    console.log(
      `[forkedFanOut] base warm-up: ${baseMs}ms, cache=${JSON.stringify(baseCache)}`,
    );

    // 2. Map — task[0] runs as a serial "prime" fork, then the rest fan out in parallel. The prime
    //    serves a dual purpose: it does useful work (verifies its cluster) AND gives the prompt cache
    //    ~5-6s to propagate after the base warm-up. Without this delay, ~50% of concurrent forks miss
    //    the cache (measured 2026-07-16: skip-prime run had 2/4 forks at read=0). With the prime,
    //    all parallel forks consistently get cacheRead. The prime itself always misses (read=0) —
    //    its value is the propagation window it creates, not its own cache hit.
    const tasks = spec.map.tasks;
    const results: FanOutMapResult[] = new Array(tasks.length);
    const mapStart = Date.now();
    // Pick the shortest prompt as the prime — it completes fastest, giving the cache the same
    // propagation window with minimal serial wait.
    const primeIdx = tasks.reduce(
      (best, t, i) => (t.prompt.length < tasks[best].prompt.length ? i : best),
      0,
    );
    if (tasks.length > 0) {
      results[primeIdx] = await fanOutMapOne(
        oc,
        baseId,
        system,
        spec,
        tasks[primeIdx],
      );
      console.log(
        `[forkedFanOut] prime fork ${tasks[primeIdx].id}: ${results[primeIdx].ms}ms, cache=${JSON.stringify(results[primeIdx].cache)}${results[primeIdx].error ? `, ERR: ${results[primeIdx].error}` : ""}`,
      );
    }
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = cursor++;
        if (i >= tasks.length) return;
        if (i === primeIdx) continue;
        results[i] = await fanOutMapOne(oc, baseId, system, spec, tasks[i]);
        console.log(
          `[forkedFanOut] map fork ${tasks[i].id}: ${results[i].ms}ms, cache=${JSON.stringify(results[i].cache)}${results[i].error ? `, ERR: ${results[i].error}` : ""}`,
        );
      }
    };
    if (tasks.length > 1)
      await Promise.all(
        Array.from({ length: Math.min(concurrency, tasks.length - 1) }, worker),
      );
    console.log(
      `[forkedFanOut] map phase: ${Date.now() - mapStart}ms (${tasks.length} forks, 1 prime + ${tasks.length - 1} parallel)`,
    );

    // 3. Reduce — one fork off the warm base over the map outputs.
    //    Degrade-and-flag on failure (same pattern as map forks): a failed reduce returns
    //    reduce=undefined so the consumer can fall back to flattening map results. Without
    //    this, a transient Copilot failure after a successful map phase kills the entire run.
    let reduce: ForkedFanOutResult["reduce"];
    if (spec.reduce) {
      const reduceStart = Date.now();
      try {
        const rfk = unwrap<any>(
          await oc.client.session.fork({ path: { id: baseId } } as any),
        );
        const rid = rfk.id ?? rfk.sessionID;
        if (!rid) throw new Error("reduce fork returned no id");
        const rinfo = await driveToCompletion(
          oc.client,
          rid,
          {
            model: { providerID: spec.provider, modelID: spec.reduce.model },
            system,
            parts: [{ type: "text", text: spec.reduce.prompt(results) }],
            format: { type: "json_schema", schema: spec.reduce.schema },
          },
          spec.reduce.timeoutMs ?? 90_000,
        );
        reduce = {
          data: rinfo?.structured ?? rinfo?.structured_output,
          cost: extractCost(rinfo),
          cache: cacheTokens(rinfo),
        };
      } catch (e) {
        // Degrade-and-flag: a failed reduce leaves reduce=undefined so the consumer flattens the map
        // results, rather than a late Copilot failure killing an otherwise-successful run.
        console.log(
          `[forkedFanOut] reduce failed, degrading: ${(e as Error).message?.slice(0, 80)}`,
        );
      }
      if (reduce) {
        console.log(
          `[forkedFanOut] reduce: ${Date.now() - reduceStart}ms, cache=${JSON.stringify(reduce.cache)}`,
        );
      } else {
        console.log(
          `[forkedFanOut] reduce DEGRADED after ${Date.now() - reduceStart}ms — consumer will flatten map results`,
        );
      }
    }
    console.log(`[forkedFanOut] total: ${Date.now() - baseStart}ms`);
    return { map: results, reduce, baseCache, baseMs };
  } catch (e) {
    if (timedOut)
      throw new Error(
        `forkedFanOut timed out after ${timeoutMs}ms (embedded server killed)`,
      );
    throw e;
  } finally {
    clearTimeout(deadline);
    await oc.server?.close?.();
  }
}
