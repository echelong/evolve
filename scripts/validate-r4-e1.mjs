#!/usr/bin/env node
// E1_REFERENCE_LEVEL_MISSINGNESS behavioural validator (cases A–M).
//
// Synthetic temporary fixtures only. No .evolve evidence is read, no live
// capture is started and no real outcome is generated.
import { revisitExitFailure } from './market-intelligence.mjs';
import { createRevisitQueue } from './market-intelligence/revisits.mjs';
import { createStorage } from './market-intelligence/storage.mjs';
import { readSourceSession, generateOutcomeRun, snapshotMissingReason } from './market-outcomes/index.mjs';
import { e1Cases, cleanupE1Roots } from './r4-e1-cases.mjs';

const api = { revisitExitFailure, createRevisitQueue, createStorage, readSourceSession, generateOutcomeRun, snapshotMissingReason };
const cases = e1Cases(api);
let failed = 0;
try {
  for (const [name, fn] of cases) {
    try { await fn(); console.log(`PASS ${name}`); }
    catch (e) { failed++; console.error(`FAIL ${name}: ${String(e?.stack ?? e).split('\n')[0]}`); }
  }
} finally { cleanupE1Roots(); }
console.log('');
console.log(`E1 reference-level missingness: ${cases.length - failed}/${cases.length} passed; synthetic temporary fixtures only`);
if (failed) process.exitCode = 1;
