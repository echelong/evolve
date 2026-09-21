/**
 * Phase 5I-PS.2 — Jev supervisor observer.
 *
 * Two strictly separated halves live in this module:
 *
 *   1. THE PASSIVE TAP (`freezeProposal` / `recordExecution`). Called
 *      synchronously, from inside `simulation.advanceTick()`, immediately
 *      before and immediately after the paper execution attempt. It copies the
 *      immutable proposal facts it is handed into a frozen record and pushes
 *      that record into a bounded queue. It never awaits, never blocks, never
 *      throws into the engine, and never lets anything it returns flow back
 *      into a decision.
 *
 *   2. THE ASYNCHRONOUS WORKER. A separate `void`-started loop that drains the
 *      queue, freezes the SOL/USDC market state into the EXISTING Phase 5I
 *      directional packet, asks direct TypeSafe Jev the existing directional
 *      question, and records an agreement/disagreement judgment. It is never
 *      awaited by the simulation (`start()` returns the observer, not a
 *      promise) and its failure can only damage observer evidence.
 *
 * JEV HAS ZERO AUTHORITY. No return value from this module is consumed by
 * `openPosition`, `closePosition`, `stepAgent`, genome scoring, fitness,
 * selection, mutation, crossover, research, the Arena, or Temporal 5I.1a.
 *
 * PAPER ONLY / DEVELOPMENT EVIDENCE ONLY. No wallet, no signing, no swap, no
 * order execution, no RPC write.
 */

import { JEV_PROVIDER_UPSTREAM, JEV_STATUS } from "../config.mjs";
import { jevDecide } from "../decide.mjs";
import { createJevRunBudget } from "../runtime.mjs";
import { HORIZON_SECONDS } from "../direction/definition.mjs";
import {
  DIRECTION_QUESTION_NAME,
  buildDirectionQuestions,
} from "../direction/questions.mjs";
import {
  DIRECTION_PACKET_VERSION,
  auditDirectionPacket,
  buildDirectionPacket,
  packetDigestOf,
  packetStateDigestOf,
} from "../direction/packet.mjs";
import {
  auditDirectionFeatures,
  classifyDirectionRegime,
  extractDirectionFeaturesFromInputs,
  preOutcomeInputDigestOf,
  warmupStatus,
} from "../direction/features.mjs";
import {
  SUPERVISOR_CACHE_ENABLED,
  SUPERVISOR_CLASSIFICATION,
  SUPERVISOR_FEATURE_DEFINITION_DIGEST,
  SUPERVISOR_FEATURE_DEFINITION_VERSION,
  SUPERVISOR_FORBIDDEN_PROVIDERS,
  SUPERVISOR_FORBIDDEN_WRITE_ROOTS,
  SUPERVISOR_HISTORY_LIMIT,
  SUPERVISOR_KIND,
  SUPERVISOR_MARKET,
  SUPERVISOR_MARKET_ID,
  SUPERVISOR_MAX_DROP_RECORDS,
  SUPERVISOR_MAX_JEV_CALLS,
  SUPERVISOR_MAX_PENDING_DRAFTS,
  SUPERVISOR_MODE,
  SUPERVISOR_PHASE,
  SUPERVISOR_QUEUE_CAPACITY,
  SUPERVISOR_QUESTION_SET_ID,
  SUPERVISOR_RECENT_ROW_LIMIT,
  SUPERVISOR_QUESTION_SET_VERSION,
  SUPERVISOR_REGIME_MARKET_LIMIT,
  SUPERVISOR_REGIME_SNAPSHOT_LIMIT,
  SUPERVISOR_REQUIRED_MODEL,
  SUPERVISOR_REQUIRED_PROVIDER,
  SUPERVISOR_REQUIRED_UPSTREAM_PROVIDER,
  SUPERVISOR_SCHEMA_VERSION,
  SUPERVISOR_STATE_PUBLISH_INTERVAL_MS,
  SUPERVISOR_SUPPORTED_MARKET_IDS,
  SUPERVISOR_SUPPORTED_MINTS,
  SUPERVISOR_QUOTE_MINT,
  SUPERVISOR_UNSUPPORTED_MARKET_REASON,
  SUPERVISOR_WORKER_IDLE_MS,
  SUPERVISOR_AGREEMENT,
  isValidSupervisorSessionId,
  supervisorSessionRootFor,
  supervisorQuestionDigest,
} from "./definition.mjs";
import { createBoundedObserverQueue } from "./queue.mjs";
import {
  agreementFor,
  buildProposalFacts,
  distanceFromHalfOf,
  exactlyHalfOf,
  freezeExecution,
  isSupportedMint,
  modelIntentFromProbability,
  proposalDigestOf,
} from "./tap.mjs";
import {
  appendSupervisorJudgment,
  appendSupervisorProposal,
  writeSupervisorSession,
  writeSupervisorState,
  writeSupervisorSummary,
} from "./storage.mjs";
import {
  buildSupervisorState,
  buildSupervisorSummary,
  compactSupervisorRow,
  createSupervisorAggregates,
  createSupervisorCounters,
  observeLatency,
  observeProbability,
  observeProviderStatus,
  supervisorHeader,
} from "./summary.mjs";

