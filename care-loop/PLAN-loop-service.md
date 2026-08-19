# PLAN — `care-loop-service`: multi-user loop runs behind an Express BE

**Status:** DRAFT 2026-08-19 — designed, not built.
**Owner:** care-loop
**Motivated by:** making `loopd` callable by the team. Today a run requires a terminal, the caller's
credentials, and a human at stdin for the plan gate. The service replaces all three: the bot authors,
the trust boundary is the network, and the gate moves to HTTP.
**Depends on:** [[PLAN-sqlite-run-store]] — `RunIndex` is the read path and the queue query. This plan
assumes that one is built first, and amends three of its decisions (§4 below).
**Related:** [[PLAN-orchestrator-architecture]] §5 (journal = single source of truth), §6 (resume IS
recovery) · `plan-gate.ts` (the transport seam this fills) · `lock.ts` (orphan detection).
**Not related to** [[PLAN-backend-bringup]], which is the CARE product's test backend on :9000.

---

## 1. Why

The blocker was never credentials — it was that `runPlan` reads stdin. `cli.ts:660` builds a
`terminalFront`, blocks on readline, and only then calls `startFromInput`. One human, one terminal,
one run.

Three changes make it a service: the **bot authors every PR** (no credential lease, no per-user
tokens), the **trust boundary is the network** (VPN/Tailscale, not in-app auth), and the **gate
becomes an HTTP transport** against the port that already exists for it.

## 2. Decisions already taken

- **Bot authors, caller is assigned.** `pulls.create` (`github.ts:567`) then `issues.addAssignees` —
  separate call, `pulls.create` takes no assignees. Plus a `Co-authored-by:` trailer on the commit.
  This deletes the credential-lease problem outright.
- **No auth yet, but shaped for it.** GitHub username in `localStorage`, sent as a header, stored as
  `requested_by`. It is *claimed attribution*, not authentication — the network is the boundary. The
  extension path is real, not aspirational; see §6.
- **Express, not raw `node:http`.** ~10 routes with path params and bodies; the regex-match style at
  `dashboard.ts:191` does not scale to that. Express 5, no body-parser dep (built in since 4.16).
- **SQLite is the destination, and this plan assumes it.** [[PLAN-sqlite-run-store]] §10 is the
  cutover to DB-as-truth. It has not happened — that plan is built as a projection with journals
  authoritative — but nothing here depends on waiting for it (§3).
- **Service as supervisor.** One `care-loopd` child per run. Credential isolation is process
  isolation, and the child is the same binary that runs locally.
- **React + TypeScript FE.** Two views today (`showFleet`, `showRun` — `dashboard.html:851,869`),
  growing to four. Vite SPA + TanStack Router + TanStack Query. No global-state library, no component
  kit, and **not** TanStack Start — see §8.

## 3. Architecture

```
browser ──HTTP──▶ Express service ──spawn──▶ care-loopd child ──▶ worktree + opencode + GitHub
                       │                          │
                       │  RunIndex + queue        │  RunStore
                       └──────────▶ loops.db ◀────┘
                                  (WAL, both write)
```

The service **never** runs loop logic in-process. It enqueues, spawns, reads, and relays the gate.

### Both sides write the DB — and this does not wait for the cutover

An earlier draft of this plan carried a single-writer rule: the service could never write a run's
journal, because the jsonl is hash-chained and two appenders corrupt it. That rule drove a
`gate-answer.json` side channel, a cancel sentinel file, and a lock hand-off at spawn. All three are
deleted, but **not** because [[PLAN-sqlite-run-store]] §10 retires the journal — that was a
misdiagnosis. They are deleted because a gate ask and a cancel flag were never journal data in the
first place. They are service state, exactly like `queue`, and they live in service-owned tables under
either design.

So this plan is unblocked today, against the projection design as built. What actually changes at the
§10 cutover is nothing structural here — only that `runs`/`run_events` stop being rebuildable, which
matters to backups rather than to the service's shape.

