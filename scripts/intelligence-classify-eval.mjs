#!/usr/bin/env node
/**
 * Phase 5G.1 — OFFLINE classifier taxonomy evaluation CLI (PAPER ONLY, DESCRIPTIVE).
 *
 *   npm run intelligence:classify-eval -- --freeze-cohort --experiments <id1,id2,...>
 *   npm run intelligence:classify-eval -- --cohort <cohort-id>
 *   npm run intelligence:classify-eval -- --cohort <cohort-id> --audit
 *   npm run intelligence:classify-eval -- --cohort <cohort-id> --audit-low-confidence [N]
 *   npm run intelligence:classify-eval -- --replay --evaluation <cleval-id>
 *   npm run intelligence:classify-eval -- --stats  --evaluation <cleval-id>
 *
 * OFFLINE ONLY: this CLI makes ZERO network calls. It never calls classifier.dev,
 * Agent-Reach, Jev, DeepSeek or the Arena. It reads frozen classifier experiments
 * and their frozen source captures only, and every action is descriptive.
 *
 * The audit views are EPHEMERAL: they print bounded rows to the terminal and
 * write NOTHING.
 */

import path from "node:path";

import { parseArgs } from "./lib/args.mjs";
import { INTELLIGENCE_DIR } from "./intelligence/config.mjs";
import { CLASSIFIER_DIR } from "./intelligence/classifier-experiment.mjs";
import {
  CLASSIFIER_EVALUATION_PHASE,
  buildAuditSample,
  buildLowConfidenceAudit,
  evaluationStats,
  freezeCohort,
  replayEvaluation,
  runEvaluation,
} from "./intelligence/classifier-evaluation.mjs";

const BOOLEAN_FLAGS = ["json", "stats", "replay", "audit", "freeze-cohort", "help", "allow-infrastructure"];
// NOTE: `audit-low-confidence` is deliberately NOT declared: when present alone it
// parses to `true`, and `--audit-low-confidence 30` binds the optional value.
const VALUE_FLAGS = ["cohort", "evaluation", "experiments", "out", "captures"];

function usage() {
  return [
    `EVOLVE Phase ${CLASSIFIER_EVALUATION_PHASE} offline classifier taxonomy evaluation (PAPER ONLY, DESCRIPTIVE)`,
    "",
    "Freeze an explicit DEVELOPMENT cohort from frozen classifier experiments:",
    "  npm run intelligence:classify-eval -- --freeze-cohort --experiments <clexp-id,clexp-id,...>",
    "Create the offline evaluation artifact for a cohort:",
    "  npm run intelligence:classify-eval -- --cohort <cohort-id>",
    "Inspect (EPHEMERAL, terminal only, no artifact):",
    "  npm run intelligence:classify-eval -- --cohort <cohort-id> --audit",
    "  npm run intelligence:classify-eval -- --cohort <cohort-id> --audit-low-confidence [N]",
    "Offline replay / stats of a stored evaluation:",
    "  npm run intelligence:classify-eval -- --replay --evaluation <cleval-id>",
    "  npm run intelligence:classify-eval -- --stats  --evaluation <cleval-id>",
    "",
    "Options:",
    `  --out <dir>        classifier root (default ${CLASSIFIER_DIR})`,
    `  --captures <dir>   capture root (default ${INTELLIGENCE_DIR})`,
    "  --allow-infrastructure  permit the canonical one-record infrastructure experiment (separate report only)",
    "  --json             machine-readable output",
    "",
    "OFFLINE: zero network calls. No classifier.dev, no Agent-Reach, no Jev, no DeepSeek, no Arena.",
    "The taxonomy is DESCRIPTIVE and UNVERIFIED; there is no ground truth and no automated verdict.",
  ].join("\n");
}

