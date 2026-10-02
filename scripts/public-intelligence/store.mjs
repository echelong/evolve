// Phase 5K.1 - STORAGE: a small deterministic LOCAL store. No database.
//
// 5K.1 needs persistence with certain properties, not a production database:
//
//   * raw evidence is written BEFORE and ALONGSIDE normalization
//   * raw evidence survives a round trip byte-for-byte
//   * records are append-only: no in-place mutation, ever
//   * record identity is deterministic (the dedup identity)
//   * re-ingestion is idempotent
//   * dedup is provider-aware
//   * tests get a read-only querying surface
//
// Two backends satisfy that: an in-memory store and an append-only NDJSON
// store. The NDJSON backend is what proves durability and append-only
// behaviour; the memory backend keeps unit tests hermetic.
//
// THE HARD RULE: this module writes ONLY inside a caller-supplied directory and
// REFUSES any path under `.evolve`. Phase 5K.1 does not touch R4 evidence, R4
// governance, or any existing EVOLVE state directory. The refusal is enforced at
// the path-validation boundary, so it holds for every write in the module.
//
// OFFLINE BY CONSTRUCTION: filesystem only, no socket, no provider SDK.
import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { canonical } from './definition.mjs';
import { failClosed } from './observation.mjs';
import { PUBLIC_INTELLIGENCE_5K1_DEDUP_OUTCOMES } from './dedup.mjs';

/**
 * Paths that are permanently off limits to Phase 5K.1 writes. `.evolve` holds
 * R4 evidence, Arena state and every other EVOLVE artifact; 5K.1 must not be
 * able to reach it even by accident or by a caller passing a bad path.
 */
export const PUBLIC_INTELLIGENCE_5K1_FORBIDDEN_WRITE_ROOTS = Object.freeze([
  '.evolve',
]);

/** The storage contract, stated as data. */
export const PUBLIC_INTELLIGENCE_5K1_STORAGE = Object.freeze({
  localOnly: true,
  requiresNoDatabase: true,
  rawWrittenBeforeNormalization: true,
  rawPreserved: true,
  appendOnly: true,
  inPlaceMutationPermitted: false,
  deterministicRecordIdentity: true,
  recordIdentitySource: 'DEDUP_IDENTITY',
  idempotentIngest: true,
  providerAwareDedup: true,
  readOnlyQueryingSupported: true,
  writesUnderEvolvePermitted: false,
  refusesEvolvePaths: true,
  conflictOverwritesPermitted: false,
});

/**
 * Validates a caller-supplied directory. Absolute containment is required so a
 * relative path cannot escape into `.evolve` via `..`.
 */
export function assertSafeStoreDirectory(directory) {
  if (typeof directory !== 'string' || !directory.trim()) {
    failClosed('PUBLIC_INTELLIGENCE_5K1_STORE_DIRECTORY_REQUIRED');
  }
  const resolved = path.resolve(directory);
  const segments = resolved.split(path.sep);
  if (segments.some(segment => PUBLIC_INTELLIGENCE_5K1_FORBIDDEN_WRITE_ROOTS.includes(segment))) {
    failClosed(`PUBLIC_INTELLIGENCE_5K1_STORE_PATH_FORBIDDEN:${resolved}`);
  }
  return resolved;
}

/** The envelope written to disk. Closed schema; identity first, then evidence. */
export const PUBLIC_INTELLIGENCE_5K1_RECORD_ENVELOPE = Object.freeze({
  closed: true,
  fields: Object.freeze([
    'schemaVersion',
    'recordType',
    'phase',
    'dedupIdentity',
    'provider',
    'providerObservationId',
    'rawObservationFingerprint',
    'raw',
    'normalized',
    'classification',
  ]),
});

function buildEnvelope(normalized) {
  const envelope = {
    schemaVersion: normalized.schemaVersion,
    recordType: 'public_social_ingest_record',
    phase: 'PHASE_5K_1',
    // Deterministic record identity: the provider-scoped upstream identity.
    dedupIdentity: normalized.dedupIdentity,
    provider: normalized.provider,
    providerObservationId: normalized.providerObservationId,
    rawObservationFingerprint: normalized.rawObservationFingerprint,
    // Raw evidence is stored alongside normalization, never instead of it.
    raw: normalized.raw,
    normalized,
    classification: normalized.classification,
  };
  const allowed = new Set(PUBLIC_INTELLIGENCE_5K1_RECORD_ENVELOPE.fields);
  for (const key of Object.keys(envelope)) {
    if (!allowed.has(key)) failClosed(`PUBLIC_INTELLIGENCE_5K1_ENVELOPE_UNKNOWN_FIELD:${key}`);
  }
  return Object.freeze(envelope);
}

