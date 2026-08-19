# PLAN — `RunStore`: SQLite as the run store, with the journal as a verified replica

**Status:** BUILT 2026-08-19; six passes through 2026-08-20 (see "As-built" at the end of this doc
for all of them — three the first day, then parity-at-resume, the §9 evaluation run for real, and the
first lived-through run). The database is now the source of truth end-to-end (§2 third pass, §10
cutover) — `Journal.read()` is DB-backed, `resume`/`projectState` go through it, and the jsonl
replica is written for assurance/forensics/`reindex`/the doctor but is no longer on any live
control-flow path.
**Owner:** care-loop
**Motivated by:** the loop-service bring-up (making `loopd` callable by the team, bot-authored PRs
assigned to the caller). The fleet list must answer "my runs" cheaply, and the current list view
re-parses every event of every journal on a 10s refresh.
**Related:** [[PLAN-orchestrator-architecture]] §5 (journal = single source of truth — superseded by
this plan's §2/§10), §6 (resume IS recovery — now DB-backed) and §9 (config & layout) — unchanged.

**Three positions were taken the same day** — journal-authoritative with best-effort DB writes, then
DB-authoritative-for-fleet-queries only, then the full §10 cutover below. See "As-built" for the
complete history. What was actually **dropped** is narrow: `--no-db` (both the flag and the silent
auto-fallback). What **remains**, contrary to the retirement version that was drafted and rejected:
the jsonl replica is still written on every append, `reindex` still rebuilds the DB from it,
`state.json` is still written, and the doctor's reader is untouched.

---

## 1. Why

`/api/runs` calls `summarizeRun` per run dir, which does `new Journal(...).read()` and folds the
**entire** event stream to compute `startedAt`, `durationMs`, `lastCost`, and `eventCount`
(`dashboard.ts:75-105`). The page auto-refreshes every 10s (`dashboard.html:901`). With one user and
a handful of runs this is free. With a team, tabs left open, and a growing `runs/`, it is the first
thing to degrade — and it degrades as a sluggish dashboard, not as an obvious bug.

Separately, the service needs `requested_by` per run so a caller can filter to their own runs, and
cross-run questions ("how often does 6b need a second round?") are today a bespoke script over every
journal.

## 2. The invariant (revised 2026-08-19, third pass)

**The database is the source of truth. The journal is a written, continuously verified replica.**

Everything reads the DB — fleet queries and per-run control flow alike, including `resume` and
`projectState`. `journal.jsonl` is still written on every append and still greppable, but nothing
depends on it at runtime. It exists to be *diffed against* the truth (§9) and to *rebuild* it (§8),
which are jobs a backup can only do if something actually checks it.

This is a third position, not a return to the first. The first pass made the journal authoritative and
DB writes best-effort. The second made the DB authoritative for fleet queries only, leaving per-run
control flow on the journal — a split ownership that is what let the §2 text and the code disagree
about which writes were fatal. The third resolves it in one direction: **one truth, one replica, one
check.**

- **Both writes are fatal.** A journal append failure and a DB write failure each halt the run.
  (An earlier revision of this section claimed the jsonl write was "logged, not fatal." That was never
  true of the code — `journal.ts`'s write is `try/finally` with no `catch` — and it must not become
  true: a replica with holes cannot verify or rebuild anything.)
- **DB first, then journal.** ⚠️ *Correctness-critical, and the easy thing to get backwards.* Today the
  jsonl is written first. Under DB-as-truth a crash between the two writes would leave the replica
  holding an event the truth lacks — the authoritative copy silently short an event, and the §9 check
  flagging it forever with no way to tell which side is right. Reversed, a crash leaves truth correct
  and the replica lagging: detectable and repairable.
- **`seq` and `deltaMs` come from the DB; `prev` comes from the replica.** ⚠️ *Correctness-critical.*
  `seq` and `deltaMs` are ordering facts, and letting the replica define them would invert ownership
  on the field that sequences everything. **`prev` is not an ordering fact** — it is the replica
  file's own integrity checksum, a property of the bytes on disk. An earlier revision of this bullet
  lumped all three together and sourced `prev` from the DB too; §10 item 8 records what that broke.
- **`synchronous = FULL`.** Once `resume` reads the DB, a power loss that drops the DB tail resumes
  from a stale state while the journal holds the truth. That is divergence on the recovery path
  specifically, which is the worst place to have it.
- **No `--no-db`.** `NullRunStore` survives only as a test double. A run that cannot reach the DB can
  no longer resume or project state, so the flag is not an opt-out any more — it is a broken mode.
- **The parity check is load-bearing, not optional** (§9). "Journals for comparison" is only true if
  something compares.

**The doctor needs no changes.** It reads `journal.jsonl` directly, and the file is still written
exactly as before. This is the main thing keeping the journal rather than retiring it buys.

**Status:** all of the above is BUILT (third pass — see As-built). The two ⚠️ items and the
`Journal.read()` swap landed together; 291/291 tests green.

Consequence worth stating: `stale` is NOT a column. It derives from the run directory being renamed
with a `.stale-` suffix — a filesystem fact, not a journal fact. Storing it would quietly make the DB
authoritative for something the rebuild cannot reproduce. `RunIndex` computes it from `slug` at read
time.

### The invariant is scoped to the run tables

[[PLAN-loop-service]] adds `queue` and `gate_asks` to this same database. Those are **service-owned
state with no journal behind them** — a pending request is not a run yet, and a gate answer is not run
data. They are not exceptions to the invariant so much as outside it:

- `reindex` rebuilds `runs` / `run_detail` / `run_rounds` / `run_events` and **must not touch** the
  service tables. Its `DELETE FROM runs` is scoped by design; deleting a `queue` row is unrecoverable
  where deleting a `runs` row is not.
- **`synchronous = FULL`** — already set (§10 item 4), so the service tables inherit it. This was
  going to be required for them regardless: `NORMAL` is justified by rebuildability, which
  `queue`/`gate_asks` do not have, and a power loss under it can drop a pending request or an
  answered gate.

## 3. Schema

`runs/loops.db`, alongside the run dirs it projects.

```sql
PRAGMA journal_mode = WAL;      -- N child processes, one writer per row
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = FULL;      -- §10 item 4: the DB is what Journal.read()/resume trust
PRAGMA foreign_keys = ON;
PRAGMA user_version = 2;        -- migration hook; no schema_version table. v2 = parity_error.

-- Exactly what the fleet list renders or filters on. No unbounded TEXT.
CREATE TABLE runs (
  run_id       TEXT PRIMARY KEY,   -- ULID, minted once at run.start
  slug         TEXT NOT NULL,      -- dir basename; full path = <runs-root>/<slug>
  requested_by TEXT,               -- GitHub login; NULL for local CLI runs
  repo         TEXT NOT NULL,      -- owner/name
  branch       TEXT NOT NULL,
  tier         TEXT NOT NULL,      -- trivial | standard | complex
  step         TEXT NOT NULL,      -- STEP_VOCAB, current
  round        INTEGER NOT NULL,   -- current round; the list renders it (dashboard.html:668)
  pr           INTEGER,            -- NULL until opened
  started_at   TEXT NOT NULL,      -- ISO-8601 UTC = events[0].ts (re-asserted post-fold, §10 item 9)
  updated_at   TEXT NOT NULL,      -- ISO = last event ts
  -- Rollups, MATERIALIZED at write time (see note below). Short scalars only.
  event_count  INTEGER NOT NULL DEFAULT 0,
  cost_usd     REAL    NOT NULL DEFAULT 0,   -- NOT NULL: the incremental UPDATE adds to it
  duration_ms  INTEGER NOT NULL DEFAULT 0,   -- active duration, run.resume gaps excluded
  parity_error TEXT                          -- §10 item 7: last run.end divergence; NULL = clean
);

-- Cold / unbounded columns. Nearly write-once; the detail view joins by PK.
CREATE TABLE run_detail (
  run_id            TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
  task              TEXT NOT NULL,  -- free text, the one genuinely unbounded column
  ticket            TEXT,           -- ENG-###
  summary           TEXT,           -- PR-title summary
  worktree          TEXT NOT NULL,
  head_sha          TEXT,
  last_reviewed_sha TEXT
);

-- Real 1:N. Today collapsed into `round INTEGER` on the state.
CREATE TABLE run_rounds (
  run_id        TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  round         INTEGER NOT NULL,
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  triage_total  INTEGER,
  addressed     INTEGER,
  declined      INTEGER,
  apply_outcome TEXT,               -- fixed | handoff | noop
  ci_outcome    TEXT,               -- converged | capped | deferred | gate-blocked
  pushed_sha    TEXT,
  cost_usd      REAL,
  PRIMARY KEY (run_id, round)
);

-- AUTHORITATIVE since the §10 cutover: this is what Journal.read() returns and resume folds.
CREATE TABLE run_events (
  run_id   TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  seq      INTEGER NOT NULL,
  ts       TEXT NOT NULL,
  event    TEXT NOT NULL,
  step     TEXT,
  round    INTEGER,
  data     TEXT,                    -- JSON, verbatim
  cost_cum REAL,
  prev     TEXT NOT NULL,           -- sha256 chain preserved verbatim
  PRIMARY KEY (run_id, seq)
);

CREATE INDEX idx_runs_mine   ON runs(requested_by, started_at DESC);
CREATE INDEX idx_runs_recent ON runs(updated_at DESC);
CREATE INDEX idx_events_kind ON run_events(event, ts DESC);
```

**No CHECK constraints on `tier` / `step`.** `validateState` already hard-rejects out-of-vocabulary
values before anything reaches the DB, and `STEP_VOCAB` is actively evolving. Mirroring it into SQL
would put a moving vocabulary in a second place that needs a schema migration to change. The DB is
downstream of validated state; the TypeScript owns the invariant.

**`event_count` / `cost_usd` / `duration_ms` ARE materialized columns on `runs`** (revised
2026-08-19; an earlier draft made them a VIEW). Indexes cannot materialize aggregates and SQLite has
no materialized views, so a VIEW means recomputing a `GROUP BY` over all events of all runs on every
fleet query — growing with total event volume, which is the exact scan this plan exists to remove.
`duration_ms` cannot be indexed at all: it is a sequential fold (sum the gaps between consecutive
events, dropping the gap that lands on a `run.resume`).

Materializing is free: `projectAndWrite` already holds the full event array, so all three compute at
write time with no extra I/O. The fleet list is then a single-table query with no joins and no
aggregates. Do NOT add indexes on these columns until a sort-by-cost/duration UI exists — at a few
hundred rows, sorting is free.

### Driver

`node:sqlite` (`DatabaseSync`) — zero new dependencies, synchronous API matching a codebase that is
synchronous I/O throughout (`spawnSync`/`readFileSync`/`fsyncSync`), no native build step on deploy.
As-built note: it works (experimental-warning only, no `--experimental-sqlite` flag needed) on plain
Node 22.19 — the "requires 24+" caution in an earlier draft does not hold for the unflagged surface
this plan uses. `better-sqlite3` has the same `prepare/run/get/all` surface if a pin is ever needed —
the port in §4 makes them interchangeable.

## 4. Write path — two chokepoints, not 141

Measured, not assumed:

| Surface | Call sites | Chokepoint |
|---|---|---|
| `Journal.append({...})` | 118 occurrences of `.append({` (105 via a `j.` receiver; the other 13 are `auto-doctor.ts` on a differently-named handle) | `Journal.append()` — one method |
| `projectAndWrite(runDir, events)` | 23 (excluding the definition), across 6 files | one function |
| `new Journal(...)` | 10 total — 8 write-path, 2 read-only in `dashboard.ts` | needs a store handle |

Re-measure these at build time; they drift with every new code path (§5 shows the derive-site
inventory drifting from six to ten between drafting and review).

So mirroring events hooks inside `Journal.append`, and the `runs`/`run_detail`/`run_rounds` upsert
hooks inside `projectAndWrite`. **No call site changes.** Only construction needs touching, and a
`openRun(runDir, runId)` factory removes even those 8.

Note `projectAndWrite(runDir, events)` already receives the full event array at every call site — so
`started_at`, `event_count`, `cost_usd`, `duration_ms`, and the whole `run_rounds` fold are all
computable there with **zero extra I/O**. The rollup logic is a straight lift of what `summarizeRun`
does today; the computation moves from read-time-per-poll to write-time-once.

### The port

Following the `GitHubApi` / `ports.ts` / `PlanGate` idiom:

```ts
export interface RunStore {
  upsertRun(state: CareState, rollups: RunRollups): void;  // fatal on failure (§2)
  appendEvent(runId: string, ev: JournalEvent): void;      // fatal on failure (§2)
  close(): void;
}
```

Implementations: `SqliteRunStore` everywhere, local CLI included, and in-memory SQLite (`:memory:`)
for tests via `test/_store.ts`'s `useRealStore()`. `openRunStore(dbPath: string)` takes no `undefined`
and throws if the path cannot be opened — **there is no `--no-db` production path** (§10 item 5).
`NullRunStore` survives as a test double only; since `read()` is DB-backed, a run against it looks
permanently empty, which is exactly why it cannot be a fallback.

Each child process writes only its own rows, so WAL gives no contention beyond file-level write
serialization. Wrap the `runs` + `run_detail` upsert in one transaction so a crash cannot leave a
`runs` row without its mate.

### Rollups must update at BOTH chokepoints

Events mirror on every `Journal.append`, but `projectAndWrite` fires only at step transitions. If the
rollups refreshed only in the latter, an active run mid-step would show `event_count` / `cost_usd` /
`updated_at` lagging `run_events` — and the §9 parity diff would fail on exactly the runs that are
live when it runs.

So `appendEvent` also does an incremental update, which is free since every input is in hand:

```sql
UPDATE runs SET event_count = event_count + 1,
                updated_at  = :ts,
                cost_usd    = cost_usd + :event_cost, -- data.cost_usd on skill.result, else 0
                duration_ms = duration_ms + :delta    -- 0 when the event is run.resume
 WHERE run_id = :run_id;
```

`:delta` is `ts - <previous event ts>`, taken from `store.getLastEvent(runId)` — the same call that
supplies `seq` and `prev` (§10 item 2; it read the jsonl tail before the cutover). Forced to 0 on
`run.resume`, the same rule as the `summarizeRun` fold.

**`:event_cost` is `data.cost_usd` on a `skill.result` event and 0 otherwise — NOT `cost_cum`.** The
full recompute lifts `summarizeRun`, which deliberately sums the per-event `data.cost_usd` because
`cost_cum` "was not accumulating correctly" on older journals (`dashboard.ts:77-78`). The incremental
and full forms MUST compute the same quantity; if they disagree, the row's cost flips definition
between chokepoints and the §9 parity diff fails on exactly the live runs this section exists to
keep consistent.

`projectAndWrite` keeps doing the FULL recompute from the event array. That gives a self-healing
property worth stating: incremental keeps the row fresh between transitions, and the full recompute
reconciles any drift at the next step boundary, so error cannot accumulate across a run.

### `appendEvent` must seed the parent row

The store hook lives in `Journal.append`, so the very first append — `run.start` — reaches the store
BEFORE any `projectAndWrite` has upserted a `runs` row. With `foreign_keys = ON`, that `run_events`
INSERT violates the FK.

Under §2's fatal writes this now fails loudly on the first event of every run rather than silently
dropping it, so it cannot ship broken — but it still has to be fixed, not merely surfaced. (It is
worth recording what the failure mode *was* under the first pass's best-effort writes, because it is
the reason this subsection exists: the error was swallowed and the event row went permanently missing,
since the full recompute reconciles rollup columns but never re-inserts event rows. Only a `reindex`
recovered it, and nothing pointed at it.)

Fix: when the event is `run.start` or `run.resume`, `appendEvent` **seeds a minimal `runs` row** from
the `data.state` those two events carry, before inserting the event. The ordering invariant that makes
this sufficient: `run.start` is always the FIRST event — seq 0, since `append()` numbers from zero
(`nextSeq = last ? last.seq + 1 : 0`). `pipeline.ts:110` seeds it only when the run is empty and
`plan.ts:71` appends it first otherwise, so the parent row exists before any other event can
reference it.

(Dropping the FK also works — `reindex` can delete the tables explicitly rather than relying on the
cascade — but under §2 `run_events` is authoritative data rather than a rebuildable mirror, so the
constraint is worth more now than it was. Keep it and seed.)

**Regression guard:** assert `COUNT(run_events) == <journal event count>` after a LIVE run, not only
after a `reindex`. A reindex-only assertion is blind to precisely this class of bug. §9's standing
parity check subsumes this once built.

## 5. Stable `run_id` — do this first

`run_id` already exists on every journal event, but it is **derived**, not minted:
`${repo.replace("/","-")}-${branch}`, recomputed independently at **ten** sites (re-measured
2026-08-19 via `grep -rn 'replace("/", "-")' src/*.ts` — an earlier draft said six):

`adopt.ts:168` · `cli.ts:281` · `cli.ts:386` · `cli.ts:545` · `default-wiring.ts:104` ·
`default-wiring.ts:436` · `ci-round.ts:172` · `orchestrate.ts:94` · `pipeline.ts:94` · `plan.ts:48`

`adopt.ts:168` is worse than a missed site: it derives from `prInfo.headRef` rather than `branch`, so
the salvage path mints ids by a DIFFERENT formula into the same namespace. Step 1 must be a
grep-driven sweep, not a walk of a hardcoded list — the derived id has been metastasizing with each
new code path, which is itself the argument for minting once.

That is not unique per run: reuse a branch, or re-run the loop on the same branch months later, and
two distinct runs collide on the same id. As a primary key that is a defect, and deduplicating a
year of history after the fact is the migration that actually hurts.

**Mint a ULID once at `run.start`** (lexicographically time-sortable, so it doubles as a chronological
key), persist it in `CareState`, and have all ten sites read it instead of recomputing. Keep the
`repo-branch` slug for directory naming — a good human label and a bad key.

**ULID implementation:** no dependency. Node has no built-in ULID and the orchestrator is
deliberately dependency-light (`node:sqlite` is chosen partly for that), so write the ~20-line
Crockford-base32 helper — 48-bit timestamp + 80 bits from `crypto.randomBytes` — in `run-id.ts` with
a monotonicity test.

**Pre-existing runs on the LIVE path, not just `reindex`.** §8 backfills ids during a rebuild, but a
`resume` of a run recorded before this step projects a state with no `run_id`; once §6 makes it
required, `validateState` throws — the exact worst-timed failure §10 warns about. So `run.resume`
mints-or-backfills using the same deterministic recipe as §8 (`ULID(started_at, hash(slug))`), and
`resume.test.ts` gains a pre-ULID fixture. NOT nullable-with-skip: a store that silently drops rows
lacking an id is invisible data loss precisely where §2 promises recoverability.

This is the only item on the plan with a deadline: it gets more expensive with every run recorded.

## 6. `CareState` widening

`KEY_ORDER` is the canonical schema and `validateState` rejects ad-hoc keys (IMP-3), so widening is
deliberate and centralised. Add, all as flat scalars through `validateState`:

- `run_id` — the ULID from §5
- `requested_by` — GitHub login, nullable. Resolved by ONE function,
  `run-context.ts#resolveRequestedBy()`, read by all four seed sites (`pipeline.ts`, `plan.ts`,
  `adopt.ts`, `ci-round.ts`) — deliberately not re-derived per site, which is how `run_id` drifted
  into three formulas inside one journal (§5). Source is `CARE_REQUESTED_BY`, which the
  [[PLAN-loop-service]] supervisor sets per child process from the caller's `X-Care-User`;
  `--requested-by <login>` is CLI sugar over the same variable. NULL for a local run is the
  documented default, not a gap. Set once at seed time — `resume` re-projects it from the journal, so
  resuming someone else's run never rewrites the attribution.
- `ticket`, `summary` — today journaled only in `plan.approved.data` (`plan.ts:211`); promote so they
  project into the row rather than being re-read from the event stream
- `started_at` — `events[0].ts`, re-asserted AFTER the fold, not merely seeded before it (§10 item 9)

`state.json` keeps being written, **additively widened** — not unchanged. `KEY_ORDER` gains five
keys, and `state.ts:1-5` promises the doctor and fleet tooling a stable shape. Additive keys should be
harmless, but step 2 must check the doctor's reader (and `care-loop-doctor/SKILL.md`'s documented
contract) rather than assume it. `state.json` stays the crash-visible, greppable artifact, still written by
`projectAndWrite` as the single write path; the DB does not replace it, and nothing reads it back.

