/**
 * Jev shadow decision orchestration (Phase 5D).
 *
 * The one function every caller (the `jev` CLI, the probe, the validators)
 * uses to ask Jev a fixed question set about a bounded decision packet:
 *
 *   deterministic EVOLVE state
 *     -> bounded TRAIN-safe decision packet (scripts/jev/decision-packet.mjs)
 *     -> Jev typed questions (scripts/jev/questions.mjs)
 *     -> shadow prediction (this module, via a resolved provider)
 *     -> persisted immutable prediction (scripts/jev/experiment.mjs)
 *     -> normal deterministic EVOLVE proceeds UNCHANGED
 *
 * INVARIANT: nothing returned from here is ever fed back into the compiler,
 * watchdog, Arena scoring, gates, species matching, or promotion logic. The
 * caller decides what to do with a `NO_JEV_DECISION` exactly the same way it
 * would decide what to do with a real one: nothing — Jev is advisory-only and
 * has zero authority in Phase 5D.
 *
 * PAPER ONLY.
 */

import { digestOf } from "../lib/hash.mjs";
import { JEV_STATUS, NO_JEV_DECISION } from "./config.mjs";
import { auditJevDecisionPacket, jevStateDigestOf } from "./decision-packet.mjs";
import {
  createJevRunRecord,
  isJevFailure,
  jevCacheKey,
  normalizeAnswers,
  readJevCache,
  safeDiagnostic,
  validateAnswers,
  writeJevCache,
  writeJevProviderRun,
} from "./runtime.mjs";

export const JEV_DECIDE_VERSION = 1;

/** Deterministic run id: one call site, safe as a file name. */
export function jevRunIdFor({ experimentId = null, stateDigest, questionSetId, salt = "" }) {
  const digest = digestOf({ experimentId, stateDigest, questionSetId, salt }).slice(0, 16);
  return `JR-${digest}`;
}

/**
 * Ask Jev the fixed question set about one decision packet.
 *
 * @param {{
 *   provider: object,               // resolved via resolveJevProvider()
 *   packet: object,                 // built via decision-packet.mjs
 *   questions: object,              // built via questions.mjs
 *   questionSetId: string,
 *   questionSetVersion: number,
 *   decisionPacketVersion: number,
 *   experimentId?: string|null,
 *   root?: string|null,             // experiment root; null = no persistence (probe)
 *   cacheEnabled?: boolean,
 *   budget?: { exhausted: () => boolean, consume: () => boolean, max: number, used: number } | null,
 *   now?: () => number,
 *   context?: object,
 *   salt?: string,                  // disambiguates repeated logical requests in tests
 * }} options
 * @returns {Promise<{ run: object, decision: object|typeof NO_JEV_DECISION }>}
 */
