// test/service-app.test.ts — the HTTP contract ([[PLAN-loop-service]] §6). Drives the REAL Express
// app over an ephemeral port and an in-memory database: no mocked router, no fixture run dirs. The
// point of this file is that the contract the frontend is written against is frozen by tests before
// the frontend exists.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { buildApp } from "../src/service/app.ts";
import {
  SqliteRunIndex,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
} from "../src/run-index.ts";
import { mintRunId } from "../src/run-id.ts";
import { SessionStore } from "../src/service/auth.ts";
import { validateState, type CareState } from "../src/state.ts";
import type { SqliteRunStore } from "../src/run-store.ts";
import { useRealStore } from "./_store.ts";

function stateFor(over: Partial<CareState>): CareState {
  return validateState({
    task: "seed a run",
    repo: "ohcnetwork/care_fe",
    branch: "my-branch",
    worktree: "/tmp/wt",
    tier: "standard",
    pr: 42,
    round: 1,
    step: "2",
    head_sha: "abc",
    last_reviewed_sha: "",
    run_id: mintRunId(),
    requested_by: null,
    ticket: "ENG-747",
    summary: "do the thing",
    ...over,
  });
}

function seed(store: SqliteRunStore, slug: string, over: Partial<CareState> = {}): string {
  const state = stateFor(over);
  store.seedRun(slug, state);
  return state.run_id;
}

interface Res {
  status: number;
  body: any;
  cookie: string | null;
}

interface Harness {
  store: SqliteRunStore;
  base: string;
  get: (path: string, headers?: Record<string, string>) => Promise<Res>;
  post: (path: string, body?: unknown, headers?: Record<string, string>) => Promise<Res>;
  close: () => Promise<void>;
}

/** Pull the session token out of a Set-Cookie so a test can act as that signed-in caller. */
function cookieValue(setCookie: string | null): string | null {
  const m = setCookie?.match(/care_session=([^;]*)/);
  return m ? m[1] : null;
}

async function harness(): Promise<Harness> {
  const store = useRealStore();
  const db = (store as unknown as { db: DatabaseSync }).db;
  const app = buildApp({
    index: new SqliteRunIndex(db),
    sessions: new SessionStore(db),
    version: "test",
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const read = async (res: Response): Promise<Res> => ({
    status: res.status,
    body: res.status === 204 ? null : await res.json(),
    cookie: res.headers.get("set-cookie"),
  });
  return {
    store,
    base,
    get: async (path, headers) => read(await fetch(base + path, { headers })),
    post: async (path, body, headers) =>
      read(
        await fetch(base + path, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body ?? {}),
        }),
      ),
    close: () => new Promise((r) => server.close(() => r(undefined))),
  };
}

test("GET /api/health reports db reachability, not merely process liveness", async () => {
  const h = await harness();
  try {
    const { status, body } = await h.get("/api/health");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.db, true);
    assert.equal(body.version, "test");
    assert.equal(body.supervisor, null, "no supervisor until step 4");
  } finally {
    await h.close();
  }
});

test("GET /api/auth/me echoes the claimed identity, null when nothing identifies the caller", async () => {
  const h = await harness();
  try {
    assert.equal((await h.get("/api/auth/me", { "X-Care-User": "octocat" })).body.login, "octocat");
    // 200-with-null, not 401 — the frontend makes one unconditional call and branches on the answer.
    const anon = await h.get("/api/auth/me");
    assert.equal(anon.status, 200);
    assert.equal(anon.body.login, null);
    assert.equal((await h.get("/api/auth/me", { "X-Care-User": "   " })).body.login, null);
    // Trimmed, so a stray space in a header cannot create a second "user".
    assert.equal((await h.get("/api/auth/me", { "X-Care-User": " octocat " })).body.login, "octocat");
    // The header path has no roster entry — only a real session does.
    assert.equal((await h.get("/api/auth/me", { "X-Care-User": "octocat" })).body.account, null);
  } finally {
    await h.close();
  }
});

test("GET /api/runs returns an envelope with a filter-consistent total", async () => {
  const h = await harness();
  try {
    for (let i = 0; i < 3; i++) seed(h.store, `care_fe-${i}`, { requested_by: "octocat" });
    seed(h.store, "care_fe-other", { requested_by: "someone" });

    const all = await h.get("/api/runs");
    assert.equal(all.body.total, 4);
    assert.equal(all.body.items.length, 4);

    const mine = await h.get("/api/runs?requested_by=octocat");
    assert.equal(mine.body.total, 3);

    const paged = await h.get("/api/runs?requested_by=octocat&limit=2");
    assert.equal(paged.body.items.length, 2);
    assert.equal(paged.body.total, 3, "total describes the filter, not the page");
    assert.equal(paged.body.limit, 2);
    assert.equal(paged.body.offset, 0);
  } finally {
    await h.close();
  }
});

