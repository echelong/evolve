/**
 * `vercel-jev` — the same Jev decision supervisor, reached through the **Vercel
 * AI Gateway** with the AI SDK 7 `experimental_evaluate` evaluation API.
 *
 * This is a THIRD, EXPLICIT route. It is not a replacement for, and never a
 * fallback to or from, `typesafe-jev`:
 *
 *   mock-jev      offline, deterministic, synthetic decisions only
 *   typesafe-jev  DIRECT TypeSafe AI  — POST https://api.typesafe.ai/v1/systemone
 *                 credential: EVOLVE_JEV_API_KEY
 *   vercel-jev    VERCEL AI GATEWAY   — the AI SDK's evaluation-model transport
 *                 credential: AI_GATEWAY_API_KEY
 *                 canonical model: `typesafe-ai/jev`
 *
 * The two real routes are SEPARATE PROVIDERS WITH SEPARATE CREDENTIALS. A
 * Vercel AI Gateway key is a Vercel credential: sending it to `api.typesafe.ai`
 * would be wrong, and a direct TypeSafe key sent to the AI Gateway would be
 * wrong. Neither credential is copied into the other's variable, and neither is
 * ever persisted, logged, or printed.
 *
 * The gateway answers the SAME fixed `jev-question-set-v1` / `jev-market-v1`
 * questions (`scripts/jev/questions.mjs`) — no second decision schema is
 * invented here. This module is a pure PROTOCOL ADAPTER that:
 *
 *   1. converts EVOLVE's existing question objects into the AI SDK evaluation
 *      question shape (`noul` -> `boolean`; `choice`/`score` are structurally
 *      identical), and
 *   2. converts the AI SDK's typed answers back into the SAME raw SDK wire
 *      shape `typesafe-jev` returns (`{ type: "noul", noul }` /
 *      `{ type: "choice", choice, confidence, probabilities }` /
 *      `{ type: "score", score, confidence, legend, probabilities }`).
 *
 * Step 2 is what keeps the rest of EVOLVE provider-neutral:
 * `scripts/jev/runtime.mjs#normalizeAnswers` then normalizes BOTH routes with
 * the SAME function, and the decision packet, experiment layer, calibration
 * and dashboard never see a Vercel-specific object.
 *
 * SHADOW ONLY. PAPER ONLY. This provider is an HTTPS decision-API client: it
 * never spawns a process, never reads a file, never touches a wallet/seed/RPC,
 * and never executes anything the model returns.
 *
 * There is NO fallback of any kind: every failure becomes an explicit `JEV_*`
 * status the caller records and continues past.
 */

import { experimental_evaluate as experimentalEvaluate } from "ai";

import {
  DEFAULT_VERCEL_JEV_MODEL,
  DEFAULT_VERCEL_JEV_UPSTREAM_PROVIDER,
  JEV_STATUS,
} from "../config.mjs";
import { retryAfterMsOf } from "../transport.mjs";
import { redactSecrets } from "../../lib/sanitize.mjs";

export const VERCEL_JEV_PROVIDER = "vercel-jev";
export const VERCEL_JEV_TRANSPORT = "vercel-ai-gateway";
export const VERCEL_JEV_UPSTREAM_PROVIDER = DEFAULT_VERCEL_JEV_UPSTREAM_PROVIDER;
export const VERCEL_JEV_DEFAULT_MODEL = DEFAULT_VERCEL_JEV_MODEL;

/**
 * Exactly one provider attempt per EVOLVE call: no SDK-level retry storm.
 *
 * UNCHANGED in Phase 5F.1. EVOLVE's own transport layer now owns retries and it
 * must never run at the same time as an SDK-level retry — otherwise attempt
 * accounting becomes opaque and `providerAttemptCount` stops being true.
 */
export const VERCEL_JEV_MAX_RETRIES = 0;

/* ============================================================================
 * Question mapping: EVOLVE's existing question set -> AI SDK evaluation shape
 * ==========================================================================*/

/**
 * Convert the EXISTING EVOLVE question objects into the AI SDK evaluation
 * question shape. This is a mechanical re-labelling, not a new schema: the same
 * question names, the same `instructions`, and the same `criteria` are sent.
 *
 * The only structural difference between the two protocols is the yes/no
 * question type name (`noul` in the TypeSafe SDK, `boolean` in the AI SDK).
 */
