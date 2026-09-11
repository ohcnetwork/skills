// Express types every query value as `string | string[] | ParsedQs`. Coercing inline at each route is
// where silent wrongness gets in (`?limit=abc` → NaN, `?active=false` → truthy), so every value is
// parsed here and a malformed one is a 400 rather than a surprising result set.

import { badRequest } from "./errors.js";

type RawQuery = Record<string, unknown>;

const TRUTHY = ["1", "true", "yes"];
const FALSY = ["0", "false", "no"];

/** A repeated param (`?repo=a&repo=b`) takes the last — what a form resubmit produces. */
export function str(q: RawQuery, key: string): string | undefined {
  const v = q[key];
  if (v === undefined) return undefined;
  const last = Array.isArray(v) ? v[v.length - 1] : v;
  if (typeof last !== "string") throw badRequest("bad_query", `${key} must be a string`);
  return last.trim() || undefined;
}

/** Every value for a repeatable param (`?event=step.enter&event=run.end`). */
export function strList(q: RawQuery, key: string): string[] | undefined {
  const v = q[key];
  if (v === undefined) return undefined;
  const values = (Array.isArray(v) ? v : [v])
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter((x) => x !== "");
  return values.length > 0 ? values : undefined;
}

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

export function bool(q: RawQuery, key: string): boolean | undefined {
  const raw = str(q, key)?.toLowerCase();
  if (raw === undefined) return undefined;
  if (TRUTHY.includes(raw)) return true;
  if (FALSY.includes(raw)) return false;
  throw badRequest("bad_query", `${key} must be a boolean (true/false), got '${raw}'`);
}
