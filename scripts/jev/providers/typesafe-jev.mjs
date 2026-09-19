/**
 * `typesafe-jev` — the real Jev provider, through the official TypeSafe AI
 * JavaScript SDK (Phase 5D).
 *
 * Verified against `@typesafe-ai/sdk@0.6.0` (installed dependency) and the
 * published docs at docs.typesafe.ai:
 *
 *   - endpoint:  POST https://api.typesafe.ai/v1/systemone
 *   - auth:      `Authorization: Bearer <API_KEY>`
 *   - call:      `client.systemOne({ state, questions, model })`
 *   - response:  `{ model, answers: { [name]: NoulResponse|ChoiceResponse|ScoreResponse }, usage }`
 *   - pinned model: `jev-1.13.0` (the `jev-latest`/`jev-preview` aliases move
 *     when a new release ships, so canonical Phase 5D evidence never uses them
 *     — see `scripts/jev/config.mjs#DEFAULT_JEV_MODEL`)
 *
 * This provider is ONLY an HTTPS decision-API client: it never spawns a
 * process, never reads a file, never touches a wallet/key/RPC, and never
 * executes anything Jev returns. The SDK's own `fetch` override
 * (`TypeSafeClientConfig.fetch`) is used to make this provider fully testable
 * offline — no live network call is ever required to exercise this code path.
 *
 * There is NO fallback to `mock-jev`: any failure here becomes an explicit
 * `JEV_*` status; the caller never silently answers instead.
 *
 * PAPER ONLY.
 */

import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  TypeSafeClient,
  TypeSafeError,
} from "@typesafe-ai/sdk";

import { JEV_STATUS } from "../config.mjs";
import { retryAfterMsOf } from "../transport.mjs";

export const TYPESAFE_JEV_PROVIDER = "typesafe-jev";

/**
 * The bounded transport label recorded on every attempt record for this route.
 * It matches `JEV_PROVIDER_TRANSPORT[JEV_PROVIDER.TYPESAFE]` in `config.mjs`, and
 * it is what lets a later calibration tell a DIRECT TypeSafe decision apart from
 * one that arrived through the Vercel AI Gateway for the same underlying model.
 */
export const TYPESAFE_JEV_TRANSPORT = "typesafe-sdk";

/**
 * Map an SDK-thrown error (or a constructor-time configuration error) to one
 * of EVOLVE's explicit Jev statuses. Never re-throws: every failure mode must
 * become a status the caller can record and continue past.
 *
 * The status VOCABULARY is unchanged from Phase 5D (pinned by
 * `validate:phase5d`: 401/403 stay `JEV_CONFIG_ERROR`, 429/5xx stay
 * `JEV_HTTP_ERROR`). Phase 5F.1 additionally reports the bounded numeric
 * `httpStatus` and a single bounded `retryAfterMs` so EVOLVE's OWN transport
 * layer can tell a transient outage (retryable) from a typo (not retryable)
 * without reinterpreting the status label.
 */
function classifyError(error) {
  if (error instanceof APITimeoutError) {
    return { status: JEV_STATUS.TIMEOUT, reason: `Jev call timed out after ${error.timeoutMs}ms`, httpStatus: null };
  }
  if (error instanceof APIUserAbortError) {
    return { status: JEV_STATUS.UNAVAILABLE, reason: "Jev call was aborted", httpStatus: null };
  }
  if (error instanceof APIConnectionError) {
    return { status: JEV_STATUS.UNAVAILABLE, reason: `Jev connection failed: ${error.message}`, httpStatus: null };
  }
  if (error instanceof APIError) {
    const httpStatus = Number.isFinite(error.status) ? error.status : null;
    if (error.status === 401 || error.status === 403) {
      return { status: JEV_STATUS.CONFIG_ERROR, reason: `Jev authentication failed (HTTP ${error.status})`, httpStatus };
    }
    return { status: JEV_STATUS.HTTP_ERROR, reason: `Jev HTTP error ${error.status}: ${error.message}`, httpStatus };
  }
  if (error instanceof TypeSafeError) {
    // Thrown for missing API key / invalid client configuration / empty questions
    // BEFORE any network call is attempted — a configuration error, not a
    // runtime provider failure.
    return { status: JEV_STATUS.CONFIG_ERROR, reason: `Jev configuration error: ${error.message}`, httpStatus: null };
  }
  return { status: JEV_STATUS.UNAVAILABLE, reason: `Jev call failed: ${error?.message ?? error}`, httpStatus: null };
}

/**
 * Create the real Jev provider. Conforms to the narrow contract:
 * `evaluate({ state, questions, context })`.
 *
 * @param {{
 *   apiKey: string,
 *   model?: string,
 *   baseURL?: string,
 *   timeoutMs?: number,
 *   fetchImpl?: Function|null,   // test-only: injected into the SDK client
 *   logLevel?: string,
 * }} options
 */
export function createTypeSafeJevProvider({
  apiKey,
  model,
  baseURL,
  timeoutMs = 20_000,
  fetchImpl = null,
  logLevel = "off",
} = {}) {
  // The client is constructed lazily, on the first `evaluate()` call, so a
  // missing/invalid key becomes a normal `JEV_CONFIG_ERROR` status rather than
  // an exception thrown while merely SELECTING the provider.
  let client = null;
  let constructError = null;

  function ensureClient() {
    if (client || constructError) return;
    try {
      client = new TypeSafeClient({
        apiKey,
        baseURL,
        defaultModel: model,
        timeout: timeoutMs,
        logLevel,
        dangerouslyAllowBrowser: false,
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
      });
    } catch (error) {
      constructError = error;
    }
  }

  return {
    name: TYPESAFE_JEV_PROVIDER,
    model,
    transport: TYPESAFE_JEV_TRANSPORT,
    offline: false,
    external: true,
    syntheticDecision: false,
    async evaluate({ state, questions, context = {} } = {}) {
      ensureClient();
      if (constructError) {
        const classified = classifyError(constructError);
        return { ok: false, ...classified };
      }
      try {
        const { data, requestId } = await client
          .systemOne({ state, questions, model }, { timeout: timeoutMs })
          .withResponse();
        void context;
        return {
          ok: true,
          model: data.model,
          requestId: requestId ?? null,
          answers: data.answers,
          usage: data.usage,
        };
      } catch (error) {
        const classified = classifyError(error);
        // Bounded, non-secret transport hints only: the HTTP status number and
        // one clamped `retryAfterMs` (never raw headers).
        return { ok: false, ...classified, retryAfterMs: retryAfterMsOf(error) };
      }
    },
  };
}
