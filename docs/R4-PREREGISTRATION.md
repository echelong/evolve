# R4 full preregistration — frozen protocol

Status: **FROZEN full R4 preregistration.** This document fixes the complete R4
protocol prospectively, before any real R4 cohort, source session, maturation or
outcome exists. It is bound by the deterministic R4 preregistration seal under
`.evolve/governance/` (record type `r4_preregistration_seal`), whose authority
section lists every bound artifact digest and every frozen constant.

This document authorizes **no capture, no cohort start and no outcome
generation**. Cohort start requires the seal to be committed and pushed, and then
the mechanical T0 rule of §D1. Outcome generation requires the cohort to be
closed, maturation to be complete, source integrity to verify and a separate
authorization.

The primary outcome primitive was frozen earlier by
`docs/R4-MARKET-OUTCOME-FOUNDATION.md`. The Policy A rule was frozen earlier by
`docs/R4-P3C-PREREGISTRATION.md`. This document does not reopen either; it fixes
the remaining protocol mechanics.

## Authority map and precedence

| Rule | Document | Code | Validator | State |
| --- | --- | --- | --- | --- |
| Outcome primitive `ABS_LOG_RETURN_300S_BPS_V1`, horizon, tolerance, ordering | `docs/R4-MARKET-OUTCOME-FOUNDATION.md` | `scripts/market-outcomes/index.mjs` | `scripts/validate-market-outcomes.mjs` | FROZEN |
| Policy A `POLICY_A_CONTENT_UNIQUENESS` | `docs/R4-P3C-PREREGISTRATION.md` | `scripts/market-outcomes/index.mjs` | `policy-a-cases.mjs`, `validate-p3c-mutation.mjs` | FROZEN |
| Policy B sensitivity, compute only | `docs/R4-P3C-PREREGISTRATION.md` | `scripts/market-outcomes/sensitivity.mjs` | `validate-market-outcomes-policy-b.mjs` | FROZEN |
| Capture, storage bound, revisit scheduler | `docs/PHASE5J-MARKET-INTELLIGENCE.md`, `docs/R4-CAPTURE-COVERAGE.md`, `docs/r4-revisit-scheduler.md` | `scripts/market-intelligence.mjs`, `scripts/market-intelligence/*` | `validate-phase5j.mjs`, `validate-r4-revisits.mjs` | FROZEN |
| B1 reference-level missingness | this document §B1 | `scripts/market-intelligence.mjs`, `scripts/market-intelligence/revisits.mjs` | `validate-r4-e1.mjs`, `validate-r4-e1-mutation.mjs` | FROZEN |
| Reference selection `ALL_ELIGIBLE_REFERENCES` | this document §D2 | `scripts/market-outcomes/reference-selection.mjs` | `validate-r4-protocol.mjs` | FROZEN |
| Primary analysis `CONTINUOUS_RANK_ASSOCIATION` | this document §D3 | `scripts/market-outcomes/primary-analysis.mjs` | `validate-r4-protocol.mjs` | FROZEN |
| Cohort governance plan, T0, 6/8 attempts | this document §D1, §D4 | `scripts/r4-cohort-plan.mjs` | `validate-r4-protocol.mjs` | FROZEN |

No committed authority overrides these. `2af26a8` repaired the live scheduler;
`44f02fa` froze Policy A; `aa71894` locked its behavioural tests and the B
sensitivity.

## D1 — Cohort

**Frozen: `MULTI_SESSION_TARGETED`.**

- Target: **6 completed eligible cohort-role sessions**.
- Each session: a **45-minute** reference window, capture mode **`--r4-revisits`**,
  run sequentially, each followed by its own normal bounded revisit drain.
- Exact command: `node scripts/market-intelligence.mjs capture --r4-revisits --minutes 45`.
- Providers: **Jupiter + DexScreener enabled**; GMGN remains `DISABLED_NO_KEY`;
  the launch observer remains `DISABLED_UNVERIFIED_TRANSPORT`.
