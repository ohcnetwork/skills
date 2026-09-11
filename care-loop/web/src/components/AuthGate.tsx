import { useState, type ReactNode } from "react";
import { useLogin, useMe } from "../api/queries";
import { ApiError } from "../api/client";
import { Button, Card, Input } from "./ui/primitives";

export function AuthGate({ children }: { children: ReactNode }) {
  const me = useMe();

  if (me.isPending)
    return <div className="grid min-h-screen place-items-center text-muted-foreground">loading…</div>;

  if (me.isError) {
    const err = me.error as ApiError;
    return (
      <div className="grid min-h-screen place-items-center p-5">
        <Card className="w-full max-w-md border-destructive p-6">
          <h2 className="mb-2 text-base font-semibold">Cannot reach the service</h2>
          <p className="mb-1 text-muted-foreground">{err.message}</p>
          <p className="mb-4 text-xs text-muted-foreground">
            Is <code className="font-mono">care-loopd serve</code> running?
          </p>
          <Button onClick={() => void me.refetch()}>Retry</Button>
        </Card>
      </div>
    );
  }

  if (!me.data?.login) return <LoginForm />;
  return <>{children}</>;
}

function LoginForm() {
  const [login, setLogin] = useState("");
  const doLogin = useLogin();
  const err = doLogin.error as ApiError | null;

  return (
    <div className="grid min-h-screen place-items-center p-5">
      <Card className="w-full max-w-sm p-6">
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (login.trim()) doLogin.mutate(login.trim());
          }}
        >
          <h1 className="text-lg font-semibold tracking-tight">care-loop</h1>
          <label htmlFor="login" className="text-xs text-muted-foreground">
            GitHub username
          </label>
          <Input
            id="login"
            value={login}
            onChange={(e) => setLogin(e.target.value)}
            placeholder="octocat"
            autoFocus
            autoComplete="username"
            spellCheck={false}
          />
          {err && <p className="text-sm text-destructive">{err.message}</p>}
          <Button type="submit" disabled={!login.trim() || doLogin.isPending}>
            {doLogin.isPending ? "signing in…" : "Continue"}
          </Button>
          {/* Stated plainly rather than buried: nothing verifies this, and implying otherwise would
              be the kind of security theatre that makes people trust it more than they should. */}
          <p className="text-xs leading-relaxed text-muted-foreground">
            This identifies you for attribution. It is not authentication — the trust boundary is the
            network.
          </p>
        </form>
      </Card>
    </div>
  );
}