export function toEvaluationQuestions(questions = {}) {
  const out = {};
  for (const [name, question] of Object.entries(questions ?? {})) {
    if (!question || typeof question !== "object") continue;
    // The AI SDK requires `instructions` to be a JSON-compatible string,
    // object, or array; the TypeSafe SDK allows it to be omitted. Default to an
    // empty string rather than sending `null`, which the AI SDK rejects.
    const instructions = question.instructions === undefined || question.instructions === null ? "" : question.instructions;
    if (question.type === "noul") {
      out[name] = {
        type: "boolean",
        instructions,
        ...(question.criteria ? { criteria: { ...question.criteria } } : {}),
      };
    } else if (question.type === "choice") {
      out[name] = { type: "choice", instructions, criteria: { ...(question.criteria ?? {}) } };
    } else if (question.type === "score") {
      out[name] = { type: "score", instructions, criteria: [...(question.criteria ?? [])] };
    }
  }
  return out;
}

/** Rubric legend (`{ "0": description, ... }`) for a score question, mirroring the TypeSafe wire legend. */
export function legendForQuestion(question) {
  if (
    question?.type === "score" &&
    Array.isArray(question.criteria) &&
    question.criteria.length > 0 &&
    question.criteria.every((entry) => typeof entry === "string")
  ) {
    const legend = {};
    question.criteria.forEach((entry, index) => {
      legend[String(index)] = entry;
    });
    return legend;
  }
  return {};
}

/** Highest finite probability in a distribution, or `null` when none is reported. */
function confidenceOf(probabilities) {
  const values = Object.values(probabilities ?? {}).filter((value) => Number.isFinite(value));
  if (values.length === 0) return null;
  return Math.max(...values);
}

/**
 * Convert the AI SDK's typed answers back into the SAME raw wire shape the
 * direct TypeSafe SDK returns, so `runtime.mjs#normalizeAnswers` (and therefore
 * the decision packet, experiment layer, calibration, and dashboard) treats
 * both routes identically.
 */
export function fromEvaluationAnswers(answers = {}, questions = {}) {
  const out = {};
  for (const [name, answer] of Object.entries(answers ?? {})) {
    if (!answer || typeof answer !== "object") continue;
    if (answer.type === "boolean") {
      out[name] = { type: "noul", noul: Number.isFinite(answer.probability) ? answer.probability : answer.probability };
    } else if (answer.type === "choice") {
      const probabilities =
        answer.probabilities && typeof answer.probabilities === "object" ? { ...answer.probabilities } : {};
      out[name] = {
        type: "choice",
        choice: typeof answer.choice === "string" ? answer.choice : answer.choice,
        confidence: Number.isFinite(probabilities[answer.choice]) ? probabilities[answer.choice] : null,
        probabilities,
      };
    } else if (answer.type === "score") {
      const probabilities =
        answer.probabilities && typeof answer.probabilities === "object" ? { ...answer.probabilities } : {};
      out[name] = {
        type: "score",
        score: answer.score,
        confidence: confidenceOf(probabilities),
        legend: legendForQuestion(questions?.[name]),
        probabilities,
      };
    }
  }
  return out;
}

/* ============================================================================
 * Bounded provider metadata (observational only, never authoritative)
 * ==========================================================================*/

