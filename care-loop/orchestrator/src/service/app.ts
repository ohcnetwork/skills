// service/app.ts — the Express application ([[PLAN-loop-service]] §6, build step 1).
//
// Read routes only, and the reads go through `RunIndex`, which is DB-only: no route touches a run
// directory, a journal.jsonl, or a state.json. The frontend in turn talks only to this API. Three
// layers, each with exactly one thing below it.
//
// `buildApp` takes its dependencies rather than opening them, so tests drive a real Express app over
// an in-memory database with no server, no port, and no fixture directory.

import { join } from "node:path";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { ApiError, badRequest, notFound, sendError } from "./errors.js";
import { identity, requireUser } from "./identity.js";
import {
  clearedCookie,
  isValidLogin,
  sessionCookie,
  type SessionStore,
} from "./auth.js";
import { bool, int, str, strList } from "./query.js";
import type { GateAsk, GateStore } from "./gate-store.js";
import {
  LIVE_STATUSES,
  QUEUE_STATUSES,
  resolveQueuePaging,
  type QueueStatus,
  type QueueStore,
} from "./queue.js";
import { validateSeed } from "../front-terminal.js";
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
  queue: QueueStore;
  /** The plan gate (§7). The child posts asks and polls for answers against the same table; this side
   *  only ever reads an ask and writes an answer. */
  gates: GateStore;
  /** Set once a supervisor is running (step 4). Until then `POST /api/runs` refuses rather than
   *  banking work nothing will ever execute — a queued row with no consumer is a silent black hole,
   *  and the person who asked for the run has no way to tell it apart from a slow start. */
  supervisor?: {
    running: boolean;
    /** `cancelled: false` means the row was already terminal — a finished run cannot be un-run, and
     *  saying so beats a 202 that did nothing. */
    cancel(runId: string): { cancelled: boolean; signalled: boolean };
  } | null;
  /** Repos a run may be requested against. An allowlist rather than free text: `repo` reaches
   *  `git worktree add` and a GitHub API call, and "whatever the client sent" is not a good input to
   *  either. Defaults to the one repo this exists for. */
  allowedRepos?: string[];
  /** Reported by `/api/health` so a deploy can be identified without shelling into the box. */
  version?: string;
  /** Mark the session cookie `Secure`. Off by default because the service binds loopback over plain
   *  HTTP; turn it on wherever TLS terminates. */
  secureCookies?: boolean;
  /** Built frontend to serve (`web/dist`). When set, the API and the app share ONE origin and one
   *  port — which is what lets the session cookie be plain same-origin with no CORS anywhere. */
  staticDir?: string;
}

/** The gate answer for an `approve` ask. Validated here rather than trusted, because it reaches
 *  `runPlan`'s decision branch — where `approve` authorizes a push to origin. */
function parseDecision(body: Record<string, unknown>): {
  decision: "approve" | "reject" | "amend";
  amendment?: string;
} {
  const decision = body.decision;
  if (decision === "approve" || decision === "reject") return { decision };
  if (decision === "amend") {
    const amendment = typeof body.amendment === "string" ? body.amendment.trim() : "";
    // An empty amendment is what the terminal gate re-prompts for: it would send the planner off to
    // re-draft against no instruction, burning a model call to produce the same plan.
    if (!amendment) throw badRequest("bad_amendment", "amend requires a non-empty amendment");
    return { decision, amendment };
  }
  throw badRequest("bad_decision", "decision must be approve, reject, or amend");
}

/** The gate answer for an `interview` ask: one entry per question, correlated by the stable
 *  `PlanQuestion.id` the child posted. */
