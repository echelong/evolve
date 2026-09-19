#!/usr/bin/env node
/**
 * EVOLVE Phase 5F.0 — external-intelligence → Jev SHADOW experiment CLI.
 *
 *   npm run jev:external -- --capture <capture-id> --provider <provider> [--save]
 *   npm run jev:external -- --capture capture-20260919T130756Z --provider vercel-jev --save
 *
 * This is EXPLICIT experimentation, NOT operational routing. The command:
 *
 *   1. requires an EXISTING frozen capture (never takes a new one);
 *   2. replays it OFFLINE (zero network) and verifies capture integrity;
 *   3. builds `external-intelligence-packet-v1`;
 *   4. runs `assertPacketAllowed`, then asserts the routing flags are false and
 *      the packet is shadow/paper/read-only;
 *   5. derives the dedicated bounded Jev projection
 *      (`JEV_EXTERNAL_INTELLIGENCE_DECISION_PACKET`);
 *   6. builds the fixed `jev-external-intelligence-v1` question set;
 *   7. optionally calls EXACTLY ONE explicitly selected Jev provider;
 *   8. persists under the EXISTING Jev experiment storage only when `--save`
 *      (or `--experiment`) is passed;
 *   9. never calls Agent-Reach, never reaches live internet except the selected
 *      Jev provider call, never calls DeepSeek, never runs the Arena.
 *
 * Provider selection is FAIL-CLOSED and by NAME only. Unset ⇒ disabled
 * (`JEV_DISABLED` / `NO_JEV_DECISION`); any unregistered name is a hard error;
 * there is NO fallback to a different decision model. `EVOLVE_JEV_MAX_CALLS`
 * defaults to 1 here (maximum LOGICAL decisions) and the budget is checked
 * BEFORE the provider is invoked.
 *
 * Phase 5F.1 wraps the selected provider in a bounded transport resilience
 * layer: up to `EVOLVE_JEV_MAX_ATTEMPTS` (default 3, max 5) PHYSICAL attempts
 * per logical decision, retrying ONLY transient 429 / 5xx / timeout / network
 * failures with bounded exponential backoff and jitter, an optional same-Jev
 * transport chain (`EVOLVE_JEV_TRANSPORT_CHAIN`, honoured only when the other
 * Jev route has its OWN real credential), and a bounded provider-health
 * cooldown that refuses to call a provider already known to be rate limited
 * (unless `--override-cooldown` is passed explicitly). A retried call is still
 * exactly ONE shadow decision; every failed attempt is recorded.
 *
 * PAPER ONLY, SHADOW ONLY, READ-ONLY with respect to every other EVOLVE system.
 */

import path from "node:path";

import { parseArgs } from "./lib/args.mjs";
import { loadEnvFiles } from "./lib/env.mjs";
import {
  REGISTERED_JEV_PROVIDERS,
  UnknownJevProviderError,
  readIntEnv,
  requireJevProviderName,
  resolveJevConfig,
  resolveJevModelName,
} from "./jev/config.mjs";
import { createResilientJevProvider } from "./jev/provider.mjs";
import { createJevRunBudget } from "./jev/runtime.mjs";
import {
  JEV_EXTERNAL_INTELLIGENCE_PACKET_KIND,
  JEV_EXTERNAL_INTELLIGENCE_PACKET_VERSION,
  JEV_EXTERNAL_INTELLIGENCE_QUESTION_SET_ID,
  JEV_EXTERNAL_INTELLIGENCE_QUESTION_SET_VERSION,
  buildExternalIntelligenceJevPacket,
  runExternalIntelligenceShadowDecision,
} from "./jev-external-bridge.mjs";
import { INTELLIGENCE_DIR } from "./intelligence/config.mjs";
import { verifyCapture } from "./intelligence/capture.mjs";
import { replayCapture } from "./intelligence/replay.mjs";
import {
  assertPacketAllowed,
  auditExternalIntelligencePacket,
  buildExternalIntelligencePacket,
} from "./intelligence/packet.mjs";

loadEnvFiles();

const BOOLEAN_FLAGS = ["json", "help", "save", "override-cooldown"];
const VALUE_FLAGS = ["capture", "provider", "model", "timeout-ms", "max-calls", "out", "experiment"];

const DEFAULT_EXTERNAL_MAX_CALLS = 1;

