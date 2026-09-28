// R4 methods-only exclusion list — single leaf source of truth.
//
// These five sessions are methods-only / process evidence. No R4 scientific
// path may consume them, regardless of any caller-supplied role string. This is
// a leaf module: it imports nothing, so every boundary (source loading, the
// reference builder, the cohort governor and analysis provenance) can enforce
// the same frozen list without an import cycle.
//
// The list is frozen by docs/R4-PREREGISTRATION.md and bound by the canonical
// tracked R4 seal.
export const R4_EXCLUSIONS = Object.freeze([
  '1790507032018-6854248b-5e29-49fc-9dec-aef8ab398593',
  '1790523432292-82b204a2-75b8-49fd-92a6-c51e6a9370ca',
  '1790579084231-1b57d644-fbbe-4ccc-9b6e-62aff585a4ee',
  '1790584852634-6265dffb-c23a-45fd-9d74-ec03a18f76a3',
  '1790585177858-ac3ca9df-85a4-4bf8-806c-c91045f92883',
]);

const EXCLUDED = new Set(R4_EXCLUSIONS);

export function isR4Excluded(sessionId) {
  return typeof sessionId === 'string' && EXCLUDED.has(sessionId);
}

export function assertR4NotExcluded(sessionId) {
  if (isR4Excluded(sessionId)) throw new Error('R4_EXCLUDED_SESSION');
  return sessionId;
}
