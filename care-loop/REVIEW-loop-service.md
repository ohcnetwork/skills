# REVIEW — `loop-service` branch, as of 2026-08-21

**Reviewer:** adversarial read of the branch against [[PLAN-loop-service]] and
[[PLAN-sqlite-run-store]].
**Scope:** steps 0–3 as built (`src/service/*`, `run-index.ts`, `run-store.ts` schema v5, `web/`).
Steps 4–6 (supervisor, gate transport, deploy) are unbuilt and are reviewed only where the built
code has already committed to a decision that will bite there.
**Baseline verified before writing:** `npm test` → **382/382 green**, `tsc --noEmit` clean in both
`orchestrator/` and `web/`. Everything below survives that suite — which is itself the point of
several findings.

Every claim marked **[confirmed]** was reproduced by running code on this branch, not inferred from
reading. Claims marked **[read]** are from the source alone.

---

## 0. The honest summary

The plan documents are better than most production designs I have read, and the code mostly does
what they say. `run-index.ts`, `query.ts`, and `errors.ts` are genuinely well-built: the ORDER BY
whitelist, the `ESCAPE '\'` on the free-text LIKE, `resolvePaging` being shared between the query and
the envelope, the facets honouring the same predicate as the list — these are the details that
usually get skipped and then cost a week.

The problem is not the code that exists. It is that **three of the load-bearing decisions in the plan
have not been reconciled with the loop they are driving**, and the built code has already committed
to them. In particular:

1. The second service-initiated run on any branch **cannot start**. Not "may race" — cannot start.
   This is a direct consequence of §4's mint-at-enqueue crossed with `derivePaths` keying the run dir
   by `repo+branch`, and it is guaranteed, not probabilistic. **[confirmed]**
2. Making the service a writer (correctly identified in §3) was implemented such that **every request
   carrying a session cookie is a write**, including `GET /api/health` and every static asset. Under
   a child's write lock that turns the whole API into a 5-second stall followed by a blanket
   HTTP 500. **[confirmed]**
3. `POST /api/runs` is live, validated, and attributed — and **nothing on earth will ever execute the
   rows it writes**, because the supervisor is step 4. There is no UI for the queue and no warning on
   the route. A teammate handed this URL today gets a silent black hole.

None of these are caught by the 382 tests, and (2) and (3) are not caught by the plan either.

---

## 1. Blocking — fix before step 4 lands

### 1.1 A branch can only ever be run once through the service **[confirmed]**

`derivePaths` (`front-terminal.ts:64`) derives the run dir from `${repoName}-${branch}` and nothing
renames it afterwards — `.stale-` is a manual convention (the only three references to it in `src/`
are read-side filters in `run-index.ts`). `resolveRunId` (`run-context.ts:79`) caches the id in
`<runDir>/.run_id` and, per §4's "established beats pinned", **throws** `RunIdConflictError` when
`CARE_RUN_ID` disagrees.

So: run #1 on `feat-x` completes, run dir persists holding id A. Run #2 on `feat-x` is enqueued, the
service mints id B, the supervisor spawns with `CARE_RUN_ID=B`, and the child dies immediately:

```
CARE_RUN_ID is 01M0GE0551P9DR2FY8F32T5BZ7 but <runDir> is already run 01M0GDZ… — refusing to rebind
```

Reproduced directly against `resolveRunId`. The same applies to any branch previously driven from
the CLI. §4 frames the throw as protecting against "a stale id pointed at an occupied dir", treating
an occupied dir as the anomaly — for the service, it is the **normal steady state**.

With the retry cap from §12 this becomes: three spawn attempts, `failed`, an error message about run
ids that means nothing to the person who asked for the run.

**Fixes, in order of preference:**

- **(a) Do what §12 already identified as the right answer: key the run dir by `run_id`, demote slug
  to a display label.** §12 calls this "not blocking; the cheaper rule buys time". That assessment is
  wrong now that ids are minted at enqueue — the cheap rule (queue-behind) only covers the
  *concurrent* case, and the failure above is the *sequential* one. This also retires queue-behind
  entirely, leaving only git's one-branch-one-worktree constraint on the worktree path.
- **(b) If (a) is too large for step 4:** have the supervisor resolve the run dir's established id
  *before* spawning, and, when the dir already has one, **adopt it** — update `queue.run_id` to the
  established id and return that from a subsequent `GET`. This makes `POST /api/runs`'s
  synchronously-returned id provisional, which is a real cost, and the `queue.run_id UNIQUE`
  constraint will collide on the second re-run of a branch. Workable but ugly.