export { buildEnvelope };

// ---------------------------------------------------------------------------
// IN-MEMORY STORE (hermetic, used by unit tests)
// ---------------------------------------------------------------------------

/**
 * An in-memory, append-only store. Records are frozen on the way in and are
 * never mutated afterwards; `put` either appends a new record or returns the
 * existing one unchanged.
 */
export function createMemoryStore() {
  const records = new Map();
  return Object.freeze({
    kind: 'memory',
    directory: null,
    /** Append-only. A duplicate identity is a no-op that returns the original. */
    put(envelope) {
      const existing = records.get(envelope.dedupIdentity);
      if (existing) return Object.freeze({ stored: false, record: existing, outcome: PUBLIC_INTELLIGENCE_5K1_DEDUP_OUTCOMES.DUPLICATE });
      records.set(envelope.dedupIdentity, envelope);
      return Object.freeze({ stored: true, record: envelope, outcome: PUBLIC_INTELLIGENCE_5K1_DEDUP_OUTCOMES.INSERTED });
    },
    has: dedupIdentity => records.has(dedupIdentity),
    get: dedupIdentity => records.get(dedupIdentity) ?? null,
    /** Read-only querying surface for tests. */
    list: () => Object.freeze([...records.values()]),
    count: () => records.size,
    providers: () => Object.freeze([...new Set([...records.values()].map(r => r.provider))].sort()),
  });
}

// ---------------------------------------------------------------------------
// NDJSON STORE (append-only, filesystem backed)
// ---------------------------------------------------------------------------

/**
 * An append-only NDJSON store rooted at a caller-supplied directory.
 *
 * Layout: two append-only streams in the caller's directory.
 *
 *   raw-evidence.ndjson   one line per ingested raw record, written FIRST
 *   observations.ndjson   one canonical envelope per record, written after
 *
 * Writing raw evidence to its own stream BEFORE the envelope is what makes
 * "raw before normalization" verifiable rather than merely asserted: if the
 * process dies between the two appends, raw evidence still survives on disk
 * and is never lost behind a failed normalization.
 *
 * Neither file is ever rewritten. A re-ingested record is detected by its dedup
 * identity and is NOT appended a second time, which is what makes ingest
 * idempotent at the file level.
 */
export function createNdjsonStore(directory, { fileName = 'observations.ndjson' } = {}) {
  const root = assertSafeStoreDirectory(directory);
  const target = path.join(root, fileName);
  const rawTarget = path.join(root, 'raw-evidence.ndjson');
  // Re-checked at construction, not just at the API boundary.
  assertSafeStoreDirectory(path.dirname(target));
  assertSafeStoreDirectory(path.dirname(rawTarget));
  mkdirSync(root, { recursive: true });

  const readLines = file => (existsSync(file)
    ? readFileSync(file, 'utf8').split('\n').filter(line => line.trim().length > 0)
    : []);

  /** Reads every stored envelope, in append order, deep-frozen and read-only. */
  const list = () => Object.freeze(readLines(target).map(line => deepFreeze(JSON.parse(line))));
  const findByIdentity = dedupIdentity =>
    list().find(record => record.dedupIdentity === dedupIdentity) ?? null;

  return Object.freeze({
    kind: 'ndjson',
    directory: root,
    filePath: target,
    rawFilePath: rawTarget,
    put(envelope) {
      const existing = findByIdentity(envelope.dedupIdentity);
      if (existing) {
        return Object.freeze({ stored: false, record: existing, outcome: PUBLIC_INTELLIGENCE_5K1_DEDUP_OUTCOMES.DUPLICATE });
      }
      // RAW FIRST. The canonical serialization keeps lines byte-stable.
      appendFileSync(rawTarget, `${canonical(envelope.raw)}\n`, 'utf8');
      appendFileSync(target, `${canonical(envelope)}\n`, 'utf8');
      return Object.freeze({ stored: true, record: envelope, outcome: PUBLIC_INTELLIGENCE_5K1_DEDUP_OUTCOMES.INSERTED });
    },
    has: findByIdentity,
    get: findByIdentity,
    list,
    /** The raw evidence stream, independently readable. */
    rawList: () => Object.freeze(readLines(rawTarget).map(line => deepFreeze(JSON.parse(line)))),
    count() {
      return list().length;
    },
    providers() {
      return Object.freeze([...new Set(list().map(record => record.provider))].sort());
    },
  });
}

/** Deep-freezes a parsed record so a reader can never mutate stored evidence. */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}
