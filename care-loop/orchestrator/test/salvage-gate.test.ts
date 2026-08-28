import { test } from "node:test";
import assert from "node:assert/strict";
import { salvageGate, type GateIo } from "../src/salvage-gate-terminal.ts";
import type { SalvageGateInput } from "../src/adopt.ts";

/** Scripted line I/O: answers dequeue in order; writes accumulate for assertions. */
function scripted(answers: string[]): GateIo & { out: () => string } {
  let i = 0;
  let out = "";
  return {
    ask: async () => answers[i++] ?? "",
    write: (s) => {
      out += s;
    },
    out: () => out,
  };
}

const ask = (over: Partial<SalvageGateInput> = {}): SalvageGateInput => ({
  pr: 16632,
  title: "Add E2E tests for appointment booking",
  intent: "Adds Playwright specs for the booking flow.",
  description: "This PR adds appointment booking specs.",
  divergence: { risk: true, note: "⚠ description is stale" },
  draftCriteria: ["booking is covered by an e2e spec"],
  reconstructedBy: "care-intent (maker)",
  ...over,
});

test("salvage gate surfaces the divergence and the Reconstructed-by line (display only)", async () => {
  const io = scripted(["a", ""]); // approve, no non-goals
  await salvageGate(io)(ask());
  assert.match(io.out(), /DIVERGENCE.*description is stale/s);
  assert.match(io.out(), /Reconstructed by: care-intent \(maker\)  \(display only — not enforced\)/);
  assert.match(io.out(), /Reconstructed intent/);
});

test("a non-Opus reconstructedBy is NOT auto-rejected — salvage approves (§11 D4)", async () => {
  const io = scripted(["a", ""]);
  const decision = await salvageGate(io)(ask({ reconstructedBy: "sonnet-maker" }));
  assert.equal(decision.decision, "approve"); // no Opus-or-reject in salvage
});

test("approve captures non-goals until a blank line, and carries the draft criteria", async () => {
  const io = scripted([
    "a",
    "do not refactor the booking API",
    "leave the billing module alone",
    "", // finish non-goals
  ]);
  const decision = await salvageGate(io)(ask());
  assert.equal(decision.decision, "approve");
  assert.deepEqual(decision.nonGoals, [
    "do not refactor the booking API",
    "leave the billing module alone",
  ]);
  assert.deepEqual(decision.criteria, ["booking is covered by an e2e spec"]);
});

test("reject returns a reject decision", async () => {
  const decision = await salvageGate(scripted(["r"]))(ask());
  assert.equal(decision.decision, "reject");
});

test("an unrecognized answer re-prompts", async () => {
  const io = scripted(["huh", "r"]);
  const decision = await salvageGate(io)(ask());
  assert.equal(decision.decision, "reject");
  assert.match(io.out(), /unrecognized/);
});
