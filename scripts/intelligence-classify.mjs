#!/usr/bin/env node
/**
 * Phase 5G.0 — classifier.dev FROZEN classification CLI (PAPER ONLY, SHADOW ONLY).
 *
 *   npm run intelligence:classify -- --capture <capture-id> --classifier reach-signal-type-v1 \
 *       --provider classifier-dev [--save]
 *   npm run intelligence:classify -- --stats  --experiment <clexp-id>
 *   npm run intelligence:classify -- --replay --experiment <clexp-id>
 *
 * Agent-Reach → frozen public observations → deterministic bounded text projection
 *   → classifier.dev FAST tier → frozen classification artifact → STOP.
 *
 * The provider is DISABLED unless `--provider classifier-dev` is given
 * explicitly. Classification is never triggered by a capture, never captures,
 * and its result is routed nowhere (no Jev, DeepSeek, Arena, evolution, compiler
 * or trading). `--stats` and `--replay` are OFFLINE: zero network calls.
 *
 * Only `EVOLVE_CLASSIFIER_*` variables are ever read from the environment or from
 * `.env` files; no credential is loaded, and none is sent.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseArgs } from "./lib/args.mjs";
import { parseEnvFile } from "./lib/env.mjs";
import { INTELLIGENCE_DIR } from "./intelligence/config.mjs";
import { CLASSIFIER_ID, REGISTERED_CLASSIFIERS } from "./intelligence/classifier-definition.mjs";
import {
  CLASSIFIER_DEV_PROVIDER,
  CLASSIFIER_DEV_TIER,
  DEFAULT_CLASSIFIER_PROVIDER,
  REGISTERED_CLASSIFIER_PROVIDERS,
  createClassifierDevProvider,
  resolveClassifierSettings,
} from "./intelligence/classifier-dev.mjs";
import {
  CLASSIFIER_DIR,
  classifierExperimentStats,
  listClassifierExperiments,
  replayClassifierExperiment,
  runClassification,
} from "./intelligence/classifier-experiment.mjs";

const BOOLEAN_FLAGS = ["json", "save", "stats", "replay", "help"];
const VALUE_FLAGS = ["capture", "classifier", "provider", "experiment", "out", "captures", "tier", "labels", "multi", "max-labels", "instructions"];

function usage() {
  return [
    "EVOLVE Phase 5G.0 classifier.dev frozen classification (PAPER ONLY, SHADOW ONLY)",
    "",
    "Classify a FROZEN capture (ONE request, FAST tier, fixed taxonomy) and freeze the result:",
    `  npm run intelligence:classify -- --capture <capture-id> --classifier ${CLASSIFIER_ID} --provider ${CLASSIFIER_DEV_PROVIDER} [--save]`,
    "Offline inspection (zero network):",
    "  npm run intelligence:classify -- --stats  [--experiment <clexp-id>]",
    "  npm run intelligence:classify -- --replay --experiment <clexp-id>",
    "",
    "Options:",
    `  --provider <${REGISTERED_CLASSIFIER_PROVIDERS.join("|")}>   default ${DEFAULT_CLASSIFIER_PROVIDER} (nothing is called)`,
    `  --classifier <${REGISTERED_CLASSIFIERS.join("|")}>`,
    `  --captures <dir>   capture root (default ${INTELLIGENCE_DIR})`,
    `  --out <dir>        classifier root (default ${CLASSIFIER_DIR}); must be outside the capture root`,
    "  --save             persist the frozen experiment (otherwise the result is only printed)",
    "  --json             machine-readable output",
    "",
    "Refused by design: --tier smart, multi-label, custom labels, custom instructions.",
    "Labels are DESCRIPTIVE and UNVERIFIED. Nothing is routed to Jev, DeepSeek, the Arena or trading.",
  ].join("\n");
}

function fail(message) {
  console.error(`[classify] ${message}`);
  process.exitCode = 1;
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

/** Only `EVOLVE_CLASSIFIER_*` keys are ever taken from `.env` files — no credential is loaded. */
async function classifierEnv() {
  const env = {};
  for (const file of [".env.local", ".env"]) {
    let parsed = {};
    try {
      parsed = parseEnvFile(await readFile(path.join(process.cwd(), file), "utf8"));
    } catch {
      continue;
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (key.startsWith("EVOLVE_CLASSIFIER_") && env[key] === undefined) env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("EVOLVE_CLASSIFIER_")) env[key] = value;
  }
  return env;
}

