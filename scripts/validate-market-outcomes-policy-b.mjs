#!/usr/bin/env node
// P3-C Policy B (POLICY_B_OBSERVATION_IDENTITY) sensitivity validation.
//
// Sensitivity only. Policy A remains the primary policy and remains the default.
// Synthetic temporary fixtures only: no R4 evidence is read, no R4 outcome is
// generated, and the real .evolve tree is never written.
import { policyBCases } from './market-outcomes/policy-b-cases.mjs';
import { resolveReference, snapshotMissingReason } from './market-outcomes/index.mjs';
import { resolveReferencePolicyB, PRIMARY_POLICY, SENSITIVITY_POLICY } from './market-outcomes/sensitivity.mjs';

const cases = policyBCases({ resolveReference, snapshotMissingReason, resolveReferencePolicyB });
let failed = 0;
for (const [name, fn] of cases) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (e) { failed++; console.error(`FAIL ${name}: ${e.stack}`); }
}
console.log('');
console.log(`Primary policy (default, production): ${PRIMARY_POLICY}`);
console.log(`Sensitivity policy (never primary):    ${SENSITIVITY_POLICY}`);
console.log(`Policy B sensitivity: ${cases.length - failed}/${cases.length} passed; synthetic temporary fixtures only`);
if (failed) process.exitCode = 1;
