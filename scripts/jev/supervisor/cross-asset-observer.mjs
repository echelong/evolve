/**
 * Phase 5I-PS.2d — the cross-asset production shadow component of the passive
 * supervisor observer.
 *
 *   observeProductionEntry(facts)   SYNCHRONOUS passive tap (called by the
 *                                   engine through a protected wrapper):
 *                                   genuineness → schema → complete-input digest
 *                                   → deterministic sampler → bounded queue push.
 *                                   Never awaits, never throws, returns nothing.
 *   processNext()                   ASYNCHRONOUS worker step (observer loop only):
 *                                   pins → circuit breaker → one typed Jev call
 *                                   → one bounded NDJSON record.
 *   finalizeFlush()                 graceful final flush: queued-but-unsent items
 *                                   are recorded UNSENT_AT_FINALIZE with NO call.
 *
 * DEVELOPMENT SHADOW • ZERO AUTHORITY. Nothing here is ever returned to, or read
 * by, the engine, selection, evolution, fitness, the Arena or any evidence tree.
 *
 * PAPER ONLY / SHADOW ONLY / DEVELOPMENT EVIDENCE ONLY.
 */

import { JEV_PROVIDER_UPSTREAM, JEV_STATUS } from "../config.mjs";
import { jevDecide } from "../decide.mjs";
import { createJevRunBudget } from "../runtime.mjs";
import { digestOf } from "../../lib/hash.mjs";
import {
  PS2D_AUTHORITY_TAG,
  PS2D_CIRCUIT_BREAKER,
  PS2D_FLAGS,
  PS2D_LABEL,
  PS2D_MAX_DASHBOARD_ASSET_ROWS,
  PS2D_MAX_FAILURE_REASON_LENGTH,
  PS2D_MAX_PERSISTED_ASSET_ROWS,
  PS2D_PACKET_VERSION,
  PS2D_PER_ASSET_MAX_JEV_CALLS_PER_RUN,
  PS2D_PER_ASSET_MIN_SPACING_MS,
  PS2D_PHASE,
  PS2D_PROTOCOL_DIGEST,
  PS2D_PROTOCOL_ID,
  PS2D_PROTOCOL_VERSION,
  PS2D_QUESTION_SET_ID,
  PS2D_QUESTION_SET_VERSION,
  PS2D_RECENT_ROW_LIMIT,
  PS2D_SCHEMA_VERSION,
  PS2D_STANCES,
  PS2D_STATEMENT,
  PS2D_TICK_BUFFER_LIMIT,
  PS2D_WITHIN_TICK_ORDER,
  crossAssetExternalCallPolicy,
  crossAssetProfileFor,
} from "./cross-asset-protocol.mjs";
import {
  buildCrossAssetPacket,
  crossAssetCompleteInput,
  crossAssetInputDigestOf,
  validateGenuineProductionEntry,
} from "./cross-asset-packet.mjs";
import {
  PS2D_RESPONSE_CONTRACT_DIGEST,
  buildCrossAssetQuestions,
  validateCrossAssetTypedResponse,
} from "./cross-asset-questions.mjs";
import { createCrossAssetSampler } from "./cross-asset-sampler.mjs";
import { createBoundedObserverQueue } from "./queue.mjs";
import { appendSupervisorCrossAssetObservation } from "./storage.mjs";
import { deepFreeze } from "./tap.mjs";

export const PS2D_OBSERVER_VERSION = 1;

export const PS2D_DISPOSITIONS = Object.freeze({
  JEV_OK: "JEV_OK",
  JEV_FAILURE: "JEV_FAILURE",
  SKIPPED_PIN_MISMATCH: "SKIPPED_PIN_MISMATCH",
  SKIPPED_POLICY_INVALID: "SKIPPED_POLICY_INVALID",
  SKIPPED_CIRCUIT_OPEN: "SKIPPED_CIRCUIT_OPEN",
  SKIPPED_TRANSPORT_COOLDOWN: "SKIPPED_TRANSPORT_COOLDOWN",
  QUEUE_DROPPED: "QUEUE_DROPPED",
  UNSENT_AT_FINALIZE: "UNSENT_AT_FINALIZE",
  IN_FLIGHT_AT_FINALIZE: "IN_FLIGHT_AT_FINALIZE",
});

