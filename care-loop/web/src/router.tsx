// router.tsx — routes, defined in code rather than by file convention.
//
// Two reasons. There are three of them, so a generated route tree would be more machinery than
// content. And the fleet's filters live in the URL as validated search params — a link IS the
// filtered view, shareable and back/forward-able — which is easier to read declared here than spread
// across files.

import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import { AuthGate } from "./components/AuthGate";
import { FleetPage } from "./routes/fleet";
import { RunPage } from "./routes/run";
import { NewRunPage } from "./routes/new-run";
import type { ListOrder, RunFilters } from "./api/types";

const ORDERS: ListOrder[] = ["started_at", "updated_at", "cost_usd", "duration_ms"];

const rootRoute = createRootRoute({
  component: () => (
    <AuthGate>
      <Outlet />
    </AuthGate>
  ),
});

const fleetRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  // Search params are the filter state. This NORMALISES the keys it knows about, so an unparseable
  // `order` or `dir` degrades to the default rather than blanking the screen on a 400.
  //
  // It is not a whitelist: TanStack Router merges validated output over the raw search rather than
  // replacing it, so keys not named here (e.g. `offset`, which the pager writes) survive into
  // `useSearch()` and are forwarded by `qs`. That is load-bearing — pagination depends on it — and is
  // safe because the API validates every parameter itself and 400s on anything malformed.
  validateSearch: (raw: Record<string, unknown>): RunFilters => {
    const s = (k: string): string | undefined => {
      const v = raw[k];
      return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
    };
    const order = s("order");
    const dir = s("dir");
    return {
      requested_by: s("requested_by"),
      repo: s("repo"),
      branch: s("branch"),
      step: s("step"),
      q: s("q"),
      active: raw.active === true || raw.active === "true" ? true : undefined,
      stale: raw.stale === true || raw.stale === "true" ? true : undefined,
      order: ORDERS.includes(order as ListOrder) ? (order as ListOrder) : undefined,
      dir: dir === "asc" || dir === "desc" ? dir : undefined,
      // Not a server filter: the API has no notion of "has an open gate". Narrowed client-side from
      // the needs-you list, which is one small polled request either way.
      gate: raw.gate === true || raw.gate === "true" ? true : undefined,
    };
  },
  component: FleetPage,
});

const runRoute = createRoute({
  getParentRoute: () => rootRoute,
  // Keyed by run_id, never the slug: slug has no unique constraint and a reused branch collides on
  // it deterministically ([[PLAN-loop-service]] §6).
  path: "/runs/$runId",
  component: RunPage,
});

const newRunRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/new",
  component: NewRunPage,
});

const routeTree = rootRoute.addChildren([fleetRoute, newRunRoute, runRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
