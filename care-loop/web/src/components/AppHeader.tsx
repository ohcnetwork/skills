import { Link } from "@tanstack/react-router";
import { useLogout, useMe } from "../api/queries";
import { Button } from "./ui/primitives";

export function AppHeader({ subtitle }: { subtitle?: string }) {
  const me = useMe();
  const logout = useLogout();
  return (
    <header className="mb-4 flex items-baseline justify-between gap-4 border-b border-border pb-3">
      <div className="flex items-baseline gap-2">
        <Link to="/" className="text-base font-semibold tracking-tight text-foreground">
          care-loop
        </Link>
        {subtitle && <span className="text-xs text-muted-foreground">{subtitle}</span>}
      </div>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        {me.data?.login}
        <Button variant="link" size="none" onClick={() => logout.mutate()} disabled={logout.isPending}>
          sign out
        </Button>
      </div>
    </header>
  );
}
