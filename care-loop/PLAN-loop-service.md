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

Note the service's connection is **read-write** as of the auth work — step 1 opened it read-only,
which was correct while the API only read. `users`/`sessions`/`queue` are service-owned writes and do
not touch the rule above, which is scoped to the RUN tables.

⚠️ **Two writers means every connection must configure itself.** `busy_timeout`, `foreign_keys`, and
`synchronous` are PER-CONNECTION pragmas and are not stored in the database file — only
`journal_mode = WAL` is. A connection that skips them takes an immediate `SQLITE_BUSY` where a
configured one waits five seconds. This bit exactly once, and instructively: the pragmas lived inside
the schema string, which only `SqliteRunStore`'s constructor runs, so the child waited politely while
the service failed instantly. WAL is what hid it — readers never contend, so a read-only service
looked healthy right up until sessions and queue rows made it a writer. Both paths now call
`applyConnectionPragmas`, and `test/concurrency.test.ts` asserts a bare connection really is
unconfigured, so the helper cannot quietly become decorative.

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
  run_id       TEXT NOT NULL UNIQUE,   -- minted HERE at enqueue (see below); joins to runs.run_id
  status       TEXT NOT NULL,          -- pending | running | awaiting_gate | done | failed | cancelled
  requested_by TEXT NOT NULL,          -- the resolved caller (session, or X-Care-User)
  repo         TEXT NOT NULL,
  branch       TEXT NOT NULL,
  task         TEXT NOT NULL,
  ticket       TEXT NOT NULL,          -- ENG-###; required, because the PR title assert requires it
  summary      TEXT NOT NULL,          -- required for the same reason: the loop needs all four seeds
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

`awaiting_gate` means the child exited on purpose, at a gate, with nothing wrong (§7): live, not
claimable, and re-admitted to `pending` by the human's answer. It is the one status a *human*, rather
than the fleet, is the bottleneck for — which is why it is not folded into `pending`.

`done` means *the child exited* having finished. Whether the loop merged, aborted, or deferred lives in `runs.step`,
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

| lock (`inspectLock`) | meaning | action |
|---|---|---|
| held, holder alive | child outlived the service | re-adopt the PID |
| held, holder dead | child died mid-run | back to `pending` |
| absent | never spawned, or exited cleanly | back to `pending` |

Non-destructive `inspectLock`, not `acquireLock`: a caller asking "is anything driving this run?" must
not answer by *taking the lock*, which is what the acquire-and-see-if-it-refuses formulation does.

**Back to `pending`, not "resume it, stay `running`".** Earlier drafts had a dead child resumed in
place. Returning it to `pending` reaches the same destination through the path that already exists:
the claim/spawn cycle re-spawns it with the *same* `CARE_RUN_ID` onto the *same* run dir, and
`run-context` adopts that id rather than rebinding it. What the draft called resume is what a re-spawn
already does — and the alternative was a second code path that executes only after a crash, which is
the least-tested kind there is.

A re-adopted child needs one thing a spawned one does not: there is no exit *event* for a process you
did not fork, so the supervisor sweeps adopted pids each tick. The exit status is still recoverable —
the child holds its lock for the whole run and releases it in `withLock`'s `finally`, so a vanished
process that left no lock unwound cleanly and one whose lock is still there died where it stood.

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

Which is exactly why a run waiting on a human must not hold a slot. §7's gate is a suspend point: the
child waits ~10 minutes, then exits `75`, and the supervisor moves the row to `awaiting_gate` rather
than `done`. A cap of 2 that two unanswered plans can exhaust is not a cap, it is a deadlock with a
countdown.

**Orphan recovery is nearly free.** loopd is already crash-only with journal-backed `resume`, and
`lock.ts` already does PID-liveness (`defaultIsAlive`, `lock.ts:18`). The boot scan is the §4
reconciliation table — driven by `WHERE status = 'running'` rather than by a directory walk, which is
the practical payoff of the queue owning the lifecycle. No new recovery machinery.

