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
} from './providers/common.mjs';

export const PUBLIC_INTELLIGENCE_5K3_PHASE = 'PHASE_5K_3';
export const PUBLIC_INTELLIGENCE_5K3_SCHEMA_VERSION = '5K.3.0';
export const PUBLIC_INTELLIGENCE_5K3_PLAN_RECORD_TYPE = 'public_collection_plan';

/** The only provider and query type 5K.3 supports. No other provider is added here. */
export const PUBLIC_INTELLIGENCE_5K3_PROVIDERS = Object.freeze(['mastodon']);
export const PUBLIC_INTELLIGENCE_5K3_QUERY_TYPES = Object.freeze(['HASHTAG']);
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

  assertClosed(plan.query, PUBLIC_INTELLIGENCE_5K3_PLAN_SCHEMA.queryFields, 'PUBLIC_INTELLIGENCE_5K3_PLAN_QUERY');
  if (!PUBLIC_INTELLIGENCE_5K3_QUERY_TYPES.includes(plan.query.type)) failClosed('PUBLIC_INTELLIGENCE_5K3_PLAN_QUERY_TYPE_INVALID');
  try { assertHashtag(plan.query.value); }
  catch (error) { if (error instanceof ProviderAdapterError) failClosed('PUBLIC_INTELLIGENCE_5K3_PLAN_QUERY_VALUE_INVALID'); throw error; }

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
export function buildCollectionPlan({ provider = 'mastodon', instance, hashtag, bounds, collectionMode, createdAt }) {
  return validateCollectionPlan({
    schemaVersion: PUBLIC_INTELLIGENCE_5K3_SCHEMA_VERSION,
    recordType: PUBLIC_INTELLIGENCE_5K3_PLAN_RECORD_TYPE,
    provider,
    instance,
    query: { type: 'HASHTAG', value: hashtag },
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