export async function jevDecide({
  provider,
  packet,
  questions,
  questionSetId,
  questionSetVersion,
  decisionPacketVersion,
  experimentId = null,
  root = null,
  cacheEnabled = false,
  budget = null,
  now = () => Date.now(),
  context = {},
  salt = "",
}) {
  // The packet is built exclusively by whitelisted constructors, but the
  // boundary is audited unconditionally — a future edit that widens the
  // whitelist is caught here, not discovered later against a real dataset.
  const audit = auditJevDecisionPacket(packet);
  if (!audit.ok) {
    throw new Error(
      `refusing to send a Jev decision packet that failed the leakage audit: ${JSON.stringify(audit.violations)}`,
    );
  }

  const stateDigest = jevStateDigestOf(packet);
  const questionDigest = digestOf(questions);
  const questionNames = Object.keys(questions ?? {});
  const jevRunId = jevRunIdFor({ experimentId, stateDigest, questionSetId, salt });
  const startedAt = new Date(now()).toISOString();

  const cacheKey = jevCacheKey({
    provider: provider?.name ?? null,
    model: provider?.model ?? null,
    decisionPacketVersion,
    questionSetId,
    questionSetVersion,
    stateDigest,
    questionDigest,
  });

  // ---- cache -----------------------------------------------------------
  if (cacheEnabled && root) {
    const cached = await readJevCache(root, cacheKey);
    if (cached?.answers) {
      const revalidated = validateAnswers(cached.answers, questionNames);
      if (revalidated.ok) {
        const run = createJevRunRecord({
          jevRunId,
          experimentId,
          provider: provider?.name ?? null,
          model: provider?.model ?? null,
          requestId: cached.requestId ?? null,
          decisionPacketVersion,
          questionSetId,
          questionSetVersion,
          stateDigest,
          questionDigest,
          startedAt,
          completedAt: startedAt,
          latencyMs: 0,
          status: JEV_STATUS.OK,
          reason: `cache hit: reused a persisted decision for the same logical state (${cacheKey.slice(0, 12)})`,
          cacheHit: true,
          usage: null,
          answers: cached.answers,
          rawResponseDigest: cached.rawResponseDigest ?? null,
        });
        run.cacheKey = cacheKey;
        run.originalJevRunId = cached.jevRunId ?? null;
        run.syntheticDecision = cached.syntheticDecision === true;
        if (root) await writeJevProviderRun(root, run);
        return { run, decision: cached.answers };
      }
      // A cached payload that no longer validates is never repaired or reused.
    }
  }

  // ---- disabled ----------------------------------------------------------
  if (provider?.disabled === true && provider?.name === null) {
    const run = createJevRunRecord({
      jevRunId,
      experimentId,
      provider: null,
      model: null,
      decisionPacketVersion,
      questionSetId,
      questionSetVersion,
      stateDigest,
      questionDigest,
      startedAt,
      completedAt: startedAt,
      latencyMs: 0,
      status: JEV_STATUS.DISABLED,
      reason: "Jev is disabled (EVOLVE_JEV_PROVIDER is not set)",
    });
    run.cacheKey = cacheKey;
    if (root) await writeJevProviderRun(root, run);
    return { run, decision: NO_JEV_DECISION };
  }

  // ---- budget --------------------------------------------------------------
  if (budget && budget.exhausted()) {
    const run = createJevRunRecord({
      jevRunId,
      experimentId,
      provider: provider?.name ?? null,
      model: provider?.model ?? null,
      decisionPacketVersion,
      questionSetId,
      questionSetVersion,
      stateDigest,
      questionDigest,
      startedAt,
      completedAt: startedAt,
      latencyMs: 0,
      status: JEV_STATUS.BUDGET_EXCEEDED,
      reason: `Jev call budget of ${budget.max} reached; no further calls were made`,
    });
    run.cacheKey = cacheKey;
    if (root) await writeJevProviderRun(root, run);
    return { run, decision: NO_JEV_DECISION };
  }

  // ---- live call -------------------------------------------------------
  // Consumed BEFORE the call: a call that times out or errors still used up
  // the attempt ("failures consume attempted-call budget").
  budget?.consume();

  const startMs = now();
  let outcome;
  try {
    outcome = await provider.evaluate({ state: packet, questions, context });
  } catch (error) {
    outcome = { ok: false, status: JEV_STATUS.UNAVAILABLE, reason: `provider threw: ${error?.message ?? error}` };
  }
  const completedMs = now();
  const latencyMs = Math.max(0, completedMs - startMs);
  const completedAt = new Date(completedMs).toISOString();

  let status;
  let reason = null;
  let answers = null;
  let rawResponseDigest = null;

  if (!outcome?.ok) {
    status = outcome?.status ?? JEV_STATUS.UNAVAILABLE;
    reason = outcome?.reason ? safeDiagnostic(outcome.reason) : null;
  } else {
    const normalized = normalizeAnswers(outcome.answers);
    const validated = validateAnswers(normalized, questionNames);
    rawResponseDigest = digestOf(outcome.answers ?? null);
    if (!validated.ok) {
      status = JEV_STATUS.INVALID_RESPONSE;
      reason = validated.reason;
    } else {
      status = JEV_STATUS.OK;
      answers = normalized;
    }
  }

  const run = createJevRunRecord({
    jevRunId,
    experimentId,
    provider: provider?.name ?? null,
    model: outcome?.model ?? provider?.model ?? null,
    requestId: outcome?.requestId ?? null,
    decisionPacketVersion,
    questionSetId,
    questionSetVersion,
    stateDigest,
    questionDigest,
    startedAt,
    completedAt,
    latencyMs,
    status,
    reason,
    cacheHit: false,
    usage: outcome?.usage ?? null,
    answers,
    rawResponseDigest,
  });
  run.cacheKey = cacheKey;
  run.syntheticDecision = outcome?.syntheticDecision === true;

  if (root) {
    await writeJevProviderRun(root, run);
    if (status === JEV_STATUS.OK && cacheEnabled) {
      await writeJevCache(root, cacheKey, {
        schemaVersion: JEV_DECIDE_VERSION,
        cacheKey,
        jevRunId,
        provider: run.provider,
        model: run.model,
        requestId: run.requestId,
        answers,
        rawResponseDigest,
        syntheticDecision: run.syntheticDecision,
      });
    }
  }

  return { run, decision: isJevFailure(status) ? NO_JEV_DECISION : answers };
}