- No outcome-dependent extension; no discretionary extra session.
- Start trigger: capture may begin only after this complete preregistration and
  its independent pre-capture seal are committed and pushed. **T0 = the first
  whole UTC hour at least 30 minutes after that seal commit.** The rule is
  mechanical (`mechanicalT0`) and T0 may not be moved because of market
  conditions.
- Session eligibility requires `status = complete`, `reason = duration reached`,
  `storage.sessionBoundReached = false`, a completed 45-minute reference window,
  a completed bounded drain, a normally finalized manifest, all scheduled revisit
  entries terminal, `pending = 0`, and no session-fatal condition (§B1).

**Why targeted rather than the passive cohort Phase 5J recommended.** Phase 5J
recommended a passive fixed-duration cohort and this is disclosed as a **scope
evolution**, not a contradiction. Methods-only structural evidence justifies it:
the complete passive shakedown produced 196 structurally valid references from
106 mints and **zero** otherwise-valid post-target two-source future candidates,
because same-mint Dex round robin is far slower than the frozen 300 s horizon. A
passive cohort would leave the frozen outcome primitive unresolved for
essentially every reference. The opt-in targeted revisit scheduler was built for
exactly this reason and is frozen at `2af26a8`.

## D2 — Reference selection

**Frozen: `ALL_ELIGIBLE_REFERENCES`.**

- Include **every** snapshot from eligible cohort-role sessions that satisfies
  the frozen reference-validity rules (`validationReason === null`).
- Invalid snapshots are **not** included in the supplied reference list.
- Deterministic ordering only: `sessionId` ascending, then full reconstructed
  `snapshotDigest` ascending.
- No thinning, no mint-level deduplication, no outcome-dependent membership.
- A duplicate `sessionId/snapshotDigest` identity is a hard error.
- Unit of analysis: **one reference = one valid (mint, reference time)**.
- Maturation-role sessions can never supply references.

Implemented by `selectAllEligibleReferences` / `collectAllEligibleReferences`.
The builder is read-only with respect to evidence and never inspects a price
direction, an outcome, a model score or a later token state.

## D3 — Primary analysis

**Frozen: `CONTINUOUS_RANK_ASSOCIATION`.**

| Element | Frozen value |
| --- | --- |
| Primary exposure | `crossSourcePriceRangeBps` (frozen snapshot feature, computed before the outcome) |
| Primary outcome | `absLogReturn300sBps` (`ABS_LOG_RETURN_300S_BPS_V1`) |
| Primary estimand | **Kendall's tau-b**, native tie correction |
| Analysis population | all D2 valid references |
| Availability denominator | all D2 valid references |
| Outcome denominator | **Policy-A resolved references only** |
| Missing outcomes | never imputed |
| Dependence | cluster bootstrap by **mint** |
| Bootstrap | **10,000** mint-level resamples |
| Interval | two-sided **95 % percentile** interval, Hyndman–Fan **type-7** quantile |
| PRNG | deterministic **SplitMix64** (BigInt), unbiased rejection sampling |
| Seed | outcome-independent, derived from the preregistration seal fingerprint |
| Multiplicity | exactly one primary exposure/outcome association |
| Minimum inferential floor | **≥100 resolved references AND ≥30 distinct resolved mints** |
| Below the floor | report descriptively only; no primary inferential claim |
| Degenerate | `<1000` defined bootstrap replicates ⇒ no interval |
| Policy B | the same analysis on the same frozen references, sensitivity only |

Seed derivation, frozen exactly:
`seed = SHA-256(canonical({ specVersion: 'R4-PRIMARY-TAU-B-V1', sealFingerprint, horizonMs: 300000, toleranceMs: 60000, referenceIdentities: sorted(D2 identities) }))`.
No price, return, direction, model score or outcome value enters the seed. The
reference identity set is sorted, so reference enumeration order cannot change it.

