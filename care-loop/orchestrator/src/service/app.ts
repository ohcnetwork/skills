// Reads go through `RunIndex`, which is DB-only: no route touches a run directory, a journal.jsonl,
// or a state.json. `buildApp` takes its dependencies rather than opening them, so tests drive a real
// Express app over an in-memory database with no server and no port.

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
  /** Absent until a supervisor runs, and `POST /api/runs` refuses while it is: a queued row with no
   *  consumer is a black hole the requester cannot tell apart from a slow start. */
  supervisor?: {
    running: boolean;
    /** `cancelled: false` means the row was already terminal. */
    cancel(runId: string): { cancelled: boolean; signalled: boolean };
  } | null;
  /** An allowlist rather than free text: `repo` reaches `git worktree add` and a GitHub API call. */
  allowedRepos?: string[];
  /** Reported by `/api/health` so a deploy can be identified without shelling into the box. */
  version?: string;
  /** Off by default because the service binds loopback over plain HTTP; on wherever TLS terminates. */
  secureCookies?: boolean;
  /** When set, the API and the app share one origin, which is what lets the session cookie be plain
   *  same-origin with no CORS anywhere. */
  staticDir?: string;
}

/** Validated rather than trusted: this reaches `runPlan`, where `approve` authorizes a push. */
function parseDecision(body: Record<string, unknown>): {
  decision: "approve" | "reject" | "amend";
  amendment?: string;
} {
  const decision = body.decision;
  if (decision === "approve" || decision === "reject") return { decision };
  if (decision === "amend") {
    const amendment = typeof body.amendment === "string" ? body.amendment.trim() : "";
    // Without one the planner re-drafts against no instruction, at one model call per lap.
    if (!amendment) throw badRequest("bad_amendment", "amend requires a non-empty amendment");
    return { decision, amendment };
  }
  throw badRequest("bad_decision", "decision must be approve, reject, or amend");
}

/** One entry per question, correlated by the `PlanQuestion.id` the child posted. */
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
  // Every question, in the order asked: a partial set would reach the planner as a silently shorter
  // interview, and the plan would be drafted against the gaps.
  return questions.map((q) => {
    const answer = byId.get(q.id);
    if (answer === undefined) throw badRequest("bad_request", `no answer for question '${q.id}'`);
    return { id: q.id, answer };
  });
}

/** Client-side routes have no extension; assets always do. */
const looksLikeAsset = (path: string): boolean => /\.[a-zA-Z0-9]+$/.test(path);

/** Turns a thrown ApiError into its response. */
function route(fn: (req: Request, res: Response) => void) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      fn(req, res);
    } catch (err) {
      next(err);
    }
  };
}

