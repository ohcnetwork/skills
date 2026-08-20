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
import { SessionStore } from "./auth.js";
import { QueueStore } from "./queue.js";
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
  const here = dirname(fileURLToPath(import.meta.url));
  const defaultStatic = join(here, "../../../web/dist");
  const staticDir = o.staticDir ?? (existsSync(defaultStatic) ? defaultStatic : undefined);
  const app = buildApp({
    index,
    sessions,
    queue,
    version: o.version ?? packageVersion(),
    secureCookies: o.secureCookies ?? false,
    staticDir,
  });
  const host = o.host ?? "127.0.0.1";
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

  const shutdown = (): void => {
    if (timer) clearInterval(timer);
    server.close(() => {
      index.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return server;
}
