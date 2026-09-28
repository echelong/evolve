# R4 P3-C scientific preregistration: reused reference price evidence

Status: **FROZEN before the real R4 cohort**. This note fixes only the
`REUSED_REFERENCE_PRICE_EVIDENCE` rule. It does not seal the full R4 protocol,
start a cohort, change capture, or change any other scientific threshold.
Reviewed code HEAD: `2af26a8d089458c925f507c26d44621a35cef8fa`.

**Primary policy, bound:** `POLICY_A_CONTENT_UNIQUENESS`. The production
resolver `resolveReference` in `scripts/market-outcomes/index.mjs` implements
it and is the default and only primary entry point. `generateOutcomeRun` always
resolves under Policy A. No R4 cohort has started and no R4 outcome has been
generated.

## Decision evidence and limit

The second bounded non-R4 shakedown had 147 safely Jupiter-eligible references
and 147/147 valid post-target two-source opportunities. It had zero avoidable
Dex scheduler misses, zero idle-with-capacity incidents, zero proven
capacity-bound misses, and zero provider failures. Native
`revisit-scheduler.ndjson` telemetry was sufficient. The fail-closed unresolved
references were 67 `JUPITER_PRE_TARGET` and 11 `JUPITER_MINT_NOT_PRESENT`.
This shakedown generated no outcomes and calculated no returns.

The P3-C measurement found 13 reuse-only candidates affecting six references,
an affected-reference rate of 4.1%. All six references came from one
zero-activity mint. Every affected candidate was DexScreener `bothEqual`:
its raw and normalized digests both equaled the corresponding reference
digests. No evidence shows broad censoring across many mints or providers.
Six references from one mint cannot estimate the population-wide frequency of
identical future observations. They do demonstrate the mechanism: a valid
post-target capture opportunity can have the same provider content as its
reference. The choice here therefore concerns the evidentiary rule, not an
estimate of that mechanism's cohort-wide frequency.

`PRE_TARGET_PRICE_EVIDENCE` already rejects literal old evidence carrying its
original old timestamp. The authenticated source and observation joins block
ordinary cache replay, duplicate persistence, and pre-target reuse. Current
DexScreener `providerObservedAt` is locally established request/receipt timing,
not an independently authenticated upstream update time. No provider response
ID, nonce, ETag/Date/Age provenance, or provider-authenticated update identifier
is persisted. Provenance is **PARTIAL**: it supports a distinct local capture
event, but cannot independently prove a fresh upstream DexScreener measurement
when identical bytes appear again.

## Scientific choice

**Primary: `POLICY_A_CONTENT_UNIQUENESS`.** A same-provider raw *or*
normalized digest match to the reference makes that future candidate
ineligible. The rule relies on authenticated content, source joins, and fixed
timestamps; it does not treat a new local timestamp as sufficient proof of
upstream freshness. It is deterministic, reproducible, auditable from persisted
digests, and conservative for the first preregistered R4 experiment. It can
remain frozen through the full cohort without a provider-side identity field.
Its cost is real: a legitimately fresh but unchanged DexScreener response is
rejected, so zero-movement evidence can be censored. The six affected
references show this possibility; they do not quantify its general rate.

`POLICY_B_OBSERVATION_IDENTITY` would retain flat observations when a separate
persisted capture has valid post-target timestamps and provenance, even if both
digests match. This reduces content-based zero-movement censoring and has a
clear local audit trail. It nevertheless depends on the following additional
trust assumption: **“A later locally timestamped provider receipt is accepted
as evidence of a distinct upstream observation even if the provider supplies
identical payload bytes.”** Current provenance cannot verify that assumption.
An old DexScreener response could be relabeled with a later local
`providerObservedAt` before finalization, given a new internally consistent
observation record and authenticated session manifest. Source authentication
would then prove what was persisted, not when the provider last measured or
updated those bytes. Policy B would admit that case; Policy A rejects it when
either same-provider digest matches. Neither rule proves the provider's true
update time, but A does not need that proof to reject matching content.

The decision was made without observing R4 returns, outcome direction,
profitability, or model success. No criterion was assigned a numerical weight.

