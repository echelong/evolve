/**
 * EVOLVE Phase 5I-PS.1 — forensic ANALYSIS ORCHESTRATOR.
 *
 * ONE explicit captured paper-shadow session in, one forensic artifact set out:
 *
 *   load (strict, read-only)
 *     -> source integrity contract (fail closed)
 *       -> probability diagnostics
 *         -> forward-return horizons + horizon metrics + probability buckets
 *           -> episode reconstruction + churn diagnostics + friction decomposition
 *             -> fixed friction verification through the engine
 *               -> five FROZEN counterfactual replays
 *                 -> digest audit + preservation proof
 *                   -> artifacts written into the separate forensic tree
 *
 * There is no network call, no provider construction, no Jev configuration, no
 * API key, and no execution capability anywhere on this path. The source session
 * is never written to and is proven byte-identical afterwards.
 *
 * PAPER ONLY / DEVELOPMENT ONLY / POST-HOC ONLY.
 */

import path from "node:path";

import { digestOf } from "../../lib/hash.mjs";
import { packetDigestOf, packetStateDigestOf } from "../direction/packet.mjs";
import { auditDigestIdentity } from "./audit.mjs";
import { analyzeChurn, decomposeFriction, reconstructEpisodes } from "./episodes.mjs";
import { buildCounterfactuals, PAPER_FORENSICS_RECORDED_BINARY } from "./counterfactuals.mjs";
import {
  PAPER_FORENSICS_BOUNDARY_NOTE,
  PAPER_FORENSICS_CLASSIFICATION,
  PAPER_FORENSICS_COUNTERFACTUAL_BANNER,
  PAPER_FORENSICS_EXCLUSION_NOTE,
  PAPER_FORENSICS_FILES,
  PAPER_FORENSICS_FORBIDDEN_WRITE_ROOTS,
  PAPER_FORENSICS_HORIZONS_SECONDS,
  PAPER_FORENSICS_KIND,
  PAPER_FORENSICS_LABEL,
  PAPER_FORENSICS_METRIC_BANNER,
  PAPER_FORENSICS_PHASE,
  PAPER_FORENSICS_POLICIES,
  PAPER_FORENSICS_ROOT_DIR,
  PAPER_FORENSICS_SCHEMA_VERSION,
  PAPER_FORENSICS_SOURCE_FILES,
  paperForensicsAnalysisIdFor,
  paperForensicsRootFor,
} from "./definition.mjs";
import { capNeverBinds, frozenPaperFriction, resolveFrictionModel } from "./friction.mjs";
import { analyzeHorizons, analyzeProbabilityBuckets } from "./horizons.mjs";
import { buildForensicsReport } from "./report.mjs";
import { analyzeSignal } from "./signal.mjs";
import { forensicMetadataDiagnostic, loadSourceSession, verifySourceIntegrity } from "./source.mjs";
import { preservationProof, snapshotPreservationTargets } from "./preservation.mjs";
import {
  ensurePaperForensicsDir,
  fileDigest,
  paperForensicsArtifactSetDigest,
  paperForensicsArtifactSnapshot,
  writePaperForensicsJson,
  writePaperForensicsText,
} from "./storage.mjs";

export const PAPER_FORENSICS_ANALYSIS_VERSION = 1;

/** The frozen policy definitions, persisted so the analysis is self-describing. */
export function frozenPolicyBlock() {
  return PAPER_FORENSICS_POLICIES.map((policy) => ({
    id: policy.id,
    label: policy.label,
    summary: policy.summary,
    definition: policy.definition,
    parameters: { ...policy.parameters },
    frozenBeforeResults: true,
  }));
}

/**
 * Analyze ONE explicitly named captured paper-shadow session.
 *
 * @param {{
 *   sessionId: string,
 *   out?: string|null,
 *   sourceRoot?: string|null,
 *   canonicalRoot?: string|null,
 *   projectRoot?: string,
 *   createdAt?: number,
 *   write?: boolean,
 * }} options
 */
