// test/service-app.test.ts — the HTTP contract ([[PLAN-loop-service]] §6). Drives the REAL Express
// app over an ephemeral port and an in-memory database: no mocked router, no fixture run dirs. The
// point of this file is that the contract the frontend is written against is frozen by tests before
// the frontend exists.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { buildApp } from "../src/service/app.ts";
import { SqliteRunIndex } from "../src/run-index.ts";
import { mintRunId } from "../src/run-id.ts";
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

interface Harness {
  store: SqliteRunStore;
  base: string;
  get: (path: string, headers?: Record<string, string>) => Promise<{ status: number; body: any }>;
  close: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const store = useRealStore();
  const db = (store as unknown as { db: DatabaseSync }).db;
  const app = buildApp({ index: new SqliteRunIndex(db), version: "test" });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    store,
    base,
    get: async (path, headers) => {
      const res = await fetch(base + path, { headers });
      return { status: res.status, body: await res.json() };
    },
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

test("GET /api/me echoes the claimed identity, null when the header is absent or blank", async () => {
  const h = await harness();
  try {
    assert.equal((await h.get("/api/me", { "X-Care-User": "octocat" })).body.login, "octocat");
    assert.equal((await h.get("/api/me")).body.login, null);
    assert.equal((await h.get("/api/me", { "X-Care-User": "   " })).body.login, null);
    // Trimmed, so a stray space in a header cannot create a second "user".
    assert.equal((await h.get("/api/me", { "X-Care-User": " octocat " })).body.login, "octocat");
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
