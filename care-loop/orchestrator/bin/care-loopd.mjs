#!/usr/bin/env -S node --import tsx
// care-loopd launcher — runs the TypeScript CLI directly via tsx so no build step is needed.
// Installed on PATH through package.json "bin" (use `npm link` in this dir to expose it globally).
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
await import(join(here, "..", "src", "cli.ts"));
