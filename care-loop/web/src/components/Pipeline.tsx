// Pipeline — the step vocabulary as a progress strip. Labelled for screen readers rather than left
// as decorative dots, since it is the only place the run's position is shown graphically.

import { PIPELINE, pipelineIndex } from "../format";
import { cn } from "./ui/primitives";

export function Pipeline({ step }: { step: string }) {
  const at = pipelineIndex(step);
  const aborted = step === "aborted";
  return (
    <div
      className="inline-flex gap-[3px]"
      role="img"
      aria-label={aborted ? "run aborted" : `step ${step} of ${PIPELINE.length}`}
    >
      {PIPELINE.map((s, i) => (
        <span
          key={s}
          title={`step ${s}`}
          className={cn(
            "h-1.5 w-2.5 rounded-[2px]",
            aborted
              ? "bg-destructive"
              : i < at
                ? "bg-muted-foreground/50"
                : i === at
                  ? "bg-primary"
                  : "bg-border",
          )}
        />
      ))}
    </div>
  );
}