**Cancel.** A `pending` row cancels as a status write, with nothing to kill. A `running` row is sent
`SIGTERM`, escalating to `SIGKILL` after a grace period.

An earlier draft had the child poll its own queue row at each step boundary and exit cleanly. That
contradicted §4's "the child never sees the queue" — and §4 wins, because that property is what keeps
the child **the same binary you run locally**: no DB coupling to a service-owned table, no schema
knowledge, debuggable by re-running the same command by hand. Signalling costs nothing next to it.
loopd is crash-only with journal-backed `resume`, so a terminated child is a resumable run travelling
the same recovery path a power cut would take — one mechanism, already tested, rather than a second
one that only cancellation exercises.

The status write comes **first**, and it is what the caller's `202` means. Killing is the best-effort
half: a lost signal or an already-dead process still leaves the row correct, and `reconcile` will not
resurrect a row that is no longer `running`.

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

**Settled before the frontend starts** — that is the whole reason the FE is sequenced third. Every
route is `/api/*`, returns JSON, and resolves identity through one middleware. `:id` is always a
**run_id** (ULID); the directory slug appears in responses as a display label and is never a key.

| Method | Route | Returns | Step |
|---|---|---|---|
| `GET` | `/health` | `{ ok, db, supervisor, version }` | ✅ |
| `POST` | `/auth/login` | `201 { user }` + session cookie | ✅ |
| `POST` | `/auth/logout` | `204`, clears the cookie | ✅ |
| `GET` | `/auth/me` | `{ login, account }` — `login: null` when anonymous | ✅ |
| `GET` | `/runs` | `{ items: RunSummary[], total, limit, offset }` | ✅ |
| `GET` | `/runs/facets` | `{ repos, branches, users, steps }` with counts | ✅ |
| `GET` | `/runs/:id` | `{ run, queue }` — `runs` + `run_detail` + its queue row | ✅ |
| `GET` | `/runs/:id/events` | `{ items: JournalEvent[], next_seq }` | ✅ |
| `GET` | `/runs/:id/artifacts` | `{ items: ArtifactSummary[] }` — metadata, no bodies | ✅ |
| `GET` | `/runs/:id/artifacts/:sha` | one artifact, `content` parsed | ✅ |
| `GET` | `/runs/:id/stream` | SSE — live event tail | 2 |
| `POST` | `/runs` | `201 { run_id, queue_id, blocked_by_branch, queue_position }` — enqueue | ✅ |
| `GET` | `/queue` | `{ items: QueueRow[], total, limit, offset }` — live rows by default | ✅ |
| `GET` | `/stats` | `{ runs, active, by_step, queue }` | ✅ |
| `POST` | `/runs/:id/cancel` | `202 { run_id, cancelled, signalled }` | ✅ |
| `GET` | `/runs/:id/gate` | `PendingAsk \| null` | 5 |
| `POST` | `/runs/:id/gate` | `204` | 5 |

**`GET /runs` filters**, all optional and all composing: `requested_by` (the literal `me` resolves to
the caller), `repo`, `branch`, `step`, `ticket`, `pr`, `q` (free text over task / summary / branch /
ticket), `since` / `until` (half-open on `started_at`), `active` (non-terminal step), `stale`,
`order` (`started_at` · `updated_at` · `cost_usd` · `duration_ms`), `dir`, `limit` (default 50, max
200), `offset`.

`/runs/facets` accepts the same filters and answers with what is left, so narrowing to one repo offers
only that repo's branches rather than the whole fleet's.

`GET /runs/:id/events` filters: `after_seq` (the cursor — `seq` is dense and monotonic per run, so it
beats an offset), `event` (repeatable), `limit` (default 500, max 2000).

Three decisions inside that table are easy to get wrong later:

- **`order` is whitelisted, never interpolated.** It is the one parameter that would otherwise reach
  SQL as syntax rather than as a bound value. An unrecognised value is a 400.
- **`/runs/facets` is declared BEFORE `/runs/:id`.** Express matches in order and `facets` is a
  plausible path segment; declared after, it would be caught by `:id` and rejected as a malformed run
  id.
