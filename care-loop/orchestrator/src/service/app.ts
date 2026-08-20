// service/app.ts — the Express application ([[PLAN-loop-service]] §6, build step 1).
//
// Read routes only, and the reads go through `RunIndex`, which is DB-only: no route touches a run
// directory, a journal.jsonl, or a state.json. The frontend in turn talks only to this API. Three
// layers, each with exactly one thing below it.
//
// `buildApp` takes its dependencies rather than opening them, so tests drive a real Express app over
// an in-memory database with no server, no port, and no fixture directory.

import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { ApiError, badRequest, notFound, sendError } from "./errors.js";
import { identity } from "./identity.js";
import {
  clearedCookie,
  isValidLogin,
  sessionCookie,
  type SessionStore,
} from "./auth.js";
import { bool, int, str, strList } from "./query.js";
import { isValidRunId } from "../run-id.js";
import {
  resolvePaging,
  LIST_ORDERS,
  type ListFilter,
  type ListOrder,
  type RunIndex,
} from "../run-index.js";

export interface AppDeps {
  index: RunIndex;
  sessions: SessionStore;
  /** Reported by `/api/health` so a deploy can be identified without shelling into the box. */
  version?: string;
  /** Mark the session cookie `Secure`. Off by default because the service binds loopback over plain
   *  HTTP; turn it on wherever TLS terminates. */
  secureCookies?: boolean;
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
/** Read every list filter off the query string, in one place, so `/runs` and `/runs/facets` cannot
 *  drift apart in what they accept. */
function listFilterFrom(req: Request): ListFilter {
  const q = req.query as Record<string, unknown>;
  const order = str(q, "order");
  if (order !== undefined && !LIST_ORDERS.includes(order as ListOrder))
    throw badRequest("bad_query", `order must be one of ${LIST_ORDERS.join(", ")}`);
  const dir = str(q, "dir");
  if (dir !== undefined && dir !== "asc" && dir !== "desc")
    throw badRequest("bad_query", "dir must be asc or desc");

  // `requested_by=me` resolves to the caller. A CONVENIENCE, not a permission — §6 is explicit that
  // no route may make an authorization decision, and this one does not: it expands to a filter value
  // the caller could have typed themselves. Requiring a session for it would be a gate, so when
  // nobody is signed in it 400s as a malformed filter rather than 401ing.
  let requestedBy = str(q, "requested_by");
  if (requestedBy === "me") {
    if (!req.user)
      throw badRequest("bad_query", "requested_by=me needs a signed-in caller or an X-Care-User header");
    requestedBy = req.user;
  }

  return {
    requestedBy,
    repo: str(q, "repo"),
    branch: str(q, "branch"),
    step: str(q, "step"),
    ticket: str(q, "ticket"),
    pr: int(q, "pr"),
    q: str(q, "q"),
    since: str(q, "since"),
    until: str(q, "until"),
    active: bool(q, "active"),
    includeStale: bool(q, "stale") ?? false,
    order: order as ListOrder | undefined,
    dir: dir as "asc" | "desc" | undefined,
    limit: int(q, "limit", { min: 1 }),
    offset: int(q, "offset"),
  };
}

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
  app.use(identity(deps.sessions));

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

  // ── auth ────────────────────────────────────────────────────────────────────────────────────
  // Not authentication yet: logging in means CLAIMING a login, and nothing verifies it (§6). The
  // shape is what matters — swapping in GitHub OAuth replaces the body of this one handler and
  // leaves /auth/me, /auth/logout, the middleware, and every other route untouched.

  app.post(
    "/api/auth/login",
    route((req, res) => {
      const body = (req.body ?? {}) as { login?: unknown };
      const login = typeof body.login === "string" ? body.login.trim() : "";
      if (!login) throw badRequest("bad_login", "login is required");
      if (!isValidLogin(login))
        throw badRequest(
          "bad_login",
          `'${login}' is not a valid GitHub login (1-39 chars, alphanumeric or single hyphens)`,
        );
      const { user, token } = deps.sessions.login(login);
      res.setHeader("Set-Cookie", sessionCookie(token, { secure: deps.secureCookies ?? false }));
      res.status(201).json({ user });
    }),
  );

  app.post(
    "/api/auth/logout",
    route((req, res) => {
      // Idempotent: signing out twice, or with a stale cookie, succeeds. Clearing the cookie matters
      // more than whether a row was updated — the client must not keep sending a dead token.
      if (req.sessionToken) deps.sessions.revoke(req.sessionToken);
      res.setHeader("Set-Cookie", clearedCookie({ secure: deps.secureCookies ?? false }));
      res.status(204).end();
    }),
  );

  app.get(
    "/api/auth/me",
    route((req, res) => {
      // 200-with-null rather than 401: "who am I" is answerable when the answer is "nobody", and it
      // lets the frontend decide between a login screen and a dashboard from one unconditional call.
      res.json({ login: req.user, account: req.account });
    }),
  );

  app.get(
    "/api/runs",
    route((req, res) => {
      const filter = listFilterFrom(req);
      // Echo the EFFECTIVE paging, not what was asked for: `?limit=999` serves 200 rows, and a
      // response claiming 999 would make `offset += limit` skip 799 of them without erroring.
      const applied = resolvePaging(filter);
      res.json({
        items: deps.index.list(filter),
        total: deps.index.count(filter),
        limit: applied.limit,
        offset: applied.offset,
      });
    }),
  );

  app.get(
    "/api/runs/facets",
    route((req, res) => {
      // Declared BEFORE /api/runs/:id — Express matches in order, and "facets" is a valid-looking
      // path segment that would otherwise be caught by the :id route and rejected as a bad run id.
      res.json(deps.index.facets(listFilterFrom(req)));
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
        limit: int(q, "limit", { min: 1 }),
      });
      res.json({ items: page.items, next_seq: page.nextSeq });
    }),
  );

  app.get(
    "/api/runs/:id/artifacts",
    route((req, res) => {
      const id = runIdParam(req);
      if (!deps.index.get(id)) throw notFound("run_not_found", `no run ${id}`);
      // Metadata only. A run's artifacts total ~160 KB and a timeline view wants the links, not the
      // bodies — streaming every skill envelope to render a list would be the wrong default.
      res.json({ items: deps.index.artifacts(id) });
    }),
  );

  app.get(
    "/api/runs/:id/artifacts/:sha",
    route((req, res) => {
      const id = runIdParam(req);
      const raw = req.params.sha;
      const sha = Array.isArray(raw) ? raw[0] : raw;
      // Validate the shape before it reaches SQL, and so a typo is a 400 rather than an empty 404
      // the caller has to guess at.
      if (typeof sha !== "string" || !/^(sha256:)?[0-9a-f]{64}$/.test(sha))
        throw new ApiError(400, "bad_sha", `'${String(sha)}' is not a sha256 hex digest`);
      if (!deps.index.get(id)) throw notFound("run_not_found", `no run ${id}`);
      const found = deps.index.artifact(id, sha);
      if (!found) throw notFound("artifact_not_found", `run ${id} has no artifact ${sha}`);
      res.json(found);
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
