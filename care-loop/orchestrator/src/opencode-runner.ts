// opencode runner — the §4 worker boundary, minimal seed (Phase-2 spike).
//
// One judgment spawn = one opencode session, model-pinned, returning a schema-validated JobResult
// via opencode's native structured output. This is the first real brick of runner.ts: prove that
// opencode + GitHub Copilot drives a pinned judgment role headlessly and hands back a typed result.
//
// Deliberately thin: no FSM, no journal, no retry ladder yet (those are later phases). It only
// stands up the transport + the schema boundary + the model-pin cross-check (IMP-1, belt+suspenders).

import { createOpencode as sdkCreateOpencode } from "@opencode-ai/sdk";
import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import {
  JOBRESULT_SCHEMA,
  validateJobResult,
  type JobResult,
} from "./jobresult.js";

// Test seam, in the `setActiveRunStore` idiom: every server this module starts goes through
// `createOpencode`, so a test can swap in an in-process fake and record exactly what each role sends.
type CreateOpencode = typeof sdkCreateOpencode;
let launchOpencode: CreateOpencode = sdkCreateOpencode;
const createOpencode: CreateOpencode = (...args) => launchOpencode(...args);
export function setOpencodeLauncher(fn?: CreateOpencode): void {
  launchOpencode = fn ?? sdkCreateOpencode;
}

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
  // opencode's default is "ask": three identical tool calls in one step raise a prompt no one can answer,
  // and the session sits silent until the watchdog kills it (probed 2026-09-11). "deny" fails the whole
  // session instead. Our deadline and inactivity watchdog already bound a runaway loop.
  doom_loop: "allow",
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
  doom_loop: "allow", // see JUDGMENT_PERMISSION
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

