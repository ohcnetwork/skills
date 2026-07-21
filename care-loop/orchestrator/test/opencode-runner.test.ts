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
