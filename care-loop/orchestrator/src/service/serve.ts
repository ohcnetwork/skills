// Opens the db, builds the app, listens. Separated from `app.ts` so the app itself never opens a
// connection or binds a port — this file is the only place with I/O.

import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { buildApp } from "./app.js";
import { SqliteRunIndex } from "../run-index.js";
import { applyConnectionPragmas } from "../run-store.js";
import { SessionStore } from "./auth.js";
import { QueueStore } from "./queue.js";
import { GateStore } from "./gate-store.js";
import { Supervisor } from "./supervisor.js";
import { backupNow, integrityCheck } from "./backup.js";

export interface ServeOptions {
  dbPath: string;
  port: number;
  /** Loopback by default: this service has no authentication, so exposing it on all interfaces must
   *  be a deliberate act. */
  host?: string;
  version?: string;
  /** Mark session cookies `Secure` — set wherever TLS terminates in front of this. */
  secureCookies?: boolean;
  /** Defaults to `../web/dist` when it exists, so a dev checkout without one runs API-only. */
  staticDir?: string;
  /** Where `VACUUM INTO` snapshots go. Defaults to `<db dir>/backups`. */
  backupDir?: string;
  /** Snapshot interval. Defaults to 6h; 0 disables the timer (a snapshot is still taken at boot). */
  backupIntervalMs?: number;
  /** Snapshots to retain. Default 7. */
  backupKeep?: number;
  /** Repos a run may be requested against. Defaults to the one this exists for. */
  allowedRepos?: string[];
  /** Off by default: two `serve` processes on one db must not both claim, and a read-only dashboard
   *  is a reasonable thing to run. `POST /api/runs` returns 503 while it is off, rather than banking
   *  rows nothing consumes. */
  supervise?: boolean;
  /** Max concurrent children. Each is a worktree plus an opencode session plus Copilot credits. */
  concurrency?: number;
  /** Defaults to the db's own directory, where `reindex` and the CLI already put them. */
  runsDir?: string;
  /** The main checkout worktrees branch from, passed to each child as `--main`. */
  mainRepoPath?: string;
}

/** For `/api/health`, so a deploy can be identified without shelling into the box. */
function packageVersion(): string | undefined {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "../../package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version;
  } catch {
    return undefined;
  }
}

export function startService(o: ServeOptions): Server {
  if (!existsSync(o.dbPath))
    throw new Error(
      `no database at ${o.dbPath} — run \`care-loopd reindex\` first to build it from the journals`,
    );
  // Read-write: the run tables are still written only by the child that owns the run, but
  // users/sessions/queue/gate_asks are service-owned. WAL arbitrates between the two writers.
  const db = new DatabaseSync(o.dbPath);
  applyConnectionPragmas(db);

  const integrity = integrityCheck(db);
  if (!integrity.ok) {
    console.error("[service] PRAGMA integrity_check FAILED — serving anyway:");
    for (const p of integrity.problems.slice(0, 10)) console.error(`  ${p}`);
    console.error("  recover with: care-loopd reindex  (rebuilds the run tables from the journals)");
    console.error("  NOTE: queue/users/sessions have no journal behind them — restore from backups/");
  }

  const index = new SqliteRunIndex(db);
  const sessions = new SessionStore(db);
  const queue = new QueueStore(db);
  const gates = new GateStore(db);
  const here = dirname(fileURLToPath(import.meta.url));
  const defaultStatic = join(here, "../../../web/dist");
  const staticDir = o.staticDir ?? (existsSync(defaultStatic) ? defaultStatic : undefined);
  const runsDir = o.runsDir ?? dirname(o.dbPath);
  // Constructed even when supervision is off, so the enqueue gate can report the real reason.
  const supervisor = new Supervisor({
    queue,
    runsDir,
    concurrency: o.concurrency,
    mainRepoPath: o.mainRepoPath,
  });
  if (o.supervise) supervisor.start();

  const app = buildApp({
    index,
    sessions,
    queue,
    gates,
    supervisor,
    version: o.version ?? packageVersion(),
    secureCookies: o.secureCookies ?? false,
    staticDir,
    allowedRepos: o.allowedRepos,
  });
  const host = o.host ?? "127.0.0.1";
  const server = app.listen(o.port, host, () => {
    console.log(
      `care-loop service: http://${host}:${o.port}  (db: ${o.dbPath})` +
        (staticDir ? `  serving ${staticDir}` : "  API only — no web/dist built"),
    );
  });
  const backupDir = o.backupDir ?? join(dirname(o.dbPath), "backups");
  const keep = o.backupKeep ?? 7;
  const runBackup = (): void => {
    try {
      const path = backupNow(db, { dir: backupDir, keep });
      console.log(`[service] backup ${path}`);
    } catch (err) {
      // The safety net, not the thing being protected: never take the service down with it.
      console.error("[service] backup failed:", err);
    }
  };
  runBackup(); // at boot, so a fresh deploy is covered before it takes requests
  const intervalMs = o.backupIntervalMs ?? 6 * 60 * 60 * 1000;
  const timer = intervalMs > 0 ? setInterval(runBackup, intervalMs) : null;
  timer?.unref(); // must not hold the process open at shutdown

  // EADDRINUSE arrives as an event, not a throw; unhandled it is a stack trace where "port in use"
  // is the entire useful content.
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE")
      console.error(`care-loop service: port ${o.port} is already in use on ${host}`);
    else console.error("care-loop service: listen failed:", err);
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (timer) clearInterval(timer);
    // Stops claiming without killing the children: a restart must not abort every teammate's run,
    // and `reconcile` re-adopts them at boot.
    supervisor.stop();
    server.close(() => {
      index.close();
      process.exit(0);
    });
    // `server.close` waits for IDLE keep-alive sockets too, so one dashboard left open on a second
    // monitor is enough for SIGTERM never to complete and systemd to SIGKILL on every restart.
    server.closeAllConnections();
    setTimeout(() => process.exit(1), 10_000).unref(); // backstop
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return server;
}
