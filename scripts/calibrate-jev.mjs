#!/usr/bin/env node
/**
 * EVOLVE Jev calibration CLI (Phase 5D).
 *
 *   npm run calibrate:jev -- --experiment <jev-experiment-id> --arena <arena-id>
 *   npm run calibrate:jev -- --experiment <jev-experiment-id>   (join against
 *                                                                 already-recorded outcomes only)
 *
 * This tool NEVER calls Jev. It only:
 *
 *   1. reads a Jev experiment's previously PERSISTED, TIMESTAMPED decisions
 *      (predictions made before any outcome existed);
 *   2. optionally reads an EXISTING Arena artifact's `candidates.json` (a real,
 *      unchanged deterministic-gate-evaluation result — never re-evaluated,
 *      never re-run) and joins any matching candidate's gate result in as that
 *      decision's outcome, by digest only;
 *   3. runs the pure, offline `runJevCalibration` and persists `calibration.json`.
 *
 * It never mutates the Arena artifact it reads from, never re-derives a gate
 * result, and never invents an outcome for a decision it cannot match.
 *
 * PAPER ONLY.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseArgs } from "./lib/args.mjs";
import {
  jevExperimentRootFor,
  buildJevOutcomeRecord,
  listJevDecisions,
  listJevOutcomes,
  readJevExperiment,
  writeJevCalibration,
  writeJevOutcome,
} from "./jev/experiment.mjs";
import { runJevCalibration } from "./jev/calibration.mjs";

const BOOLEAN_FLAGS = ["json", "help"];
const VALUE_FLAGS = ["experiment", "arena"];

function usage() {
  return [
    "EVOLVE Jev calibration CLI (PAPER ONLY, SHADOW ONLY)",
    "",
    "  npm run calibrate:jev -- --experiment <id> [--arena <arena-id>]",
    "",
    "Joins previously TIMESTAMPED Jev decisions with LATER deterministic Arena",
    "gate outcomes and reports calibration (Brier score, reliability bins,",
    "multi-label primaryRisk agreement, threshold-coverage analysis). Jev is",
    "NEVER called again. No threshold produced here is promoted operationally.",
  ].join("\n");
}

/** Read an Arena's `candidates.json` (read-only) and index it by digest. */
async function readArenaCandidateIndex(arenaId) {
  const file = path.join(".evolve", "arenas", String(arenaId), "candidates.json");
  let list;
  try {
    list = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return new Map();
  }
  const index = new Map();
  for (const candidate of Array.isArray(list) ? list : []) {
    if (typeof candidate?.digest !== "string") continue;
    const gates = Array.isArray(candidate.gates) ? candidate.gates : [];
    index.set(candidate.digest, {
      status: candidate.status ?? null,
      gates,
      passed: gates.filter((gate) => gate?.pass === true).length,
      failed: gates.filter((gate) => gate?.pass === false).length,
      total: gates.length,
    });
  }
  return index;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { booleanFlags: BOOLEAN_FLAGS, valueFlags: VALUE_FLAGS });
  if (args.help === true) {
    console.log(usage());
    return;
  }

  const experimentId = args.experiment ? String(args.experiment) : null;
  if (!experimentId) {
    console.error("[calibrate:jev] --experiment <id> is required");
    process.exitCode = 2;
    return;
  }

  const root = jevExperimentRootFor(undefined, experimentId);
  const experiment = await readJevExperiment(root);
  if (!experiment) {
    console.error(`[calibrate:jev] no Jev experiment found at ${root}`);
    process.exitCode = 2;
    return;
  }

  const decisions = await listJevDecisions(root);
  let outcomes = await listJevOutcomes(root);
  const existingOutcomeIds = new Set(outcomes.map((outcome) => outcome.decisionId));

  let joinedFromArena = 0;
  let unmatched = 0;
  if (args.arena) {
    const arenaIndex = await readArenaCandidateIndex(String(args.arena));
    for (const decision of decisions) {
      if (existingOutcomeIds.has(decision.decisionId)) continue;
      if (decision.packetKind !== "JEV_CANDIDATE_DECISION_PACKET") continue;
      const gateResult = arenaIndex.get(decision.subjectDigest);
      if (!gateResult) {
        unmatched += 1;
        continue;
      }
      const outcome = buildJevOutcomeRecord({
        decisionId: decision.decisionId,
        arenaId: String(args.arena),
        gateResult,
        recordedAt: new Date().toISOString(),
        note: "Joined from an existing, unchanged Arena candidates.json by digest. The Arena artifact was never re-evaluated.",
      });
      await writeJevOutcome(root, outcome);
      outcomes.push(outcome);
      joinedFromArena += 1;
    }
  }

  const calibration = runJevCalibration({ decisions, outcomes });
  const persisted = {
    ...calibration,
    experimentId,
    arenaId: args.arena ? String(args.arena) : null,
    joinedFromArena,
    unmatchedDecisions: unmatched,
    generatedAt: new Date().toISOString(),
  };
  await writeJevCalibration(root, persisted);

  if (args.json === true) {
    console.log(JSON.stringify(persisted, null, 2));
  } else {
    console.log("EVOLVE Jev calibration (PAPER ONLY, OFFLINE ANALYSIS ONLY)");
    console.log(`  experiment                 ${experimentId}`);
    console.log(`  decisions                  ${decisions.length}`);
    console.log(`  outcomes                   ${outcomes.length} (joined from Arena: ${joinedFromArena}, unmatched: ${unmatched})`);
    console.log(`  predictions calibrated     ${calibration.predictionCount}`);
    console.log(
      `  gateFailureRisk Brier      ${calibration.gateFailureRisk.brierScore ?? "n/a"} (n=${calibration.gateFailureRisk.predictionCount})`,
    );
    console.log(
      `  generalizationConf. Brier  ${calibration.generalizationConfidence.brierScore ?? "n/a"} (n=${calibration.generalizationConfidence.predictionCount})`,
    );
    console.log(
      `  primaryRisk agreement      ${calibration.primaryRisk.agreementRateWhenGatesFailed ?? "n/a"} (n=${calibration.primaryRisk.predictionCount})`,
    );
    console.log(`  regime shadow agreement    ${calibration.regimeShadow.agreementRate ?? "n/a"} (n=${calibration.regimeShadow.predictionCount})`);
    console.log("  note                       no threshold produced here is promoted to an operational gate");
  }
}

main().catch((error) => {
  console.error("[calibrate:jev] calibration failed:", error?.message ?? error);
  process.exitCode = 1;
});
