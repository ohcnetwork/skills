// The one way a skill invocation gets recorded, as a DECORATOR rather than a logger sprinkled through
// skill bodies: wrap a skill once and every driver path captures it identically.
//
// Per call it writes a bounded `skill.invoke` event plus the input as a sidecar BEFORE the call, so a
// crash mid-skill is on record, then a bounded `skill.result` event plus the full envelope. Heavy
// content lives in the sidecars and in run_artifacts; the journal carries only bounded fields and
// {path,sha256} refs, so the hash-chained spine stays lean.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Journal, type EventType } from "./journal.js";
import { getActiveRunStore } from "./run-store.js";
import type { SkillArtifact, SkillResult } from "./skill-result.js";

const sha256 = (s: string): string =>
  "sha256:" + createHash("sha256").update(s, "utf8").digest("hex");

/** `event` appends a bounded journal line; `artifact` writes a sidecar under <run-dir>/skills/ and
 *  returns its ref. An object rather than just the decorator, so a future second call site emits a
 *  structured event through the same mechanism instead of a freeform channel. */
export interface SkillLogger {
  event(
    type: EventType,
    data: Record<string, unknown>,
    opts?: { step?: string; round?: number; costUsd?: number },
  ): void;
  /** Takes a VALUE, not a pre-serialized string, so the sidecar text and the db's jsonb encoding
   *  cannot disagree and "every artifact is valid JSON" is structural rather than a convention. */
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
      // Scans back for the last event actually carrying cost_cum — head() may be a step.enter with
      // no cost field — which also keeps the total right across the two loggers a run creates.
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
      // One serialization for all three of the sidecar file, the hash, and the db encoding.
      const content = JSON.stringify(value, null, 2);
      mkdirSync(skillsDir, { recursive: true });
      writeFileSync(join(skillsDir, relName), content);
      const ref = {
        name: relName.replace(/\.[^.]+$/, ""),
        path: `skills/${relName}`,
        sha256: sha256(content),
      };
      // The service reads the database and nothing else, so the body has to be reachable there too.
      // Fatal on failure, like the event append beside it: a silently-missing artifact would be
      // repaired invisibly by the next reindex, masking a real db fault.
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

/** Returns a function of the SAME type, so it is a drop-in in default-wiring. A thrown error is
 *  recorded as `skill.result{terminal_state:"failed"}` and re-thrown, so a crash stays on record. */
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
