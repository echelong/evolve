// Phase 5K.6.1 - PROVIDER CAPABILITY REGISTRY.
//
// SINGLE SOURCE OF TRUTH for provider-scoped collection ceilings.
//
// WHY THIS EXISTS
//
// A 5K.3 collection plan used ONE generic set of ceilings, inherited from the
// Mastodon adapter (maxPages 5, maxRecords 200). Once 5K.6 added a second
// provider with STRICTER transport ceilings (maxPages 3, maxRecords 100), a plan
// sized to the generic ceilings could pass plan validation and only then be
// refused inside the transport with BLUESKY_BOUNDS_INVALID.
//
// That was already fail-closed, so it was never unsafe - just untidy, and it
// wasted a round trip to learn something the plan could have been told. 5K.6.1
// moves that refusal EARLIER, to plan validation, by scoping ceilings to the
// selected provider.
//
// NO VALUE IS INVENTED HERE.
//
// Mastodon's ceilings are READ from the 5K.2 transport constant. Bluesky's are
// DEFINED here, with exactly the values 5K.6 already governed, and
// `providers/bluesky-common.mjs` re-exports THIS constant as its own
// `BLUESKY_HARD_CEILINGS`. There is therefore exactly one definition of each
// provider's ceiling in the repository, and the Bluesky transport keeps enforcing
// the very same object it always did.
//
// WHY BLUESKY'S CEILING LIVES HERE RATHER THAN IN ITS TRANSPORT
//
// A plan whose bounds are scoped per provider must be able to READ every
// provider's ceilings. If this registry imported the Bluesky transport
// constants, then the collection plan would transitively import them too, and the
// 5K.3 run-pipeline closure would grow a bluesky module - which is exactly what
// 5K.6's P5 check forbids. Defining the value here and having the transport
// re-export it keeps the dependency pointing the safe way: plan -> registry ->
// Mastodon constants, with no path from the run pipeline to any Bluesky module.
//
// NO CIRCULAR IMPORT.
//
// providers/common.mjs imports NOTHING, and bluesky-common imports only this
// registry, so the graph is acyclic.
//
// PURE AND OFFLINE BY IMPORT: no socket, no clock, no environment, no filesystem.
import { PROVIDER_HARD_CEILINGS } from './providers/common.mjs';

/**
 * The Phase 5K.6 Bluesky transport ceilings.
 *
 * Identical to what 5K.6 shipped in `providers/bluesky-common.mjs`; this is now
 * the single definition site and `BLUESKY_HARD_CEILINGS` is a re-export of it, so
 * the transport's defence-in-depth check is unchanged in both value and effect.
 */
export const PUBLIC_INTELLIGENCE_5K6_1_BLUESKY_TRANSPORT_CEILINGS = Object.freeze({
  maxPages: 3,
  maxRecords: 100,
  maxResponseBytes: 2 * 1024 * 1024,
  timeoutMs: 20_000,
  lookbackMs: 7 * 24 * 60 * 60 * 1000,
  maxRetries: 1,
});

export const PUBLIC_INTELLIGENCE_5K6_1_PHASE = 'PHASE_5K_6_1';
export const PUBLIC_INTELLIGENCE_5K6_1_SCHEMA_VERSION = '5K.6.1';

/**
 * The closed shape of one provider capability entry.
 *
 * `planBoundCeilings` is in COLLECTION-PLAN vocabulary (`maxLookbackMs`);
 * `transportBoundCeilings` is in TRANSPORT vocabulary (`lookbackMs`). Keeping
 * both, rather than one renamed, is what lets the validator compare a plan ceiling
 * against the exact ceiling the transport enforces without translating twice.
 */
export const PUBLIC_INTELLIGENCE_5K6_1_CAPABILITY_SCHEMA = Object.freeze({
  closed: true,
  fields: Object.freeze(['provider', 'planBoundCeilings', 'transportBoundCeilings', 'source']),
  planFields: Object.freeze(['maxPages', 'maxRecords', 'timeoutMs', 'maxResponseBytes', 'maxLookbackMs']),
  transportFields: Object.freeze(['maxPages', 'maxRecords', 'timeoutMs', 'maxResponseBytes', 'lookbackMs', 'maxRetries']),
});

/** The only field whose floor is legitimately 0: "no retry" is a real setting. */
const ZERO_ALLOWED_FIELDS = Object.freeze(['maxRetries']);

const freezeEntry = (provider, ceilings, source) => Object.freeze({
  provider,
  planBoundCeilings: Object.freeze({
    maxPages: ceilings.maxPages,
    maxRecords: ceilings.maxRecords,
    timeoutMs: ceilings.timeoutMs,
    maxResponseBytes: ceilings.maxResponseBytes,
    maxLookbackMs: ceilings.lookbackMs,
  }),
  transportBoundCeilings: Object.freeze({
    maxPages: ceilings.maxPages,
    maxRecords: ceilings.maxRecords,
    timeoutMs: ceilings.timeoutMs,
    maxResponseBytes: ceilings.maxResponseBytes,
    maxLookbackMs: ceilings.lookbackMs,
  }),
  transportBoundCeilings: Object.freeze({
    maxPages: ceilings.maxPages,
    maxRecords: ceilings.maxRecords,
    timeoutMs: ceilings.timeoutMs,
    maxResponseBytes: ceilings.maxResponseBytes,
    lookbackMs: ceilings.lookbackMs,
    maxRetries: ceilings.maxRetries,
  }),
  source,
});

