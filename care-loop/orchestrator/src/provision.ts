// provision.ts — the DEFAULT worktree provisioner (a ports.Provisioner). A fresh `git worktree add`
// is missing the gitignored/generated artifacts a build needs; this symlinks them from the main
// checkout — fast (no 900M copy, no npm install) and correct for the vast majority of tasks.
//
// Modular by design: tasks that add/update packages, or cloud workers that need a fully-isolated
// environment, swap this for an `npm ci` + generate provisioner via WiringConfig.provision — nothing
// else changes.

import { existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { Provisioner } from "./ports.js";

/** care_fe's ignored/generated artifacts a worktree lacks (node_modules, the browserslist-generated
 *  source, and env). Order-independent; missing sources and already-present dests are skipped. */
export const CARE_FE_LINKS = ["node_modules", "src/supportedBrowsers.ts", ".env"];

export function symlinkProvisioner(links: string[] = CARE_FE_LINKS): Provisioner {
  return ({ worktree, mainRepoPath }) => {
    const linked: string[] = [];
    for (const rel of links) {
      const src = join(mainRepoPath, rel);
      const dest = join(worktree, rel);
      if (!existsSync(src)) continue; // main checkout doesn't have it — nothing to link
      if (existsSync(dest)) continue; // worktree already has it (tracked file or prior symlink)
      try {
        symlinkSync(src, dest); // posix symlinks don't need a type; works for dirs + files
        linked.push(rel);
      } catch (e) {
        return { exit: 1, summary: `symlink ${rel} failed: ${(e as Error).message}` };
      }
    }
    return { exit: 0, summary: `provisioned: ${linked.join(", ") || "nothing (already present)"}` };
  };
}
