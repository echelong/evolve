#!/usr/bin/env node
/**
 * Phase 5C — dataset registry report (PAPER ONLY).
 *
 *   npm run datasets:research
 *   npm run datasets:research -- --json
 *
 * Prints, for every historical dataset: id, REAL/SYNTHETIC/MIXED/INVALID, path,
 * fingerprint, start/end, duration, snapshots, observations, unique mints, feed
 * source, capture interval, completion state, error counts, temporal overlap,
 * eligibility, and the DEVELOPMENT / REPLICATION / CONTAMINATED / UNKNOWN
 * classification.
 *
 * Read-only. No dataset is modified, no provider is called, and nothing trades.
 */

import path from "node:path";

import { parseArgs } from "./lib/args.mjs";
import { REPLICATION_DIR } from "./replication/constants.mjs";
import { loadFrozenCohorts } from "./replication/cohorts.mjs";
import { readFreeze } from "./replication/freeze.mjs";
import {
  buildReplicationRegistry,
  collectArenaDatasetUsage,
  datasetRow,
  discoverDatasetRecords,
  registryDigest,
} from "./replication/datasets.mjs";
import { formatCaptureGuidance } from "./replication/guidance.mjs";
import { formatDatasetRegistry } from "./replication/report.mjs";

const BOOLEAN_FLAGS = ["json", "help"];

function usage() {
  return [
    "EVOLVE Phase 5C dataset registry (read-only)",
    "",
    "  npm run datasets:research",
    "  npm run datasets:research -- --json",
    "",
    "Classifies every dataset under .evolve/history as REAL / SYNTHETIC / MIXED /",
    "INVALID, computes temporal overlap between REAL captures, and reports the",
    "Phase 5C eligibility decision and role for each. Synthetic evidence is never",
    "counted as real, and overlapping captures are never independent replications.",
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { booleanFlags: BOOLEAN_FLAGS });
  if (args.help === true) {
    console.log(usage());
    return;
  }

  const baseDir = path.resolve(process.env.EVOLVE_REPLICATION_DIR ?? REPLICATION_DIR);
  const freeze = await readFreeze({ root: baseDir });
  // READ-ONLY: this report never creates or refreshes a frozen cohort. The
  // frozen cohorts are immutable evidence, loaded (not written) here.
  const { manifests: cohorts } = await loadFrozenCohorts({ baseDir, keys: ["mock", "deepseek"] });
  const historyRoot = process.env.EVOLVE_HISTORY_ROOT ?? path.join(".evolve", "history");
  const arenasDir = process.env.EVOLVE_ARENAS_DIR ?? path.join(".evolve", "arenas");

  const [records, arenaUsage] = await Promise.all([
    discoverDatasetRecords(historyRoot),
    collectArenaDatasetUsage(arenasDir),
  ]);
  const registry = buildReplicationRegistry({ records, cohorts, arenaUsage });

  if (args.json === true) {
    console.log(
      JSON.stringify(
        {
          historyRoot,
          freezeDigest: freeze?.freezeDigest ?? null,
          registryDigest: registryDigest(registry),
          counts: registry.counts,
          selected: registry.selectedIds,
          duplicates: registry.duplicates,
          overlap: registry.overlap,
          recordsAvailable: registry.recordsAvailable,
          criteria: registry.criteria,
          criteriaText: registry.criteriaText,
          datasets: registry.records.map((record) => ({
            ...datasetRow(record, registry),
            invalidReasons: record.invalidReasons,
            leakageMatrix: registry.leakage[record.datasetId] ?? null,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(formatDatasetRegistry(registry));
  console.log("");
  console.log(`Registry digest: ${registryDigest(registry)}`);
  if (registry.selectedIds.length < 2) {
    console.log("");
    console.log(formatCaptureGuidance(registry));
  }
}

main().catch((error) => {
  console.error(`[datasets:research] failed: ${error?.message ?? error}`);
  process.exitCode = 1;
});
