// test/_fake-opencode.ts — an in-process stand-in for `createOpencode` that records every call a role
// makes (server config, session create/fork, each prompt body, drive timeout, abort, close) and answers
// prompts from a script. Lets tests pin the opencode layer's transport contract without a live server.
//
// Session ids are unique across every server a fake starts, so a drive (which only knows its session)
// can be attributed to the server that owns it.

export interface FakeReply {
  structured?: unknown;
  error?: { name: string; message?: string };
  sessionError?: boolean;
  /** Emit nothing after the prompt, so the session never goes idle (a transport stall). */
  hang?: boolean;
  /** Answer promptAsync with an HTTP failure the way the SDK does with throwOnError off: returned, not thrown. */
  httpError?: { status: number; body: unknown };
  modelID?: string;
  cost?: number;
  tokens?: { input?: number; output?: number; cache?: { read?: number; write?: number } };
}

export interface RecordedServer {
  config: unknown;
  closed: boolean;
  calls: Record<string, unknown>[];
}

export type FakeScript = (req: {
  sessionId: string;
  body: any;
  forkedFrom?: string;
}) => FakeReply;

export function fakeOpencode(script: FakeScript) {
  const servers: RecordedServer[] = [];
  const owner = new Map<string, RecordedServer>();
  let seq = 0;

  const launcher = async (opts: { port?: number; config?: unknown } = {}) => {
    const rec: RecordedServer = { config: opts.config, closed: false, calls: [] };
    servers.push(rec);
    const forkParent = new Map<string, string>();
    const replies = new Map<string, FakeReply>();
    const subscribers = new Set<(ev: unknown) => void>();
    const emit = (ev: unknown) => {
      for (const s of subscribers) s(ev);
    };
    const newSession = (): string => {
      const id = `s${++seq}`;
      owner.set(id, rec);
      return id;
    };

    const client = {
      session: {
        create: async (a: any) => {
          const id = newSession();
          rec.calls.push({ op: "session.create", id, title: a?.body?.title });
          return { data: { id } };
        },
        fork: async (a: any) => {
          const id = newSession();
          forkParent.set(id, a.path.id);
          rec.calls.push({ op: "session.fork", id, from: a.path.id });
          return { data: { id } };
        },
        promptAsync: async (a: any) => {
          const sessionId: string = a.path.id;
          rec.calls.push({ op: "promptAsync", session: sessionId, body: a.body });
          const reply = script({ sessionId, body: a.body, forkedFrom: forkParent.get(sessionId) });
          replies.set(sessionId, reply);
          if (reply.httpError)
            return { error: reply.httpError.body, response: { status: reply.httpError.status } };
          if (reply.hang) return;
          const messageId = `m${rec.calls.length}-${sessionId}`;
          setImmediate(() => {
            emit({
              type: "message.updated",
              properties: { info: { role: "assistant", sessionID: sessionId, id: messageId } },
            });
            emit(
              reply.sessionError
                ? { type: "session.error", properties: { sessionID: sessionId, error: { name: "FakeError" } } }
                : { type: "session.idle", properties: { sessionID: sessionId } },
            );
          });
        },
        message: async (a: any) => {
          const r = replies.get(a.path.id) ?? {};
          return {
            data: {
              info: {
                role: "assistant",
                id: a.path.messageID,
                sessionID: a.path.id,
                structured: r.structured,
                error: r.error,
                modelID: r.modelID,
                cost: r.cost,
                tokens: r.tokens,
              },
            },
          };
        },
        messages: async () => ({ data: [] }),
        abort: async (a: any) => {
          rec.calls.push({ op: "session.abort", session: a.path.id });
          return { data: true };
        },
      },
      event: {
        subscribe: async ({ signal }: { signal: AbortSignal }) => {
          const queue: unknown[] = [];
          let wake: (() => void) | undefined;
          const push = (ev: unknown) => {
            queue.push(ev);
            wake?.();
          };
          subscribers.add(push);
          const stream = (async function* () {
            try {
              for (;;) {
                while (queue.length) yield queue.shift();
                if (signal.aborted) return;
                await new Promise<void>((resolve) => {
                  wake = resolve;
                  signal.addEventListener("abort", () => resolve(), { once: true });
                });
                wake = undefined;
              }
            } finally {
              subscribers.delete(push);
            }
          })();
          return { stream };
        },
      },
    };

    return {
      client,
      server: {
        url: `http://127.0.0.1:${opts.port ?? 0}`,
        close: async () => {
          rec.closed = true;
          rec.calls.push({ op: "server.close" });
        },
      },
    } as any;
  };

  /** Pass to `setDriveObserver` so each drive's deadline is recorded on the server that owns it. */
  const observeDrive = (e: { sessionId: string; timeoutMs: number }) => {
    owner.get(e.sessionId)?.calls.push({ op: "drive", session: e.sessionId, timeoutMs: e.timeoutMs });
  };

  return { launcher, servers, observeDrive };
}
