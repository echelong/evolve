/**
 * Phase 5I-PS.2e — the temporally distributed Local Tev supervisor shadow.
 *
 *   observeProductionEntry(facts)  SYNCHRONOUS passive tap (called by the engine
 *                                  through its protected wrapper): genuineness →
 *                                  schema → per-tick buffer → precommitted
 *                                  temporal scheduler → bounded queue push.
 *                                  Never awaits, never throws, returns nothing.
 *   processNext()                  ASYNCHRONOUS worker step (observer loop only):
 *                                  fail-closed policy/readiness/circuit checks →
 *                                  ONE logical shared-Local-JEV call → one bounded
 *                                  NDJSON record with its ACTUAL route.
 *   finalizeFlush()                graceful flush: queued-but-unsent items are
 *                                  recorded UNSENT_AT_FINALIZE with NO call.
 *
 * DEVELOPMENT SHADOW • ZERO AUTHORITY. Nothing here is ever returned to, or read
 * by, the engine, selection, evolution, fitness, the Arena or research.
 *
 * PAPER ONLY / SHADOW ONLY / DEVELOPMENT EVIDENCE ONLY.
 */

import { digestOf } from "../../lib/hash.mjs";
import {
  LOCAL_JEV_CLIENT_STATUS,
  assessLocalTevReadiness,
  classifyLocalJevOutcome,
  createLocalJevClient,
} from "./local-jev-client.mjs";
import {
  attachTemporalProvenance,
  buildTevOpportunityPacket,
  localTevCompleteInput,
  localTevInputDigestOf,
  modelInputDescriptorOf,
  requestStateLength,
  tevOpportunityDigestOf,
  validateGenuineProductionEntry,
} from "./local-tev-packet.mjs";
import {
  PS2E_ABSTAIN_TOKEN,
  PS2E_LOCAL_JEV_INVOCATION,
  buildLocalTevQuestions,
  localTevQuestionDigest,
} from "./local-tev-questions.mjs";
import { createLocalTevScheduler } from "./local-tev-scheduler.mjs";
import {
  PS2E_AUTHORITY_TAG,
  PS2E_BUCKET_COUNT,
  PS2E_BUCKET_MS,
  PS2E_CIRCUIT_BREAKER,
  PS2E_DECISION_SOURCES,
  PS2E_DECISIONS,
  PS2E_DISPOSITIONS,
  PS2E_FLAGS,
  PS2E_LABEL,
  PS2E_LATENCY_GROUPS,
  PS2E_LOCAL_JEV_CONTRACT,
  PS2E_LOCAL_JEV_MODE,
  PS2E_LOGICAL_CALL_TIMEOUT_MS,
  PS2E_MAX_DASHBOARD_ASSET_ROWS,
  PS2E_MAX_FAILURE_REASON_LENGTH,
  PS2E_MAX_LOGICAL_CALLS_PER_RUN,
  PS2E_MAX_PERSISTED_ASSET_ROWS,
  PS2E_MAX_PERSISTED_ATTEMPTS_PER_RECORD,
  PS2E_MAX_PHYSICAL_ATTEMPTS_PER_RUN,
  PS2E_MISSING_LOCAL_JEV_INTERFACE,
  PS2E_OUTCOMES,
  PS2E_PACKET_LIMITATIONS,
  PS2E_PACKET_VERSION,
  PS2E_PER_BUCKET_MAX_ADMISSIONS,
  PS2E_PHASE,
  PS2E_PHYSICAL_ATTEMPT_CEILING_PER_LOGICAL_CALL,
  PS2E_PRIMARY_CLASSIFIER,
  PS2E_PROTOCOL_DIGEST,
  PS2E_PROTOCOL_ID,
  PS2E_PROTOCOL_VERSION,
  PS2E_QUESTION_ID,
  PS2E_QUESTION_SET_ID,
  PS2E_QUESTION_SET_VERSION,
  PS2E_RECENT_ROW_LIMIT,
  PS2E_RUN_WINDOW_MS,
  PS2E_SCHEMA_VERSION,
  PS2E_STATEMENT,
  PS2E_THINKING_RULE,
  PS2E_TICK_BUFFER_LIMIT,
  PS2E_UNAVAILABLE_MEASUREMENTS,
  classifierPolicyProblems,
  localTevProfileFor,
  physicalAttemptCeilingFor,
} from "./local-tev-protocol.mjs";
import { createBoundedObserverQueue } from "./queue.mjs";
import { appendSupervisorLocalTevObservation } from "./storage.mjs";
import { deepFreeze } from "./tap.mjs";

export const PS2E_OBSERVER_VERSION = 1;

/** The frozen token set: two classification tokens plus the reserved ABSTAIN. */
export const PS2E_ALLOWED_TOKENS = Object.freeze(["support", "do_not_support", PS2E_ABSTAIN_TOKEN]);

/** Metrics collected per latency group (each reported as count/mean/p50/p95/p99/min/max). */
export const PS2E_LATENCY_SERIES_METRICS = Object.freeze([
  "totalE2EMs",
  "localClientDispatchMs",
  "queueWaitMs",
  "packetBuildMs",
  "localJevReportedLatencyMs",
]);

/** The exact request fields sent to the shared implementation (provenance only). */
export const PS2E_REQUEST_FIELDS = Object.freeze(["id", "question_id", "state", "question", "choices", "allow_abstain", "risk"]);

/* ============================================================================
 * Latency statistics (bounded; no invented measurement)
 * ==========================================================================*/

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(fraction * sorted.length)));
  return sorted[rank - 1];
}

/**
 * count / mean / p50 / p95 / p99 / min / max for one metric series. A metric the
 * runtime cannot provide is reported as null, never as 0.
 */
