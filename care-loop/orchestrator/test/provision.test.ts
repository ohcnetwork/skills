import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  lstatSync,
  existsSync,
  readlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { symlinkProvisioner } from "../src/provision.ts";

function scene(): { main: string; wt: string } {
  const root = mkdtempSync(join(tmpdir(), "careloopd-prov-"));
  const main = join(root, "main");
  const wt = join(root, "wt");
  mkdirSync(join(main, "node_modules"), { recursive: true });
  mkdirSync(join(main, "src"), { recursive: true });
  writeFileSync(
    join(main, "src", "supportedBrowsers.ts"),
    "export default [];\n",
  );
  writeFileSync(join(main, ".env"), "X=1\n");
  mkdirSync(join(wt, "src"), { recursive: true }); // worktree has tracked dirs but not the ignored files
  return { main, wt };
}

test("symlinks node_modules, the generated source, and .env into the worktree", () => {
  const { main, wt } = scene();
  const r = symlinkProvisioner()({ worktree: wt, mainRepoPath: main });
  assert.equal(r.exit, 0);
  for (const rel of ["node_modules", "src/supportedBrowsers.ts", ".env"]) {
    assert.ok(existsSync(join(wt, rel)), `${rel} should exist`);
    assert.ok(
      lstatSync(join(wt, rel)).isSymbolicLink(),
      `${rel} should be a symlink`,
    );
    assert.equal(readlinkSync(join(wt, rel)), join(main, rel));
  }
});

test("skips a dest that already exists (idempotent re-provision)", () => {
  const { main, wt } = scene();
  writeFileSync(join(wt, ".env"), "PREEXISTING=1\n"); // worktree already has a real .env
  const r = symlinkProvisioner()({ worktree: wt, mainRepoPath: main });
  assert.equal(r.exit, 0);
  assert.equal(lstatSync(join(wt, ".env")).isSymbolicLink(), false); // untouched (still the real file)
  assert.match(r.summary, /node_modules/); // but the others were linked
});

test("skips a link whose source is absent in the main checkout", () => {
  const { main, wt } = scene();
  const r = symlinkProvisioner(["node_modules", "does/not/exist.ts"])({
    worktree: wt,
    mainRepoPath: main,
  });
  assert.equal(r.exit, 0);
  assert.equal(existsSync(join(wt, "does/not/exist.ts")), false);
  assert.ok(lstatSync(join(wt, "node_modules")).isSymbolicLink());
});