## 7. Read path — `RunIndex`

`dashboard.ts` currently does `readdirSync` / `existsSync` / `Journal.read()` inline in its route
handlers. Introduce:

```ts
export interface RunIndex {
  list(filter?: { requestedBy?: string }): RunSummary[];
  get(runId: string): RunDetail | null;
}
```

with `SqliteRunIndex` today. The HTTP routes and the page never learn which implementation answered.
The fleet query becomes a single-table indexed scan with no unbounded TEXT in it:

```sql
SELECT * FROM runs WHERE requested_by = ? ORDER BY started_at DESC;
```

`get()` joins `run_detail` by PK and reads that run's events from `run_events`. `dashboard.ts` keeps a
`readReplica()` full-scan path, but only as the fallback for when `loops.db` does not exist yet — it
reads by directory slug, which is not a `run_id`, so it cannot go through the DB.

### `RunSummary` v2 — drop `task`

Today's `RunSummary` embeds the whole `CareState`, `task` included (`dashboard.ts:21-30`). Keeping
that would force the fleet query to join `run_detail` for a column nothing displays. Verified against
the renderer: the list row shows `name · step · pipeline · round · pr · tier · cost · duration ·
age(updated_at)` (`dashboard.html:655-673`) and **never reads `task`**. So v2 drops it, the fleet
query stays join-free, and `dashboard.html` needs no change — confirmed with the live smoke test
below rather than trusted.

