// Routes in code rather than by file convention: there are three of them, and the fleet's filters
// live in the URL as validated search params — a link IS the filtered view.

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
  // Normalises the keys it knows, so an unparseable `order` degrades to the default rather than
  // blanking the screen on a 400. NOT a whitelist: the router merges this over the raw search, so
  // unnamed keys (`offset`, which the pager writes) survive — load-bearing for pagination, and safe
  // because the API validates every parameter itself.
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
      // The API has no "has an open gate" filter; narrowed client-side from the needs-you list.
      gate: raw.gate === true || raw.gate === "true" ? true : undefined,
    };
  },
  component: FleetPage,
});

const runRoute = createRoute({
  getParentRoute: () => rootRoute,
  // Keyed by run_id: slug has no unique constraint, and a reused branch collides deterministically.
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