/** Shared by `/runs` and `/runs/facets` so they cannot drift apart in what they accept. */
function listFilterFrom(req: Request): ListFilter {
  const q = req.query as Record<string, unknown>;
  const order = str(q, "order");
  if (order !== undefined && !LIST_ORDERS.includes(order as ListOrder))
    throw badRequest("bad_query", `order must be one of ${LIST_ORDERS.join(", ")}`);
  const dir = str(q, "dir");
  if (dir !== undefined && dir !== "asc" && dir !== "desc")
    throw badRequest("bad_query", "dir must be asc or desc");

  // A convenience, not a permission: it expands to a value the caller could have typed themselves,
  // so an anonymous caller gets a 400 for a malformed filter rather than a 401.
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

/** Validating the SHAPE here makes a malformed id a 400 and a well-formed unknown one a 404 — the
 *  distinction between a broken link and a deleted run. */
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
  // Registered BEFORE identity(), which touches the db: health is precisely the route that must
  // answer when the database is unhappy. Behind the middleware, a dead db plus a cookie produced a
  // 500 where a dead db alone correctly produced 503.
  app.get(
    "/api/health",
    route((_req, res) => {
      // Touch the db rather than report a cached flag: "the process is up" is not the question.
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

  // Logging in means CLAIMING a login; nothing verifies it. Swapping in GitHub OAuth replaces the
  // body of this one handler and leaves every other route untouched.
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
      // Clearing the cookie matters more than whether a row was updated: the client must not keep
      // sending a dead token.
      if (req.sessionToken) deps.sessions.revoke(req.sessionToken);
      res.setHeader("Set-Cookie", clearedCookie({ secure: deps.secureCookies ?? false }));
      res.status(204).end();
    }),
  );

  app.get(
    "/api/auth/me",
    route((req, res) => {
      // 200-with-null, not 401: "who am I" is answerable when the answer is "nobody", and the
      // frontend chooses between a login screen and a dashboard from one unconditional call.
      res.json({ login: req.user, account: req.account });
    }),
  );

  app.get(
    "/api/runs",
    route((req, res) => {
      const filter = listFilterFrom(req);
      // The EFFECTIVE paging: `?limit=999` serves 200 rows, and a response claiming 999 would make
      // `offset += limit` skip 799 of them without erroring.
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
      // Every run is attributed: an unattributed row is a request nobody can be asked about.
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

      // Reported rather than refused — the row is queued either way. Both reasons are sent because
      // they are different: `blocked_by_branch` waits on one specific run, `queue_position` waits on
      // capacity, and with a cap of 2 the second is far more common.
      //
      // `liveOn` returns the oldest live row on the branch, which is our own when nothing else holds
      // it — so a DIFFERENT run id is the signal that something is ahead of us.
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
      // Live rows by default: a month of finished ones buries the question this answers.
      const filter = {
        status: (requested as QueueStatus[] | undefined) ?? [...LIVE_STATUSES],
        requestedBy: str(q, "requested_by"),
        repo: str(q, "repo"),
        branch: str(q, "branch"),
        limit: int(q, "limit", { min: 1 }),
        offset: int(q, "offset", { min: 0 }),
      };
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
      // Counted in SQL: filtering a page of rows stops being a total once the queue outgrows it.
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
      // Attributed but not restricted to the requester: a shared concurrency cap means a run wedged
      // on someone's day off has to be stoppable by whoever is at the keyboard.
      requireUser(req);
      const id = runIdParam(req);
      if (!deps.supervisor)
        throw new ApiError(503, "no_supervisor", "no supervisor is running — nothing can be cancelled");
      const row = deps.queue.byRunId(id);
      if (!row) throw notFound("run_not_found", `no queued run ${id}`);

      // One route for pending and running alike: a stable id before there is a process means the
      // caller never has to make the distinction it is least able to make without racing.
      const { cancelled, signalled } = deps.supervisor.cancel(id);
      if (!cancelled)
        throw badRequest("not_cancellable", `run ${id} is already ${row.status}`);

      // 202, not 204: the row is cancelled for certain, but the child exits on its own schedule.
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
      // A gate nobody sees is a gate that expires, throwing away planning work already paid for.
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
      // Must precede /api/runs/:id — Express matches in order, and "facets" would otherwise be
      // caught by the :id route and rejected as a bad run id.
      res.json(deps.index.facets(listFilterFrom(req)));
    }),
  );

  app.get(
    "/api/runs/:id",
    route((req, res) => {
      const id = runIdParam(req);
      const run = deps.index.get(id);
      const queue = deps.queue.byRunId(id);
      // Either half may legitimately be absent: `queue` is null for a CLI run that never went
      // through the service, and `run` is null for one enqueued but not yet started — which the
      // new-run form navigates straight to, so 404 there made a successful enqueue look like one.
      if (!run && !queue) throw notFound("run_not_found", `no run ${id}`);
      res.json({ run, queue });
    }),
  );

  app.get(
    "/api/runs/:id/events",
    route((req, res) => {
      const id = runIdParam(req);
      // Checked first: an empty page is otherwise indistinguishable from a missing run, and "no
      // events yet" is the normal state of one that just started.
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
      // Metadata only — a timeline wants the links, not ~160 KB of skill envelopes.
      res.json({ items: deps.index.artifacts(id) });
    }),
  );

  app.get(
    "/api/runs/:id/artifacts/:sha",
    route((req, res) => {
      const id = runIdParam(req);
      const raw = req.params.sha;
      const sha = Array.isArray(raw) ? raw[0] : raw;
      // Shape-checked before SQL, so a typo is a 400 rather than an empty 404 to guess at.
      if (typeof sha !== "string" || !/^(sha256:)?[0-9a-f]{64}$/.test(sha))
        throw new ApiError(400, "bad_sha", `'${String(sha)}' is not a sha256 hex digest`);
      if (!deps.index.get(id)) throw notFound("run_not_found", `no run ${id}`);
      const found = deps.index.artifact(id, sha);
      if (!found) throw notFound("artifact_not_found", `run ${id} has no artifact ${sha}`);
      res.json(found);
    }),
  );

  // Scoped to /api so it cannot swallow the frontend's client-side routes below.
  app.use("/api", (_req, res) => {
    sendError(res, notFound("not_found", "no such route"));
  });

  if (deps.staticDir) {
    app.use(express.static(deps.staticDir, { index: false }));
    // SPA fallback, excluding anything that looks like a file. Without that exclusion a missing
    // /assets/main.js answers 200-with-HTML, the browser executes a document as JavaScript, and the
    // MIME error says nothing about the real problem — a stale asset reference after a redeploy.
    app.get(/.*/, (req, res, next) => {
      if (looksLikeAsset(req.path)) return next();
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
