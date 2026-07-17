// models-config.ts — load the loopd model configuration from models.json.
//
// Separates model selection from methodology: skill/guide files own WHAT the role does; this file
// owns WHICH engine runs it per deployment. A `models.local.json` (gitignored) can point at a local
// opencode-configured provider — no code change needed to swap to local models.
//
// Resolution order (per role): roles.<role> → tiers.<tier> → built-in fallback.
// Thread the resulting SkillModels into the skill factories (opencodeReviewer, opencodePlanner, …)
// via defaultSeams/defaultPlanSeams; the factories already accept SkillModels.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SkillModels } from "./skills-opencode.js";

/** Shape of care-loop/models.json (and any override file). */
export interface ModelsConfig {
  provider?: string;
  tiers?: {
    judgment?: string; // default engine for all judgment roles (reviewer, planner, triager)
    maker?: string; // default engine for the implementer
  };
  roles?: {
    reviewer?: string;
    planner?: string;
    plannerRecon?: string; // interview/recon phase; defaults to the maker tier (fast)
    triager?: string;
    implementer?: string;
    testGrader?: string; // 4b judgment tier
    uxValidator?: string; // 4c judgment tier
    ciFixer?: string; // CI-fix track; defaults to the maker tier
  };
}

const DEFAULT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../models.json",
);

/**
 * Load a models config file and resolve it to a SkillModels map suitable for passing to the
 * skill factories. Silently falls back to built-in defaults on any read/parse error so a
 * missing file doesn't crash the orchestrator — the factories' own defaults kick in.
 */
export function loadModels(configPath?: string): SkillModels {
  const filePath = configPath ?? DEFAULT_PATH;
  let config: ModelsConfig = {};
  // Absent file → silent fallback to built-in defaults (a normal, supported deployment). But a file
  // that IS present and fails to parse is a config typo the operator wants to know about — falling
  // back to (paid) defaults silently is the opposite of what someone reaching for a local model wants.
  if (existsSync(filePath)) {
    try {
      config = JSON.parse(readFileSync(filePath, "utf8")) as ModelsConfig;
    } catch (e) {
      console.warn(
        `[models-config] warning: ${filePath} exists but could not be parsed (${(e as Error).message}) — falling back to built-in model defaults.`,
      );
    }
  }

  const judgment = config.tiers?.judgment;
  const maker = config.tiers?.maker;

  return {
    provider: config.provider,
    reviewer: config.roles?.reviewer ?? judgment,
    planner: config.roles?.planner ?? judgment,
    // Recon is navigation, not judgment → defaults to the fast MAKER tier (not judgment), the planner
    // speed lever. Explicit roles.plannerRecon wins; else maker; else the factory's built-in fallback.
    plannerRecon: config.roles?.plannerRecon ?? maker,
    triager: config.roles?.triager ?? judgment,
    implementer: config.roles?.implementer ?? maker,
    testGrader: config.roles?.testGrader ?? judgment,
    uxValidator: config.roles?.uxValidator ?? judgment,
    ciFixer: config.roles?.ciFixer ?? maker,
  };
}