The rule that does survive, narrower: **one writer per run.** A run's `runs`/`run_events` rows are
written only by the child that owns it. The service reads them and never writes them, which is what
keeps the child the same binary you run locally (§5). Service-owned tables are the service's; run
tables are the child's; SQLite in WAL arbitrates the file.

**One durability change is required before this ships.** `loops.db` runs at `synchronous = NORMAL`,
justified by `rm loops.db && reindex` being a complete recovery. That justification does not extend to
`queue` and `gate_asks`, which have no journal behind them — under `NORMAL` a power loss can drop a
pending request or an answered gate. Move it to `FULL` with step 3, not at the cutover. See
[[PLAN-sqlite-run-store]] §2, "The invariant is scoped to the run tables."

## 4. The queue table

The service is always on. `POST /api/runs` inserts a row and returns; the supervisor claims pending
rows, spawns, and writes the terminal status when the child exits.

**The service mints `run_id`, not the child and not SQLite.** Worth stating because the natural
assumption is wrong on both counts: `run_id` is a ULID minted in application code (`run-id.ts` —
48-bit ms timestamp + 80 bits random, Crockford base32, time-sortable), and SQLite only ever stores
it as `TEXT PRIMARY KEY`. Until now the *child* minted it on first touch of the run dir, which cannot
work here: `POST /api/runs` has to answer `{ run_id }` synchronously, and the child starts long
afterwards — possibly never, if the row sits pending or the spawn fails.

So the service calls `mintRunId()` at insert time and passes the value to the child as `CARE_RUN_ID`.
`resolveRunId` (run-context.ts) honours it for a run dir that has no id yet, and **throws rather than
rebinding** one that does — a pinned id may name a fresh run, never hijack an established one. A
supervisor restart re-spawning the same row with the same id is therefore idempotent, while a stale
id pointed at an occupied dir fails loudly instead of silently forking the run's identity.

```sql
CREATE TABLE queue (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  status       TEXT NOT NULL,          -- pending | running | done | failed | cancelled
  requested_by TEXT NOT NULL,          -- GitHub login, from X-Care-User
  repo         TEXT NOT NULL,
  branch       TEXT NOT NULL,
  task         TEXT NOT NULL,          -- the request payload the form collected
  ticket       TEXT,
  run_id       TEXT NOT NULL,          -- minted HERE at enqueue (see below); joins to runs.run_id
  enqueued_at  TEXT NOT NULL,
  started_at   TEXT,
  finished_at  TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  error        TEXT                    -- supervision failure only, never a loop outcome
);
CREATE INDEX idx_queue_pending ON queue(status, enqueued_at);
CREATE INDEX idx_queue_mine    ON queue(requested_by, enqueued_at DESC);
```

### `status` is about supervision, not about the loop

`done` means *the child exited*. Whether the loop merged, aborted, or deferred lives in `runs.step`,
and it stays there — duplicating outcome into `queue` is the wide-table mistake again. `failed` means
the spawn or the supervision failed, which is a different thing from a loop that concluded badly.

### The claim must be atomic

One supervisor makes this trivial, but write it correctly anyway so a restart overlapping its
predecessor cannot double-spawn:

```sql
BEGIN IMMEDIATE;
UPDATE queue SET status = 'running', started_at = :now, attempts = attempts + 1
 WHERE id = (SELECT id FROM queue WHERE status = 'pending'
              ORDER BY enqueued_at LIMIT 1)
   AND status = 'pending';
COMMIT;
```

Claim only if `changes() == 1`. Repeat until the cap is reached. Priority and per-user fairness are an
`ORDER BY` when wanted; not v1.

### The child never sees the queue

The supervisor owns the whole lifecycle: it claims, spawns, observes the exit code, and writes `done`
or `failed`. The child writes only its own journal. This is what keeps the child **the same binary you
run locally** — it has no idea a service exists, and no DB coupling to the queue.

### `running` rows are lies after a crash

If the service dies mid-run, every `running` row survives as a claim nobody holds. On boot, reconcile
each one:

| `run_id` | lock (`acquireLock`) | meaning | action |
|---|---|---|---|
| NULL | — | died between claim and spawn | back to `pending` |
| set | refused | child is alive | re-adopt the PID |
| set | acquired | child is dead | `resume` it, stay `running` |

