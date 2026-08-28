// One run: header, metadata, and the event timeline. Artifacts are listed per event and fetched
// only when opened.

import type { ReactNode } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useCancelRun, useRun, useRunArtifacts, useRunEvents, useRunGate } from "../api/queries";
import { GateAskView } from "../components/GateAskView";
import type { QueueRow } from "../api/types";
import { AppHeader } from "../components/AppHeader";
import { Pipeline } from "../components/Pipeline";
import { Timeline } from "../components/Timeline";
import { Badge, Button, Card, cn } from "../components/ui/primitives";
import { cost, duration, shortSha } from "../format";

const REFRESH_MS = 5_000;

export function RunPage() {
  const { runId } = useParams({ from: "/runs/$runId" });
  const run = useRun(runId, { refetch: REFRESH_MS });
  // Both need a journal, which a queued run has not written yet — the id is minted at enqueue, long
  // before any process exists.
  const started = run.data?.run != null;
  const events = useRunEvents(runId, { refetch: REFRESH_MS, enabled: started });
  const artifacts = useRunArtifacts(runId, { enabled: started });
  // A gate can open at any point in the plan stage, and whoever must answer is likely already here.
  const gate = useRunGate(runId, { refetch: REFRESH_MS });
  const cancel = useCancelRun();

  if (run.isPending)
    return (
      <Shell>
        <p className="text-muted-foreground">loading…</p>
      </Shell>
    );

  if (run.isError) {
    const err = run.error as { status?: number; message: string };
    return (
      <Shell>
        <Card className="border-destructive p-6">
          <h2 className="mb-2 text-base font-semibold">
            {err.status === 404 ? "No such run" : "Could not load this run"}
          </h2>
          <p className="mb-3 text-muted-foreground">{err.message}</p>
          <Link to="/" className="text-primary hover:underline">
            ← Back to the fleet
          </Link>
        </Card>
      </Shell>
    );
  }

  const q = run.data!.queue;
  const r = run.data!.run;
  // Above everything else, in every state: it is the only thing on this page waiting on the reader,
  // and a run can be parked on a question before its journal reaches the database.
  const gateBanner = gate.data?.ask ? (
    <div className="mb-5">
      <GateAskView ask={gate.data.ask} onSettled={() => void run.refetch()} />
    </div>
  ) : null;

  // Reachable before any process has written a journal, so showing the request beats a 404 for what
  // is a normal few seconds of a run's life.
  if (!r && q)
    return (
      <Shell>
        {gateBanner}
        <NotStartedYet q={q} onCancel={() => cancel.mutate(runId)} />
      </Shell>
    );
  if (!r)
    return (
      <Shell>
        <Card className="border-destructive p-6">
          <h2 className="mb-2 text-base font-semibold">No such run</h2>
          <Link to="/" className="text-primary hover:underline">← Back to the fleet</Link>
        </Card>
      </Shell>
    );
  const cancellable = q !== null && ["pending", "running", "awaiting_gate"].includes(q.status);
  return (
    <Shell>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-mono text-lg font-semibold tracking-tight">{r.slug}</h1>
          <p className="mb-4 mt-1 max-w-3xl">
            {r.task || <span className="text-muted-foreground">no task recorded</span>}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <Pipeline step={r.step} />
          {cancellable && (
            <Button
              variant="outline"
              size="sm"
              className="text-destructive"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate(runId)}
            >
              Cancel run
            </Button>
          )}
        </div>
      </div>

      {gateBanner}
      {q?.status === "awaiting_gate" && !gate.data?.ask && (
        <Card className="mb-5 border-warn/40 p-4 text-sm">
          This run is suspended at a gate whose question is no longer open — it was cancelled or
          expired.
        </Card>
      )}
      {q?.status === "pending" && (
        <Card className="mb-5 p-4 text-sm text-muted-foreground">
          Queued. Nothing has started yet — the run id exists because it is minted at enqueue.
        </Card>
      )}

      <Card className="mb-5 grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3 p-3.5">
        <Meta k="Step">
          <span
            className={cn(
              "font-mono text-xs",
              r.terminal ? "text-muted-foreground" : "font-semibold text-live",
            )}
          >
            {r.step}
          </span>
        </Meta>
        <Meta k="Round">{r.round}</Meta>
        <Meta k="Tier"><Badge>{r.tier}</Badge></Meta>
        <Meta k="Repo">{r.repo}</Meta>
        <Meta k="Branch"><span className="font-mono text-xs">{r.branch}</span></Meta>
        <Meta k="Ticket">{r.ticket ?? "—"}</Meta>
        <Meta k="PR">
          {r.pr !== null ? (
            <a
              className="text-primary hover:underline"
              href={`https://github.com/${r.repo}/pull/${r.pr}`}
              target="_blank"
              rel="noreferrer"
            >
              #{r.pr}
            </a>
          ) : (
            "—"
          )}
        </Meta>
        <Meta k="Requested by">
          {r.requestedBy ?? <span className="text-muted-foreground">unattributed</span>}
        </Meta>
        <Meta k="Head"><span className="font-mono text-xs">{shortSha(r.headSha)}</span></Meta>
        <Meta k="Cost">{cost(r.costUsd)}</Meta>
        <Meta k="Duration">{duration(r.durationMs)}</Meta>
        <Meta k="Events">{r.eventCount}</Meta>
      </Card>

      {events.isPending && <p className="text-muted-foreground">loading timeline…</p>}
      {events.isError && <p className="text-sm text-destructive">{(events.error as Error).message}</p>}
      {events.data && (
        <>
          <Timeline
            runId={runId}
            events={events.data.pages.flatMap((p) => p.items)}
            artifacts={artifacts.data?.items ?? []}
          />
          {events.hasNextPage && (
            <div className="mt-3 flex items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void events.fetchNextPage()}
                disabled={events.isFetchingNextPage}
              >
                {events.isFetchingNextPage ? "loading…" : "Load more events"}
              </Button>
              <span className="text-xs text-muted-foreground">
                showing {events.data.pages.reduce((n, p) => n + p.items.length, 0)} of {r.eventCount}
              </span>
            </div>
          )}
        </>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-[1200px] px-5 pb-16 pt-4">
      <AppHeader />
      <Link to="/" className="mb-4 inline-block text-primary hover:underline">
        ← Fleet
      </Link>
      {children}
    </div>
  );
}

function Meta({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div>
      <dt className="mb-0.5 text-[11px] text-muted-foreground">{k}</dt>
      <dd className="m-0 text-[13px]">{children}</dd>
    </div>
  );
}

/** Everything here comes from the queue row, the only half that exists at this point. */
function NotStartedYet({ q, onCancel }: { q: QueueRow; onCancel: () => void }) {
  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-mono text-lg font-semibold tracking-tight">
            {q.repo.split("/")[1]}-{q.branch.replace(/\//g, "-")}
          </h1>
          <p className="mb-4 mt-1 max-w-3xl">{q.task}</p>
        </div>
        <Badge tone={q.status === "pending" ? "warn" : "neutral"}>{q.status}</Badge>
      </div>
      <Card className="p-5 text-sm">
        <p className="text-muted-foreground">
          {q.status === "pending"
            ? "Queued. The supervisor starts it when a slot frees on this branch — the timeline appears once it does."
            : q.status === "awaiting_gate"
              ? "Suspended on the question above. It holds no process and no slot; answering it puts the run back in the queue."
              : `This run is ${q.status} and has no timeline.`}
        </p>
        <dl className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
          <Meta k="Ticket">{q.ticket}</Meta>
          <Meta k="Branch"><span className="font-mono text-xs">{q.branch}</span></Meta>
          <Meta k="Requested by">{q.requestedBy}</Meta>
          <Meta k="Attempts">{q.attempts}</Meta>
        </dl>
        {q.error && <p className="mt-4 text-destructive">{q.error}</p>}
        {["pending", "running", "awaiting_gate"].includes(q.status) && (
          <Button variant="outline" size="sm" className="mt-4 text-destructive" onClick={onCancel}>
            Cancel run
          </Button>
        )}
      </Card>
    </>
  );
}
