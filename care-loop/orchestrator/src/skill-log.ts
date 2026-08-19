// skill-log.ts — Phase-2 observability: the ONE way a skill invocation gets recorded.
//
// Goal (per the two reasons logs exist): DEBUGGING and SKILL SELF-IMPROVEMENT. Both want the same
// thing — structured, uniform, per-skill records, not scattered freeform prose. So logging is a
// DECORATOR around a skill, not a logger sprinkled through skill bodies: wrap a skill once and every
// invocation on every driver path (roleSpawn, reduceTriage, 6b apply) is captured identically.
//
// What it records per call:
//   • a bounded `skill.invoke` journal event + the INPUT as a content-addressed sidecar (so the doctor
//     can replay exactly what the skill saw), written BEFORE the call so a crash mid-skill is on record;
//   • a bounded `skill.result` event (verdict, reason_code, model, duration, counts, artifact refs) +
//     the full SkillResult envelope as a sidecar — the durable, SDK-independent record the doctor reads.
// Heavy content lives in the sidecars AND in run_artifacts (jsonb); the journal carries only bounded
// fields + {path,sha256} refs, so
// the hash-chained spine stays lean and one source of truth (see PLAN §5 / the observability contract).

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Journal, type EventType } from "./journal.js";
import { getActiveRunStore } from "./run-store.js";
import type { SkillArtifact, SkillResult } from "./skill-result.js";

const sha256 = (s: string): string =>
  "sha256:" + createHash("sha256").update(s, "utf8").digest("hex");

/** A run-scoped structured logger. `event` appends a bounded journal line; `artifact` writes a
 *  content-addressed sidecar under <run-dir>/skills/ and returns its {name,path,sha256} ref. Kept as
 *  an object (not just the decorator) so the day a genuine second call site appears — e.g. a transport
 *  `skill.retry` breadcrumb — it can emit a STRUCTURED event through the same mechanism, not a freeform
 *  channel. No such consumer exists yet; the decorator is the only user today. */
export interface SkillLogger {
  event(
    type: EventType,
    data: Record<string, unknown>,
    opts?: { step?: string; round?: number; costUsd?: number },
  ): void;
  /** Persist one artifact. Takes a JSON-serializable VALUE, not a pre-serialized string: the
   *  serialization is then canonical and single-sourced, the sidecar text and the db's jsonb encoding
   *  are guaranteed to agree, and "every artifact is valid JSON" becomes structural rather than a
   *  convention every caller has to honour. */
  artifact(relName: string, value: unknown): SkillArtifact;
}

export function makeSkillLogger(opts: {
  runDir: string;
  runId: string;
}): SkillLogger {
  const journal = new Journal(join(opts.runDir, "journal.jsonl"), opts.runId);
  const skillsDir = join(opts.runDir, "skills");
  return {
    event(type, data, o) {
      // Stamp cumulative cost when a call reports usd (IMP-14 → rubric dim 3): scan backwards
      // through the journal for the last event that actually carries cost_cum (not just head(),
      // which may be a step.enter or similar that has no cost field) and add this call's spend.
      // Scanning the tail keeps the total correct even across the two loggers one run creates
      // (plan stage + build stage), each with its own closure.
      let cost_cum: { usd_est: number } | undefined;
      if (typeof o?.costUsd === "number") {
        const { events } = journal.read();
        const prev =
          [...events].reverse().find((e) => e.cost_cum)?.cost_cum?.usd_est ?? 0;
        cost_cum = { usd_est: prev + o.costUsd };
      }
      journal.append({
        event: type,
        step: o?.step,
        round: o?.round,
        data,
        cost_cum,
      });
    },
    artifact(relName, value) {
      // ONE serialization, used for all three of: the sidecar file, the hash, and the db encoding.
      const content = JSON.stringify(value, null, 2);
      mkdirSync(skillsDir, { recursive: true });
      writeFileSync(join(skillsDir, relName), content);
      const ref = {
        name: relName.replace(/\.[^.]+$/, ""),
        path: `skills/${relName}`,
        sha256: sha256(content),
      };
      // Mirror the BODY into the db too ([[PLAN-loop-service]] §6). The journal event still carries
      // only the bounded {name,path,sha256} ref — the spine stays lean — but the service reads the
      // database and nothing else, so the content has to be reachable there or the API can report
      // that a skill returned three findings without being able to show what it wrote.
      // Fatal on failure, exactly like the event append beside it: an artifact that silently failed
      // to store is a run whose record is partly absent, repaired invisibly by the next reindex and
      // masking a real db fault.
      getActiveRunStore().putArtifact(opts.runId, { ...ref, content });
      return ref;
    },
  };
}

/** Bounded per-role counts for the `skill.result` event (the doctor's at-a-glance signal). */
function deriveCounts(res: SkillResult): Record<string, number> | undefined {
  const p = res.payload as Record<string, unknown> | undefined;
  if (!p) return undefined;
  if (Array.isArray(p.findings)) return { findings: p.findings.length };
  if (typeof p.addressCount === "number")
    return {
      address: p.addressCount as number,
      decline: p.declineCount as number,
    };
  if (Array.isArray(p.filesChanged))
    return { filesChanged: p.filesChanged.length };
  return undefined;
}

/**
 * Wrap a skill so every invocation is logged (input+output+timing) with zero per-skill code. Returns
 * a function of the SAME type, so it's a drop-in in default-wiring. Errors are recorded as a
 * `skill.result{terminal_state:"failed"}` then re-thrown (a crashed skill stays on the record).
 */
export function withSkillLog<
  I extends { runDir: string; round: number; step?: string },
  P,
>(
  name: string,
  fn: (input: I) => Promise<SkillResult<P>>,
  logger: SkillLogger,
): (input: I) => Promise<SkillResult<P>> {
  return async (input) => {
    const round = input.round;
    const step = input.step;
    const inputRef = logger.artifact(`${name}-r${round}.input.json`, input);
    logger.event(
      "skill.invoke",
      { skill: name, input: inputRef },
      { step, round },
    );

    const t0 = Date.now();
    try {
      const res = await fn(input);
      const durationMs = Date.now() - t0;
      const artifacts: SkillArtifact[] = [
        inputRef,
        logger.artifact(`${name}-r${round}.result.json`, { ...res, durationMs }),
      ];
      logger.event(
        "skill.result",
        {
          skill: res.skill ?? name,
          verdict: res.verdict,
          reason_code: res.reasonCode,
          terminal_state: res.terminalState,
          model: res.modelUsed,
          duration_ms: durationMs,
          cost_usd: res.cost?.usdEst,
          counts: deriveCounts(res),
          artifacts,
        },
        { step, round, costUsd: res.cost?.usdEst },
      );
      return { ...res, artifacts, durationMs };
    } catch (err) {
      logger.event(
        "skill.result",
        {
          skill: name,
          terminal_state: "failed",
          reason_code: "threw",
          error: String((err as Error)?.message ?? err),
          duration_ms: Date.now() - t0,
        },
        { step, round },
      );
      throw err;
    }
  };
}