function refuseForbiddenFlags(args) {
  // `hasOwn`, not `!== undefined`: a bare `--multi` parses to `undefined` and must still be refused.
  const has = (key) => Object.hasOwn(args, key);
  if (has("tier") && String(args.tier).toLowerCase() !== CLASSIFIER_DEV_TIER) {
    return `--tier '${args.tier}' refused: Phase 5G.0 is FAST tier only (smart tier is disabled)`;
  }
  if (has("multi")) return "--multi refused: multi-label classification is disabled";
  if (has("max-labels")) return "--max-labels refused: single-label classification only";
  if (has("labels")) return "--labels refused: the taxonomy is frozen and never supplied by the caller";
  if (has("instructions")) return "--instructions refused: the instructions are frozen";
  return null;
}

async function classifyAction({ args, captureRoot, outRoot }) {
  const providerName = typeof args.provider === "string" ? args.provider : DEFAULT_CLASSIFIER_PROVIDER;
  if (!REGISTERED_CLASSIFIER_PROVIDERS.includes(providerName)) {
    fail(`unknown provider '${providerName}' (expected ${REGISTERED_CLASSIFIER_PROVIDERS.join(", ")}) — there is no fallback`);
    return;
  }
  if (providerName === DEFAULT_CLASSIFIER_PROVIDER) {
    fail(`classification refused: the provider is DISABLED (the default). Pass \`--provider ${CLASSIFIER_DEV_PROVIDER}\` explicitly.`);
    return;
  }
  if (typeof args.capture !== "string" || args.capture.length === 0) {
    fail("classification requires --capture <capture-id> (an existing frozen capture; nothing is ever captured here)");
    return;
  }
  if (typeof args.classifier !== "string" || args.classifier.length === 0) {
    fail(`classification requires --classifier ${CLASSIFIER_ID}`);
    return;
  }
  if (!REGISTERED_CLASSIFIERS.includes(args.classifier)) {
    fail(`unknown classifier '${args.classifier}' (expected ${REGISTERED_CLASSIFIERS.join(", ")})`);
    return;
  }

  const provider = createClassifierDevProvider({ settings: resolveClassifierSettings(await classifierEnv()) });
  const result = await runClassification({
    captureRoot,
    outRoot,
    captureId: args.capture,
    classifierId: args.classifier,
    provider,
    save: args.save === true,
  });

  if (!result.ok) {
    if (args.json === true) printJson({ action: "classify", ok: false, status: result.status, reason: result.reason, httpStatus: result.httpStatus, attempts: result.attempts, saved: false });
    else {
      console.error(`[classify] FAILED (${result.status}): ${result.reason}`);
      console.error(`[classify]   attempts: ${result.attemptCount} · nothing was persisted`);
    }
    process.exitCode = 1;
    return;
  }

  const { experiment, run } = result;
  if (args.json === true) {
    printJson({ action: "classify", ok: true, saved: result.saved, dir: result.dir, experiment, run: { ...run, attempts: run.attempts } });
    return;
  }
  console.log(`[classify] ${experiment.experimentId}${result.saved ? "" : " (NOT saved — pass --save to freeze it)"}`);
  console.log(`[classify]   capture:      ${experiment.captureId} (manifest ${experiment.captureManifestDigest})`);
  console.log(`[classify]   classifier:   ${experiment.classifierId} v${experiment.classifierVersion} · ${experiment.inputProjectionVersion}`);
  console.log(`[classify]   provider:     ${experiment.provider} ${experiment.endpointVersion} · tier ${experiment.returnedTier} · model ${experiment.returnedModel ?? "n/a"}`);
  console.log(`[classify]   records:      ${experiment.recordCount} · classified ${experiment.classifiedCount} · skipped-empty ${experiment.skippedEmptyCount}`);
  console.log(`[classify]   attempts:     ${run.attemptCount} · latency ${run.latencyMs}ms`);
  console.log(`[classify]   labelCounts:  ${JSON.stringify(experiment.summary.labelCounts)}`);
  console.log(`[classify]   meanConfidence: ${experiment.summary.meanConfidence}`);
  console.log(`[classify]   resultDigest: ${experiment.resultDigest}`);
  if (result.saved) console.log(`[classify]   stored:       ${result.dir}`);
  console.log("[classify] frozen and STOPPED. Labels are descriptive and unverified; nothing was routed to Jev, DeepSeek, the Arena or trading.");
}

