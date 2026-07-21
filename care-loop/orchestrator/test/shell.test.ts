import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHelper } from "../src/shell.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "careloopd-shell-"));
}

test("captures exit 0, writes the log, returns the last line as summary", () => {
  const dir = tmp();
  const script = join(dir, "ok.sh");
  writeFileSync(
    script,
    "#!/usr/bin/env bash\necho 'stage tsc PASS'\necho 'run_gate: ALL PASSED'\n",
  );
  chmodSync(script, 0o755);

  const r = runHelper({ cmd: script, logPath: join(dir, "gate.log") });
  assert.equal(r.exit, 0);
  assert.equal(r.summary, "run_gate: ALL PASSED");
  assert.match(readFileSync(r.logPath, "utf8"), /ALL PASSED/);
});

test("propagates a non-zero exit code", () => {
  const dir = tmp();
  const script = join(dir, "fail.sh");
  writeFileSync(
    script,
    "#!/usr/bin/env bash\necho 'lint error: boom' >&2\nexit 3\n",
  );
  chmodSync(script, 0o755);

  const r = runHelper({ cmd: script, logPath: join(dir, "gate.log") });
  assert.equal(r.exit, 3);
  assert.match(r.summary, /lint error/);
});

test("summaryMatch picks the matching line over the last line", () => {
  const dir = tmp();
  const script = join(dir, "multi.sh");
  writeFileSync(
    script,
    "#!/usr/bin/env bash\necho 'run_gate: build PASS'\necho 'run_gate: FAIL at vitest'\necho 'see log for details'\nexit 1\n",
  );
  chmodSync(script, 0o755);

  const r = runHelper({
    cmd: script,
    logPath: join(dir, "g.log"),
    summaryMatch: /PASS|FAIL/,
  });
  assert.equal(r.exit, 1);
  assert.equal(r.summary, "run_gate: FAIL at vitest");
});

test("a missing binary is a clean exit 127, not a throw", () => {
  const dir = tmp();
  const r = runHelper({
    cmd: join(dir, "does-not-exist"),
    logPath: join(dir, "g.log"),
  });
  assert.equal(r.exit, 127);
});
