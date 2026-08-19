// service/app.ts — the Express application ([[PLAN-loop-service]] §6, build step 1).
//
// Read routes only, and the reads go through `RunIndex`, which is DB-only: no route touches a run
// directory, a journal.jsonl, or a state.json. The frontend in turn talks only to this API. Three
// layers, each with exactly one thing below it.
//
// `buildApp` takes its dependencies rather than opening them, so tests drive a real Express app over
// an in-memory database with no server, no port, and no fixture directory.

import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { ApiError, notFound, sendError } from "./errors.js";
import { identity } from "./identity.js";
import { bool, int, str, strList } from "./query.js";
import { isValidRunId } from "../run-id.js";
import type { RunIndex } from "../run-index.js";

export interface AppDeps {
  index: RunIndex;
  /** Reported by `/api/health` so a deploy can be identified without shelling into the box. */
  version?: string;
}

/** Wrap a handler so a thrown ApiError becomes its response. Express 5 forwards rejected promises to
 *  the error middleware, but these handlers are synchronous and this keeps the intent local. */
function route(fn: (req: Request, res: Response) => void) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      fn(req, res);
    } catch (err) {
      next(err);
    }
  };
}

/** Every `:id` in this API is a run_id. Validating the SHAPE here means an obviously-malformed id is
 *  a 400 (the caller's mistake) while a well-formed unknown one is a 404 (a real lookup that missed)
 *  — a distinction the frontend needs in order to tell a broken link from a deleted run. */
function runIdParam(req: Request): string {
  const raw = req.params.id;
  const id = Array.isArray(raw) ? raw[0] : raw;
  if (typeof id !== "string" || !isValidRunId(id))
    throw new ApiError(400, "bad_run_id", `'${String(id)}' is not a valid run id`);
  return id;
}

export function buildApp(deps: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use(identity());

  app.get(
    "/api/health",
    route((_req, res) => {
      // Actually touch the database rather than reporting a cached flag: "the process is up" is not
      // the question anyone asks health for.
      let db = false;
      try {
        deps.index.count({ limit: 1 });
        db = true;
      } catch (err) {
        console.error("[service] health: db unreachable:", err);
      }
      res.status(db ? 200 : 503).json({
        ok: db,
        db,
        supervisor: null, // populated at step 4, when there is one
        version: deps.version ?? null,
      });
    }),
  );

  app.get(
    "/api/me",
    route((req, res) => {
      res.json({ login: req.user });
    }),
  );

  app.get(
    "/api/runs",
    route((req, res) => {
      const q = req.query as Record<string, unknown>;
      const filter = {
        requestedBy: str(q, "requested_by"),
        repo: str(q, "repo"),
        branch: str(q, "branch"),
        step: str(q, "step"),
        active: bool(q, "active"),
        includeStale: bool(q, "stale") ?? false,
        limit: int(q, "limit"),
        offset: int(q, "offset"),
      };
      const items = deps.index.list(filter);
      res.json({
        items,
        total: deps.index.count(filter),
        limit: filter.limit ?? null,
        offset: filter.offset ?? 0,
      });
    }),
  );

  app.get(
    "/api/runs/:id",
    route((req, res) => {
      const id = runIdParam(req);
      const run = deps.index.get(id);
      if (!run) throw notFound("run_not_found", `no run ${id}`);
      // `queue` is null until step 3 builds the table. Present in the shape from day one so the
      // frontend's type does not change when it starts arriving.
      res.json({ run, queue: null });
    }),
  );

  app.get(
    "/api/runs/:id/events",
    route((req, res) => {
      const id = runIdParam(req);
      // A run with zero events is indistinguishable from a missing one on this route unless the run
      // is checked first — and "no events yet" is the normal state of a run that just started.
      if (!deps.index.get(id)) throw notFound("run_not_found", `no run ${id}`);
      const q = req.query as Record<string, unknown>;
      const page = deps.index.events(id, {
        afterSeq: int(q, "after_seq"),
        events: strList(q, "event"),
        limit: int(q, "limit"),
      });
      res.json({ items: page.items, next_seq: page.nextSeq });
    }),
  );

  app.use((_req, res) => {
    sendError(res, notFound("not_found", "no such route"));
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    sendError(res, err);
  });

  return app;
}