export const SUPERVISOR_OBSERVER_VERSION = 1;

/** The ONLY thing in this subsystem that ever waits. */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function iso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function pad(value, width = 6) {
  return String(value).padStart(width, "0");
}

/**
 * FAIL-CLOSED pin evaluation against a resolved provider object. Never throws,
 * never falls back: any mismatch means the observer must NOT call Jev and must
 * record an observer FAILURE instead.
 */
export function evaluateSupervisorProviderPins({ provider = null, upstream = null } = {}) {
  const problems = [];
  const name = provider?.name ?? null;
  const model = provider?.model ?? null;
  const resolvedUpstream = upstream ?? (typeof name === "string" && name.length > 0 ? JEV_PROVIDER_UPSTREAM[name] ?? null : null);

  if (provider === null || provider === undefined) {
    problems.push("no Jev provider was supplied to the supervisor observer");
  } else {
    if (SUPERVISOR_FORBIDDEN_PROVIDERS.includes(name)) {
      problems.push(`provider '${name}' is forbidden for the supervisor observer; there is no fallback route`);
    }
    if (name !== SUPERVISOR_REQUIRED_PROVIDER) {
      problems.push(`provider '${name}' is refused: the supervisor observer requires direct '${SUPERVISOR_REQUIRED_PROVIDER}'`);
    }
    if (model !== SUPERVISOR_REQUIRED_MODEL) {
      problems.push(`model '${model}' is refused: the supervisor observer pins '${SUPERVISOR_REQUIRED_MODEL}'`);
    }
    if (provider.gatewayUsed === true) {
      problems.push("the provider reports gatewayUsed=true; the Vercel AI Gateway is refused");
    }
    if (resolvedUpstream !== SUPERVISOR_REQUIRED_UPSTREAM_PROVIDER) {
      problems.push(`upstream '${resolvedUpstream}' is refused: expected '${SUPERVISOR_REQUIRED_UPSTREAM_PROVIDER}'`);
    }
  }

  return { ok: problems.length === 0, problems, provider: name, model, upstream: resolvedUpstream };
}

/**
 * Create the supervisor observer.
 *
 * @param {{
 *   sessionId: string,
 *   sessionRoot?: string|null,
 *   baseRoot?: string|null,
 *   provider?: object|null,
 *   providerIdentity?: { provider?: string|null, model?: string|null, upstream?: string|null }|null,
 *   questions?: object|null,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   writeArtifacts?: boolean,
 *   historyLimit?: number,
 *   regimeSnapshotLimit?: number,
 *   regimeMarketLimit?: number,
 *   finalizeTimeoutMs?: number,
 *   onRow?: ((row: object) => void)|null,
 * }} options
 */