Kendall τ-b is computed directly, dependency-free:
`numerator = Σ_{i<j} sign(x_j − x_i)·sign(y_j − y_i)`,
`n0 = n(n−1)/2`, `n1 = Σ t_x(t_x−1)/2` (exposure ties), `n2 = Σ t_y(t_y−1)/2`
(outcome ties), `τ_b = numerator / √((n0−n1)(n0−n2))`, undefined when that
denominator is zero.

Allowed interpretation: association between measured cross-source price
disagreement and subsequent 300-second absolute movement magnitude.

Forbidden interpretation: direction, causality, profitability, predictive
trading edge, trading authority.

All other cross-source fields are secondary or exploratory.

Implemented by `kendallTauB`, `clusterBootstrap`, `percentileType7`,
`deriveAnalysisSeed`, `runPrimaryAnalysis` in
`scripts/market-outcomes/primary-analysis.mjs`.

## D4 — Stopping and replacement

**Frozen: `FIXED_REPLACEMENT_SESSION_RULE`.**

- Target: **6 completed eligible cohort sessions**.
- Maximum: **8 total cohort-session attempts**, indexes 1..8.
- Failed, incomplete, unfinalized or corrupt attempts **never** become cohort
  evidence.
- A failed attempt is replaced with **one** session using identical frozen
  capture parameters.
- Stop as soon as 6 eligible completed sessions exist; otherwise stop after
  attempt 8.
- If fewer than 6 completed sessions exist after 8 attempts, close the cohort
  with those completed sessions and disclose the shortfall. No further attempt.
- Replacement decisions must not depend on prices, outcomes, apparent effect,
  model output or apparent sample result.

Implemented by `buildCohortPlan` / `evaluateCohortProgress` in
`scripts/r4-cohort-plan.mjs`. Replacement linkage is mechanical: attempt `k>1`
carries `replacementOf = k−1` exactly when attempt `k−1` failed. No attempt has
been started.

## B1 — Reference-level missingness (frozen)

**Frozen: `E1_REFERENCE_LEVEL_MISSINGNESS`.**

An unserved R4 revisit reference is a **reference-level measurement failure**,
not automatically a session-level capture failure. A valid reference remains
part of D2 even when no admissible future observation is ultimately available.
The canonical outcome resolver, using authenticated source evidence, determines
the unresolved reason later. **Capture telemetry must not directly assign the
scientific outcome missingness category.**

Pending versus failed is frozen as follows:

- `pending > 0` after the complete bounded drain ⇒ **session fatal / incomplete**.
- `failed > 0` with `pending === 0` ⇒ **reference-level missingness only**; the
  session may remain complete.

A normal finalization deterministically expires/closes every due queue entry
before evaluating pending; no entry may silently disappear.

Session-fatal conditions (not weakened): manual signal/interruption; crash or
unfinalized source; storage bound reached; manifest/fingerprint/integrity
failure; an unhandled capture/provider exception that aborts collection; pending
revisit work after the complete bounded drain; scheduler invariant failure
(ledger inconsistency, an unrecognised failure code, an inconsistent empty-queue
next-time); corrupted or unauthenticated scheduler telemetry; sealed
configuration drift.

Terminal reference-level failures remain authenticated telemetry in
`revisit-scheduler.ndjson`: post-target Jupiter unavailable, Jupiter mint no
longer present, stale provider evidence, unavailable provider alignment, an
exhausted valid candidate window, or a completed request lifecycle that did not
yield admissible two-source evidence. They do not remove an otherwise valid D2
reference, do not make the whole session incomplete, and do not choose the
outcome missingness reason. `generateOutcomeRun` independently derives
`SOURCE_COVERAGE_GAP`, `NO_SAME_MINT_OBSERVATION_IN_WINDOW`,
`NO_VALID_FUTURE_TWO_SOURCE_OBSERVATION` or another already-frozen canonical
result. **No new outcome missingness code was introduced.**