function usage() {
  return [
    "EVOLVE Phase 5F.0 external-intelligence -> Jev SHADOW experiment (PAPER ONLY, SHADOW ONLY)",
    "",
    "  npm run jev:external -- --capture <capture-id> --provider <name> [--save]",
    "",
    "Options:",
    `  --capture <id>      REQUIRED. An existing frozen capture to replay offline`,
    `  --provider <name>   ${REGISTERED_JEV_PROVIDERS.join(" | ")} (default: env, else disabled)`,
    "  --model <id>        override the provider's canonical model id",
    "  --timeout-ms <n>    provider call timeout (bounded)",
    `  --max-calls <n>     Jev call budget for this run (default ${DEFAULT_EXTERNAL_MAX_CALLS})`,
    "  --out <dir>         capture root (default .evolve/intelligence)",
    "  --experiment <id>   persist under this Jev experiment id",
    "  --save              persist the Jev shadow experiment",
    "  --override-cooldown force a call even while a transient-failure cooldown is active",
    "  --json              print machine-readable output",
    "",
    "One logical decision may use several bounded physical attempts (transient 429/5xx/timeout/network",
    "only), controlled by EVOLVE_JEV_MAX_ATTEMPTS (default 3, max 5). Non-transient failures are never retried.",
    "This command NEVER takes a capture, NEVER calls Agent-Reach, NEVER calls DeepSeek and",
    "NEVER runs the Arena. Operational external-intelligence routing remains OFF.",
  ].join("\n");
}