test("GET /api/runs rejects malformed query values instead of coercing them", async () => {
  const h = await harness();
  try {
    const limit = await h.get("/api/runs?limit=abc");
    assert.equal(limit.status, 400);
    assert.equal(limit.body.error.code, "bad_query");

    const negative = await h.get("/api/runs?offset=-5");
    assert.equal(negative.status, 400);

    // The bug this prevents: a non-empty string being truthy, so `?active=false` means "active".
    const active = await h.get("/api/runs?active=maybe");
    assert.equal(active.status, 400);
    assert.equal((await h.get("/api/runs?active=false")).status, 200);
  } finally {
    await h.close();
  }
});

test("GET /api/runs/:id distinguishes a malformed id (400) from an unknown one (404)", async () => {
  const h = await harness();
  try {
    const bad = await h.get("/api/runs/not-a-ulid");
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, "bad_run_id");

    const missing = await h.get(`/api/runs/${mintRunId()}`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, "run_not_found");
  } finally {
    await h.close();
  }
});

test("GET /api/runs/:id returns the run with its detail fields and a queue slot", async () => {
  const h = await harness();
  try {
    const runId = seed(h.store, "care_fe-a", { requested_by: "octocat" });
    const { status, body } = await h.get(`/api/runs/${runId}`);
    assert.equal(status, 200);
    assert.equal(body.run.runId, runId);
    assert.equal(body.run.ticket, "ENG-747");
    assert.equal(body.run.pr, 42);
    assert.equal(body.run.requestedBy, "octocat");
    assert.equal(body.queue, null, "shape is stable before step 3 populates it");
  } finally {
    await h.close();
  }
});

test("GET /api/runs/:id/events paginates by seq and 404s for an unknown run", async () => {
  const h = await harness();
  try {
    const runId = seed(h.store, "care_fe-a");
    for (let seq = 0; seq < 4; seq++)
      h.store.appendEvent(
        runId,
        { seq, ts: `2026-08-01T00:00:0${seq}.000Z`, run_id: runId, event: "step.enter", step: "2", prev: "sha256:x" },
        { deltaMs: 0, costUsd: 0 },
      );

    const first = await h.get(`/api/runs/${runId}/events?limit=2`);
    assert.deepEqual(first.body.items.map((e: { seq: number }) => e.seq), [0, 1]);
    assert.equal(first.body.next_seq, 1);

    const next = await h.get(`/api/runs/${runId}/events?limit=2&after_seq=1`);
    assert.deepEqual(next.body.items.map((e: { seq: number }) => e.seq), [2, 3]);
    assert.equal(next.body.next_seq, null);

    // An empty timeline must not read as a missing run — it is the normal state of a fresh run.
    const empty = seed(h.store, "care_fe-fresh");
    const none = await h.get(`/api/runs/${empty}/events`);
    assert.equal(none.status, 200);
    assert.deepEqual(none.body.items, []);

    assert.equal((await h.get(`/api/runs/${mintRunId()}/events`)).status, 404);
  } finally {
    await h.close();
  }
});

test("an unknown route returns the same error envelope as every other failure", async () => {
  const h = await harness();
  try {
    const { status, body } = await h.get("/api/nope");
    assert.equal(status, 404);
    assert.equal(body.error.code, "not_found");
    assert.equal(typeof body.error.message, "string");
  } finally {
    await h.close();
  }
});

test("GET /api/runs/:id/artifacts lists metadata, and /:sha returns one parsed body", async () => {
  const h = await harness();
  try {
    const runId = seed(h.store, "care_fe-a");
    const sha = "sha256:" + "e".repeat(64);
    h.store.putArtifact(runId, {
      path: "skills/care-reviewer-r1.result.json",
      name: "care-reviewer-r1.result",
      sha256: sha,
      content: JSON.stringify({ verdict: "pass", findings: [] }),
    });

    const list = await h.get(`/api/runs/${runId}/artifacts`);
    assert.equal(list.status, 200);
    assert.equal(list.body.items.length, 1);
    assert.equal(list.body.items[0].sha256, sha);
    assert.equal(list.body.items[0].content, undefined, "the list must not carry bodies");

    // addressed by the bare hex, which is what a URL segment should hold
    const body = await h.get(`/api/runs/${runId}/artifacts/${"e".repeat(64)}`);
    assert.equal(body.status, 200);
    assert.deepEqual(body.body.content, { verdict: "pass", findings: [] });
  } finally {
    await h.close();
  }
});

