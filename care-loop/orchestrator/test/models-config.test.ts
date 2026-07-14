import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadModels } from "../src/models-config.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "careloopd-models-"));

function write(dir: string, body: string): string {
  const p = join(dir, "models.json");
  writeFileSync(p, body, "utf8");
  return p;
}

test("per-role override wins over the tier default", () => {
  const p = write(
    tmp(),
    JSON.stringify({
      provider: "p",
      tiers: { judgment: "J", maker: "M" },
      roles: { reviewer: "R" },
    }),
  );
  const m = loadModels(p);
  assert.equal(m.provider, "p");
  assert.equal(m.reviewer, "R"); // role override
  assert.equal(m.planner, "J"); // tier default (no role override)
  assert.equal(m.triager, "J");
  assert.equal(m.implementer, "M"); // maker tier
});

test("tier default applies to all judgment roles when no per-role override", () => {
  const p = write(
    tmp(),
    JSON.stringify({ tiers: { judgment: "JUDGE", maker: "MAKE" } }),
  );
  const m = loadModels(p);
  assert.equal(m.reviewer, "JUDGE");
  assert.equal(m.planner, "JUDGE");
  assert.equal(m.triager, "JUDGE");
  assert.equal(m.implementer, "MAKE");
});

test("missing file → all-undefined (factories fall back to their built-in defaults), no throw", () => {
  const m = loadModels(join(tmp(), "does-not-exist.json"));
  assert.equal(m.reviewer, undefined);
  assert.equal(m.planner, undefined);
  assert.equal(m.implementer, undefined);
  assert.equal(m.provider, undefined);
});

test("present-but-malformed file → warns and falls back to undefined (does not throw)", () => {
  const dir = tmp();
  const p = write(dir, "{ this is not valid json");
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (msg: unknown) => warnings.push(String(msg));
  try {
    const m = loadModels(p);
    assert.equal(m.reviewer, undefined);
  } finally {
    console.warn = orig;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /could not be parsed/);
});

test("local-model config resolves without any Copilot/Opus reference (the swap goal)", () => {
  const p = write(
    tmp(),
    JSON.stringify({
      provider: "ollama",
      tiers: { judgment: "qwen2.5-coder", maker: "qwen2.5-coder" },
    }),
  );
  const m = loadModels(p);
  assert.equal(m.provider, "ollama");
  assert.equal(m.reviewer, "qwen2.5-coder");
  assert.equal(m.planner, "qwen2.5-coder");
});
