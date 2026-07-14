import { test } from "node:test";
import assert from "node:assert/strict";
import { transition, FsmError, type FsmConfig } from "../src/fsm.ts";

const HALF: FsmConfig = { reviewSteps: ["4a"], maxImplementRetries: 2 };
const FULL: FsmConfig = {
  reviewSteps: ["4a", "4b", "4c"],
  maxImplementRetries: 2,
};

test("half-pipe happy path: 2→3→4a→5", () => {
  assert.equal(transition("2", "helper-ok", { cfg: HALF }).next, "3");
  assert.equal(transition("3", "advance", { cfg: HALF }).next, "4a");
  assert.equal(transition("4a", "advance", { cfg: HALF }).next, "5"); // 4a is last review → gate
  assert.equal(transition("5", "gate-ok", { cfg: HALF }).next, "5-await");
});

test("full profile chains review steps 4a→4b→4c→5", () => {
  assert.equal(transition("4a", "advance", { cfg: FULL }).next, "4b");
  assert.equal(transition("4b", "advance", { cfg: FULL }).next, "4c");
  assert.equal(transition("4c", "advance", { cfg: FULL }).next, "5");
});

test("review loopback returns to implement", () => {
  assert.equal(transition("4a", "loopback", { cfg: HALF }).next, "3");
  assert.equal(transition("4b", "loopback", { cfg: FULL }).next, "3");
  assert.equal(transition("4c", "loopback", { cfg: FULL }).next, "3");
});

test("implement retry stays on 3 until exhausted, then aborts", () => {
  assert.equal(transition("3", "retry", { attempt: 1, cfg: HALF }).next, "3");
  assert.equal(
    transition("3", "retry", { attempt: 2, cfg: HALF }).next,
    "aborted",
  );
  assert.equal(transition("3", "escalate", { cfg: HALF }).next, "aborted");
});

test("setup failure and gate red route correctly", () => {
  assert.equal(transition("2", "helper-fail", { cfg: HALF }).next, "aborted");
  assert.equal(transition("5", "gate-fail", { cfg: HALF }).next, "3");
});

test("budget-stop aborts from any step", () => {
  for (const s of ["2", "3", "4a", "5"] as const) {
    assert.equal(transition(s, "budget-stop", { cfg: HALF }).next, "aborted");
  }
});

test("round loop: 5-await→6a→6b→5", () => {
  assert.equal(transition("5-await", "advance", { cfg: FULL }).next, "6a");
  assert.equal(transition("6a", "advance", { cfg: FULL }).next, "6b");
  assert.equal(transition("6b", "advance", { cfg: FULL }).next, "5");
});

test("undefined (step × signal) edges throw loudly, never silent no-op", () => {
  assert.throws(() => transition("2", "loopback", { cfg: HALF }), FsmError);
  assert.throws(() => transition("4a", "gate-ok", { cfg: HALF }), FsmError);
});
