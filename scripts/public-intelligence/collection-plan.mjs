// Phase 5K.3 - COLLECTION PLAN: a closed-schema, bounded, fingerprinted request
// for ONE collection run.
//
// PURE AND OFFLINE BY CONSTRUCTION. No network, no filesystem, no clock, no
// environment. A plan names WHAT to collect and HOW MUCH; it carries no URL, no
// endpoint, no credential and no scientific result.
//
// RESEARCH/OBSERVER-ONLY BY CONSTRUCTION (5K.0): the plan embeds the frozen
// classification verbatim and refuses any other value. No run can override it.
import {
  PUBLIC_INTELLIGENCE_CLASSIFICATION, canonical, digest, isValidTimestamp,
} from './definition.mjs';
import { failClosed } from './observation.mjs';
import {
  PROVIDER_HARD_CEILINGS, assertPublicHost, assertHashtag, ProviderAdapterError,
  PROVIDER_ERROR_CODES, providerFail,
} from './providers/common.mjs';

export const PUBLIC_INTELLIGENCE_5K3_PHASE = 'PHASE_5K_3';
export const PUBLIC_INTELLIGENCE_5K3_SCHEMA_VERSION = '5K.3.0';
export const PUBLIC_INTELLIGENCE_5K3_PLAN_RECORD_TYPE = 'public_collection_plan';

/**
 * The governed provider and query-type registries.
 *
 * 5K.3 shipped with exactly one entry each. Phase 5K.6 extends both ADDITIVELY
 * for the Bluesky / AT Protocol provider. The registry stays a closed allowlist
 * and stays SORTED, so an operator still cannot name an arbitrary provider, an
 * arbitrary query type, an arbitrary XRPC method or an arbitrary endpoint.
 * Mastodon's `HASHTAG` semantics are untouched: `TEXT_SEARCH` is a separate
 * type, and `buildCollectionPlan` still produces `HASHTAG` for Mastodon.
 */
export const PUBLIC_INTELLIGENCE_5K3_PROVIDERS = Object.freeze(['bluesky', 'mastodon']);
export const PUBLIC_INTELLIGENCE_5K3_QUERY_TYPES = Object.freeze(['HASHTAG', 'TEXT_SEARCH']);
/** OFFLINE_FIXTURE requires an injected transport; LIVE_PUBLIC_PROVIDER forbids one. */
export const PUBLIC_INTELLIGENCE_5K3_COLLECTION_MODES = Object.freeze(['OFFLINE_FIXTURE', 'LIVE_PUBLIC_PROVIDER']);

/** Plan bounds map 1:1 onto the 5K.2 hard ceilings. They can only be tightened. */
export const PUBLIC_INTELLIGENCE_5K3_BOUND_CEILINGS = Object.freeze({
  maxPages: PROVIDER_HARD_CEILINGS.maxPages,
  maxRecords: PROVIDER_HARD_CEILINGS.maxRecords,
  timeoutMs: PROVIDER_HARD_CEILINGS.timeoutMs,
  maxResponseBytes: PROVIDER_HARD_CEILINGS.maxResponseBytes,
  maxLookbackMs: PROVIDER_HARD_CEILINGS.lookbackMs,
});

export const PUBLIC_INTELLIGENCE_5K3_PLAN_SCHEMA = Object.freeze({
  closed: true,
  fields: Object.freeze([
    'schemaVersion', 'recordType', 'provider', 'instance', 'query', 'bounds',
    'collectionMode', 'createdAt', 'classification',
  ]),
  queryFields: Object.freeze(['type', 'value']),
  boundFields: Object.freeze(Object.keys(PUBLIC_INTELLIGENCE_5K3_BOUND_CEILINGS)),
});

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The governed TEXT_SEARCH value: a bounded plain keyword.
 *
 * Deliberately narrower than a search engine's syntax. It admits letters and
 * digits only, so it can carry NO `#`, `/`, `:`, `?`, `&`, `=`, whitespace,
 * quote or percent sequence - which means it can never smuggle a URL, a path, an
 * XRPC parameter or a query-syntax operator into the endpoint. Bounds are fixed
 * here and cannot be widened by a plan or an operator.
 */
const PLAIN_SEARCH_TERM = /^[\p{L}\p{N}]{1,64}$/u;

export function assertPlainSearchTerm(value) {
  // Deliberately raised as the SAME typed refusal as `assertHashtag`, so a plan
  // validator reports one code for "the query value is invalid" regardless of
  // which query type was used.
  if (typeof value !== 'string' || !PLAIN_SEARCH_TERM.test(value)) providerFail(PROVIDER_ERROR_CODES.QUERY_INVALID);
  return value;
}

