// dashboard.ts — lightweight web dashboard for care-loop runs.
// Zero external dependencies: uses node:http + node:fs to serve a self-contained HTML page
// and JSON API endpoints over the runs directory.

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Journal } from "./journal.js";
import { projectState } from "./state.js";
import { renderEvent } from "./render.js";
import type { CareState } from "./state.js";
import type { JournalEvent } from "./journal.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface RunSummary {
  name: string;
  state: CareState | null;
  eventCount: number;
  lastCost: number | null;
  startedAt: string | null;
  durationMs: number | null;
  stale: boolean;
  error?: string;
}

interface RunDetail {
  name: string;
  state: CareState | null;
  events: (JournalEvent & { rendered: string })[];
  truncatedTail: boolean;
  error?: string;
}

function discoverRuns(runsDir: string, includeStale: boolean): string[] {
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir)
    .filter((d) => {
      if (d.startsWith(".")) return false;
      if (!includeStale && d.includes(".stale-")) return false;
      const p = join(runsDir, d);
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

function summarizeRun(runsDir: string, name: string): RunSummary {
  const dir = join(runsDir, name);
  const journalPath = join(dir, "journal.jsonl");
  const stale = name.includes(".stale-");

  if (!existsSync(journalPath)) {
    return {
      name,
      state: null,
      eventCount: 0,
      lastCost: null,
      startedAt: null,
      durationMs: null,
      stale,
    };
  }

  try {
    const j = new Journal(journalPath, name);
    const { events } = j.read();
    const state = events.length > 0 ? projectState(events) : null;
    // Sum individual cost_usd from every skill.result event — works on both old journals
    // (where cost_cum was not accumulating correctly) and new ones.
    const totalCost = events.reduce((sum, e) => {
      const c =
        e.event === "skill.result"
          ? (e.data?.cost_usd as number | undefined)
          : undefined;
      return sum + (typeof c === "number" ? c : 0);
    }, 0);
    const startedAt = events.length > 0 ? events[0].ts : null;
    const lastTs = events.length > 0 ? events[events.length - 1].ts : null;
    const durationMs =
      startedAt && lastTs
        ? new Date(lastTs).getTime() - new Date(startedAt).getTime()
        : null;
    return {
      name,
      state,
      eventCount: events.length,
      lastCost: totalCost > 0 ? totalCost : null,
      startedAt,
      durationMs,
      stale,
    };
  } catch (err) {
    return {
      name,
      state: null,
      eventCount: 0,
      lastCost: null,
      startedAt: null,
      durationMs: null,
      stale,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function detailRun(runsDir: string, name: string): RunDetail {
  const dir = join(runsDir, name);
  const journalPath = join(dir, "journal.jsonl");

  if (!existsSync(journalPath)) {
    return {
      name,
      state: null,
      events: [],
      truncatedTail: false,
      error: "no journal",
    };
  }

  try {
    const j = new Journal(journalPath, name);
    const { events, truncatedTail } = j.read();
    const state = events.length > 0 ? projectState(events) : null;
    const rendered = events.map((e) => ({ ...e, rendered: renderEvent(e) }));
    return { name, state, events: rendered, truncatedTail };
  } catch (err) {
    return {
      name,
      state: null,
      events: [],
      truncatedTail: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-cache",
  });
  res.end(body);
}

function html(res: ServerResponse, body: string): void {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-cache",
  });
  res.end(body);
}

export function startDashboard(runsDir: string, port: number): void {
  const absRunsDir = resolve(runsDir);
  const htmlPath = join(__dirname, "dashboard.html");

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const path = url.pathname;

    // API: list runs
    if (path === "/api/runs") {
      const includeStale = url.searchParams.get("stale") === "1";
      const names = discoverRuns(absRunsDir, includeStale);
      const summaries = names.map((n) => summarizeRun(absRunsDir, n));
      json(res, summaries);
      return;
    }

    // API: run detail
    const detailMatch = path.match(/^\/api\/runs\/([^/]+)$/);
    if (detailMatch) {
      const name = decodeURIComponent(detailMatch[1]);
      const dir = join(absRunsDir, name);
      if (!existsSync(dir)) {
        json(res, { error: "not found" }, 404);
        return;
      }
      json(res, detailRun(absRunsDir, name));
      return;
    }

    // Serve HTML
    if (path === "/" || path === "/index.html") {
      try {
        const page = readFileSync(htmlPath, "utf8");
        html(res, page);
      } catch {
        res.writeHead(500);
        res.end("dashboard.html not found next to dashboard.ts");
      }
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });

  server.listen(port, () => {
    console.log(`care-loopd dashboard: http://localhost:${port}`);
    console.log(`  runs dir: ${absRunsDir}`);
    console.log(`  press Ctrl+C to stop`);
  });
}
