// render.ts — human narrative (loop.log) rendered from the journal (§5). Never hand-written;
// always regenerable. The doctor and a human read this to follow a run without touching the raw
// journal or chat sessions.

import type { JournalEvent } from "./journal.js";

function d(ev: JournalEvent, key: string): string {
  const v = ev.data?.[key];
  return v === undefined || v === null ? "" : String(v);
}

/** One compact line per event. */
export function renderEvent(ev: JournalEvent): string {
  const t = ev.ts.replace("T", " ").replace(/\.\d+Z$/, "Z");
  const rd = ev.round !== undefined ? ` r${ev.round}` : "";
  const cost = ev.cost_cum ? ` ($${ev.cost_cum.usd_est.toFixed(2)})` : "";
  let body: string;
  switch (ev.event) {
    case "run.start":
      body = `run.start  task="${d(ev, "task") || (ev.data?.state as any)?.task || ""}"`;
      break;
    case "run.resume":
      body = `run.resume  re-entry step=${ev.step ?? "?"}`;
      break;
    case "run.end":
      body = `run.end  ${d(ev, "outcome") || d(ev, "reason_code")}`;
      break;
    case "step.enter":
      body = `→ step ${ev.step}${rd}`;
      break;
    case "step.exit":
      body = `✓ step ${ev.step}${rd}  ${d(ev, "reason_code")}`;
      break;
    case "gate.asked":
      body = `gate.asked  ${d(ev, "count")} question(s)`;
      break;
    case "gate.answered":
      body = `gate.answered`;
      break;
    case "plan.approved":
      body = `plan.approved  by=${d(ev, "planned_by")} tier=${d(ev, "classification")}`;
      break;
    case "spawn.start":
      body = `spawn ${d(ev, "role")} (${d(ev, "model")})`;
      break;
    case "spawn.result":
      body =
        `spawn ${d(ev, "role")} → ${d(ev, "verdict")} ${d(ev, "reason_code")}`.trimEnd();
      break;
    case "spawn.invalid":
      body = `spawn ${d(ev, "role")} INVALID (${d(ev, "reason_code")})`;
      break;
    case "spawn.retry":
      body = `spawn ${d(ev, "role")} retry ${d(ev, "attempt")}`;
      break;
    case "spawn.escalate":
      body = `spawn ${d(ev, "role")} escalate → ${d(ev, "to")}`;
      break;
    case "helper.exec":
      body =
        `$ ${d(ev, "cmd")} → exit ${d(ev, "exit")}  ${d(ev, "summary")}`.trimEnd();
      break;
    case "decision":
      body = `decision ${d(ev, "from")} → ${d(ev, "to")}`;
      break;
    case "push":
      body = `push ${d(ev, "head_sha")}${d(ev, "pr") ? ` (PR #${d(ev, "pr")})` : ""}`;
      break;
    case "ci.wait":
      body = `ci.wait ${d(ev, "sha")}`;
      break;
    case "ci.done":
      body = `ci.done ${d(ev, "conclusion")}`;
      break;
    case "budget.tick":
      body = `budget ${cost.trim()}`.trim();
      break;
    case "budget.stop":
      body = `budget.stop ${d(ev, "reason_code")}`;
      break;
    case "checkpoint.written":
      body = `checkpoint ${d(ev, "reason_code")}`;
      break;
    case "skill.invoke": {
      body = `skill ${d(ev, "skill")} ▸ invoke`;
      break;
    }
    case "skill.result": {
      const c = ev.data?.counts as Record<string, number> | undefined;
      const counts = c
        ? " " +
          Object.entries(c)
            .map(([k, v]) => `${k}=${v}`)
            .join(" ")
        : "";
      const ms =
        ev.data?.duration_ms !== undefined
          ? ` ${(Number(ev.data.duration_ms) / 1000).toFixed(1)}s`
          : "";
      body =
        `skill ${d(ev, "skill")} → ${d(ev, "verdict") || d(ev, "terminal_state")}${counts}${ms}`.trimEnd();
      break;
    }
    default:
      body = ev.event;
  }
  // cost_cum (cumulative $) rides as a suffix on every event that carries it; budget.tick already
  // shows it in its own body, so don't double it there.
  return `[${t}] ${body}${ev.event === "budget.tick" ? "" : cost}`;
}

export function renderLoopLog(events: JournalEvent[]): string {
  return events.map(renderEvent).join("\n") + (events.length ? "\n" : "");
}
