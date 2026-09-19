#!/usr/bin/env node
/**
 * Phase 5H.0 — OFFLINE deterministic classifier-derived features CLI (PAPER ONLY, DESCRIPTIVE).
 *
 *   npm run intelligence:classify-features -- --cohort <clcohort-id>
 *   npm run intelligence:classify-features -- --replay --feature <clfeat-id>
 *   npm run intelligence:classify-features -- --stats  --feature <clfeat-id>
 *   npm run intelligence:classify-features -- --definition
 *
 * OFFLINE ONLY: this CLI makes ZERO network calls. It never calls classifier.dev,
 * Agent-Reach, Jev, DeepSeek or the Arena, never reclassifies and never captures.
 * It has NO provider option, NO network option, NO routing option and NO
 * classification option: the only inputs are ONE explicit frozen cohort id or
 * ONE explicit stored feature id.
 *
 * The derived features are DESCRIPTIVE ONLY — never alpha, never signal
 * strength, never sentiment, never trading direction, never project quality,
 * never legitimacy, never fraud probability, never profitability, never
 * expected return, never market health, never buy/sell probability.
 */

import path from "node:path";

import { parseArgs } from "./lib/args.mjs";
import { INTELLIGENCE_DIR } from "./intelligence/config.mjs";
import { CLASSIFIER_DIR, buildClassifierFeature, classifierFeatureStats, replayClassifierFeature } from "./intelligence/classifier-features.mjs";
import {
  FEATURE_ALIASES,
  FEATURE_DEFINITION,
  FEATURE_DEFINITION_DIGEST,
  FEATURE_DEFINITION_VERSION,
  FEATURE_NAMES,
  FEATURE_PHASE,
} from "./intelligence/classifier-feature-definition.mjs";

const BOOLEAN_FLAGS = ["json", "replay", "stats", "definition", "help"];
const VALUE_FLAGS = ["cohort", "feature", "out", "captures"];
const KNOWN_FLAGS = new Set([...BOOLEAN_FLAGS, ...VALUE_FLAGS]);

/** Options Phase 5H.0 deliberately does NOT have. Supplying one is a hard error. */
const FORBIDDEN_FLAGS = Object.freeze([
  "provider",
  "network",
  "routing",
  "route",
  "classify",
  "classification",
  "classifier",
  "model",
  "reach",
  "agent-reach",
  "jev",
  "deepseek",
  "arena",
  "trading",
  "trade",
  "capture",
  "experiments",
  "experiment",
  "latest",
  "all",
  "signal",
  "alpha",
  "sentiment",
]);

function usage() {
  return [
    `EVOLVE Phase ${FEATURE_PHASE} deterministic classifier-derived features (PAPER ONLY, DESCRIPTIVE)`,
    "",
    "Build + freeze ONE feature artifact from ONE explicit frozen cohort:",
    "  npm run intelligence:classify-features -- --cohort <clcohort-id>",
    "Offline replay / stats of a stored feature artifact:",
    "  npm run intelligence:classify-features -- --replay --feature <clfeat-id>",
    "  npm run intelligence:classify-features -- --stats  --feature <clfeat-id>",
    "Print the frozen feature definition:",
    "  npm run intelligence:classify-features -- --definition",
    "",
    "Options:",
    `  --out <dir>        classifier root (default ${CLASSIFIER_DIR})`,
    `  --captures <dir>   capture root (default ${INTELLIGENCE_DIR})`,
    "  --json             machine-readable output",
    "  --help             this help",
    "",
    "There is NO latest: every action needs an EXPLICIT cohort or feature id.",
    "OFFLINE: zero network calls, no classifier.dev, no Agent-Reach, no Jev, no DeepSeek, no Arena, no trading.",
    "Routing stays false: Jev false · DeepSeek false · Arena false · Trading false.",
    "The derived features are DESCRIPTIVE ONLY and imply no quality, legitimacy, profitability or direction.",
  ].join("\n");
}

