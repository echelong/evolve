/**
 * Phase 5C — data-capture readiness guidance (PAPER ONLY).
 *
 * When the repository does not yet hold enough independent CLEAN real captures,
 * the correct Phase 5C result is INSUFFICIENT_INDEPENDENT_REAL_DATASETS. This
 * module prints the EXACT existing command(s) to capture more real market
 * history, plus the constraints that exist so nobody "fixes" the shortfall by
 * changing what gets captured.
 *
 * It does not alter capture behavior, does not automate real trading, and market
 * observation remains strictly read-only.
 */

import { MIN_CLEAN_TO_RUN } from "./constants.mjs";

/** The existing, unmodified capture commands. */
export const CAPTURE_COMMANDS = Object.freeze([
  "EVOLVE_MARKET_MODE=live npm run record:market -- --minutes 60 --interval 5000",
  "EVOLVE_MARKET_MODE=live npm run record:market -- --minutes 60 --interval 5000 --dir .evolve/history/<YYYY-MM-DD>/session-<label>",
]);

/** What the capture must (and must not) do to become a replication dataset. */
export const CAPTURE_RULES = Object.freeze([
  "Capture SEPARATE sessions at different times of day and, ideally, different market regimes.",
  "Each session must be independent: a new wall-clock window, not a slice of an existing capture.",
  "Walk-forward windows produced from ONE capture are NOT independent datasets and never count separately.",
  "Do not alter capture behavior, filters, endpoints, or intervals to improve how a strategy scores.",
  "Do not synthesize, replay, or relabel data to create extra datasets — synthetic/mixed data never counts as real.",
  "Market observation stays read-only: EVOLVE has no wallet, no signer, and no order path.",
  "Let each run finalize (status `complete`, fingerprint written) so it can be validated and fingerprinted.",
]);

/**
 * @param {object|null} registry a Phase 5C replication registry (optional)
 * @param {{
 *   selection?: { datasetIds?: string[], datasets?: object[] }|null,
 * }} [options] the CURRENT command's selection, when it has one. A wave-scoped
 *   command's shortfall is about the datasets ITS plan selected, not about the
 *   registry as a whole, so the count must never be borrowed from the registry.
 */
export function formatCaptureGuidance(registry = null, { selection = null } = {}) {
  const out = [];
  const selected = registry?.selectedIds ?? [];
  const counts = registry?.counts ?? {};
  const commandSelection = selection ? selection.datasetIds ?? selection.datasets ?? [] : null;
  out.push("-".repeat(72));
  out.push("PHASE 5C — INSUFFICIENT_INDEPENDENT_REAL_DATASETS");
  out.push("-".repeat(72));
  out.push(
    commandSelection
      ? `Clean independent real replication datasets SELECTED for this command: ${commandSelection.length} (need at least ${MIN_CLEAN_TO_RUN} to run; 3+ to describe multi-dataset replication).`
      : `Clean independent real replication datasets available: ${selected.length} (need at least ${MIN_CLEAN_TO_RUN} to run; 3+ to describe multi-dataset replication).`,
  );
  if (registry) {
    out.push(
      `Registry: ${registry.records?.length ?? 0} dataset(s) — DEVELOPMENT ${counts.DEVELOPMENT ?? 0}, REPLICATION ${counts.REPLICATION ?? 0}, CONTAMINATED ${counts.CONTAMINATED ?? 0}, UNKNOWN ${counts.UNKNOWN ?? 0}, INELIGIBLE ${counts.INELIGIBLE ?? 0}, NON_REAL ${counts.NON_REAL ?? 0}, INVALID ${counts.INVALID ?? 0}.`,
    );
  }
  out.push("");
  out.push("Capture additional REAL market history with the EXISTING commands:");
  for (const command of CAPTURE_COMMANDS) out.push(`  ${command}`);
  out.push("");
  out.push("Rules for a capture to count as an independent replication dataset:");
  for (const rule of CAPTURE_RULES) out.push(`  - ${rule}`);
  out.push("");
  out.push("Phase 5C implementation is COMPLETE; the replication run simply waits for more captures.");
  return out.join("\n");
}