The §9 parity diff is defined over v2's fields.

## 8. `care-loopd reindex` — migration and permanent recovery

One command, two jobs:

```
DELETE FROM runs;                       -- cascades to detail/rounds/events
for each dir in runs/:
    events = new Journal(dir/journal.jsonl).readReplica().events   -- NOT read(): that is DB-backed
                                                                   -- now, and this rebuilds the DB
    store.upsertRun(projectState(events), rollups(events))
    store.appendEvent(...) for each event
```

It is the one-time backfill, and after §10 it is the recovery path that makes flipping the read path
safe — rebuild the truth from the replica. Wired into the test suite
(`reindex.test.ts`) so the rebuild guarantee is enforced, not merely intended.

Runs predating §5 have no minted `run_id`: backfilled deterministically as
`ULID(started_at, hash(slug))` via `validateState`'s own self-healing fallback (the SAME mechanism
that backfills a live resume of a pre-ULID run — one rule, not two), so a re-index is idempotent
rather than minting fresh ids each time.

## 9. Evaluation — prove it on real data before anything depends on it

1. Run `reindex` over the existing `runs/` directory.
2. For every run, diff the `RunSummary` produced by `SqliteRunIndex` against the one
   `summarizeRun` produces today. They must match field-for-field.
3. Time `/api/runs` before and after, at current fleet size.
4. Re-run `reindex` and confirm the DB is byte-identical (idempotence).

