/**
 * Phase 5I.0b — deterministic OFFLINE fixture provider (development/validation only).
 *
 * Answers ONLY the Phase 5I direction question set. Any other question set is
 * REFUSED (`JEV_INVALID_RESPONSE`), so this provider can never act as a silent
 * substitute for another phase's provider, and it can never be mistaken for
 * direct TypeSafe evidence (every run is marked `syntheticDecision: true` and
 * `offline: true`, and the caller records the exact implementation name).
 *
 * The probability is a pure function of the packet digest: same packet -> same
 * probability, no RNG, no wall clock, no network, no filesystem.
 *
 * PAPER ONLY / DEVELOPMENT EVIDENCE ONLY.
 */

import { digestOf } from "../../lib/hash.mjs";
import { JEV_STATUS } from "../config.mjs";
import { DIRECTION_QUESTION_NAME, DIRECTION_QUESTION_NAMES } from "./questions.mjs";
import { OFFLINE_FIXTURE_IMPLEMENTATION, OFFLINE_FIXTURE_PROVIDER } from "./definition.mjs";

export const DIRECTION_FIXTURE_PROVIDER_VERSION = 1;

/** Deterministic bounded probability in [0.25, 0.75] from a packet digest. */
export function fixtureProbabilityFor(packet) {
  const hex = digestOf(packet ?? {}).slice(0, 8);
  const value = Number.parseInt(hex, 16) / 0xffffffff;
  return Number((0.25 + value * 0.5).toFixed(6));
}

/**
 * @param {{
 *   probabilityFor?: ((packet: object) => number)|null,  // test injection
 *   answers?: Record<string, number>|null,                // per-observationId override
 *   failWith?: string|null,                               // force a status, for failure-path fixtures
 * }} [options]
 */
export function createDirectionFixtureProvider({ probabilityFor = null, answers = null, failWith = null } = {}) {
  return {
    name: OFFLINE_FIXTURE_PROVIDER,
    model: OFFLINE_FIXTURE_IMPLEMENTATION,
    implementation: OFFLINE_FIXTURE_IMPLEMENTATION,
    offline: true,
    external: false,
    syntheticDecision: true,
    async evaluate({ state, questions } = {}) {
      const names = Object.keys(questions ?? {});
      if (names.length !== DIRECTION_QUESTION_NAMES.length || !names.every((name) => DIRECTION_QUESTION_NAMES.includes(name))) {
        return {
          ok: false,
          status: JEV_STATUS.INVALID_RESPONSE,
          reason: `direction fixture provider answers only ${DIRECTION_QUESTION_NAMES.join(", ")}; got ${names.join(", ") || "(none)"}`,
        };
      }
      if (typeof failWith === "string" && failWith.length > 0) {
        return { ok: false, status: failWith, reason: `fixture-forced failure (${failWith})` };
      }

      const observationId = state?.observationId ?? null;
      const injected =
        answers && observationId && Number.isFinite(answers[observationId])
          ? answers[observationId]
          : null;
      const probability =
        injected !== null
          ? injected
          : typeof probabilityFor === "function"
            ? probabilityFor(state)
            : fixtureProbabilityFor(state);

      if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
        return {
          ok: false,
          status: JEV_STATUS.INVALID_RESPONSE,
          reason: `fixture probability ${String(probability)} is not in [0,1]`,
        };
      }

      return {
        ok: true,
        model: OFFLINE_FIXTURE_IMPLEMENTATION,
        requestId: `fixture-${digestOf({ state }).slice(0, 16)}`,
        answers: { [DIRECTION_QUESTION_NAME]: { type: "noul", noul: probability } },
        usage: { input_tokens: 0, output_tokens: 0 },
        syntheticDecision: true,
      };
    },
  };
}