- **One `cancel`, not two.** Minting `run_id` at enqueue (§4) means a request has a stable id before
  it has a process, so one route covers both cases: a `pending` row is marked `cancelled` in place, a
  `running` one signals the child. The frontend never has to know which state it caught the run in —
  the distinction it is least able to make without a race. It answers `202`, not `204`: the row is
  certain, but a signalled child exits on its own schedule, and a `204` would render as a finished run
  seconds before the process actually stopped.

**Why enqueue reports two blockers, not one.** `blocked_by_branch` names the live run occupying this
`(repo, branch)`; `queue_position` counts pending rows ahead. Reporting only the first would be
actively misleading — with a cap of 2 and five queued runs on five branches, three callers would be
told nothing is in their way while they wait on the cap, which is the *common* reason a run does not
start. Position counts `pending` rows only, so a caller polling their own row watches it count down to
zero rather than plateau.

**`/queue` carries the same envelope as every other list route** — `{ items, total, limit, offset }`,
50 default / 200 max. It was specified as a bare `{ items }` with the queue store keeping its own
200/500 defaults, which is precisely the drift the convention above exists to prevent, caught while
the contract was still cheap to change.

### Auth: the shape now, the verification later

`POST /auth/login` takes a GitHub login and starts a session. **Nothing verifies it** — the boundary
is still the network (below), and anyone can claim any login. What exists now is the STRUCTURE real
auth needs, so adding GitHub OAuth replaces one handler's body and leaves `/auth/me`, `/auth/logout`,
the middleware, and every other route untouched.

- **Sessions are cookie-borne** (`care_session`, `HttpOnly`, `SameSite=Lax`, 30 days, `Secure`
  wherever TLS terminates). Cookies rather than a bearer token because OAuth's redirect flow lands on
  a cookie anyway; choosing tokens now would mean changing the client later.
- **The db stores a hash of the token, never the token.** The cookie is the only copy, so a leaked
  database is not a set of live logins. Nothing here is secret yet — the point is that it is three
  lines now and awkward to retrofit.
- **Logout revokes, it does not delete.** Consistent with the standing preference for soft deletes on
  domain rows, and "who was signed in when" survives the sign-out.
- **`users` accumulates the roster** as people log in. `login` is the GitHub login and is MUTABLE — a
  rename orphans history — which is why `github_id` sits there unpopulated: real auth brings it, and
  the migration then points `requested_by` at `users.id` rather than rewriting rows.
- **`X-Care-User` still works**, for curl, scripts, and the CLI, which have no cookie jar. A session
  wins when both are present. This header is exactly the thing to delete when real auth lands — a
  trusted header beside a verified session is a bypass, not a convenience — and it is confined to the
  one middleware so that removal is a one-line change.
- **`/auth/me` answers 200-with-null when nobody is signed in**, rather than 401. "Who am I" is
  answerable when the answer is "nobody", and it lets the frontend make one unconditional call and
  branch on the result instead of treating an error as a state.
- **An unresolvable cookie falls through to the header rather than 401ing.** The middleware
  identifies; it does not gate. A revoked or expired cookie must not lock out a caller who also sent
  a header.

**Hosting does not block GitHub auth, and a public domain is not required.** Recorded because the
instinct is to assume otherwise and defer the whole thing. GitHub never connects INBOUND — that is
webhooks. The OAuth web flow only needs the user's browser to reach the callback URL and the box to
have outbound HTTPS:

| Step | Direction |
|---|---|
| authorize | browser → github.com |
| callback | github.com 302s the **browser** → us |
| token exchange / user fetch | **our box** → github.com (outbound) |

The box lives on the office LAN and teammates reach it there, so a callback of
`http://<box>:<port>/api/auth/github/callback` is all GitHub needs — to it, that is just a string it
redirects to. Three things to settle before step 5 leans on it: **verify GitHub accepts the URL**
(five minutes with a throwaway OAuth App; the fallback if not is the OAuth **device flow**, which has
no callback URL at all); **register a hostname, not a DHCP IP**, since the callback is a fixed string
and a moved address breaks auth with a confusing mismatch; and note that plain HTTP means no `Secure`
cookie, so session tokens cross the LAN in cleartext — consistent with the network already being the
trust boundary, and reversible by putting Tailscale in front, which gives real HTTPS with no public
exposure and flips `secureCookies` on. An OAuth App has ONE callback URL, so localhost dev plus the
office host means two apps (or a GitHub App, which allows several).