Only after (2) is clean does the dashboard get pointed at `RunIndex`.

### The continuous parity check (§10 item 6)

The one-shot diff above needs a historical `runs/` tree, which does not exist on this box — which is
why step 4's evaluation is built but has never actually run. The standing version does not need one:
at `run.end`, fold `journal.read().events` through `projectState` and diff it against the DB-derived
state, plus assert `COUNT(run_events)` matches the journal's event count. Fail loudly.

That turns every run into evidence instead of waiting for a fleet to accumulate, and it is what makes
the journal a verified replica rather than an unchecked backup. It is also the gate for §10: flip the
read path once *N* consecutive runs are parity-clean, which is an objective criterion rather than a
judgement call.

## 10. Cutover — DB authoritative, journal as replica ✅ BUILT

The §2 target. Deliberately **not** the journal-retirement cutover an earlier draft described: the
jsonl keeps being written, the doctor keeps reading it, and `reindex` keeps working. What changed is
which store the orchestrator believes.

| # | Change | Where | Status |
|---|---|---|---|
| 1 | Write DB before jsonl | `journal.ts` `append()` | ✅ |
| 2 | `seq` / `deltaMs` from `store.getLastEvent()`, not the jsonl tail | `journal.ts` | ✅ (`prev` reverted — item 8) |
| 3 | `Journal.read()` queries `run_events`; file parsing moved to `readReplica()` | `journal.ts:134,144` | ✅ `projectState` unchanged — a pure fold over whatever the reader returns, which is why this stayed small |
| 4 | `synchronous = NORMAL` → `FULL` | `run-store.ts:61` | ✅ |
| 5 | Delete `--no-db`; `NullRunStore` becomes test-only | `cli.ts`, `run-store.ts` | ✅ `openRunStore(dbPath: string)` no longer accepts `undefined` |
| 6 | Parity assertion at `run.end` | `parity.ts` | ✅ see the gap in item 7 |
| 7 | Parity at `run.resume` too; `run.end` throw demoted to a recorded warning | `journal.ts`, `parity.ts`, `run-store.ts` | ✅ |
| 8 | **`prev` back to the replica tail** — item 2 broke every reindexed legacy run | `journal.ts` | ✅ see below |
| 9 | `started_at` re-asserted after the fold | `state.ts` | ✅ see below |

**Tests were ported before the flip**, as required: 12 files, via `test/_store.ts`'s `useRealStore()`.
`resume` is the survivability story of a long autonomous run and the least-exercised path in normal
operation — a wrong fold there does not crash, it quietly re-derives a run that had not pushed.

### Item 7 — the coverage gap, and two phases with two policies ✅

The first cut of item 6 fired `assertParity` only on `run.end`. Every path that emits it is a *clean*
conclusion (`pipeline.ts:319,331`, `orchestrate.ts:131`, `ci-round.ts:211`, `plan.ts:143,168`,
`adopt.ts:204`), so a run killed mid-step — host reboot, OOM, an escaping `SQLITE_BUSY` — emitted
nothing at all. The check was absent from exactly the failure modes that make the DB read path
load-bearing, and present only on the runs least likely to have diverged.

