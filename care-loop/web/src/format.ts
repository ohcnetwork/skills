// format.ts — display helpers. Kept out of components so the fleet table and the run header cannot
// drift into formatting the same value two ways.

export function age(iso: string, now: number = Date.now()): string {
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "—";
  return duration(Math.max(0, ms)) + " ago";
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function cost(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || usd === 0) return "—";
  // Four decimals: individual skill calls land in the tenths of a cent, and rounding them to
  // "$0.00" would make a real number look like an absent one.
  return `$${usd.toFixed(4)}`;
}

export function shortSha(sha: string | null | undefined): string {
  if (!sha || sha === "scratch" || sha === "unknown") return sha ?? "—";
  return sha.slice(0, 7);
}

/** The milestone steps, in order, for the progress strip.
 *
 *  This is a PRESENTATION choice, not a copy of the orchestrator's vocabulary: STEP_VOCAB also holds
 *  sub-states (`3-implementing`, `5-await`, `6b-applying`) that would make ten pips into seventeen
 *  without telling anyone more. Whether a run is FINISHED is deliberately not derived here — the
 *  server sends `terminal` on every run, so there is one answer to that question rather than one per
 *  layer. */
export const PIPELINE = ["1", "2", "3", "4a", "4b", "4c", "5", "6a", "6b", "7"] as const;

/** Where a step sits in the strip, or null if it is not on it.
 *
 *  Returns null rather than -1 for an unknown step so the caller has to handle it. A step this build
 *  predates (the orchestrator gained one, the frontend has not been redeployed) previously fell
 *  through as -1 and rendered as a strip of all-future pips — indistinguishable from a run that had
 *  not started, which is the wrong answer told confidently. */
export function pipelineIndex(step: string): number | null {
  if (step === "merged") return PIPELINE.length - 1;
  if (step === "aborted") return null;
  const exact = PIPELINE.indexOf(step as (typeof PIPELINE)[number]);
  if (exact !== -1) return exact;
  // Sub-states share their parent's prefix: `5-await` sits at `5`.
  const base = step.split("-")[0] ?? "";
  const parent = PIPELINE.indexOf(base as (typeof PIPELINE)[number]);
  return parent === -1 ? null : parent;
}