**This is still not authorization, and no route may add any.** `?requested_by=me` is a convenience
that expands to a value the caller could have typed — which is why it 400s as an unexpandable filter
when nobody is signed in, rather than 401ing as a refused permission. Keeping authorization entirely
absent means adding it later is additive rather than a hunt through routes that quietly assumed a
trusted header.

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
them, and they are worth keeping separate because they do not have the same lifetime:

1. **`care-loop-doctor` reads `skills/*.json` by path** off the run dir — it is a skill, not a db
   client. **This reason is temporary.** The doctor loop is slated for rework after this plan ships,
   and the obvious shape for it is reading the API (or the db) instead of globbing run dirs, at which
   point this dependency disappears. Whoever does that rework: `run_artifacts` already holds every
   body as jsonb keyed by `(run_id, path)`, with `sha256` and `bytes` alongside, so the doctor's
   inputs are queryable today — `json_extract` over `content` needs no reparse. Nothing needs adding
   to the schema for it.
2. **`reindex` rebuilds `run_artifacts` from them** — disaster recovery for the bodies. Real, but
   narrowing: once step 3 lands `queue` and `gate_asks`, which no rebuild can restore, backups
   (`VACUUM INTO` + boot `integrity_check`) become the actual answer to a lost db, and rebuildability
   drops from necessary to cheap insurance. Cheap is right — 1.1 MB for the whole historical fleet.

A third reason was claimed and then withdrawn, because it is instructive: *schema-evolution backfill*.
`reindex` is genuinely how existing runs acquire data a new schema version projects — v3 gave every
existing db the `run_artifacts` table and **zero rows**, and the 188 artifacts exist only because
reindex read them off disk. But that need was one-time and is now spent: the content is IN the
database. A later version deriving something new from artifact content reads `run_artifacts.content`
directly (`INSERT … SELECT json_extract(content, …)`), no disk involved. Disk is only required to
backfill what the database does not already hold.

**So the sidecars are transitional, not permanent.** Both remaining reasons expire — (1) at the doctor
rework, (2) at step 3 backups — and the v3 backfill is already spent. There is no urgency to delete
them, but nothing should be built assuming they will always be there.

**The `journal.jsonl` replica is a different question and should not be lumped in with this.** It is
the independent witness the parity check compares the db against at `run.resume` and `run.end`
([[PLAN-sqlite-run-store]] §2/§10). Retiring it means the database has no external check on itself —
a decision about assurance, not about storage.

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

**The child polls SQLite directly, not the HTTP API.** It already opens the database — that is how
every run event is written — so the gate needs no HTTP client, no service URL, and no credentials in
the child. The property this buys is worth stating plainly: **a gate survives the service being
restarted, redeployed, or crashed.** The ask and the answer are both committed rows, and the two sides
never talk to each other, only to the table.

```sql
CREATE TABLE gate_asks (
  run_id       TEXT NOT NULL,
  ask_id       TEXT NOT NULL,        -- 'interview:<n>' | 'approve:<n>' — see "per attempt" below
  kind         TEXT NOT NULL,        -- interview | approve
  payload      TEXT NOT NULL,        -- JSON: PlanQuestion[] or ConsolidatedAsk
  answer       TEXT,                 -- JSON: PlanAnswer[] or ApprovalDecision; NULL while pending
  answered_by  TEXT,
  asked_at     TEXT NOT NULL,
  answered_at  TEXT,
  cancelled_at TEXT,                 -- the service revoking the ask (see "Cancel" below)
  expires_at   TEXT NOT NULL,        -- a parked run holds a concurrency slot; it cannot park forever
  PRIMARY KEY (run_id, ask_id)
);
CREATE INDEX idx_gate_pending ON gate_asks(run_id) WHERE answer IS NULL AND cancelled_at IS NULL;
```

