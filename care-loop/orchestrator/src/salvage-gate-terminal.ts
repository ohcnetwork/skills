// salvage-gate-terminal.ts — the `SalvageGate` for `care-loopd --pr` (PLAN-pr-salvage §4).
//
// A salvage run has no interview and no planner; the human's one gate confirms the code-derived
// reconstruction against the (possibly stale) PR description, and records non-goals. Two deliberate
// differences from the normal plan gate (gate-terminal.ts):
//   • it leads with the description-vs-diff DIVERGENCE — the salvage failure mode is a stale
//     description seeding wrong criteria that then suppress valid review comments (§3.1);
//   • `Reconstructed by:` is DISPLAY-ONLY. The normal gate's not-Opus⇒reject (plan.ts
//     `modelPinSatisfied`) does not apply here (§11 D4): the reconstruction runs at maker tier, and
//     the human is checking it against a diff in front of them — a stronger check than the Opus rule
//     backstops. adopt.ts never routes salvage through that enforcement; this transport must not
//     reintroduce it.
//
// The gate logic is written against an injected line I/O so it is deterministically testable; the
// readline wrapper (`terminalGateIo`) is the thin transport, mirroring gate-terminal.ts.

import { createInterface } from "node:readline/promises";
import { askOrFail } from "./gate-terminal.js";
import { stdin as processStdin, stdout as processStdout } from "node:process";
import type { Readable, Writable } from "node:stream";
import type { SalvageApproval, SalvageGate, SalvageGateInput } from "./adopt.js";

/** The gate's I/O seam: prompt-and-read one line, and write a line. Injected so tests script it. */
export interface GateIo {
  ask: (prompt: string) => Promise<string>;
  write: (s: string) => void;
}

/** The readline-backed I/O for the real terminal. One interface for the whole dialog. */
export function terminalGateIo(
  io: { input?: Readable; output?: Writable } = {},
): GateIo & { close: () => void } {
  const input = io.input ?? processStdin;
  const output = io.output ?? processStdout;
  const rl = createInterface({ input, output, terminal: false });
  return {
    // Fails rather than hangs when stdin is closed — see askOrFail. A salvage run spawned without a
    // TTY would otherwise print the approval prompt and stop there forever.
    ask: askOrFail(rl),
    write: (s: string) => void output.write(s),
    close: () => rl.close(),
  };
}

/** Build a SalvageGate over an injected line I/O (or the real terminal by default). */
export function salvageGate(io?: GateIo): SalvageGate {
  return async (ask: SalvageGateInput): Promise<SalvageApproval> => {
    const term = io ?? terminalGateIo();
    const write = term.write;
    try {
      write(`\n══ Salvage plan — PR #${ask.pr} ═════════════════════════════════════════\n`);
      write(`Title:           ${ask.title}\n`);
      // Display-only: salvage does NOT enforce Opus (§11 D4).
      write(`Reconstructed by: ${ask.reconstructedBy}  (display only — not enforced)\n`);

      // Lead with the divergence — the whole reason the gate is mandatory here.
      write(`\n${ask.divergence.risk ? "⚠ DIVERGENCE" : "Divergence check"}: ${ask.divergence.note}\n`);

      write(`\n── Reconstructed intent (from the code, not the description) ──\n`);
      write(`${ask.intent}\n`);
      write(`\n── PR description (may be stale — cross-check, don't trust) ──\n`);
      write(`${ask.description.trim() || "(none)"}\n`);
      write(`\n── Draft acceptance criteria (from the reconstruction) ──\n`);
      if (ask.draftCriteria.length)
        for (const c of ask.draftCriteria) write(`  • ${c}\n`);
      else write(`  (none derived)\n`);
      write(`\nApproval authorizes the loop to address reviews, push commits, and update the PR.\n`);

      for (;;) {
        const ans = (
          await term.ask(`\nAdopt this PR into the loop? [a]pprove / [r]eject > `)
        )
          .trim()
          .toLowerCase();
        if (ans === "r" || ans === "reject") return { decision: "reject" };
        if (ans === "a" || ans === "approve") {
          // Capture non-goals — the interview's real output, compressed to one prompt. These become
          // decisions.md, which the 6a triager citation-declines against.
          const nonGoals: string[] = [];
          write(`\nNon-goals (out-of-scope items the loop must decline). One per line, blank to finish:\n`);
          for (;;) {
            const ng = (await term.ask(`  non-goal > `)).trim();
            if (!ng) break;
            nonGoals.push(ng);
          }
          return { decision: "approve", criteria: ask.draftCriteria, nonGoals };
        }
        write(`(unrecognized — enter a or r)\n`);
      }
    } finally {
      if (!io && "close" in term) (term as { close: () => void }).close();
    }
  };
}