test("artifact routes reject a malformed sha (400) and report an unknown one (404)", async () => {
  const h = await harness();
  try {
    const runId = seed(h.store, "care_fe-a");
    const bad = await h.get(`/api/runs/${runId}/artifacts/nope`);
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, "bad_sha");

    const missing = await h.get(`/api/runs/${runId}/artifacts/${"f".repeat(64)}`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, "artifact_not_found");

    assert.equal((await h.get(`/api/runs/${mintRunId()}/artifacts`)).status, 404);
  } finally {
    await h.close();
  }
});

test("the paging envelope reports what was APPLIED, never what was asked for", async () => {
  const h = await harness();
  try {
    for (let i = 0; i < 3; i++) seed(h.store, `care_fe-${i}`);

    // Omitted limit must still report the default in force — a client cannot page by a null.
    const bare = await h.get("/api/runs");
    assert.equal(bare.body.limit, DEFAULT_LIST_LIMIT);
    assert.equal(bare.body.offset, 0);

    // Over the ceiling: the response must say 200, not 999. A client doing `offset += limit` on the
    // requested value would skip 799 rows per page and never see an error.
    const over = await h.get("/api/runs?limit=999");
    assert.equal(over.body.limit, MAX_LIST_LIMIT);

    // Zero rows is not a meaningful page — it used to be clamped up to 1 and reported as 0.
    const zero = await h.get("/api/runs?limit=0");
    assert.equal(zero.status, 400);
    assert.equal(zero.body.error.code, "bad_query");
    assert.equal((await h.get(`/api/runs/${seed(h.store, "care_fe-z")}/events?limit=0`)).status, 400);
  } finally {
    await h.close();
  }
});

// ── auth ─────────────────────────────────────────────────────────────────────────────────────────

test("login establishes a session cookie that /auth/me then resolves", async () => {
  const h = await harness();
  try {
    const login = await h.post("/api/auth/login", { login: "octocat" });
    assert.equal(login.status, 201);
    assert.equal(login.body.user.login, "octocat");
    assert.equal(typeof login.body.user.id, "number");

    const raw = login.cookie ?? "";
    assert.match(raw, /HttpOnly/, "the token must not be readable from JS");
    assert.match(raw, /SameSite=Lax/);
    assert.doesNotMatch(raw, /Secure/, "plain HTTP on loopback by default");

    const me = await h.get("/api/auth/me", { cookie: `care_session=${cookieValue(raw)}` });
    assert.equal(me.body.login, "octocat");
    assert.equal(me.body.account.login, "octocat", "a real session carries the roster entry");
  } finally {
    await h.close();
  }
});

test("the raw token is never stored — only its hash", async () => {
  const h = await harness();
  try {
    const token = cookieValue((await h.post("/api/auth/login", { login: "octocat" })).cookie)!;
    const db = (h.store as unknown as { db: DatabaseSync }).db;
    const rows = db.prepare("SELECT token_sha256 FROM sessions").all() as { token_sha256: string }[];
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].token_sha256, token, "a leaked db must not be a set of live logins");
    assert.equal(
      rows[0].token_sha256,
      createHash("sha256").update(token, "utf8").digest("hex"),
    );
  } finally {
    await h.close();
  }
});

test("logout revokes the session and clears the cookie, and is idempotent", async () => {
  const h = await harness();
  try {
    const token = cookieValue((await h.post("/api/auth/login", { login: "octocat" })).cookie)!;
    const jar = { cookie: `care_session=${token}` };

    const out = await h.post("/api/auth/logout", {}, jar);
    assert.equal(out.status, 204);
    assert.match(out.cookie ?? "", /Max-Age=0/);

    // the token no longer identifies anyone
    assert.equal((await h.get("/api/auth/me", jar)).body.login, null);
    // revoked, not deleted — "who was signed in when" survives the sign-out
    const db = (h.store as unknown as { db: DatabaseSync }).db;
    const row = db.prepare("SELECT revoked_at FROM sessions").get() as { revoked_at: string | null };
    assert.notEqual(row.revoked_at, null);

    // a second logout, and a logout with no cookie at all, both succeed
    assert.equal((await h.post("/api/auth/logout", {}, jar)).status, 204);
    assert.equal((await h.post("/api/auth/logout")).status, 204);
  } finally {
    await h.close();
  }
});

