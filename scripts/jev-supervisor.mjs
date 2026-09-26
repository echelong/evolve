#!/usr/bin/env node
/**
 * EVOLVE — JEV SUPERVISOR OBSERVER CLI (Phase 5I-PS.2).
 *
 *   npm run jev:supervisor -- --minutes 60
 *
 * Runs the NORMAL EVOLVE paper engine (dashboard state, evolution, research
 * swarm, paper execution — all exactly as always) with a PASSIVE proposal tap
 * attached. Immediately after each paper decision EXECUTES, an immutable
 * proposal snapshot is pushed into a bounded queue; an in-process asynchronous
 * worker drains that queue, asks direct TypeSafe Jev the EXISTING SOL/USDC
 * directional question about the FROZEN MARKET STATE, and records an
 * agreement/disagreement judgment.
 *
 * Jev has ZERO authority here. It cannot allow, block, alter, resize or delay
 * a trade, and it cannot touch a genome, fitness, evolution, the Arena,
 * research candidates, selection, Temporal 5I.1a, or canonical Phase 5I
 * evidence. A slow, failed or malformed Jev response can only damage observer
 * evidence — the paper engine continues normally.
 *
 * No wallet, no signing, no swap, no order, no RPC write, no real money.
 * PAPER ONLY / DEVELOPMENT EVIDENCE ONLY.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";

import { parseArgs } from "./lib/args.mjs";
import { loadEnvFiles } from "./lib/env.mjs";
import { resolveJevConfig } from "./jev/config.mjs";
import { createResilientJevProvider } from "./jev/provider.mjs";
import { createMarketConfig } from "./market/config.mjs";
import { startEngine } from "./evolve-engine.mjs";
import {
  SUPERVISOR_BOOLEAN_FLAGS,
  SUPERVISOR_DEFAULT_DURATION_MINUTES,
  SUPERVISOR_DURATION_BOUNDS,
  SUPERVISOR_FORBIDDEN_WRITE_ROOTS,
  SUPERVISOR_ISOLATION_STATEMENT,
  SUPERVISOR_LABEL,
  SUPERVISOR_MARKET_ID,
  SUPERVISOR_MAX_JEV_CALLS,
  SUPERVISOR_NO_AUTHORITY_TAG,
  SUPERVISOR_QUEUE_CAPACITY,
  SUPERVISOR_REQUIRED_MODEL,
  SUPERVISOR_REQUIRED_PROVIDER,
  SUPERVISOR_ROOT_DIR,
  SUPERVISOR_STATEMENT,
  SUPERVISOR_SUPPORTED_MARKET_IDS,
  SUPERVISOR_VALUE_FLAGS,
  supervisorSessionIdFor,
  supervisorSessionRootFor,
} from "./jev/supervisor/definition.mjs";
import { buildSupervisorSettings, enforceSupervisorProviderPins } from "./jev/supervisor/settings.mjs";
import {
  PS2D_AUTHORITY_TAG,
  PS2D_CLI_PROFILES,
  PS2D_LABEL,
  PS2D_PROFILES,
  PS2D_PROVIDER_HEALTH_DIR,
  PS2D_TIMEOUT_MS,
  PS2D_TRANSPORT_SETTINGS,
  crossAssetExternalCallPolicy,
} from "./jev/supervisor/cross-asset-protocol.mjs";
import {
  PS2E_AUTHORITY_TAG,
  PS2E_CLI_PROFILES,
  PS2E_LABEL,
  PS2E_MISSING_LOCAL_JEV_INTERFACE,
  PS2E_PRIMARY_CLASSIFIER,
  PS2E_PROFILES,
  localTevExternalCallPolicy,
} from "./jev/supervisor/local-tev-protocol.mjs";
import {
  assessLocalTevReadiness,
  createDecisionCliTransport,
  readLocalJevEnvironment,
} from "./jev/supervisor/local-jev-client.mjs";
import { createSupervisorProposalObserver } from "./jev/supervisor/observer.mjs";
import { validateExternalPolicy } from "./governance/external-policy.mjs";
import { ensureSupervisorDir } from "./jev/supervisor/storage.mjs";

function usage() {
  return [
    `EVOLVE — ${SUPERVISOR_LABEL} (${SUPERVISOR_NO_AUTHORITY_TAG})`,
    "",
    "  npm run jev:supervisor -- --minutes 60",
    "",
    "Options:",
    `  --minutes <n>       bounded run duration in minutes (default ${SUPERVISOR_DEFAULT_DURATION_MINUTES}, bounds ${SUPERVISOR_DURATION_BOUNDS.min}-${SUPERVISOR_DURATION_BOUNDS.max})`,
    `  --market <id>       ${SUPERVISOR_SUPPORTED_MARKET_IDS.join(" | ")} (the only supported market)`,
    "  --session <id>      explicit session id (default jsup-<UTC timestamp>-<digest>)",
    `  --cross-asset <p>   opt into the Phase 5I-PS.2d ${PS2D_LABEL} (${PS2D_AUTHORITY_TAG});`,
    `                      frozen profiles: ${PS2D_CLI_PROFILES.map((name) => `${name} (max ${PS2D_PROFILES[name].globalMaxJevCallsPerRun} Jev calls)`).join(", ")}`,
    `  --local-tev <p>     opt into the Phase 5I-PS.2e ${PS2E_LABEL} (${PS2E_AUTHORITY_TAG});`,
    `                      frozen profiles: ${PS2E_CLI_PROFILES.map((name) => `${name} (${PS2E_PROFILES[name].bucketCount} x ${PS2E_PROFILES[name].bucketMs / 60_000} min buckets, max ${PS2E_PROFILES[name].perBucketMaxAdmissions}/bucket, max ${PS2E_PROFILES[name].globalMaxAdmissions}/run, >= ${PS2E_PROFILES[name].minimumMinutes} minutes)`).join(", ")}`,
    "                      one shadow protocol per run: --cross-asset and --local-tev are mutually exclusive.",
    "  --json              machine-readable result",
    "  --help              this help",
    "",
    `Provider: direct TypeSafe Jev (${SUPERVISOR_REQUIRED_PROVIDER}), model ${SUPERVISOR_REQUIRED_MODEL}, gatewayUsed=false, cache disabled.`,
    "No fallback to mock-jev, the Vercel AI Gateway, a cached answer, or another model.",
    "",
    `Bounded queue: ${SUPERVISOR_QUEUE_CAPACITY} proposals (fixed in source). Jev calls: at most ${SUPERVISOR_MAX_JEV_CALLS} per session.`,
    `Isolation: writes only under ${SUPERVISOR_ROOT_DIR}/<session>/ and NEVER into ${SUPERVISOR_FORBIDDEN_WRITE_ROOTS.join(", ")}.`,
    SUPERVISOR_STATEMENT,
    SUPERVISOR_ISOLATION_STATEMENT,
    "No daemon. Ctrl+C finalizes the observer summary cleanly. PAPER ONLY.",
  ].join("\n");
}

async function main() {
  loadEnvFiles();

  const args = parseArgs(process.argv.slice(2), {
    booleanFlags: SUPERVISOR_BOOLEAN_FLAGS,
    valueFlags: SUPERVISOR_VALUE_FLAGS,
  });
  if (args.help === true) {
    console.log(usage());
    return;
  }

  const settings = buildSupervisorSettings(args);
  if (settings.problems.length > 0) {
    for (const problem of settings.problems) console.error(`[jev:supervisor] ${problem}`);
    console.error("[jev:supervisor] nothing was started; no artifact was written and no provider was called.");
    process.exitCode = 2;
    return;
  }

  // ---- FAIL-CLOSED provider enforcement (direct TypeSafe only) --------------
  const envConfig = resolveJevConfig();
  const pins = enforceSupervisorProviderPins({ envConfig });
  if (!pins.ok) {
    for (const problem of pins.problems) console.error(`[jev:supervisor] ${problem}`);
    console.error(
      "[jev:supervisor] refusing to start: the observer requires direct TypeSafe Jev. No artifact was written and " +
        "no provider was called. The normal paper engine can still be run with `npm run engine`.",
    );
    process.exitCode = 2;
    return;
  }

  // ---- PS.2e: the SHARED Local JEV classifier boundary -----------------------
  // The precommitted primary Tev-style classifier is required. When the shared
  // Local JEV installation does not expose it, PS.2e REFUSES to start: it never
  // substitutes a generic local model as the primary decision model.
  let localTev = null;
  if (settings.localTevProfile !== null) {
    const profile = PS2E_PROFILES[settings.localTevProfile];
    const policyValidation = validateExternalPolicy(
      localTevExternalCallPolicy({ policy: PS2E_PRIMARY_CLASSIFIER, profile }),
      { evidenceBearing: true },
    );
    if (policyValidation.status !== "PASS") {
      for (const problem of policyValidation.problems) console.error(`[jev:supervisor] PS.2e policy: ${problem}`);
      console.error("[jev:supervisor] refusing to start: the PS.2e external-call policy failed validation.");
      process.exitCode = 2;
      return;
    }
    const projection = await readLocalJevEnvironment();
    const readiness = assessLocalTevReadiness({ projection, policy: PS2E_PRIMARY_CLASSIFIER });
    if (!readiness.ready) {
      console.error(
        `[jev:supervisor] PS.2e cannot start: primary classifier readiness is ${readiness.status} ` +
          `(tier ${PS2E_PRIMARY_CLASSIFIER.primaryTier}, ${PS2E_PRIMARY_CLASSIFIER.classifierRuntime}).`,
      );
      for (const problem of readiness.problems) console.error(`[jev:supervisor] PS.2e ${problem}`);
      // The missing-interface list is the HISTORICAL precommit-time record,
      // retained for provenance. It is printed only when the CURRENT failure is
      // about the missing specialist interface, and never as the current cause.
      if (readiness.status === "PRIMARY_CLASSIFIER_UNAVAILABLE") {
        console.error(
          "[jev:supervisor] historical precommit-time missing-interface record (retained for provenance; the " +
            "current cause is the readiness problem listed above):",
        );
        for (const item of PS2E_MISSING_LOCAL_JEV_INTERFACE) console.error(`[jev:supervisor]   - ${item}`);
      }
      console.error(
        "[jev:supervisor] refusing to start: PS.2e never substitutes a generic local model and this session made no " +
          "classifier call. No artifact was written.",
      );
      process.exitCode = 2;
      return;
    }
    localTev = {
      profile: settings.localTevProfile,
      classifierPolicy: PS2E_PRIMARY_CLASSIFIER,
      projection,
      readiness,
      transport: createDecisionCliTransport(),
    };
  }

  // A PS.2e session makes no direct TypeSafe call of its own, but the unchanged
  // PS.2 / PS.2a SOL observer in the same session still requires its existing
  // direct-TypeSafe pins. That is pre-existing PS.2 behavior and is reported as
  // such; it is never a PS.2e classifier call.

  // ---- PS.2d: Governance v1 validation of the evidence-bearing call policy
  // (no fallback, fail closed, bounded) BEFORE any artifact or provider exists.
  if (settings.crossAssetProfile !== null) {
    const policyValidation = validateExternalPolicy(
      crossAssetExternalCallPolicy(PS2D_PROFILES[settings.crossAssetProfile], { provider: pins.provider, model: pins.model }),
      { evidenceBearing: true },
    );
    if (policyValidation.status !== "PASS") {
      for (const problem of policyValidation.problems) console.error(`[jev:supervisor] PS.2d policy: ${problem}`);
      console.error("[jev:supervisor] refusing to start: the PS.2d external-call policy failed validation.");
      process.exitCode = 2;
      return;
    }
  }

  // ---- isolated session tree -------------------------------------------------
  const sessionId = settings.sessionId ?? supervisorSessionIdFor({ startedAt: Date.now() });
  const baseRoot = process.env.EVOLVE_SUPERVISOR_ROOT?.trim() || SUPERVISOR_ROOT_DIR;
  const sessionRoot = supervisorSessionRootFor(baseRoot, sessionId);
  await ensureSupervisorDir(sessionRoot, baseRoot);
  const healthRoot = path.join(sessionRoot, "provider-health");
  await mkdir(healthRoot, { recursive: true });

  const resilient = createResilientJevProvider({
    selectedProvider: pins.provider,
    // No chain: no gateway route can ever answer as a substitute.
    config: { ...envConfig, transportChain: [] },
    modelOverride: null,
    timeoutMs: envConfig.timeoutMs,
    healthRoot,
  });
  const provider = resilient.provider;

  // ---- PS.2d: a DEDICATED provider instance with the frozen PS.2d call policy
  // (pinned timeout and transport attempts, empty chain = no fallback route,
  // its own provider-health directory). Same pinned provider/model only.
  let crossAsset = null;
  if (settings.crossAssetProfile !== null) {
    const crossAssetHealthRoot = path.join(sessionRoot, PS2D_PROVIDER_HEALTH_DIR);
    await mkdir(crossAssetHealthRoot, { recursive: true });
    const crossAssetResilient = createResilientJevProvider({
      selectedProvider: pins.provider,
      // Frozen PS.2d transport policy spread LAST: no env variable can override it.
      config: { ...envConfig, transportChain: [], ...PS2D_TRANSPORT_SETTINGS },
      modelOverride: null,
      timeoutMs: PS2D_TIMEOUT_MS,
      healthRoot: crossAssetHealthRoot,
    });
    crossAsset = {
      profile: settings.crossAssetProfile,
      provider: crossAssetResilient.provider,
      providerIdentity: { provider: pins.provider, model: pins.model, upstream: pins.identity?.upstreamProvider ?? null },
    };
  }

  const observer = createSupervisorProposalObserver({
    sessionId,
    sessionRoot,
    baseRoot,
    provider,
    providerIdentity: {
      provider: pins.provider,
      model: pins.model,
      upstream: pins.identity?.upstreamProvider ?? null,
    },
    crossAsset,
    localTev,
    onRow:
      args.json === true
        ? null
        : (row) => {
            const p = Number.isFinite(row.pHigher) ? row.pHigher.toFixed(4) : "n/a";
            console.log(
              `[jev:supervisor] ${String(row.action ?? "?").padEnd(9)} ${String(row.reason ?? "?").padEnd(12)} ` +
                `${String(row.symbol ?? "?").padEnd(6)} price=${row.referencePrice ?? "n/a"} ` +
                `evolve=${row.evolveDirectionalIntent ?? "—"} jev=${row.modelIntent ?? "—"} p=${p} ` +
                `agreement=${row.agreement ?? "—"} executed=${row.executed ? "yes" : "no"}`,
            );
          },
  });

  const engineConfig = createMarketConfig();

  let stopTimer = null;
  let reported = false;

  const report = () => {
    const snapshot = observer.snapshot();
    if (args.json === true) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            sessionId,
            root: sessionRoot,
            provider: pins.provider,
            model: pins.model,
            gatewayUsed: false,
            cacheEnabled: false,
            status: snapshot.status,
            counters: snapshot.counters,
            summary: observer.summary(),
            queue: snapshot.queue,
            crossAssetShadow: snapshot.crossAssetShadow,
            localTevShadow: snapshot.localTevShadow,
            observerFailures: snapshot.counters.observerFailures,
            paperOnly: true,
            developmentOnly: true,
            jevHasTradingAuthority: false,
          },
          null,
          2,
        ),
      );
      return;
    }
    const summary = observer.summary();
    console.log("");
    console.log(`${SUPERVISOR_LABEL} • ${SUPERVISOR_NO_AUTHORITY_TAG}`);
    console.log(`[jev:supervisor]   artifacts        ${sessionRoot}`);
    console.log(`[jev:supervisor]   status           ${snapshot.status}`);
    console.log(`[jev:supervisor]   provider/model   ${pins.provider} / ${pins.model} (gatewayUsed=false)`);
    console.log(`[jev:supervisor]   market           ${SUPERVISOR_MARKET_ID}`);
    console.log(`[jev:supervisor]   executed trades  ${snapshot.counters.executedTradeProposals} proposals · ${snapshot.counters.supportedProposals} supported · ${snapshot.counters.unsupportedProposals} unsupported (bypassed, counted, not queued)`);
    console.log(`[jev:supervisor]   Jev calls        ${snapshot.counters.jevCalls} · ok ${snapshot.counters.jevOk} · failures ${snapshot.counters.jevFailures}`);
    console.log(`[jev:supervisor]   agreement        ${snapshot.counters.agreementCount} agree · ${snapshot.counters.disagreementCount} disagree · ${snapshot.counters.exactHalfCount} exact 0.50`);
    console.log(`[jev:supervisor]   SOL opportunit.  ${snapshot.counters.solOpportunities} captured · ${snapshot.counters.solActuallySelected} selected · ${snapshot.counters.solNotSelected} not selected`);
    console.log(`[jev:supervisor]   SOL judgments    ${snapshot.counters.uniqueSolMarketStates} states · ${snapshot.counters.jevCallsForSolStates} calls · ${snapshot.counters.reusedJevJudgments} reused`);
    console.log(`[jev:supervisor]   SOL agreement    ${snapshot.counters.solAgreementCount} agree · ${snapshot.counters.solDisagreementCount} disagree · ${snapshot.counters.solExactHalfCount} exact 0.50`);
    console.log(`[jev:supervisor]   queue            depth ${snapshot.queue.depth} · high water ${snapshot.queue.highWatermark} · dropped ${snapshot.queue.dropped}`);
    console.log(`[jev:supervisor]   means            pHigher ${summary?.meanPHigher ?? "n/a"} · |p-0.50| ${summary?.meanDistanceFromHalf ?? "n/a"} · latency ${summary?.meanLatencyMs ?? "n/a"}ms`);
    const tx = snapshot.localTevShadow;
    if (tx) {
      console.log(`[jev:supervisor]   ${tx.label} • ${tx.authorityTag} • profile ${tx.profile}`);
      console.log(`[jev:supervisor]     scheduler      ${tx.bucketCount} buckets x ${tx.bucketMs / 60_000} min • max ${tx.perBucketMaxAdmissions}/bucket • max ${tx.globalMaxAdmissions}/run • run ${tx.runStartedAt ?? "—"}`);
      console.log(`[jev:supervisor]     classifier     ${tx.classifier.classifierId} (${tx.classifier.classifierRuntime}, tier ${tx.classifier.primaryTier}) • thinking ${tx.thinking.enabled ? "ON" : "OFF"} • readiness ${tx.localJev.readinessStatus}`);
      console.log(`[jev:supervisor]     opportunities  ${tx.counters.genuineProductionOpportunitiesObserved} genuine • ${tx.counters.schemaEligible} schema eligible • ${tx.counters.admitted} admitted • ${tx.counters.logicalCalls}/${tx.maxLogicalCallsPerRun} logical calls`);
      console.log(`[jev:supervisor]     routes         primary ${tx.counters.primaryResults} • escalated ${tx.counters.escalatedResults} • TypeSafe fallback ${tx.counters.fallbackResults} • abstain ${tx.counters.abstainResults} • failed ${tx.counters.failures} • malformed ${tx.counters.malformed} • unavailable ${tx.counters.unavailable}`);
      console.log(`[jev:supervisor]     physical       local attempts ${tx.counters.physicalLocalAttempts} • fallback attempts ${tx.counters.physicalFallbackAttempts} • total ${tx.counters.totalPhysicalAttempts} (ceiling ${tx.maxPhysicalAttemptsPerRun})`);
      console.log(`[jev:supervisor]     queue          depth ${tx.queue.depth} • high water ${tx.queue.highWatermark} • dropped ${tx.queue.dropped} • unsent ${tx.counters.unsentAtFinalize} • in flight ${tx.counters.inFlightAtFinalize}`);
      console.log(`[jev:supervisor]     temporal       span ${tx.temporal.admissionSpanSeconds ?? "—"}s • buckets with admissions ${tx.temporal.occupancy.bucketsWithAdmissions}/${tx.bucketCount} • empty ${tx.temporal.occupancy.emptyBuckets} • at cap ${tx.temporal.occupancy.bucketsAtCap}`);
      console.log(`[jev:supervisor]     latency (E2E) primary p50 ${tx.latency.groups.primaryTevResults.metrics.totalE2EMs.p50 ?? "—"}ms p95 ${tx.latency.groups.primaryTevResults.metrics.totalE2EMs.p95 ?? "—"}ms • all p50 ${tx.latency.groups.allLogicalRequests.metrics.totalE2EMs.p50 ?? "—"}ms`);
      // Score semantics are derived from the recorded evidence itself:
      // `sample_stability` is a vote-share stability proxy and NOT a calibrated
      // probability; a calibrated number exists only if the shared TypeSafe
      // fallback reported one.
      const scoreSemantics = tx.scoreSemantics ?? {};
      console.log(
        `[jev:supervisor]     TypeSafe as normal provider: ${tx.localJev.typeSafeIsNormalProvider ? "YES" : "no"} ` +
          `• score semantics: sample_stability vote shares are stability proxies, never calibrated probabilities ` +
          `• calibrated-probability records: ${scoreSemantics.calibratedProbabilityRecords ?? 0} (shared-stack reports only)`,
      );
    }
    const xa = snapshot.crossAssetShadow;
    if (xa) {
      console.log(`[jev:supervisor]   ${xa.label} • ${xa.authorityTag} • profile ${xa.profile}`);
      console.log(`[jev:supervisor]     opportunities  ${xa.counters.genuineProductionOpportunitiesObserved} genuine · ${xa.counters.schemaEligible} schema eligible · ${xa.counters.uniqueAssetsObserved} assets`);
      console.log(`[jev:supervisor]     suppressed     duplicate ${xa.counters.suppressedDuplicateDigest} · cooldown ${xa.counters.suppressedAssetCooldown} · per-asset cap ${xa.counters.suppressedPerAssetCap} · global cap ${xa.counters.suppressedGlobalCap}`);
      console.log(`[jev:supervisor]     Jev            queued ${xa.counters.queuedForJev} · calls ${xa.counters.jevCalls} (max ${xa.globalMaxJevCallsPerRun}) · ok ${xa.counters.jevOk} · failed ${xa.counters.jevFailures} · unsent ${xa.counters.unsentAtFinalize}`);
    }
    console.log(`[jev:supervisor]   observer failures ${snapshot.counters.observerFailures}`);
    console.log(`[jev:supervisor]   ${SUPERVISOR_STATEMENT}`);
    console.log(`[jev:supervisor]   ${SUPERVISOR_ISOLATION_STATEMENT}`);
  };

  const onShutdown = async (signal) => {
    if (stopTimer) clearTimeout(stopTimer);
    stopTimer = null;
    if (reported === true) return;
    reported = true;
    await observer.finalize({ status: signal === "SIGINT" || signal === "SIGTERM" ? "INTERRUPTED" : "COMPLETE" });
    report();
  };

  let handle = null;
  try {
    // The worker starts FIRST so no queued proposal is ever left unobserved.
    // `start()` returns the observer, not a promise: nothing awaits it, and the
    // simulation below never holds a reference to it.
    observer.start();
    handle = await startEngine({
      config: engineConfig,
      simulationOptions: { proposalObserver: observer },
      onShutdown,
    });

    console.log(`[jev:supervisor] session ${sessionId} -> ${sessionRoot}`);
    console.log(
      `[jev:supervisor] observing completed EVOLVE paper decisions for ${settings.durationMinutes} minute(s). ` +
        "Jev has no authority and is not awaited by the engine.",
    );

    stopTimer = setTimeout(() => {
      console.log("[jev:supervisor] bounded duration reached — finalizing observer summary.");
      void handle.stop("DURATION_COMPLETE");
    }, settings.durationMs);
  } catch (error) {
    await observer.finalize({ status: "FAILED" }).catch(() => {});
    throw error;
  }
}

main().catch((error) => {
  console.error("[jev:supervisor] failed:", error?.stack ?? error?.message ?? error);
  process.exitCode = 1;
});
