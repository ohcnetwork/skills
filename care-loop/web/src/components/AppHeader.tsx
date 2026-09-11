import { Link } from "@tanstack/react-router";
import { useGates, useLogout, useMe } from "../api/queries";
import { Badge, Button } from "./ui/primitives";

export function AppHeader({ subtitle }: { subtitle?: string }) {
  const me = useMe();
  const logout = useLogout();
  // Everywhere, not just the fleet page: a gate nobody notices expires, throwing away planning work
  // already paid for.
  const gates = useGates();
  const waiting = gates.data?.total ?? 0;

  return (
    <header className="mb-4 flex items-baseline justify-between gap-4 border-b border-border pb-3">
      <div className="flex items-baseline gap-2">
        <Link to="/" className="text-base font-semibold tracking-tight text-foreground">
          care-loop
        </Link>
        {subtitle && <span className="text-xs text-muted-foreground">{subtitle}</span>}
      </div>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        {waiting > 0 && (
          <Link to="/" search={{ gate: true }}>
            <Badge tone="warn">
              {waiting} waiting on a human
            </Badge>
          </Link>
        )}
        <Link to="/new" className="text-primary hover:underline">
          new run
        </Link>
        {me.data?.login}
        <Button variant="link" size="none" onClick={() => logout.mutate()} disabled={logout.isPending}>
          sign out
        </Button>
      </div>
    </header>
  );
}