Same `lock.ts` PID-liveness primitive as §5, now driven from the queue rather than from a directory
scan.

### `queue` sits outside the projection invariant

[[PLAN-sqlite-run-store]] §2 says SQLite is a projection and `rm loops.db && reindex` is the
acceptance test. `queue` is **not** a projection — a pending request has no journal because it is not
a run yet. That plan's §2 now carries the scoping explicitly, and it cuts two ways:

- `reindex` rebuilds the four run tables and must leave `queue` and `gate_asks` alone. Its
  `DELETE FROM runs` is scoped by design.
- `synchronous = FULL` becomes required, per §3 above.

Losing `queue` loses pending requests, which are re-submittable. Losing `gate_asks` loses an answered
gate, which means someone re-approves a plan. Both are cheap next to run history — but neither comes
back from a rebuild, so they are the tables that make backups matter before the cutover rather than
after it.

**One file or two?** `queue` could live in its own `queue.db`, which would keep `rm loops.db` literally
true with no caveat and separate the service's writes from the child processes' `RunStore` writes.
Rejected for v1: the fleet list wants pending and running in one query, and a cross-database `ATTACH`
join to buy back a caveat we can state in one sentence is a bad trade. Revisit if WAL contention
between the service and N children actually shows up.

## 5. Supervisor

**Spawn.** On a successful claim, mint the `run_id`, write it onto the queue row, then
`child_process.spawn` the same `bin/care-loopd.mjs` with `cwd` at the runs root and the bot's
credentials in env. Track `{ id → pid }` in memory only — the queue row and the journal are the
durable copy, so a service restart loses nothing but the map (and §4 reconciles it).

**Concurrency cap.** `CARE_SERVICE_CONCURRENCY`, default 2. Each run is a worktree plus an opencode
session plus Copilot credits; this is a real resource limit, not a formality.

**Orphan recovery is nearly free.** loopd is already crash-only with journal-backed `resume`, and
`lock.ts` already does PID-liveness (`defaultIsAlive`, `lock.ts:18`). The boot scan is the §4
reconciliation table — driven by `WHERE status = 'running'` rather than by a directory walk, which is
the practical payoff of the queue owning the lifecycle. No new recovery machinery.

**Cancel.** A `pending` row cancels as a status write, with nothing to kill. A `running` row needs the
child: the service sets `queue.status = 'cancelled'`, the child reads its own queue row at each step
boundary and exits cleanly with a `run.end`, and the supervisor escalates to `SIGTERM` after a
timeout. No sentinel file — a row the child polls is the same mechanism with one fewer artifact, and
the DB write is durable, so a killed run is just a resumable one.

**`CARE_DOCTOR=0`** on the server. The end-of-run doctor opens self-improvement PRs against the skills
repo; that should stay a deliberate local action, not a side effect of every teammate's run.

## 6. HTTP API

**The service reads the DATABASE and nothing else.** No route touches a run directory, a
`journal.jsonl`, or a `state.json` — `run_events` mirrors the journal completely (same `seq`/`ts`/
`event`/`step`/`round`/`data`/`prev`), so there is nothing the filesystem could add. The FE in turn
talks only to this API, never to the DB. Three layers, each with exactly one thing below it.

This is a genuine constraint, not a preference, and it costs one thing — see "What DB-only cannot
serve" below.

### The full surface

Every route is `/api/*`, returns JSON, and takes `X-Care-User`. `:id` is always a **run_id** (ULID);
the directory slug appears in responses as a display label and is never a key.