export function localTevLatencyStats(values) {
  const finite = (values ?? []).filter((value) => typeof value === "number" && Number.isFinite(value) && value >= 0);
  if (finite.length === 0) {
    return { count: 0, mean: null, p50: null, p95: null, p99: null, min: null, max: null };
  }
  const sorted = [...finite].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return {
    count: sorted.length,
    mean: Number(mean.toFixed(3)),
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

/** Bounded series: older samples are dropped, never unbounded memory. */
function createBoundedSeries(limit = 240) {
  const values = [];
  return {
    push(value) {
      values.push(value);
      if (values.length > limit) values.shift();
    },
    values: () => [...values],
  };
}

function bounded(text, limit = PS2E_MAX_FAILURE_REASON_LENGTH) {
  return typeof text === "string" ? text.slice(0, limit) : null;
}

function iso(ms) {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function zeroLatencySeries() {
  return Object.fromEntries(PS2E_LATENCY_SERIES_METRICS.map((metric) => [metric, createBoundedSeries()]));
}

/**
 * Augment a readiness report with the projection fields the session records need
 * (executable resolution source, config digest, acceptance policy). Read-only.
 */
export function augmentReadinessForSession(readiness, projection, { classifierIdentityDigest = null } = {}) {
  const configDigest =
    projection?.config?.found === true
      ? digestOf({
          mode: projection.config.mode,
          jevFallbackEnabled: projection.config.jevFallbackEnabled,
          tiers: projection.config.tiers,
          local: projection.config.local,
          inference: projection.config.inference ?? null,
          acceptance: projection.config.acceptance,
        })
      : null;
  return {
    ...readiness,
    classifierIdentityDigest: readiness?.classifierIdentityDigest ?? classifierIdentityDigest,
    executableSource: projection?.executable?.source ?? null,
    executableFound: projection?.executable?.found ?? null,
    configDigest,
    acceptance: projection?.config?.acceptance ?? null,
    escalationTiers: readiness?.escalationTiers ?? [],
  };
}

/**
 * Fail-closed self-check of the frozen PS.2e call policy: a policy that could
 * substitute a generic model as the primary classifier, fall back to a remote
 * provider, fail open or exceed its bounds makes NO call.
 */
export function localTevPolicyProblems({ policy, readiness }) {
  const problems = [];
  for (const problem of classifierPolicyProblems(PS2E_PRIMARY_CLASSIFIER)) {
    problems.push(`frozen classifier pin: ${problem}`);
  }
  if (!policy || typeof policy !== "object") {
    problems.push("a classifier policy is required");
    return problems;
  }
  if (policy.classifierMode !== PS2E_LOCAL_JEV_MODE) problems.push("the classifier policy must use the shared local-first mode");
  if (policy.thinkingEnabled !== false) problems.push("thinking must be OFF for the specialized classifier");
  if (policy.classifierKind !== "specialized-option-token-classifier") {
    problems.push("the classifier must be the specialized option-token classifier, never a generic local model");
  }
  if (policy.grammarConstrainedOptionTokens !== true) {
    problems.push("the classifier answer must stay inside the frozen option-token grammar");
  }
  if (policy.abstainIsProtocolOutcome !== true) {
    problems.push("ABSTAIN must remain a protocol outcome of the shared contract");
  }
  // NOTE: classifier AVAILABILITY is a readiness outcome (recorded per admitted
  // observation as SKIPPED_PRIMARY_CLASSIFIER_UNAVAILABLE), not a policy defect.
  const ceiling = readiness?.physicalAttemptCeilingPerLogicalCall ?? PS2E_PHYSICAL_ATTEMPT_CEILING_PER_LOGICAL_CALL;
  if (!(Number.isInteger(ceiling) && ceiling > 0 && ceiling <= PS2E_PHYSICAL_ATTEMPT_CEILING_PER_LOGICAL_CALL)) {
    problems.push("the derived physical-attempt ceiling is outside the frozen bound");
  }
  if (PS2E_LOGICAL_CALL_TIMEOUT_MS <= 0) problems.push("the logical call timeout must be positive");
  return problems;
}

/**
 * @param {{
 *   sessionId: string,
 *   root: string,
 *   profileName: string,
 *   allowOfflineValidation?: boolean,
 *   classifierPolicy: object,
 *   localJevProjection?: object|null,
 *   readiness?: object|null,
 *   transport?: object|null,
 *   client?: object|null,
 *   writeArtifacts: boolean,
 *   waitForStorage: () => Promise<void>,
 *   noteObserverError: (error: unknown) => void,
 *   now?: () => number,
 *   nowMs?: () => number,
 *   runStartedAtMs?: number|null,
 * }} options
 */
export function createLocalTevShadow({
  sessionId,
  root,
  profileName,
  allowOfflineValidation = false,
  classifierPolicy,
  localJevProjection = null,
  readiness = null,
  transport = null,
  client = null,
  writeArtifacts,
  waitForStorage,
  noteObserverError,
  now = () => Date.now(),
  nowMs = null,
  runStartedAtMs = null,
}) {
  if (!classifierPolicy || typeof classifierPolicy !== "object") {
    throw new Error("PS.2e requires an explicit classifier policy (no implicit default may change the primary model)");
  }
  const profile = localTevProfileFor(profileName, { allowOfflineValidation });
  if (profile === null) throw new Error(`unknown PS.2e profile '${profileName}'`);

  const monoNow = typeof nowMs === "function" ? nowMs : now;
  const windowStartedAtMs = Number.isFinite(runStartedAtMs) ? runStartedAtMs : now();
  const questions = deepFreeze(buildLocalTevQuestions());
  const questionDigest = localTevQuestionDigest();
  const classifierIdentity = {
    classifierId: classifierPolicy.classifierId,
    classifierFamily: classifierPolicy.classifierFamily,
    classifierKind: classifierPolicy.classifierKind,
    classifierRuntime: classifierPolicy.classifierRuntime,
    classifierProvider: classifierPolicy.classifierProvider,
    classifierMode: classifierPolicy.classifierMode,
    primaryTier: classifierPolicy.primaryTier,
    thinkingEnabled: classifierPolicy.thinkingEnabled === true,
    pinnedModel: classifierPolicy.pinnedModel ?? null,
    pinnedModelSha256: classifierPolicy.pinnedModelSha256 ?? null,
    available: classifierPolicy.available === true,
  };
  const classifierIdentityDigest = digestOf(classifierIdentity);
  const baseReadiness =
    readiness ??
    (localJevProjection !== null
      ? assessLocalTevReadiness({ projection: localJevProjection, policy: classifierPolicy })
      : {
          status: classifierPolicy.available === true ? "READY" : "PRIMARY_CLASSIFIER_UNAVAILABLE",
          ready: classifierPolicy.available === true,
          problems: classifierPolicy.available === true ? [] : [bounded(classifierPolicy.unavailableReason)],
          primaryIdentity: null,
          escalationTiers: [],
          typesafeFallbackEnabled: false,
          localTierCount: 0,
          maxLocalRetries: 0,
          physicalAttemptCeilingPerLogicalCall: physicalAttemptCeilingFor({}),
          derivedWorstCaseLogicalMs: null,
          timeoutBounds: null,
          classifierIdentityDigest,
          routingDigest: null,
        });
  const resolvedReadiness = augmentReadinessForSession(baseReadiness, localJevProjection, { classifierIdentityDigest });
  const policyProblems = localTevPolicyProblems({ policy: classifierPolicy, readiness: resolvedReadiness });

  const localClient =
    client ??
    createLocalJevClient({
      transport:
        transport ??
        {
          kind: "unavailable",
          description: null,
          dispatch: () =>
            Promise.resolve({
              status: "TRANSPORT_SPAWN_FAILED",
              exitCode: null,
              error: "no Local JEV transport was provided",
              stdout: "",
              stderr: "",
            }),
        },
      policy: classifierPolicy,
      logicalTimeoutMs: PS2E_LOGICAL_CALL_TIMEOUT_MS,
      stateLengthOf: requestStateLength,
      nowMs: monoNow,
    });

  const protocolBlock = Object.freeze({
    phase: PS2E_PHASE,
    protocolId: PS2E_PROTOCOL_ID,
    protocolVersion: PS2E_PROTOCOL_VERSION,
    protocolDigest: PS2E_PROTOCOL_DIGEST,
    schemaVersion: PS2E_SCHEMA_VERSION,
    packetVersion: PS2E_PACKET_VERSION,
    evidenceClassification: PS2E_FLAGS.evidenceClassification,
  });
  const routingBlock = Object.freeze({
    mode: classifierPolicy.classifierMode,
    logicalTimeoutMs: PS2E_LOGICAL_CALL_TIMEOUT_MS,
    transportKind: localClient.transport?.kind ?? null,
    executableSource: resolvedReadiness.executableSource,
    invocation: PS2E_LOCAL_JEV_INVOCATION,
    localJevConfigDigest: resolvedReadiness.configDigest,
    requestFieldSet: PS2E_REQUEST_FIELDS,
    maxStateChars: PS2E_LOCAL_JEV_CONTRACT.maxStateChars,
    retriesAddedByPs2e: 0,
  });
  const classifierBlock = Object.freeze({
    ...classifierIdentity,
    classifierIdentityDigest,
    routingDigest: resolvedReadiness.routingDigest,
    primaryIdentity: resolvedReadiness.primaryIdentity,
    escalationTiers: resolvedReadiness.escalationTiers,
    typesafeFallbackEnabled: resolvedReadiness.typesafeFallbackEnabled,
    acceptance: resolvedReadiness.acceptance,
  });
  // The EFFECTIVE model-inference settings per shared decision-tier slot,
  // resolved from the SAME shared configuration the child will execute against
  // (tier overrides, `local` inheritance and shared defaults included — never
  // raw config syntax). They materially alter the inference request, so they are
  // digested with the complete model-visible input; the block is null when no
  // shared configuration was projected (offline fixtures).
  const inferenceSampling =
    localJevProjection?.config?.inference != null
      ? { primaryTier: classifierPolicy.primaryTier, tiers: localJevProjection.config.inference }
      : null;
  const inferenceClassifierConfig = localJevProjection?.config?.tiers?.[classifierPolicy.primaryTier]?.classifier ?? null;

  const scheduler = createLocalTevScheduler({ profile, runStartedAtMs: windowStartedAtMs });

  const counters = {
    queuedForLocalJev: 0,
    queueDropped: 0,
    processed: 0,
    logicalCalls: 0,
    primaryResults: 0,
    primaryAbstainResults: 0,
    primaryIdentityMismatch: 0,
    escalatedResults: 0,
    fallbackResults: 0,
    abstainedWithoutAcceptedTier: 0,
    abstainResults: 0,
    failures: 0,
    malformed: 0,
    unavailable: 0,
    skippedPolicyInvalid: 0,
    skippedPrimaryClassifierUnavailable: 0,
    skippedLocalJevUnavailable: 0,
    skippedCircuitOpen: 0,
    skippedRequestTooLarge: 0,
    unsentAtFinalize: 0,
    inFlightAtFinalize: 0,
    finalizeTimedOut: false,
    lateCompletionsIgnored: 0,
    tapErrors: 0,
    tapErrorsUnaccounted: 0,
    samplingErrors: 0,
    tickBufferEarlyFlushes: 0,
    recordWriteFailures: 0,
    circuitBreakerTrips: 0,
    physicalLocalAttempts: 0,
    physicalFallbackAttempts: 0,
    totalPhysicalAttempts: 0,
    // Score semantics accounting (a vote share is never a probability).
    sampleStabilityRecords: 0,
    calibratedProbabilityRecords: 0,
    // A malformed source never keeps a directional decision (always 0 unless a
    // record had to be coerced to stay coherent).
    recordConsistencyCoercions: 0,
    // Honest accounting: a call whose answer was unreadable reports no attempt
    // list, so its physical attempt count is UNKNOWN rather than invented.
    logicalCallsWithoutReadableAttempts: 0,
  };
  const providerStatusCounts = {};
  let accepting = true;
  let closed = false;
  let inFlight = null;
  let pendingRecords = [];
  let recentRows = [];
  let tickBuffer = [];
  let tickBufferKey = null;
  let lastTickKey = null;
  let engineTickOrdinal = 0;
  let opportunitySequence = 0;
  const breaker = { consecutiveFailures: 0, openUntilMs: null, halfOpen: false };
  const series = Object.fromEntries(PS2E_LATENCY_GROUPS.map((group) => [group, zeroLatencySeries()]));
  const coldOrWarm = { cold: 0, warm: 0, unknown: 0 };

  const queue = createBoundedObserverQueue({
    capacity: profile.queueCapacity,
    onDrop: (item) => {
      counters.queueDropped += 1;
      scheduler.noteDisposition({ baseMint: item.identity.baseMint, bucketIndex: item.bucketIndex, disposition: "queueDropped" });
      pendingRecords.push(
        recordFor(item, {
          disposition: PS2E_DISPOSITIONS.QUEUE_DROPPED,
          decision: PS2E_OUTCOMES.UNAVAILABLE,
          decisionSource: PS2E_DECISION_SOURCES.LOCAL_JEV_UNAVAILABLE,
          providerStatus: "PS2E_QUEUE_DROPPED",
          failureReason: "the bounded PS.2e queue was at capacity; no call was made",
        }),
      );
    },
  });

  /* ======================================================================
   * THE PASSIVE TAP — synchronous, bounded, non-throwing, returns nothing
   * ====================================================================*/

  function observeProductionEntry(facts) {
    if (!accepting) return;
    let accounted = false;
    try {
      scheduler.noteFactReceived();
      const verdict = validateGenuineProductionEntry(facts);
      if (!verdict.genuine) {
        scheduler.noteNonGenuine(verdict.reason);
        accounted = true;
        return;
      }
      const atMs = facts.at;
      // Observer-assigned provenance: the smallest deterministic ordinal the
      // engine does not expose. Neither value is ever read by the engine.
      const tickKey = `${facts.generation}:${facts.generationTick}`;
      if (tickKey !== lastTickKey) {
        engineTickOrdinal += 1;
        lastTickKey = tickKey;
      }
      opportunitySequence += 1;
      const packetStartedAtMs = monoNow();
      const built = buildTevOpportunityPacket({ ...facts, engineTick: engineTickOrdinal, opportunitySequence });
      const packetBuildMs = Math.max(0, monoNow() - packetStartedAtMs);
      if (!built.ok) {
        scheduler.noteSchemaIneligible({ identity: built.identity, reason: built.reason, atMs });
        accounted = true;
        return;
      }
      const opportunityDigest = tevOpportunityDigestOf(built.packet);
      // A new engine tick means the previous one is complete: sample it first.
      if (tickBufferKey !== null && tickKey !== tickBufferKey) flushSampling();
      if (tickBuffer.length >= PS2E_TICK_BUFFER_LIMIT) {
        counters.tickBufferEarlyFlushes += 1;
        flushSampling();
      }
      tickBufferKey = tickKey;
      tickBuffer.push({
        identity: built.identity,
        packet: built.packet,
        opportunityDigest,
        proposalAtMs: atMs,
        capturedAtMs: now(),
        packetBuildMs,
        engineTick: engineTickOrdinal,
        opportunitySequence,
        agentId: built.packet.proposal.agentId,
        species: built.packet.proposal.species,
        generation: built.packet.proposal.generation,
        generationTick: built.packet.proposal.generationTick,
        lineageId: typeof facts.lineageId === "string" ? facts.lineageId.slice(0, 64) : null,
        researchFamilyId: typeof facts.researchFamilyId === "string" ? facts.researchFamilyId.slice(0, 64) : null,
      });
      accounted = true;
    } catch (error) {
      counters.tapErrors += 1;
      if (!accounted) counters.tapErrorsUnaccounted += 1;
      noteObserverError(error);
    }
  }

  /**
   * Apply the precommitted scheduler to the buffered (complete) tick in the
   * frozen within-tick order (ascending opportunity digest — never population or
   * fitness order), attach temporal provenance, and push admitted items to the
   * bounded queue. Synchronous.
   */
  function flushSampling() {
    if (tickBuffer.length === 0) {
      tickBufferKey = null;
      return;
    }
    const entries = tickBuffer;
    tickBuffer = [];
    tickBufferKey = null;
    entries.sort((a, b) => (a.opportunityDigest < b.opportunityDigest ? -1 : a.opportunityDigest > b.opportunityDigest ? 1 : 0));
    for (const entry of entries) {
      try {
        const decision = scheduler.decide({
          identity: entry.identity,
          opportunityDigest: entry.opportunityDigest,
          atMs: entry.proposalAtMs,
        });
        if (!decision.admitted) continue;
        const bucketIndex = decision.bucketIndex ?? 0;
        const packet = attachTemporalProvenance(entry.packet, {
          bucketIndex: decision.bucketIndex,
          bucketStartMs: windowStartedAtMs + bucketIndex * PS2E_BUCKET_MS,
          bucketEndMs: windowStartedAtMs + (bucketIndex + 1) * PS2E_BUCKET_MS,
          bucketAdmissionIndex: decision.bucketAdmissionIndex,
          globalAdmissionIndex: decision.globalAdmissionIndex,
          bucketCount: PS2E_BUCKET_COUNT,
          admissionRule: "PRECOMMITTED_TEMPORAL_BUCKET_SCHEDULE",
        });
        const completeInput = localTevCompleteInput({
          protocol: protocolBlock,
          classifier: classifierBlock,
          routing: routingBlock,
          questionSetId: PS2E_QUESTION_SET_ID,
          questionSetVersion: PS2E_QUESTION_SET_VERSION,
          questionId: PS2E_QUESTION_ID,
          question: questions.question,
          options: questions.options,
          allowAbstain: true,
          abstainDescription: questions.abstainDescription,
          risk: questions.risk,
          sampling: inferenceSampling,
          classifierConfig: inferenceClassifierConfig,
          packet,
          limitations: PS2E_PACKET_LIMITATIONS,
        });
        const item = {
          ...entry,
          packet,
          packetDigest: digestOf(packet),
          completeInput,
          // The bounded pre-response descriptor: with `packet` it is sufficient
          // to recompute `jevInputDigest` from stored evidence alone.
          modelInputDescriptor: modelInputDescriptorOf(completeInput),
          jevInputDigest: localTevInputDigestOf(completeInput),
          requestStateChars: requestStateLength(packet),
          bucketIndex: decision.bucketIndex,
          bucketAdmissionIndex: decision.bucketAdmissionIndex,
          globalAdmissionIndex: decision.globalAdmissionIndex,
          queuedAtMs: now(),
        };
        scheduler.noteAdmissionProvenance({
          atMs: entry.proposalAtMs,
          generation: entry.generation,
          generationTick: entry.generationTick,
          engineTick: entry.engineTick,
          opportunitySequence: entry.opportunitySequence,
        });
        if (queue.push(item)) {
          counters.queuedForLocalJev += 1;
          scheduler.noteDisposition({ baseMint: item.identity.baseMint, bucketIndex: item.bucketIndex, disposition: "queued" });
        }
      } catch (error) {
        counters.samplingErrors += 1;
        noteObserverError(error);
      }
    }
  }

  /* ======================================================================
   * Records — one bounded NDJSON line per ADMITTED observation
   * ====================================================================*/

  function recordFor(item, fields = {}) {
    const record = {
      schemaVersion: PS2E_SCHEMA_VERSION,
      recordType: "LOCAL_TEV_CROSS_ASSET_OBSERVATION",
      phase: PS2E_PHASE,
      protocolId: PS2E_PROTOCOL_ID,
      protocolVersion: PS2E_PROTOCOL_VERSION,
      protocolDigest: PS2E_PROTOCOL_DIGEST,
      ...PS2E_FLAGS,
      sessionId,
      profile: profile.profile,
      globalAdmissionIndex: item.globalAdmissionIndex,
      bucketAdmissionIndex: item.bucketAdmissionIndex,
      temporalBucketIndex: item.bucketIndex,
      temporalBucketStart: iso(item.bucketIndex === null ? null : windowStartedAtMs + item.bucketIndex * PS2E_BUCKET_MS),
      temporalBucketEnd: iso(item.bucketIndex === null ? null : windowStartedAtMs + (item.bucketIndex + 1) * PS2E_BUCKET_MS),
      engineTick: item.engineTick,
      opportunitySequence: item.opportunitySequence,
      assetKey: item.identity.baseMint,
      marketId: item.identity.marketId,
      baseMint: item.identity.baseMint,
      quoteMint: item.identity.quoteMint,
      symbol: item.identity.symbol,
      agentId: item.agentId,
      species: item.species,
      generation: item.generation,
      generationTick: item.generationTick,
      lineageId: item.lineageId,
      researchFamilyId: item.researchFamilyId,
      proposalAt: iso(item.proposalAtMs),
      capturedAt: iso(item.capturedAtMs),
      queuedAt: iso(item.queuedAtMs ?? null),
      packetVersion: PS2E_PACKET_VERSION,
      packet: item.packet,
      packetDigest: item.packetDigest ?? null,
      jevInputDigest: item.jevInputDigest ?? null,
      // The bounded canonical pre-response descriptor: with `packet` above it is
      // sufficient to independently recompute `jevInputDigest` from evidence.
      modelInputDescriptor: item.modelInputDescriptor ?? null,
      questionSetId: PS2E_QUESTION_SET_ID,
      questionSetVersion: PS2E_QUESTION_SET_VERSION,
      questionId: PS2E_QUESTION_ID,
      questionDigest,
      optionTokens: [...PS2E_ALLOWED_TOKENS],
      optionTokenCount: PS2E_ALLOWED_TOKENS.length,
      allowAbstain: true,
      abstainToken: PS2E_ABSTAIN_TOKEN,
      classifierId: classifierPolicy.classifierId,
      classifierFamily: classifierPolicy.classifierFamily,
      classifierKind: classifierPolicy.classifierKind,
      classifierRuntime: classifierPolicy.classifierRuntime,
      classifierProvider: classifierPolicy.classifierProvider,
      classifierMode: classifierPolicy.classifierMode,
      classifierPrimaryTier: classifierPolicy.primaryTier,
      classifierPinnedModel: classifierPolicy.pinnedModel ?? null,
      classifierPinnedModelSha256: classifierPolicy.pinnedModelSha256 ?? null,
      classifierIdentityDigest,
      thinkingEnabled: false,
      thinkingRule: PS2E_THINKING_RULE,
      localJevMode: PS2E_LOCAL_JEV_MODE,
      localJevCaller: "evolve",
      localJevTransportKind: localClient.transport?.kind ?? null,
      localJevReadinessStatus: resolvedReadiness.status,
      localJevConfigDigest: resolvedReadiness.configDigest,
      logicalCallTimeoutMs: PS2E_LOGICAL_CALL_TIMEOUT_MS,
      disposition: null,
      decision: null,
      decisionSource: null,
      acceptedTier: null,
      classifierModel: null,
      classifierModelSha256: null,
      classifierDigest: null,
      escalated: false,
      escalationReason: null,
      fallbackTier: null,
      fallbackProvider: null,
      fallbackModel: null,
      fallbackUsed: false,
      primaryIdentityMismatch: false,
      localAttemptCount: 0,
      fallbackAttemptCount: 0,
      totalPhysicalAttempts: 0,
      physicalAttemptsUnknown: false,
      attempts: [],
      failureReason: null,
      requestId: null,
      providerStatus: null,
      // ---- score semantics (never a probability unless one really exists) ----
      probabilityKind: "none",
      probabilities: null,
      calibratedProbability: null,
      sampleStability: null,
      decisionScore: null,
      probabilitiesAreCalibrated: false,
      probabilityFieldsAbsentOrNull: true,
      noFakeProbabilities: true,
      // ---- latency telemetry (every unavailable measurement stays null) ------
      latency: {
        queueWaitMs: null,
        packetBuildMs: item.packetBuildMs ?? null,
        localClientDispatchMs: null,
        localJevReportedLatencyMs: null,
        primaryAttemptLatencyMs: null,
        escalationLatencyMs: null,
        fallbackLatencyMs: null,
        totalE2EMs: null,
        coldOrWarm: null,
        unavailable: [...PS2E_UNAVAILABLE_MEASUREMENTS],
      },
      observerStartedAt: null,
      observerCompletedAt: null,
      packetBuildMs: item.packetBuildMs ?? null,
      rawAnswerDigest: null,
      note:
        "Temporally bounded development shadow observation of a genuine EVOLVE production entry proposal, answered " +
        "by the shared Local JEV stack. Zero authority: nothing here was, or can be, returned to the engine. The " +
        "classification is not correctness and no outcome is resolved.",
      ...fields,
    };
    // A MALFORMED provenance can never carry a valid directional/support
    // decision: observer evidence is semantically coherent by construction.
    if (
      record.decisionSource === PS2E_DECISION_SOURCES.MALFORMED &&
      (record.decision === PS2E_DECISIONS.SUPPORT ||
        record.decision === PS2E_DECISIONS.DO_NOT_SUPPORT ||
        record.decision === PS2E_DECISIONS.ABSTAIN)
    ) {
      counters.recordConsistencyCoercions += 1;
      record.decision = PS2E_OUTCOMES.MALFORMED;
      record.disposition = PS2E_DISPOSITIONS.MALFORMED;
      record.failureReason = bounded(
        `a malformed source never keeps a directional decision (record coerced): ${record.failureReason ?? "none"}`,
      );
    }
    return record;
  }

  async function writeRecord(record) {
    if (!writeArtifacts) return;
    try {
      await waitForStorage();
      await appendSupervisorLocalTevObservation(root, record);
    } catch (error) {
      counters.recordWriteFailures += 1;
      noteObserverError(error);
    }
  }

  async function flushPending() {
    if (pendingRecords.length === 0) return;
    const records = pendingRecords;
    pendingRecords = [];
    for (const record of records) await writeRecord(record);
  }

  function rememberRow(record) {
    recentRows = [
      ...recentRows,
      {
        at: record.observerCompletedAt ?? record.proposalAt,
        globalAdmissionIndex: record.globalAdmissionIndex,
        temporalBucketIndex: record.temporalBucketIndex,
        marketId: record.marketId,
        symbol: record.symbol,
        species: record.species,
        disposition: record.disposition,
        decision: record.decision,
        decisionSource: record.decisionSource,
        classifierModel: record.classifierModel,
        sampleStability: record.sampleStability,
      },
    ].slice(-PS2E_RECENT_ROW_LIMIT);
  }

  /* ======================================================================
   * Worker step — the ONLY place PS.2e ever waits
   * ====================================================================*/

  function breakerAllowsCall(atMs) {
    if (breaker.openUntilMs === null) return true;
    if (atMs < breaker.openUntilMs) return false;
    breaker.openUntilMs = null;
    breaker.halfOpen = true;
    return true;
  }

  function noteCallResult(ok, atMs) {
    if (ok) {
      breaker.consecutiveFailures = 0;
      breaker.halfOpen = false;
      return;
    }
    breaker.consecutiveFailures += 1;
    if (breaker.halfOpen || breaker.consecutiveFailures >= PS2E_CIRCUIT_BREAKER.failureThreshold) {
      breaker.openUntilMs = atMs + PS2E_CIRCUIT_BREAKER.cooldownMs;
      breaker.consecutiveFailures = 0;
      breaker.halfOpen = false;
      counters.circuitBreakerTrips += 1;
    }
  }

  function noteSkip(item, disposition, decisionSource, status, failureReason) {
    scheduler.noteDisposition({ baseMint: item.identity.baseMint, bucketIndex: item.bucketIndex, disposition: "unavailable" });
    const record = recordFor(item, {
      disposition,
      decision: PS2E_OUTCOMES.UNAVAILABLE,
      decisionSource,
      providerStatus: status,
      failureReason: bounded(failureReason),
    });
    rememberRow(record);
    return record;
  }

  function noteSeries(group, sample) {
    for (const metric of PS2E_LATENCY_SERIES_METRICS) {
      const value = sample[metric];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) series[group]?.[metric]?.push(value);
    }
  }

  async function processNext() {
    await flushPending();
    const item = queue.shift();
    if (item === null) return false;
    const baseMint = item.identity.baseMint;
    const bucketIndex = item.bucketIndex;
    counters.processed += 1;

    // FAIL CLOSED, re-checked before EVERY call. Each refusal is its own record.
    if (policyProblems.length > 0) {
      counters.skippedPolicyInvalid += 1;
      const record = noteSkip(
        item,
        PS2E_DISPOSITIONS.SKIPPED_POLICY_INVALID,
        PS2E_DECISION_SOURCES.SKIPPED_POLICY_INVALID,
        "PS2E_POLICY_INVALID",
        `the frozen PS.2e call policy failed its fail-closed check: ${policyProblems.join("; ")}`,
      );
      await writeRecord(record);
      return true;
    }
    if (resolvedReadiness.ready !== true) {
      const localUnavailable =
        resolvedReadiness.status === "LOCAL_JEV_UNAVAILABLE" ||
        resolvedReadiness.status === "LOCAL_JEV_TIMEOUT_BOUND_EXCEEDS_PS2E_BOUND";
      if (localUnavailable) {
        counters.skippedLocalJevUnavailable += 1;
        const record = noteSkip(
          item,
          PS2E_DISPOSITIONS.SKIPPED_LOCAL_JEV_UNAVAILABLE,
          PS2E_DECISION_SOURCES.SKIPPED_LOCAL_JEV_UNAVAILABLE,
          resolvedReadiness.status,
          `the shared Local JEV installation cannot serve PS.2e: ${resolvedReadiness.problems.join("; ")}`,
        );
        await writeRecord(record);
        return true;
      }
      counters.skippedPrimaryClassifierUnavailable += 1;
      const record = noteSkip(
        item,
        PS2E_DISPOSITIONS.SKIPPED_PRIMARY_CLASSIFIER_UNAVAILABLE,
        PS2E_DECISION_SOURCES.SKIPPED_PRIMARY_CLASSIFIER_UNAVAILABLE,
        resolvedReadiness.status,
        `the precommitted primary Tev-style classifier is unavailable: ${resolvedReadiness.problems.join("; ")}`,
      );
      await writeRecord(record);
      return true;
    }

    const startedAtMs = now();
    item.startedAtMs = startedAtMs;
    if (!breakerAllowsCall(startedAtMs)) {
      counters.skippedCircuitOpen += 1;
      const record = noteSkip(
        item,
        PS2E_DISPOSITIONS.SKIPPED_CIRCUIT_OPEN,
        PS2E_DECISION_SOURCES.SKIPPED_CIRCUIT_OPEN,
        "PS2E_CIRCUIT_OPEN",
        `circuit breaker open until ${iso(breaker.openUntilMs)}; no call was made`,
      );
      await writeRecord(record);
      return true;
    }

    const request = localClient.buildRequestFor({
      sessionId,
      packet: item.packet,
      globalAdmissionIndex: item.globalAdmissionIndex,
    });
    // The shared contract rejects an over-long state: refuse locally, with NO
    // call and NO logical-call accounting, rather than sending a truncated one.
    if (item.requestStateChars > PS2E_LOCAL_JEV_CONTRACT.maxStateChars) {
      counters.skippedRequestTooLarge += 1;
      scheduler.noteDisposition({ baseMint, bucketIndex, disposition: "unavailable" });
      const record = recordFor(item, {
        disposition: PS2E_DISPOSITIONS.SKIPPED_REQUEST_TOO_LARGE,
        decision: PS2E_OUTCOMES.UNAVAILABLE,
        decisionSource: PS2E_DECISION_SOURCES.SKIPPED_REQUEST_TOO_LARGE,
        providerStatus: LOCAL_JEV_CLIENT_STATUS.REQUEST_TOO_LARGE,
        failureReason: `request state is ${item.requestStateChars} chars; the shared contract allows ${PS2E_LOCAL_JEV_CONTRACT.maxStateChars}`,
        observerStartedAt: iso(startedAtMs),
        observerCompletedAt: iso(now()),
      });
      rememberRow(record);
      await writeRecord(record);
      return true;
    }

    // ONE logical call. The shared implementation owns tiers, retries and
    // escalation; PS.2e adds no second retry policy of its own.
    counters.logicalCalls += 1;
    scheduler.noteDisposition({ baseMint, bucketIndex, disposition: "logicalCalls" });
    inFlight = item;
    let dispatch = null;
    let thrown = null;
    try {
      dispatch = await localClient.dispatch({ request, stateLength: item.requestStateChars });
    } catch (error) {
      thrown = error;
    }
    inFlight = null;
    if (closed) {
      counters.lateCompletionsIgnored += 1;
      return true;
    }
    const completedAtMs = now();
    if (thrown !== null) {
      counters.failures += 1;
      scheduler.noteDisposition({ baseMint, bucketIndex, disposition: "failures" });
      noteCallResult(false, completedAtMs);
      const record = recordFor(item, {
        disposition: PS2E_DISPOSITIONS.FAILED,
        decision: PS2E_OUTCOMES.FAILED,
        decisionSource: PS2E_DECISION_SOURCES.FAILED,
        providerStatus: "PS2E_OBSERVER_ERROR",
        failureReason: bounded(`Local JEV client error: ${thrown?.message ?? thrown}`),
        observerStartedAt: iso(startedAtMs),
        observerCompletedAt: iso(completedAtMs),
      });
      rememberRow(record);
      await writeRecord(record);
      return true;
    }

    const classified = classifyLocalJevOutcome({
      validation: dispatch.validation,
      policy: classifierPolicy,
      clientStatus: dispatch.status,
    });
    const attempts = classified.escalationPath ?? [];
    const reportedMs = attempts
      .map((attempt) => attempt.latencyMs)
      .filter((value) => typeof value === "number" && Number.isFinite(value))
      .reduce((sum, value) => sum + value, 0);
    const primaryTierToken = String(classifierPolicy.primaryTier);
    const primaryAttempt = attempts.find((attempt) => attempt.tierToken === primaryTierToken) ?? null;
    const fallbackAttempt = attempts.find((attempt) => attempt.tierToken === "3") ?? null;
    const escalationMs = attempts
      .filter((attempt) => attempt.tierToken !== primaryTierToken)
      .map((attempt) => attempt.latencyMs)
      .filter((value) => typeof value === "number" && Number.isFinite(value))
      .reduce((sum, value) => sum + value, 0);
    const totalE2EMs = Math.max(0, completedAtMs - startedAtMs);
    const sample = {
      queueWaitMs: Math.max(0, startedAtMs - item.queuedAtMs),
      packetBuildMs: item.packetBuildMs,
      localClientDispatchMs: dispatch.dispatchMs,
      localJevReportedLatencyMs: reportedMs,
      primaryAttemptLatencyMs: primaryAttempt?.latencyMs ?? null,
      escalationLatencyMs: escalationMs > 0 ? escalationMs : null,
      fallbackLatencyMs: fallbackAttempt?.latencyMs ?? null,
      totalE2EMs,
    };

    counters.totalPhysicalAttempts += classified.totalPhysicalAttempts;
    counters.physicalLocalAttempts += classified.localAttemptCount;
    counters.physicalFallbackAttempts += classified.fallbackAttemptCount;
    if (classified.physicalAttemptsUnknown === true) counters.logicalCallsWithoutReadableAttempts += 1;

    const isClassification =
      classified.decision === PS2E_DECISIONS.SUPPORT ||
      classified.decision === PS2E_DECISIONS.DO_NOT_SUPPORT ||
      classified.decision === PS2E_DECISIONS.ABSTAIN;

    // The route counters partition every logical call EXACTLY once.
    if (classified.decisionSource === PS2E_DECISION_SOURCES.PRIMARY_TEV_CLASSIFIER) {
      counters.primaryResults += 1;
      scheduler.noteDisposition({ baseMint, bucketIndex, disposition: "primaryResults" });
    } else if (classified.primaryIdentityMismatch) {
      counters.primaryIdentityMismatch += 1;
      scheduler.noteDisposition({ baseMint, bucketIndex, disposition: "escalatedResults" });
    } else if (classified.decisionSource === PS2E_DECISION_SOURCES.ESCALATED_LOCAL_TIER) {
      counters.escalatedResults += 1;
      scheduler.noteDisposition({ baseMint, bucketIndex, disposition: "escalatedResults" });
    } else if (classified.decisionSource === PS2E_DECISION_SOURCES.FALLBACK_TYPESAFE_JEV) {
      counters.fallbackResults += 1;
      scheduler.noteDisposition({ baseMint, bucketIndex, disposition: "fallbackResults" });
    } else if (classified.decisionSource === PS2E_DECISION_SOURCES.ABSTAINED_WITHOUT_ACCEPTED_TIER) {
      counters.abstainedWithoutAcceptedTier += 1;
      scheduler.noteDisposition({ baseMint, bucketIndex, disposition: "abstainResults" });
    } else if (classified.decision === PS2E_OUTCOMES.FAILED) {
      counters.failures += 1;
      scheduler.noteDisposition({ baseMint, bucketIndex, disposition: "failures" });
    } else if (classified.decision === PS2E_OUTCOMES.MALFORMED) {
      counters.malformed += 1;
      scheduler.noteDisposition({ baseMint, bucketIndex, disposition: "malformed" });
    } else {
      counters.unavailable += 1;
      scheduler.noteDisposition({ baseMint, bucketIndex, disposition: "unavailable" });
    }

    // ABSTAIN is a protocol outcome and is counted once, cross-cutting the route.
    if (classified.decision === PS2E_DECISIONS.ABSTAIN) {
      counters.abstainResults += 1;
      if (classified.decisionSource === PS2E_DECISION_SOURCES.PRIMARY_TEV_CLASSIFIER) counters.primaryAbstainResults += 1;
    }
    providerStatusCounts[dispatch.status] = (providerStatusCounts[dispatch.status] ?? 0) + 1;
    if (classified.probabilityKind === "calibrated_probability") counters.calibratedProbabilityRecords += 1;
    else if (classified.probabilityKind === "sample_stability") counters.sampleStabilityRecords += 1;
    noteCallResult(isClassification, completedAtMs);

    // Latency groups: primary Tev results / escalated local results / TypeSafe
    // fallback results / all logical requests. Never merged.
    noteSeries("allLogicalRequests", sample);
    if (classified.decisionSource === PS2E_DECISION_SOURCES.PRIMARY_TEV_CLASSIFIER) noteSeries("primaryTevResults", sample);
    else if (classified.decisionSource === PS2E_DECISION_SOURCES.FALLBACK_TYPESAFE_JEV) noteSeries("typesafeFallbackResults", sample);
    else if (classified.decisionSource === PS2E_DECISION_SOURCES.ESCALATED_LOCAL_TIER || classified.primaryIdentityMismatch) {
      noteSeries("escalatedLocalResults", sample);
    }
    if (classified.coldOrWarm === "cold") coldOrWarm.cold += 1;
    else if (classified.coldOrWarm === "warm") coldOrWarm.warm += 1;
    else coldOrWarm.unknown += 1;

    const record = recordFor(item, {
      disposition: dispositionOf(classified.decision),
      decision: classified.decision,
      decisionSource: classified.decisionSource,
      acceptedTier: classified.acceptedTier,
      classifierModel: classified.classifierModel,
      classifierModelSha256: classified.classifierModelSha256,
      classifierDigest: digestOf({
        classifierIdentity,
        acceptedTier: classified.acceptedTier,
        model: classified.classifierModel,
        modelSha256: classified.classifierModelSha256,
      }),
      escalated: classified.escalated,
      escalationReason: classified.escalationReason,
      fallbackTier: classified.fallbackTier,
      fallbackProvider: classified.fallbackProvider,
      fallbackModel: classified.fallbackModel,
      fallbackUsed: classified.fallbackUsed,
      primaryIdentityMismatch: classified.primaryIdentityMismatch,
      localAttemptCount: classified.localAttemptCount,
      fallbackAttemptCount: classified.fallbackAttemptCount,
      totalPhysicalAttempts: classified.totalPhysicalAttempts,
      // True when the shared implementation's answer carried no readable attempt
      // list: the logical call happened, its physical routing is unknown.
      physicalAttemptsUnknown: classified.physicalAttemptsUnknown === true,
      attempts: attempts.slice(0, PS2E_MAX_PERSISTED_ATTEMPTS_PER_RECORD),
      failureReason: bounded(classified.failureReason),
      requestId: dispatch.validation?.outcome?.requestId ?? null,
      providerStatus: dispatch.validation?.status ?? dispatch.status,
      probabilityKind: classified.probabilityKind,
      probabilities: null,
      calibratedProbability: classified.decisionScore?.calibratedProbability ?? null,
      sampleStability: classified.decisionScore?.sampleStability ?? null,
      decisionScore: classified.decisionScore,
      // True ONLY when the shared implementation itself reported a calibrated
      // probability (the TypeSafe fallback tier). A local vote share is never
      // relabelled: `probabilities` stays null and the kind says what it is.
      probabilitiesAreCalibrated: classified.probabilityKind === "calibrated_probability",
      observerStartedAt: iso(startedAtMs),
      observerCompletedAt: iso(completedAtMs),
      rawAnswerDigest: dispatch.rawDigest ?? null,
      latency: { ...sample, coldOrWarm: classified.coldOrWarm, unavailable: [...PS2E_UNAVAILABLE_MEASUREMENTS] },
    });
    rememberRow(record);
    await writeRecord(record);
    return true;
  }

  function dispositionOf(decision) {
    if (decision === PS2E_DECISIONS.SUPPORT) return PS2E_DISPOSITIONS.SUPPORT;
    if (decision === PS2E_DECISIONS.DO_NOT_SUPPORT) return PS2E_DISPOSITIONS.DO_NOT_SUPPORT;
    if (decision === PS2E_DECISIONS.ABSTAIN) return PS2E_DISPOSITIONS.ABSTAIN;
    if (decision === PS2E_OUTCOMES.MALFORMED) return PS2E_DISPOSITIONS.MALFORMED;
    if (decision === PS2E_OUTCOMES.UNAVAILABLE) return PS2E_DISPOSITIONS.UNAVAILABLE;
    return PS2E_DISPOSITIONS.FAILED;
  }

  function stopAccepting() {
    accepting = false;
  }

  /**
   * Graceful final flush. The tap is already closed. An in-flight call is
   * recorded IN_FLIGHT_AT_FINALIZE; queued items are recorded
   * UNSENT_AT_FINALIZE WITHOUT a call. Idempotent.
   */
  async function finalizeFlush() {
    if (closed) return;
    accepting = false;
    flushSampling();
    closed = true;
    if (inFlight !== null) {
      counters.inFlightAtFinalize += 1;
      scheduler.noteDisposition({
        baseMint: inFlight.identity.baseMint,
        bucketIndex: inFlight.bucketIndex,
        disposition: "inFlightAtFinalize",
      });
      // Finalization cleanup: the in-flight request's process tree is
      // terminated (scoped to its own process group); its late answer is
      // ignored and never awaited.
      localClient.cancelPending?.();
      pendingRecords.push(
        recordFor(inFlight, {
          disposition: PS2E_DISPOSITIONS.IN_FLIGHT_AT_FINALIZE,
          decision: PS2E_OUTCOMES.UNAVAILABLE,
          decisionSource: PS2E_DECISION_SOURCES.LOCAL_JEV_UNAVAILABLE,
          providerStatus: "PS2E_IN_FLIGHT_AT_FINALIZE",
          failureReason: "finalized while this logical call was still in flight; the late answer is ignored",
        }),
      );
    }
    for (const item of queue.drain()) {
      counters.unsentAtFinalize += 1;
      scheduler.noteDisposition({ baseMint: item.identity.baseMint, bucketIndex: item.bucketIndex, disposition: "unsentAtFinalize" });
      pendingRecords.push(
        recordFor(item, {
          disposition: PS2E_DISPOSITIONS.UNSENT_AT_FINALIZE,
          decision: PS2E_OUTCOMES.UNAVAILABLE,
          decisionSource: PS2E_DECISION_SOURCES.LOCAL_JEV_UNAVAILABLE,
          providerStatus: "PS2E_UNSENT_AT_FINALIZE",
          failureReason: "still queued at finalization; no call was made",
        }),
      );
    }
    await flushPending();
  }

  /** Honest finalize accounting: the observer records a timed-out finalize. */
  function noteFinalizeTimedOut() {
    counters.finalizeTimedOut = true;
  }

  /* ======================================================================
   * Read-only views (never touched by the engine)
   * ====================================================================*/

  function accountingIdentities(samplerCounters) {
    const c = samplerCounters;
    return {
      receivedEqualsNonGenuinePlusGenuine:
        c.productionEntryFactsReceived ===
        c.nonGenuineRejected + c.genuineProductionOpportunitiesObserved + tickBuffer.length + counters.tapErrorsUnaccounted,
      genuineEqualsEligiblePlusIneligible: c.genuineProductionOpportunitiesObserved === c.schemaEligible + c.schemaIneligible,
      eligibleEqualsSuppressionsPlusAdmitted:
        c.schemaEligible ===
        c.suppressedOutsideWindow +
          c.suppressedDuplicateOpportunityDigest +
          c.suppressedPerAssetCap +
          c.suppressedAssetCooldown +
          c.suppressedBucketCap +
          c.suppressedGlobalCap +
          c.admitted,
      admittedEqualsQueuedPlusDropped: c.admitted === counters.queuedForLocalJev + counters.queueDropped,
      queuedAccountedFor: counters.queuedForLocalJev === counters.processed + counters.unsentAtFinalize + queue.depth,
      processedEqualsCallsPlusSkips:
        counters.processed ===
        counters.logicalCalls +
          counters.skippedPolicyInvalid +
          counters.skippedPrimaryClassifierUnavailable +
          counters.skippedLocalJevUnavailable +
          counters.skippedCircuitOpen +
          counters.skippedRequestTooLarge,
      callsAccountedFor:
        counters.logicalCalls ===
        counters.primaryResults +
          counters.primaryIdentityMismatch +
          counters.escalatedResults +
          counters.fallbackResults +
          counters.abstainedWithoutAcceptedTier +
          counters.failures +
          counters.malformed +
          counters.unavailable +
          counters.inFlightAtFinalize +
          (inFlight !== null && !closed ? 1 : 0),
      // ABSTAIN is counted once cross-cutting its route; every other call is
      // counted by exactly one route term above.
      abstainIsCrossCutting: true,
      // Skip dispositions also increment the descriptive per-asset `unavailable`
      // counter, so that per-asset counter is an upper bound, not a partition.
      perAssetUnavailableIsDescriptive: true,
      physicalAttemptsBounded:
        counters.totalPhysicalAttempts <=
        counters.logicalCalls * Math.max(1, resolvedReadiness.physicalAttemptCeilingPerLogicalCall ?? 1),
      logicalCallsBounded: counters.logicalCalls <= profile.globalMaxAdmissions,
      bucketCapRespected: scheduler.temporalReport().occupancy.bucketsAtCap <= PS2E_BUCKET_COUNT,
    };
  }

  function latencyReport() {
    const groups = {};
    for (const group of PS2E_LATENCY_GROUPS) {
      const source = series[group] ?? {};
      const metrics = {};
      for (const metric of PS2E_LATENCY_SERIES_METRICS) metrics[metric] = localTevLatencyStats(source[metric]?.values() ?? []);
      groups[group] = { count: source.totalE2EMs?.values().length ?? 0, metrics };
    }
    return {
      clock: "observer clock; totalE2EMs = observerCompletedAt - observerStartedAt",
      percentileMethod: "nearest-rank over the observed samples",
      groups,
      coldOrWarm: { ...coldOrWarm },
      unavailableMeasurements: [...PS2E_UNAVAILABLE_MEASUREMENTS],
      approximateTargetMs: null,
      performanceTargetIsAcceptanceCriterion: false,
      note:
        "measured values only; no target is an acceptance criterion, and a measurement the shared runtime does not " +
        "provide is reported as null rather than invented",
    };
  }

  function block({ maxRows }) {
    const sampled = scheduler.snapshot({ maxRows });
    const allCounters = { ...sampled.counters, ...counters };
    return {
      label: PS2E_LABEL,
      authorityTag: PS2E_AUTHORITY_TAG,
      statement: PS2E_STATEMENT,
      ...PS2E_FLAGS,
      phase: PS2E_PHASE,
      protocolId: PS2E_PROTOCOL_ID,
      protocolVersion: PS2E_PROTOCOL_VERSION,
      protocolDigest: PS2E_PROTOCOL_DIGEST,
      enabled: true,
      profile: profile.profile,
      runStartedAt: sampled.runStartedAt,
      runWindowMs: PS2E_RUN_WINDOW_MS,
      bucketCount: PS2E_BUCKET_COUNT,
      bucketMs: PS2E_BUCKET_MS,
      perBucketMaxAdmissions: PS2E_PER_BUCKET_MAX_ADMISSIONS,
      globalMaxAdmissions: profile.globalMaxAdmissions,
      maxLogicalCallsPerRun: PS2E_MAX_LOGICAL_CALLS_PER_RUN,
      maxPhysicalAttemptsPerRun: PS2E_MAX_PHYSICAL_ATTEMPTS_PER_RUN,
      physicalAttemptCeilingPerLogicalCall: resolvedReadiness.physicalAttemptCeilingPerLogicalCall ?? null,
      schedulerRule: sampled.schedulerRule,
      suppressionPrecedence: sampled.suppressionPrecedence,
      perAssetMaxAdmissionsPerRun: sampled.perAssetMaxAdmissionsPerRun,
      perAssetMinSpacingMs: sampled.perAssetMinSpacingMs,
      withinTickOrder: "ascending opportunity digest (content-determined; never population/fitness order)",
      withinTickOrderGuaranteed: counters.tickBufferEarlyFlushes === 0,
      bufferedEligibleOpportunities: tickBuffer.length,
      questionSetId: PS2E_QUESTION_SET_ID,
      questionSetVersion: PS2E_QUESTION_SET_VERSION,
      questionId: PS2E_QUESTION_ID,
      questionDigest,
      optionTokens: [...PS2E_ALLOWED_TOKENS],
      optionTokenCount: PS2E_ALLOWED_TOKENS.length,
      allowAbstain: true,
      abstainIsProtocolOutcome: true,
      classifier: { ...classifierIdentity, classifierIdentityDigest },
      classifierPolicyProblems: [...policyProblems],
      localJev: {
        mode: PS2E_LOCAL_JEV_MODE,
        invocation: PS2E_LOCAL_JEV_INVOCATION,
        transportKind: localClient.transport?.kind ?? null,
        executableSource: resolvedReadiness.executableSource,
        readinessStatus: resolvedReadiness.status,
        ready: resolvedReadiness.ready === true,
        problems: [...(resolvedReadiness.problems ?? [])],
        missingInterface: classifierPolicy.available === true ? [] : [...PS2E_MISSING_LOCAL_JEV_INTERFACE],
        primaryIdentity: resolvedReadiness.primaryIdentity,
        escalationTiers: resolvedReadiness.escalationTiers,
        typesafeFallbackEnabled: resolvedReadiness.typesafeFallbackEnabled === true,
        typeSafeIsNormalProvider: false,
        localTierCount: resolvedReadiness.localTierCount ?? 0,
        maxLocalRetries: resolvedReadiness.maxLocalRetries ?? 0,
        derivedWorstCaseLogicalMs: resolvedReadiness.derivedWorstCaseLogicalMs ?? null,
        configDigest: resolvedReadiness.configDigest,
        routingDigest: resolvedReadiness.routingDigest ?? null,
      },
      externalCallPolicy: {
        boundary: "shared Local JEV CLI (decision ask)",
        logicalCallTimeoutMs: PS2E_LOGICAL_CALL_TIMEOUT_MS,
        logicalCallsPerRunCeiling: PS2E_MAX_LOGICAL_CALLS_PER_RUN,
        physicalAttemptsPerRunCeiling: PS2E_MAX_PHYSICAL_ATTEMPTS_PER_RUN,
        retriesAddedByPs2e: 0,
        retriesOwnedBySharedRouter: true,
        circuitBreaker: { ...PS2E_CIRCUIT_BREAKER },
        failClosed: true,
        authorityLevel: "SHADOW",
        secretsForwarded: false,
        childEnvAllowListOnly: true,
      },
      thinking: { enabled: false, rule: PS2E_THINKING_RULE },
      counters: allCounters,
      // TRUE score semantics, derived from the recorded evidence itself: a local
      // vote share is `sample_stability` (a proxy, never a probability); a
      // `calibrated_probability` exists only when the shared TypeSafe fallback
      // reported one.
      scoreSemantics: {
        sampleStabilityIsCalibratedProbability: false,
        sampleStabilityRecords: counters.sampleStabilityRecords,
        calibratedProbabilityRecords: counters.calibratedProbabilityRecords,
        calibratedProbabilitySource: "the shared TypeSafe fallback tier only; a local vote share is never relabelled",
        recordConsistencyCoercions: counters.recordConsistencyCoercions,
      },
      accountingIdentities: accountingIdentities(sampled.counters),
      providerStatusCounts: { ...providerStatusCounts },
      queue: {
        capacity: queue.capacity,
        depth: queue.depth,
        highWatermark: queue.highWatermark,
        dropped: queue.dropped,
        pushed: queue.pushed,
      },
      circuitBreaker: {
        failureThreshold: PS2E_CIRCUIT_BREAKER.failureThreshold,
        cooldownMs: PS2E_CIRCUIT_BREAKER.cooldownMs,
        open: breaker.openUntilMs !== null,
        openUntil: iso(breaker.openUntilMs),
        trips: counters.circuitBreakerTrips,
      },
      latency: latencyReport(),
      temporal: scheduler.temporalReport(),
      assetRowKey: sampled.assetRowKey,
      assetRowOrder: sampled.assetRowOrder,
      totalAssetCount: sampled.totalAssetCount,
      rowsStored: sampled.rowsStored,
      rowsTruncated: sampled.rowsTruncated,
      assetRows: sampled.assetRows,
      truncatedRowsAggregate: sampled.truncatedRowsAggregate,
      overflowActive: sampled.overflowActive,
      overflowAggregate: sampled.overflowAggregate,
      aggregateDigest: sampled.aggregateDigest,
      recentRows: [...recentRows],
      closed,
      winner: null,
      noAutomatedWinner: true,
      assetsRanked: false,
      profitabilityClaim: false,
      tradingInference: false,
      deploymentInference: false,
      authorityPromotionEmitted: false,
      automaticPromotionPermitted: false,
      predictiveEvidence: false,
      canonical: false,
      replication: false,
      temporalReplication: false,
    };
  }

  return {
    version: PS2E_OBSERVER_VERSION,
    profile,
    classifierPolicy,
    readiness: resolvedReadiness,
    policyProblems,
    observeProductionEntry,
    processNext,
    hasWork: () => queue.depth > 0 || pendingRecords.length > 0,
    flushSampling,
    stopAccepting,
    finalizeFlush,
    noteFinalizeTimedOut,
    stateBlock: () => block({ maxRows: PS2E_MAX_DASHBOARD_ASSET_ROWS }),
    summaryBlock: () => block({ maxRows: PS2E_MAX_PERSISTED_ASSET_ROWS }),
    sessionBlock: () => ({
      phase: PS2E_PHASE,
      protocolId: PS2E_PROTOCOL_ID,
      protocolVersion: PS2E_PROTOCOL_VERSION,
      protocolDigest: PS2E_PROTOCOL_DIGEST,
      ...PS2E_FLAGS,
      profile: profile.profile,
      runStartedAt: iso(windowStartedAtMs),
      runWindowMs: PS2E_RUN_WINDOW_MS,
      bucketCount: PS2E_BUCKET_COUNT,
      bucketMs: PS2E_BUCKET_MS,
      perBucketMaxAdmissions: PS2E_PER_BUCKET_MAX_ADMISSIONS,
      globalMaxAdmissions: profile.globalMaxAdmissions,
      queueCapacity: profile.queueCapacity,
      questionSetId: PS2E_QUESTION_SET_ID,
      questionSetVersion: PS2E_QUESTION_SET_VERSION,
      questionId: PS2E_QUESTION_ID,
      questionDigest,
      optionTokens: [...PS2E_ALLOWED_TOKENS],
      classifier: { ...classifierIdentity, classifierIdentityDigest },
      classifierPolicyProblems: [...policyProblems],
      localJev: {
        mode: PS2E_LOCAL_JEV_MODE,
        invocation: PS2E_LOCAL_JEV_INVOCATION,
        transportKind: localClient.transport?.kind ?? null,
        executableSource: resolvedReadiness.executableSource,
        readinessStatus: resolvedReadiness.status,
        ready: resolvedReadiness.ready === true,
        problems: [...(resolvedReadiness.problems ?? [])],
        missingInterface: classifierPolicy.available === true ? [] : [...PS2E_MISSING_LOCAL_JEV_INTERFACE],
        configDigest: resolvedReadiness.configDigest,
        routingDigest: resolvedReadiness.routingDigest ?? null,
      },
      externalCallPolicy: {
        logicalCallTimeoutMs: PS2E_LOGICAL_CALL_TIMEOUT_MS,
        logicalCallsPerRunCeiling: PS2E_MAX_LOGICAL_CALLS_PER_RUN,
        physicalAttemptCeilingPerLogicalCall: resolvedReadiness.physicalAttemptCeilingPerLogicalCall ?? null,
        physicalAttemptsPerRunCeiling: PS2E_MAX_PHYSICAL_ATTEMPTS_PER_RUN,
        circuitBreaker: { ...PS2E_CIRCUIT_BREAKER },
        failClosed: true,
        authorityLevel: "SHADOW",
        retriesAddedByPs2e: 0,
      },
      thinking: { enabled: false, rule: PS2E_THINKING_RULE },
      typeSafeIsNormalProvider: false,
      missingLocalJevInterface: classifierPolicy.available === true ? [] : [...PS2E_MISSING_LOCAL_JEV_INTERFACE],
    }),
    get inFlight() {
      return inFlight !== null;
    },
    get queueDepth() {
      return queue.depth;
    },
    get logicalCalls() {
      return counters.logicalCalls;
    },
  };
}

export { PS2E_PRIMARY_CLASSIFIER, assessLocalTevReadiness, LOCAL_JEV_CLIENT_STATUS };
