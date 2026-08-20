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

/** The FSM's step vocabulary in pipeline order, for rendering progress. Mirrors STEP_VOCAB. */
export const PIPELINE = ["1", "2", "3", "4a", "4b", "4c", "5", "6a", "6b", "7"] as const;
const TERMINAL = new Set(["7", "merged", "aborted"]);

export function isTerminal(step: string): boolean {
  return TERMINAL.has(step);
}

/** Where a step sits in the pipeline, tolerating the sub-states (`3-implementing`, `5-await`, …)
 *  that share a prefix with their parent step. */
export function pipelineIndex(step: string): number {
  if (step === "merged") return PIPELINE.length - 1;
  if (step === "aborted") return -1;
  const exact = PIPELINE.indexOf(step as (typeof PIPELINE)[number]);
  if (exact !== -1) return exact;
  const base = step.split("-")[0] ?? "";
  return PIPELINE.indexOf(base as (typeof PIPELINE)[number]);
}