| Method | Route | Returns | Step |
|---|---|---|---|
| `GET` | `/health` | `{ ok, db, supervisor, version }` | 1 |
| `GET` | `/me` | `{ login }` — the resolved identity, echoed back | 1 |
| `GET` | `/runs` | `{ items: RunSummary[], total, limit, offset }` | 1 |
| `GET` | `/runs/:id` | `{ run, detail, queue }` — `runs` + `run_detail` + its queue row | 1 |
| `GET` | `/runs/:id/events` | `{ items: JournalEvent[], next_seq }` — paginated timeline | 1 |
| `GET` | `/runs/:id/artifacts` | `{ items: ArtifactSummary[] }` — metadata, no bodies | 1 |
| `GET` | `/runs/:id/artifacts/:sha` | one artifact, `content` parsed | 1 |
| `GET` | `/runs/:id/stream` | SSE — live event tail | 2 |
| `POST` | `/runs` | `201 { run_id, queue_id }` — enqueue | 3 |
| `GET` | `/queue` | `{ items: QueueRow[] }` — pending + running | 3 |
| `GET` | `/stats` | `{ active, by_step, cost_usd, runs_today }` | 3 |
| `POST` | `/runs/:id/cancel` | `202` | 4 |
| `GET` | `/runs/:id/gate` | `PendingAsk \| null` | 5 |
| `POST` | `/runs/:id/gate` | `204` | 5 |

`GET /runs` filters: `requested_by`, `repo`, `branch`, `step`, `active` (non-terminal step), `stale`,
`limit` (default 50, max 200), `offset`. All are optional and all compose.

`GET /runs/:id/events` filters: `after_seq` (the pagination cursor — `seq` is dense and monotonic per
run, so it beats an offset), `event` (repeatable type filter), `limit` (default 500, max 2000).

**One `cancel`, not two.** Minting `run_id` at enqueue (§4) means a request has a stable id before it
has a process, so a single route covers both cases: a `pending` row is marked `cancelled` in place,
a `running` one signals the child. The FE never has to know which state it caught the run in — which
is exactly the distinction it is least able to make without a race.

### Conventions

- **Envelope on lists, bare object on singletons.** `{ items, total, limit, offset }` for collections;
  the resource itself for a single fetch. Pagination added later to a bare array is a breaking change,
  and this contract is frozen before the FE is written.
- **Errors are `{ error: { code, message } }`** with a real status: `400` malformed, `404` unknown
  run, `409` state conflict (cancelling a finished run), `503` DB unreachable. `code` is a stable
  string the FE can branch on; `message` is for humans and may change.
- **No route makes an authorization decision** (see below). `?requested_by=` is a filter, not a
  permission.
- **Timestamps are ISO-8601 UTC strings**, exactly as stored. No epoch ints, no server-side
  formatting — the FE owns presentation.

### Skill artifact bodies live in the db too

Originally this section recorded a limitation: skill *output* was not in the database. `skill-log.ts`
keeps the journal spine lean — a `skill.result` event carries bounded fields plus a `{path, sha256}`
**reference**, with the full envelope in a content-addressed sidecar under `<run-dir>/skills/` — so a
DB-only API could say *the reviewer returned 3 findings and declined* but not *here is what it wrote*.

**Resolved by storing the bodies (`run_artifacts`, schema v3) rather than by letting the service read
files.** The journal spine is unchanged; the artifact table is a parallel mirror.

- **`content` is jsonb, in a `BLOB` column.** Every artifact is a serialized JSON value by
  construction, because `SkillLogger.artifact` now takes a VALUE and does the serializing — so "valid
  JSON" is structural, not a convention each caller has to honour. `json_extract()` works directly on
  the stored bytes with no reparse. Measured on the real fleet: 188 artifacts, 643 KB of text → 568 KB
  of jsonb, ~12% smaller.
- **jsonb is a function and an encoding, NOT a column type.** Declaring a column `JSONB` is accepted
  but matches no affinity rule (it does not contain `BLOB`), so it lands on **NUMERIC** affinity and
  will coerce numeric-looking strings. `BLOB` is the correct declaration.
- **PK is `(run_id, path)`, not `(run_id, sha256)`.** Path is unique within a run; content is not — an
  unchanged input recurring across two rounds would otherwise collapse two artifacts into one row.
- **`sha256` is a handle, not a verified digest.** Worth stating plainly because the name implies
  more: nothing in the codebase re-hashes an artifact and compares. The only verified hashes are
  `journal.ts`'s `prev` chain and `run-id`'s backfill seed. It addresses the sidecar text, and it is
  what the journal's ref already carries — which is why the API serves bodies by it, letting the
  frontend go from a timeline event to a body with no second lookup.