Three outcomes, three policies:

| Situation | `run.resume` | `run.end` |
|---|---|---|
| Replica and DB agree | proceed | proceed |
| Replica readable, **disagrees** | **throw `ParityError`** | warn + record on `runs.parity_error` |
| Replica **unreadable / missing** | warn, proceed | warn, proceed |

`run.resume` throws because it is the moment the DB is trusted to *reconstruct* a run: proceeding
against a DB the replica contradicts means resuming into a state that never happened. It is also the
only trigger covering crash paths, which is the whole point of the item.

`run.end` records instead. By the time it fires both writes have committed, the PR is open and CI has
gone green — the check cannot prevent what it finds, only report it, and throwing there fails a run
whose work is complete. It is a detector, not a guard; it should not destroy the thing it was
watching.

An **unreadable replica** warns at both phases and never throws. Under §2 the DB is authoritative, so
a missing or corrupt jsonl is a degraded *backup*, not a corrupt truth — refusing to finish or resume
a run because its backup is unreadable would be worse than the fault being reported.

One sharp edge worth knowing: `checkParity` reports a *projection failure* as not-ok even when both
sides fail identically. That is not a divergence, but at `run.resume` it still throws — correctly, since
a run whose events cannot project is not safely resumable either way. The message distinguishes them
(`projection failed:` vs `projected state mismatch:`).

### Item 8 — `prev` belongs to the replica, not the DB ✅

Found by running the §9 evaluation against the real fleet (2026-08-19), which is exactly the class of
bug it existed to catch — and which **304 passing tests did not**, before and after.

Item 2 sourced `prev` from `sha256(serializeEvent(store.getLastEvent()))`. A legacy journal carries a
**pre-ULID `run_id`** in every line; `reindex` backfills a ULID into the DB. So the DB re-serializes
into a line the file never contained, and the FIRST append to any migrated run broke the chain:

```
hash-chain break at seq 80: prev=sha256:9b7c1edd… expected=sha256:1ac727e5…
```

Consequences, in order of how quietly they arrive: `readReplica()` throws → `reindex` can no longer
rebuild that run → the recovery path is gone. And it is silent, because item 7 treats an unreadable
replica as a warning. The DB stays correct throughout, so the run keeps working; only the ability to
recover it is lost.

**Scope, measured rather than assumed:** normalising `run_id` away, 78 of 80 lines round-trip
**byte-exactly** — every `data` payload and all 5 `cost_cum` events. `run_id` is the sole cause, so
this is a complete fix, not the first of several. (The 2 that still differed carry a *second* derived
id — `care_fe-<branch>` on the doctor events vs `ohcnetwork-care_fe-<branch>` on the rest. §5's
derive-site drift, in production data.)

**Fix:** `prev` from the replica tail, which `truncateTornTail()` already reads — moved to the top of
`append()` so the repair happens before the hash is taken. `seq` and `deltaMs` stay DB-owned.

**Guarded by** `reindex.test.ts`'s "appending to a reindexed legacy run keeps the replica chain
valid", which builds a legacy journal with both derived id forms. Verified to fail against the old
provenance and pass against the new — a regression test asserted rather than assumed.

**Known and accepted:** a crash *between* the DB write and the jsonl write leaves the replica one
event short, so the next append writes a seq the file skips and `readReplica()` reports a seq gap. No
`prev` provenance fixes that — the replica is genuinely missing an event — and detecting it is what
the parity check is for.

### Item 9 — `started_at` was patched by the event that seeds it ✅

