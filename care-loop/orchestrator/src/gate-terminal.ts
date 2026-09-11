// gate-terminal.ts — the readline `PlanGate` adapter: the human answers the interview and the
// consolidated gate directly in the terminal. This is ONE transport; a Jira/PR-comment adapter
// implements the same interface (post + poll) with zero change to `runPlan`. Kept dependency-injectable
// (input/output streams) so a test can drive it with scripted stdin.

import { createInterface } from "node:readline/promises";
import { stdin as processStdin, stdout as processStdout } from "node:process";
import type { Readable, Writable } from "node:stream";
import type { ApprovalDecision, ConsolidatedAsk, PlanAnswer, PlanGate, PlanQuestion } from "./plan-gate.js";

export interface TerminalGateIo {
  input?: Readable;
  output?: Writable;
}

/** Thrown when a gate is asked to read from a stream that has already ended. */
export class GateInputClosedError extends Error {}

/**
 * Fails on a closed stdin instead of hanging on it. `rl.question` against an ended stream never
 * resolves — not EOF, not an empty string, just a promise that sits there — so a non-interactive
 * invocation stopped dead at the gate with no error and no exit. Reachable rather than theoretical:
 * the supervisor spawns children with `stdio: "ignore"`.
 *
 * Shared by both terminal gates, so the fix cannot exist in one and be forgotten in the other.
 */
export function askOrFail(rl: {
  question: (prompt: string) => Promise<string>;
  once: (event: "close", cb: () => void) => unknown;
}): (prompt: string) => Promise<string> {
  const closed = new Promise<never>((_resolve, reject) => {
    rl.once("close", () =>
      reject(
        new GateInputClosedError(
          "the gate needs an answer but stdin is closed — this run cannot be approved here. " +
            "Run it from a terminal, or approve it over HTTP with `care-loopd serve`.",
        ),
      ),
    );
  });
  // The happy path closes the interface too, rejecting this with nobody waiting on it.
  closed.catch(() => {});
  return async (prompt: string): Promise<string> => {
    // An already-closed interface throws ERR_USE_AFTER_CLOSE synchronously rather than returning a
    // promise, escaping the race below as a node internal. Reached by `echo "a" | care-loopd`.
    try {
      return await Promise.race([rl.question(prompt), closed]);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ERR_USE_AFTER_CLOSE")
        throw new GateInputClosedError(
          "the gate needs another answer but stdin has ended — this run cannot be approved here. " +
            "Run it from a terminal, or approve it over HTTP with `care-loopd serve`.",
        );
      throw err;
    }
  };
}

export function terminalGate(io: TerminalGateIo = {}): PlanGate {
  const input = io.input ?? processStdin;
  const output = io.output ?? processStdout;
  const write = (s: string) => output.write(s);

  const withRl = async <T>(fn: (ask: (prompt: string) => Promise<string>) => Promise<T>): Promise<T> => {
    const rl = createInterface({ input, output, terminal: false });
    const ask = askOrFail(rl);
    try {
      return await fn(ask);
    } finally {
      rl.close();
    }
  };

  return {
    async interview(questions: PlanQuestion[]): Promise<PlanAnswer[]> {
      if (questions.length === 0) return [];
      return withRl(async (ask) => {
        write(`\n── Plan interview — ${questions.length} question(s) ─────────────────────────────\n`);
        const answers: PlanAnswer[] = [];
        for (let i = 0; i < questions.length; i++) {
          const q = questions[i];
          const answer = (await ask(`\n[${i + 1}/${questions.length}] ${q.prompt}\n> `)).trim();
          answers.push({ id: q.id, answer });
        }
        return answers;
      });
    },

    async approve(ask: ConsolidatedAsk): Promise<ApprovalDecision> {
      return withRl(async (askUser) => {
        write(`\n══ Plan approval ════════════════════════════════════════════════════════\n`);
        write(`Planned by: ${ask.plannedBy}\n`); // MANDATORY line — not-Opus ⇒ reject at the gate
        write(`\nSummary:        ${ask.summary}\n`);
        write(`Classification: ${ask.classification}\n`);
        if (ask.criteria.length) {
          write(`\nAcceptance criteria:\n`);
          for (const c of ask.criteria) write(`  • ${c}\n`);
        }
        write(`\nTests:          ${ask.testPlan}\n`);
        write(`\n${ask.pushAuthNote}\n`);

        // Loop until a recognized decision. Amend collects free-text the planner folds into a re-draft.
        for (;;) {
          const ans = (await askUser(`\nApprove this plan? [a]pprove / a[m]end / [r]eject > `)).trim().toLowerCase();
          if (ans === "a" || ans === "approve") return { decision: "approve" };
          if (ans === "r" || ans === "reject") return { decision: "reject" };
          if (ans === "m" || ans === "amend") {
            const amendment = (await askUser(`Describe the amendment:\n> `)).trim();
            if (amendment) return { decision: "amend", amendment };
            write(`(empty amendment — please choose again)\n`);
            continue;
          }
          write(`(unrecognized — enter a, m, or r)\n`);
        }
      });
    },
  };
}