1. `HttpPlanGate.interview()` / `.approve()` insert a row and poll it.
2. `GET /api/runs/:run_id/gate` returns the pending row.
3. The human answers; the service writes `answer` + `answered_by`.
4. The child's poll returns, it deserialises, and `runPlan` continues.

`answered_by` is worth having separately from `queue.requested_by` — the person who approves a plan is
not always the person who requested it, and at a gate that distinction is the interesting one. Any
authenticated caller may answer, on the same reasoning as cancel (§6): a shared box with a shared
concurrency cap needs whoever is at the keyboard to be able to unblock it.

### `ask_id` is per ATTEMPT, not per kind

An earlier draft used the literal `'approve'` as the ask id. That is an infinite loop: `amend`
re-drafts the plan and asks again, the second ask finds the *first* ask's row — already answered
`amend` — and returns it immediately, so the planner amends forever against an answer nobody re-gave.
`plan.ts:134` is a bare `for (;;)` whose own comment says amend re-drafts **unbounded**, and every
iteration is a real planner call, so this spends credits until someone notices.

So the id carries the attempt, and `runPlan` already has the counter: `spawn` (`plan.ts:87`) is
monotonic across the stage — interview 1, drafts 2, 3, 4 — so the ask for a draft is `approve:<that
draft's round>`. Stable, already journalled, and tied to the exact draft the human is looking at
rather than to a second counter that could drift from it. `interview:1` likewise carries the whole
batch in one row rather than one row per `PlanQuestion`: the frontend renders one form and the child
wants one round-trip, so a row per question would be three representations of one interaction.

Keying by attempt also makes re-asking **idempotent for free**, which is what a crash-only loop needs:
a child that dies after the ask and is re-spawned re-derives the same `spawn` counter, asks the same
id, finds the row it already wrote, and picks up the answer if the human gave one in the meantime.
Same id, same question, no duplicate prompt.

One caveat to keep honest: this only holds while the re-spawn reproduces the same sequence of drafts.
It does not today — `resume` refuses a pre-plan crash outright, so a crashed plan stage restarts from
scratch and re-drafts from the planner, which may or may not land on the same content for the same
`spawn`. The id is still *correct* (a fresh draft deserves a fresh ask); it simply does not yet buy
back the human's earlier answer in that case. Worth revisiting only if plan-stage crashes turn out to
be common — the loop-service makes them cheaper to observe, which is the prerequisite for knowing.

### Cancel travels the channel the child is already blocked on

A run parked at its gate is the one moment in the loop where the child is definitionally idle *and*
definitionally already polling a row the service can write. Cancelling it with `SIGTERM` would work —
crash-only makes that safe — but it is strictly worse than saying so in the row: a signalled child
skips its `finally`, so it leaves its lockfile behind, writes no `run.end`, and the run's last journal
event is a question nobody will ever answer. The FE then shows a run cancelled in the queue and still
"planning" in its timeline.

So cancellation of a parked run is **cooperative first, signalled second**:

| the run is… | what cancel does |
|---|---|
| `pending` | status write; nothing to kill |
| `awaiting_gate` (suspended) | status write; there is no process — see "suspend point" below |
| live at a gate (inside `wait_ms`) | stamp `cancelled_at`, short grace, then escalate to `SIGTERM`/`SIGKILL` |
| running, no pending ask | `SIGTERM` immediately, then `SIGKILL` — the crash-only path |

Which branch is a single indexed query for a pending ask, so a non-parked run pays nothing for the
parked run's grace. The child's poll returns `cancelled`, `HttpPlanGate` raises, and `runPlan` unwinds
through its normal path: `run.end` with `outcome: "aborted"`, `reason_code: "cancelled"`, lock released
by the `finally` that a signal would have skipped, exit 0.