/** Cost-like keys the gateway may report. Values are recorded as plain numbers, never interpreted. */
const GATEWAY_COST_KEYS = Object.freeze(["totalCost", "total_cost", "gatewayCost", "gateway_cost", "cost"]);
const MARKET_COST_KEYS = Object.freeze(["marketCost", "market_cost"]);
const GENERATION_ID_KEYS = Object.freeze(["generationId", "generation_id"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Depth-bounded scan for the first finite number under one of the allowlisted keys. */
function findAllowlistedNumber(source, keys, depth = 0) {
  if (depth > 3 || !source || typeof source !== "object") return null;
  if (Array.isArray(source)) {
    for (const entry of source) {
      const found = findAllowlistedNumber(entry, keys, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  for (const [key, value] of Object.entries(source)) {
    if (keys.includes(key) && Number.isFinite(value)) return value;
    const found = findAllowlistedNumber(value, keys, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

/** Depth-bounded scan for the first string under one of the allowlisted keys. */
function findAllowlistedString(source, keys, depth = 0) {
  if (depth > 3 || !source || typeof source !== "object") return null;
  if (Array.isArray(source)) {
    for (const entry of source) {
      const found = findAllowlistedString(entry, keys, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  for (const [key, value] of Object.entries(source)) {
    if (keys.includes(key) && typeof value === "string" && value.length > 0) return value;
    const found = findAllowlistedString(value, keys, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

/** Sorted top-level key NAMES from provider metadata. Names only — never values. */
function metadataKeyNames(providerMetadata) {
  if (!isPlainObject(providerMetadata)) return [];
  return Object.keys(providerMetadata).sort();
}

/**
 * Build the bounded, non-secret metadata block for ONE vercel-jev call.
 *
 * Explicitly excluded: authorization headers, the API key, environment dumps,
 * cookies, and any raw credential-bearing request/response object. Raw
 * `providerMetadata` is NOT persisted — only allowlisted scalars and key NAMES
 * survive this function.
 *
 * Every monetary value here is OBSERVATIONAL. Nothing in EVOLVE bills, charges,
 * or infers profitability from it.
 */
export function buildVercelProviderMetadata({
  model = VERCEL_JEV_DEFAULT_MODEL,
  upstreamProvider = VERCEL_JEV_UPSTREAM_PROVIDER,
  latencyMs = null,
  providerAttemptCount = 1,
  providerStatus = JEV_STATUS.OK,
  httpStatus = null,
  generationId = null,
  gatewayCost = null,
  marketCost = null,
  tokenUsage = null,
  providerMetadata = null,
} = {}) {
  return {
    provider: VERCEL_JEV_PROVIDER,
    upstreamProvider,
    model,
    transport: VERCEL_JEV_TRANSPORT,
    gatewayUsed: true,
    gatewayMode: "shadow",
    providerAttemptCount,
    providerStatus,
    httpStatus: Number.isFinite(httpStatus) ? httpStatus : null,
    latencyMs: Number.isFinite(latencyMs) ? Math.max(0, Math.round(latencyMs)) : null,
    generationId: typeof generationId === "string" && generationId.length > 0 ? generationId : null,
    gatewayCost: Number.isFinite(gatewayCost) ? gatewayCost : null,
    marketCost: Number.isFinite(marketCost) ? marketCost : null,
    tokenUsage: tokenUsage
      ? {
          inputTokens: Number.isFinite(tokenUsage.inputTokens) ? tokenUsage.inputTokens : null,
          outputTokens: Number.isFinite(tokenUsage.outputTokens) ? tokenUsage.outputTokens : null,
          totalTokens: Number.isFinite(tokenUsage.totalTokens) ? tokenUsage.totalTokens : null,
        }
      : null,
    upstreamMetadataKeys: metadataKeyNames(providerMetadata),
    costNote: "Observational only. No billing, pricing, or profitability inference is made from this value.",
    formatVersion: 1,
  };
}

/** Normalize AI SDK usage (`{ inputTokens, outputTokens, totalTokens }`). */
export function usageFromResult(result) {
  const usage = result?.usage ?? null;
  if (!usage) return null;
  return {
    input_tokens: Number.isFinite(usage.inputTokens) ? usage.inputTokens : null,
    output_tokens: Number.isFinite(usage.outputTokens) ? usage.outputTokens : null,
    total_tokens: Number.isFinite(usage.totalTokens) ? usage.totalTokens : null,
  };
}

/* ============================================================================
 * Error classification — gateway/Vercel failures -> EVOLVE's Jev vocabulary
 * ==========================================================================*/

/** Numeric status from the many shapes an AI SDK / Gateway error may expose. */
function statusOf(error) {
  const candidates = [error?.statusCode, error?.status, error?.response?.status, error?.cause?.statusCode];
  for (const candidate of candidates) if (Number.isFinite(candidate)) return candidate;
  return null;
}

const CONNECTION_PATTERN = /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up|network/i;

/**
 * Map a gateway/AI-SDK error (or a pre-call configuration problem) to one of
 * EVOLVE's explicit Jev statuses. Never re-throws.
 *
 * The distinctions the task requires are explicit here:
 *   - 401/403            -> JEV_AUTH_ERROR   (authentication / credential)
 *   - 429                -> JEV_RATE_LIMIT
 *   - upstream 5xx / 503 -> JEV_UNAVAILABLE  (NEVER authentication)
 *   - 400/404/422        -> JEV_CONFIG_ERROR (bad request / unknown model)
 *   - other 4xx          -> JEV_HTTP_ERROR
 *   - malformed typed    -> JEV_INVALID_RESPONSE
 *   - aborted/timed out  -> JEV_TIMEOUT
 *   - anything unexpected-> JEV_INTERNAL_ERROR
 */
export function classifyVercelError(error, { timedOut = false, timeoutMs = null, apiKey = "" } = {}) {
  const redact = (text) => redactSecrets(String(text ?? ""), [apiKey]);
  const name = typeof error?.name === "string" ? error.name : "";
  const type = typeof error?.type === "string" ? error.type : "";
  const message = String(error?.message ?? error ?? "unknown error");

  if (timedOut) {
    return {
      status: JEV_STATUS.TIMEOUT,
      reason: redact(`Vercel AI Gateway Jev call timed out after ${timeoutMs ?? "the configured"}ms`),
      httpStatus: null,
    };
  }

  // A retry wrapper can hide the real cause; unwrap it.
  if (name.includes("RetryError") && error?.lastError) {
    return classifyVercelError(error.lastError, { timedOut, timeoutMs, apiKey });
  }

  const httpStatus = statusOf(error);

  // Gateway-reported error types take precedence where they are more specific
  // than the status code (a failed response-body validation is a malformed
  // provider output, not an outage).
  if (type === "response_error") {
    return {
      status: JEV_STATUS.INVALID_RESPONSE,
      reason: redact(`Vercel AI Gateway returned an invalid evaluation response: ${message}`),
      httpStatus,
    };
  }

  if (httpStatus === 401 || httpStatus === 403 || type === "authentication_error" || type === "forbidden") {
    return {
      status: JEV_STATUS.AUTH_ERROR,
      reason: redact(`Vercel AI Gateway authentication failed (HTTP ${httpStatus ?? "n/a"}); check AI_GATEWAY_API_KEY`),
      httpStatus,
    };
  }

  if (httpStatus === 429 || type === "rate_limit_exceeded") {
    return {
      status: JEV_STATUS.RATE_LIMIT,
      reason: redact(`Vercel AI Gateway rate limit exceeded (HTTP ${httpStatus ?? 429})`),
      httpStatus,
    };
  }

  if (name.includes("InvalidResponseData") || name.includes("TypeValidation")) {
    return {
      status: JEV_STATUS.INVALID_RESPONSE,
      reason: redact(`Vercel AI Gateway returned malformed typed answers: ${message}`),
      httpStatus,
    };
  }

  if (name.includes("InvalidArgument")) {
    return {
      status: JEV_STATUS.CONFIG_ERROR,
      reason: redact(`Vercel AI Gateway request was rejected as invalid: ${message}`),
      httpStatus,
    };
  }

  if (name.includes("LoadAPIKey") || name.includes("MissingAPIKey") || /api key|no authentication provided/i.test(message)) {
    return {
      status: JEV_STATUS.AUTH_ERROR,
      reason: redact(`Vercel AI Gateway credential was missing or rejected: ${message}`),
      httpStatus,
    };
  }

  if (httpStatus === 400 || httpStatus === 404 || httpStatus === 422 || type === "invalid_request_error" || type === "model_not_found") {
    return {
      status: JEV_STATUS.CONFIG_ERROR,
      reason: redact(`Vercel AI Gateway configuration/request error (HTTP ${httpStatus ?? "n/a"}): ${message}`),
      httpStatus,
    };
  }

  // Upstream / gateway 5xx is an AVAILABILITY problem — explicitly NOT an auth failure.
  if (httpStatus !== null && httpStatus >= 500) {
    return {
      status: JEV_STATUS.UNAVAILABLE,
      reason: redact(`Vercel AI Gateway is unavailable (HTTP ${httpStatus}): ${message}`),
      httpStatus,
    };
  }

  if (httpStatus !== null && httpStatus >= 400) {
    return {
      status: JEV_STATUS.HTTP_ERROR,
      reason: redact(`Vercel AI Gateway HTTP error ${httpStatus}: ${message}`),
      httpStatus,
    };
  }

  if (name.includes("Abort")) {
    return {
      status: JEV_STATUS.TIMEOUT,
      reason: redact("Vercel AI Gateway Jev call was aborted before it completed"),
      httpStatus,
    };
  }

  if (name.includes("UnsupportedModelVersion") || name.includes("NoSuchModel")) {
    return {
      status: JEV_STATUS.CONFIG_ERROR,
      reason: redact(`Vercel AI Gateway model configuration error: ${message}`),
      httpStatus,
    };
  }

  if (error instanceof TypeError || name.includes("APIConnection") || CONNECTION_PATTERN.test(message)) {
    return {
      status: JEV_STATUS.UNAVAILABLE,
      reason: redact(`Vercel AI Gateway connection failed: ${message}`),
      httpStatus,
    };
  }

  return {
    status: JEV_STATUS.INTERNAL_ERROR,
    reason: redact(`Vercel AI Gateway Jev call failed unexpectedly: ${message}`),
    httpStatus,
  };
}

/* ============================================================================
 * Provider factory
 * ==========================================================================*/

/**
 * Create the `vercel-jev` provider. Conforms to the narrow contract every Jev
 * provider implements: `evaluate({ state, questions, context })`.
 *
 * @param {{
 *   gatewayApiKey: string,          // AI_GATEWAY_API_KEY — used ONLY for redaction + presence checks
 *   model?: string,                 // default: typesafe-ai/jev
 *   upstreamProvider?: string,
 *   timeoutMs?: number,
 *   evaluateImpl?: Function,        // TEST ONLY: injected stand-in for experimental_evaluate
 * }} options
 */
export function createVercelJevProvider({
  gatewayApiKey = "",
  model = VERCEL_JEV_DEFAULT_MODEL,
  upstreamProvider = VERCEL_JEV_UPSTREAM_PROVIDER,
  timeoutMs = 20_000,
  evaluateImpl = null,
} = {}) {
  const evaluate = typeof evaluateImpl === "function" ? evaluateImpl : experimentalEvaluate;

  return {
    name: VERCEL_JEV_PROVIDER,
    model,
    upstreamProvider,
    gatewayUsed: true,
    transport: VERCEL_JEV_TRANSPORT,
    offline: false,
    external: true,
    syntheticDecision: false,
    async evaluate({ state, questions, context = {} } = {}) {
      void context;
      // Defense in depth: `resolveJevProvider` already refuses to build this
      // provider without a gateway credential. Re-checking here guarantees the
      // external request is never attempted with an empty key.
      if (!gatewayApiKey || String(gatewayApiKey).trim().length === 0) {
        return {
          ok: false,
          status: JEV_STATUS.CONFIG_ERROR,
          reason:
            "the Vercel AI Gateway credential (AI_GATEWAY_API_KEY) is not set; vercel-jev was requested but no gateway credential is configured",
        };
      }

      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, Math.max(1, Math.round(Number(timeoutMs) || 20_000)));

      const startedMs = Date.now();
      try {
        const result = await evaluate({
          model,
          state,
          questions: toEvaluationQuestions(questions),
          // The observed probe performed exactly ONE provider attempt. EVOLVE
          // keeps that guarantee explicit instead of inheriting the SDK default
          // of two retries.
          maxRetries: VERCEL_JEV_MAX_RETRIES,
          abortSignal: controller.signal,
        });
        const latencyMs = Date.now() - startedMs;
        const providerMetadata = result?.providerMetadata ?? null;
        const response = result?.response ?? null;
        const generationId =
          findAllowlistedString(providerMetadata, GENERATION_ID_KEYS) ??
          (typeof response?.id === "string" ? response.id : null);

        return {
          ok: true,
          model,
          requestId: generationId,
          answers: fromEvaluationAnswers(result?.answers, questions),
          usage: usageFromResult(result),
          syntheticDecision: false,
          providerMetadata: buildVercelProviderMetadata({
            model,
            upstreamProvider,
            latencyMs,
            providerAttemptCount: 1,
            providerStatus: JEV_STATUS.OK,
            generationId,
            gatewayCost: findAllowlistedNumber(providerMetadata, GATEWAY_COST_KEYS),
            marketCost: findAllowlistedNumber(providerMetadata, MARKET_COST_KEYS),
            tokenUsage: {
              inputTokens: result?.usage?.inputTokens,
              outputTokens: result?.usage?.outputTokens,
              totalTokens: result?.usage?.totalTokens,
            },
            providerMetadata,
          }),
        };
      } catch (error) {
        const classified = classifyVercelError(error, { timedOut, timeoutMs, apiKey: gatewayApiKey });
        return {
          ok: false,
          status: classified.status,
          reason: classified.reason,
          // The bounded HTTP status and a single bounded `retryAfterMs` number
          // (never raw headers) are what EVOLVE's own transport layer uses to
          // decide whether a retry is warranted. The status vocabulary and the
          // `maxRetries: 0` request above are unchanged.
          httpStatus: classified.httpStatus,
          retryAfterMs: retryAfterMsOf(error),
          providerMetadata: buildVercelProviderMetadata({
            model,
            upstreamProvider,
            latencyMs: Date.now() - startedMs,
            providerAttemptCount: 1,
            providerStatus: classified.status,
            httpStatus: classified.httpStatus,
          }),
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