function fail(message) {
  console.error(`[classify-eval] ${message}`);
  process.exitCode = 1;
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function hex(ok) {
  return ok ? "✓" : "✗";
}

/* ============================================================================
 * Actions
 * ==========================================================================*/

async function freezeAction({ args, classifierRoot, captureRoot }) {
  if (typeof args.experiments !== "string" || args.experiments.trim().length === 0) {
    fail("--freeze-cohort requires --experiments <id1,id2,...> (the exact ids; Phase 5G.1 never searches for 'latest')");
    return;
  }
  const { cohort, file } = await freezeCohort({
    classifierRoot,
    captureRoot,
    experimentIds: args.experiments,
    allowInfrastructure: args["allow-infrastructure"] === true,
  });
  if (args.json === true) {
    printJson({ action: "freeze-cohort", cohort, file });
    return;
  }
  console.log(`[classify-eval] froze cohort ${cohort.cohortId}`);
  console.log(`[classify-eval]   evidenceClass: ${cohort.evidenceClass}`);
  console.log(`[classify-eval]   experiments:   ${cohort.experimentIds.length} · captures ${cohort.sourceCaptureIds.length}`);
  console.log(`[classify-eval]   cohortDigest:  ${cohort.cohortDigest}`);
  console.log(`[classify-eval]   stored:        ${file}`);
  console.log("[classify-eval] DEVELOPMENT evidence only. Frozen and immutable; never overwritten.");
}

function printEvaluationSummary(evaluation) {
  const metrics = evaluation.metrics ?? {};
  console.log(`[classify-eval] evaluation ${evaluation.evaluationId}`);
  console.log(`[classify-eval]   cohort:        ${evaluation.cohortId}`);
  console.log(`[classify-eval]   evidenceClass: ${evaluation.evidenceClass}`);
  console.log(`[classify-eval]   classifier:    ${evaluation.classifierId} v${evaluation.classifierVersion} · ${evaluation.inputProjectionVersion}`);
  console.log(`[classify-eval]   experiments:   ${evaluation.experimentCount} · captures ${evaluation.captureCount} · records ${evaluation.recordCount}`);
  console.log(`[classify-eval]   channels:      ${JSON.stringify(evaluation.channelCounts)}`);
  console.log(`[classify-eval]   labelCounts:   ${JSON.stringify(Object.fromEntries((metrics.labelDistribution?.labels ?? []).map((e) => [e.label, e.count])))}`);
  console.log(`[classify-eval]   labelDiversity:${metrics.labelDistribution?.labelDiversity}`);
  console.log(`[classify-eval]   mean/median confidence: ${metrics.confidence?.mean} / ${metrics.confidence?.median}`);
  console.log(`[classify-eval]   ambiguity fractions:    ${JSON.stringify(Object.fromEntries(Object.entries(metrics.scoreMargin?.bands ?? {}).map(([id, band]) => [id, band.fraction])))}`);
  console.log(`[classify-eval]   noise fraction:         ${metrics.noise?.fraction} · promotion fraction: ${metrics.promotion?.fraction}`);
  console.log(`[classify-eval]   largest label:          ${metrics.concentration?.largestLabel} (${metrics.concentration?.largestLabelFraction})`);
  console.log(`[classify-eval]   cohortDigest:  ${evaluation.cohortDigest}`);
  console.log(`[classify-eval]   evaluationDigest: ${evaluation.evaluationDigest}`);
  console.log("[classify-eval] descriptive only: no ground truth, no verdict, no profitability inference.");
}

async function evaluateAction({ args, classifierRoot, captureRoot }) {
  if (typeof args.cohort !== "string") {
    fail("--cohort <cohort-id> is required (freeze one first with --freeze-cohort)");
    return;
  }
  const { evaluation, dir } = await runEvaluation({ classifierRoot, captureRoot, cohortId: args.cohort, save: true });
  if (args.json === true) {
    printJson({ action: "evaluate", dir, evaluation });
    return;
  }
  printEvaluationSummary(evaluation);
  console.log(`[classify-eval] stored: ${dir}`);
}

async function auditAction({ args, classifierRoot, captureRoot }) {
  if (typeof args.cohort !== "string") {
    fail("--audit requires --cohort <cohort-id>");
    return;
  }
  const sample = await buildAuditSample({ classifierRoot, captureRoot, cohortId: args.cohort });
  if (args.json === true) {
    printJson({ action: "audit", ...sample });
    return;
  }
  console.log(`[classify-eval] audit sample ${sample.cohortId} (EPHEMERAL — nothing is persisted)`);
  console.log(`[classify-eval]   evidenceClass: ${sample.evidenceClass} · up to ${sample.perLabel} observations per observed label`);
  if (sample.rows.length === 0) console.log("[classify-eval]   (no observations)");
  for (const row of sample.rows) {
    console.log(`[classify-eval]   ${row.recordDigest}  ${String(row.channel).padEnd(7)} ${row.label}  conf=${row.confidence}`);
    console.log(`[classify-eval]       top: ${row.topScores.map((s) => `${s.label}=${s.score}`).join(", ")}`);
    console.log(`[classify-eval]       text: ${row.excerpt ?? "(empty)"}`);
  }
  console.log("[classify-eval] no URL, no author, no query, no credential is shown. No artifact was written.");
}

async function lowConfidenceAction({ args, classifierRoot, captureRoot }) {
  if (typeof args.cohort !== "string") {
    fail("--audit-low-confidence requires --cohort <cohort-id>");
    return;
  }
  const requested = args["audit-low-confidence"];
  const sample = await buildLowConfidenceAudit({ classifierRoot, captureRoot, cohortId: args.cohort, limit: requested });
  if (args.json === true) {
    printJson({ action: "audit-low-confidence", ...sample });
    return;
  }
  console.log(`[classify-eval] low-confidence audit ${sample.cohortId} (EPHEMERAL — nothing is persisted)`);
  console.log(`[classify-eval]   showing the ${sample.limit} lowest-confidence observation(s)`);
  if (sample.rows.length === 0) console.log("[classify-eval]   (no observations)");
  for (const row of sample.rows) {
    console.log(`[classify-eval]   conf=${row.confidence}  ${String(row.channel).padEnd(7)} ${row.label}  ${row.recordDigest}`);
    console.log(`[classify-eval]       top: ${row.topScores.map((s) => `${s.label}=${s.score}`).join(", ")}`);
    console.log(`[classify-eval]       text: ${row.excerpt ?? "(empty)"}`);
  }
  console.log("[classify-eval] deterministic; no artifact was written.");
}

async function replayAction({ args, classifierRoot, captureRoot }) {
  if (typeof args.evaluation !== "string") {
    fail("--replay requires --evaluation <cleval-id>");
    return;
  }
  const report = await replayEvaluation({ classifierRoot, captureRoot, evaluationId: args.evaluation });
  if (!report.ok) process.exitCode = 1;
  if (args.json === true) {
    printJson({ action: "replay", ...report });
    return;
  }
  console.log(`[classify-eval] replay ${report.evaluationId} (offline, zero network, no reclassification)`);
  for (const [name, ok] of Object.entries(report.checks)) console.log(`[classify-eval]   ${hex(ok)} ${name}`);
  if (report.evaluationDigest) console.log(`[classify-eval]   evaluationDigest: ${report.evaluationDigest}`);
  console.log(report.ok ? "[classify-eval] integrity OK." : `[classify-eval] integrity FAILED: ${report.problems.join(" | ")}`);
}

async function statsAction({ args, classifierRoot }) {
  if (typeof args.evaluation !== "string") {
    fail("--stats requires --evaluation <cleval-id>");
    return;
  }
  const stats = await evaluationStats({ classifierRoot, evaluationId: args.evaluation });
  if (args.json === true) {
    printJson({ action: "stats", ...stats });
    return;
  }
  console.log(`[classify-eval] stats ${stats.evaluationId} (offline, zero network)`);
  console.log(`[classify-eval]   cohort:        ${stats.cohortId}`);
  console.log(`[classify-eval]   experiments:   ${stats.experimentCount} · captures ${stats.captureCount} · records ${stats.recordCount}`);
  console.log(`[classify-eval]   channels:      ${JSON.stringify(stats.channelCounts)}`);
  console.log(`[classify-eval]   labelCounts:   ${JSON.stringify(stats.labelCounts)}`);
  console.log(`[classify-eval]   labelFractions:${JSON.stringify(stats.labelFractions)}`);
  console.log(`[classify-eval]   labelDiversity:${stats.labelDiversity}`);
  console.log(`[classify-eval]   mean/median confidence: ${stats.meanConfidence} / ${stats.medianConfidence}`);
  console.log(`[classify-eval]   ambiguity fractions:    ${JSON.stringify(stats.ambiguityFractions)}`);
  console.log(`[classify-eval]   noise fraction:         ${stats.noiseFraction} · promotion fraction: ${stats.promotionFraction}`);
  console.log(`[classify-eval]   largest label:          ${stats.largestLabel} (${stats.largestLabelFraction})`);
  console.log(`[classify-eval]   resultDigests: ${JSON.stringify(stats.resultDigests)}`);
  console.log(`[classify-eval]   cohortDigest:  ${stats.cohortDigest} (ok: ${stats.cohortDigestOk}, cohort verified: ${stats.cohortOk})`);
  console.log(`[classify-eval]   evaluationDigest: ${stats.evaluationDigest} (matches: ${stats.evaluationDigestOk})`);
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

  const classifierRoot = path.resolve(String(args.out ?? CLASSIFIER_DIR));
  const captureRoot = path.resolve(String(args.captures ?? process.env.EVOLVE_INTELLIGENCE_DIR ?? INTELLIGENCE_DIR));

  const actions = [
    args["freeze-cohort"] === true ? "freeze-cohort" : null,
    args.audit === true ? "audit" : null,
    Object.hasOwn(args, "audit-low-confidence") ? "audit-low-confidence" : null,
    args.replay === true ? "replay" : null,
    args.stats === true ? "stats" : null,
  ].filter(Boolean);
  const evaluate = actions.length === 0;

  if (args.replay === true && args.stats === true) {
    fail("--replay and --stats are mutually exclusive");
    return;
  }
  if (!evaluate && actions.length !== 1) {
    fail(`exactly one action is allowed (got ${actions.join(", ")})`);
    return;
  }
  if (evaluate && typeof args.cohort !== "string") {
    fail("nothing to do: pass --cohort <cohort-id>, or --freeze-cohort / --audit / --audit-low-confidence / --replay / --stats");
    console.log(usage());
    return;
  }

  try {
    if (args["freeze-cohort"] === true) return await freezeAction({ args, classifierRoot, captureRoot });
    if (Object.hasOwn(args, "audit-low-confidence")) return await lowConfidenceAction({ args, classifierRoot, captureRoot });
    if (args.audit === true) return await auditAction({ args, classifierRoot, captureRoot });
    if (args.replay === true) return await replayAction({ args, classifierRoot, captureRoot });
    if (args.stats === true) return await statsAction({ args, classifierRoot });
    return await evaluateAction({ args, classifierRoot, captureRoot });
  } catch (error) {
    fail(String(error?.message ?? error));
  }
}

main().catch((error) => {
  console.error(`[classify-eval] failed: ${error?.message ?? error}`);
  process.exitCode = 1;
});
