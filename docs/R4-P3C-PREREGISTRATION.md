# R4 P3-C scientific preregistration: reused reference price evidence

Status: **FROZEN before the real R4 cohort**. This note fixes only the
`REUSED_REFERENCE_PRICE_EVIDENCE` rule. It does not seal the full R4 protocol,
start a cohort, change capture, or change any other scientific threshold.
Reviewed code HEAD: `2af26a8d089458c925f507c26d44621a35cef8fa`.

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
`REUSED_REFERENCE_PRICE_EVIDENCE` count. Zero movement is admissible when the
required later two-source evidence is distinct by these rules; an identical
same-provider raw or normalized digest is inadmissible regardless of the price
value. No price direction or movement magnitude participates in eligibility.

## Sensitivity analysis, fixed in advance

`POLICY_B_OBSERVATION_IDENTITY` is predeclared **only as a sensitivity
analysis**. Under B, replace only the same-provider raw/normalized reference
digest comparison above: accept matching content if each future contributor
is corroborated by a distinct persisted source observation and normalized
market observation in an authenticated eligible session, and all existing
post-target, freshness, alignment, two-source, and no-lookahead rules pass.
The local-receipt trust assumption stated above applies. Cross-provider and
within-snapshot rules remain identical. A separately versioned sensitivity
implementation and behavioral tests must be fixed before it reads real R4
outcomes.

Later reporting may compare reference availability, missing-reason counts,
and the same prespecified R4 primary analysis under A and B on the same frozen
reference set. The B result must be labeled sensitivity, disclosed with its
trust assumption and the affected-reference count, and never substituted for
the A primary result. It cannot select references, tune thresholds, change
the primary estimand, or redefine the primary result after returns are seen.

## Implementation and required checks

Production `scripts/market-outcomes/index.mjs` already implements Policy A:
`resolveReference` checks `PRE_TARGET_PRICE_EVIDENCE` first, then rejects a
same-provider raw **or** normalized digest equality with
`REUSED_REFERENCE_PRICE_EVIDENCE`. No production code change, capture redesign,
Jupiter semantic change, or new provenance claim is required.

Before full R4 preregistration, freeze behavioral tests for: raw-only,
normalized-only, and both-equal same-provider matches; each provider in turn;
post-target local timestamps that cannot waive a digest match; pre-target
timestamps even with changed content; cross-provider-only matches that do not
trigger the reference-reuse code; duplicate within-snapshot evidence that
remains invalid; rejection counts and deterministic skip-to-next-candidate
behavior; and admissibility of a separately authenticated flat observation
whose same-provider digests differ. Existing resolver tests already cover the
raw-only, normalized-only, pre-target, and duplicate-evidence cases. The
remaining boundary cases require explicit test fixtures. These checks must
use synthetic evidence and may not inspect real R4 outcomes.

## Methods/process incident

The launcher-side aborted zero-reference session `1790584852634-…` remains a
disclosed methods/process incident. It is excluded from scientific evidence.
The valid second bounded shakedown is `1790585177858-…`. This note does not
alter either live evidence session.

## Remaining full-preregistration work

Complete and verify the missing Policy A boundary tests; fix and verify any
separately versioned Policy B sensitivity implementation before it reads real
R4 outcomes; then finish the other R4 protocol gates and code/evidence seal.
This P3-C decision alone does not declare R4 sealed or authorize cohort start.