function fail(message) {
  console.error(`[jev:external] ${message}`);
  process.exitCode = 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { booleanFlags: BOOLEAN_FLAGS, valueFlags: VALUE_FLAGS });
  if (args.help === true) {
    console.log(usage());
    return;
  }

  const captureId = typeof args.capture === "string" ? args.capture.trim() : "";
  if (!captureId) {
    fail("--capture <id> is required (see `npm run intelligence:stats`)");
    return;
  }

  // ---- provider selection (fail-closed, by NAME only) ---------------------
  const envConfig = resolveJevConfig();
  const requestedName = args.provider !== undefined ? String(args.provider) : envConfig.requestedProvider;

  let resolution;
  try {
    resolution = requireJevProviderName(requestedName);
  } catch (error) {
    console.error(`[jev:external] ${error.message}`);
    console.error(`[jev:external] registered providers: ${REGISTERED_JEV_PROVIDERS.join(", ")}`);
    process.exitCode = 2;
    return;
  }
  if (resolution.provider === null) {
    fail("Jev is disabled (EVOLVE_JEV_PROVIDER is not set / no --provider given). Nothing to do.");
    process.exitCode = 2;
    return;
  }

  const model = resolveJevModelName(envConfig, {
    provider: resolution.provider,
    override: args.model !== undefined ? String(args.model) : null,
  });
  const timeoutMs = args["timeout-ms"] ? Number.parseInt(String(args["timeout-ms"]), 10) : envConfig.timeoutMs;
  // ---- bounded transport resilience (Phase 5F.1) --------------------------
  // ONE logical decision may now consume several PHYSICAL attempts (transient
  // 429/5xx/timeout/network only), with bounded exponential backoff + jitter, an
  // optional same-Jev transport chain that is only ever honoured when the other
  // route has its OWN real credential, and a bounded provider-health cooldown
  // that refuses to call a provider we already know is rate limited.
  const resilient = createResilientJevProvider({
    selectedProvider: resolution.provider,
    config: envConfig,
    modelOverride: args.model !== undefined ? String(args.model) : null,
    timeoutMs,
    overrideCooldown: args["override-cooldown"] === true,
  });
  const provider = resilient.provider;

  if (resilient.wrapped && args["override-cooldown"] === true) {
    console.error("[jev:external] --override-cooldown: bypassing the provider-health cooldown fail-safe for this run");
  }
  for (const entry of resilient.chain?.skipped ?? []) {
    console.error(`[jev:external] transport chain: skipping '${entry.provider}' — ${entry.reason}`);
  }

  // ---- replay the EXISTING frozen capture OFFLINE -------------------------
  const captureRoot = path.resolve(String(args.out ?? process.env.EVOLVE_INTELLIGENCE_DIR ?? INTELLIGENCE_DIR));
  let replay;
  try {
    replay = await replayCapture({ root: captureRoot, captureId, asOf: null });
  } catch (error) {
    fail(`could not replay capture '${captureId}': ${error?.message ?? error}`);
    process.exitCode = 2;
    return;
  }
  const integrity = await verifyCapture(captureRoot, captureId);
  if (!integrity.ok) {
    fail(`capture '${captureId}' failed integrity verification (${integrity.reason ?? "unknown"})`);
    process.exitCode = 2;
    return;
  }

  // ---- external packet + mandatory audit ----------------------------------
  const externalPacket = buildExternalIntelligencePacket({ replay });
  assertPacketAllowed(externalPacket);
  if (externalPacket.routing.jevRoutingActive !== false || externalPacket.routing.deepseekRoutingActive !== false) {
    fail("refusing to continue: external-intelligence routing flags are not false");
    process.exitCode = 2;
    return;
  }

  // ---- dedicated Jev projection -------------------------------------------
  const jevPacket = buildExternalIntelligenceJevPacket({ externalPacket });

  // ---- call budget: checked BEFORE the provider is invoked ----------------
  const maxCalls =
    args["max-calls"] !== undefined
      ? Math.max(1, Number.parseInt(String(args["max-calls"]), 10) || DEFAULT_EXTERNAL_MAX_CALLS)
      : readIntEnv(process.env, "EVOLVE_JEV_MAX_CALLS", DEFAULT_EXTERNAL_MAX_CALLS, { min: 1, max: 500 });
  // LOGICAL budget only. `EVOLVE_JEV_MAX_ATTEMPTS` bounds PHYSICAL attempts per
  // logical decision and is never counted here.
  const budget = createJevRunBudget(maxCalls);

  const persist = args.save === true || args.experiment !== undefined;

  const result = await runExternalIntelligenceShadowDecision({
    externalPacket,
    provider,
    budget,
    cacheEnabled: envConfig.cacheEnabled,
    persist,
    experimentId: args.experiment ? String(args.experiment) : null,
    experimentRootBase: undefined,
    now: () => Date.now(),
  });

  const output = {
    captureId,
    provider: resolution.provider,
    model: provider.model ?? model,
    packetVersion: JEV_EXTERNAL_INTELLIGENCE_PACKET_VERSION,
    packetKind: JEV_EXTERNAL_INTELLIGENCE_PACKET_KIND,
    questionSetId: JEV_EXTERNAL_INTELLIGENCE_QUESTION_SET_ID,
    questionSetVersion: JEV_EXTERNAL_INTELLIGENCE_QUESTION_SET_VERSION,
    sourcePacketDigest: externalPacket.packetDigest,
    externalPacketAudit: auditExternalIntelligencePacket(externalPacket),
    projection: { featureFields: Object.keys(jevPacket.features).length, stateDigest: result.stateDigest },
    jevStateDigest: result.stateDigest,
    status: result.run.status,
    reason: result.run.reason,
    latencyMs: result.run.latencyMs,
    budget: { max: budget.max, used: budget.used },
    providerAttemptCount: result.run.providerAttemptCount ?? 0,
    providerAttempts: result.run.providerAttempts ?? null,
    transport: {
      wrapped: resilient.wrapped === true,
      chain: resilient.chain?.chainNames ?? [resolution.provider],
      maxAttempts: resilient.settings?.maxAttempts ?? 1,
      skipped: resilient.chain?.skipped ?? [],
      cooldownOverride: args["override-cooldown"] === true,
    },
    decision: result.decision === "NO_JEV_DECISION" ? "NO_JEV_DECISION" : result.decision,
    deterministicComparators: result.comparators,
    experimentId: result.experimentId,
    persisted: result.root !== null,
    decisionId: result.decisionRecord?.decisionId ?? null,
    deepseekCalls: 0,
    agentReachCalls: 0,
    liveCaptures: 0,
    arenaRuns: 0,
    routing: { jevRoutingActive: false, deepseekRoutingActive: false },
  };

  if (args.json === true) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log("EVOLVE external-intelligence -> Jev SHADOW experiment (PAPER ONLY)");
    console.log(`  capture       ${captureId}`);
    console.log(`  provider      ${resolution.provider} (${provider.model ?? model})`);
    console.log(`  packet        ${JEV_EXTERNAL_INTELLIGENCE_PACKET_KIND} v${JEV_EXTERNAL_INTELLIGENCE_PACKET_VERSION}`);
    console.log(`  question set  ${JEV_EXTERNAL_INTELLIGENCE_QUESTION_SET_ID} v${JEV_EXTERNAL_INTELLIGENCE_QUESTION_SET_VERSION}`);
    console.log(`  status        ${result.run.status}`);
    console.log(`  latency       ${Number.isFinite(result.run.latencyMs) ? `${result.run.latencyMs}ms` : "n/a"}`);
    console.log(`  budget        ${budget.used}/${budget.max} logical · ${result.run.providerAttemptCount ?? 0} physical attempt(s)`);
    console.log(`  transport     ${(resilient.chain?.chainNames ?? [resolution.provider]).join(" → ")} (max ${resilient.settings?.maxAttempts ?? 1} attempts/provider)`);
    console.log(`  persisted     ${result.root ? `yes (${result.experimentId})` : "no (pass --save)"}`);
    if (result.run.status === "JEV_COOLDOWN") {
      console.log("  COOLDOWN      no network call was made; pass --override-cooldown to force one");
    }
    console.log(`  decision      ${JSON.stringify(output.decision)}`);
    console.log(`  comparators   ${JSON.stringify(result.comparators)}`);
    console.log("  isolation     Agent-Reach 0 · DeepSeek 0 · live captures 0 · Arena runs 0");
    if (output.decision !== "NO_JEV_DECISION" && output.decision?.researchDisposition?.choice === "escalate_to_deep_research") {
      console.log("  NOTE          'escalate_to_deep_research' is a SHADOW ANSWER, not an action. Nothing was escalated.");
    }
  }

  process.exitCode = result.run.status === "JEV_OK" ? 0 : 3;
}

main().catch((error) => {
  if (error instanceof UnknownJevProviderError) {
    console.error(`[jev:external] ${error.message}`);
    process.exitCode = 2;
    return;
  }
  console.error(`[jev:external] failed: ${error?.message ?? error}`);
  process.exitCode = 1;
});
