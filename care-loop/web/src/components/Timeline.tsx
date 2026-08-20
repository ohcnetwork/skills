// Timeline — the run's events in order, grouped by step.
//
// Events carry an unbounded `data` blob, so a row shows a one-line summary and expands on demand.
// Skill artifacts are refs, not bodies: opening one fetches it, which is how a run with 327 events
// and 42 artifacts renders without pulling a megabyte nobody looked at.

import { useState } from "react";
import { useArtifact } from "../api/queries";
import type { ArtifactSummary, JournalEvent } from "../api/types";
import { cost, duration } from "../format";
import { Button, cn } from "./ui/primitives";

export function Timeline({
  runId,
  events,
  artifacts,
}: {
  runId: string;
  events: JournalEvent[];
  artifacts: ArtifactSummary[];
}) {
  const bySha = new Map(artifacts.map((a) => [a.sha256, a]));
  let lastStep: string | undefined;

  if (events.length === 0)
    return <p className="py-6 text-muted-foreground">No events yet.</p>;

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      {events.map((ev) => {
        const divider = ev.step && ev.step !== lastStep ? ev.step : null;
        lastStep = ev.step ?? lastStep;
        return (
          <div key={ev.seq}>
            {divider && (
              <div className="border-t border-border bg-muted px-3 py-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
                step {divider}
              </div>
            )}
            <EventRow runId={runId} ev={ev} bySha={bySha} />
          </div>
        );
      })}
    </div>
  );
}

/** Artifact refs hide inside `data` in two shapes: `input` on skill.invoke, `artifacts[]` on
 *  skill.result. Both are `{name, path, sha256}`. */
function refsOf(ev: JournalEvent): { name: string; sha256: string }[] {
  const out: { name: string; sha256: string }[] = [];
  const push = (v: unknown): void => {
    if (v && typeof v === "object" && "sha256" in v && typeof (v as { sha256: unknown }).sha256 === "string")
      out.push(v as { name: string; sha256: string });
  };
  push(ev.data?.input);
  const list = ev.data?.artifacts;
  if (Array.isArray(list)) list.forEach(push);
  return out;
}

function summarize(ev: JournalEvent): string {
  const d = ev.data ?? {};
  return [d.skill, d.verdict, d.reason_code, d.model]
    .filter((v): v is string => typeof v === "string")
    .join(" · ");
}

function EventRow({
  runId,
  ev,
  bySha,
}: {
  runId: string;
  ev: JournalEvent;
  bySha: Map<string, ArtifactSummary>;
}) {
  const [open, setOpen] = useState(false);
  const refs = refsOf(ev).filter((r) => bySha.has(r.sha256));
  const durMs = typeof ev.data?.duration_ms === "number" ? ev.data.duration_ms : null;
  const usd = typeof ev.data?.cost_usd === "number" ? ev.data.cost_usd : null;
  const dim = "font-mono text-xs text-muted-foreground";

  return (
    <div className="border-t border-border first:border-t-0">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="grid w-full grid-cols-[16px_64px_130px_1fr_70px_70px] items-baseline gap-2 px-3 py-1.5 text-left hover:bg-muted/60"
      >
        <span className={dim}>{open ? "▾" : "▸"}</span>
        <span className={dim} title={ev.ts}>{ev.ts.slice(11, 19)}</span>
        <span className="font-mono text-xs">{ev.event}</span>
        <span className="truncate text-xs text-muted-foreground">{summarize(ev)}</span>
        <span className={cn(dim, "text-right")}>{durMs !== null ? duration(durMs) : ""}</span>
        <span className={cn(dim, "text-right")}>{usd !== null ? cost(usd) : ""}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 pl-9">
          <Pre>{JSON.stringify(ev.data ?? {}, null, 2)}</Pre>
          {refs.map((r) => (
            <Artifact key={r.sha256} runId={runId} name={r.name} sha={r.sha256} meta={bySha.get(r.sha256)!} />
          ))}
        </div>
      )}
    </div>
  );
}

function Pre({ children }: { children: string }) {
  return (
    <pre className="my-1.5 max-h-[420px] overflow-auto rounded-md border border-border bg-muted p-2.5 font-mono text-xs">
      {children}
    </pre>
  );
}

function Artifact({
  runId,
  name,
  sha,
  meta,
}: {
  runId: string;
  name: string;
  sha: string;
  meta: ArtifactSummary;
}) {
  const [open, setOpen] = useState(false);
  const body = useArtifact(runId, open ? sha : null);
  return (
    <div className="mt-1.5">
      <Button variant="link" size="none" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="font-mono text-xs">
          {open ? "▾" : "▸"} {name}
        </span>
        <span className="text-xs text-muted-foreground">{(meta.bytes / 1024).toFixed(1)} KB</span>
      </Button>
      {open && body.isPending && <p className="text-xs text-muted-foreground">loading…</p>}
      {open && body.isError && <p className="text-xs text-destructive">{(body.error as Error).message}</p>}
      {open && body.data !== undefined && <Pre>{JSON.stringify(body.data.content, null, 2)}</Pre>}
    </div>
  );
}