test("login rejects a value that could not be a GitHub login", async () => {
  const h = await harness();
  try {
    for (const bad of ["", "   ", "-leading", "trailing-", "two--hyphens", "a".repeat(40), "has space"]) {
      const res = await h.post("/api/auth/login", { login: bad });
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
      assert.equal(res.body.error.code, "bad_login");
    }
    assert.equal((await h.post("/api/auth/login", {})).status, 400);
  } finally {
    await h.close();
  }
});

test("logging in twice reuses the user row and issues a second session", async () => {
  const h = await harness();
  try {
    const a = await h.post("/api/auth/login", { login: "octocat" });
    const b = await h.post("/api/auth/login", { login: "octocat" });
    assert.equal(a.body.user.id, b.body.user.id, "the roster must not grow a duplicate");
    assert.notEqual(cookieValue(a.cookie), cookieValue(b.cookie));
    // both remain valid — signing in on a second machine must not evict the first
    for (const c of [a, b])
      assert.equal(
        (await h.get("/api/auth/me", { cookie: `care_session=${cookieValue(c.cookie)}` })).body.login,
        "octocat",
      );
  } finally {
    await h.close();
  }
});

test("a session beats the header, and an unresolvable cookie falls back to it", async () => {
  const h = await harness();
  try {
    const token = cookieValue((await h.post("/api/auth/login", { login: "octocat" })).cookie)!;
    const both = await h.get("/api/auth/me", {
      cookie: `care_session=${token}`,
      "X-Care-User": "someone-else",
    });
    assert.equal(both.body.login, "octocat", "the session is the stronger claim");

    // a dead cookie must not lock out a caller who also sent a header — identify, do not gate
    const stale = await h.get("/api/auth/me", {
      cookie: "care_session=deadbeef",
      "X-Care-User": "someone-else",
    });
    assert.equal(stale.status, 200);
    assert.equal(stale.body.login, "someone-else");
  } finally {
    await h.close();
  }
});

// ── list filters ─────────────────────────────────────────────────────────────────────────────────

test("filters compose across runs and run_detail columns", async () => {
  const h = await harness();
  try {
    seed(h.store, "care_fe-a", { requested_by: "octocat", branch: "feat-a", ticket: "ENG-1", task: "add pagination" });
    seed(h.store, "care_fe-b", { requested_by: "octocat", branch: "feat-b", ticket: "ENG-2", task: "fix the date format" });
    seed(h.store, "care_fe-c", { requested_by: "someone", branch: "feat-c", ticket: "ENG-3", task: "add pagination again" });

    assert.equal((await h.get("/api/runs?requested_by=octocat")).body.total, 2);
    assert.equal((await h.get("/api/runs?ticket=ENG-2")).body.total, 1);
    assert.equal((await h.get("/api/runs?branch=feat-c")).body.total, 1);
    // free text reaches the detail table, which the list joins for exactly this
    assert.equal((await h.get("/api/runs?q=pagination")).body.total, 2);
    assert.equal((await h.get("/api/runs?q=pagination&requested_by=octocat")).body.total, 1);
  } finally {
    await h.close();
  }
});

test("q escapes LIKE wildcards so a literal % is searched for, not matched with", async () => {
  const h = await harness();
  try {
    seed(h.store, "care_fe-a", { task: "handle 100% of cases" });
    seed(h.store, "care_fe-b", { task: "something else entirely" });
    assert.equal((await h.get("/api/runs?q=100%25")).body.total, 1, "literal percent");
    assert.equal((await h.get("/api/runs?q=%25")).body.total, 1, "a bare % must not match everything");
  } finally {
    await h.close();
  }
});

test("requested_by=me resolves to the caller, and 400s when nobody is signed in", async () => {
  const h = await harness();
  try {
    seed(h.store, "care_fe-a", { requested_by: "octocat" });
    seed(h.store, "care_fe-b", { requested_by: "someone" });

    const viaHeader = await h.get("/api/runs?requested_by=me", { "X-Care-User": "octocat" });
    assert.equal(viaHeader.body.total, 1);
    assert.equal(viaHeader.body.items[0].requestedBy, "octocat");

    const token = cookieValue((await h.post("/api/auth/login", { login: "someone" })).cookie)!;
    const viaSession = await h.get("/api/runs?requested_by=me", { cookie: `care_session=${token}` });
    assert.equal(viaSession.body.items[0].requestedBy, "someone");

    // 400 not 401: it is a filter that cannot be expanded, not a permission being refused.
    const anon = await h.get("/api/runs?requested_by=me");
    assert.equal(anon.status, 400);
    assert.equal(anon.body.error.code, "bad_query");
  } finally {
    await h.close();
  }
});

