// Resolves the caller from a session cookie, falling back to the `X-Care-User` header for curl,
// scripts, and the CLI. Both are claims, not authentication — the trust boundary is the network.
//
// The header is confined to this function so that deleting it is a one-line change: alongside real
// auth it would be a bypass rather than a convenience.

import type { NextFunction, Request, Response } from "express";
import { ApiError } from "./errors.js";
import { isValidLogin, readCookie, SESSION_COOKIE, type SessionStore, type User } from "./auth.js";

export const USER_HEADER = "x-care-user";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** The caller's claimed login, or null when nothing identifies them. */
      user: string | null;
      /** The roster row, present only for a session — the header path has none. */
      account: User | null;
      /** So /auth/logout revokes exactly the token it arrived on. */
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
      // Identify, don't gate: a revoked or expired cookie falls through to the header.
    }

    const claimedLogin = req.header(USER_HEADER)?.trim() ?? "";
    if (claimedLogin !== "") {
      // Held to the rule /auth/login enforces — they write the same column, and two standards would
      // let a login rejected at the form walk in here and become a permanent `requested_by` value.
      if (!isValidLogin(claimedLogin))
        throw new ApiError(400, "bad_user", `X-Care-User '${claimedLogin}' is not a valid login`);
      req.user = claimedLogin;
    }
    next();
  };
}

/** Requires that the caller said who they are. Never asks what they are allowed to do. */
export function requireUser(req: Request): string {
  if (!req.user) throw new ApiError(401, "not_authenticated", "not signed in");
  return req.user;
}
