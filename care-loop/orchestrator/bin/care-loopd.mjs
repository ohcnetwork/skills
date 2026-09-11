#!/usr/bin/env node
// care-loopd launcher — runs the TypeScript CLI directly via tsx so no build step is needed.
// Installed on PATH through package.json "bin" (use `npm link` in this dir to expose it globally).
//
// tsx is registered PROGRAMMATICALLY, resolved from this file rather than from the working directory.
// The shebang used to be `node --import tsx`, which asks node to resolve the bare specifier `tsx`
// against the CWD — so the launcher worked from inside the package and died with
// "Cannot find package 'tsx'" from anywhere else. That is every `npm link` user, and every child the
// loop-service supervisor spawns, whose cwd is the run directory by design.
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { register } = await import(pathToFileURL(require.resolve("tsx/esm/api")).href);
register();
await import(pathToFileURL(join(here, "..", "src", "cli.ts")).href);