**This does not breach §4's "the child never sees the queue."** The child reads *its own gate row for
its own run* — the very table it is already blocked on, and the transport it was handed. It never
reads `queue`, never learns a queue exists, and gains no coupling to service scheduling. What §4
protects is the child's independence from the *scheduler*, not an embargo on the gate transport
talking about its own gate. The terminal gate has always had a cancel channel too; it is called
ctrl-C.

The poll interval is short (2s) because it is a local SQLite read against a WAL database — the cost
that made `pollPr` wait 60s between rounds is a GitHub API call, and none of that applies here.

### A gate is a SUSPEND point, not a blocking wait

**"Parked" means the plan is finished and waiting on a human.** Not waiting to start — that is
`pending`, and no process exists yet. Not waiting to plan — recon, the interview, and the draft have
all already run. The child has done every expensive thing it is going to do before approval, and is
sitting on the answer.

The first draft of this section had it hold that position for 24h and called the slot it consumes an
acceptable cost. It is not. With the cap at 2, one plan left unanswered overnight halves the fleet and
two stop it — on a shared office box where the requester may simply have gone home.

So the child **waits briefly, then exits**, and the run resumes at the gate when the answer arrives:

| timer | default | what it bounds |
|---|---|---|
| `wait_ms` | 10 min | how long the child stays alive polling — "a human is probably looking at it right now" |
| `expires_at` | 7 days | how long the ask stays answerable at all |

These bound different things, and separating them is the whole trick. The first was expensive, so it
is short. The second is now free — a suspended run holds no process, no slot, no opencode session, and
**no worktree**, because `runStart` provisions the worktree *after* the gate (`cli.ts` cmdRun) — so it
can be generous.

**Resuming costs no model calls, because everything the approval path needs is already durable.**
This is not a lucky accident; it is what the table was already going to hold:

- `writeArtifacts` runs **before** the ask (`plan.ts`), so `criteria.md` / `baseline.md` /
  `decisions.md` are on disk before the human ever sees the question.
- `gate_asks.payload` **is** the `ConsolidatedAsk`, and the two fields `plan.approved` reads off the
  draft — `plannedBy` and `classification` — are both in it.
- `ticket` and `summary` arrive as seed flags the supervisor passes on every spawn anyway.

So an `approve` resume journals `plan.approved` and advances to step 2 having called no model at all.
A `reject` resume is a single journal write. Only `amend` re-invokes the planner — which is precisely
the work the human just asked for — and it reconstructs its inputs from the `interview:1` row.

**The lifecycle gains one status, `awaiting_gate`**, between `running` and terminal. It is live but
not claimable, so the cap ignores it. The answer is what re-admits the run: `POST /api/runs/:id/gate`
writes `answer` + `answered_by` and flips `awaiting_gate → pending` in one transaction, and the
supervisor claims it on the next tick. A distinct status rather than parking it back in `pending` for
an honest reason — "waiting on a human" and "waiting on capacity" are different states, the FE must
render them differently, and `queue_position` is meaningless for the first.

**The child still never sees the queue.** It signals suspension the only way a child ever talks to the
supervisor: an exit code. `75` (`EX_TEMPFAIL`) means "I am not done, and nothing is wrong" — the
supervisor writes `awaiting_gate` instead of `done`. A run started from a terminal uses the readline
gate, never suspends, and never emits it.

This makes cancel simpler too: the row in §7's table for "parked" only applies during the 10-minute
live window. After suspension there is no process at all, so cancelling is a status write, exactly
like a `pending` row.

**What this does not solve.** A suspended run re-enters through `runPlan`, so the loop needs one new
re-entry point: journal head at `gate.suspended` ⇒ skip recon/interview/draft, read the ask and its
answer, act. `resume` today refuses a pre-plan crash outright, and that stays true — this is a narrower
door than `resume`, opened only by a gate suspension, which is a clean state rather than a crash.

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

**Port order — as built, this step was SKIPPED, and the record should say so.** The plan called for a
render-diff against the vanilla page before deleting it, as the check that the DB migration and the FE
rewrite had not masked each other's bugs. The React app was written fresh and `dashboard.html` +
`startDashboard` were deleted in the same session without that diff being run.

