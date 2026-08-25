// service/serve.ts — open the db, build the app, listen ([[PLAN-loop-service]] step 1).
//
// Separated from `app.ts` so the app itself never opens a connection or binds a port: tests get a
// real Express app over an in-memory database, and this file is the only place with I/O.

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
  /** Bind address. Defaults to loopback: this service has no authentication (§6), so exposing it on
   *  all interfaces must be a deliberate act, not the default. */
  host?: string;
  version?: string;
  /** Mark session cookies `Secure` — set wherever TLS terminates in front of this. */
  secureCookies?: boolean;
  /** Built frontend to serve. Defaults to `../web/dist` when it exists, so a built app is served
   *  automatically and a dev checkout without one simply runs API-only. */
  staticDir?: string;
  /** Where `VACUUM INTO` snapshots go. Defaults to `<db dir>/backups`. */
  backupDir?: string;
  /** Snapshot interval. Defaults to 6h; 0 disables the timer (a snapshot is still taken at boot). */
  backupIntervalMs?: number;
  /** Snapshots to retain. Default 7. */
  backupKeep?: number;
  /** Repos a run may be requested against. Defaults to the one this exists for. */
  allowedRepos?: string[];
  /** Claim queued rows and spawn children (§5). OFF by default: `serve` on a laptop next to someone
   *  else's `serve` on the same db must not both start claiming, and a read-only dashboard is a
   *  perfectly good thing to run. `POST /api/runs` refuses while this is off, so the failure mode is
   *  a clear 503 rather than rows nothing consumes. */
  supervise?: boolean;
  /** Max concurrent children. Each is a worktree plus an opencode session plus Copilot credits. */
  concurrency?: number;
  /** Where run directories live. Defaults to the db's own directory, which is where `reindex` and the
   *  CLI already put them. */
  runsDir?: string;
  /** The main checkout worktrees branch from, passed to each child as `--main`. */
  mainRepoPath?: string;
}

/** The running build, for `/api/health`. A version nobody can read off a live deploy is not much of
 *  a version — and this is the only identifying thing the API exposes. */
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
  // READ-WRITE, deliberately — step 1 opened this read-only, which was right while the API only read.
  // Sessions changed that. It does not weaken §3's rule, which is scoped to the RUN tables: those are
  // still written only by the child that owns the run. `users`/`sessions` (and later `queue`/
  // `gate_asks`) are service-owned, and WAL arbitrates the file between the two writers.
  const db = new DatabaseSync(o.dbPath);
  // Per-connection pragmas, applied for THIS connection: `busy_timeout` and friends are not stored in
  // the file, so opening it without them leaves the service taking an immediate SQLITE_BUSY whenever
  // a child holds the write lock. WAL hid this while the service was read-only.
  applyConnectionPragmas(db);

  // Integrity BEFORE serving. Reported, not fatal (backup.ts): a database that still answers most
  // queries beats a service that will not start, and the run tables stay rebuildable with `reindex`.
  // What matters is that someone learns — silent corruption found weeks later, after backups have
  // rotated past the last good snapshot, is the failure this exists to prevent.
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
  // Constructed but not started when supervision is off, so `app.ts` sees `running: false` and the
  // enqueue gate reports the real reason.
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
  // EADDRINUSE arrives as an 'error' EVENT, not a throw: without a handler it surfaces as an
  // unhandled event and a stack trace, where "port 3142 is in use" is the entire useful content.
  const server = app.listen(o.port, host, () => {
    console.log(
      `care-loop service: http://${host}:${o.port}  (db: ${o.dbPath})` +
        (staticDir ? `  serving ${staticDir}` : "  API only — no web/dist built"),
    );
  });
  // Backups exist from this release because `queue` is the first data `reindex` cannot rebuild
  // ([[PLAN-loop-service]] §12). One at boot so a fresh deploy is covered before it takes requests.
  const backupDir = o.backupDir ?? join(dirname(o.dbPath), "backups");
  const keep = o.backupKeep ?? 7;
  const runBackup = (): void => {
    try {
      const path = backupNow(db, { dir: backupDir, keep });
      console.log(`[service] backup ${path}`);
    } catch (err) {
      // A failed snapshot must not take the service down with it — it is the safety net, not the
      // thing being protected.
      console.error("[service] backup failed:", err);
    }
  };
  runBackup();
  const intervalMs = o.backupIntervalMs ?? 6 * 60 * 60 * 1000;
  const timer = intervalMs > 0 ? setInterval(runBackup, intervalMs) : null;
  // unref so a pending backup timer cannot hold the process open at shutdown.
  timer?.unref();

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
    // Stop claiming, but do NOT kill the children: they are independent processes holding their own
    // locks and journals, and a service restart aborting every teammate's run would be a far worse
    // failure than a few minutes of unsupervised children. `reconcile` re-adopts them at boot.
    supervisor.stop();
    server.close(() => {
      index.close();
      process.exit(0);
    });
    // `server.close` waits for IDLE keep-alive sockets too, so one dashboard left open on a second
    // monitor is enough for SIGTERM never to complete and for systemd to SIGKILL on every restart.
    // This gets worse with SSE, where connections stay open by design.
    server.closeAllConnections();
    // Backstop for anything that still refuses to let go.
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return server;
}
