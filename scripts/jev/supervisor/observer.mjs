import { createSolFunnel } from "./sol-funnel.mjs";
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
 *      queue, consumes capture-time SOL inputs in the EXISTING Phase 5I
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
  SUPERVISOR_EXECUTED_TRADE_EVIDENCE_TYPE,
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
  SUPERVISOR_MAX_UNSUPPORTED_SAMPLE,
  SUPERVISOR_MODE,
  SUPERVISOR_PHASE,
  SUPERVISOR_PHASE_EXTENSION,
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
  SUPERVISOR_SOL_DEDUP_RULE,
  SUPERVISOR_SOL_OPPORTUNITY_EVIDENCE_TYPE,
  SUPERVISOR_SOL_QUEUE_CAPACITY,
  SUPERVISOR_STATE_PUBLISH_INTERVAL_MS,
  SUPERVISOR_SUPPORTED_MARKET_IDS,
  SUPERVISOR_SUPPORTED_MINTS,
  SUPERVISOR_QUOTE_MINT,
  SUPERVISOR_UNSUPPORTED_MARKET_REASON,
  SUPERVISOR_WORKER_IDLE_MS,
  SUPERVISOR_AGREEMENT,
  isValidSupervisorSessionId,
  supervisorSessionRootFor,
} from "./definition.mjs";
import { createBoundedObserverQueue } from "./queue.mjs";
import {
  agreementFor,
  buildProposalFacts,
  buildSolOpportunityFacts,
  deepFreeze,
  distanceFromHalfOf,
  exactlyHalfOf,
  freezeExecution,
  freezeSolSelection,
  isSupportedMint,
  modelIntentFromProbability,
  proposalDigestOf,
  solOpportunityDigestOf,
} from "./tap.mjs";
import {
  appendSupervisorJudgment,
  appendSupervisorProposal,
  appendSupervisorSolJudgment,
  appendSupervisorSolOpportunity,
  writeSupervisorSession,
  writeSupervisorState,
  writeSupervisorSummary,
} from "./storage.mjs";
import {
  buildSupervisorState,
  buildSupervisorSummary,
  compactSolOpportunityRow,
  compactSupervisorRow,
  createSupervisorAggregates,
  createSupervisorCounters,
  observeLatency,
  observeProbability,
  observeProviderStatus,
  observeSolLatency,
  observeSolProbability,
  observeSolProviderStatus,
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

  const resolvedQuestions = deepFreeze(structuredClone(questions ?? buildDirectionQuestions()));
  const questionDigest = preOutcomeInputDigestOf(resolvedQuestions);
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

  // ---- PS.2a SOL opportunity state (observer-only) ------------------------
  // A SEPARATE bounded queue, a separate dedup ledger, and a separate judgment
  // map. None of this can consume the executed-proposal queue, and none of it
  // is ever read by the engine.
  /** @type {Map<string, object>} */
  const solDrafts = new Map();
  /** jevInputDigest -> { jevJudgmentId, reuseCount, packetDigest, ... } */
  const solJudgments = new Map();
  const solStateSeen = new Set();
  let solOpportunitySerial = 0;
  let solJudgmentSerial = 0;
  const solFunnel = createSolFunnel();
  function observeSolFunnel(facts) {
    if (!running) return;
    try { solFunnel.observe(facts); } catch (error) { noteObserverError(error); }
  }
  let unsupportedRecentSample = [];
  let solDroppedRecords = [];
  let lastSolOpportunityAt = null;
  let lastSolJudgmentAt = null;
  // Agent/generation dedup ledger: reset NATURALLY when the generation changes.
  let solDedupGeneration = null;
  let solDedupAgentIds = new Set();

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

  const solQueue = createBoundedObserverQueue({
    capacity: SUPERVISOR_SOL_QUEUE_CAPACITY,
    onDrop: (draft) => recordSolDrop(draft, "SOL_QUEUE_FULL"),
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
    phaseExtension: SUPERVISOR_PHASE_EXTENSION,
    queueCapacity: SUPERVISOR_QUEUE_CAPACITY,
    solQueueCapacity: SUPERVISOR_SOL_QUEUE_CAPACITY,
    solDedupRule: SUPERVISOR_SOL_DEDUP_RULE,
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

  /**
   * Bounded record of an UNSUPPORTED executed-trade proposal. Unsupported
   * markets are known synchronously from the mint identity, so they are counted
   * and sampled here and NEVER enqueued into the Jev work queue (the run-1
   * flooding bug: 42 311 proposals, 1 097 queue drops, zero calls).
   */
  function recordUnsupportedSample(entry) {
    unsupportedRecentSample = [...unsupportedRecentSample, entry].slice(-SUPERVISOR_MAX_UNSUPPORTED_SAMPLE);
    counters.unsupportedRecentSampleCount = unsupportedRecentSample.length;
  }

  /** A SOL opportunity that could not be retained because the SOL queue was full. */
  function recordSolDrop(draft, dropReason) {
    counters.solQueueDropped += 1;
    const record = {
      recordType: "SOL_OPPORTUNITY_DROPPED",
      evidenceType: SUPERVISOR_SOL_OPPORTUNITY_EVIDENCE_TYPE,
      sessionId,
      opportunityId: draft?.opportunityId ?? null,
      at: iso(now()),
      dropReason,
      agentId: draft?.opportunityFacts?.agentId ?? null,
      note:
        "A SOL OPPORTUNITY (not a trade) was dropped explicitly at the frozen SOL queue capacity. The paper engine " +
        "was never slowed, blocked, or altered, and the executed-proposal queue was never touched.",
    };
    solDroppedRecords = [...solDroppedRecords, record].slice(-SUPERVISOR_MAX_DROP_RECORDS);
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
      solQueue,
      status,
      recentRows,
      droppedRecords,
      unsupportedRecentSample,
      solFunnel: solFunnel.snapshot(),
      lastProposalAt,
      lastJudgmentAt,
      lastSolOpportunityAt,
      lastSolJudgmentAt,
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
      const at = Number.isFinite(facts?.at) ? facts.at : null;
      const mint =
        typeof facts?.market?.mint === "string"
          ? facts.market.mint
          : typeof facts?.position?.mint === "string"
            ? facts.position.mint
            : null;
      counters.executedTradeProposals += 1;
      counters.totalExecutionProposalsObserved += 1;
      if (at !== null) lastProposalAt = iso(at);

      // PS.2 fix: an unsupported market is known SYNCHRONOUSLY from the mint
      // identity. Count it and keep a bounded sample only — never enqueue it,
      // never build a market-state projection or packet, never call Jev, and
      // never consume a slot in the Jev evaluation queue.
      if (!isSupportedMint(mint)) {
        counters.unsupportedProposals += 1;
        counters.unsupportedProposalCount = counters.unsupportedProposals;
        recordUnsupportedSample({
          proposalId,
          at: iso(at),
          action: typeof facts?.action === "string" ? facts.action : null,
          reason: typeof facts?.reason === "string" ? facts.reason : null,
          agentId: typeof facts?.agentId === "string" ? facts.agentId : null,
          mint,
          symbol:
            typeof facts?.market?.symbol === "string"
              ? facts.market.symbol
              : typeof facts?.position?.symbol === "string"
                ? facts.position.symbol
                : null,
          // NEVER a fabricated identity: an arbitrary asset is not SOL-USDC.
          marketId: null,
          supported: false,
          unsupportedReason: SUPERVISOR_UNSUPPORTED_MARKET_REASON,
        });
        return Object.freeze({ proposalId, unsupported: true });
      }

      const proposalFacts = buildProposalFacts(facts, { proposalId, sessionId, regimeMarketLimit });
      const draft = {
        proposalId,
        serial: proposalSerial,
        proposalFacts,
        packetContext: freezePacketContext(proposalFacts),
        digest: proposalDigestOf(proposalFacts),
        frozenAtMs: now(),
        execution: null,
        executionAttachedAtMs: null,
      };
      rememberObservedState(proposalFacts);
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
      if (handle?.unsupported === true) return; // counted at tap; never queued
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
   * THE PS.2a SOL OPPORTUNITY TAP — synchronous, bounded, non-throwing
   * ======================================================================*/

  /**
   * Reset the dedup ledger the moment the generation changes, so eligibility
   * is restored naturally for the next generation. Bounded by population size
   * per generation. The rule NEVER consults a score, a Jev answer or a price.
   */
  function solDedupAllows({ agentId, generation }) {
    if (solDedupGeneration !== generation) {
      solDedupGeneration = generation;
      solDedupAgentIds = new Set();
    }
    if (solDedupAgentIds.has(agentId)) return false;
    solDedupAgentIds.add(agentId);
    return true;
  }

  /**
   * Freeze one actionable SOL observation. Returns an opaque handle, or null
   * when it was suppressed by the agent/generation sampling rule (or when the
   * observation was malformed). Synchronous; never awaited by the engine.
   */
  function observeSolOpportunity(facts) {
    if (!running) return null;
    try {
      const agentId = typeof facts?.agentId === "string" ? facts.agentId : null;
      const generation = Number.isFinite(facts?.generation) ? facts.generation : null;
      if (agentId === null || generation === null) return null;
      counters.solOpportunityObservations += 1;
      if (!solDedupAllows({ agentId, generation })) {
        counters.opportunitiesSuppressedByAgentGenerationDedup += 1;
        observeSolFunnel({ kind: "suppressed", species: facts.species });
        return null;
      }
      solOpportunitySerial += 1;
      const opportunityId = `${sessionId}-sol${pad(solOpportunitySerial)}`;
      const opportunityFacts = buildSolOpportunityFacts(facts, { opportunityId, sessionId, regimeMarketLimit });
      const draft = {
        opportunityId,
        serial: solOpportunitySerial,
        opportunityFacts,
        frozenJev: freezeSolJevInput(opportunityFacts),
        digest: solOpportunityDigestOf(opportunityFacts),
        selection: null,
        frozenAtMs: now(),
        selectionAttachedAtMs: null,
      };
      solDrafts.set(opportunityId, draft);
      if (solDrafts.size > SUPERVISOR_MAX_PENDING_DRAFTS) {
        const oldest = solDrafts.keys().next().value;
        const evicted = solDrafts.get(oldest);
        solDrafts.delete(oldest);
        recordSolDrop(evicted, "SOL_PENDING_DRAFT_BACKSTOP");
      }
      counters.solOpportunityProposals += 1;
      observeSolFunnel({ kind: "captured", species: facts.species });
      return Object.freeze({ opportunityId });
    } catch {
      observeSolFunnel({ kind: "capture_error", species: facts?.species });
      // Observer-only evidence. The paper engine continues untouched.
      return null;
    }
  }

  /**
   * Attach which market EVOLVE ACTUALLY selected for this decision. This is the
   * observer learning a fact about a decision that was already made; it is
   * never returned to the engine and never influences selection.
   */
  function recordSolSelection(handle, selection) {
    if (!running) return;
    try {
      const opportunityId = handle?.opportunityId;
      if (typeof opportunityId !== "string") return;
      const draft = solDrafts.get(opportunityId);
      if (draft === undefined) return;
      solDrafts.delete(opportunityId);
      draft.selection = freezeSolSelection(selection);
      draft.selectionAttachedAtMs = now();
      solQueue.push(draft);
    } catch {
      counters.observerFailures += 1;
    }
  }

  /* ========================================================================
   * Worker-only: packet construction and judgment recording
   * ======================================================================*/

  // Capture-time copies only. Neither worker completion nor queue delay can
  // change the history available to subsequent captures.
  function freezePacketContext(proposal) {
    return deepFreeze(structuredClone({
      history,
      regimeSnapshots: [...regimeSnapshots, proposal.regimeSnapshot].filter(Boolean).slice(-regimeSnapshotLimit),
      createdAt: proposal.timestamp,
    }));
  }

  function rememberObservedState(proposal) {
    const state = proposal.marketState;
    if (!Number.isFinite(state?.observedAt) || !(state?.market?.price > 0)) return;
    history = [...history, {
      observedAt: iso(state.observedAt), observedAtMs: state.observedAt, priceUsd: state.market.price,
    }].slice(-historyLimit);
    if (proposal.regimeSnapshot?.markets?.length > 0) {
      regimeSnapshots = [...regimeSnapshots, proposal.regimeSnapshot].slice(-regimeSnapshotLimit);
    }
  }

  function freezeSolJevInput(opportunity) {
    try {
      const built = buildPacketFor(opportunity, freezePacketContext(opportunity), { shared: true });
      // Reuse the canonical Phase 5I input digest over the COMPLETE TypeSafe
      // systemOne payload. packetDigestOf deliberately omits metadata, so it
      // alone cannot prove that the actual supplied payload is identical.
      const jevInput = { state: built.packet, questions: resolvedQuestions, model: SUPERVISOR_REQUIRED_MODEL };
      return deepFreeze({ ...built, jevInput, jevInputDigest: preOutcomeInputDigestOf(jevInput), error: null });
    } catch (error) {
      return deepFreeze({ jevInputDigest: null, error: String(error?.message ?? error) });
    }
  }

  function buildPacketFor(proposal, context, { shared = false } = {}) {
    const marketState = proposal.marketState;
    const inputs = { ...marketState, history: context.history, regimeSnapshots: context.regimeSnapshots };
    const computed = extractDirectionFeaturesFromInputs(inputs);
    const featureAudit = auditDirectionFeatures(computed.features);
    if (!featureAudit.ok) {
      throw new Error(`malformed feature vector: ${featureAudit.problems.join("; ")}`);
    }
    const warmup = warmupStatus(computed.features);
    const regime = classifyDirectionRegime(
      inputs.regimeSnapshots,
    );
    const observationSubjectId = proposal.proposalId ?? proposal.opportunityId ?? "obs";
    const packet = buildDirectionPacket({
      experimentId: sessionId,
      observationId: shared ? null : `${observationSubjectId}-obs`,
      observationIndex: shared ? null : proposal.generationTick ?? 0,
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
      createdAt: context.createdAt,
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
        const built = buildPacketFor(proposal, draft.packetContext);
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
      evidenceType: SUPERVISOR_EXECUTED_TRADE_EVIDENCE_TYPE,
      phase: SUPERVISOR_PHASE,
      phaseExtension: SUPERVISOR_PHASE_EXTENSION,
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
            evidenceType: SUPERVISOR_EXECUTED_TRADE_EVIDENCE_TYPE,
            phase: SUPERVISOR_PHASE,
            phaseExtension: SUPERVISOR_PHASE_EXTENSION,
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
   * Worker-only: PS.2a SOL opportunity processing + complete-input judgment dedup
   * ======================================================================*/

  /**
   * Process one frozen EVOLVE_SOL_OPPORTUNITY.
   *
   * Jev receives the capture-time packet and questions. At most ONE call is
   * made per identical complete input. Every matching agent opportunity
   * references the same judgment. This is call deduplication only:
   * no individual opportunity record is ever merged or discarded here.
   */
  async function processSolOpportunity(draft) {
    if (writeArtifacts) await storageReady;
    const opportunity = draft.opportunityFacts;
    const marketState = opportunity.marketState;
    counters.solOpportunities += 1;

    // Partial current-state identity remains descriptive; NEVER the reuse key.
    const frozenJev = draft.frozenJev;
    const jevInputDigest = frozenJev.jevInputDigest;
    const preOutcomeInputDigest = frozenJev.preOutcomeInputDigest ?? null;
    const stateDigest = preOutcomeInputDigestOf(marketState);
    const marketObservationId = `${sessionId}-mob-${stateDigest.slice(0, 12)}`;
    if (!solStateSeen.has(stateDigest)) {
      solStateSeen.add(stateDigest);
      counters.uniqueSolMarketStates = solStateSeen.size;
    }

    const selection = draft.selection ?? freezeSolSelection(null);
    const solWasActuallySelected = selection.actualSelectedMint === opportunity.solMint;
    if (solWasActuallySelected) counters.solActuallySelected += 1;
    else counters.solNotSelected += 1;

    const existing = jevInputDigest === null ? null : solJudgments.get(jevInputDigest) ?? null;
    const judgmentReused = existing !== null;
    let judgment = existing;
    let judgmentReuseCount = existing?.reuseCount ?? 0;
    let providerStatus = existing?.providerStatus ?? null;
    let failureReason = existing?.failureReason ?? null;

    const priceUsable = Number.isFinite(marketState?.market?.price) && marketState.market.price > 0;
    const timeUsable = Number.isFinite(marketState?.observedAt);

    if (judgmentReused) {
      judgment.reuseCount += 1;
      judgmentReuseCount = judgment.reuseCount;
      counters.reusedJevJudgments += 1;
    } else {
      let pHigher = null;
      let run = null;
      let packetDigestValue = null;
      let observerCompletedAtMs = null;

      if (!priceUsable || !timeUsable) {
        providerStatus = "MARKET_STATE_UNAVAILABLE";
        failureReason = "the frozen SOL market state was not observable; no Jev call was made";
      } else {
        try {
          if (frozenJev.error) throw new Error(frozenJev.error);
          const built = frozenJev;
          packetDigestValue = built.packetDigest;
          if (!pins.ok) {
            // FAIL CLOSED: no call, no fallback, an explicit observer failure.
            providerStatus = "JEV_PIN_MISMATCH";
            failureReason = `the supervisor observer refused to call Jev: ${pins.problems.join("; ")}`;
          } else {
            counters.jevCallsForSolStates += 1;
            const decided = await jevDecide({
              provider,
              packet: built.packet,
              questions: resolvedQuestions,
              questionSetId: SUPERVISOR_QUESTION_SET_ID,
              questionSetVersion: SUPERVISOR_QUESTION_SET_VERSION,
              decisionPacketVersion: DIRECTION_PACKET_VERSION,
              experimentId: sessionId,
              root: null,
              cacheEnabled: false,
              budget,
              now,
              salt: `${sessionId}-sol${draft.serial}`,
            });
            run = decided.run;
            providerStatus = run?.status ?? null;
            const decision = decided.decision;
            const answer = decision && typeof decision === "object" ? decision[DIRECTION_QUESTION_NAME] ?? null : null;
            pHigher =
              answer && answer.type === "noul" && Number.isFinite(answer.probability) ? answer.probability : null;
            if (providerStatus !== JEV_STATUS.OK) failureReason = run?.reason ?? `Jev returned ${providerStatus}`;
          }
        } catch (error) {
          providerStatus = "JEV_OBSERVER_ERROR";
          failureReason = `observer error: ${error?.message ?? error}`;
          noteObserverError(error);
        }
        observerCompletedAtMs = now();
      }

      if (providerStatus === JEV_STATUS.OK) {
        counters.solJevOk += 1;
        observeSolLatency(aggregates, run?.latencyMs ?? null);
        observeSolProbability(aggregates, pHigher);
      } else {
        counters.solJevFailures += 1;
      }
      observeSolProviderStatus(aggregates, providerStatus);

      solJudgmentSerial += 1;
      judgment = {
        jevJudgmentId: `${sessionId}-solj${pad(solJudgmentSerial)}`,
        reuseCount: 0,
        pHigher,
        pLower: Number.isFinite(pHigher) ? 1 - pHigher : null,
        modelIntent: modelIntentFromProbability(pHigher),
        exactlyHalf: exactlyHalfOf(pHigher),
        providerStatus,
        failureReason,
        stateDigest,
        jevInputDigest,
        preOutcomeInputDigest,
        packetDigest: packetDigestValue,
        marketObservationId,
        provider: identity.provider,
        model: identity.model,
        upstream: identity.upstream,
        requestId: run?.requestId ?? null,
        latencyMs: Number.isFinite(run?.latencyMs) ? run.latencyMs : null,
        providerAttemptCount: Number.isFinite(run?.providerAttemptCount) ? run.providerAttemptCount : null,
        judgedAt: iso(observerCompletedAtMs),
      };
      if (jevInputDigest !== null) solJudgments.set(jevInputDigest, judgment);
    }

    const modelIntent = judgment?.modelIntent ?? null;
    const exactlyHalf = judgment?.exactlyHalf === true;
    const { agreement, agreementReason } = agreementFor({
      directionalComparable: true,
      evolveDirectionalIntent: opportunity.evolveDirectionalIntent,
      modelIntent,
    });
    if (agreement === SUPERVISOR_AGREEMENT.AGREE) counters.solAgreementCount += 1;
    else if (agreement === SUPERVISOR_AGREEMENT.DISAGREE) counters.solDisagreementCount += 1;
    if (exactlyHalf) counters.solExactHalfCount += 1;

    const opportunityRecord = {
      schemaVersion: SUPERVISOR_SCHEMA_VERSION,
      recordType: "SOL_OPPORTUNITY",
      evidenceType: SUPERVISOR_SOL_OPPORTUNITY_EVIDENCE_TYPE,
      phase: SUPERVISOR_PHASE,
      phaseExtension: SUPERVISOR_PHASE_EXTENSION,
      kind: SUPERVISOR_KIND,
      sessionId,
      ...SUPERVISOR_CLASSIFICATION,
      sequence: draft.serial,
      isExecutedTrade: false,
      opportunityId: opportunity.opportunityId,
      generation: opportunity.generation,
      generationTick: opportunity.generationTick,
      agentId: opportunity.agentId,
      species: opportunity.species,
      lineageId: opportunity.lineageId,
      researchFamilyId: opportunity.researchFamilyId,
      timestamp: opportunity.timestamp,
      solMint: opportunity.solMint,
      symbol: opportunity.symbol,
      referencePrice: opportunity.referencePrice,
      liquidity: opportunity.liquidity,
      solScore: opportunity.solScore,
      agentEntryThreshold: opportunity.agentEntryThreshold,
      scoreMargin: opportunity.scoreMargin,
      passesGates: true,
      actionable: true,
      evolveDirectionalIntent: opportunity.evolveDirectionalIntent,
      directionalComparable: true,
      actualSelectedMint: selection.actualSelectedMint,
      actualSelectedSymbol: selection.actualSelectedSymbol,
      actualSelectedScore: selection.actualSelectedScore,
      solWasActuallySelected,
      marketObservationId,
      stateDigest,
      jevInputDigest,
      preOutcomeInputDigest,
      packetDigest: judgment?.packetDigest ?? null,
      jevJudgmentId: judgment?.jevJudgmentId ?? null,
      judgmentReused,
      judgmentReuseCount,
      pHigher: judgment?.pHigher ?? null,
      pLower: judgment?.pLower ?? null,
      modelIntent,
      exactlyHalf,
      agreement,
      agreementReason,
      providerStatus: judgment?.providerStatus ?? null,
      failureReason: judgment?.failureReason ?? null,
      confidenceThresholdApplied: false,
      note:
        "SOL OPPORTUNITY only: the agent independently considered SOL actionable. This is NOT an executed trade " +
        "and the record never influenced which market EVOLVE selected.",
    };

    const solJudgmentRecord =
      judgmentReused || judgment === null
        ? null
        : {
            schemaVersion: SUPERVISOR_SCHEMA_VERSION,
            recordType: "SOL_JUDGMENT",
            evidenceType: SUPERVISOR_SOL_OPPORTUNITY_EVIDENCE_TYPE,
            phase: SUPERVISOR_PHASE,
            phaseExtension: SUPERVISOR_PHASE_EXTENSION,
            kind: SUPERVISOR_KIND,
            sessionId,
            ...SUPERVISOR_CLASSIFICATION,
            judgmentId: judgment.jevJudgmentId,
            marketObservationId,
            stateDigest,
            jevInputDigest,
            preOutcomeInputDigest,
            packetDigest: judgment.packetDigest,
            provider: identity.provider,
            model: identity.model,
            upstream: identity.upstream,
            gatewayUsed: false,
            cacheEnabled: false,
            providerStatus: judgment.providerStatus,
            failureReason: judgment.failureReason,
            requestId: judgment.requestId,
            latencyMs: judgment.latencyMs,
            providerAttemptCount: judgment.providerAttemptCount,
            pHigher: judgment.pHigher,
            pLower: judgment.pLower,
            modelIntent: judgment.modelIntent,
            exactlyHalf: judgment.exactlyHalf,
            judgedAt: judgment.judgedAt,
            questionSetId: SUPERVISOR_QUESTION_SET_ID,
            questionSetVersion: SUPERVISOR_QUESTION_SET_VERSION,
            questionDigest,
            featureDefinitionVersion: SUPERVISOR_FEATURE_DEFINITION_VERSION,
            featureDefinitionDigest: SUPERVISOR_FEATURE_DEFINITION_DIGEST,
            confidenceThresholdApplied: false,
            note:
              "One complete frozen SOL input judgment, reused only for an identical packet, questions and model. " +
              "Jev received pre-outcome market evidence only and this judgment has zero authority.",
          };

    lastSolOpportunityAt = opportunity.timestamp;
    if (solJudgmentRecord !== null) lastSolJudgmentAt = judgment.judgedAt;
    const row = compactSolOpportunityRow({
      opportunity: opportunityRecord,
      judgmentSummary: judgment === null ? null : { ...judgment, judgmentReused, judgmentReuseCount },
      agreement,
      exactlyHalf,
    });
    recentRows = [...recentRows, row].slice(-SUPERVISOR_RECENT_ROW_LIMIT);

    if (writeArtifacts) {
      try {
        await appendSupervisorSolOpportunity(root, opportunityRecord);
        if (solJudgmentRecord !== null) await appendSupervisorSolJudgment(root, solJudgmentRecord);
      } catch (error) {
        noteObserverError(error);
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
      const solDraft = solQueue.shift();
      if (draft === null && solDraft === null) {
        // Publish funnel-only sessions too: absence of opportunities is evidence.
        if (writeArtifacts) {
          await storageReady;
          await publishState();
        }
        await sleep(SUPERVISOR_WORKER_IDLE_MS);
        continue;
      }
      try {
        if (draft !== null) await processDraft(draft);
        if (solDraft !== null) await processSolOpportunity(solDraft);
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
      solQueue,
      status,
      finalizedAt,
      lastProposalAt,
      lastJudgmentAt,
      lastSolOpportunityAt,
      lastSolJudgmentAt,
      unsupportedRecentSample,
      solFunnel: solFunnel.snapshot(),
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
          solQueueHighWatermark: solQueue.highWatermark,
          solQueueDropped: solQueue.dropped,
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
      aggregates: {
        ...aggregates,
        providerStatusCounts: { ...aggregates.providerStatusCounts },
        solProviderStatusCounts: { ...aggregates.solProviderStatusCounts },
      },
      queue: {
        capacity: queue.capacity,
        depth: queue.depth,
        highWatermark: queue.highWatermark,
        dropped: queue.dropped,
        pushed: queue.pushed,
      },
      solQueue: {
        capacity: solQueue.capacity,
        depth: solQueue.depth,
        highWatermark: solQueue.highWatermark,
        dropped: solQueue.dropped,
        pushed: solQueue.pushed,
      },
      lastObserverError,
      lastProposalAt,
      lastJudgmentAt,
      lastSolOpportunityAt,
      lastSolJudgmentAt,
      pendingDrafts: drafts.size,
      pendingSolDrafts: solDrafts.size,
      unsupportedRecentSample: [...unsupportedRecentSample],
      solFunnel: solFunnel.snapshot(),
      solDroppedRecords: [...solDroppedRecords],
      uniqueSolMarketStates: solStateSeen.size,
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
    // ---- the PS.2a SOL opportunity tap (synchronous; called by the engine) --
    // `solMint` is the ONE market identity the engine may sample for
    // opportunities. The engine reads it and nothing else.
    solMint: SUPERVISOR_SUPPORTED_MINTS[0] ?? null,
    observeSolOpportunity,
    observeSolFunnel,
    recordSolSelection,
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