export function createSupervisorProposalObserver({
  sessionId,
  sessionRoot = null,
  baseRoot = null,
  provider = null,
  providerIdentity = null,
  questions = null,
  now = () => Date.now(),
  sleep = defaultSleep,
  writeArtifacts = true,
  historyLimit = SUPERVISOR_HISTORY_LIMIT,
  regimeSnapshotLimit = SUPERVISOR_REGIME_SNAPSHOT_LIMIT,
  regimeMarketLimit = SUPERVISOR_REGIME_MARKET_LIMIT,
  finalizeTimeoutMs = 5_000,
  onRow = null,
} = {}) {
  if (!isValidSupervisorSessionId(sessionId)) {
    throw new Error(`invalid Jev supervisor session id '${sessionId}'`);
  }
  const resolvedBaseRoot = baseRoot ?? ".evolve/jev-supervisor-observer";
  const root = sessionRoot ?? supervisorSessionRootFor(resolvedBaseRoot, sessionId);

  const resolvedQuestions = questions ?? buildDirectionQuestions();
  const questionDigest = supervisorQuestionDigest();
  const startedAtMs = now();
  const startedAt = iso(startedAtMs);

  const identity = {
    provider: providerIdentity?.provider ?? provider?.name ?? null,
    model: providerIdentity?.model ?? provider?.model ?? null,
    upstream:
      providerIdentity?.upstream ??
      (typeof provider?.name === "string" && provider.name.length > 0
        ? JEV_PROVIDER_UPSTREAM[provider.name] ?? null
        : null),
  };
  const pins = evaluateSupervisorProviderPins({ provider, upstream: identity.upstream });

  // ---- mutable observer-only state ----------------------------------------
  const counters = createSupervisorCounters();
  const aggregates = createSupervisorAggregates();
  const budget = createJevRunBudget(SUPERVISOR_MAX_JEV_CALLS);
  /** @type {Map<string, object>} */
  const drafts = new Map();
  let history = [];
  let regimeSnapshots = [];
  let recentRows = [];
  let droppedRecords = [];
  let pendingDropLines = [];
  let proposalSerial = 0;
  let proposalsSeenByTap = 0;
  let running = true;
  let finalized = false;
  let workerPromise = null;
  let finalizedSummary = null;
  let finalizedStateDoc = null;
  let lastProposalAt = null;
  let lastJudgmentAt = null;
  let lastStatePublishedAtMs = 0;
  let lifecycle = "RUNNING";
  let lastObserverError = null;

  /**
   * Record an observer-only failure. Bounded, secret-free (it is a message, and
   * this subsystem never handles credentials), and never able to affect the
   * engine: it only ever damages observer evidence.
   */
  function noteObserverError(error) {
    counters.observerFailures += 1;
    const message = typeof error === "string" ? error : error?.message ?? String(error ?? "unknown");
    lastObserverError = String(message).slice(0, 240);
  }

  const queue = createBoundedObserverQueue({
    capacity: SUPERVISOR_QUEUE_CAPACITY,
    onDrop: (draft) => recordDrop(draft, "QUEUE_FULL"),
  });

  const sessionRecord = {
    ...supervisorHeader({ sessionId, status: "RUNNING", updatedAt: startedAt }),
    provider: identity.provider,
    model: identity.model,
    upstream: identity.upstream,
    gatewayUsed: false,
    mode: SUPERVISOR_MODE,
    cacheEnabled: SUPERVISOR_CACHE_ENABLED,
    questionDigest,
    queueCapacity: SUPERVISOR_QUEUE_CAPACITY,
    maxJevCallsPerSession: SUPERVISOR_MAX_JEV_CALLS,
    supportedMarketIds: [...SUPERVISOR_SUPPORTED_MARKET_IDS],
    supportedMints: [...SUPERVISOR_SUPPORTED_MINTS],
    quoteMint: SUPERVISOR_QUOTE_MINT,
    pinsOk: pins.ok,
    pinProblems: [...pins.problems],
    forbiddenWriteRoots: [...SUPERVISOR_FORBIDDEN_WRITE_ROOTS],
    isolation: {
      root,
      canonicalEvidence: false,
      replicationEvidence: false,
      temporalReplicationEvidence: false,
      paperShadowEvidence: false,
      forensicsEvidence: false,
      arenaEligible: false,
      deploymentEligible: false,
      writesOnlyInsideSessionRoot: true,
    },
    startedAt,
    updatedAt: startedAt,
    finalizedAt: null,
    counters: { ...counters },
  };

  // The session directory must exist before the worker appends anything, so
  // every writer awaits this ONE bounded promise first. It is observer-local:
  // the simulation never sees it.
  const storageReady = writeArtifacts
    ? writeSupervisorSession(root, sessionRecord).catch((error) => {
        noteObserverError(error);
      })
    : Promise.resolve();

  /* ========================================================================
   * Observer-only bookkeeping helpers
   * ======================================================================*/

  function recordDrop(draft, dropReason) {
    counters.queueDropped += 1;
    const record = {
      recordType: "PROPOSAL_DROPPED",
      sessionId,
      proposalId: draft?.proposalId ?? null,
      at: iso(now()),
      dropReason,
      action: draft?.proposalFacts?.action ?? null,
      proposalReason: draft?.proposalFacts?.reason ?? null,
      agentId: draft?.proposalFacts?.agentId ?? null,
      note:
        "Observer work was dropped explicitly at the frozen queue capacity. The paper engine was never slowed, " +
        "blocked, or altered.",
    };
    droppedRecords = [...droppedRecords, record].slice(-SUPERVISOR_MAX_DROP_RECORDS);
    if (pendingDropLines.length < SUPERVISOR_MAX_DROP_RECORDS * 2) pendingDropLines.push(record);
  }

  async function flushDropLines() {
    if (!writeArtifacts || pendingDropLines.length === 0) return;
    await storageReady;
    const lines = pendingDropLines;
    pendingDropLines = [];
    for (const line of lines) {
      try {
        await appendSupervisorProposal(root, { schemaVersion: SUPERVISOR_SCHEMA_VERSION, phase: SUPERVISOR_PHASE, kind: SUPERVISOR_KIND, ...SUPERVISOR_CLASSIFICATION, ...line });
      } catch (error) {
        noteObserverError(error);
      }
    }
  }

  function publishedStateDoc(status = lifecycle) {
    return buildSupervisorState({
      session: sessionRecord,
      counters,
      aggregates,
      queue,
      status,
      recentRows,
      droppedRecords,
      lastProposalAt,
      lastJudgmentAt,
      updatedAt: iso(now()),
      lastObserverError,
    });
  }

  async function publishState({ force = false, status = lifecycle } = {}) {
    if (!writeArtifacts) return;
    const at = now();
    if (!force && at - lastStatePublishedAtMs < SUPERVISOR_STATE_PUBLISH_INTERVAL_MS) return;
    lastStatePublishedAtMs = at;
    try {
      await writeSupervisorState(root, publishedStateDoc(status));
    } catch (error) {
      noteObserverError(error);
    }
  }

  /* ========================================================================
   * THE PASSIVE TAP — synchronous, bounded, non-throwing
   * ======================================================================*/

  /**
   * Freeze one proposal immediately BEFORE the paper execution attempt.
   * @returns {{ proposalId: string }|null} an opaque handle, or null.
   */
  function freezeProposal(facts) {
    if (!running) return null;
    try {
      proposalSerial += 1;
      proposalsSeenByTap += 1;
      const proposalId = `${sessionId}-p${pad(proposalSerial)}`;
      const proposalFacts = buildProposalFacts(facts, { proposalId, sessionId, regimeMarketLimit });
      const draft = {
        proposalId,
        serial: proposalSerial,
        proposalFacts,
        digest: proposalDigestOf(proposalFacts),
        frozenAtMs: now(),
        execution: null,
        executionAttachedAtMs: null,
      };
      drafts.set(proposalId, draft);
      if (drafts.size > SUPERVISOR_MAX_PENDING_DRAFTS) {
        const oldest = drafts.keys().next().value;
        const evicted = drafts.get(oldest);
        drafts.delete(oldest);
        recordDrop(evicted, "PENDING_DRAFT_BACKSTOP");
      }
      return Object.freeze({ proposalId });
    } catch {
      // Observer-only evidence. The paper engine continues untouched.
      return null;
    }
  }

  /**
   * Attach the EVOLVE paper execution result and hand the fully frozen
   * proposal to the observer queue. Synchronous; never awaited by the engine.
   */
  function recordExecution(handle, execution) {
    if (!running) return;
    try {
      const proposalId = handle?.proposalId;
      if (typeof proposalId !== "string") return;
      const draft = drafts.get(proposalId);
      if (draft === undefined) return;
      drafts.delete(proposalId);
      draft.execution = freezeExecution(execution);
      draft.executionAttachedAtMs = now();
      queue.push(draft);
    } catch {
      counters.observerFailures += 1;
    }
  }

  /* ========================================================================
   * Worker-only: packet construction and judgment recording
   * ======================================================================*/

  function buildPacketFor(proposal) {
    const marketState = proposal.marketState;
    const inputs = { ...marketState, history };
    const computed = extractDirectionFeaturesFromInputs(inputs);
    const featureAudit = auditDirectionFeatures(computed.features);
    if (!featureAudit.ok) {
      throw new Error(`malformed feature vector: ${featureAudit.problems.join("; ")}`);
    }
    const warmup = warmupStatus(computed.features);
    const regime = classifyDirectionRegime(
      [...regimeSnapshots, proposal.regimeSnapshot].filter(Boolean).slice(-regimeSnapshotLimit),
    );
    const packet = buildDirectionPacket({
      experimentId: sessionId,
      observationId: `${proposal.proposalId}-obs`,
      observationIndex: proposal.generationTick ?? 0,
      market: SUPERVISOR_MARKET,
      horizonSeconds: HORIZON_SECONDS,
      sourceEventAt: proposal.sourceEventAtMs === null ? null : iso(proposal.sourceEventAtMs),
      receivedAt: proposal.timestamp,
      stateObservedAt: iso(marketState.observedAt),
      stateAge: null,
      preOutcomeInputDigest: preOutcomeInputDigestOf(inputs),
      features: computed.features,
      recentObservationHistory: computed.historyUsed,
      regime,
      universe: {
        observedMarkets: proposal.regimeSnapshot?.totalMarkets ?? null,
        usableMarkets: proposal.regimeSnapshot?.marketCount ?? null,
        source: "EVOLVE engine observed market feed (paper simulation)",
        endpoints: [],
        synthetic: false,
      },
      quoteObservationAvailable: Number.isFinite(marketState.quoteMarket?.price),
      createdAt: iso(now()),
      generatedBy: { phase: SUPERVISOR_PHASE, observer: SUPERVISOR_OBSERVER_VERSION, warmup },
    });
    const packetAudit = auditDirectionPacket(packet);
    if (!packetAudit.ok) {
      throw new Error(`packet failed the leakage audit: ${JSON.stringify(packetAudit.violations)}`);
    }
    return {
      packet,
      inputs,
      stateDigest: packetStateDigestOf(packet),
      packetDigest: packetDigestOf(packet),
      preOutcomeInputDigest: preOutcomeInputDigestOf(inputs),
    };
  }

  function proposalSummaryOf(proposal) {
    return {
      action: proposal.action,
      reason: proposal.reason,
      directionalComparable: proposal.directionalComparable,
      evolveDirectionalIntent: proposal.evolveDirectionalIntent,
      agentId: proposal.agentId,
      species: proposal.species,
      lineageId: proposal.lineageId,
      researchFamilyId: proposal.researchFamilyId,
      timestamp: proposal.timestamp,
      proposalFrozenAt: proposal.proposalFrozenAt,
      generation: proposal.generation,
      generationTick: proposal.generationTick,
      market: {
        marketId: proposal.market.marketId,
        mint: proposal.market.mint,
        symbol: proposal.market.symbol,
        referencePrice: proposal.market.referencePrice,
      },
    };
  }

  async function processDraft(draft) {
    if (writeArtifacts) await storageReady;
    const proposal = draft.proposalFacts;
    const supported = isSupportedMint(proposal.market?.mint ?? null);
    const marketState = proposal.marketState;
    const priceUsable = Number.isFinite(marketState?.market?.price) && marketState.market.price > 0;
    const timeUsable = Number.isFinite(marketState?.observedAt);

    counters.proposalsObserved += 1;
    if (supported) {
      counters.supportedProposals += 1;
      if (proposal.directionalComparable === true) counters.directionallyComparable += 1;
      else counters.notDirectionallyComparable += 1;
      if (proposal.directionalComparable === true && proposal.action === "ENTER_LONG") counters.entryComparableCount += 1;
      if (proposal.directionalComparable === true && proposal.action === "EXIT_LONG") counters.signalExitComparableCount += 1;
      if (proposal.reason === "STOP") counters.stopObservations += 1;
      else if (proposal.reason === "TAKE") counters.takeObservations += 1;
      else if (proposal.reason === "TIME") counters.timeObservations += 1;
      else if (proposal.action === "EXIT_LONG") counters.otherLifecycleExitObservations += 1;
    } else {
      counters.unsupportedProposals += 1;
      counters.unsupportedProposalCount = counters.unsupportedProposals;
    }

    let jevEvaluation = "EVALUATED";
    let providerStatus = null;
    let failureReason = null;
    let run = null;
    let pHigher = null;
    let stateDigest = null;
    let packetDigest = null;
    let preOutcomeInputDigest = null;
    let observerStartedAtMs = null;
    let observerCompletedAtMs = null;

    if (!supported) {
      jevEvaluation = "UNSUPPORTED_MARKET";
    } else if (!priceUsable || !timeUsable) {
      jevEvaluation = "MARKET_STATE_UNAVAILABLE";
      counters.marketStateUnavailableProposals += 1;
      failureReason = "the SOL/USDC market state was not observed for this proposal; no Jev call was made";
    } else {
      observerStartedAtMs = now();
      try {
        const built = buildPacketFor(proposal);
        stateDigest = built.stateDigest;
        packetDigest = built.packetDigest;
        preOutcomeInputDigest = built.preOutcomeInputDigest;

        if (!pins.ok) {
          // FAIL CLOSED: no call, no fallback, an explicit observer failure.
          providerStatus = "JEV_PIN_MISMATCH";
          failureReason = `the supervisor observer refused to call Jev: ${pins.problems.join("; ")}`;
        } else {
          counters.jevCalls += 1;
          const decided = await jevDecide({
            provider,
            packet: built.packet,
            questions: resolvedQuestions,
            questionSetId: SUPERVISOR_QUESTION_SET_ID,
            questionSetVersion: SUPERVISOR_QUESTION_SET_VERSION,
            decisionPacketVersion: DIRECTION_PACKET_VERSION,
            experimentId: sessionId,
            // No cache, no provider-run persistence in another tree: the only
            // artifacts this session writes live in its own session root.
            root: null,
            cacheEnabled: false,
            budget,
            now,
            salt: `${sessionId}-p${draft.serial}`,
          });
          run = decided.run;
          providerStatus = run?.status ?? null;
          const decision = decided.decision;
          const answer = decision && typeof decision === "object" ? decision[DIRECTION_QUESTION_NAME] ?? null : null;
          pHigher = answer && answer.type === "noul" && Number.isFinite(answer.probability) ? answer.probability : null;
          if (providerStatus !== JEV_STATUS.OK) {
            failureReason = run?.reason ?? `Jev returned ${providerStatus}`;
          }
        }
      } catch (error) {
        providerStatus = "JEV_OBSERVER_ERROR";
        failureReason = `observer error: ${error?.message ?? error}`;
        noteObserverError(error);
      }
      observerCompletedAtMs = now();
    }

    const executedAt = draft.executionAttachedAtMs;
    const executionCompletedBeforeObserverStart =
      Number.isFinite(executedAt) && Number.isFinite(observerStartedAtMs) ? executedAt <= observerStartedAtMs : null;

    // ---- frozen judgment semantics (unchanged by any result) --------------
    const modelIntent = modelIntentFromProbability(pHigher);
    const exactlyHalf = exactlyHalfOf(pHigher);
    const distanceFromHalf = distanceFromHalfOf(pHigher);
    const { agreement, agreementReason } = agreementFor({
      directionalComparable: proposal.directionalComparable,
      evolveDirectionalIntent: proposal.evolveDirectionalIntent,
      modelIntent,
    });

    if (jevEvaluation === "EVALUATED") {
      if (providerStatus === JEV_STATUS.OK) counters.jevOk += 1;
      else counters.jevFailures += 1;
      observeLatency(aggregates, run?.latencyMs ?? null);
      observeProviderStatus(aggregates, providerStatus);
      observeProbability(aggregates, pHigher);
      if (exactlyHalf) counters.exactHalfCount += 1;
      if (agreement === SUPERVISOR_AGREEMENT.AGREE) counters.agreementCount += 1;
      else if (agreement === SUPERVISOR_AGREEMENT.DISAGREE) counters.disagreementCount += 1;
    }

    const proposalRecord = {
      schemaVersion: SUPERVISOR_SCHEMA_VERSION,
      recordType: "PROPOSAL",
      phase: SUPERVISOR_PHASE,
      kind: SUPERVISOR_KIND,
      sessionId,
      ...SUPERVISOR_CLASSIFICATION,
      sequence: draft.serial,
      supported,
      supportedMarketId: supported ? SUPERVISOR_MARKET_ID : null,
      unsupportedReason: supported ? null : SUPERVISOR_UNSUPPORTED_MARKET_REASON,
      jevEvaluation,
      proposalFrozenAt: proposal.proposalFrozenAt,
      proposalFrozenAtMs: draft.frozenAtMs,
      proposal,
      proposalDigest: draft.digest,
      evolveExecution: draft.execution,
      executionAttachedAt: iso(draft.executionAttachedAtMs),
      executionCompletedBeforeObserverStart,
      observerStartedAt: iso(observerStartedAtMs),
      observerCompletedAt: iso(observerCompletedAtMs),
      providerStatus,
      failureReason,
      pHigher,
      modelIntent,
      agreement,
    };

    const judgmentRecord =
      jevEvaluation === "EVALUATED"
        ? {
            schemaVersion: SUPERVISOR_SCHEMA_VERSION,
            recordType: "JUDGMENT",
            phase: SUPERVISOR_PHASE,
            kind: SUPERVISOR_KIND,
            sessionId,
            ...SUPERVISOR_CLASSIFICATION,
            judgmentId: `${sessionId}-j${pad(draft.serial)}`,
            sequence: draft.serial,
            proposalId: draft.proposalId,
            supported,
            proposal: proposalSummaryOf(proposal),
            proposalDigest: draft.digest,
            evolveExecution: draft.execution,
            executionAttachedAt: iso(draft.executionAttachedAtMs),
            executionCompletedBeforeObserverStart,
            // The EVOLVE paper decision was made and executed BEFORE this
            // observer began. Nothing below was, or can be, fed back.
            evolveExecutionPrecededObservation: true,
            observerStartedAt: iso(observerStartedAtMs),
            observerCompletedAt: iso(observerCompletedAtMs),
            provider: identity.provider,
            model: identity.model,
            upstream: identity.upstream,
            gatewayUsed: false,
            cacheEnabled: false,
            requestId: run?.requestId ?? null,
            latencyMs: Number.isFinite(run?.latencyMs) ? run.latencyMs : null,
            providerAttemptCount: Number.isFinite(run?.providerAttemptCount) ? run.providerAttemptCount : null,
            providerStatus,
            failureReason,
            pHigher,
            pLower: Number.isFinite(pHigher) ? 1 - pHigher : null,
            modelIntent,
            exactlyHalf,
            distanceFromHalf,
            agreement,
            agreementReason,
            stateDigest,
            packetDigest,
            preOutcomeInputDigest,
            questionSetId: SUPERVISOR_QUESTION_SET_ID,
            questionSetVersion: SUPERVISOR_QUESTION_SET_VERSION,
            questionDigest,
            featureDefinitionVersion: SUPERVISOR_FEATURE_DEFINITION_VERSION,
            featureDefinitionDigest: SUPERVISOR_FEATURE_DEFINITION_DIGEST,
            confidenceThresholdApplied: false,
            note:
              "Agreement/disagreement record only. This judgment was produced after the EVOLVE paper execution " +
              "completed, has zero authority, and is never consumed by the simulation.",
          }
        : null;

    const row = compactSupervisorRow({
      proposal: proposalSummaryOf(proposal),
      evolveExecution: draft.execution,
      pHigher,
      pLower: Number.isFinite(pHigher) ? 1 - pHigher : null,
      modelIntent,
      agreement,
      exactlyHalf,
      providerStatus,
      supported,
      observerCompletedAt: iso(observerCompletedAtMs),
      observerStartedAt: iso(observerStartedAtMs),
    });
    row.jevEvaluation = jevEvaluation;

    lastProposalAt = proposal.timestamp;
    if (judgmentRecord !== null) lastJudgmentAt = judgmentRecord.observerCompletedAt;
    recentRows = [...recentRows, row].slice(-SUPERVISOR_RECENT_ROW_LIMIT);

    if (writeArtifacts) {
      try {
        await appendSupervisorProposal(root, proposalRecord);
        if (judgmentRecord !== null) await appendSupervisorJudgment(root, judgmentRecord);
      } catch (error) {
        noteObserverError(error);
        failureReason = `observer storage error: ${error?.message ?? error}`;
      }
    }

    // Pre-decision history only grows from genuinely observed SOL state.
    if (jevEvaluation === "EVALUATED") {
      history = [
        ...history,
        { observedAt: iso(marketState.observedAt), observedAtMs: marketState.observedAt, priceUsd: marketState.market.price },
      ].slice(-historyLimit);
      if (Array.isArray(proposal.regimeSnapshot?.markets) && proposal.regimeSnapshot.markets.length > 0) {
        regimeSnapshots = [...regimeSnapshots, proposal.regimeSnapshot].slice(-regimeSnapshotLimit);
      }
    }

    if (typeof onRow === "function") {
      try {
        onRow(row);
      } catch {
        /* observer-only */
      }
    }

    await publishState({ status: lifecycle });
  }

  /* ========================================================================
   * Worker lifecycle — started with `void`, never awaited by the simulation
   * ======================================================================*/

  async function workerLoop() {
    while (running) {
      const draft = queue.shift();
      if (draft === null) {
        await sleep(SUPERVISOR_WORKER_IDLE_MS);
        continue;
      }
      try {
        await processDraft(draft);
      } catch (error) {
        noteObserverError(error);
      }
      if (pendingDropLines.length > 0) await flushDropLines();
    }
  }

  /**
   * Start the asynchronous observer worker. Returns the observer (NOT a
   * promise), so no caller can await it by accident, and the simulation never
   * holds a reference to it at all.
   */
  function start() {
    if (workerPromise === null) {
      workerPromise = workerLoop();
      workerPromise.catch((error) => {
        noteObserverError(error);
      });
    }
    return api;
  }

  /**
   * Finalize the session: stop the worker, wait a BOUNDED time for in-flight
   * work, then write the descriptive summary and the final state. Idempotent.
   */
  async function finalize({ status = "COMPLETE" } = {}) {
    if (finalized) return finalizedStateDoc;
    lifecycle = "FINALIZING";
    running = false;
    if (workerPromise !== null) {
      await Promise.race([
        workerPromise.catch(() => {}),
        (async () => {
          await sleep(finalizeTimeoutMs);
        })(),
      ]);
    }
    await storageReady;
    await flushDropLines();

    const finalizedAt = iso(now());
    const summary = buildSupervisorSummary({
      session: sessionRecord,
      counters,
      aggregates,
      queue,
      status,
      finalizedAt,
      recentRowCount: recentRows.length,
      droppedRecordCount: droppedRecords.length,
    });
    lifecycle = status;
    const finalState = publishedStateDoc(status);

    if (writeArtifacts) {
      try {
        await writeSupervisorSummary(root, summary);
        await writeSupervisorState(root, finalState);
        await writeSupervisorSession(root, {
          ...sessionRecord,
          status,
          updatedAt: finalizedAt,
          finalizedAt,
          counters: { ...counters },
          queueHighWatermark: queue.highWatermark,
          queueDropped: queue.dropped,
          finalizeTimedOut: running,
        });
      } catch (error) {
        noteObserverError(error);
      }
    }

    finalizedSummary = summary;
    finalizedStateDoc = finalState;
    finalized = true;
    return finalState;
  }

  /** Read-only in-memory snapshot (pure; no I/O, no engine access). */
  function snapshot() {
    return {
      sessionId,
      sessionRoot: root,
      status: lifecycle,
      finalized,
      pins,
      identity,
      counters: { ...counters, proposalsSeenByTap },
      aggregates: { ...aggregates, providerStatusCounts: { ...aggregates.providerStatusCounts } },
      queue: {
        capacity: queue.capacity,
        depth: queue.depth,
        highWatermark: queue.highWatermark,
        dropped: queue.dropped,
        pushed: queue.pushed,
      },
      lastObserverError,
      pendingDrafts: drafts.size,
      recentRows: [...recentRows],
      droppedRecords: [...droppedRecords],
      historyLength: history.length,
      regimeSnapshotCount: regimeSnapshots.length,
    };
  }

  const api = {
    version: SUPERVISOR_OBSERVER_VERSION,
    sessionId,
    sessionRoot: root,
    baseRoot: resolvedBaseRoot,
    // ---- the passive tap (synchronous; called by the simulation) -----------
    freezeProposal,
    recordExecution,
    // ---- observer lifecycle ------------------------------------------------
    start,
    finalize,
    ready: () => storageReady,
    // ---- read-only introspection (never touched by the engine) -------------
    snapshot,
    publishedState: () => publishedStateDoc(lifecycle),
    summary: () => finalizedSummary,
    isFinalized: () => finalized,
    queueCapacity: SUPERVISOR_QUEUE_CAPACITY,
  };

  return api;
}
