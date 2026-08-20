// service/identity.ts — resolve the caller, in ONE place ([[PLAN-loop-service]] §6).
//
// Two ways in, both claims rather than authentication:
//
//   1. a session cookie, established by POST /api/auth/login (auth.ts);
//   2. the `X-Care-User` header, for curl, scripts, and the CLI, which have no cookie jar.
//
// The session wins when both are present. The header is a deliberate affordance for a service whose
// boundary is the network, and it is EXACTLY the thing to delete when real auth lands — a trusted
// header alongside a verified session is a bypass, not a convenience. It is confined to this function
// so that removal is a one-line change rather than a hunt.
//
// **No route may make an authorization decision.** `?requested_by=` is a filter, not a permission.
// Keeping authorization entirely absent means adding it later is additive, rather than a hunt through
// routes that quietly assumed a trusted header.

import type { NextFunction, Request, Response } from "express";
import { ApiError } from "./errors.js";
import { isValidLogin, readCookie, SESSION_COOKIE, type SessionStore, type User } from "./auth.js";

export const USER_HEADER = "x-care-user";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** The caller's claimed login, or null when neither a session nor a header identifies them. */
      user: string | null;
      /** The full user row, present only for a real session — the header path has no roster entry. */
      account: User | null;
      /** The raw session token, so /auth/logout can revoke exactly the one it arrived on. */
      sessionToken: string | null;
    }
  }
}

export function identity(sessions: SessionStore) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    req.user = null;
    req.account = null;
    req.sessionToken = null;

    const token = readCookie(req.header("cookie"), SESSION_COOKIE);
    if (token) {
      req.sessionToken = token;
      const account = sessions.resolve(token);
      if (account) {
        req.user = account.login;
        req.account = account;
        return next();
      }
      // A cookie that no longer resolves (revoked, expired, or from a rebuilt db) falls through to
      // the header rather than 401ing here: this middleware identifies, it does not gate.
    }

    const raw = req.header(USER_HEADER);
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    if (trimmed !== "") {
      // The SAME rule `/auth/login` enforces. They write the same column, so two standards meant a
      // login rejected at the form could walk in through the header and become a permanent
      // `requested_by` value, a facet entry, and a filter option. React escapes it in the DOM, but it
      // is still junk in the data and a needless injection surface for any future non-React consumer.
      if (!isValidLogin(trimmed))
        throw new ApiError(400, "bad_user", `X-Care-User '${trimmed}' is not a valid login`);
      req.user = trimmed;
    }
    next();
  };
}

/** Routes that need SOMEONE, without caring who. Not authorization — it never asks what the caller is
 *  allowed to do, only that they said who they are. */
export function requireUser(req: Request): string {
  if (!req.user) throw new ApiError(401, "not_authenticated", "not signed in");
  return req.user;
}