// Test seam: lets a recording fake note each drive's deadline — per-role timeouts are tuned from
// incidents, so they are part of what the characterization test pins.
type DriveObserver = (e: { sessionId: string; timeoutMs: number }) => void;
let driveObserver: DriveObserver | undefined;
export function setDriveObserver(fn?: DriveObserver): void {
  driveObserver = fn;
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
  driveObserver?.({ sessionId, timeoutMs });
  const ac = new AbortController();
  let assistantMsgId: string | undefined;
  let settle!: () => void;
  let fail!: (e: unknown) => void;
  const done = new Promise<void>((res, rej) => {
    settle = res;
    fail = rej;
  });
  // `done` can be rejected before anything awaits it: by a timer while promptAsync is still in flight,
  // or by the pump once a failed promptAsync has aborted the stream. Node treats that as an unhandled
  // rejection and exits the process, so mark it handled here; `await done` below still sees the failure.
  done.catch(() => {});

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
    const sent = await client.session.promptAsync({
      path: { id: sessionId },
      body,
    });
    // The SDK returns an HTTP failure as `{ error, response }` rather than throwing. Unchecked, a refused
    // prompt never runs, nothing goes idle, and the refusal surfaced 90s later as a "stalled" error.
    if (sent?.error) {
      throw new Error(
        `opencode promptAsync failed (HTTP ${sent.response?.status ?? "?"}): ${JSON.stringify(sent.error).slice(0, 300)}`,
      );
    }
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

/** A transport STALL (inactivity watchdog fired), a dropped connection, a server-start race, or a 5xx
 *  from promptAsync — all transient, all fixed by re-running the whole spawn on a FRESH server. A genuine
 *  model/schema failure, or a 4xx (the same request would be refused again), does NOT match and
 *  propagates immediately (fail fast + journaled, never loop on a real error). */
const STALL_RE =
  /stalled|fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|Server exited|EADDRINUSE|other side closed|terminated|HTTP 5\d\d/i;
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

/** What a structured spawn returns: the schema-valid output, the engine opencode reports having run
 *  (for the model-pin cross-check), and the best-effort cost summed over the session's turns. */
export interface StructuredResult {
  data: any;
  modelReported: string | undefined;
  modelPinSatisfied: boolean;
  cost?: SpawnCost;
}

/** One turn of a structured session; `label` names it in error messages. */
interface Turn {
  system: string;
  parts: unknown[];
  label?: string;
}

/**
 * The session every structured spawn runs: a fresh server, one model-pinned session, an optional
 * agentic `explore` turn with NO `format`, then the `emit` turn WITH `format` — same session, same
 * model (why two turns: promptAgenticThenStructured). Driven over the async transport
 * (driveToCompletion). No retry ladder: startOpencodeOnFreePort handles server-startup races, the SSE
 * bus auto-reconnects transient drops, and a real failure (session.error / timeout / no structured
 * output) fails fast and journaled. Whether a transport stall is retried is the caller's call.
 */
async function runStructuredSession(
  s: {
    permission: object;
    tools: Record<string, boolean>;
    title: string;
    providerID: string;
    modelID: string;
    timeoutMs?: number;
    explore?: Turn;
    emit: Turn;
  },
  schema: object,
): Promise<StructuredResult> {
  const oc = await startOpencodeOnFreePort({
    permission: s.permission,
    tools: s.tools,
  });
  const timeoutMs = s.timeoutMs ?? JUDGMENT_TIMEOUT_MS;
  const model = { providerID: s.providerID, modelID: s.modelID };
  try {
    const session = unwrap<any>(
      await oc.client.session.create({ body: { title: s.title } }),
    );
    const sessionId = session.id ?? session.sessionID;
    if (!sessionId) throw new Error("opencode: session.create returned no id");

    let exploreCost: SpawnCost | undefined;
    if (s.explore) {
      const info = await driveToCompletion(
        oc.client,
        sessionId,
        { model, system: s.explore.system, parts: s.explore.parts },
        timeoutMs,
      );
      if (info?.error?.name) {
        throw new Error(
          `opencode ${s.explore.label} turn error: ${info.error.name}: ${info.error.message ?? "unknown"}`,
        );
      }
      exploreCost = extractCost(info);
    }

    // `format` (structured output) is in the runtime API + docs but missing from this SDK version's
    // published body type, so the body is cast. Proven live (spike-reviewer + probe-async-prompt).
    const info = await driveToCompletion(
      oc.client,
      sessionId,
      {
        model,
        system: s.emit.system,
        parts: s.emit.parts,
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
      const turn = s.emit.label ? ` on ${s.emit.label} turn` : "";
      throw new Error(
        `opencode returned no structured output${turn}. info keys: ${Object.keys(info ?? {}).join(", ")}`,
      );
    }
    const modelReported: string | undefined =
      info?.modelID ?? info?.model?.modelID ?? info?.providerModel;
    return {
      data: structured,
      modelReported,
      modelPinSatisfied: modelReported
        ? modelReported.includes(s.modelID)
        : true,
      cost: sumCost(exploreCost, extractCost(info)),
    };
  } finally {
    await oc.server?.close?.();
  }
}

/** One-turn structured spawn: a model-pinned session whose single turn returns JSON matching `schema`.
 *  Suited to a role that reasons from inline inputs; one that must explore first uses
 *  promptAgenticThenStructured. A transport stall is retried once on a fresh server. */
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
): Promise<StructuredResult> {
  // `tools: { task: false }` disables the subagent-spawn tool for judgment spawns. SSE-traced: the
  // planner recon spent ~90s of a 146s run inside two serial `task` subagents (each its own slow agentic
  // loop) — pure latency the planner doesn't need (direct batched grep/glob/read is faster). Harmless for
  // the reviewer/triager, which don't spawn subagents anyway. Combined with the batch directive in the
  // planner prompt, this is the "explore in parallel like Claude Code" fix (no index, no accuracy loss).
  // A caller may pass its own `spec.tools` to gate further — the reviewer passes NO_EXPLORE_TOOLS so a
  // structured-output spawn can't enter the format+tools serial-tool death-spiral (see NO_EXPLORE_TOOLS).
  return withStallRetry(() =>
    runStructuredSession(
      {
        permission: JUDGMENT_PERMISSION,
        tools: spec.tools ?? { task: false },
        title: `${spec.role} r${spec.round}`,
        providerID: spec.providerID,
        modelID: spec.modelID,
        timeoutMs: spec.timeoutMs,
        emit: {
          system: spec.system,
          parts: [{ type: "text", text: spec.task }],
        },
      },
      schema,
    ),
  );
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
/** One image/file attachment to send alongside the recon task text (PLAN-jira-ticket-fetch.md §3.5). */
export interface PromptAttachment {
  path: string;
  mime: string;
  filename?: string;
}

/** Expand attachment specs into opencode `file` parts (base64 `data:` URI in `url` —
 *  FilePartInput shape, probed to reach the model on Copilot). A read failure on one attachment is
 *  skipped-and-logged rather than fatal — a missing image must not abort the recon. */
function fileParts(
  attachments: PromptAttachment[] | undefined,
): Array<{ type: "file"; mime: string; filename?: string; url: string }> {
  if (!attachments?.length) return [];
  const parts: Array<{
    type: "file";
    mime: string;
    filename?: string;
    url: string;
  }> = [];
  for (const a of attachments) {
    try {
      const b64 = readFileSync(a.path).toString("base64");
      parts.push({
        type: "file",
        mime: a.mime,
        filename: a.filename,
        url: `data:${a.mime};base64,${b64}`,
      });
    } catch (e) {
      console.warn(
        `[promptAgenticThenStructured] skipping unreadable attachment ${a.path}: ${(e as Error).message}`,
      );
    }
  }
  return parts;
}

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
    attachments?: PromptAttachment[]; // images sent as file parts on Turn A (recon)
    tools?: Record<string, boolean>; // default { task: false }; NO_EXPLORE_TOOLS when every input is inline
  },
  schema: object,
): Promise<StructuredResult> {
  return withStallRetry(() =>
    runStructuredSession(
      {
        permission: JUDGMENT_PERMISSION,
        tools: spec.tools ?? { task: false },
        title: `${spec.role} r${spec.round}`,
        providerID: spec.providerID,
        modelID: spec.modelID,
        timeoutMs: spec.timeoutMs,
        // Turn A — AGENTIC recon, NO `format`. This is the whole fix: let the tool loop run unconstrained.
        // Any ticket images ride here as `file` parts (probed to reach the model on Copilot) so recon forms
        // its understanding WITH the mockups/screenshots. Empty attachments ⇒ byte-identical text-only path.
        explore: {
          label: "recon",
          system: spec.reconSystem,
          parts: [
            { type: "text", text: spec.task },
            ...fileParts(spec.attachments),
          ],
        },
        // Turn B — SAME warm session, WITH `format`. No exploration left: it serialises Turn A's findings.
        emit: {
          label: "emit",
          system: spec.emitSystem,
          parts: [{ type: "text", text: spec.emitInstruction }],
        },
      },
      schema,
    ),
  );
}