/**
 * The registry. Keys are sorted and the object is frozen: a caller cannot add a
 * provider at runtime, and an unknown provider has NO entry and NO fallback.
 */
export const PUBLIC_INTELLIGENCE_5K6_1_PROVIDER_CAPABILITIES = Object.freeze({
  bluesky: freezeEntry('bluesky', PUBLIC_INTELLIGENCE_5K6_1_BLUESKY_TRANSPORT_CEILINGS, 'PUBLIC_INTELLIGENCE_5K6_1_BLUESKY_TRANSPORT_CEILINGS'),
  mastodon: freezeEntry('mastodon', PROVIDER_HARD_CEILINGS, 'PROVIDER_HARD_CEILINGS'),
});

export const PUBLIC_INTELLIGENCE_5K6_1_CAPABILITY_PROVIDERS = Object.freeze(
  Object.keys(PUBLIC_INTELLIGENCE_5K6_1_PROVIDER_CAPABILITIES).sort(),
);

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The capability entry for one provider.
 *
 * FAILS CLOSED for anything unknown: there is no default capability set and no
 * fallback to generic bounds, because a silent fallback is exactly the untidy
 * behaviour 5K.6.1 exists to remove.
 */
export function providerCapabilitiesOf(provider) {
  const entry = PUBLIC_INTELLIGENCE_5K6_1_PROVIDER_CAPABILITIES[provider];
  if (!isPlainObject(entry)) {
    const code = `PUBLIC_INTELLIGENCE_5K6_1_PROVIDER_CAPABILITIES_UNKNOWN:${String(provider).slice(0, 32)}`;
    throw Object.assign(new Error(code), { code });
  }
  return entry;
}

/** The plan-vocabulary ceilings for one provider. */
export const planBoundCeilingsOf = provider => providerCapabilitiesOf(provider).planBoundCeilings;

/** The transport-vocabulary ceilings for one provider. */
export const transportBoundCeilingsOf = provider => providerCapabilitiesOf(provider).transportBoundCeilings;

/**
 * Structural validation of the registry itself.
 *
 * Returns `{ ok, problems }` rather than throwing so the validator can report
 * precisely which invariant broke. Every governed value must be a finite integer
 * at or above its floor; nothing may be NaN, Infinity, fractional, or zero where
 * zero would mean "unlimited".
 */
export function validateProviderCapabilitiesRegistry(registry = PUBLIC_INTELLIGENCE_5K6_1_PROVIDER_CAPABILITIES) {
  const problems = [];
  const S = PUBLIC_INTELLIGENCE_5K6_1_CAPABILITY_SCHEMA;
  const checkBounded = (scope, values, fields) => {
    for (const field of fields) {
      const value = values?.[field];
      const floor = ZERO_ALLOWED_FIELDS.includes(field) ? 0 : 1;
      if (typeof value !== 'number' || !Number.isFinite(value)) { problems.push(`${scope}.${field}:NOT_FINITE`); continue; }
      if (!Number.isInteger(value)) { problems.push(`${scope}.${field}:NOT_AN_INTEGER`); continue; }
      if (value < floor) problems.push(`${scope}.${field}:BELOW_FLOOR`);
    }
    for (const key of Object.keys(values ?? {})) {
      if (!fields.includes(key)) problems.push(`${scope}.${key}:UNKNOWN_FIELD`);
    }
  };
  for (const provider of Object.keys(registry).sort()) {
    const entry = registry[provider];
    if (!isPlainObject(entry)) { problems.push(`${provider}:NOT_AN_OBJECT`); continue; }
    for (const field of S.fields) if (!Object.hasOwn(entry, field)) problems.push(`${provider}:FIELD_MISSING:${field}`);
    for (const key of Object.keys(entry)) {
      if (!S.fields.includes(key)) problems.push(`${provider}.${key}:UNKNOWN_FIELD`);
    }
    if (entry.provider !== provider) problems.push(`${provider}:PROVIDER_KEY_MISMATCH`);
    checkBounded(`${provider}.planBoundCeilings`, entry.planBoundCeilings, S.planFields);
    checkBounded(`${provider}.transportBoundCeilings`, entry.transportBoundCeilings, S.transportFields);
  }
  return { ok: problems.length === 0, problems: Object.freeze(problems) };
}

/**
 * The critical invariant: a plan ceiling may never exceed the ceiling the
 * transport enforces for the same provider. Returns the per-field comparison so
 * the validator can assert equality rather than merely inequality.
 */
export function comparePlanAndTransportCeilings(provider) {
  const entry = providerCapabilitiesOf(provider);
  const shared = ['maxPages', 'maxRecords', 'timeoutMs', 'maxResponseBytes'];
  return Object.freeze({
    provider,
    planAtMostTransport: shared.every(field => entry.planBoundCeilings[field] <= entry.transportBoundCeilings[field]),
    equalFields: Object.freeze(shared.filter(field => entry.planBoundCeilings[field] === entry.transportBoundCeilings[field])),
    unequalFields: Object.freeze(shared.filter(field => entry.planBoundCeilings[field] !== entry.transportBoundCeilings[field])),
    lookbackPlanAtMostTransport: entry.planBoundCeilings.maxLookbackMs <= entry.transportBoundCeilings.lookbackMs,
    lookbackEqual: entry.planBoundCeilings.maxLookbackMs === entry.transportBoundCeilings.lookbackMs,
  });
}
