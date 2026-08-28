// gate-terminal.ts — the readline `PlanGate` adapter: the human answers the interview and the
// consolidated gate directly in the terminal. This is ONE transport; a Jira/PR-comment adapter
// implements the same interface (post + poll) with zero change to `runPlan`. Kept dependency-injectable
// (input/output streams) so a test can drive it with scripted stdin.

import { createInterface, type Interface } from "node:readline/promises";
import { stdin as processStdin, stdout as processStdout } from "node:process";
import type { Readable, Writable } from "node:stream";
import type { ApprovalDecision, ConsolidatedAsk, PlanAnswer, PlanGate, PlanQuestion } from "./plan-gate.js";

export interface TerminalGateIo {
  input?: Readable;
  output?: Writable;
}

export function terminalGate(io: TerminalGateIo = {}): PlanGate {
  const input = io.input ?? processStdin;
  const output = io.output ?? processStdout;
  const write = (s: string) => output.write(s);

  const withRl = async <T>(fn: (rl: Interface) => Promise<T>): Promise<T> => {
    const rl = createInterface({ input, output, terminal: false });
    try {
      return await fn(rl);
    } finally {
      rl.close();
    }
  };

  return {
    async interview(questions: PlanQuestion[]): Promise<PlanAnswer[]> {
      if (questions.length === 0) return [];
      return withRl(async (rl) => {
        write(`\n── Plan interview — ${questions.length} question(s) ─────────────────────────────\n`);
        const answers: PlanAnswer[] = [];
        for (let i = 0; i < questions.length; i++) {
          const q = questions[i];
          const answer = (await rl.question(`\n[${i + 1}/${questions.length}] ${q.prompt}\n> `)).trim();
          answers.push({ id: q.id, answer });
        }
        return answers;
      });
    },

    async approve(ask: ConsolidatedAsk): Promise<ApprovalDecision> {
      return withRl(async (rl) => {
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
          const ans = (await rl.question(`\nApprove this plan? [a]pprove / a[m]end / [r]eject > `)).trim().toLowerCase();
          if (ans === "a" || ans === "approve") return { decision: "approve" };
          if (ans === "r" || ans === "reject") return { decision: "reject" };
          if (ans === "m" || ans === "amend") {
            const amendment = (await rl.question(`Describe the amendment:\n> `)).trim();
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