What covered the risk instead, and why it is judged sufficient: the concern was specifically
replica-vs-DB divergence, and that is checked *continuously* rather than once — `assertParity` at
`run.resume` and `checkParity` at `run.end` diff the two directly ([[PLAN-sqlite-run-store]] §9), the
`started_at` bug was caught by an independent fold rather than by any rendering, and `reindex` over
the real fleet was verified deterministic across repeated runs. The React app was then driven against
that same fleet: 327 events and 61 step dividers on one run, artifact bodies fetched from the db.

The honest residue: nothing compared the two renderings side by side, and it can no longer be done
without checking out the deleted page. If that matters, `git show 45b9c6c^:care-loop/orchestrator/src/dashboard.html`
is where it lives.

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
| 2 | Vite + Router + Query scaffold; React FE at read parity, vanilla page deleted — **built 2026-08-20** | done |
| 3 | `queue` table + `POST /api/runs` enqueue + the list join — **built 2026-08-20** | done |
| 4 | Supervisor: claim, spawn, cap, reconcile, cancel — **built 2026-08-21** | done |
| 5 | `gate_asks` (schema v6) + `HttpPlanGate` + gate routes + new-run form + gate view | 1.5d |
| 6 | Deploy: systemd unit, `.env`, Tailscale | 0.5d |

**~5.5d.** Steps 0–4 are done; 5–6 remain.

Step 4 added `src/service/supervisor.ts` and turned three things that were paper into code:

- **`--supervise` is opt-in.** Two `serve` processes on one db must not both claim, and a read-only
  dashboard is a perfectly reasonable thing to run. `POST /api/runs` refuses while it is off, so the
  failure mode is a clear `503` rather than rows nothing consumes.
- **The claim consults the filesystem.** `QueueStore.claim` takes a `startable` predicate, evaluated
  *inside* the `BEGIN IMMEDIATE` transaction, and the supervisor backs it with `inspectLock`. Without
  it the queue is blind to a run someone launched from a terminal — which holds the very same lockfile,
  since the run dir is `${repo}-${branch}` either way — and the service would claim, spawn, set up a
  worktree, and die in `withLock` minutes later, reported as a spawn failure. The candidate query
  returns the oldest pending row *per branch* so fifty rows queued on one blocked branch cannot fill
  the scan window and starve every branch behind them.
- **`stop()` does not kill the children.** They are independent processes holding their own locks and
  journals; a service restart aborting every teammate's run would be far worse than a few unsupervised
  minutes, and §4's reconciliation re-adopts them at boot. This is what makes the boot table load-bearing
  rather than decorative.

Spawning the child for real also shook two latent bugs out of the *loop* side — both invisible until
something ran `care-loopd` non-interactively, which nothing did before this step:

- **The launcher only worked from inside its own package.** `bin/care-loopd.mjs` had the shebang
  `node --import tsx`, and node resolves that bare specifier against the *working directory* — so it
  died with "Cannot find package 'tsx'" from anywhere else. That is every `npm link` user, and every
  child the supervisor spawns, whose cwd is the run directory by design. It now registers tsx
  programmatically, resolved relative to the launcher itself.
- **The plan gate hung forever on a closed stdin.** `rl.question` against an ended stream never
  resolves — not EOF, not an empty string, just a promise that sits there. The child printed the
  approval prompt and stopped: alive, idle, holding its lock and a concurrency slot, with no error and
  no exit. Both terminal gates now race the question against the interface's own `close` and fail with
  a message naming the two places a run *can* be approved. This is a hazard the CLI's advertised
  non-interactive mode already carried; the service is simply the first caller to hit it every time.

Neither is fixed *by* the supervisor — but a service that spawns children is the thing that made them
matter, and step 5's `HttpPlanGate` replaces the second one's transport rather than its guard.

