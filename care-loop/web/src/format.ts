// Kept out of components so the fleet table and the run header cannot format a value two ways.

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
  // Individual skill calls land in tenths of a cent; "$0.00" would look like an absent number.
  return `$${usd.toFixed(4)}`;
}

export function shortSha(sha: string | null | undefined): string {
  if (!sha || sha === "scratch" || sha === "unknown") return sha ?? "—";
  return sha.slice(0, 7);
}

/** A presentation choice, not a copy of STEP_VOCAB: its sub-states (`3-implementing`, `5-await`)
 *  would turn ten pips into seventeen without telling anyone more. Whether a run is FINISHED is not
 *  derived here — the server sends `terminal`, so that question has one answer, not one per layer. */
export const PIPELINE = ["1", "2", "3", "4a", "4b", "4c", "5", "6a", "6b", "7"] as const;

/** Null rather than -1 for an unknown step, so the caller has to handle it: a step this build
 *  predates otherwise renders as all-future pips, indistinguishable from a run that never started. */
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
