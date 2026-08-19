// test/_store.ts — shared test helper for the §10 cutover: the DB is authoritative now (Journal.read()
// queries it, Journal.append() sources seq/prev/deltaMs from it), so any test that appends events and
// expects them to round-trip needs a REAL store installed first — the default `NullRunStore` always
// returns empty/null, which would make every run look perpetually brand-new.
//
// A fresh `:memory:` SqliteRunStore per call is deliberate: it isolates each test's DB completely (no
// cross-test collisions even when two tests happen to mint/reuse the same run_id), and it's free.
import { SqliteRunStore, setActiveRunStore } from "../src/run-store.ts";

/** Install a fresh, empty in-memory store as the active one. Call this before any code path that
 *  will call `Journal.append()`/`Journal.read()` (directly, or via `openRun`/`runPlan`/`runHalfPipe`/
 *  `runStart`/`runCiRounds`/`adoptPr`, all of which go through the same active-store singleton). */
export function useRealStore(): SqliteRunStore {
  const store = new SqliteRunStore(":memory:");
  setActiveRunStore(store);
  return store;
}
