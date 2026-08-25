// new-run.tsx — the form that replaces `terminalFront`'s questionnaire ([[PLAN-loop-service]] §8).
//
// The same four seed fields the CLI prompts for, validated by the SAME rules — server-side, by
// `front-terminal.ts#validateSeed`, so a ticket that would fail the `[ENG-###]` PR-title assert or a
// branch `git worktree add` would reject fails here, while a person is looking at the form, instead
// of hours later inside a spawned child.

import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useCreateRun } from "../api/queries";
import { ApiError } from "../api/client";
import { AppHeader } from "../components/AppHeader";
import { Button, Card, Input, cn } from "../components/ui/primitives";

const FIELDS = [
  {
    key: "ticket" as const,
    label: "Ticket",
    placeholder: "ENG-613",
    hint: "Becomes the [ENG-###] PR title prefix, which the loop asserts on.",
  },
  {
    key: "branch" as const,
    label: "Branch",
    placeholder: "eng-613/expiry-column",
    hint: "The run directory and worktree are derived from it — one live run per branch.",
  },
  {
    key: "summary" as const,
    label: "PR summary",
    placeholder: "add expiry date to the supply table",
    hint: "One line. Becomes the PR title after the ticket prefix.",
  },
];

const LABEL = "block text-xs font-semibold text-muted-foreground";
const HINT = "mt-1 text-xs text-muted-foreground/80";

export function NewRunPage() {
  const navigate = useNavigate();
  const create = useCreateRun();
  const [form, setForm] = useState({ ticket: "", branch: "", summary: "", task: "" });

  // The server validates every field and names the offender in `error.code` (`bad_ticket`,
  // `bad_branch`, …). Mapping that back onto the input is what makes the message land next to the
  // thing that is wrong, rather than as a banner the eye has to correlate.
  const err = create.error instanceof ApiError ? create.error : null;
  const fieldError = (key: string): string | null =>
    err && err.code === `bad_${key}` ? err.message : null;
  const formError = err && !err.code.startsWith("bad_") ? err : null;

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    create.mutate(
      { ...form },
      {
        // Straight to the run. It has a stable id before it has a process — that is what minting the
        // ULID at enqueue buys — so there is a page to land on even while it is still queued.
        onSuccess: (res) => void navigate({ to: "/runs/$runId", params: { runId: res.run_id } }),
      },
    );
  };

  const ready = form.ticket && form.branch && form.summary && form.task;

  return (
    <div className="mx-auto max-w-[720px] px-5 pb-16 pt-4">
      <AppHeader subtitle="new run" />
      <Card className="mt-4 p-5">
        <form onSubmit={submit} className="space-y-5">
          <div>
            <label className={LABEL} htmlFor="task">
              Task
            </label>
            <textarea
              id="task"
              rows={4}
              value={form.task}
              onChange={(e) => setForm({ ...form, task: e.target.value })}
              placeholder="What should change, and why?"
              className={cn(
                "mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm",
                "placeholder:text-muted-foreground/70",
              )}
            />
            <p className={HINT}>
              The planner interviews against this. Vague in, vague out — it is the only free text the
              loop gets.
            </p>
            {fieldError("task") && (
              <p className="mt-1 text-xs text-destructive">{fieldError("task")}</p>
            )}
          </div>

          {FIELDS.map((f) => (
            <div key={f.key}>
              <label className={LABEL} htmlFor={f.key}>
                {f.label}
              </label>
              <Input
                id={f.key}
                value={form[f.key]}
                placeholder={f.placeholder}
                onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                className="mt-1"
              />
              <p className={HINT}>{f.hint}</p>
              {fieldError(f.key) && (
                <p className="mt-1 text-xs text-destructive">{fieldError(f.key)}</p>
              )}
            </div>
          ))}

          {formError && (
            <p className="text-sm text-destructive">
              {formError.code === "no_supervisor"
                ? "No supervisor is running, so a queued run would never start. Start the service with --supervise."
                : formError.message}
            </p>
          )}

          <div className="flex items-center gap-3">
            <Button type="submit" disabled={!ready || create.isPending}>
              {create.isPending ? "Queueing…" : "Queue run"}
            </Button>
            <Button type="button" variant="ghost" onClick={() => void navigate({ to: "/" })}>
              Cancel
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