/**
 * Per-provider plan metadata.
 *
 * `instance` is the single documented public host for that provider, so a plan
 * still cannot name an arbitrary endpoint. `queryType` is the one governed
 * query type that provider supports.
 */
export const PUBLIC_INTELLIGENCE_5K3_PROVIDER_DEFAULTS = Object.freeze({
  bluesky: Object.freeze({
    instance: 'public.api.bsky.app', queryType: 'TEXT_SEARCH',
    // Host-free ON PURPOSE. A Mastodon instance IS part of a status's identity -
    // the same status id on two instances is two different pieces of evidence -
    // but a Bluesky AppView is NOT: the same AT URI served by another AppView is
    // the same record. Binding Bluesky identity to a host would make it change
    // when the provider moves infrastructure, so the governed namespace carries
    // no host at all. The DID inside the AT URI is the stable author reference.
    rawProviderNamespace: 'bluesky:public-appview',
  }),
  mastodon: Object.freeze({ instance: null, queryType: 'HASHTAG', rawProviderNamespace: null }),
});

/**
 * The raw-observation `provider` namespace a plan's evidence must carry.
 *
 * Mastodon keeps `${provider}:${instance}` exactly as 5K.2 defined it. A
 * provider that governs a host-free namespace uses that instead. This is a
 * property of the governed provider registry, not a string concatenation, so a
 * plan can never influence its own namespace.
 */
export function rawProviderNamespaceOf(plan) {
  if (!plan || typeof plan !== 'object' || typeof plan.provider !== 'string') {
    failClosed('PUBLIC_INTELLIGENCE_5K3_PROVIDER_NAMESPACE_NO_PLAN');
  }
  const governed = PUBLIC_INTELLIGENCE_5K3_PROVIDER_DEFAULTS[plan.provider]?.rawProviderNamespace;
  return governed ?? `${plan.provider}:${plan.instance}`;
}

function assertClosed(object, fields, code) {
  if (!isPlainObject(object)) failClosed(`${code}_NOT_AN_OBJECT`);
  const allowed = new Set(fields);
  for (const key of Object.keys(object)) if (!allowed.has(key)) failClosed(`${code}_UNKNOWN_FIELD:${key}`);
  for (const key of fields) if (!Object.hasOwn(object, key)) failClosed(`${code}_FIELD_MISSING:${key}`);
}

/**
 * Validates a plan against the closed schema and the hard ceilings. Throws a
 * code; never clamps, defaults or repairs. Returns the deep-frozen plan.
 */
