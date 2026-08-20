// gate-terminal.test.ts — the readline gate's behaviour when nobody is at the keyboard.
//
// The happy path is a human typing, which the pipeline tests already drive through injected gates.
// What was untested, and broken, is the case the CLI explicitly advertises: a non-interactive run.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Readable, Writable } from "node:stream";
import { GateInputClosedError, terminalGate } from "../src/gate-terminal.ts";
import { salvageGate, terminalGateIo } from "../src/salvage-gate-terminal.ts";
import type { ConsolidatedAsk } from "../src/plan-gate.ts";

function sink(): { out: Writable; text: () => string } {
  const chunks: string[] = [];
  return {
    out: new Writable({
      write(c, _e, cb) {
        chunks.push(String(c));
        cb();
      },
    }),
    text: () => chunks.join(""),
  };
}

const ASK: ConsolidatedAsk = {
  summary: "do the thing",
  classification: "trivial",
  criteria: ["it works"],
  testPlan: "skip — trivial change",
  pushAuthNote: "Approval authorizes the loop to push.",
  plannedBy: "test",
};

/** Fail the test rather than hang it: a regression here is an infinite wait, which reads as a stuck
 *  suite rather than a failure unless it is raced against something. */
function within<T>(ms: number, p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_r, reject) =>
      setTimeout(() => reject(new Error(`still waiting after ${ms}ms — the gate hung`)), ms).unref(),
    ),
  ]);
}

test("the plan gate FAILS on a closed stdin instead of hanging on it", async () => {
  const { out, text } = sink();
  // An already-ended stream is what `stdio: "ignore"` gives a spawned child, and what a piped
  // invocation gives once its input is consumed.
  const gate = terminalGate({ input: Readable.from([]), output: out });

  // `rl.question` on an ended stream never resolves — not EOF, not "", just a promise that sits
  // there. The child printed the approval prompt and stopped, alive and idle, with no error.
  await assert.rejects(
    () => within(2000, gate.approve(ASK)),
    GateInputClosedError,
    "must be a diagnosable failure, not a silent wait",
  );
  assert.match(text(), /Approve this plan\?/, "the prompt is still shown before it gives up");
});

test("the interview fails the same way, at the first question", async () => {
  const { out } = sink();
  const gate = terminalGate({ input: Readable.from([]), output: out });
  await assert.rejects(
    () => within(2000, gate.interview([{ id: "q1", prompt: "which?" }])),
    GateInputClosedError,
  );
});

test("the failure names the two ways a run CAN be approved", async () => {
  const { out } = sink();
  const gate = terminalGate({ input: Readable.from([]), output: out });
  const err = await within(2000, gate.approve(ASK).then(
    () => null,
    (e: Error) => e,
  ));
  assert.ok(err instanceof GateInputClosedError);
  assert.match(err.message, /terminal/);
  assert.match(err.message, /care-loopd serve/);
});

test("the salvage gate carries the same guard — one fix, both dialogs", async () => {
  const { out } = sink();
  const io = terminalGateIo({ input: Readable.from([]), output: out });
  await assert.rejects(
    () =>
      within(
        2000,
        salvageGate(io)({
          pr: 7,
          title: "[ENG-1] a thing",
          intent: "a thing",
          description: "a thing",
          divergence: { risk: false, note: "aligned" },
          draftCriteria: ["it works"],
          reconstructedBy: "test",
        }),
      ),
    GateInputClosedError,
  );
});

test("a gate with real input still reads answers", async () => {
  const { out } = sink();
  const gate = terminalGate({ input: Readable.from(["a\n"]), output: out });
  assert.deepEqual(await within(2000, gate.approve(ASK)), { decision: "approve" });
});

test("amend collects the free text the planner folds into a re-draft", async () => {
  const { out } = sink();
  // A PassThrough that is never ended — which is what a terminal is. `Readable.from([...])` ends
  // after its last line, closing readline before the second question can be asked; that is a real
  // case too (`echo "m" | care-loopd`) and it now errors clearly rather than throwing a node internal.
  const input = new PassThrough();
  input.write("m\n");
  setTimeout(() => input.write("use a modal instead\n"), 10);
  const gate = terminalGate({ input, output: out });
  assert.deepEqual(await within(2000, gate.approve(ASK)), {
    decision: "amend",
    amendment: "use a modal instead",
  });
});

test("a piped stdin that runs out mid-dialog errors clearly, not with a node internal", async () => {
  const { out } = sink();
  // `echo "m" | care-loopd` — one answer, then EOF, with the gate still needing the amendment text.
  const gate = terminalGate({ input: Readable.from(["m\n"]), output: out });
  await assert.rejects(() => within(2000, gate.approve(ASK)), GateInputClosedError);
});