- **(c) Cheapest stopgap, correctness-preserving:** archive the run dir on terminal exit
  (`mv <dir> <dir>.stale-<ts>`) so a fresh run always starts on a fresh dir. This also makes the
  `stale` column honest (see §4.3) and is a supervisor-local change.

Whichever is chosen, **add the test now**: enqueue → spawn → finish → enqueue the same branch again →
assert the second run starts. That is the missing case in `queue.test.ts`, which tests "same branch
while running" but never "same branch after finishing".

### 1.2 Every authenticated request is a writer, and a contended write 500s the whole API **[confirmed]**

`identity()` (`identity.ts:46`) calls `sessions.resolve()` on **every** request, and `resolve`
(`auth.ts:104`) unconditionally does `UPDATE sessions SET last_seen_at = ?`. The middleware is
registered first (`app.ts:118`), before `express.static`, so this includes health checks and every
JS/CSS/font byte.

Measured on this branch, with a child holding an open write transaction:

```
resolve while child holds write lock: THREW after 5438 ms: database is locked
pure READ while child holds write lock: 0 ms
```

The read costs nothing — WAL is doing exactly its job. The session touch burns the full 5s
`busy_timeout` and then throws, and because `identity` is middleware (not wrapped by `route()`) the
throw reaches the error handler as an unmodelled error: **HTTP 500 `{"code":"internal"}` on every
route, for every signed-in user, for as long as the lock is held.** A read-only dashboard poll that
would have been served instantly instead hangs for five seconds and fails.

`concurrency.test.ts` does not catch this because it interleaves *completed* writes; it never holds a
transaction open across the other connection. That is the test to add.

**Fix:**

- Throttle the touch: skip the UPDATE unless `last_seen_at` is older than, say, 60s. One extra
  comparison, and it removes the write from ~99.9% of requests. (`resolve` already has the row in
  hand from the SELECT.)
- Make `resolve` failure non-fatal to identification: a `SQLITE_BUSY` on the *bookkeeping* write must
  not cost the caller their identity, let alone the request. Wrap the UPDATE in its own try/catch and
  log.
- Independently: `/api/health` must not depend on the middleware. Register it **before**
  `identity()`. Confirmed today that a dead db + a cookie yields `500 internal` where a dead db alone
  correctly yields `503 {ok:false}` — health is precisely the route that must survive.
- Add the contention test: open a write txn on connection A, assert connection B still serves
  `GET /api/runs` and `GET /api/health` promptly.

### 1.3 `POST /api/runs` accepts work nothing will run

The route is complete, validated, and attributed. There is no supervisor, no `useQueue` hook in the
frontend (`web/src/api/queries.ts` has no queue query at all), and no "New run" form. `/api/health`
reports `supervisor: null` and nothing surfaces it.

This is defensible as an unfinished step; it is **not** defensible as a deployed state, and the
branch is otherwise deployable. Before this is reachable by anyone but the author, either:

- gate the route behind a `deps.supervisor` that is absent today and 503 with
  `{code: "no_supervisor"}` when it is, or
- surface pending rows in the fleet view with an explicit "queued — no supervisor running" state.

The first is three lines and is the honest one.

### 1.4 `reindex` will corrupt a live run, and nothing stops it