Found in the first lived-through run after the cutover (salvage of PR #16686, 2026-08-19).
`runs.started_at` read `…03.624Z` while `events[0].ts` was `…03.625Z`.

`projectState` seeded the accumulator with `events[0].ts` and then folded every event's `data.state`
over it — and `run.start` carries a full `CareState`, constructed a moment before `append()` stamps
the event's `ts`. So the first patch of the fold overwrote the journal's own timestamp with a slightly
earlier one. The comment above that line claimed `started_at` was "always derivable, never patched",
which was exactly wrong: it is the one field the first event always patches.

1ms in that run, but unbounded in principle — the gap is however long passes between constructing the
state and appending the event, which on some paths includes real work.

**Fix:** re-assert `acc.started_at = events[0].ts` *after* the fold, so the invariant holds rather than
depending on no event ever carrying the field. Guarded by `state.test.ts`'s "started_at is
events[0].ts, not run.start's own state payload", verified to fail without the fix.

Worth noting what did NOT catch this: live and reindex agreed perfectly (both replay the same
seed-then-upsert order), so the §2 rebuild invariant held throughout — a projection can be
self-consistent and still be consistently wrong. It surfaced only from diffing the row against an
independent fold of the journal.

### What still argues for keeping the jsonl

- **The doctor's input contract** is `journal.jsonl` + `skills/*.json` sidecars + `state.json` +
  `loop.log`. Untouched by this cutover; a retirement would make it a separate skill to rewrite.
- **Run dirs stay self-contained and greppable** — `jq` a journal, zip a run dir, read it with no
  tooling.
- **`reindex` stays a real recovery path**, which is the safety net that makes flipping the read path
  reasonable while the DB write path is still new.

No disk pressure forces a retirement decision: measured 2026-08-19, the live fleet is **6 runs / 1314
events / 432K of journals** (2.8M for the whole `runs/` tree), extrapolating to ~70MB at a thousand
runs. When it does matter, gzip TERMINAL runs in place (`step` = `merged` / `aborted`, never an active
run) and teach the legacy reader to open `.jsonl.gz` — jsonl compresses ~15x and nothing else changes.

### Backups are still needed

Journals back up run data, and `reindex` restores it. They cannot rebuild `queue` and `gate_asks`
when [[PLAN-loop-service]] lands — those have nothing behind them. So a periodic
`VACUUM INTO backups/loops-<ts>.db` plus `PRAGMA integrity_check` on boot covers service state, and
the journals cover run state. Two mechanisms because there are two kinds of data.

## 11. Testing

- `run-store.test.ts` — `SqliteRunStore` against `:memory:`/tmp files: upsert, idempotence, the
  `runs`+`detail` transaction, FK seeding, incremental vs. full-recompute rollups, `NullRunStore`
  no-op. ✅ built.
- `run-context.test.ts` — `openRun`/`resolveRunId`: mint-on-empty, cache stability, self-healing
  backfill of a pre-run_id journal. ✅ built.
- `journal-store-integration.test.ts` — a real `Journal` + `SqliteRunStore` wired via the active-store
  singleton: event-for-event mirroring on a LIVE run (not just after reindex), and a closed/broken
  store never breaking a journal append. ✅ built.
- `reindex.test.ts` — the §2 guarantee: build a fixture fleet, index, re-index, assert identical; and
  parity between a lived-through DB and a reindexed one. ✅ built.
- `run-id.test.ts` — ULID shape, monotonicity, uniqueness, deterministic backfill. ✅ built.
- `state.test.ts` — extended for the widened `KEY_ORDER` and the ad-hoc-key rejection. ✅ (existing
  suite passes unchanged; new fields self-heal via defaults, no test edits needed).
- `parity.test.ts` — the pure diff (count mismatch, state divergence, the vacuous empty case) AND the
  §10 item 7 policy end-to-end: `run.resume` throws on a real replica/DB divergence, `run.end` records
  to `runs.parity_error` without throwing, an unreadable replica warns at both phases, and the v1→v2
  migration adds the column idempotently. ✅ built (12 cases).
- **12 test files were PORTED, not preserved** — journal, state, pipeline, run-context, reindex, plan,
  adopt, resume, skill-log, ci-round, orchestrate, journal-store-integration — against
  `test/_store.ts`'s `useRealStore()`. An earlier revision of this line claimed the journal path was
  untouched and the tests unchanged; the §10 cutover made both false. ✅ 291/291 green.

## 12. Build order

| # | Step | Status |
|---|---|---|
| 1 | ULID helper + `run_id` minted at `run.start`, persisted; grep-driven sweep of all ten derive sites; mint-or-backfill on `run.resume` (via `validateState`'s deterministic self-heal) | ✅ done |
| 2 | `CareState` widening + `validateState` + `KEY_ORDER` | ✅ done |
| 3 | `RunStore` port + `SqliteRunStore` + `NullRunStore`, hooked into `Journal.append` (incremental rollups) and `projectAndWrite` (full recompute / reconciliation) | ✅ done |
| 4 | `care-loopd reindex` + the §9 evaluation mechanism (unit/integration-tested; not yet run against a real historical fleet — the live `runs/` tree is currently empty of pre-feature runs) | ✅ mechanism done; live-fleet timing/diff still to run once there's real history |
| 5 | `RunIndex` + `RunSummary` v2 + point the dashboard's `/api/runs` at it (falls back to the old full-scan when `loops.db` doesn't exist yet); smoke-tested live | ✅ done |

| 6 | **§10 cutover** — DB before jsonl; `seq`/`prev`/`deltaMs` from the DB; `Journal.read()` over `run_events`; `synchronous = FULL`; drop `--no-db` as a silent auto-fallback; parity assertion at run.end. `resume.test.ts` + `journal.test.ts` ported to the DB-backed reader | ✅ done |

All six steps are built. See the Third-pass As-built note for exact file-by-file changes and what was
verified live.

Steps 1–5 are independently valuable ahead of any service work: step 5 alone removes the
full-journal scan from the dashboard already in daily use. Step 6 is what makes §2 true rather than
aspirational, and none of [[PLAN-loop-service]] waits on it.

## 13. Risks

- **`SQLITE_BUSY` under concurrency.** Mitigated by WAL + `busy_timeout` + short transactions +
  one-writer-per-row. Would otherwise surface a fortnight in, under exactly the concurrency the
  service exists to enable.
- **`node:sqlite` is experimental.** As-built: works fine on Node 22.19 (warning only); no version
  pin was required. The `RunStore` port keeps `better-sqlite3` a drop-in if one ever is.
- **Schema drift between `CareState` and the table.** Mitigated by `validateState` staying the single
  authority and `PRAGMA user_version` gating migrations.
- **Silent divergence between DB and journals.** Mitigated by `reindex` idempotence tests
  (`reindex.test.ts`), the live-mirroring integration test, and the standing per-run parity assertion
  (§10 items 6-7) — the only one of the three that runs on real traffic, and since item 7 it covers
  crash paths (`run.resume`) as well as clean completions (`run.end`).
- **`resume` regressions after the §10 flip.** It is the survivability story of a long autonomous run
  and the least-exercised path in normal operation; a wrong fold does not crash, it re-derives a run
  that had not pushed. Mitigated by `resume.test.ts` having been ported to the DB reader before the
  flip, by `reindex` remaining able to rebuild the DB from the replica, and — since §10 item 7 — by
  the parity check running at `run.resume` itself, which is the trigger that actually covers the crash
  paths leading to one.
- **`journal.ts` branches on `instanceof NullRunStore`** (`journal.ts:249`), which breaks the
  `RunStore` port abstraction the rest of the codebase depends on by interface, in the hot path of
  every event. It exists so journal-mechanics-only tests need not build a valid `CareState`. §10 item
  5 removes it with `--no-db`; until then, narrowing the skip to the `validateState` call would keep
  the seam intact. **Applied 2026-08-19:** the branch now guards only the seed step
  (`validateState` + `seedRun`); `store.appendEvent(...)` is called unconditionally through the plain
  `RunStore` interface (a no-op on `NullRunStore`), so the seam no longer widens beyond the one call
  that genuinely needs the concrete-type check. 292/292 tests still green, `tsc --noEmit` clean.

## Non-goals

- Auth, sessions, or a users table. `requested_by` is a login string; the trust boundary is the
  network (see the loop-service plan).
- Mirroring `skills/*.json` sidecars or `loop.log` into the DB.
- Multi-host. One box, one `runs/`, one `loops.db`.
- Replacing `state.json`. It stays the crash-visible, greppable artifact, written but never read back.
- Populating `run_rounds` (schema-complete, per §3, but not yet written to — round-level analytics is
  future work; the read path never queries it).

---

## As-built (2026-08-19)

Steps 1, 2, 3, 5 fully built and tested; step 4's mechanism built and tested (the live-fleet
evaluation itself needs a real historical `runs/` tree to run against, which doesn't exist yet on
this box). 292/292 orchestrator tests green, `tsc --noEmit` clean.

**New files:** `src/run-id.ts` (ULID mint/backfill), `src/run-context.ts` (`openRun`/`resolveRunId` —
the `.run_id` cache file that solves the mint-before-run.start chicken-and-egg across all ten derive
sites), `src/run-store.ts` (`RunStore`/`SqliteRunStore`/`NullRunStore` + the active-store singleton +
`rollupsFromEvents`), `src/reindex.ts` (`reindexRuns`), `src/run-index.ts` (`RunIndex`/`SqliteRunIndex`
/ `RunSummary` v2).

