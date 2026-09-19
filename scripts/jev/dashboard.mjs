/**
 * Jev shadow dashboard state (Phase 5D).
 *
 * Builds the compact, bounded `jevShadow` panel block consumed by
 * `scripts/lib/dashboard-state.mjs` / `/api/state`. Read-only: this module
 * never writes anything, and it only ever reads from `.evolve/jev/`.
 *
 * Exposed fields are counts, identity, and health only — never prompts, never
 * raw decision-packet state, never the API key. See
 * `scripts/jev/runtime.mjs#jevStateSummary` for the exact shape.
 *
 * PAPER ONLY.
 */

import { readdir } from "node:fs/promises";
import path from "node:path";

import { jevStateSummary, listJevProviderRuns } from "./runtime.mjs";
import { JEV_EXPERIMENTS_DIR, readJevCalibration, readJevExperiment } from "./experiment.mjs";

/**
 * Load the most recently started Jev experiment's shadow-state summary, or a
 * `available: false` placeholder when no Jev experiment has ever run in this
 * workspace (the expected state for most of Phase 5D: implementation never
 * makes a live or mock call on its own).
 */
export async function loadJevShadowState(root = path.join(process.cwd(), ".evolve")) {
  const experimentsDir = path.join(root, "jev", "experiments");
  let dirs = [];
  try {
    dirs = (await readdir(experimentsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("jexp-"))
      .map((entry) => entry.name)
      .sort();
  } catch {
    dirs = [];
  }

  if (dirs.length === 0) {
    return {
      available: false,
      mode: "shadow",
      paperOnly: true,
      note: "No Jev shadow experiment has been run in this workspace yet (npm run jev -- --provider mock-jev --fixture synthetic).",
    };
  }

  const experimentId = dirs[dirs.length - 1];
  const experimentRoot = path.join(experimentsDir, experimentId);
  const experiment = await readJevExperiment(experimentRoot);
  const runs = await listJevProviderRuns(experimentRoot);
  const calibration = await readJevCalibration(experimentRoot);

  const summary = jevStateSummary({
    identity: { provider: experiment?.provider ?? null, model: experiment?.model ?? null },
    mode: experiment?.mode ?? "shadow",
    experimentId,
    cacheEnabled: experiment?.cacheEnabled === true,
    runs,
    calibration,
  });

  return {
    available: true,
    ...summary,
    questionSetVersion: experiment?.questionSetVersion ?? null,
    decisionPacketVersion: experiment?.decisionPacketVersion ?? null,
    paperOnly: true,
  };
}

export const JEV_EXPERIMENTS_ROOT = JEV_EXPERIMENTS_DIR;