`reindexRuns` (`reindex.ts:92`) opens its own store and runs `store.clearAll()` → `DELETE FROM runs`,
cascading to `run_events`. If a child is mid-run, its next `Journal.append` inserts an event whose FK
parent no longer exists → FK violation → **fatal by design** (§2's "both writes are fatal") → the run
halts, hours in.

The plan repeatedly calls `rm loops.db && reindex` "a complete recovery" and the acceptance test of
the whole projection. That was true when runs were driven one-at-a-time from a terminal by the person
typing the command. With an always-on service and N children it is a foot-gun with a friendly name,
and `care-loopd reindex` is documented in `usage()` as **"Safe at any time"** (`cli.ts:79`). It is
not.

**Fix:** before `clearAll()`, refuse if any run is live — `SELECT COUNT(*) FROM queue WHERE status =
'running'`, plus a directory scan of `inspectLock` (which §12 already schedules for step 4). Add
`--force`. And correct the usage string. Secondarily: wrap each run's replay in one transaction so a
crash mid-reindex does not leave the serving database half-rebuilt.

---

## 2. Correctness bugs (confirmed, small, fix now)

### 2.1 Malformed JSON body returns 500, not 400 **[confirmed]**

```
POST /api/auth/login  body: "{not json"
→ 500 {"error":{"code":"internal","message":"internal error"}}
```

`express.json()` throws a `SyntaxError` carrying `status: 400`; `sendError` (`errors.ts`) only
recognises `ApiError` and maps everything else to 500. §6 states plainly: "`400` malformed". The
frontend cannot distinguish "I sent garbage" from "the server is broken".

**Fix:** in `sendError`, honour an `err.status`/`err.statusCode` in the 4xx range (or special-case
`err instanceof SyntaxError && "body" in err`) and emit `{code: "bad_json"}`. Four lines, one test.

### 2.2 `X-Care-User` is unvalidated where `/auth/login` is strict **[confirmed]**

```
POST /api/runs   X-Care-User: "  <script>alert(1)</script> not a login  "
→ 201; queue row requested_by = "<script>alert(1)</script> not a login"
```

`auth.ts` has `isValidLogin` (GitHub's exact rule) and `/auth/login` enforces it — with a good comment
about typos filling the roster with junk. `identity.ts:52` trims the header and trusts it verbatim.
Same field, same column, two standards. That string becomes a `requested_by` facet value, a filter
value, and a display label; React escapes it in the DOM, but it is still permanent junk in the data
and a needless injection surface for any future non-React consumer (a Slack notifier, a CSV export).

**Fix:** run the header through `isValidLogin` and 400 on failure. One line, and it is the same line
that gets deleted when real auth lands.

### 2.3 `SELECT changes()` as a separate statement is a fragile way to read a result

`queue.ts:178` and `queue.ts:208` run `UPDATE …` and then `SELECT changes() AS n` as a second
prepared statement. It happens to work — a SELECT does not reset the counter — but `node:sqlite`'s
`.run()` already returns `{ changes, lastInsertRowid }`. The current form is one refactor away from
silently reading someone else's change count, and it costs an extra round trip on the hot claim path.

**Fix:** `const { changes } = stmt.run(...)`.

### 2.4 `--port` accepts garbage

`cli.ts:818`: `Number.parseInt(sf.port, 10)` with no NaN guard. `care-loopd serve --port abc` binds a
random OS-assigned port and prints `http://127.0.0.1:NaN`. Also, `app.listen` has no `'error'`
handler, so `EADDRINUSE` surfaces as an unhandled `'error'` event and a stack trace instead of "port
3142 is in use".

---

## 3. Design gaps the plan has not yet reconciled

### 3.1 §4 and §5 contradict each other about the child and the queue

- §4: **"The child never sees the queue."** Repeated verbatim in `queue.ts`'s header comment.
- §5, Cancel: "the child **reads its own queue row** at each step boundary and exits cleanly".

Both cannot be true, and the one that is chosen determines whether the child keeps a DB coupling to a
service-owned table — which §4 names as the property that "keeps the child the same binary you run
locally". This needs settling *before* step 4 writes it down in code.

**Recommendation:** keep §4. Cancel via `SIGTERM` to the child with a grace period, and let the
existing crash-only `resume` machinery be the recovery — that is precisely what it is for, and §5
already concedes "a killed run is just a resumable one". The queue row then stays purely the
supervisor's, and the child stays credential- and schema-isolated from the service.

### 3.2 Admission control is blind to CLI-started runs

`QueueStore.liveOn` and the `NOT EXISTS` guard inside `claim()` (`queue.ts`) consult **only the queue
table**. A run started from a terminal on `feat-x` has no queue row. The service will happily claim a
queued row for `feat-x`, spawn, and the child will die on `withLock(runDir)` — after the worktree
setup, and reported as a spawn failure.

§12 already names the missing primitive (`inspectLock(runDir) → {held, pid, alive}`) and schedules it
for step 4. Make sure the claim query consults it (or `runs.step NOT IN TERMINAL_STEPS` as a cheap
pre-filter), not just the queue. Otherwise the loop's lockfile — a correctness invariant — is doing
the job of an admission policy, hours late and with a confusing error.

### 3.3 `queued_behind` is a snapshot of the wrong thing

`app.ts:241` reports the oldest live row on the same `(repo, branch)`. It says nothing about the
concurrency cap, which is the far more common reason a run does not start immediately: with
`CARE_SERVICE_CONCURRENCY=2` and five queued runs on five different branches, three callers are told
`queued_behind: null` and will reasonably expect their run to be starting.

**Fix:** either rename it to `blocked_by_branch` and add a separate `queue_position`, or make it
report true position: `COUNT(*) FROM queue WHERE status='pending' AND enqueued_at < :ours`. The
latter is what the field's name promises. Freeze this before the FE's new-run form (step 5) renders
it.

### 3.4 The `queue` list is the one route that breaks the plan's own envelope rule

§6 Conventions: *"Pagination added later to a bare array is a breaking change, and this contract is
frozen before the FE is written."* The very next table then specifies `GET /queue → { items }` with
no `total`/`limit`/`offset`, and `app.ts` implements it. `QueueStore.list` also uses its own
defaults (200 default / 500 max, `queue.ts:118`) against the API's 50/200 everywhere else.

Small, but it is *exactly* the mistake the convention was written to prevent, and it is cheapest to
fix in the week the contract is frozen rather than after the FE ships against it.

### 3.5 `allowedRepos` and `secureCookies` are unreachable configuration

`AppDeps` exposes `allowedRepos`, `secureCookies`, `staticDir`, `backupDir`, `backupIntervalMs`,
`backupKeep`. `cli.ts:814` passes **`dbPath`, `port`, `host`** and nothing else. So the repo
allowlist is hard-coded to `["ohcnetwork/care_fe"]` at `app.ts:208`, and — more importantly —
**§6's "put Tailscale in front, which gives real HTTPS … and flips `secureCookies` on" cannot be
done**, because there is no flag. Step 6 will discover this at deploy time.

**Fix:** wire the flags now (`--secure-cookies`, `--static`, `--repos`, `--backup-dir`), or read them
from env in `serve.ts`. Ten minutes, and it un-blocks step 6.

---

## 4. Robustness and hygiene

### 4.1 Shutdown will hang under systemd

`serve.ts:120` — `server.close(cb)` waits for in-flight *and idle keep-alive* connections. Browsers
hold keep-alive sockets open; a dashboard left open on someone's second monitor is enough to make
`SIGTERM` never complete, and systemd will `SIGKILL` after its timeout on every restart. This gets
strictly worse at step 2's SSE endpoint, where connections are open **by design** and will never
close on their own.

**Fix:** `server.closeAllConnections()` (Node 18.2+) after `server.close()`, plus a hard
`setTimeout(() => process.exit(1), 10_000).unref()` as the backstop. Also: `startService` registers
`SIGINT`/`SIGTERM` handlers on every call with no removal — harmless in production, a listener leak
in any test that starts more than one service.

### 4.2 `Journal.append` re-reads the entire replica on every event — O(n²) per run **[read]**

`journal.ts:225` calls `truncateTornTail()`, which calls `rawLines()` = a full `readFileSync` + split,
on **every append**, solely to hash the last line for `prev`. §10 item 8 is right that `prev` must
come from the replica; that does not require re-reading the whole file.

The current live fleet is 1314 events / 432 KB, so a long run re-reads a growing file ~2000 times.
Measured cost is small today. It is the shape that is wrong, and it scales against the exact thing
this branch exists to increase (more runs, longer runs, N of them at once).

**Fix:** cache the last raw line on the `Journal` instance after each successful append; read the
file only when the cache is cold (first append of a process) or after a torn-tail repair. Behaviour
identical, I/O constant.

### 4.3 `stale` is still a filesystem naming convention leaking into a SQL predicate

`run-index.ts:197,287` — `slug.includes(".stale-")` and `slug NOT LIKE '%.stale-%'`. §12 already
flags this and prescribes an explicit `archived_at` on `runs`. Worth doing **with** the fix for 1.1(c)
if you take that route, since that is the code that will be doing the renaming.

Note also: nothing in `src/` ever *writes* a `.stale-` name. The filter is currently matching a
convention no code produces.

### 4.4 Unbounded free text, unbounded queue

`POST /api/runs` accepts a 1 MB JSON body and `validateSeed`'s `task`/`summary` validators only check
non-empty. A 1 MB task string lands in `queue.task` and later `run_detail.task`, and every fleet
`?q=` search LIKEs across it. There is no rate limit and no per-user queue cap, so anyone reachable
on the VPN can enqueue unbounded rows. Cheap guards: cap `task` at ~4 KB and `summary` at ~200 chars
in `REQUIRED_FIELDS` (which also improves the CLI's errors), and cap pending rows per
`requested_by`.

### 4.5 `VACUUM INTO` blocks the event loop

`node:sqlite` is synchronous, so the 6-hourly `backupNow` freezes the entire service for the duration
of the vacuum. Irrelevant at 1.1 MB; state the threshold in the code so it is not rediscovered as a
mystery latency spike. (Also: snapshots default to `runs/backups/`, i.e. inside the tree `reindex`
scans and anything that zips a run tree will sweep up — harmless today, worth a line of comment.)

### 4.6 `--test-force-exit` is hiding handle leaks

`package.json`'s test script uses `--test-force-exit`, which is exactly what would mask 4.1's
listener leak and any un-closed db handle. Worth removing once and seeing what falls out.

### 4.7 `@types/express` is in `dependencies`

Should be `devDependencies`. Trivial, but this package is installed on the server.

---

## 5. Frontend

Generally clean; the query-key design and the `placeholderData` choice are right. Three notes:

- **The timeline silently truncates at 2000 events.** `useRunEvents` (`queries.ts`) fetches
  `limit: 2000` in one shot and ignores `next_seq`, which the API returns specifically so it does not
  have to. The live fleet already has runs at 327 events; 2000 is one long run away, and the failure
  is invisible — the timeline just stops. Use `useInfiniteQuery` with `next_seq`, or at minimum
  render a "showing first 2000 of N" banner from `run.eventCount`.
- **Unknown search params flow straight to the API.** Verified: TanStack Router *merges* validated
  output over the raw search rather than replacing it, so `?offset=50` (not read by `validateSearch`)
  survives into `useSearch()` and is forwarded by `qs(filters)`. Pagination therefore works — but
  `router.tsx:33`'s comment ("Validated here so a hand-edited URL degrades to a sane view instead of
  sending garbage to the API") overstates what is happening. Either whitelist keys on the way out in
  `qs`, or reword the comment.
- **`AuthGate` blocks the entire app behind a login form** although every read route serves anonymous
  callers and `/auth/me` is designed to answer 200-with-null precisely so the FE can branch. Product
  call, not a bug — but it means the "not authentication" disclaimer on the form reads as a lie to a
  first-time user who just wants to look at the fleet. Consider read-only-when-anonymous.

---

## 6. Test coverage against §10's own list

§10 names nine tests. Present and good: **claim is atomic** (`concurrency.test.ts`'s two-connection
race is the right test, and the "a bare connection really is unconfigured" guard against a decorative
helper is excellent practice), **concurrent writers** (partially — see 1.2), **restore**
(`backup.test.ts`).

Absent, and all of them belong to step 4: queue cap, reconciliation of the three §4 rows, restart
mid-run, spawn failure, gate round-trip, the gate front. Expected.

**Missing tests that the code as it stands today already needs:**

| Test | Guards |
|---|---|
| Re-run the same branch after the first finishes | 1.1 — the guaranteed failure |
| Hold a write txn on conn A; assert conn B serves reads and `/health` | 1.2 |
| Malformed JSON body → 400 | 2.1 |
| Junk `X-Care-User` → 400 | 2.2 |
| `reindex` refuses while a run is live | 1.4 |
| `/health` with a cookie and a dead db → 503 | 1.2 |

---

## 7. Suggested order

1. **1.2** (session-touch throttle + health before identity + non-fatal bookkeeping write) — smallest
   diff, largest blast radius removed.
2. **2.1, 2.2, 2.3, 2.4** — an hour, all with tests.
3. **1.3** — gate `POST /api/runs` on a supervisor. Three lines.
4. **1.4** — `reindex` live-run guard + fix the "safe at any time" usage string.
5. **3.5** — wire the config flags; un-blocks step 6 and costs nothing.
6. **3.1, 3.3, 3.4** — settle the contradictions *on paper* before step 4/5 code exists.
7. **1.1** — the real design decision. Prefer keying run dirs by `run_id` (§12 already describes it);
   take the archive-on-exit stopgap only if step 4 must ship first.
8. **4.1, 4.2** — before the SSE endpoint and before run lengths grow.

Items 1–5 are roughly a day. Item 7 is the one worth arguing about, and it is worth arguing about
**now**, because every additional run recorded under the current scheme is another run dir pinned to
a branch name.