**Modified:** `state.ts` (widened `CareState`/`KEY_ORDER`, self-healing `run_id` backfill in
`validateState`, `started_at` set in `projectState`, `projectAndWrite` mirrors into the active store),
`journal.ts` (`Journal.append` mirrors into the active store + seeds the parent row on `run.start`),
the ten derive sites (`adopt.ts`, `ci-round.ts`, `orchestrate.ts`, `pipeline.ts`, `plan.ts`,
`default-wiring.ts` ×2, `auto-doctor-wiring.ts`; `cli.ts`'s three `maybeRunDoctor` call sites were left
as human-readable slugs on purpose — that value feeds branch/report naming, not a journal `run_id`),
`cli.ts` (store init in `main()`, `--no-db`, new `reindex` subcommand), `dashboard.ts` (`/api/runs`
prefers `SqliteRunIndex` when `loops.db` exists, falls back to the full scan otherwise).

**Verified live:** `care-loopd reindex --runs-dir <dir>` against a hand-seeded journal produced
correct `runs`/`run_detail`/`run_events` rows; the dashboard's `/api/runs` served the SQLite-backed
`RunSummary` v2 shape and matched exactly what `dashboard.html` expects (no page changes needed).

**Deliberately not built:** the full §10 cutover (journal fully retired) and `run_rounds`
population — both future work, discussed above.

### Second pass, same day: DB-as-truth-for-fleet-queries + fatal writes

After the first pass shipped (best-effort DB, journal authoritative for everything), the direction
was refined: **the DB is truth for cross-run/fleet queries and its writes are now fatal; the journal
stays as a per-run assurance copy** (written, never read back by the orchestrator's own control flow)
rather than being retired outright. The doctor was explicitly left out of scope — it reads
`journal.jsonl` directly and needed no change, since the file is still written exactly as before.

**Changed:**
- `journal.ts` — `Journal.append()`'s DB mirror (seed-on-`run.start` + per-event insert) is no longer
  wrapped in try/catch; a store failure now propagates and halts the run. The jsonl write above it is
  unchanged (fsync, hash-chained) and untouched by a DB failure. The seed/mirror step is skipped
  entirely when the active store is a `NullRunStore` (no real DB configured) — otherwise even
  journal-mechanics-only unit tests (chaining/seq/corruption, no interest in `CareState` validity)
  would be forced through `validateState` and fail on a deliberately minimal fake payload.
- `state.ts` — `projectAndWrite`'s DB mirror is likewise no longer swallowed; both chokepoints (§4)
  now share the same fatal semantics, so an incremental write and the full reconcile can't silently
  diverge in how failures are handled.
- `run-store.ts` — `openRunStore(dbPath)` now throws if a given path can't be opened, instead of
  logging a warning and quietly downgrading to `NullRunStore`. `NullRunStore`/`--no-db` remain, but
  only as an explicit, deliberate opt-out — never an automatic fallback from an unexpected failure.
- Tests updated to match: `run-store.test.ts`'s "falls back to NullRunStore" case is now "throws";
  `journal-store-integration.test.ts`'s "closed db is swallowed" case is now "closed db is FATAL" (and
  still asserts the jsonl assurance copy recorded the attempt regardless). 292/292 green, `tsc
  --noEmit` clean; live-verified both the happy path (real store, real writes) and the fatal path
  (closed/unreachable store throws from `Journal.append`, jsonl still has the record).

**Deliberately still not built:** anything from the original §10 full inversion beyond what's above —
no `synchronous = FULL`, no dropped `prev` chain, no DB-assigned `seq`, no backups/restore-drill, no
`resume`/`journal` test porting to a SQLite-backed read path (`Journal.read()` still parses jsonl,
unchanged), and the doctor's reader is untouched. Those remain future work if a full cutover is
revisited.

### Third pass, same day: the §10 cutover — DB authoritative end-to-end

Went further than the second pass same day: `Journal.read()` is now DB-backed, `seq`/`prev`/`deltaMs`
are DB-derived (not the jsonl tail), the DB write happens BEFORE the jsonl write, `synchronous = FULL`,
and a standing parity check runs at every `run.end`. The jsonl replica is still written on every
append and is still what `reindex`, the doctor, and the parity check itself read — it just isn't on
any LIVE control-flow path any more (`resume`, `projectState`, the drivers all go through the DB).

**Changed:**
- `run-store.ts` — `RunStore` gained `getEvents(runId)` / `getLastEvent(runId)` (the new authoritative
  read primitives); `PRAGMA synchronous` is `FULL`; `openRunStore(dbPath)` no longer accepts `undefined`
  (no more `--no-db` production path at all — an explicit opt-out now means constructing `NullRunStore`
  directly, which only tests do).
