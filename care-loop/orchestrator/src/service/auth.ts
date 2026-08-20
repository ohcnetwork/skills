// service/auth.ts — sessions ([[PLAN-loop-service]] §6).
//
// **This is not authentication yet, and the shape is the point.** Logging in means claiming a GitHub
// login; nothing verifies it, and the security boundary remains the network (§6). What it buys is the
// STRUCTURE real auth needs: a session established by some credential step, a cookie carrying it, and
// every route downstream reading `req.user` without caring how it got there. Adding GitHub OAuth
// replaces `login()`'s body — verify the code, read the real account — and leaves `resolve`,
// `revoke`, the cookie handling, and every route untouched.
//
// Two habits are worth having from the start even though nothing here is secret yet:
//   • the db stores a HASH of the token, never the token, so a leaked database is not a set of live
//     logins (the cookie is the only copy);
//   • logout REVOKES rather than deletes, so "who was signed in when" survives the sign-out.

import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const SESSION_COOKIE = "care_session";
/** 30 days. Long because this is a team dashboard on a VPN, not a bank. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** How stale `last_seen_at` may get before `resolve` bothers to refresh it.
 *
 *  This exists because `resolve` runs on EVERY request — including `/api/health` and every static
 *  asset — and an unconditional UPDATE made every authenticated request a writer. Under a child's
 *  write lock that cost the full `busy_timeout` and then threw, turning a read-only dashboard poll
 *  into a 5-second hang and an HTTP 500. `last_seen_at` is a liveness hint, not an audit trail;
 *  minute-granularity is more than it is ever read at. */
export const SESSION_TOUCH_INTERVAL_MS = 60_000;

export interface User {
  id: number;
  login: string;
  githubId: number | null;
  createdAt: string;
  lastSeenAt: string;
}

export interface LoginResult {
  user: User;
  /** The raw token — the ONLY copy. Goes straight into the cookie and is never stored. */
  token: string;
}

const hash = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

/** GitHub's own rule: 1–39 chars, alphanumeric or single hyphens, not leading/trailing a hyphen.
 *  Validated even though the claim is unverified — a login that could never exist is a typo, and a
 *  typo silently becoming a new "user" is how a roster fills with junk. */
const LOGIN_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;

export function isValidLogin(login: string): boolean {
  return LOGIN_RE.test(login);
}

interface UserRow {
  id: number;
  login: string;
  github_id: number | null;
  created_at: string;
  last_seen_at: string;
}

const toUser = (r: UserRow): User => ({
  id: r.id,
  login: r.login,
  githubId: r.github_id,
  createdAt: r.created_at,
  lastSeenAt: r.last_seen_at,
});

export class SessionStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Find or create the user, then mint a session. The upsert is what accumulates the roster: today
   *  from a claimed login, later from a verified OAuth account, with no change to callers. */
  login(login: string, now: Date = new Date()): LoginResult {
    const iso = now.toISOString();
    this.db
      .prepare(
        `INSERT INTO users (login, created_at, last_seen_at) VALUES (?, ?, ?)
         ON CONFLICT(login) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      )
      .run(login, iso, iso);
    const row = this.db
      .prepare("SELECT * FROM users WHERE login = ?")
      .get(login) as unknown as UserRow;

    const token = randomBytes(32).toString("hex");
    this.db
      .prepare(
        `INSERT INTO sessions (token_sha256, user_id, created_at, expires_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(hash(token), row.id, iso, new Date(now.getTime() + SESSION_TTL_MS).toISOString(), iso);
    return { user: toUser(row), token };
  }

  /** The user behind a token, or null if it is unknown, revoked, or expired. Expiry is checked in SQL
   *  against the caller's clock rather than swept by a background job: a stale row that is never read
   *  costs nothing, and a sweep is one more thing to run and get wrong. */
  resolve(token: string, now: Date = new Date()): User | null {
    const iso = now.toISOString();
    const digest = hash(token);
    const row = this.db
      .prepare(
        `SELECT u.*, s.last_seen_at AS session_seen FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_sha256 = ? AND s.revoked_at IS NULL AND s.expires_at > ?`,
      )
      .get(digest, iso) as unknown as (UserRow & { session_seen: string }) | undefined;
    if (!row) return null;

    // Throttled, and deliberately AFTER the identity is already decided. Two separate problems were
    // being caused by the unconditional version:
    //   • every request became a write, so a read-only dashboard poll contended with a running child;
    //   • a SQLITE_BUSY on this bookkeeping write propagated out of the identity middleware, which is
    //     not wrapped by `route()`, and 500'd the whole request — costing the caller their identity
    //     over a timestamp nobody reads at second granularity.
    const age = now.getTime() - Date.parse(row.session_seen);
    if (!Number.isFinite(age) || age >= SESSION_TOUCH_INTERVAL_MS) {
      try {
        this.db
          .prepare("UPDATE sessions SET last_seen_at = ? WHERE token_sha256 = ?")
          .run(iso, digest);
      } catch (err) {
        // Non-fatal by design: failing to record when someone was last seen must never fail their
        // request. Logged so a persistently locked db is still visible.
        console.error("[service] session touch failed (identity is unaffected):", err);
      }
    }
    return toUser(row);
  }

  /** Idempotent: revoking an unknown or already-revoked token is a no-op, so a double logout (or a
   *  logout with a stale cookie) succeeds rather than erroring at someone who is already signed out. */
  revoke(token: string, now: Date = new Date()): void {
    this.db
      .prepare(
        "UPDATE sessions SET revoked_at = ? WHERE token_sha256 = ? AND revoked_at IS NULL",
      )
      .run(now.toISOString(), hash(token));
  }

  /** Every session for a user — what a future "sign out everywhere" needs, and what makes the roster
   *  inspectable while there is no real auth behind it. */
  revokeAllFor(userId: number, now: Date = new Date()): void {
    this.db
      .prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
      .run(now.toISOString(), userId);
  }

  byLogin(login: string): User | null {
    const row = this.db
      .prepare("SELECT * FROM users WHERE login = ?")
      .get(login) as unknown as UserRow | undefined;
    return row ? toUser(row) : null;
  }
}

/** Parse one named cookie out of a Cookie header. Hand-rolled to avoid a dependency for a single
 *  cookie; deliberately tolerant of whitespace and of other cookies sharing the header. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return value === "" ? null : decodeURIComponent(value);
  }
  return null;
}

export function sessionCookie(token: string, opts: { secure: boolean }): string {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (opts.secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function clearedCookie(opts: { secure: boolean }): string {
  const attrs = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (opts.secure) attrs.push("Secure");
  return attrs.join("; ");
}
