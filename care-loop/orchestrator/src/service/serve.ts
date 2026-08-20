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
  const index = new SqliteRunIndex(db);
  const sessions = new SessionStore(db);
  const here = dirname(fileURLToPath(import.meta.url));
  const defaultStatic = join(here, "../../../web/dist");
  const staticDir = o.staticDir ?? (existsSync(defaultStatic) ? defaultStatic : undefined);
  const app = buildApp({
    index,
    sessions,
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
  const shutdown = (): void => {
    server.close(() => {
      index.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return server;
}
