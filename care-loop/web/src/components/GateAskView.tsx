// GateAskView.tsx — the human gate, on a screen ([[PLAN-loop-service]] §7, §8).
//
// This is the one place in the app where a click authorizes something irreversible: approval lets
// the loop push commits and open a PR on origin. So the ask is rendered in full — every acceptance
// criterion, the test plan, and the `Planned by:` line the SKILL mandates — rather than summarised
// into a yes/no. A gate that is easier to skim than to read is a rubber stamp.

import { useState } from "react";
import { useAnswerGate } from "../api/queries";
import { ApiError } from "../api/client";
import type { ConsolidatedAsk, GateAsk, PlanQuestion } from "../api/types";
import { Badge, Button, Card, cn } from "./ui/primitives";

const H = "text-xs font-semibold uppercase tracking-wide text-muted-foreground";
const TEXTAREA = cn(
  "mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm",
  "placeholder:text-muted-foreground/70",
);

export function GateAskView({ ask, onSettled }: { ask: GateAsk; onSettled?: () => void }) {
  return ask.kind === "approve" ? (
    <ApproveGate ask={ask} payload={ask.payload as ConsolidatedAsk} onSettled={onSettled} />
  ) : (
    <InterviewGate ask={ask} questions={ask.payload as PlanQuestion[]} onSettled={onSettled} />
  );
}

/** Shared framing: what is being asked, and how long it stays answerable. */
function GateFrame({
  title,
  ask,
  error,
  children,
}: {
  title: string;
  ask: GateAsk;
  error: unknown;
  children: React.ReactNode;
}) {
  const api = error instanceof ApiError ? error : null;
  return (
    <Card className="border-warn/40 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {/* Not decoration: the ask stops being answerable at this moment, and a run whose gate
            expires loses finished planning work. */}
        <Badge tone="warn">expires {new Date(ask.expires_at).toLocaleString()}</Badge>
      </div>
      {children}
      {api && (
        <p className="mt-3 text-sm text-destructive">
          {api.status === 404
            ? "Someone else answered this first — reload to see where the run went."
            : api.message}
        </p>
      )}
    </Card>
  );
}

function ApproveGate({
  ask,
  payload,
  onSettled,
}: {
  ask: GateAsk;
  payload: ConsolidatedAsk;
  onSettled?: () => void;
}) {
  const answer = useAnswerGate(ask.run_id);
  const [amending, setAmending] = useState(false);
  const [amendment, setAmendment] = useState("");
  const send = (body: Parameters<typeof answer.mutate>[0]): void =>
    answer.mutate(body, { onSuccess: () => onSettled?.() });

  return (
    <GateFrame title="Plan approval" ask={ask} error={answer.error}>
      <dl className="mt-4 space-y-4 text-sm">
        <div>
          <dt className={H}>Planned by</dt>
          {/* Surfaced because a wrong-tier plan is meant to be caught at this one review moment. */}
          <dd className="mt-1">{payload.plannedBy}</dd>
        </div>
        <div>
          <dt className={H}>Summary</dt>
          <dd className="mt-1 whitespace-pre-wrap">{payload.summary}</dd>
        </div>
        <div>
          <dt className={H}>Classification</dt>
          <dd className="mt-1">
            <Badge>{payload.classification}</Badge>
          </dd>
        </div>
        <div>
          <dt className={H}>Acceptance criteria</dt>
          <dd className="mt-1">
            {payload.criteria.length ? (
              <ul className="list-disc space-y-1 pl-5">
                {payload.criteria.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            ) : (
              <span className="text-muted-foreground">(none stated)</span>
            )}
          </dd>
        </div>
        <div>
          <dt className={H}>Tests</dt>
          <dd className="mt-1 whitespace-pre-wrap">{payload.testPlan}</dd>
        </div>
      </dl>

      <p className="mt-4 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm">
        {payload.pushAuthNote}
      </p>

      {amending ? (
        <div className="mt-4">
          <label className={H} htmlFor="amendment">
            What should change?
          </label>
          <textarea
            id="amendment"
            rows={3}
            autoFocus
            value={amendment}
            onChange={(e) => setAmendment(e.target.value)}
            placeholder="The planner folds this into a fresh draft and asks again."
            className={TEXTAREA}
          />
          <div className="mt-3 flex gap-2">
            <Button
              // An empty amendment would send the planner off to re-draft against no instruction —
              // a model call spent to produce the same plan. The server refuses it too.
              disabled={!amendment.trim() || answer.isPending}
              onClick={() => send({ decision: "amend", amendment: amendment.trim() })}
            >
              Send amendment
            </Button>
            <Button variant="ghost" onClick={() => setAmending(false)}>
              Back
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-5 flex flex-wrap gap-2">
          <Button disabled={answer.isPending} onClick={() => send({ decision: "approve" })}>
            Approve
          </Button>
          <Button variant="outline" onClick={() => setAmending(true)}>
            Amend
          </Button>
          <Button
            variant="outline"
            disabled={answer.isPending}
            className="text-destructive"
            onClick={() => send({ decision: "reject" })}
          >
            Reject
          </Button>
        </div>
      )}
    </GateFrame>
  );
}

function InterviewGate({
  ask,
  questions,
  onSettled,
}: {
  ask: GateAsk;
  questions: PlanQuestion[];
  onSettled?: () => void;
}) {
  const answer = useAnswerGate(ask.run_id);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  // Every question, because a partial set reaches the planner as a silently shorter interview and
  // the plan gets drafted against the gaps. The server enforces it; the button just agrees.
  const complete = questions.every((q) => (answers[q.id] ?? "").trim() !== "");

  return (
    <GateFrame title="Plan interview" ask={ask} error={answer.error}>
      <p className="mt-2 text-sm text-muted-foreground">
        The planner needs these settled before it drafts. Answers are folded into the plan.
      </p>
      <div className="mt-4 space-y-4">
        {questions.map((q, i) => (
          <div key={q.id}>
            <label className="block text-sm" htmlFor={q.id}>
              <span className="mr-2 text-muted-foreground">{i + 1}.</span>
              {q.prompt}
            </label>
            <textarea
              id={q.id}
              rows={2}
              value={answers[q.id] ?? ""}
              onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
              className={TEXTAREA}
            />
          </div>
        ))}
      </div>
      <Button
        className="mt-4"
        disabled={!complete || answer.isPending}
        onClick={() =>
          answer.mutate(
            { answers: questions.map((q) => ({ id: q.id, answer: (answers[q.id] ?? "").trim() })) },
            { onSuccess: () => onSettled?.() },
          )
        }
      >
        {answer.isPending ? "Sending…" : "Send answers"}
      </Button>
    </GateFrame>
  );
}