## Canonical frozen primary rule

For each existing, same-mint future snapshot in the inclusive interval
`[referenceObservedAt + 300000, referenceObservedAt + 360000]`, first apply all
existing source, snapshot, provenance, freshness, alignment, and two-source
validity checks. Both Jupiter and DexScreener future price contributors must
have `providerObservedAt >= referenceObservedAt + 300000`. A contributor with
an earlier timestamp rejects the candidate as `PRE_TARGET_PRICE_EVIDENCE`,
even if its content differs. A post-target timestamp does not override a
digest match.

Compare each future price contributor only with the reference contributor of
the **same provider**. Reject the entire future candidate as
`REUSED_REFERENCE_PRICE_EVIDENCE` if **either** its authenticated
`rawResponseDigest` equals that same-provider reference raw digest **or** its
authenticated `normalizedPayloadDigest` equals that same-provider reference
normalized digest. This includes `bothEqual` and applies even when the future
observation was separately fetched, persisted, and locally timestamped. No
digest comparison between different providers is a reference-reuse test;
the existing within-snapshot `DUPLICATE_PRICE_EVIDENCE` check still requires
independent Jupiter and DexScreener contributors.

An eligible future candidate must remain an existing, distinctly persisted
snapshot with contributor-to-source and source-to-market-observation identity
corroborated by the authenticated session evidence. A copied snapshot or
duplicated observation does not become independent evidence through a new
session label or local timestamp. Passing identity, timestamp, and digest
checks is required; identity or timestamp alone cannot waive content
uniqueness. When a candidate fails, the resolver records its exact rejection
count and considers the next candidate in deterministic order. If none is
valid, the reference remains unavailable with
`NO_VALID_FUTURE_TWO_SOURCE_OBSERVATION` and its
`REUSED_REFERENCE_PRICE_EVIDENCE` count. **Zero movement is admissible when the
required later two-source evidence is distinct by these rules; an identical
same-provider raw or normalized digest is inadmissible regardless of the price
value.** Policy A rejects *evidence identity reuse*, not zero movement. No price
direction or movement magnitude participates in eligibility.

## Frozen boundary coverage

`scripts/market-outcomes/policy-a-cases.mjs` holds the frozen behavioral cases
and is executed by `scripts/validate-market-outcomes.mjs` against the
production resolver. It covers, for each provider in turn: same-provider
raw-only, normalized-only, and both-equal matches; cross-provider digest
equality that must **not** trigger the reuse code; `PRE_TARGET_PRICE_EVIDENCE`
precedence over reuse both with and without a digest match; rejection counts
recorded per reason; deterministic skip-to-next-candidate and the
digest-then-session-ID tie-break; the all-reused unavailable state; a distinct
flat observation with zero movement and an exact `absLogReturn300sBps` of `0`;
and byte-identical results and rejection counts under candidate, session, and
indexed-input reordering.

`scripts/validate-p3c-mutation.mjs` applies controlled edits to the frozen reuse
rule and executes the identical case module against each mutant. All eight
critical mutants are killed and both behaviour-preserving control mutants
survive, so equivalence is demonstrated rather than asserted.

## Sensitivity analysis, fixed in advance

`POLICY_B_OBSERVATION_IDENTITY` is predeclared **only as a sensitivity
analysis**. Under B, replace only the same-provider raw/normalized reference
digest comparison above: accept matching content if each future contributor
is corroborated by a distinct persisted source observation and normalized
market observation in an authenticated eligible session, and all existing
post-target, freshness, alignment, two-source, and no-lookahead rules pass.
The local-receipt trust assumption stated above applies. Cross-provider and
within-snapshot rules remain identical.

### Policy B trust assumption (frozen wording)

Provenance is classified **PARTIAL**, so Policy B necessarily carries this
explicit trust assumption, which must not be weakened or omitted when a B
result is reported:

> A later locally timestamped provider receipt is accepted as evidence of a
> distinct upstream observation even if the provider supplies identical payload
> bytes.

### Policy B isolation architecture (frozen)