Steps 0–1 are done. `run-store.ts`, `run-id.ts`, `run-context.ts`, and `reindex.ts` gave
step 1 a working store to build on; step 1 then rewrote `run-index.ts` as a **DB-only** port (`get`
takes a run_id and reads `run_events`, where it used to take a directory slug and read the journal
file) and added `src/service/` — `app.ts` (routes), `identity.ts`, `query.ts`, `errors.ts`,
`serve.ts` — behind `care-loopd serve`. 17 tests cover the port and the HTTP contract; the contract
tests drive a real Express app over an in-memory db, so the shape the FE is written against is frozen
before the FE exists.

Two things fell out of building it, both worth keeping in mind at step 2:

- The vanilla `dashboard.html` read `{name, state}`, not the service's shape, so `dashboard.ts`
  adapted the index rows back into it. **Both are gone as of step 2** — with them went the second
  response shape, the no-`loops.db` full-journal scan, and `RunIndex.slugOf`, whose only caller was
  the old detail route. `care-loopd dashboard` no longer exists; `care-loopd serve` replaces it.
- `serve` opens the db `readOnly: true` and binds loopback by default. Both are deliberate: the
  service has no reason to write (§3, one writer per run), and it has no authentication, so exposing
  it beyond loopback should take an explicit `--host`.

Steps 1–2 ship a read-only team dashboard before any spawn code exists, which is where the value/risk
ratio is best. The [[PLAN-sqlite-run-store]] §10 cutover is **not** a prerequisite for any step here
(§3); it can land before, during, or after, and the only thing it changes for this plan is that
backups get more valuable.

### Design system: Care UI

[careui.ohc.network](https://careui.ohc.network) is the design system of record — React 19, Tailwind
v4 CSS-first, components published as a shadcn registry.

**The registry could not be used, and this is worth recording rather than rediscovering.** Every
`https://careui.ohc.network/r/<name>.json` endpoint returns the docs SPA's HTML with
`content-type: text/html`, so `npx shadcn@latest add …` fails on `Unexpected token '<'`. Verified
against the real CLI, not inferred.

What was adopted instead is the substance: the **tokens**, read directly off the live docs site's
computed styles and transcribed into `web/src/styles.css` — the full semantic set for both themes
(`--background`, `--card`, `--primary`, `--muted-foreground`, `--destructive`, `--border`, `--ring`,
`--radius: .625rem`, the chart ramp), plus Figtree and Geist Mono. Note Care UI's `--primary` is
**emerald**, not blue.

`web/src/components/ui/primitives.tsx` holds the few primitives this app needs (Button, Input, Select,
Badge, Card), written against exactly the token names Care UI's own components consume. When the
registry is fixed, the real components replace that one file and nothing else changes — that is the
whole reason it is one file.

Dark mode is a `.dark` CLASS, not `prefers-color-scheme`: Care UI ships five modes (light, dark,
high-contrast, protanopia, tritanopia) and a media query can only express two. Following the system
preference is the default; the class is the seam a theme picker drives later.

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
  `gate_asks` do not. **Addressed at step 3, with the queue** — which is the right moment, because
  before `queue` existed, losing the database cost nothing at all. `synchronous = FULL` was already
  set at the §10 cutover; step 3 added `VACUUM INTO backups/loops-<ts>.db` (at boot, then every 6h,
  keeping 7) and `PRAGMA integrity_check` before the first request is served.

  `VACUUM INTO` rather than copying the file: it snapshots a live database through SQLite itself, so
  it is safe with WAL and with readers and writers connected — `cp loops.db` can catch a torn page or
  miss the WAL. Pruning orders by the ISO stamp in the filename rather than mtime, which a copy or a
  restore would rewrite. The integrity check REPORTS rather than refusing to start: a database that
  still answers most queries beats a service that will not boot, and the run tables remain
  rebuildable — what matters is that someone learns, since corruption found weeks later, after
  backups have rotated past the last good snapshot, is the failure this exists to prevent.
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
replacing `cli.ts` (the local CLI remains first-class).

"Unchanged" was the original wording and is no longer literally true: `cli.ts` gained `serve`,
`reindex`, and `--requested-by`, and lost `dashboard`. What holds is the part that mattered — a run
started from the terminal goes through the same code as one started from the service, and the child
the supervisor will spawn is the same binary a human runs. The CLI is not a compatibility shim.