function iso(ms) {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Local fail-closed self-check of the frozen evidence-bearing call policy (the
 * CLI additionally validates it with the Governance v1 validator before start).
 * A policy that could fall back, fail open or exceed its bounds makes NO call.
 */
export function crossAssetPolicyProblems(policy, profile) {
  const problems = [];
  if (policy?.fallback !== "none") problems.push("fallback must be 'none'");
  if (policy?.failClosed !== true) problems.push("failClosed must be true");
  if (policy?.evidenceBearing !== true) problems.push("evidenceBearing must be true");
  if (policy?.authorityLevel !== "SHADOW") problems.push("authorityLevel must be SHADOW");
  if (!(Number.isFinite(policy?.timeoutMs) && policy.timeoutMs > 0)) problems.push("timeoutMs must be positive");
  if (!(Number.isInteger(policy?.retryCap) && policy.retryCap >= 0 && policy.retryCap <= 5)) problems.push("retryCap out of bounds");
  if (policy?.maxCallsPerRun !== profile?.globalMaxJevCallsPerRun) problems.push("maxCallsPerRun must equal the profile maximum");
  if (!(policy?.circuitBreaker?.failureThreshold > 0 && policy?.circuitBreaker?.cooldownMs > 0)) problems.push("circuit breaker required");
  return problems;
}

function bounded(text) {
  return typeof text === "string" ? text.slice(0, PS2D_MAX_FAILURE_REASON_LENGTH) : null;
}

/** Numeric provider usage only (the cost-accounting hook); never raw payloads. */
function boundedUsage(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const out = {};
  for (const [name, value] of Object.entries(usage).slice(0, 8)) {
    if (typeof value === "number" && Number.isFinite(value)) out[String(name).slice(0, 48)] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * @param {{
 *   sessionId: string,
 *   root: string,
 *   profileName: string,
 *   allowOfflineValidation?: boolean,
 *   provider: object|null,
 *   providerIdentity?: { provider?: string|null, model?: string|null, upstream?: string|null }|null,
 *   evaluatePins: (options: object) => { ok: boolean, problems: string[] },
 *   now: () => number,
 *   writeArtifacts: boolean,
 *   waitForStorage: () => Promise<void>,
 *   noteObserverError: (error: unknown) => void,
 * }} options
 */
export function createCrossAssetShadow({
  sessionId,
  root,
  profileName,
  allowOfflineValidation = false,
  provider = null,
  providerIdentity = null,
  evaluatePins,
  now,
  writeArtifacts,
  waitForStorage,
  noteObserverError,
}) {
  const profile = crossAssetProfileFor(profileName, { allowOfflineValidation });
  if (profile === null) throw new Error(`unknown PS.2d cross-asset profile '${profileName}'`);

  const questions = deepFreeze(structuredClone(buildCrossAssetQuestions()));
  const questionDigest = digestOf(questions);
  const identity = {
    provider: providerIdentity?.provider ?? provider?.name ?? null,
    model: providerIdentity?.model ?? provider?.model ?? null,
    upstream:
      providerIdentity?.upstream ??
      (typeof provider?.name === "string" && provider.name.length > 0 ? JEV_PROVIDER_UPSTREAM[provider.name] ?? null : null),
  };
  const pins = evaluatePins({ provider, upstream: identity.upstream });
  const policy = crossAssetExternalCallPolicy(profile, { provider: identity.provider, model: identity.model });
  const policyProblems = crossAssetPolicyProblems(policy, profile);
  const budget = createJevRunBudget(profile.globalMaxJevCallsPerRun);
  const sampler = createCrossAssetSampler({ profile });

  const counters = {
    queuedForJev: 0,
    queueDropped: 0,
    processed: 0,
    jevCalls: 0,
    jevOk: 0,
    jevFailures: 0,
    skippedPinMismatch: 0,
    skippedPolicyInvalid: 0,
    skippedCircuitOpen: 0,
    skippedTransportCooldown: 0,
    unsentAtFinalize: 0,
    inFlightAtFinalize: 0,
    lateCompletionsIgnored: 0,
    tapErrors: 0,
    tapErrorsUnaccounted: 0,
    samplingErrors: 0,
    tickBufferEarlyFlushes: 0,
    recordWriteFailures: 0,
    circuitBreakerTrips: 0,
    stanceSupports: 0,
    stanceDoesNotSupport: 0,
    stanceExactlyHalf: 0,
  };
  const providerStatusCounts = {};
  let latencySumMs = 0;
  let latencyCount = 0;
  let accepting = true;
  let closed = false;
  let inFlight = null;
  let pendingRecords = [];
  let recentRows = [];
  /** Schema-eligible opportunities of the CURRENT engine tick, not yet sampled. */
  let tickBuffer = [];
  let tickBufferKey = null;
  const breaker = { consecutiveFailures: 0, openUntilMs: null, halfOpen: false };

  const queue = createBoundedObserverQueue({
    capacity: profile.queueCapacity,
    onDrop: (item) => {
      counters.queueDropped += 1;
      sampler.noteDisposition(item.identity.marketId, "queueDropped");
      pendingRecords.push(recordFor(item, { disposition: PS2D_DISPOSITIONS.QUEUE_DROPPED }));
    },
  });

  /* ======================================================================
   * THE PASSIVE TAP — synchronous, bounded, non-throwing, returns nothing
   * ====================================================================*/

  function observeProductionEntry(facts) {
    if (!accepting) return;
    // Every received fact ends in EXACTLY one bucket: non-genuine, schema-
    // ineligible, buffered for sampling, or (on an observer error) unaccounted.
    let accounted = false;
    try {
      sampler.noteFactReceived();
      const verdict = validateGenuineProductionEntry(facts);
      if (!verdict.genuine) {
        sampler.noteNonGenuine(verdict.reason);
        accounted = true;
        return;
      }
      const atMs = facts.at;
      const built = buildCrossAssetPacket(facts);
      if (!built.ok) {
        sampler.noteSchemaIneligible({ identity: built.identity, reason: built.reason, atMs });
        accounted = true;
        return;
      }
      const completeInput = crossAssetCompleteInput({
        provider: identity.provider,
        model: identity.model,
        questionSetId: PS2D_QUESTION_SET_ID,
        questionSetVersion: PS2D_QUESTION_SET_VERSION,
        questions,
        packet: built.packet,
      });
      const jevInputDigest = crossAssetInputDigestOf(completeInput);
      const tickKey = `${built.packet.proposal.generation}:${built.packet.proposal.generationTick}`;
      // A new engine tick means the previous one is complete: sample it first.
      if (tickBufferKey !== null && tickKey !== tickBufferKey) flushSampling();
      if (tickBuffer.length >= PS2D_TICK_BUFFER_LIMIT) {
        counters.tickBufferEarlyFlushes += 1;
        flushSampling();
      }
      tickBufferKey = tickKey;
      tickBuffer.push({
        identity: built.identity,
        packet: built.packet,
        packetDigest: digestOf(built.packet),
        jevInputDigest,
        proposalAtMs: atMs,
        capturedAtMs: now(),
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
   * Apply the deterministic sampler to the buffered (complete) tick in the
   * frozen within-tick order, then push admitted items to the bounded queue.
   * Synchronous. Called when the next tick starts, from the worker loop (which
   * can only run BETWEEN synchronous engine ticks), and at finalization, so the
   * decisions never depend on when the flush happens.
   */
  function flushSampling() {
    if (tickBuffer.length === 0) {
      tickBufferKey = null;
      return;
    }
    const entries = tickBuffer;
    tickBuffer = [];
    tickBufferKey = null;
    entries.sort((a, b) => (a.jevInputDigest < b.jevInputDigest ? -1 : a.jevInputDigest > b.jevInputDigest ? 1 : 0));
    for (const entry of entries) {
      try {
        const decision = sampler.decide({ identity: entry.identity, jevInputDigest: entry.jevInputDigest, atMs: entry.proposalAtMs });
        if (!decision.admitted) continue;
        const item = { ...entry, admissionOrdinal: decision.admissionOrdinal };
        if (queue.push(item)) {
          counters.queuedForJev += 1;
          sampler.noteDisposition(item.identity.marketId, "queued");
        }
      } catch (error) {
        counters.samplingErrors += 1;
        noteObserverError(error);
      }
    }
  }

  /* ======================================================================
   * Records (one bounded NDJSON line per ADMITTED observation)
   * ====================================================================*/

  function recordFor(item, fields = {}) {
    return {
      schemaVersion: PS2D_SCHEMA_VERSION,
      recordType: "CROSS_ASSET_OBSERVATION",
      phase: PS2D_PHASE,
      protocolId: PS2D_PROTOCOL_ID,
      protocolVersion: PS2D_PROTOCOL_VERSION,
      protocolDigest: PS2D_PROTOCOL_DIGEST,
      ...PS2D_FLAGS,
      sessionId,
      profile: profile.profile,
      admissionOrdinal: item.admissionOrdinal,
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
      packetVersion: PS2D_PACKET_VERSION,
      packet: item.packet,
      packetDigest: item.packetDigest,
      jevInputDigest: item.jevInputDigest,
      questionSetId: PS2D_QUESTION_SET_ID,
      questionSetVersion: PS2D_QUESTION_SET_VERSION,
      questionDigest,
      responseContractDigest: PS2D_RESPONSE_CONTRACT_DIGEST,
      provider: identity.provider,
      model: identity.model,
      upstream: identity.upstream,
      gatewayUsed: false,
      cacheEnabled: false,
      fallback: "none",
      disposition: null,
      observerStartedAt: null,
      observerCompletedAt: null,
      providerStatus: null,
      failureReason: null,
      requestId: null,
      latencyMs: null,
      providerAttemptCount: null,
      rawResponseDigest: null,
      usage: null,
      typedResponse: null,
      pSupport: null,
      stance: null,
      stanceIsCorrectness: false,
      confidenceThresholdApplied: false,
      note:
        "Development shadow observation of a genuine EVOLVE production entry proposal. Zero authority: nothing here " +
        "was, or can be, returned to the engine. The stance is not correctness and no outcome is resolved.",
      ...fields,
    };
  }

  async function writeRecord(record) {
    if (!writeArtifacts) return;
    try {
      await waitForStorage();
      await appendSupervisorCrossAssetObservation(root, record);
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
    const row = {
      at: record.observerCompletedAt ?? record.proposalAt,
      admissionOrdinal: record.admissionOrdinal,
      marketId: record.marketId,
      symbol: record.symbol,
      species: record.species,
      disposition: record.disposition,
      providerStatus: record.providerStatus,
      pSupport: record.pSupport,
      stance: record.stance,
    };
    recentRows = [...recentRows, row].slice(-PS2D_RECENT_ROW_LIMIT);
  }

  /* ======================================================================
   * Worker step — the ONLY place PS.2d ever waits
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
    if (breaker.halfOpen || breaker.consecutiveFailures >= PS2D_CIRCUIT_BREAKER.failureThreshold) {
      breaker.openUntilMs = atMs + PS2D_CIRCUIT_BREAKER.cooldownMs;
      breaker.consecutiveFailures = 0;
      breaker.halfOpen = false;
      counters.circuitBreakerTrips += 1;
    }
  }

  async function processNext() {
    await flushPending();
    const item = queue.shift();
    if (item === null) return false;
    const marketId = item.identity.marketId;
    counters.processed += 1;

    // FAIL CLOSED, re-checked before EVERY call: the frozen call policy, then
    // the provider pins. Each refusal is recorded under its own disposition.
    if (policyProblems.length > 0) {
      counters.skippedPolicyInvalid += 1;
      sampler.noteDisposition(marketId, "skippedPolicyInvalid");
      const record = recordFor(item, {
        disposition: PS2D_DISPOSITIONS.SKIPPED_POLICY_INVALID,
        providerStatus: "PS2D_POLICY_INVALID",
        failureReason: bounded(`the PS.2d call policy failed its fail-closed check: ${policyProblems.join("; ")}`),
      });
      rememberRow(record);
      await writeRecord(record);
      return true;
    }
    const callPins = evaluatePins({ provider, upstream: identity.upstream });
    if (!callPins.ok) {
      counters.skippedPinMismatch += 1;
      sampler.noteDisposition(marketId, "skippedPinMismatch");
      const record = recordFor(item, {
        disposition: PS2D_DISPOSITIONS.SKIPPED_PIN_MISMATCH,
        providerStatus: "JEV_PIN_MISMATCH",
        failureReason: bounded(`the PS.2d observer refused to call Jev: ${callPins.problems.join("; ")}`),
      });
      rememberRow(record);
      await writeRecord(record);
      return true;
    }

    const startedAtMs = now();
    if (!breakerAllowsCall(startedAtMs)) {
      counters.skippedCircuitOpen += 1;
      sampler.noteDisposition(marketId, "skippedCircuitOpen");
      const record = recordFor(item, {
        disposition: PS2D_DISPOSITIONS.SKIPPED_CIRCUIT_OPEN,
        providerStatus: "PS2D_CIRCUIT_OPEN",
        failureReason: `circuit breaker open until ${iso(breaker.openUntilMs)}; no call was made`,
      });
      rememberRow(record);
      await writeRecord(record);
      return true;
    }

    // Counted while in flight; the per-asset call is noted once the outcome is
    // known (or at finalization for an in-flight call).
    counters.jevCalls += 1;
    inFlight = item;
    let decided = null;
    let thrown = null;
    try {
      decided = await jevDecide({
        provider,
        packet: item.packet,
        questions,
        questionSetId: PS2D_QUESTION_SET_ID,
        questionSetVersion: PS2D_QUESTION_SET_VERSION,
        decisionPacketVersion: PS2D_PACKET_VERSION,
        experimentId: sessionId,
        root: null,
        cacheEnabled: false,
        budget,
        now,
        salt: `${sessionId}-xa${item.admissionOrdinal}`,
      });
    } catch (error) {
      thrown = error;
    }
    inFlight = null;
    if (closed) {
      // Finalization already recorded this item IN_FLIGHT_AT_FINALIZE; the late
      // answer is ignored so the finalized accounting identities stay exact.
      counters.lateCompletionsIgnored += 1;
      return true;
    }
    const completedAtMs = now();
    const run = decided?.run ?? null;
    if (thrown === null && run?.status === JEV_STATUS.COOLDOWN) {
      // The transport's own provider-health cooldown answered WITHOUT a network
      // call: not a Jev call, not a Jev failure, and not fed to the breaker.
      counters.jevCalls -= 1;
      counters.skippedTransportCooldown += 1;
      sampler.noteDisposition(marketId, "skippedTransportCooldown");
      providerStatusCounts[JEV_STATUS.COOLDOWN] = (providerStatusCounts[JEV_STATUS.COOLDOWN] ?? 0) + 1;
      const record = recordFor(item, {
        disposition: PS2D_DISPOSITIONS.SKIPPED_TRANSPORT_COOLDOWN,
        observerStartedAt: iso(startedAtMs),
        observerCompletedAt: iso(completedAtMs),
        providerStatus: JEV_STATUS.COOLDOWN,
        failureReason: bounded(run?.reason ?? "transport cooldown active; no network call was made"),
        providerAttemptCount: 0,
      });
      rememberRow(record);
      await writeRecord(record);
      return true;
    }
    sampler.noteDisposition(marketId, "jevCalls");
    const typed =
      thrown === null
        ? validateCrossAssetTypedResponse(decided, { okStatus: JEV_STATUS.OK })
        : {
            ok: false,
            status: "JEV_OBSERVER_ERROR",
            pSupport: null,
            stance: null,
            failureReason: bounded(`observer error: ${thrown?.message ?? thrown}`),
            typedResponse: null,
          };
    if (thrown !== null) noteObserverError(thrown);
    providerStatusCounts[typed.status] = (providerStatusCounts[typed.status] ?? 0) + 1;
    if (Number.isFinite(run?.latencyMs) && run.latencyMs >= 0) {
      latencySumMs += run.latencyMs;
      latencyCount += 1;
    }
    if (typed.ok) {
      counters.jevOk += 1;
      sampler.noteDisposition(marketId, "jevOk");
      if (typed.stance === PS2D_STANCES.SUPPORTS) counters.stanceSupports += 1;
      else if (typed.stance === PS2D_STANCES.DOES_NOT_SUPPORT) counters.stanceDoesNotSupport += 1;
      else if (typed.stance === PS2D_STANCES.EXACTLY_HALF) counters.stanceExactlyHalf += 1;
    } else {
      counters.jevFailures += 1;
      sampler.noteDisposition(marketId, "jevFailures");
    }
    noteCallResult(typed.ok, completedAtMs);

    const record = recordFor(item, {
      disposition: typed.ok ? PS2D_DISPOSITIONS.JEV_OK : PS2D_DISPOSITIONS.JEV_FAILURE,
      observerStartedAt: iso(startedAtMs),
      observerCompletedAt: iso(completedAtMs),
      providerStatus: typed.status,
      failureReason: typed.failureReason,
      requestId: typeof run?.requestId === "string" ? run.requestId.slice(0, 128) : null,
      latencyMs: Number.isFinite(run?.latencyMs) ? run.latencyMs : null,
      providerAttemptCount: Number.isFinite(run?.providerAttemptCount) ? run.providerAttemptCount : null,
      rawResponseDigest: typeof run?.rawResponseDigest === "string" ? run.rawResponseDigest : null,
      usage: boundedUsage(run?.usage),
      typedResponse: typed.typedResponse,
      pSupport: typed.pSupport,
      stance: typed.stance,
    });
    rememberRow(record);
    await writeRecord(record);
    return true;
  }

  /** Stop admitting new observations (the tap becomes inert). */
  function stopAccepting() {
    accepting = false;
  }

  /**
   * Graceful final flush. The tap is already closed. An in-flight call is
   * recorded IN_FLIGHT_AT_FINALIZE; queued items are recorded
   * UNSENT_AT_FINALIZE WITHOUT a Jev call. Idempotent.
   */
  async function finalizeFlush() {
    if (closed) return;
    accepting = false;
    // The last tick is complete: sample it so accounting stays exact (admitted
    // items are then recorded UNSENT_AT_FINALIZE below, never sent late).
    flushSampling();
    closed = true;
    if (inFlight !== null) {
      counters.inFlightAtFinalize += 1;
      sampler.noteDisposition(inFlight.identity.marketId, "jevCalls");
      sampler.noteDisposition(inFlight.identity.marketId, "inFlightAtFinalize");
      pendingRecords.push(recordFor(inFlight, { disposition: PS2D_DISPOSITIONS.IN_FLIGHT_AT_FINALIZE }));
    }
    for (const item of queue.drain()) {
      counters.unsentAtFinalize += 1;
      sampler.noteDisposition(item.identity.marketId, "unsentAtFinalize");
      pendingRecords.push(recordFor(item, { disposition: PS2D_DISPOSITIONS.UNSENT_AT_FINALIZE }));
    }
    await flushPending();
  }

  /* ======================================================================
   * Read-only views (never touched by the engine)
   * ====================================================================*/

  function identitiesOf(samplerCounters) {
    const c = samplerCounters;
    return {
      // Genuine, schema-eligible opportunities of a not-yet-complete tick are
      // counted once the tick is sampled (`bufferedEligibleOpportunities`).
      receivedEqualsNonGenuinePlusGenuine:
        c.productionEntryFactsReceived ===
        c.nonGenuineRejected + c.genuineProductionOpportunitiesObserved + tickBuffer.length + counters.tapErrorsUnaccounted,
      genuineEqualsEligiblePlusIneligible:
        c.genuineProductionOpportunitiesObserved === c.schemaEligible + c.schemaIneligible,
      eligibleEqualsSuppressionsPlusAdmitted:
        c.schemaEligible ===
        c.suppressedDuplicateDigest + c.suppressedPerAssetCap + c.suppressedAssetCooldown + c.suppressedGlobalCap + c.admittedBySampler,
      admittedEqualsQueuedPlusDropped: c.admittedBySampler === counters.queuedForJev + counters.queueDropped,
      queuedAccountedFor: counters.queuedForJev === counters.processed + counters.unsentAtFinalize + queue.depth,
      processedEqualsCallsPlusSkips:
        counters.processed ===
        counters.jevCalls +
          counters.skippedPinMismatch +
          counters.skippedPolicyInvalid +
          counters.skippedCircuitOpen +
          counters.skippedTransportCooldown,
      callsAccountedFor:
        counters.jevCalls === counters.jevOk + counters.jevFailures + counters.inFlightAtFinalize + (inFlight !== null && !closed ? 1 : 0),
    };
  }

  function block({ maxRows }) {
    const sampled = sampler.snapshot({ maxRows });
    const allCounters = { ...sampled.counters, ...counters };
    return {
      label: PS2D_LABEL,
      authorityTag: PS2D_AUTHORITY_TAG,
      statement: PS2D_STATEMENT,
      ...PS2D_FLAGS,
      phase: PS2D_PHASE,
      protocolId: PS2D_PROTOCOL_ID,
      protocolVersion: PS2D_PROTOCOL_VERSION,
      protocolDigest: PS2D_PROTOCOL_DIGEST,
      enabled: true,
      profile: profile.profile,
      globalMaxJevCallsPerRun: profile.globalMaxJevCallsPerRun,
      perAssetMaxJevCallsPerRun: PS2D_PER_ASSET_MAX_JEV_CALLS_PER_RUN,
      perAssetMinSpacingMs: PS2D_PER_ASSET_MIN_SPACING_MS,
      samplingRule: sampled.samplingRule,
      withinTickOrder: PS2D_WITHIN_TICK_ORDER,
      // False only if a single tick ever exceeded the defensive buffer bound
      // (impossible for the engine: one entry per agent per tick, population ≤ 512).
      withinTickOrderGuaranteed: counters.tickBufferEarlyFlushes === 0,
      bufferedEligibleOpportunities: tickBuffer.length,
      suppressionPrecedence: sampled.suppressionPrecedence,
      questionSetId: PS2D_QUESTION_SET_ID,
      questionSetVersion: PS2D_QUESTION_SET_VERSION,
      questionDigest,
      responseContractDigest: PS2D_RESPONSE_CONTRACT_DIGEST,
      provider: identity.provider,
      model: identity.model,
      upstream: identity.upstream,
      pinsOk: pins.ok,
      externalCallPolicy: policy,
      externalCallPolicyProblems: [...policyProblems],
      counters: allCounters,
      accountingIdentities: identitiesOf(sampled.counters),
      nonGenuineReasonCounts: sampled.nonGenuineReasonCounts,
      schemaIneligibleReasonCounts: sampled.schemaIneligibleReasonCounts,
      providerStatusCounts: { ...providerStatusCounts },
      meanLatencyMs: latencyCount > 0 ? Number((latencySumMs / latencyCount).toFixed(3)) : null,
      queue: {
        capacity: queue.capacity,
        depth: queue.depth,
        highWatermark: queue.highWatermark,
        dropped: queue.dropped,
        pushed: queue.pushed,
      },
      circuitBreaker: {
        failureThreshold: PS2D_CIRCUIT_BREAKER.failureThreshold,
        cooldownMs: PS2D_CIRCUIT_BREAKER.cooldownMs,
        open: breaker.openUntilMs !== null,
        openUntil: iso(breaker.openUntilMs),
        trips: counters.circuitBreakerTrips,
      },
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
      policyRecommendationEmitted: false,
      authorityPromotionEmitted: false,
    };
  }

  return {
    version: PS2D_OBSERVER_VERSION,
    profile,
    pins,
    identity,
    policy,
    observeProductionEntry,
    processNext,
    hasWork: () => queue.depth > 0 || pendingRecords.length > 0,
    flushSampling,
    stopAccepting,
    finalizeFlush,
    /** Live `state.json` block (dashboard-bounded rows). */
    stateBlock: () => block({ maxRows: PS2D_MAX_DASHBOARD_ASSET_ROWS }),
    /** Finalized `summary.json` block (storage-bounded rows). */
    summaryBlock: () => block({ maxRows: PS2D_MAX_PERSISTED_ASSET_ROWS }),
    sessionBlock: () => ({
      phase: PS2D_PHASE,
      protocolId: PS2D_PROTOCOL_ID,
      protocolVersion: PS2D_PROTOCOL_VERSION,
      protocolDigest: PS2D_PROTOCOL_DIGEST,
      ...PS2D_FLAGS,
      profile: profile.profile,
      globalMaxJevCallsPerRun: profile.globalMaxJevCallsPerRun,
      queueCapacity: profile.queueCapacity,
      questionSetId: PS2D_QUESTION_SET_ID,
      questionSetVersion: PS2D_QUESTION_SET_VERSION,
      questionDigest,
      responseContractDigest: PS2D_RESPONSE_CONTRACT_DIGEST,
      provider: identity.provider,
      model: identity.model,
      upstream: identity.upstream,
      pinsOk: pins.ok,
      pinProblems: [...pins.problems],
      externalCallPolicy: policy,
      externalCallPolicyProblems: [...policyProblems],
    }),
    get inFlight() {
      return inFlight !== null;
    },
    get queueDepth() {
      return queue.depth;
    },
  };
}