- `journal.ts` — `read()` now queries the active store (`getEvents`); the old file-parsing logic
  (hash-chain verify, torn-tail drop, `JournalCorruptionError`) moved to a new `readReplica()` method,
  unchanged otherwise. `append()` derives `seq`/`prev`/`deltaMs` from `store.getLastEvent()` instead of
  the jsonl tail, writes the DB FIRST (fatal), then the jsonl line SECOND (also fatal — it always was;
  an earlier revision of this doc's prose incorrectly said otherwise). The `instanceof NullRunStore`
  branch (§13's flagged risk) stays, narrowed to just the seed step, since tests still default to
  `NullRunStore` when they don't need real persistence.
- `parity.ts` (new) — `checkParity`/`assertParity`: folds the replica and the DB's events through
  `projectState` and diffs them, plus a raw event-count check. Wired into `Journal.append()`: any
  `run.end` event triggers it, throwing `ParityError` on a mismatch (or if the replica itself is
  corrupt) — "fail loudly," per §9.
- `reindex.ts` — switched from `Journal.read()` to `Journal.readReplica()` (it rebuilds the DB FROM the
  replica; reading the DB it's rebuilding would be circular).
- `run-context.ts` — `resolveRunId`'s peek (discovering an existing run's id before it's known) switched
  from `read()` to `readReplica()` for the same reason: you can't query the DB by an id you don't have
  yet, and the replica is parseable independent of any id.
- `dashboard.ts` — `summarizeRun`/`detailRun`'s full-scan fallback (used only when `loops.db` doesn't
  exist yet) switched to `readReplica()`. Caught live: both were constructing `Journal` with the dir
  SLUG as the run_id, which silently returned zero events against the now-DB-backed `read()`.
- `cli.ts` — `journalOf()` was hardcoding a placeholder run_id (`"cli"`); switched to
  `resolveRunId(runDir)`. Same class of bug as the dashboard one, caught the same way (live smoke test
  of `care-loopd status`, not by a unit test — nothing in the suite constructs a `Journal` with a wrong
  id against a real store the way the CLI does).
- Test suite ported file-by-file (journal, state, pipeline, run-context, reindex, plan, adopt, resume,
  skill-log, ci-round, orchestrate, journal-store-integration — 12 files): a new `test/_store.ts`
  helper (`useRealStore()`) installs a fresh `:memory:` `SqliteRunStore` per test, since `read()` being
  DB-backed means `NullRunStore` (the default) makes every run look permanently empty. Manual
  `new Journal(path, arbitraryId)` constructions were fixed to use a real minted ULID consistent with
  the run.start seed's `run_id` (a mismatch between the two is an FK violation now, where it used to be
  silently swallowed) — mostly via `openRun`, which already gets this right. Assertions that inspect
  the file's own crash/corruption properties moved to `readReplica()`.

**LIVE-verified** (not just unit tests): a real run through `openRunStore` → `openRun` → `append` ×4
→ `projectAndWrite` → `run.end` produced byte-identical replica and DB content (4 events, same order,
correct rollups), the parity check passed with no throw, and `care-loopd status <run-dir>` against a
real seeded run/DB read back correctly end-to-end. 291/291 tests green, `tsc --noEmit` clean.

**Deliberately not built:** the backups/restore-drill and boot-time `integrity_check` from §10's
"Backups are still needed" subsection — no service (`queue`/`gate_asks`) tables exist yet to make that
urgent. `run_rounds` population remains future work, unchanged from prior passes.

### Fourth pass: §10 item 7 — parity at `run.resume`, `run.end` demoted

Closed the coverage gap the third pass left: the parity check ran only at `run.end`, which no crashed
run ever reaches. See §10 item 7 for the three-outcome policy table.

**Changed:**
- `parity.ts` — added `ParityPhase` and `parityWarning()` (one place for the operator-facing wording,
  so both phases read identically in a log scrape). `assertParity` takes a phase so its message names
  the trigger. `checkParity` unchanged and still pure.
- `journal.ts` — the `run.end`-only block became phase-aware over `run.end | run.resume`. An
  unreadable replica no longer throws `ParityError` at all: it warns and proceeds, because under §2 a
  missing backup is not a corrupt truth. A readable-but-disagreeing replica throws at `run.resume`
  and records at `run.end`.
- `run-store.ts` — `runs` gained `parity_error TEXT`; `RunStore` gained `recordParityError()`
  (no-op on `NullRunStore`). `PRAGMA user_version` moved out of `SCHEMA` into a new `migrate()`, which
  is the first real use of the migration hook §3 reserved. It checks `pragma_table_info` for the
  column rather than inferring from the version, so a half-applied migration (ALTER ran, version bump
  did not) self-heals instead of failing on "duplicate column name" — `SCHEMA`'s
  `CREATE TABLE IF NOT EXISTS` means a v1 database arrives here with a v1 `runs` table regardless of
  what the v2 DDL declares.
- `test/parity.test.ts` (new, 12 cases) — the pure diff, the policy end-to-end against a real
  `Journal` + file-backed `SqliteRunStore` (divergence induced by deleting a middle `run_events` row,
  which leaves `getLastEvent` — and therefore `seq`/`prev` — intact), the unreadable-replica path via
  a corrupted mid-chain line, and both migration cases.

303/303 tests green, `tsc --noEmit` clean.

**Still open:** §12 step 4's live-fleet §9 evaluation. Its stated blocker is stale — the corpus is on
disk at `care-loop/runs/` (6 runs, 1314 events, all pre-ULID with `run.start` at seq 0 carrying
`data.state`), and there is no `loops.db` yet, so it is a clean first run. Note that `reindex` writes
`prev` verbatim rather than re-deriving it, so the round-trip is only truly exercised when something
*appends* to a reindexed legacy run — resuming one of the six after the reindex is the real test.

### Fifth pass: the §9 evaluation, run for real — and what it caught

Ran §12 step 4 against the live 6-run fleet (`care-loop/runs/`, 1314 events). **All four §9 checks
pass:** 6 runs indexed / 0 skipped, `run_events` count matching the journals exactly, every rendered
and top-level `RunSummary` field identical between the DB path and the replica full scan, `/api/runs`
at 22.5ms vs 34.0ms, and reindex idempotent across two passes. Step 4 is done.

Then the test the plan flagged as the one nothing covered — appending to a *reindexed legacy* run —
and it failed. See §10 item 8 for the bug, the measurement that scoped it, and the fix. The headline:
`prev` was being derived from the DB, which cannot reproduce a legacy line's pre-ULID `run_id`, so
every migrated run would have lost its recovery path on first append, silently. 304/304 green,
`tsc --noEmit` clean, with a regression test verified to fail against the old behaviour.

**Live fleet untouched.** The chain test ran against copies in a scratchpad; no `care-loopd resume`
was executed against a real run, and `runs/care_fe-supply-delivery-expiry-date/journal.jsonl` is
unchanged since 2026-07-28. The only addition to `runs/` is `loops.db`.

### Sixth pass: the first lived-through run (salvage of PR #16686)

Salvaged an open PR with `--max-rounds 1 --no-doctor` — the first run *lived through* end to end since
the cutover, as opposed to synthetic (4 events) or replayed (the six legacy runs). 37 events, real
work done (ci-fixer `fixed`, test-grader `ok`), `outcome=capped/max_rounds` as asked.

**Verified against an independent fold of the journal:** chain valid end to end, `run.end` parity
CLEAN, `parity_error` NULL, and `event_count` (37) / `cost_usd` (0.35637) / `duration_ms` (350816) /
`step` / `round` / `pr` / `updated_at` all exact. A reindexed copy matched the lived-through row on
**every** column, so §2's rebuild guarantee holds on real data rather than only on fixtures. The
journal carries exactly one `run_id` — fresh runs show none of the derive-drift the legacy six do
(3 distinct ids each).

**One discrepancy, fixed:** `started_at` — see §10 item 9. After the fix and a reindex, all 7 runs in
the fleet satisfy `runs.started_at === events[0].ts`. 305/305 tests green.

**`requested_by` closed (same day).** All four seed sites now call one resolver,
`run-context.ts#resolveRequestedBy()`, reading `CARE_REQUESTED_BY` (supervisor-set per child) with
`--requested-by <login>` as CLI sugar over it. Whitespace-only is treated as unset so `"  "` cannot
land in the column. Covered by `run-context.test.ts` (precedence, trimming, and an end-to-end check
that a seeded run lands the value on the `runs` row). 307/307 green.

**No DB-side work remains before [[PLAN-loop-service]].** Backups + boot `integrity_check` (§10) stay
deliberately deferred to service step 3, where `queue`/`gate_asks` first create data `reindex` cannot
rebuild.