**The sidecar files stay**, and that was a real decision rather than inertia. Two things depend on
them: `care-loop-doctor` reads `skills/*.json` **by path** off the run dir (it is a skill, not a db
client), and `reindex` rebuilds `run_artifacts` from them — which is what keeps artifacts out of the
`queue`/`gate_asks` category of data no rebuild can restore. `rm loops.db && care-loopd reindex` is
still lossless, verified against the real fleet.

`X-Care-User` on every request, persisted as `requested_by`. Freeze this contract before the FE
starts — it is the whole reason the FE is sequenced third.

### Identity goes through middleware from day one

Resolve the caller in **one** Express middleware that sets `req.user`, even though today it does
nothing but read a header and trust it. No route reads `X-Care-User` directly. Adding real auth then
means replacing the body of that one function with a session or OAuth check — every route already
consumes the resolved identity and none of them change.

Two things make the later migration cheap, and both are free now:

- **`requested_by` is the GitHub login, and logins are mutable.** A user renaming on GitHub orphans
  their history. Accepted for v1 because we have no way to learn the numeric id without an API call
  we're not making. When auth arrives it brings the id with it: add a `users` table, backfill the
  distinct logins through the GitHub API once, and point `requested_by` at it. One migration, no row
  rewrites.
- **Never branch on identity anywhere else.** No route may make an authorization decision; the filter
  `?requested_by=me` is a convenience, not a permission. Keeping authorization entirely absent means
  adding it later is additive rather than a hunt through routes that quietly assumed a trusted header.

## 7. Gate transport

`plan-gate.ts` was built for this. Its own header says the terminal adapter is "interchangeable with a
future Jira-comment / PR-comment adapter that posts the questions and POLLS for replies." HTTP is that
adapter with a different poll target; `PlanQuestion.id` is already stable for correlation.

With the DB authoritative, the ask and the answer are both rows:

```sql
CREATE TABLE gate_asks (
  run_id      TEXT NOT NULL,
  ask_id      TEXT NOT NULL,        -- PlanQuestion.id, or 'approve' for the consolidated ask
  kind        TEXT NOT NULL,        -- interview | approve
  payload     TEXT NOT NULL,        -- JSON: PlanQuestion[] or ConsolidatedAsk
  answer      TEXT,                 -- JSON: PlanAnswer[] or ApprovalDecision; NULL while pending
  answered_by TEXT,
  asked_at    TEXT NOT NULL,
  answered_at TEXT,
  PRIMARY KEY (run_id, ask_id)
);
```

1. `HttpPlanGate.interview()` / `.approve()` insert a row and poll it for `answer IS NOT NULL`.
2. `GET /api/runs/:run_id/gate` returns the pending row.
3. The human answers; the service writes `answer` + `answered_by`.
4. The child's poll returns, it deserialises, and `runPlan` continues.

Every step survives a restart on either side, because every step is a committed row. `answered_by` is
worth having separately from `queue.requested_by` — the person who approves a plan is not always the
person who requested it, and at a gate that distinction is the interesting one.

## 8. Frontend

Vite + React + TS, built to static assets and served by Express. Four views: **Fleet** (list, filter to
mine), **Run detail** (port of `renderDetail`), **New run** (the form replacing `terminalFront`),
**Gate** (the ask, approve/amend/reject).

**TanStack Router.** Typed routes and typed search params, which is what the fleet filters actually
are — `?requested_by=&status=` belongs in the URL so a filtered view is linkable, and hand-rolling
that against `URLSearchParams` is the kind of code that rots.

**TanStack Query, not a state library.** There is no meaningful client state here; there is a server
cache that needs polling, invalidation, and request dedup. It replaces `setInterval(refresh, 10000)`
(`dashboard.html:901`) with per-view `refetchInterval`, gives the fleet list and an open run different
cadences, and makes "enqueue then show the new row" an invalidation instead of a manual refetch. SSE
on an open run detail pushes into the same cache.

