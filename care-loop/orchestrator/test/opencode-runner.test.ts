import { test } from "node:test";
import assert from "node:assert/strict";
import { driveToCompletion } from "../src/opencode-runner.ts";

// A fake opencode client that scripts the /event SSE stream + the message fetches, so driveToCompletion
// can be exercised without a live server. Mirrors the hey-api response shape ({ data }) the real client
// returns, since driveToCompletion unwraps it.
function fakeClient(opts: {
  events: any[]; // events the SSE stream yields, in order
  hangAfterEvents?: boolean; // if set, block on the abort signal instead of ending (for timeout tests)
  messageInfo?: any; // what session.message returns as the finished assistant message
  messagesList?: any[]; // what session.messages (list) returns for the fallback path
  promptAsync?: () => Promise<unknown>; // override promptAsync's outcome (throw, or return an HTTP error)
}) {
  const calls: {
    promptAsync: any[];
    abort: any[];
    message: any[];
    messages: number;
  } = { promptAsync: [], abort: [], message: [], messages: 0 };
  const client = {
    event: {
      subscribe: async ({ signal }: { signal: AbortSignal }) => ({
        stream: (async function* () {
          for (const ev of opts.events) yield ev;
          if (opts.hangAfterEvents) {
            await new Promise<void>((r) => {
              if (signal.aborted) return r();
              signal.addEventListener("abort", () => r(), { once: true });
            });
          }
        })(),
      }),
    },
    session: {
      promptAsync: async (a: any) => {
        calls.promptAsync.push(a);
        return opts.promptAsync?.();
      },
      abort: async (a: any) => {
        calls.abort.push(a);
      },
      message: async (a: any) => {
        calls.message.push(a);
        return { data: { info: opts.messageInfo } };
      },
      messages: async () => {
        calls.messages++;
        return { data: opts.messagesList ?? [] };
      },
    },
  };
  return { client, calls };
}

const ev = (type: string, props: any) => ({ type, properties: props });

test("driveToCompletion: happy path returns the finished assistant message, filters other sessions", async () => {
  const info = {
    role: "assistant",
    id: "m1",
    sessionID: "S",
    structured: { answer: "ok", count: 42 },
    modelID: "claude-sonnet-4.6",
    cost: 0.03,
  };
  const { client, calls } = fakeClient({
    events: [
      ev("session.idle", { sessionID: "OTHER" }), // different session — must be ignored
      ev("message.updated", { info: { role: "user", sessionID: "S", id: "m0" } }),
      ev("message.updated", { info: { role: "assistant", sessionID: "S", id: "m1" } }),
      ev("session.idle", { sessionID: "S" }),
    ],
    messageInfo: info,
  });

  const body = { model: { providerID: "p", modelID: "claude-sonnet-4.6" }, parts: [] };
  const out = await driveToCompletion(client, "S", body, 5000);

  assert.deepEqual(out.structured, { answer: "ok", count: 42 });
  assert.equal(calls.promptAsync.length, 1);
  assert.equal(calls.promptAsync[0].path.id, "S");
  assert.equal(calls.promptAsync[0].body, body); // body passed through untouched (incl. format cast)
  assert.equal(calls.message[0].path.messageID, "m1"); // id captured from the stream
  assert.equal(calls.messages, 0); // no list fallback needed
});

test("driveToCompletion: rejects on session.error for our session", async () => {
  const { client } = fakeClient({
    events: [ev("session.error", { sessionID: "S", error: { name: "ProviderError" } })],
  });
  await assert.rejects(
    () => driveToCompletion(client, "S", {}, 5000),
    /session\.error/,
  );
});

test("driveToCompletion: times out and aborts the server-side run when idle never arrives", async () => {
  const { client, calls } = fakeClient({ events: [], hangAfterEvents: true });
  await assert.rejects(
    () => driveToCompletion(client, "S", {}, 30),
    /timed out after 30ms/,
  );
  assert.equal(calls.abort.length, 1);
  assert.equal(calls.abort[0].path.id, "S"); // session.abort called to stop the run
});

test("driveToCompletion: falls back to the message list when idle beats the id capture", async () => {
  const info = { role: "assistant", id: "m9", sessionID: "S", structured: { ok: true } };
  const { client, calls } = fakeClient({
    events: [ev("session.idle", { sessionID: "S" })], // no assistant message.updated seen
    messagesList: [
      { info: { role: "user", id: "m0" } },
      { info: { role: "assistant", id: "m9" } },
    ],
    messageInfo: info,
  });
  const out = await driveToCompletion(client, "S", {}, 5000);
  assert.deepEqual(out.structured, { ok: true });
  assert.equal(calls.messages, 1); // used the list fallback
  assert.equal(calls.message[0].path.messageID, "m9"); // last assistant message
});

test("driveToCompletion: rejects if the event stream ends before idle", async () => {
  const { client } = fakeClient({ events: [ev("session.status", { sessionID: "S" })] });
  await assert.rejects(
    () => driveToCompletion(client, "S", {}, 5000),
    /ended before session\.idle/,
  );
});

test("driveToCompletion: a promptAsync that throws rejects with that error, and nothing else escapes", async () => {
  // A network failure throws out of the SDK client (it does not catch fetch errors). The event stream
  // then ends without idle; that second failure must not surface as an unhandled rejection, which
  // would kill the process before the stall retry could run.
  const stray: unknown[] = [];
  const onStray = (r: unknown) => stray.push(r);
  process.on("unhandledRejection", onStray);
  try {
    const { client } = fakeClient({
      events: [],
      hangAfterEvents: true,
      promptAsync: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await assert.rejects(() => driveToCompletion(client, "S", {}, 5000), /fetch failed/);
    await new Promise((r) => setTimeout(r, 50)); // time for a stray rejection to surface
    assert.deepEqual(stray, []);
  } finally {
    process.off("unhandledRejection", onStray);
  }
});

test("driveToCompletion: an HTTP error from promptAsync fails at once, with the server's answer", async () => {
  // The SDK returns an HTTP failure as { error, response } rather than throwing. Unchecked, the prompt
  // never runs, the session never goes idle, and the failure surfaced only as a watchdog stall.
  const { client } = fakeClient({
    events: [],
    hangAfterEvents: true,
    promptAsync: async () => ({
      error: { name: "BadRequest", data: { message: "invalid body" } },
      response: { status: 400 },
    }),
  });
  const started = Date.now();
  await assert.rejects(
    () => driveToCompletion(client, "S", {}, 5000),
    /promptAsync failed \(HTTP 400\).*invalid body/,
  );
  assert.ok(Date.now() - started < 1000, "fails on the response, not at a timeout");
});