`scripts/market-outcomes/sensitivity.mjs` is a separately versioned,
sensitivity-only resolver. `resolveReferencePolicyB` is reachable **only** by
explicitly calling that function.

* `scripts/market-outcomes/index.mjs` is **unmodified**. The primary resolver
  never references the sensitivity module, never names Policy B, and reads no
  ambient environment state. There is no flag, config value, or auto-selection.
* No fallback from A to B exists, in either direction.
* The sensitivity module imports no filesystem module, performs no writes, and
  holds no mutable module-level state. Primary artifacts are written only by
  `generateOutcomeRun`. A sensitivity result therefore cannot create, overwrite,
  or substitute a primary outcome file.
* Every scientific constant is imported from the primary module; the sensitivity
  module redefines no threshold. It consumes a reference as an argument and
  never selects one.
* Every sensitivity record carries `primaryPolicy`,
  `sensitivityPolicy`, `sensitivityOnly: true`, the trust assumption above, and
  the distinct record type `market_outcome_sensitivity`, so it can never be
  mistaken for a primary `market_outcome` record.

`scripts/validate-market-outcomes-policy-b.mjs` runs the frozen B cases in
`scripts/market-outcomes/policy-b-cases.mjs`: identical same-provider bytes are
accepted under B and rejected under A on the same input; `PRE_TARGET` still
rejects and still takes precedence; invalid provenance, within-snapshot
duplicate evidence, freshness, alignment, and candidate ordering are unchanged;
outputs are explicitly labeled; A and B cannot overwrite one another; the
default invocation always uses A; and a differential case proves A and B agree
on every scenario except the same-provider reuse rule.

### Sensitivity output contract (frozen)

Allowed comparisons between A and B, and nothing else:

* resolved and unresolved counts;
* missingness and missing-reason counts;
* reference availability;
* the same prespecified R4 primary analysis repeated on the **same frozen
  references**;
* the difference between A and B under the same cohort.

Forbidden uses, stated as a contract rather than guidance:

* redefining the primary R4 conclusion;
* selecting references from whichever policy looks better;
* choosing or tuning any threshold after observing results;
* replacing Policy A in the primary result;
* expanding or removing cohort members;
* changing the horizon, tolerance, freshness, or alignment rules;
* using B to rescue an unfavorable primary result.

Later reporting may compare the quantities above under A and B on the same
frozen reference set. The B result must be labeled sensitivity, disclosed with
its trust assumption and the affected-reference count, and never substituted for
the A primary result. It cannot select references, tune thresholds, change the
primary estimand, or redefine the primary result after returns are seen.

## Implementation and required checks

Production `scripts/market-outcomes/index.mjs` already implements Policy A:
`resolveReference` checks `PRE_TARGET_PRICE_EVIDENCE` first, then rejects a
same-provider raw **or** normalized digest equality with
`REUSED_REFERENCE_PRICE_EVIDENCE`. **No production code change was made or is
required**: that file is byte-identical across this freeze, at git blob
`12922fc1de2f235037c4757cb71f91a61fcb1961`, unchanged from the reviewed HEAD
`2af26a8`. There is no capture redesign, Jupiter semantic change, or new
provenance claim.

The frozen boundary cases, the mutation check, and the Policy B sensitivity
implementation described above are complete. All of them use synthetic
temporary fixtures. No check inspects real R4 outcomes, and no check created an
R4 cohort or an outcome run.

## Methods/process incident

The launcher-side aborted zero-reference session `1790584852634-…` remains a
disclosed methods/process incident. It is excluded from scientific evidence.
The valid second bounded shakedown is `1790585177858-…`. This note does not
alter either live evidence session.

## Remaining full-preregistration work

The Policy A boundary tests, the Policy A mutation check, and the isolated
Policy B sensitivity implementation are complete and verified without reading
R4 outcomes. Still outstanding before the R4 cohort may start: the remaining
R4 protocol gates, the decision to store any sensitivity artifact under a
separately versioned root, and the code/evidence seal. This P3-C decision alone
does not declare R4 sealed or authorize cohort start.
