// service/identity.ts — resolve the caller, in ONE place ([[PLAN-loop-service]] §6).
//
// Today this reads a header and trusts it: the boundary is the network (the box is VPN-only), and
// `requested_by` is a CLAIM, not an authentication. It is still a middleware rather than an inline
// header read at each route, so that adding real auth later means replacing this function's body and
// nothing else — every route already consumes `req.user` and none of them change shape.
//
// **No route may make an authorization decision.** `?requested_by=` is a filter, not a permission.
// Keeping authorization entirely absent means adding it later is additive, rather than a hunt through
// routes that quietly assumed a trusted header.

import type { NextFunction, Request, Response } from "express";

export const USER_HEADER = "x-care-user";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** The caller's claimed GitHub login, or null when the header is absent/blank. */
      user: string | null;
    }
  }
}

export function identity() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const raw = req.header(USER_HEADER);
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    req.user = trimmed === "" ? null : trimmed;
    next();
  };
}
