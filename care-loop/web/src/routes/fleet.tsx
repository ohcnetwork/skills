// fleet.tsx — the run list. Read parity with the vanilla dashboard's table (Run · Step · Pipeline ·
// Round · Tier · Age · Cost · Duration), plus the filters the API now supports.
//
// Filter state lives in the URL, not in component state: a filtered view is a link someone can paste
// into Slack, and browser back does what it looks like it does.

import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useFacets, useRuns } from "../api/queries";
import type { RunFilters, RunSummary } from "../api/types";
import { age, cost, duration, isTerminal } from "../format";
import { Pipeline } from "../components/Pipeline";
import { AppHeader } from "../components/AppHeader";
import { FilterBar } from "../components/FilterBar";
import { Badge, Button, cn } from "../components/ui/primitives";

const REFRESH_MS = 10_000;
const TH = "border-b border-border px-2.5 py-1.5 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap";
const TD = "border-b border-border px-2.5 py-2.5 align-top";

export function FleetPage() {
  const search = useSearch({ from: "/" });
  const navigate = useNavigate({ from: "/" });
  const runs = useRuns(search, { refetch: REFRESH_MS });
  const facets = useFacets(search);

  const setFilters = (next: Partial<RunFilters>): void => {
    void navigate({
      search: (prev) => {
        const merged = { ...prev, ...next };
        for (const k of Object.keys(merged) as (keyof RunFilters)[])
          if (merged[k] === undefined || merged[k] === "" || merged[k] === false) delete merged[k];
        return merged;
      },
    });
  };

  return (
    <div className="mx-auto max-w-[1200px] px-5 pb-16 pt-4">
      <AppHeader
        subtitle={runs.data ? `${runs.data.total} run${runs.data.total === 1 ? "" : "s"}` : undefined}
      />

      <FilterBar search={search} facets={facets.data} onChange={setFilters} />

      {runs.isPending && <p className="text-muted-foreground">loading…</p>}
      {runs.isError && <p className="text-sm text-destructive">{(runs.error as Error).message}</p>}

      {runs.data?.items.length === 0 && (
        <p className="py-6 text-muted-foreground">
          No runs match.{" "}
          <Button variant="link" size="none" onClick={() => void navigate({ search: {} })}>
            Clear filters
          </Button>
        </p>
      )}

      {runs.data && runs.data.items.length > 0 && (
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className={TH}>Run</th>
              <th className={TH}>Step</th>
              <th className={TH}>Pipeline</th>
              <th className={cn(TH, "text-right")}>Round</th>
              <th className={TH}>Tier</th>
              <th className={cn(TH, "text-right")}>Age</th>
              <th className={cn(TH, "text-right")}>Cost</th>
              <th className={cn(TH, "text-right")}>Duration</th>
            </tr>
          </thead>
          <tbody>
            {runs.data.items.map((r) => (
              <RunRow key={r.runId} run={r} />
            ))}
          </tbody>
        </table>
      )}

      {runs.data && runs.data.total > runs.data.items.length && (
        <Pager page={runs.data} onChange={setFilters} />
      )}
    </div>
  );
}

function RunRow({ run }: { run: RunSummary }) {
  const num = cn(TD, "text-right whitespace-nowrap font-mono text-[13px]");
  return (
    <tr className={cn("hover:bg-muted/50", run.stale && "opacity-55")}>
      <td className={TD}>
        <Link
          to="/runs/$runId"
          params={{ runId: run.runId }}
          className="font-mono text-[13px] font-medium text-primary hover:underline"
        >
          {run.slug}
        </Link>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>{run.requestedBy ?? "unattributed"}</span>
          {run.pr !== null && <span className="font-mono">#{run.pr}</span>}
          {run.parityError && (
            <Badge tone="warn" title={run.parityError}>
              parity
            </Badge>
          )}
        </div>
      </td>
      <td className={TD}>
        <span
          className={cn(
            "font-mono text-xs",
            isTerminal(run.step) ? "text-muted-foreground" : "font-semibold text-live",
          )}
        >
          {run.step}
        </span>
      </td>
      <td className={TD}>
        <Pipeline step={run.step} />
      </td>
      <td className={num}>{run.round}</td>
      <td className={TD}>
        <Badge>{run.tier}</Badge>
      </td>
      <td className={num} title={run.startedAt}>
        {age(run.startedAt)}
      </td>
      <td className={num}>{cost(run.costUsd)}</td>
      <td className={num}>{duration(run.durationMs)}</td>
    </tr>
  );
}

function Pager({
  page,
  onChange,
}: {
  page: { total: number; limit: number; offset: number };
  onChange: (next: Partial<RunFilters>) => void;
}) {
  const from = page.offset + 1;
  const to = Math.min(page.offset + page.limit, page.total);
  return (
    <div className="mt-4 flex items-center gap-3">
      <Button
        variant="outline"
        size="sm"
        disabled={page.offset === 0}
        onClick={() => onChange({ offset: Math.max(0, page.offset - page.limit) })}
      >
        ← Prev
      </Button>
      <span className="text-xs text-muted-foreground">
        {from}–{to} of {page.total}
      </span>
      <Button
        variant="outline"
        size="sm"
        disabled={to >= page.total}
        onClick={() => onChange({ offset: page.offset + page.limit })}
      >
        Next →
      </Button>
    </div>
  );
}
