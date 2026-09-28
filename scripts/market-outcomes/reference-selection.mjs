// Deterministic prospective R4 reference builder — ALL_ELIGIBLE_REFERENCES.
//
// The canonical resolver `generateOutcomeRun` consumes an explicit list of
// `{ sessionId, snapshotDigest }` identities. This module builds that list
// prospectively and deterministically, using only reference identity and the
// frozen reference-validity result already computed by `readSourceSession`.
//
// Frozen properties:
//   * only cohort-role sessions may contribute references (D2);
//   * only snapshots with `validationReason === null` are included;
//   * invalid snapshots are excluded from the supplied list, not emitted;
//   * ordering is sessionId ascending, then snapshotDigest ascending;
//   * a duplicate identity is a hard error;
//   * the module is read-only with respect to evidence and never inspects a
//     price direction, an outcome, a model score or a later token state.
import { R4_SOURCE_POLICY, readSourceSession } from './index.mjs';
import { assertR4NotExcluded } from '../r4-exclusions.mjs';

const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const REFERENCE_RULE = 'ALL_ELIGIBLE_REFERENCES';

export function selectAllEligibleReferences(sessions) {
  if (!Array.isArray(sessions) || sessions.length === 0) throw new Error('REFERENCE_SESSIONS_INVALID');
  const seen = new Set();
  const selected = [];
  for (const session of sessions) {
    if (!session || typeof session.sessionId !== 'string' || !Array.isArray(session.snapshots)) throw new Error('REFERENCE_SESSION_INVALID');
    // Hard exclusion at the reference-builder boundary: an excluded methods-only
    // session must never contribute a single R4 reference, whatever role it was
    // labelled with.
    assertR4NotExcluded(session.sessionId);
    if (session.role !== 'cohort') continue;
    for (const candidate of session.snapshots) {
      if (candidate.validationReason !== null) continue;
      const key = `${session.sessionId}/${candidate.snapshotDigest}`;
      if (seen.has(key)) throw new Error('REFERENCE_DUPLICATE_IDENTITY');
      seen.add(key);
      selected.push({ sessionId: session.sessionId, snapshotDigest: candidate.snapshotDigest });
    }
  }
  selected.sort((a, b) => order(a.sessionId, b.sessionId) || order(a.snapshotDigest, b.snapshotDigest));
  if (selected.length === 0) throw new Error('REFERENCE_SELECTION_EMPTY');
  return selected;
}

export function collectAllEligibleReferences({ sources }, policy = R4_SOURCE_POLICY) {
  if (!Array.isArray(sources) || sources.length === 0) throw new Error('REFERENCE_SOURCES_INVALID');
  return selectAllEligibleReferences(sources.map(source => readSourceSession(source, policy)));
}