async function statsAction({ args, outRoot }) {
  if (typeof args.experiment === "string") {
    const stats = await classifierExperimentStats({ outRoot, experimentId: args.experiment });
    if (args.json === true) printJson({ action: "stats", ...stats });
    else {
      console.log(`[classify] stats ${stats.experimentId} (offline, zero network)`);
      console.log(`[classify]   capture:       ${stats.captureId}`);
      console.log(`[classify]   classifier:    ${stats.classifierId} v${stats.classifierVersion}`);
      console.log(`[classify]   provider:      ${stats.provider} ${stats.endpointVersion} · tier ${stats.returnedTier} · model ${stats.returnedModel ?? "n/a"}`);
      console.log(`[classify]   classified:    ${stats.classifiedCount} of ${stats.recordCount} (skipped-empty ${stats.skippedEmptyCount})`);
      console.log(`[classify]   labelCounts:   ${JSON.stringify(stats.summary.labelCounts)}`);
      console.log(`[classify]   meanConfidence: ${stats.summary.meanConfidence}`);
      console.log(`[classify]   resultDigest:  ${stats.resultDigest} (matches stored: ${stats.resultDigestOk})`);
    }
    return;
  }
  const ids = await listClassifierExperiments(outRoot);
  if (args.json === true) printJson({ action: "stats", experiments: ids, networkCalls: 0 });
  else {
    console.log(`[classify] classifier experiments (${ids.length})`);
    for (const id of ids) console.log(`[classify]   ${id}`);
    if (ids.length === 0) console.log("[classify]   (none yet)");
  }
}

async function replayAction({ args, captureRoot, outRoot }) {
  if (typeof args.experiment !== "string") {
    fail("--replay requires --experiment <clexp-id>");
    return;
  }
  const report = await replayClassifierExperiment({ outRoot, captureRoot, experimentId: args.experiment });
  if (!report.ok) process.exitCode = 1;
  if (args.json === true) {
    printJson({ action: "replay", ...report });
    return;
  }
  console.log(`[classify] replay ${report.experimentId} (offline, zero network, no reclassification)`);
  for (const [name, ok] of Object.entries(report.checks)) console.log(`[classify]   ${ok ? "✓" : "✗"} ${name}`);
  if (report.resultDigest) console.log(`[classify]   resultDigest: ${report.resultDigest} (stored ${report.expectedResultDigest})`);
  console.log(report.ok ? "[classify] integrity OK." : `[classify] integrity FAILED: ${report.problems.join(" | ")}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { booleanFlags: BOOLEAN_FLAGS, valueFlags: VALUE_FLAGS });
  if (args.help === true) {
    console.log(usage());
    return;
  }
  const forbidden = refuseForbiddenFlags(args);
  if (forbidden) {
    fail(forbidden);
    return;
  }
  const captureRoot = path.resolve(String(args.captures ?? process.env.EVOLVE_INTELLIGENCE_DIR ?? INTELLIGENCE_DIR));
  const outRoot = path.resolve(String(args.out ?? CLASSIFIER_DIR));

  if (args.stats === true && args.replay === true) {
    fail("--stats and --replay are mutually exclusive");
    return;
  }
  if (args.stats === true) return statsAction({ args, outRoot });
  if (args.replay === true) return replayAction({ args, captureRoot, outRoot });
  return classifyAction({ args, captureRoot, outRoot });
}

main().catch((error) => {
  console.error(`[classify] failed: ${error?.message ?? error}`);
  process.exitCode = 1;
});