function parseAnswers(
  body: Record<string, unknown>,
  questions: { id: string }[],
): { id: string; answer: string }[] {
  const raw = body.answers;
  if (!Array.isArray(raw)) throw badRequest("bad_request", "answers must be an array");
  const byId = new Map<string, string>();
  for (const entry of raw as Record<string, unknown>[]) {
    if (typeof entry?.id !== "string" || typeof entry?.answer !== "string")
      throw badRequest("bad_request", "each answer needs a string id and a string answer");
    byId.set(entry.id, entry.answer);
  }
  // Every question, in the order asked. A partial set would reach the planner as a silently shorter
  // interview rather than as an error, and the plan would be drafted against the gaps.
  return questions.map((q) => {
    const answer = byId.get(q.id);
    if (answer === undefined) throw badRequest("bad_request", `no answer for question '${q.id}'`);
    return { id: q.id, answer };
  });
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
  // /api/health is registered BEFORE identity() on purpose: health is precisely the route that must
  // answer when the database is unhappy, and identity touches the db. With it behind the middleware,
  // a dead db plus a cookie produced `500 internal` where a dead db alone correctly produced
  // `503 {ok:false}` — the diagnostic route failing in the manner it exists to report.
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
        supervisor: deps.supervisor?.running ?? false,
        version: deps.version ?? null,
      });
    }),
  );

  app.use(identity(deps.sessions));

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

  app.post(
    "/api/runs",
    route((req, res) => {
      // The first route that needs to know WHO — every run is attributed, and an unattributed row
      // would be a request nobody can be asked about. Still not authorization: it asks that the
      // caller said who they are, never what they are allowed to do.
      const requestedBy = requireUser(req);
      if (!deps.supervisor?.running)
        throw new ApiError(
          503,
          "no_supervisor",
          "no supervisor is running, so a queued run would never start — enqueueing is disabled",
        );
      const body = (req.body ?? {}) as Record<string, unknown>;

      const allowed = deps.allowedRepos ?? ["ohcnetwork/care_fe"];
      const repo = typeof body.repo === "string" && body.repo.trim() ? body.repo.trim() : allowed[0]!;
      if (!allowed.includes(repo))
        throw badRequest("bad_repo", `repo must be one of ${allowed.join(", ")}`);

      // Validated with the LOOP's own rules (front-terminal.ts#validateSeed), not a second copy of
      // them. A ticket that would fail the [ENG-###] PR-title assert, or a branch `git worktree add`
      // would reject, fails here — while a human is looking at the form — instead of hours later
      // inside a spawned child.
      const seed: Record<string, string> = {};
      for (const key of ["task", "ticket", "branch", "summary"] as const) {
        const raw = body[key];
        if (typeof raw !== "string" || raw.trim() === "")
          throw badRequest("bad_request", `${key} is required`);
        const parsed = validateSeed(key, raw);
        if ("error" in parsed) throw badRequest(`bad_${key}`, parsed.error);
        seed[key] = parsed.value;
      }

      const row = deps.queue.enqueue({
        requestedBy,
        repo,
        branch: seed.branch!,
        task: seed.task!,
        ticket: seed.ticket!,
        summary: seed.summary!,
      });

      // Report why this will not start immediately, rather than refusing. The row is queued either
      // way and becomes claimable when the blocker clears (§12: queue behind, don't reject) — but the
      // caller deserves to know, and the two reasons are genuinely different:
      //
      //  - `blocked_by_branch` — another live run owns this (repo, branch), so this one waits for THAT
      //    run specifically. `liveOn` returns the oldest live row on the branch, which is our own when
      //    nothing else holds it, so a different run id is exactly the signal.
      //  - `queue_position` — rows ahead of us in line. This is the far more common reason with a
      //    concurrency cap of 2 and five queued branches, and reporting only the first would tell
      //    three of those five callers `null` and let them expect an immediate start.
      const ahead = deps.queue.liveOn(repo, seed.branch!);
      res.status(201).json({
        run_id: row.runId,
        queue_id: row.id,
        blocked_by_branch: ahead && ahead.runId !== row.runId ? ahead.runId : null,
        queue_position: deps.queue.position(row.runId) ?? 0,
      });
    }),
  );

  app.get(
    "/api/queue",
    route((req, res) => {
      const q = req.query as Record<string, unknown>;
      const requested = strList(q, "status");
      for (const st of requested ?? [])
        if (!QUEUE_STATUSES.includes(st as QueueStatus))
          throw badRequest("bad_query", `status must be one of ${QUEUE_STATUSES.join(", ")}`);
      // Defaults to the live rows: "what is the queue doing" is the question this answers, and a
      // month of finished rows buries it.
      const filter = {
        status: (requested as QueueStatus[] | undefined) ?? [...LIVE_STATUSES],
        requestedBy: str(q, "requested_by"),
        repo: str(q, "repo"),
        branch: str(q, "branch"),
        limit: int(q, "limit", { min: 1 }),
        offset: int(q, "offset", { min: 0 }),
      };
      // The same `{items, total, limit, offset}` envelope as every other list route (§6): a bare
      // array cannot grow pagination later without breaking every client, which is the whole reason
      // the convention exists — and this was the one route that had drifted from it.
      const applied = resolveQueuePaging(filter);
      res.json({
        items: deps.queue.list(filter),
        total: deps.queue.count(filter),
        limit: applied.limit,
        offset: applied.offset,
      });
    }),
  );

  app.get(
    "/api/stats",
    route((_req, res) => {
      const byStep: Record<string, number> = {};
      for (const f of deps.index.facets({}).steps) byStep[f.value] = f.count;
      // Counted in SQL, not by filtering a page of rows — the previous version silently stopped
      // being a total the moment the queue outgrew one page.
      const counts = deps.queue.statusCounts();
      res.json({
        runs: deps.index.count({}),
        active: deps.index.count({ active: true }),
        by_step: byStep,
        queue: { pending: counts.pending, running: counts.running },
      });
    }),
  );

  app.post(
    "/api/runs/:id/cancel",
    route((req, res) => {
      // Attributed, like every write. Not restricted to the requester: this is a shared box with a
      // shared concurrency cap, and a run wedged on someone's day off has to be stoppable by whoever
      // is at the keyboard. Authorization arrives with real auth, not before it.
      requireUser(req);
      const id = runIdParam(req);
      if (!deps.supervisor)
        throw new ApiError(503, "no_supervisor", "no supervisor is running — nothing can be cancelled");
      const row = deps.queue.byRunId(id);
      if (!row) throw notFound("run_not_found", `no queued run ${id}`);

      // ONE route for both states (§6). Minting `run_id` at enqueue means a request has a stable id
      // before it has a process, so the caller never has to know whether it caught the run pending or
      // running — the distinction it is least able to make without a race.
      const { cancelled, signalled } = deps.supervisor.cancel(id);
      if (!cancelled)
        throw badRequest("not_cancellable", `run ${id} is already ${row.status}`);

      // 202, not 204: the row is cancelled for certain, but a running child exits on its own schedule
      // after SIGTERM. Claiming completion here would be a lie the FE would render as a finished run
      // seconds before the process actually stops.
      res.status(202).json({ run_id: id, cancelled: true, signalled });
    }),
  );

  const askView = (a: GateAsk): Record<string, unknown> => ({
    run_id: a.runId,
    ask_id: a.askId,
    kind: a.kind,
    payload: a.payload,
    asked_at: a.askedAt,
    expires_at: a.expiresAt,
  });

  app.get(
    "/api/gates",
    route((_req, res) => {
      // The needs-you list. Not in §6's original table, but a gate that nobody sees is a gate that
      // expires — and expiry is the one outcome here that throws away finished planning work.
      const items = deps.gates.pendingRuns();
      res.json({ items: items.map(askView), total: items.length });
    }),
  );

  app.get(
    "/api/runs/:id/gate",
    route((req, res) => {
      const id = runIdParam(req);
      const ask = deps.gates.pending(id);
      // `null`, not 404: "this run has no open question" is a normal answer to a poll, and the FE
      // asks it of every run it shows. A 404 would make the ordinary case look like an error.
      res.json({ ask: ask ? askView(ask) : null });
    }),
  );

  app.post(
    "/api/runs/:id/gate",
    route((req, res) => {
      // Attributed, and separately from `requested_by`: the person who approves a plan is not always
      // the person who requested it, and at a gate that distinction is the interesting one.
      const answeredBy = requireUser(req);
      const id = runIdParam(req);
      const ask = deps.gates.pending(id);
      if (!ask) throw notFound("gate_not_found", `run ${id} has no open gate`);

      const body = (req.body ?? {}) as Record<string, unknown>;
      const answer =
        ask.kind === "approve"
          ? parseDecision(body)
          : parseAnswers(body, ask.payload as { id: string }[]);

      const { answered, readmitted } = deps.gates.answerAndReadmit(id, ask.askId, answer, answeredBy);
      // Two people had the gate view open. The loser must learn they did not unblock the run rather
      // than believe they did.
      if (!answered) throw new ApiError(409, "gate_already_settled", `gate ${ask.askId} was already answered or cancelled`);

      // 202: the answer is committed, but the run restarts on the supervisor's next tick.
      res.status(202).json({ run_id: id, ask_id: ask.askId, readmitted });
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
      // The queue row is null for a run started from the CLI, which never went through the service.
      // That is a real and permanent case, not a gap — the child is the same binary either way.
      res.json({ run, queue: deps.queue.byRunId(id) });
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

  // Unmatched /api paths are a 404 in the API's own envelope. Scoped to /api so it cannot swallow
  // the frontend's client-side routes below.
  app.use("/api", (_req, res) => {
    sendError(res, notFound("not_found", "no such route"));
  });

  if (deps.staticDir) {
    app.use(express.static(deps.staticDir, { index: false }));
    // SPA fallback: `/runs/<id>` is a client-side route, so a direct hit or a refresh must return
    // index.html rather than 404.
    //
    // Anything that LOOKS like a file (has an extension) is excluded, and that exclusion is the whole
    // point: without it a missing `/assets/main.js` answers 200-with-HTML, the browser tries to
    // execute a document as JavaScript, and the resulting MIME error says nothing about the actual
    // problem — a stale asset reference after a redeploy. Client routes have no extension; assets
    // always do.
    app.get(/.*/, (req, res, next) => {
      if (/\.[a-zA-Z0-9]+$/.test(req.path)) return next();
      res.sendFile(join(deps.staticDir!, "index.html"));
    });
  }

  app.use((_req, res) => {
    sendError(res, notFound("not_found", "no such route"));
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    sendError(res, err);
  });

  return app;
}