export async function analyzePaperShadowSession({
  sessionId,
  out = null,
  sourceRoot = null,
  canonicalRoot = null,
  projectRoot = process.cwd(),
  createdAt = Date.now(),
  write = true,
} = {}) {
  const loaded = await loadSourceSession({ sessionId, sourceRoot });
  const preservationBefore = await snapshotPreservationTargets({ sessionId, sourceRoot, canonicalRoot });

  const integrity = verifySourceIntegrity({
    sessionId,
    root: loaded.root,
    session: loaded.session,
    summary: loaded.summary,
    events: loaded.events,
    digests: loaded.digests,
    bytes: loaded.bytes,
    parseProblems: loaded.parseProblems,
    loadProblems: loaded.problems,
  });

  const events = loaded.events;
  const metadata = forensicMetadataDiagnostic(loaded.session);

  // ---- FAIL CLOSED: a materially broken source is never analyzed ----------
  if (integrity.status !== "PASS") {
    return {
      ok: false,
      failClosed: true,
      reason: "source_integrity_failed",
      sessionId,
      sourceRoot: loaded.root,
      integrity,
      metadata,
      artifactsWritten: false,
      message:
        "Source integrity is materially broken. The capture was NOT analyzed, nothing was written, and nothing was repaired.",
    };
  }

  // ---- descriptive + forensic analytics (offline, chronological) ----------
  const signal = analyzeSignal({ session: loaded.session, summary: loaded.summary, events });
  const horizons = analyzeHorizons({ events, horizonsSeconds: PAPER_FORENSICS_HORIZONS_SECONDS });
  horizons.probabilityBuckets = analyzeProbabilityBuckets({ decisions: horizons.decisions });
  const episodes = reconstructEpisodes({ events });
  const churn = analyzeChurn({ events, episodes, summary: loaded.summary, signal });
  const frictionResolution = resolveFrictionModel({ events });
  const decomposition = decomposeFriction({ events, episodes, summary: loaded.summary });

  const friction = {
    version: 1,
    engineModule: "scripts/engine/paper.mjs",
    accountModule: "scripts/jev/paper-shadow/account.mjs",
    frozenDefaultModel: frozenPaperFriction(),
    modelUsed: frictionResolution.model,
    modelSource: frictionResolution.used,
    modelSourceReason: frictionResolution.reason,
    derivation: frictionResolution.derivation,
    reproductionWithDerivedModel: frictionResolution.reproductionWithDerived,
    reproductionWithFrozenDefault: frictionResolution.reproductionWithDefault,
    observationCount: frictionResolution.observations.length,
    observations: frictionResolution.observations,
    engineReuseVerified: frictionResolution.reproductionWithDefault?.ok === true,
    capNeverBindsForRecordedFills: frictionResolution.observations.every((observation) =>
      capNeverBinds({ model: frictionResolution.model, observation }),
    ),
    note:
      "Fixed paper defaults, independent of future observations. Every captured fill must reproduce; unsupported configurations fail closed. Legacy captures omit cap/liquidity settings, whose original values cannot be independently established.",
  };

  const sourceAccounting = {
    startingCash: loaded.session?.startingCash ?? loaded.summary?.startingCash ?? null,
    positionFraction: loaded.session?.positionFraction ?? null,
    intentThreshold: loaded.session?.intentThreshold ?? null,
  };

  const counterfactuals = buildCounterfactuals({
    events,
    friction: frictionResolution.model,
    positionFraction: sourceAccounting.positionFraction,
    startingCash: sourceAccounting.startingCash,
    summary: loaded.summary,
  });

  if (!friction.engineReuseVerified || counterfactuals.replayIntegrity?.ok !== true || decomposition.disagreementWithSourceAccounting || Math.abs(decomposition.accountingIdentityResidual) > 1e-9) {
    return { ok: false, failClosed: true, reason: "recorded_replay_integrity_failed",
      message: "Fixed engine settings do not reproduce the captured fills/actions/account; no artifacts written.",
      integrity, counterfactuals, friction, artifactsWritten: false };
  }

  integrity.checks.push({ id: "engine_replay_and_episode_accounting", ok: true, blocking: true,
    detail: "Every action, fill, intermediate account and final account reproduces within 1e-9 USD; episode accounting reconciles." });

  // ---- digest audit (§16) + preservation proof (§4) ----------------------
  const digestAudit = await auditDigestIdentity({
    root: projectRoot,
    packetDigestOf,
    packetStateDigestOf,
  });

  const preservationAfter = await snapshotPreservationTargets({ sessionId, sourceRoot, canonicalRoot });
  const preservation = preservationProof({ before: preservationBefore, after: preservationAfter });
  const sourceFileDigestsAfter = {
    session: await fileDigest(path.join(loaded.root, PAPER_FORENSICS_SOURCE_FILES[0])),
    summary: await fileDigest(path.join(loaded.root, PAPER_FORENSICS_SOURCE_FILES[1])),
    events: await fileDigest(path.join(loaded.root, PAPER_FORENSICS_SOURCE_FILES[2])),
  };
  const digestsStable =
    sourceFileDigestsAfter.session === loaded.digests.session &&
    sourceFileDigestsAfter.summary === loaded.digests.summary &&
    sourceFileDigestsAfter.events === loaded.digests.events;

  if (!preservation.ok || !digestsStable) {
    return { ok: false, failClosed: true, reason: "source_changed_during_analysis", artifactsWritten: false };
  }
  const analysisId = paperForensicsAnalysisIdFor({ sourceDigest: loaded.digests.source, createdAt });
  const baseRoot = out ?? PAPER_FORENSICS_ROOT_DIR;
  const root = paperForensicsRootFor(baseRoot, analysisId);
  const recordedReplay = counterfactuals.policies.find((policy) => policy.policyId === PAPER_FORENSICS_RECORDED_BINARY) ?? null;

  const manifest = {
    schemaVersion: PAPER_FORENSICS_SCHEMA_VERSION,
    phase: PAPER_FORENSICS_PHASE,
    kind: PAPER_FORENSICS_KIND,
    analysisId,
    label: PAPER_FORENSICS_LABEL,
    ...PAPER_FORENSICS_CLASSIFICATION,
    boundaryNote: PAPER_FORENSICS_BOUNDARY_NOTE,
    exclusionNote: PAPER_FORENSICS_EXCLUSION_NOTE,
    accountingNote: "Simulated paper accounting. Not replication evidence. Not profitability evidence.",
    createdAt: new Date(createdAt).toISOString(),
    analyzerVersion: PAPER_FORENSICS_ANALYSIS_VERSION,
    source: {
      sessionId,
      root: loaded.root,
      files: PAPER_FORENSICS_SOURCE_FILES,
      bytes: loaded.bytes,
      digests: loaded.digests,
      identityDigest: loaded.digests.source,
      digestsStableAfterAnalysis: digestsStable,
      mutated: false,
      repairPerformed: false,
    },
    sourceClassification: {
      purpose: loaded.session?.purpose ?? null,
      status: loaded.session?.status ?? null,
      paperOnly: loaded.session?.paperOnly === true,
      developmentOnly: true,
      canonicalEvidence: loaded.session?.canonicalEvidence === true,
      replicationEvidence: loaded.session?.replicationEvidence === true,
      temporalReplicationEvidence: loaded.session?.temporalReplicationEvidence === true,
      arenaEligible: loaded.session?.arenaEligible === true,
      deploymentEligible: loaded.session?.deploymentEligible === true,
    },
    integrityStatus: integrity.status,
    metadataDiagnostic: metadata,
    digestAudit: {
      conclusion: digestAudit.conclusion,
      defectFound: digestAudit.defectFound,
      fixApplied: digestAudit.fixApplied,
      sealedContractsTouched: digestAudit.sealedContractsTouched,
    },
    engineReuse: {
      fillEngine: "scripts/engine/paper.mjs",
      paperAccount: "scripts/jev/paper-shadow/account.mjs",
      recordedPolicy: "scripts/jev/paper-shadow/policy.mjs",
      directReuse: true,
      reimplementedEngine: false,
    },
    horizonsSeconds: [...PAPER_FORENSICS_HORIZONS_SECONDS],
    policies: frozenPolicyBlock(),
    counterfactualBanner: [...PAPER_FORENSICS_COUNTERFACTUAL_BANNER],
    metricBanner: PAPER_FORENSICS_METRIC_BANNER,
    isolation: {
      root: PAPER_FORENSICS_ROOT_DIR,
      writesOnlyInto: root,
      forbiddenWriteRoots: [...PAPER_FORENSICS_FORBIDDEN_WRITE_ROOTS],
      networkCalls: 0,
      providerConstructed: false,
      apiKeyRequired: false,
      walletCapability: "none",
      signingCapability: "none",
      executionCapability: "none",
    },
    preservation,
    artifacts: [...Object.values(PAPER_FORENSICS_FILES)],
  };

  const integrityArtifact = {
    schemaVersion: PAPER_FORENSICS_SCHEMA_VERSION,
    analysisId,
    sessionId,
    sourceDigests: loaded.digests,
    fileDigestsAfterAnalysis: sourceFileDigestsAfter,
    digestsStableAfterAnalysis: digestsStable,
    integrity,
    metadataDiagnostic: metadata,
    digestAudit,
    preservation,
    classification: PAPER_FORENSICS_CLASSIFICATION,
    notes: [
      "The integrity contract is computed from the captured bytes alone. Nothing was repaired, normalized, or rewritten.",
      "A source whose integrity is materially broken is never analyzed: the analyzer fails closed.",
    ],
  };

  const episodesArtifact = {
    schemaVersion: PAPER_FORENSICS_SCHEMA_VERSION,
    analysisId,
    sessionId,
    expectedEntries: loaded.summary?.enterCount ?? null,
    expectedExits: loaded.summary?.exitCount ?? null,
    reconstructedRoundTrips: episodes.filter((episode) => episode.status === "COMPLETE").length,
    reconstructionDisagreesWithSource:
      decomposition.disagreementWithSourceAccounting ||
      churn.entriesMatchSource !== true ||
      churn.exitsMatchSource !== true,
    mappingComplete:
      episodes.length === (loaded.summary?.enterCount ?? -1) &&
      episodes.filter((episode) => episode.status === "COMPLETE").length === (loaded.summary?.exitCount ?? -1),
    episodes,
    frictionDecomposition: decomposition,
    churn,
    notes: [
      "Every recorded paper round trip is reconstructed from the captured events; a disagreement with the source accounting is flagged, never repaired.",
      "Break-even movement is an observation, never a recommended threshold.",
    ],
  };

  const reportCsv = buildForensicsReport({
    analysisId,
    sessionId,
    events,
    episodes,
    horizons,
    counterfactuals,
    decomposition,
  });

  // ---- write the artifact set (separate tree, guarded, atomic) ------------
  if (write) {
    await ensurePaperForensicsDir(root, baseRoot);
    await writePaperForensicsJson(root, PAPER_FORENSICS_FILES.manifest, manifest);
    await writePaperForensicsJson(root, PAPER_FORENSICS_FILES.integrity, integrityArtifact);
    await writePaperForensicsJson(root, PAPER_FORENSICS_FILES.signal, { ...signal, analysisId, schemaVersion: PAPER_FORENSICS_SCHEMA_VERSION });
    await writePaperForensicsJson(root, PAPER_FORENSICS_FILES.horizons, {
      ...horizons,
      analysisId,
      schemaVersion: PAPER_FORENSICS_SCHEMA_VERSION,
    });
    await writePaperForensicsJson(root, PAPER_FORENSICS_FILES.episodes, episodesArtifact);
    await writePaperForensicsJson(root, PAPER_FORENSICS_FILES.friction, {
      ...friction,
      analysisId,
      schemaVersion: PAPER_FORENSICS_SCHEMA_VERSION,
      frictionDecomposition: decomposition,
    });
    await writePaperForensicsJson(root, PAPER_FORENSICS_FILES.counterfactuals, {
      ...counterfactuals,
      analysisId,
      schemaVersion: PAPER_FORENSICS_SCHEMA_VERSION,
      sourceAccounting,
      measuredHorizons: [...PAPER_FORENSICS_HORIZONS_SECONDS],
      preservedSourceDigests: loaded.digests,
      preservationProven: preservation.ok,
    });
    await writePaperForensicsText(root, PAPER_FORENSICS_FILES.report, reportCsv);
  }

  const artifactSnapshot = write ? await paperForensicsArtifactSnapshot(root) : [];
  const artifactSetDigest = write ? paperForensicsArtifactSetDigest(artifactSnapshot) : null;
  const digestOfArtifact = (filename) => artifactSnapshot.find((entry) => entry.file === filename)?.digest ?? null;

  const summary = {
    schemaVersion: PAPER_FORENSICS_SCHEMA_VERSION,
    phase: PAPER_FORENSICS_PHASE,
    kind: PAPER_FORENSICS_KIND,
    analysisId,
    label: PAPER_FORENSICS_LABEL,
    ...PAPER_FORENSICS_CLASSIFICATION,
    createdAt: new Date(createdAt).toISOString(),
    sourceSessionId: sessionId,
    sourceIdentityDigest: loaded.digests.source,
    integrity: integrity.status,
    decisions: events.length,
    pHigher: {
      mean: signal.mean,
      median: signal.median,
      stddev: signal.stddev,
      min: signal.min,
      max: signal.max,
      atHalf: signal.pHigherEqualsHalfCount,
      histogram: signal.histogram.bins.map((bin) => ({ label: bin.label, count: bin.count })),
    },
    intents: { higher: signal.higherCount, lower: signal.lowerCount, flips: signal.intentFlips },
    horizons: horizons.horizonMetrics.map((metrics) => ({
      seconds: metrics.requestedHorizonSeconds,
      n: metrics.n,
      unavailable: metrics.unavailable,
      directionalAccuracy: metrics.directionalAccuracy,
      brierScore: metrics.brierScore,
      logLoss: metrics.logLoss,
      meanForwardReturnAfterJevHigher: metrics.meanForwardReturnAfterJevHigher,
      meanForwardReturnAfterJevLower: metrics.meanForwardReturnAfterJevLower,
    })),
    roundTrips: decomposition.closedRoundTrips,
    grossPnl: decomposition.totalGrossPnl,
    costs: decomposition.totalSimulatedCosts,
    netPnl: decomposition.totalNetPnl,
    friction: {
      fees: decomposition.fees,
      executionSlippageAdverseCost: decomposition.executionSlippageAdverseCost,
      costOverStartingBankroll: decomposition.costOverStartingBankroll,
      costOverTradedNotional: decomposition.costOverTradedNotional,
      observedBreakEvenMovementMean: decomposition.observedBreakEvenMovement.descriptive.mean,
      modelSource: frictionResolution.used,
      engineReuseVerified: friction.engineReuseVerified,
    },
    churn: {
      paperEntries: churn.paperEntries,
      paperExits: churn.paperExits,
      roundTrips: churn.roundTrips,
      meanHoldMs: churn.meanHoldMs,
      medianHoldMs: churn.medianHoldMs,
      minHoldMs: churn.minHoldMs,
      maxHoldMs: churn.maxHoldMs,
      timeLongShare: churn.timeLongShare,
      timeFlatShare: churn.timeFlatShare,
      exitsWithin30sOfEntry: churn.exitsWithin30sOfEntry,
      selectedExplanation: null,
    },
    counterfactuals: counterfactuals.policies.map((policy) => ({
      policyId: policy.policyId,
      entries: policy.entries,
      exits: policy.exits,
      roundTrips: policy.roundTrips,
      timeInMarketMs: policy.timeInMarketMs,
      endingEquity: policy.endingEquity,
      grossPnl: policy.grossPnl,
      costs: policy.costs,
      netPnl: policy.netPnl,
      maxDrawdown: policy.maxDrawdown,
      turnoverNotional: policy.turnoverNotional,
      meanHoldingMs: policy.meanHoldingMs,
    })),
    counterfactualBanner: [...PAPER_FORENSICS_COUNTERFACTUAL_BANNER],
    metricBanner: PAPER_FORENSICS_METRIC_BANNER,
    recordedBinaryReproducesAccount: recordedReplay !== null && counterfactuals.replayIntegrity?.ok === true,
    replayIntegrity: counterfactuals.replayIntegrity,
    rankingPerformed: false,
    policySelected: false,
    noWinnerStatement: counterfactuals.noWinnerStatement,
    thresholdsDerived: null,
    parameterSelectionPerformed: false,
    profitabilityClaim: null,
    metadataDiagnostic: metadata,
    digestAudit: { conclusion: digestAudit.conclusion, defectFound: digestAudit.defectFound },
    preservation,
    artifacts: {
      files: artifactSnapshot.map((entry) => entry.file),
      setDigest: artifactSetDigest,
      digests: Object.fromEntries(artifactSnapshot.map((entry) => [entry.file, entry.digest])),
      manifestDigest: digestOfArtifact(PAPER_FORENSICS_FILES.manifest),
      integrityDigest: digestOfArtifact(PAPER_FORENSICS_FILES.integrity),
    },
    closingBanner: [
      "POST-HOC DEVELOPMENT ANALYSIS ONLY",
      "NO WINNER / NO PARAMETER SELECTION / NO PROFITABILITY CLAIM",
    ],
    note:
      "Deterministic post-hoc forensic analysis of ONE captured paper-shadow session. Not replication evidence, not Arena or deployment evidence, and no profitability claim.",
  };

  if (write) {
    await writePaperForensicsJson(root, PAPER_FORENSICS_FILES.summary, summary);
  }

  const preservationAfterWrites = preservationProof({ before: preservationBefore,
    after: await snapshotPreservationTargets({ sessionId, sourceRoot, canonicalRoot }) });
  if (!preservationAfterWrites.ok) throw new Error("preservation failed after artifact writes");

  return {
    ok: true,
    failClosed: false,
    analysisId,
    root,
    baseRoot,
    sessionId,
    manifest,
    integrity: integrityArtifact,
    signal,
    horizons,
    episodes: episodesArtifact,
    friction,
    counterfactuals,
    summary,
    reportCsv,
    preservation,
    digestAudit,
    artifactsWritten: write,
  };
}

/** Digest of a forensic analysis id + its source identity, for cross-checks. */
export function analysisIdentityDigest(analysis) {
  return digestOf({
    analysisId: analysis?.analysisId ?? null,
    sessionId: analysis?.sessionId ?? null,
    sourceIdentityDigest: analysis?.manifest?.source?.identityDigest ?? null,
  });
}
