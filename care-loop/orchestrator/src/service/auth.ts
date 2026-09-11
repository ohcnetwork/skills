// Sessions. Logging in means CLAIMING a GitHub login — nothing verifies it yet, and the trust
// boundary is the network. Adding OAuth replaces `login()`'s body and leaves `resolve`, `revoke`,
// the cookie handling, and every route untouched.
//
// The db stores a hash of the token, never the token, so a leaked database is not a set of live
// logins; logout revokes rather than deletes, so "who was signed in when" survives the sign-out.

import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const SESSION_COOKIE = "care_session";
/** Long because this is a team dashboard on a VPN, not a bank. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** `last_seen_at` is a liveness hint, not an audit trail, so it is refreshed at most this often —
 *  an unconditional update made every authenticated request a writer contending with running
 *  children, turning dashboard polls into `busy_timeout` hangs. */
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
  /** The only copy — goes straight into the cookie and is never stored. */
  token: string;
}

const hash = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

/** GitHub's own rule: 1–39 chars, alphanumeric or single hyphens, none leading or trailing. Enforced
 *  even on an unverified claim, so a typo cannot silently become a new roster entry. */
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

  /** The upsert is what accumulates the roster: today from a claimed login, later from a verified
   *  OAuth account, with no change to callers. */
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

  /** Expiry is enforced in SQL rather than swept by a background job — an expired row that is never
   *  read costs nothing. */
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

    this.touch(digest, row.session_seen, now);
    return toUser(row);
  }

  /** Runs after the identity is already decided, and never throws: a SQLITE_BUSY here would escape
   *  the identity middleware, which `route()` does not wrap, and cost the caller their whole request
   *  over a timestamp nobody reads at second granularity. */
  private touch(tokenDigest: string, sessionSeenAt: string, now: Date): void {
    const age = now.getTime() - Date.parse(sessionSeenAt);
    if (Number.isFinite(age) && age < SESSION_TOUCH_INTERVAL_MS) return;
    try {
      this.db
        .prepare("UPDATE sessions SET last_seen_at = ? WHERE token_sha256 = ?")
        .run(now.toISOString(), tokenDigest);
    } catch (err) {
      console.error("[service] session touch failed (identity is unaffected):", err);
    }
  }

  /** Idempotent, so a double logout or a stale cookie succeeds rather than erroring at someone who
   *  is already signed out. */
  revoke(token: string, now: Date = new Date()): void {
    this.db
      .prepare(
        "UPDATE sessions SET revoked_at = ? WHERE token_sha256 = ? AND revoked_at IS NULL",
      )
      .run(now.toISOString(), hash(token));
  }

  /** What "sign out everywhere" needs. */
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

/** Hand-rolled to avoid a dependency for one cookie; tolerant of whitespace and of other cookies
 *  sharing the header. */
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