Scope note: this decision changes the capture *exit gate* only
(`revisitExitFailure` now keys on pending work and scheduler invariants, not on
terminal reference failures) and adds a deterministic `invariants()` self-check
to the revisit queue. It preserves failure counts and codes, does not convert a
failed entry into a successful one, does not fabricate observations, and makes no
change to the primary outcome resolver.

## Maturation

**Frozen: `MATURATION_MODE = COHORT_DRAIN_ONLY`.**

- No separate maturation-role source is used.
- Each 45-minute `--r4-revisits` cohort session runs its normal bounded drain,
  sufficient by construction to cover the `+300 s` horizon and the inclusive
  `+60 s` tolerance for every reference it produced.
- Cohort sessions may supply future candidates to references (including across
  adjacent sessions, which is permitted but not relied upon).
- Only cohort-role sessions may supply D2 references.
- No maturation session counts toward the 8-attempt cap, because no maturation
  session exists.
- No separate maturation source may later be added without reopening this
  preregistration.

Mechanical basis: the capture loop remains alive while the revisit queue has
pending work, every valid snapshot in the reference window is scheduled, and the
drain closes each entry at `target + 360,000 ms`. Generation additionally
requires `createdAt ≥ referenceObservedAt + 360,000 ms`.

## Missingness

- `D_avail` (measurement availability) = all D2 valid supplied references.
- `D_out` (outcome analysis) = Policy-A resolved references only.
- Unresolved references are reported by frozen reason and never imputed:
  `SOURCE_COVERAGE_GAP`, `NO_SAME_MINT_OBSERVATION_IN_WINDOW`,
  `NO_VALID_FUTURE_TWO_SOURCE_OBSERVATION` (with exact candidate rejection
  counts), `REFERENCE_<reason>`, `NONFINITE_LOG_RETURN`.
- No single-source, GMGN, launch, interpolation, extrapolation, pre-target or
  extended-window fallback exists.

## Policy A and Policy B

- **Primary:** `POLICY_A_CONTENT_UNIQUENESS`. `generateOutcomeRun` always resolves
  under Policy A. `PRE_TARGET_PRICE_EVIDENCE` takes precedence; a same-provider
  raw **or** normalized digest match to the reference rejects the candidate as
  `REUSED_REFERENCE_PRICE_EVIDENCE`; cross-provider digest equality is not a
  reuse test; distinct flat evidence with zero movement is admissible.
- **Sensitivity only:** `POLICY_B_OBSERVATION_IDENTITY`, artifact mode
  **COMPUTE_ONLY**. It has no filesystem access, cannot select references and
  cannot overwrite a Policy A run. Any B report must disclose the trust
  assumption and the affected-reference count and can never replace the primary
  result.
- Outcome missingness is derived from evidence, never from capture telemetry
  (§B1).

## Frozen capture constants

| Constant | Value |
| --- | --- |
| Primary horizon | 300,000 ms |
| Resolution tolerance | 60,000 ms (inclusive window `[target, target+60000]`) |
| Contributor freshness budget | 60,000 ms (Jupiter, DexScreener) |
| Alignment | 15,000 ms |
| Dex revisit safe start | `target + 60,000 − (timeout + spacing + 5,000)` = `target + 45,800 ms` at defaults |
| Session storage cap | default 512 MiB, whole-MiB clamp 64–2048, 16 KiB finalization reserve |
| Dex request budget | 6 per 30 s provider cycle; targeted work precedes passive work |

## Excluded methods evidence

No methods-only session may be promoted into the real R4 cohort:

