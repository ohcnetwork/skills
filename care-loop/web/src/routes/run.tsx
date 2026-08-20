// run.tsx — one run: header, metadata, and the event timeline, at parity with the vanilla
// dashboard's drill-down. Artifacts are listed per event and fetched only when opened.

import type { ReactNode } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useRun, useRunArtifacts, useRunEvents } from "../api/queries";
import { AppHeader } from "../components/AppHeader";
import { Pipeline } from "../components/Pipeline";
import { Timeline } from "../components/Timeline";
import { Badge, Button, Card, cn } from "../components/ui/primitives";
import { cost, duration, shortSha } from "../format";

const REFRESH_MS = 5_000;

export function RunPage() {
  const { runId } = useParams({ from: "/runs/$runId" });
  const run = useRun(runId, { refetch: REFRESH_MS });
  const events = useRunEvents(runId, { refetch: REFRESH_MS });
  const artifacts = useRunArtifacts(runId);

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

  const r = run.data!.run;
  return (
    <Shell>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-mono text-lg font-semibold tracking-tight">{r.slug}</h1>
          <p className="mb-4 mt-1 max-w-3xl">
            {r.task || <span className="text-muted-foreground">no task recorded</span>}
          </p>
        </div>
        <Pipeline step={r.step} />
      </div>

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

      {/* A parity divergence is the db and its replica disagreeing — rare, and worth surfacing on the
          run it happened to rather than only in a log nobody reads. */}
      {r.parityError && (
        <Card className="mb-5 border-warn p-3.5 text-sm">
          <strong className="text-warn">Replica parity divergence:</strong> {r.parityError}
        </Card>
      )}

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
