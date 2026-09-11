// Labelled for screen readers rather than left as decorative dots: this is the only place a run's
// position is shown graphically.

import { PIPELINE, pipelineIndex } from "../format";
import { cn } from "./ui/primitives";

export function Pipeline({ step }: { step: string }) {
  const at = pipelineIndex(step);
  const aborted = step === "aborted";
  // An unknown step shows itself rather than a row of empty pips, which would read as "not started".
  if (at === null)
    return (
      <span
        className={cn("font-mono text-xs", aborted ? "text-destructive" : "text-muted-foreground")}
      >
        {step}
      </span>
    );
  return (
    <div
      className="inline-flex gap-[3px]"
      role="img"
      aria-label={`step ${step} of ${PIPELINE.length}`}
    >
      {PIPELINE.map((s, i) => (
        <span
          key={s}
          title={`step ${s}`}
          className={cn(
            "h-1.5 w-2.5 rounded-[2px]",
            i < at ? "bg-muted-foreground/50" : i === at ? "bg-primary" : "bg-border",
          )}
        />
      ))}
    </div>
  );
}
