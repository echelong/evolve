# R4 Post-Start Continuation Amendment

## Scope

This is an enforcement-only amendment for a cohort that has already started.
Attempt 1 completed under the frozen A2/S5 authority before a post-A2 authority
resolution defect was discovered. The defect rejected legitimate attempt
artifacts while resolving the immutable approval-epoch chain.

The scientific protocol is unchanged. This amendment must not change the R4
spec digest, capture-spec digest, providers, reference rule, outcome definition,
analysis, sample floors, attempt budget, target completed sessions, or T0.

## Authority

The continuation authority is separate from approval epochs:

`A2 -> P6 -> S6 -> C1`

A2 remains the scientific approval. P6 contains only the enforcement repair and
its validators. S6 reseals the runtime. C1 is governance-only and binds A2, S5,
S6, and the complete pre-boundary attempt history.

C1 is not A3. It creates no new T0 and no additional attempt budget.

## Bound history

C1 derives its boundary from verified canonical attempt history. Every attempt
at or below that boundary is included. No caller can select, omit, restart, or
renumber historical attempts.

Each pre-boundary attempt remains verified against the authority that actually
authorized it. Its authorization, claim, terminal, attestation, session,
approval, seal, and T0 identities are bound into a deterministic history digest.

Post-C1 attempts are verified against the current P6/S6 runtime and must carry
the C1 continuation fingerprint in authorization, claim, receipt, attestation,
and terminal records.

## Eligibility and anti-selection

A continuation is permitted only when at least one attempt exists, the latest
attempt is terminal, the target has not already been reached, the fixed attempt
budget is not exhausted, and no canonical outcome run exists.

Continuation eligibility and construction do not read prices, disagreement,
references, exposure values, outcome values, effect sizes, or analysis results.

The original total budget remains eight attempts and the target remains six
completed sessions. Attempt 1 remains consumed and completed; C1 authorizes
continuation beginning mechanically at Attempt 2.