**Not TanStack Start.** Start is full-stack — its own server, SSR, server functions. Adopting it here
means either running its server alongside Express, or folding the BE into it. The second is
disqualifying: §5's supervisor does `child_process.spawn`, SIGTERM escalation, and a boot-time
reconciliation scan, none of which belong in a React framework's request-scoped server. And the
motivating benefits are absent — this is a VPN-internal tool with no SEO, no cold-load pressure, and
an API that already exists for the CLI's sake. Router without Start is the same DX at the routing
layer with one fewer server.

**Port order.** Bring `renderPipeline` and `renderEvent` across as-is first and diff against the
vanilla page before deleting it. `dashboard.html` + `startDashboard` stay until the React app reaches
parity — the render-diff from [[PLAN-sqlite-run-store]] §12 step 5 is the check that the DB migration
and the FE rewrite did not mask each other's bugs.

## 9. Credentials on the server

One `.env` on the box, bot-owned: GitHub token (`resolveToken`, `github.ts:136`), the Copilot/opencode
provider key, Jira creds. Children inherit. Nothing per-user is stored anywhere, which is the property
that made bot-authoring worth the trade.

## 10. Testing

- **Queue:** enqueue 5 with cap 2 ⇒ exactly 2 spawn; one finishes ⇒ exactly 1 more.
- **Claim is atomic:** two claim loops against one `pending` row ⇒ exactly one `changes() == 1`.
- **Reconciliation:** seed all three §4 rows (no `run_id`; alive child; dead child) and assert each
  lands in the right terminal state on boot.
- **Restart mid-run:** kill the service with a child alive ⇒ on boot the child is re-adopted, not
  double-spawned. Kill both ⇒ the run resumes.
- **Spawn failure:** point the binary at a nonexistent path ⇒ row is `failed` with `error` set and
  `attempts = 1`, not stuck at `running`.
- **Concurrent writers:** service and child writing through one gated run under WAL ⇒ no
  `SQLITE_BUSY` escaping to either side, and the run's rows are complete afterwards.
- **Gate round-trip:** ask → restart the service → answer ⇒ the child's poll still returns. The row
  is the whole durability story, so this is the test that proves §7.
- **Restore:** the [[PLAN-sqlite-run-store]] §10 drill, extended to assert `queue` and `gate_asks`
  come back with the runs.
- **Gate:** fake HTTP front drives approve / amend / reject to the same assertions as `gate-terminal`.

## 11. Build order

| # | Work | Est |
|---|------|-----|
| 0 | [[PLAN-sqlite-run-store]] steps 1–5 — **built as of 2026-08-19** | done |
| 1 | Express skeleton + read routes over `RunIndex` + `X-Care-User` — **built 2026-08-20** | done |
| 2 | Vite + Router + Query scaffold; React FE at read parity, vanilla page deleted | 1.5d |
| 3 | `queue` table + `POST /api/runs` enqueue + the list join | 0.5d |
| 4 | Supervisor: claim, spawn, cap, reconcile, cancel | 1.5d |
| 5 | `HttpPlanGate`/`HttpPlanFront` + new-run form + gate view | 1d |
| 6 | Deploy: systemd unit, `.env`, Tailscale | 0.5d |

**~5.5d.** Steps 0–1 are done. `run-store.ts`, `run-id.ts`, `run-context.ts`, and `reindex.ts` gave
step 1 a working store to build on; step 1 then rewrote `run-index.ts` as a **DB-only** port (`get`
takes a run_id and reads `run_events`, where it used to take a directory slug and read the journal
file) and added `src/service/` — `app.ts` (routes), `identity.ts`, `query.ts`, `errors.ts`,
`serve.ts` — behind `care-loopd serve`. 17 tests cover the port and the HTTP contract; the contract
tests drive a real Express app over an in-memory db, so the shape the FE is written against is frozen
before the FE exists.

Two things fell out of building it, both worth keeping in mind at step 2:

- The vanilla `dashboard.html` reads `{name, state}`, which is not the service's shape. `dashboard.ts`
  now adapts the index rows back into its own shape so the old page keeps working until step 2
  deletes it. That adapter is the ONLY thing keeping two response shapes alive; it goes with the page.