export function validateCollectionPlan(plan) {
  assertClosed(plan, PUBLIC_INTELLIGENCE_5K3_PLAN_SCHEMA.fields, 'PUBLIC_INTELLIGENCE_5K3_PLAN');
  if (plan.schemaVersion !== PUBLIC_INTELLIGENCE_5K3_SCHEMA_VERSION) failClosed('PUBLIC_INTELLIGENCE_5K3_PLAN_SCHEMA_VERSION_INVALID');
  if (plan.recordType !== PUBLIC_INTELLIGENCE_5K3_PLAN_RECORD_TYPE) failClosed('PUBLIC_INTELLIGENCE_5K3_PLAN_RECORD_TYPE_INVALID');
  if (!PUBLIC_INTELLIGENCE_5K3_PROVIDERS.includes(plan.provider)) failClosed(`PUBLIC_INTELLIGENCE_5K3_PLAN_PROVIDER_INVALID:${String(plan.provider).slice(0, 32)}`);
  if (!PUBLIC_INTELLIGENCE_5K3_COLLECTION_MODES.includes(plan.collectionMode)) failClosed('PUBLIC_INTELLIGENCE_5K3_PLAN_COLLECTION_MODE_INVALID');

  // The instance is a public DNS host name, never a URL or endpoint.
  try { if (assertPublicHost(plan.instance) !== plan.instance) failClosed('PUBLIC_INTELLIGENCE_5K3_PLAN_INSTANCE_NOT_CANONICAL'); }
  catch (error) { if (error instanceof ProviderAdapterError) failClosed('PUBLIC_INTELLIGENCE_5K3_PLAN_INSTANCE_INVALID'); throw error; }

  // A provider whose transport speaks to ONE documented host is PINNED to that
  // host: the plan may not redirect it. This is what makes "no arbitrary
  // endpoints" structural rather than advisory for such a provider. A provider
  // that governs no fixed instance (Mastodon, where the instance IS part of the
  // identity) is unaffected.
  const governedInstance = PUBLIC_INTELLIGENCE_5K3_PROVIDER_DEFAULTS[plan.provider]?.instance ?? null;
  if (governedInstance !== null && plan.instance !== governedInstance) {
    failClosed(`PUBLIC_INTELLIGENCE_5K3_PLAN_INSTANCE_NOT_GOVERNED:${String(plan.instance).slice(0, 64)}`);
  }

  assertClosed(plan.query, PUBLIC_INTELLIGENCE_5K3_PLAN_SCHEMA.queryFields, 'PUBLIC_INTELLIGENCE_5K3_PLAN_QUERY');
  if (!PUBLIC_INTELLIGENCE_5K3_QUERY_TYPES.includes(plan.query.type)) failClosed('PUBLIC_INTELLIGENCE_5K3_PLAN_QUERY_TYPE_INVALID');
  // The value rule is per query TYPE and is never relaxed by provider: a HASHTAG
  // must still be a hashtag, and a TEXT_SEARCH must still be a bounded plain
  // keyword. Neither type can borrow the other's syntax.
  if (plan.query.type === 'HASHTAG') {
    try { assertHashtag(plan.query.value); }
    catch (error) { if (error instanceof ProviderAdapterError) failClosed('PUBLIC_INTELLIGENCE_5K3_PLAN_QUERY_VALUE_INVALID'); throw error; }
  } else {
    try { assertPlainSearchTerm(plan.query.value); }
    catch (error) { if (error instanceof ProviderAdapterError) failClosed('PUBLIC_INTELLIGENCE_5K3_PLAN_QUERY_VALUE_INVALID'); throw error; }
  }

  assertClosed(plan.bounds, PUBLIC_INTELLIGENCE_5K3_PLAN_SCHEMA.boundFields, 'PUBLIC_INTELLIGENCE_5K3_PLAN_BOUNDS');
  for (const key of PUBLIC_INTELLIGENCE_5K3_PLAN_SCHEMA.boundFields) {
    const value = plan.bounds[key];
    // Number.isInteger rejects NaN, Infinity and fractions. >= 1 rejects the
    // "zero means unlimited" idiom. The ceiling rejects everything larger.
    if (!Number.isInteger(value) || value < 1) failClosed(`PUBLIC_INTELLIGENCE_5K3_PLAN_BOUND_INVALID:${key}`);
    if (value > PUBLIC_INTELLIGENCE_5K3_BOUND_CEILINGS[key]) failClosed(`PUBLIC_INTELLIGENCE_5K3_PLAN_BOUND_EXCEEDS_CEILING:${key}`);
  }

  if (!isValidTimestamp(plan.createdAt)) failClosed('PUBLIC_INTELLIGENCE_5K3_PLAN_CREATED_AT_INVALID');

  // No run may override the frozen 5K.0 classification.
  if (canonical(plan.classification) !== canonical(PUBLIC_INTELLIGENCE_CLASSIFICATION)) {
    failClosed('PUBLIC_INTELLIGENCE_5K3_PLAN_CLASSIFICATION_OVERRIDE_REFUSED');
  }
  return deepFreeze(JSON.parse(canonical(plan)));
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}

/**
 * Builds a plan from operator-selected values. `classification` is always the
 * frozen 5K.0 block; it is not a parameter, so it cannot be overridden here.
 */
export function buildCollectionPlan({ provider = 'mastodon', instance, hashtag, term, bounds, collectionMode, createdAt }) {
  const defaults = PUBLIC_INTELLIGENCE_5K3_PROVIDER_DEFAULTS[provider] ?? null;
  // A provider's query TYPE is never operator-selectable: it comes from the
  // governed registry. `hashtag` (Mastodon) and `term` (Bluesky) are two names
  // for the same governed slot, so Mastodon callers keep their exact signature.
  const query = defaults === null
    ? { type: 'HASHTAG', value: hashtag }
    : { type: defaults.queryType, value: defaults.queryType === 'TEXT_SEARCH' ? (term ?? hashtag) : hashtag };
  return validateCollectionPlan({
    schemaVersion: PUBLIC_INTELLIGENCE_5K3_SCHEMA_VERSION,
    recordType: PUBLIC_INTELLIGENCE_5K3_PLAN_RECORD_TYPE,
    provider,
    instance: instance ?? defaults?.instance,
    query,
    bounds: { ...bounds },
    collectionMode,
    createdAt,
    classification: PUBLIC_INTELLIGENCE_CLASSIFICATION,
  });
}

/** Canonical SHA-256 over the full closed plan. No runtime result is an input. */
export function collectionPlanFingerprint(plan) {
  return digest(validateCollectionPlan(plan));
}

/** Plan bounds expressed in the 5K.2 transport vocabulary. Retries stay zero. */
export function transportBoundsOf(plan) {
  return Object.freeze({
    maxPages: plan.bounds.maxPages,
    maxRecords: plan.bounds.maxRecords,
    maxResponseBytes: plan.bounds.maxResponseBytes,
    timeoutMs: plan.bounds.timeoutMs,
    lookbackMs: plan.bounds.maxLookbackMs,
    maxRetries: 0,
  });
}