test("order and dir are whitelisted, never interpolated from the query string", async () => {
  const h = await harness();
  try {
    seed(h.store, "care_fe-a", { started_at: "2026-08-01T00:00:00.000Z" });
    seed(h.store, "care_fe-b", { started_at: "2026-08-02T00:00:00.000Z" });

    const desc = await h.get("/api/runs");
    assert.deepEqual(desc.body.items.map((r: { slug: string }) => r.slug), ["care_fe-b", "care_fe-a"]);
    const asc = await h.get("/api/runs?dir=asc");
    assert.deepEqual(asc.body.items.map((r: { slug: string }) => r.slug), ["care_fe-a", "care_fe-b"]);

    assert.equal((await h.get("/api/runs?order=updated_at")).status, 200);
    const bad = await h.get("/api/runs?order=cost_usd;DROP+TABLE+runs");
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, "bad_query");
    assert.equal((await h.get("/api/runs?dir=sideways")).status, 400);
  } finally {
    await h.close();
  }
});

test("since/until bound started_at as a half-open range", async () => {
  const h = await harness();
  try {
    seed(h.store, "care_fe-a", { started_at: "2026-08-01T00:00:00.000Z" });
    seed(h.store, "care_fe-b", { started_at: "2026-08-02T00:00:00.000Z" });
    seed(h.store, "care_fe-c", { started_at: "2026-08-03T00:00:00.000Z" });
    assert.equal((await h.get("/api/runs?since=2026-08-02T00:00:00.000Z")).body.total, 2);
    assert.equal((await h.get("/api/runs?until=2026-08-02T00:00:00.000Z")).body.total, 1);
    assert.equal(
      (await h.get("/api/runs?since=2026-08-02T00:00:00.000Z&until=2026-08-03T00:00:00.000Z")).body.total,
      1,
      "half-open: since is inclusive, until is not",
    );
  } finally {
    await h.close();
  }
});

test("facets honour the active filter, so narrowing does not offer dead options", async () => {
  const h = await harness();
  try {
    seed(h.store, "care_fe-a", { repo: "ohcnetwork/care_fe", branch: "x", requested_by: "octocat" });
    seed(h.store, "care_fe-b", { repo: "ohcnetwork/care_fe", branch: "y", requested_by: "octocat" });
    seed(h.store, "care_fe-c", { repo: "ohcnetwork/care", branch: "z", requested_by: "someone" });

    const all = await h.get("/api/runs/facets");
    assert.equal(all.status, 200);
    assert.deepEqual(all.body.repos, [
      { value: "ohcnetwork/care_fe", count: 2 },
      { value: "ohcnetwork/care", count: 1 },
    ]);

    // filtered to one repo, only that repo's branches are offered
    const narrowed = await h.get("/api/runs/facets?repo=ohcnetwork/care");
    assert.deepEqual(narrowed.body.branches, [{ value: "z", count: 1 }]);
    assert.deepEqual(narrowed.body.users, [{ value: "someone", count: 1 }]);
  } finally {
    await h.close();
  }
});

test("/runs/facets is not swallowed by the /runs/:id route", async () => {
  const h = await harness();
  try {
    // "facets" is a plausible path segment; declared after :id it would 400 as a bad run id.
    const res = await h.get("/api/runs/facets");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.repos));
  } finally {
    await h.close();
  }
});

// ── static frontend ──────────────────────────────────────────────────────────────────────────────

test("the SPA fallback serves client routes but never disguises a missing asset", async () => {
  const store = useRealStore();
  const db = (store as unknown as { db: DatabaseSync }).db;
  const dir = mkdtempSync(join(tmpdir(), "careloopd-static-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>app</title>");
  const app = buildApp({
    index: new SqliteRunIndex(db),
    sessions: new SessionStore(db),
    staticDir: dir,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    // a client-side route resolves to the app shell
    const route = await fetch(`${base}/runs/${mintRunId()}`);
    assert.equal(route.status, 200);
    assert.match(route.headers.get("content-type") ?? "", /text\/html/);

    // REGRESSION: a missing asset must 404 as an asset. Answering 200-with-HTML makes the browser
    // execute a document as JavaScript, and the MIME error it then reports says nothing about the
    // real problem — a stale asset reference after a redeploy.
    const missing = await fetch(`${base}/assets/nope.js`);
    assert.equal(missing.status, 404);

    // and /api keeps its own envelope rather than being swallowed by the fallback
    const api = await fetch(`${base}/api/nope`);
    assert.equal(api.status, 404);
    assert.equal((await api.json()).error.code, "not_found");
  } finally {
    await new Promise((r) => server.close(() => r(undefined)));
  }
});