function fail(message) {
  console.error(`[classify-features] ${message}`);
  process.exitCode = 1;
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function hex(ok) {
  return ok ? "✓" : "✗";
}

function printDefinition() {
  console.log(`[classify-features] definition ${FEATURE_DEFINITION.definitionVersion}`);
  console.log(`[classify-features]   phase:        ${FEATURE_DEFINITION.phase}`);
  console.log(`[classify-features]   definition digest: ${FEATURE_DEFINITION_DIGEST}`);
  console.log(
    `[classify-features]   classifier:   ${FEATURE_DEFINITION.classifierId} v${FEATURE_DEFINITION.classifierVersion} · ` +
      `${FEATURE_DEFINITION.inputProjectionVersion}`,
  );
  console.log(`[classify-features]   classifier definition digest: ${FEATURE_DEFINITION.classifierDefinitionDigest}`);
  console.log(`[classify-features]   taxonomy labels: ${FEATURE_DEFINITION.taxonomyLabels.length}`);
  console.log(`[classify-features]   entropyNormalizationK: ${FEATURE_DEFINITION.entropyNormalizationK} · log base: ${FEATURE_DEFINITION.entropyLogBase}`);
  console.log(
    `[classify-features]   confidenceLow: ${FEATURE_DEFINITION.confidenceLow.comparator} ${FEATURE_DEFINITION.confidenceLow.threshold} · ` +
      `confidenceHigh: ${FEATURE_DEFINITION.confidenceHigh.comparator} ${FEATURE_DEFINITION.confidenceHigh.threshold} · ` +
      `marginAmbiguous: ${FEATURE_DEFINITION.marginAmbiguous.comparator} ${FEATURE_DEFINITION.marginAmbiguous.threshold}`,
  );
  console.log(`[classify-features]   rounding: ${FEATURE_DEFINITION.rounding} · quantile: ${FEATURE_DEFINITION.quantileMethod}`);
  console.log(`[classify-features]   value domain: ${FEATURE_DEFINITION.featureValueDomain} · groups: ${Object.keys(FEATURE_DEFINITION.groups).length}`);
  console.log(`[classify-features]   evidence class map: ${JSON.stringify(FEATURE_DEFINITION.evidenceClassMap)}`);
  console.log(`[classify-features]   aliases (DISPLAY ONLY, not additional features): ${JSON.stringify(FEATURE_ALIASES)}`);
  console.log(`[classify-features]   ${FEATURE_NAMES.length} canonical features, in order:`);
  FEATURE_NAMES.forEach((name, index) => console.log(`[classify-features]     ${String(index + 1).padStart(2)}. ${name}`));
  console.log("[classify-features] descriptive only, development only: no ground truth, no verdict, no profitability inference.");
}

function printFeatureSummary(feature) {
  console.log(`[classify-features] feature ${feature.featureId}`);
  console.log(`[classify-features]   definition:    ${feature.featureDefinitionVersion} (${feature.featureDefinitionDigest})`);
  console.log(`[classify-features]   evidenceClass: ${feature.sourceEvidenceClass} → ${feature.evidenceClass}`);
  console.log(`[classify-features]   cohort:        ${feature.cohortId}`);
  console.log(`[classify-features]   experiments:   ${feature.experimentCount} · captures ${feature.captureCount}`);
  console.log(
    `[classify-features]   records:       ${feature.recordCount} · classified ${feature.classifiedCount} · skipped ${feature.skippedEmptyCount}`,
  );
  console.log(
    `[classify-features]   score vectors: complete ${feature.scoreVectorCompleteCount} · incomplete ${feature.scoreVectorIncompleteCount}`,
  );
  console.log(`[classify-features]   labelCounts:   ${JSON.stringify(feature.counts.labelCounts)}`);
  console.log(`[classify-features]   labelFractions:${JSON.stringify(Object.fromEntries(FEATURE_NAMES.filter((n) => n.startsWith("label_fraction_")).map((n) => [n, feature.features[n]])))}`);
  console.log(`[classify-features]   observed labels: ${feature.features.observed_label_count} · entropy ${feature.features.label_entropy_normalized}`);
  console.log(`[classify-features]   largest label:  ${feature.counts.largestLabel} (${feature.counts.largestLabelCount} · ${feature.features.largest_label_fraction})`);
  console.log(
    `[classify-features]   confidence:     mean ${feature.features.confidence_mean} · median ${feature.features.confidence_median} · ` +
      `low ${feature.features.confidence_low_fraction} · high ${feature.features.confidence_high_fraction}`,
  );
  console.log(
    `[classify-features]   score margin:   mean ${feature.features.score_margin_mean} · median ${feature.features.score_margin_median} · ` +
      `ambiguous ${feature.features.score_margin_ambiguous_fraction}`,
  );
  console.log(
    `[classify-features]   aliases:        noise ${feature.features[FEATURE_ALIASES.noise_fraction]} · ` +
      `promotion ${feature.features[FEATURE_ALIASES.promotion_fraction]} (display aliases only)`,
  );
  console.log(`[classify-features]   evidenceAsOf:   ${feature.timeline.evidenceAsOf} · createdAt ${feature.createdAt}`);
  console.log(`[classify-features]   routing:        jev ${feature.routing.jevRoutingActive} · deepseek ${feature.routing.deepseekRoutingActive} · arena ${feature.routing.arenaRoutingActive} · trading ${feature.routing.tradingRoutingActive}`);
  console.log(`[classify-features]   featureDigest:  ${feature.featureDigest}`);
  console.log("[classify-features] descriptive only, development only: no ground truth, no verdict, no profitability inference.");
}

/* ============================================================================
 * Actions
 * ==========================================================================*/

async function buildAction({ args, classifierRoot, captureRoot }) {
  if (typeof args.cohort !== "string" || args.cohort.trim().length === 0) {
    fail("--cohort <clcohort-id> is required (Phase 5H.0 never searches for the 'latest' cohort)");
    return;
  }
  const { feature, dir } = await buildClassifierFeature({
    classifierRoot,
    captureRoot,
    cohortId: args.cohort,
    save: true,
  });
  if (args.json === true) {
    printJson({ action: "build", dir, feature });
    return;
  }
  printFeatureSummary(feature);
  console.log(`[classify-features] stored: ${dir}`);
  console.log("[classify-features] frozen, immutable and never overwritten.");
}

async function replayAction({ args, classifierRoot, captureRoot }) {
  if (typeof args.feature !== "string" || args.feature.trim().length === 0) {
    fail("--replay requires --feature <clfeat-id> (Phase 5H.0 never searches for the 'latest' feature)");
    return;
  }
  const report = await replayClassifierFeature({ classifierRoot, captureRoot, featureId: args.feature });
  if (!report.ok) process.exitCode = 1;
  if (args.json === true) {
    printJson({ action: "replay", ...report });
    return;
  }
  console.log(`[classify-features] replay ${report.featureId} (offline, zero network, no reclassification, no write)`);
  for (const [name, ok] of Object.entries(report.checks)) console.log(`[classify-features]   ${hex(ok)} ${name}`);
  if (report.featureDigest) console.log(`[classify-features]   featureDigest: ${report.featureDigest}`);
  console.log(report.ok ? "[classify-features] integrity OK." : `[classify-features] integrity FAILED: ${report.problems.join(" | ")}`);
}

async function statsAction({ args, classifierRoot }) {
  if (typeof args.feature !== "string" || args.feature.trim().length === 0) {
    fail("--stats requires --feature <clfeat-id> (Phase 5H.0 never searches for the 'latest' feature)");
    return;
  }
  const stats = await classifierFeatureStats({ classifierRoot, featureId: args.feature });
  if (args.json === true) {
    printJson({ action: "stats", ...stats });
    return;
  }
  console.log(`[classify-features] stats ${stats.featureId} (offline, zero network, no capture root needed)`);
  console.log(`[classify-features]   definition:    ${stats.featureDefinitionVersion} (matches pin: ${stats.featureDefinitionDigestOk})`);
  console.log(`[classify-features]   evidenceClass: ${stats.sourceEvidenceClass} → ${stats.evidenceClass}`);
  console.log(`[classify-features]   cohort:        ${stats.cohortId} (digest ok: ${stats.cohortDigestOk}, verified: ${stats.cohortOk})`);
  console.log(`[classify-features]   experiments:   ${stats.experimentCount} · captures ${stats.captureCount}`);
  console.log(`[classify-features]   records:       ${stats.recordCount} · classified ${stats.classifiedCount} · skipped ${stats.skippedCount}`);
  console.log(`[classify-features]   record digests: distinct ${stats.distinctRecordDigestCount} · duplicate ${stats.duplicateRecordDigestCount}`);
  console.log(`[classify-features]   score vectors: complete ${stats.scoreVectorCompleteCount} · incomplete ${stats.scoreVectorIncompleteCount}`);
  console.log(`[classify-features]   null features: ${stats.nullFeatureCount}`);
  console.log(`[classify-features]   labelCounts:   ${JSON.stringify(stats.labelCounts)}`);
  console.log(`[classify-features]   labelFractions:${JSON.stringify(stats.labelFractions)}`);
  console.log(`[classify-features]   observed labels: ${stats.observedLabelCount} · entropy ${stats.labelEntropyNormalized}`);
  console.log(`[classify-features]   largest label:  ${stats.largestLabel} (${stats.largestLabelCount} · ${stats.largestLabelFraction})`);
  console.log(`[classify-features]   confidence:     mean ${stats.confidenceMean} · median ${stats.confidenceMedian} · low ${stats.confidenceLowFraction} · high ${stats.confidenceHighFraction}`);
  console.log(`[classify-features]   score margin:   mean ${stats.scoreMarginMean} · median ${stats.scoreMarginMedian} · ambiguous ${stats.scoreMarginAmbiguousFraction}`);
  console.log(`[classify-features]   aliases:        noise ${stats.noiseFraction} · promotion ${stats.promotionFraction} (display aliases only)`);
  console.log(`[classify-features]   evidenceAsOf:   ${stats.evidenceAsOf} · createdAt ${stats.createdAt}`);
  console.log(`[classify-features]   routing:        jev ${stats.jevRoutingActive} · deepseek ${stats.deepseekRoutingActive} · arena ${stats.arenaRoutingActive} · trading ${stats.tradingRoutingActive}`);
  console.log(`[classify-features]   featureDigest:  ${stats.featureDigest} (matches: ${stats.featureDigestOk}) · audit ok: ${stats.auditOk}`);
  console.log(`[classify-features]   networkCalls:   ${stats.networkCalls}`);
  console.log("[classify-features] no verdict, no ranking, no gate, no predictive claim.");
}

/* ============================================================================
 * Dispatch
 * ==========================================================================*/

async function main() {
  const args = parseArgs(process.argv.slice(2), { booleanFlags: BOOLEAN_FLAGS, valueFlags: VALUE_FLAGS });
  if (args.help === true) {
    console.log(usage());
    return;
  }

  for (const key of Object.keys(args)) {
    if (key === "_") continue;
    if (FORBIDDEN_FLAGS.includes(key)) {
      fail(`--${key} does not exist in Phase 5H.0: there is NO provider, network, routing or classification option`);
      return;
    }
    if (!KNOWN_FLAGS.has(key)) {
      fail(`unknown option --${key} (Phase 5H.0 supports only ${[...KNOWN_FLAGS].sort().join(", ")})`);
      return;
    }
  }
  if (Array.isArray(args._) && args._.length > 0) {
    fail(`unexpected positional argument '${args._[0]}' — pass --cohort <id> or --feature <id>`);
    return;
  }

  const actions = [
    args.replay === true ? "replay" : null,
    args.stats === true ? "stats" : null,
    args.definition === true ? "definition" : null,
  ].filter(Boolean);

  if (args.replay === true && args.stats === true) {
    fail("--replay and --stats are mutually exclusive");
    return;
  }
  if (actions.length > 1) {
    fail(`exactly one action is allowed (got ${actions.join(", ")})`);
    return;
  }
  if (args.definition === true && (typeof args.cohort === "string" || typeof args.feature === "string")) {
    fail("--definition takes neither --cohort nor --feature");
    return;
  }
  if (actions.length > 0 && typeof args.cohort === "string") {
    fail(`--${actions[0]} takes --feature, not --cohort: there is no implicit build`);
    return;
  }
  if ((args.replay === true || args.stats === true) && typeof args.feature !== "string") {
    fail(`--${args.replay === true ? "replay" : "stats"} requires --feature <clfeat-id>`);
    return;
  }
  if (actions.length === 0 && typeof args.cohort !== "string") {
    fail("nothing to do: pass --cohort <clcohort-id>, or --replay/--stats with --feature, or --definition");
    console.log(usage());
    return;
  }
  if (actions.length === 0 && typeof args.feature === "string") {
    fail("--feature requires --replay or --stats");
    return;
  }
  if (actions.length === 0 && typeof args.cohort === "string" && typeof args.feature === "string") {
    fail("--cohort and --feature are mutually exclusive");
    return;
  }

  const classifierRoot = path.resolve(String(args.out ?? CLASSIFIER_DIR));
  const captureRoot = path.resolve(String(args.captures ?? process.env.EVOLVE_INTELLIGENCE_DIR ?? INTELLIGENCE_DIR));

  try {
    if (actions[0] === "definition" || args.definition === true) {
      if (args.json === true) {
        printJson({ action: "definition", definitionVersion: FEATURE_DEFINITION_VERSION, definitionDigest: FEATURE_DEFINITION_DIGEST, definition: FEATURE_DEFINITION });
        return;
      }
      printDefinition();
      return;
    }
    if (args.replay === true) return await replayAction({ args, classifierRoot, captureRoot });
    if (args.stats === true) return await statsAction({ args, classifierRoot });
    return await buildAction({ args, classifierRoot, captureRoot });
  } catch (error) {
    fail(String(error?.message ?? error));
  }
}

main().catch((error) => {
  console.error(`[classify-features] failed: ${error?.message ?? error}`);
  process.exitCode = 1;
});