- `serve` opens the db `readOnly: true` and binds loopback by default. Both are deliberate: the
  service has no reason to write (§3, one writer per run), and it has no authentication, so exposing
  it beyond loopback should take an explicit `--host`.

Steps 1–2 ship a read-only team dashboard before any spawn code exists, which is where the value/risk
ratio is best. The [[PLAN-sqlite-run-store]] §10 cutover is **not** a prerequisite for any step here
(§3); it can land before, during, or after, and the only thing it changes for this plan is that
backups get more valuable.

## 12. Risks

- **Queue starvation.** One complex run can hold a slot for hours. Mitigation: cap is per-run, not
  per-user; add fairness only if it actually bites.
- **Poison rows.** A request that fails spawn every time retries forever. Cap `attempts` at 3, then
  `failed` with the last `error`.
- **Same repo+branch is one run, not two.** `derivePaths` (front-terminal.ts) derives BOTH the
  worktree and the run dir from `${repoName}-${branch}`, so a second run on the same branch does not
  conflict with the first — it *is* the first: same run dir, same `.run_id` cache, same run id, two
  drivers appending into one event stream. What prevents that today is the loop's per-run lockfile
  (`withLock(runDir)`), which refuses a second live holder. That is a correctness invariant and it
  stays in the loop.

  **Admission control is this service's job, not the loop's.** The loop should not have to know the
  fleet exists; asking it to would mean two implementations of one policy, which is exactly how
  `run_id` drifted into three formulas ([[PLAN-sqlite-run-store]] §5). So: **queue behind, don't
  reject.** The claim query already filters on status; it also skips a `(repo, branch)` that has a
  `running` row, and the second request starts when the first finishes. Rejecting would push the
  retry back onto the requester for a situation the queue exists to handle.

  The service needs one seam the loop does not currently export: a non-destructive
  `inspectLock(runDir)` → `{ held, pid, alive }`. `lock.ts` already computes exactly this inside
  `acquireLock` (with `defaultIsAlive` pid-probing and stale-lock stealing), but it is only reachable
  by *taking* the lock. Needed because a `running` queue row is a lie after a crash — the lock's
  liveness is what distinguishes "genuinely driving" from "crashed, resumable". Build it with the
  supervisor (step 4), not before.

  Decoupling the run dir from repo+branch (key it by `run_id`, demote slug to a display label) would
  make two runs on one branch genuinely independent and retire the queue-behind rule, leaving only
  git's own "one branch, one worktree" constraint. Not blocking; the cheaper rule buys time.
- **`loops.db` holds unrebuildable service state.** Run tables survive a `reindex`; `queue` and
  `gate_asks` do not. Mitigation: `synchronous = FULL` (§3), plus a periodic
  `VACUUM INTO backups/loops-<ts>.db` and `PRAGMA integrity_check` on service boot. This gets
  strictly more important at the §10 cutover, when the run tables join them — but it is needed
  before that, not after.
- **Nothing is soft-deleted yet, and one thing should be.** Agreed direction: user-initiated removal
  should set a flag rather than delete a row. There is no call site today — no delete route, no delete
  method — so nothing is built. Two carve-outs when it lands: `clearAll()` and the `ON DELETE CASCADE`
  chain are NOT domain deletes, they are `reindex`'s truncate-before-rebuild, and soft-deleting there
  would make a rebuild an append and retire the "`rm loops.db && reindex` is lossless" invariant the
  whole projection rests on. The place it would genuinely help now is `stale`, which is currently
  derived by string-matching the directory name (`slug.includes(".stale-")`, and in SQL
  `slug NOT LIKE '%.stale-%'`) — a soft delete implemented as a filesystem naming convention leaking
  into a query predicate. An explicit `archived_at` on `runs` should replace it.

- **Attribution is unverified.** Anyone on the VPN can claim any username. Accepted: the boundary is
  the network. Revisit only if the box leaves the VPN.

## Non-goals

Per-user credentials · multi-machine workers · RBAC · run history retention/GC · public exposure ·
replacing `cli.ts` (local CLI remains first-class and unchanged).
