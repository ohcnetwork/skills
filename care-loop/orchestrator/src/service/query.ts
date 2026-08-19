// service/query.ts — parse and VALIDATE query strings at the edge ([[PLAN-loop-service]] §6).
//
// Express hands every query value through as `string | string[] | ParsedQs`. Coercing that inline at
// each route is where silent wrongness gets in: `?limit=abc` becoming NaN, `?active=false` being
// truthy because it is a non-empty string, `?offset=-5` reaching SQL. Everything is parsed once,
// here, and a malformed value is a 400 rather than a surprising result set.

import { badRequest } from "./errors.js";

type RawQuery = Record<string, unknown>;

/** A single string value, or undefined. A repeated param (`?repo=a&repo=b`) takes the LAST — that is
 *  what a form resubmit produces, and silently ANDing two values would return nothing. */
export function str(q: RawQuery, key: string): string | undefined {
  const v = q[key];
  if (v === undefined) return undefined;
  const one = Array.isArray(v) ? v[v.length - 1] : v;
  if (typeof one !== "string") throw badRequest("bad_query", `${key} must be a string`);
  const trimmed = one.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Every value for a repeatable param (`?event=step.enter&event=run.end`). */
export function strList(q: RawQuery, key: string): string[] | undefined {
  const v = q[key];
  if (v === undefined) return undefined;
  const all = (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === "string");
  const cleaned = all.map((x) => x.trim()).filter((x) => x !== "");
  return cleaned.length > 0 ? cleaned : undefined;
}

/** A non-negative integer. Rejects NaN, floats, and negatives rather than letting them reach SQL.
 *  `min` guards the values that are syntactically fine but meaningless — `?limit=0` parses, and would
 *  otherwise be silently clamped up to 1, which is a stranger answer than an error. */
export function int(
  q: RawQuery,
  key: string,
  opts: { min?: number } = {},
): number | undefined {
  const raw = str(q, key);
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw))
    throw badRequest("bad_query", `${key} must be a non-negative integer, got '${raw}'`);
  const n = Number.parseInt(raw, 10);
  if (opts.min !== undefined && n < opts.min)
    throw badRequest("bad_query", `${key} must be at least ${opts.min}, got ${n}`);
  return n;
}

/** A boolean. Accepts the forms a URL actually carries; anything else is a 400 rather than silently
 *  truthy — `?active=false` meaning "active" is the exact bug this exists to prevent. */
export function bool(q: RawQuery, key: string): boolean | undefined {
  const raw = str(q, key)?.toLowerCase();
  if (raw === undefined) return undefined;
  if (["1", "true", "yes"].includes(raw)) return true;
  if (["0", "false", "no"].includes(raw)) return false;
  throw badRequest("bad_query", `${key} must be a boolean (true/false), got '${raw}'`);
}