| Session | Classification |
| --- | --- |
| `1790507032018-6854248b-5e29-49fc-9dec-aef8ab398593` | Phase 5J.1 S1 passive storage-bound shakedown; incomplete, `capture failed` |
| `1790523432292-82b204a2-75b8-49fd-92a6-c51e6a9370ca` | Phase 5J.1 S2 passive methods shakedown; duration-complete, pre-R4 |
| `1790579084231-1b57d644-fbbe-4ccc-9b6e-62aff585a4ee` | First R4 revisit methods shakedown; incomplete coverage, non-R4 |
| `1790584852634-6265dffb-c23a-45fd-9d74-ec03a18f76a3` | Aborted zero-reference launcher incident; source-ineligible, non-R4 |
| `1790585177858-ac3ca9df-85a4-4bf8-806c-c91045f92883` | Second valid R4 revisit methods shakedown; incomplete coverage, non-R4 |

The aborted launcher was torn down after about 30 seconds; it had zero revisit
references and zero valid two-source snapshots. It is a process incident, not
scientific outcome evidence. S1 exposed the 64 MiB storage cap; Phase 5J.1 raised
the default to 512 MiB.

## Process notes and disclosures

- **Policy A/B freeze.** Policy A remains primary; Policy B remains a
  compute-only sensitivity. Neither was reopened.
- **E1 (B1) semantics change.** The capture exit gate previously treated any
  terminal reference-level revisit failure as a session-level `capture failed`.
  That made a `--r4-revisits` session structurally ineligible under the frozen R4
  source policy, so the D1 target of six completed eligible sessions was
  unattainable. The frozen E1 rule above corrects this. Terminal failures and
  their counts remain visible in the authenticated telemetry and in the finalize
  record, and the outcome missingness category is derived from evidence by the
  resolver. Session-fatal conditions were not weakened.
- **24 hours is not prior authority.** Any earlier mention of a 24-hour capture
  was never established by a committed R4 authority. D1 fixes 45-minute
  sessions; a 24-hour capture is not part of this protocol.
- **Phase 5J passive recommendation.** Disclosed above as a scope evolution
  justified by methods-only structural coverage evidence, not as a resolved
  scientific conflict.
- **Stale/scoped process wording.** The second shakedown completion record states
  that the P3-C policy choice was "the only remaining decision" before R4
  preregistration. That wording is scoped to the live revisit scheduler and is
  now stale: P3-C was frozen at `44f02fa` and locked at `aa71894`, and cohort
  design, reference selection, primary analysis, B1 and maturation remained open
  after it. It is treated as scoped process wording, not global R4 authority. No
  historical governance record was rewritten.
- **Directory-mtime observation — `AUTHORITY_NOT_FOUND`.** An observation that a
  `.evolve` directory's modification time may have been altered was reported to
  the authoring process outside the repository. No authoritative record of this
  observation was located: it appears in no committed document, no governance
  seal, no shakedown authorization or completion record, no governance
  run/review artifact, and no commit message in the available history. Its date,
  affected directories, cause, and whether any file *bytes* changed are therefore
  unknown, and no classification of it — including "no evidence impact" — can be
  attributed to repository authority. Because the EVOLVE evidence chain
  authenticates *content* (per-file SHA-256 and canonical fingerprints) rather
  than directory mtimes, an mtime-only change would not alter any authenticated
  evidence digest; however this is a general property of the integrity design and
  is **not** a verified finding about this specific observation. This note records
  the uncertainty only. No scientific-evidence impact is asserted.
- **Storage headroom.** At observed methods-only volume (~9–11 MB/min in targeted
  mode, GMGN disabled) a 45-minute session uses roughly 77–88 % of the default
  512 MiB cap. Provisioning the cap higher (64–2048 MiB) is a configuration-only
  change and alters no science; a session that does reach the bound finalizes
  `incomplete` and is governed by §D4.

## Authority

Every R4 row, summary, manifest and analysis record carries
`developmentOnly = researchOnly = paperOnly = observerOnly = true`,
`tradingAuthority = engineAuthority = arenaEligible = promotionEligible = false`
and `profitabilityInferencePermitted = false`. R4 has zero trading authority and
computes market outcomes only.
