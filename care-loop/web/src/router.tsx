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
  // Search params are the filter state. Validated here so a hand-edited URL degrades to a sane view
  // instead of sending garbage to the API — the server would 400, but a blank screen with an error
  // is a worse answer than simply ignoring an unparseable sort order.
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

const routeTree = rootRoute.addChildren([fleetRoute, runRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