/**
 * The END-OF-RUN DOCTOR spawn (auto-doctor.ts): a two-turn, EDIT-ENABLED agentic run. Turn A explores
 * the run dir and EDITS skill/diagnosis/fixture files in place (DOCTOR_PERMISSION, no `format`); Turn B
 * — same warm session — emits the structured `DoctorOutput` manifest that the deterministic scaffold
 * acts on. Mirrors `promptAgenticThenStructured`, but with edit allowed and `task: false` kept (the
 * doctor explores directly; no subagents). The scaffold owns git/gh/tests/evals — this only edits +
 * reports. Its call contract and failure paths are pinned by the characterization test (against a fake
 * server); the model's behaviour is exercised by the Phase-3 `--doctor-dry` live smoke.
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
  // Not wrapped in withStallRetry: Turn A edits files in place, and a retry would re-run it over a
  // partially edited tree.
  const { data, modelReported, cost } = await runStructuredSession(
    {
      permission: DOCTOR_PERMISSION,
      tools: { task: false },
      title: "auto-doctor",
      providerID: spec.providerID,
      modelID: spec.modelID,
      timeoutMs: spec.timeoutMs,
      // Turn A — agentic + EDIT. The model reads the run dir and writes its file changes here.
      explore: {
        label: "doctor edit",
        system: spec.editSystem,
        parts: [{ type: "text", text: spec.editInstruction }],
      },
      // Turn B — SAME session, structured emit of the manifest describing what it just did.
      emit: {
        label: "doctor emit",
        system: spec.emitSystem,
        parts: [{ type: "text", text: spec.emitInstruction }],
      },
    },
    schema,
  );
  return { data, modelReported, cost };
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
