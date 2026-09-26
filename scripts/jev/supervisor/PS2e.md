# Phase 5I-PS.2e — Temporally distributed Local Tev supervisor shadow

Research/evidence semantics: yes

DEVELOPMENT SHADOW • ZERO AUTHORITY. Paper only, shadow only, development evidence
only. PS.2e grants no trading, selection, evolution, Arena, deployment or
authority-promotion right to anything, and it is never canonical, replication or
temporal evidence. Protocol review is required before completion. The implementer
role cannot certify its own work: IMPLEMENTER CANNOT SELF-CERTIFY.

## Goal

PS.2d proved that the unchanged passive engine tap can hand a bounded,
deterministic, prospectively frozen sample of GENUINE EVOLVE production entry
proposals to a supervisor without changing production selection, execution,
genomes, fitness, evolution, the Arena, Jev direction evidence, replication or
temporal evidence. PS.2d answered the sampled proposal through the direct TypeSafe
Jev provider with a `noul` probability question.

PS.2e answers two infrastructure questions that PS.2d deliberately left open:

1. Can the supervisor's decision boundary be moved from the direct TypeSafe Jev
   provider to the SHARED Local JEV decision router (`decision ask`, mode
   `local-first`, caller `evolve`) that the developer already runs on this
   machine, without EVOLVE modifying, vendoring or reimplementing any part of
   that shared stack?
2. Can the generic local decision model be replaced by a Tev-style SPECIALIZED
   option-token classifier, and can the run be distributed across a precommitted
   temporal schedule (12 five-minute buckets, at most 10 admissions per bucket,
   at most 120 admissions per run) so that the shadow is not a single
   instant-bound sample?

PS.2e does not ask whether the classifier is correct, profitable or better than
EVOLVE, emits no winner, resolves no outcome, and never generalizes a supervised
answer into direction, replication or temporal evidence.

PS.2e must be honest about what it can and cannot do. At precommit time the
shared stack's own documentation recorded that the Tev-style specialist
(`togethercomputer/Tev1-4B-experimental`) had NO published GGUF and that the
generic NobodyWho tiers remained the configured local models, so the protocol as
precommitted DECLARED the specialized primary classifier UNAVAILABLE and refused
to start (exit code 2) rather than silently swap in a generic local model
(`PS2E_MISSING_LOCAL_JEV_INTERFACE` retains that historical record). The shared
installation now exposes a genuine Tev-style specialist of its own (fine-tuned
Qwen3-0.6B, exported GGUF, provenance manifest), so the pin is enabled against it
with a pinned artifact SHA-256, and readiness verifies that exact identity before
any call. The fail-closed path is unchanged: any identity mismatch still refuses
primary attribution and a generic local model is still never substituted.

## Architecture

Ordering: production decision/proposal finalized → copied immutable shadow facts →
normal engine continues (paper execution attempt) → asynchronous PS.2e shadow
observes the copied facts → the copied facts enter a precommitted temporal bucket →
at most one bounded admission per eligible opportunity → the shared Local JEV
stack classifies → one bounded NDJSON record per ADMITTED observation. Nothing the
shadow returns is consumed by the engine. The thirteen parts below are frozen
before any live PS.2e run.

### 1. Genuine production opportunity (unchanged PS.2d boundary)

PS.2e does NOT add a second tap. It reuses the exact PS.2d passive engine tap
`observeProductionEntry` in `stepAgent` (`scripts/engine/simulation.mjs`) after
`ctx.bestScore = bestScore` and immediately before `openPosition(agent, best,
ctx)`. `scripts/engine/simulation.mjs` is NOT modified by PS.2e: the same tap
dispatches to whichever shadows the observer attached. The genuineness boundary
(`validateGenuineProductionEntry`) is literally the PS.2d implementation, imported
unchanged from `cross-asset-packet.mjs`, so source marker
`PRODUCTION_ENTRY_PROPOSAL`, action `ENTER_LONG`, selection marker
`PRODUCTION_BEST_SCORE`, `gateAssessment.passes === true` with an empty
`failedGates`, finite score and threshold with `score >= threshold`, a market
object, and NO key matching `counterfactual` are all still required. A PS.2e
opportunity is exactly a genuine PS.2d production entry proposal; a PS.2e-only
event classification would be a second definition and is forbidden.

### 2. Temporal admission scheduler (`local-tev-scheduler.mjs`)

A single frozen scheduler assigns every eligible opportunity to exactly one
bucket. Bucket index = floor((opportunityEpochMs − runStartedAtMs) / 300000) for
opportunity time inside the frozen 3600000 ms window; anything before the window
or at or after it is `suppressedOutsideWindow`. The scheduler is a pure function of
`{ identity, opportunityDigest, atMs }` and nothing else: no score, no latency, no
prior decision, no confidence, no market direction and no outcome can reach it, and
`Math.random` and `Date.now` appear nowhere in the module. Within one engine tick
(keyed by `generation` + `generationTick`) the buffered entries are processed in
ascending opportunity-digest order — never population, fitness or encounter order —
so a past fitness rank cannot decide which same-tick opportunity wins a cooldown or
the last bucket slot. Suppression precedence, first match wins:

1. `outside_window`;
2. `duplicate_opportunity_digest` — the digest was already admitted;
3. `per_asset_cap` — the asset already has the per-asset maximum admitted;
4. `asset_cooldown` — `proposalAt − lastAdmittedAt(asset)` is below 60000 ms
   (engine time, not wall clock);
5. `bucket_cap` — the owning bucket already has 10 admissions;
6. `global_cap` — the run already has 120 admissions;
7. otherwise ADMITTED.

Bucket quota is per bucket: a full bucket never borrows another bucket's quota and
a late-arriving opportunity is still decided by its OWN bucket's quota. Under the
frozen profile the global ceiling equals 12 × 10, so the global-cap branch is
unreachable by construction and retained only as defence in depth; a scaled test
profile exercises it deterministically. The scheduler produces a temporal coverage
report (per-bucket eligible/admitted/uniqueAssets rows, empty buckets, buckets at
cap, the admission span and the share of admissions inside the first 300 seconds)
with `temporallyRepresentative: null`, `representationClaim: "none"` and
`temporalRepresentativenessClaimed: false`: the run reports coverage, and never
claims a temporal generalization.

### 3. Opportunity packet v2 and temporal provenance (`local-tev-packet.mjs`)

The model-visible packet is PS.2d's whitelisted value domain plus ONLY two
additions: a `packetVersion: 2` shape and the observer-assigned provenance
`engineTick` and `opportunitySequence`. The genuineness rules, asset identity
(`baseMint` = selected market mint, `quoteMint` = the USDC numeraire,
`marketId = <baseMint>/<quoteMint>`, symbol descriptive only) and the schema
ineligibility order (`invalid_base_mint`, `base_equals_quote_numeraire`,
`synthetic_market`, `market_not_fresh`, `invalid_reference_price`,
`invalid_liquidity`, `invalid_proposal_time`, `missing_market_observed_at`,
`observed_after_proposal`, `missing_agent_identity`, `non_finite_feature`,
`packet_audit_failed`, `packet_build_error`) are the PS.2d ones. The temporal
scheduling block is attached ONLY after admission, by
`attachTemporalProvenance`, which returns a new object and never mutates the
pre-admission packet, so the pre-admission content key is stable regardless of when
a tick is flushed. Every packet passes the PS.2d audit (`auditCrossAssetPacket`)
plus `packetValueProblems`, so no outcome, future, forward, horizon, realized, pnl,
profit, return, fill, execution, proceeds, counterfactual, exitPrice or settle KEY
can exist and every value stays in the finite-number/string/boolean/null domain.

### 4. Two deterministic digests

`opportunityDigest` is the digest of the packet BEFORE scheduling provenance is
attached: it is the content key for duplicate suppression and for the within-tick
ordering rule. `jevInputDigest = digestOf({ protocol, classifier identity and
configuration, routing configuration, questionSetId, questionSetVersion,
questionId, question, options, allowAbstain, abstainDescription, risk, sampling,
classifierConfig, packet, limitations })` is the digest of the COMPLETE
model-visible payload AFTER provenance is attached: every model-visible value
(`risk`, the question id and text, every option description including the
reserved ABSTAIN description) and every setting that materially alters the
inference request is inside it. The `sampling` block is the EFFECTIVE
model-inference settings per shared decision-tier slot (samples, seed,
temperature, n_ctx, early_stop, use_gpu, cpu_fallback), resolved with the SAME
precedence semantics as the shared Local JEV configuration (`local` without the
model identity, deep-merged with each tier's own block, then the shared
defaults) and coerced exactly like the shared provider constructor
(`int(...)` / `float(...)` / `bool(...)`; `early_stop` is disabled only by a
literal `false`, the shared `is False` check). The projection carries EFFECTIVE
values only: tier overrides, inherited `local` values and omitted defaults that
resolve to the same effective settings produce the SAME `sampling` projection —
raw config syntax is never digested as inference behavior, and a materially
different effective request always changes `jevInputDigest`. There is no
partial-state digest and no volatile-field exclusion; any model-visible change
changes `jevInputDigest`, and byte-equivalent canonical payloads reproduce it.
The persisted `modelInputDescriptor` (the complete input minus the packet, which
the record stores in full) carries these effective settings, so
`jevInputDigestFromEvidence()` recomputes the exact digest from stored evidence
alone, without consulting today's mutable Local JEV configuration.

Float-valued settings use `sharedFloatCoercion`, an exact mirror of the pinned
router's Python `float(...)` measured on the router's own interpreter:
`true`/`false` are 1.0/0.0, finite numbers are kept (`-0.0` is normalized to 0),
and strings follow Python's float grammar (Python whitespace around the numeral
— not JavaScript's `trim()` set, so U+FEFF is refused — an optional sign,
underscores only BETWEEN digits in the mantissa and the exponent, optional
fraction and exponent): `"0.2_5"` is 0.25 while `"_0.25"`, `"0__25"`, `"0_.25"`
and `"1e_1"` are refused exactly as Python raises. Three classes fail CLOSED
where Python would still produce a value: a non-finite result (`"nan"`, `"inf"`,
`"1e309"`; the shared router has no finite check for temperature, but
canonical-JSON evidence cannot represent it), a JSON number beyond the binary64
range (an integer literal makes Python raise, a float literal becomes inf, and
the parsed value cannot tell them apart), and non-ASCII numerals (Unicode
decimal digits, never guessed). The effective temperature is therefore the
router's own value (`true` is 1, `"0.7_5"` is 0.75), never null for an
accepted value, and `0.25`, `"0.25"` and `"0.2_5"` produce the same effective
projection. The effective acceptance block is resolved the same way
(`min_stability`: `float(...)` then [0, 1]; `min_margin`: `int(...)` then
>= 0; `escalate_on_abstain`: Python `bool(...)`; omitted keys take the shared
defaults), since `min_stability` / `min_margin` are also the worker's early-stop
thresholds.

### 5. Specialized option-token question set (`local-tev-questions.mjs`)

The PS.2d question set (`jev-cross-asset-production-proposal-v1`, a `noul`
probability question) is not reused or modified. The new set is
`jev-cross-asset-production-opportunity-tev-v1` with a single question and exactly
two grammar-constrained option tokens, `support` and `do_not_support`, plus the
reserved protocol outcome `ABSTAIN` delivered through `allow_abstain`. Option ids
obey the shared contract (`^[a-z][a-z0-9_]{0,47}$`, `ABSTAIN` reserved) and the
token grammar is the shared implementation's. There is NO probability field: the
classifier reports an option vote share (`sample_stability`) that is explicitly NOT
a probability, and `pSupport` does not exist in this question set or this evidence
class. `ABSTAIN` is a protocol OUTCOME, never converted into a binary stance;
`do_not_support` is never flipped. The question text and the response semantics
are scanned for probability and future/outcome/profitability language.

### 6. Shared Local JEV client (`local-jev-client.mjs`)

The ONLY decision path is the shared Local JEV CLI invocation
`decision ask --mode local-first --caller evolve` with one JSON request object on
stdin and one JSON object on stdout. EVOLVE does not vendor, modify, fork or
reimplement the shared stack; PS.2e reads a read-only projection of the shared
configuration (mode, tier models and their configured sha256, acceptance policy,
local sampling settings) that never includes an absolute model path, and it
forwards a MINIMAL child environment built from an allow-list with every
secret-shaped variable dropped. The request is built to the shared contract
(`id`, `question_id`, `state` ≤ 16000 characters, `question` ≤ 1000, `choices`,
`allow_abstain`, `risk`) and an over-long state is refused LOCALLY with NO call and
NO logical-call accounting. Readiness is computed before any call and fails closed
with distinct statuses: `READY`, `PRIMARY_CLASSIFIER_UNAVAILABLE`,
`PRIMARY_IDENTITY_MISMATCH`, `LOCAL_JEV_UNAVAILABLE`, `LOCAL_JEV_CONFIG_INVALID`,
`LOCAL_JEV_ATTEMPT_CEILING_EXCEEDS_PS2E_BOUND`,
`LOCAL_JEV_TIMEOUT_BOUND_EXCEEDS_PS2E_BOUND`. The shared stack owns tiers, retries
and escalation; PS.2e adds no second retry policy (`retriesAddedByPs2e: 0`) and
makes exactly one logical call per admitted observation, bounded by
`PS2E_LOGICAL_CALL_TIMEOUT_MS = 180000` which the readiness check requires to be at
least the shared stack's derived worst case. `acceptance.max_local_retries` is
normalized EXACTLY as the shared Local JEV normalizes it
(`acceptance.Policy.from_config`: Python `int(...)`, then `0..3`): `"3"` is 3
retries, `1.5` is 1 retry, `true` is 1, a missing key is 0, and anything the
shared parser would refuse (null, `"1.5"`, negatives, values above 3,
non-numeric strings) makes the shared router error on EVERY call — readiness
reports `LOCAL_JEV_CONFIG_INVALID` and fails closed, never a silent zero.
The integer-string LEXICAL mirror (`sharedIntegerValue`, used by
`max_local_retries`, `min_margin`, `samples`, `seed` and `n_ctx`) strips
leading/trailing whitespace EXACTLY as the pinned interpreter's `int(...)`
strips it — the measured Python whitespace set shared with the float mirror
(`stripPythonWhitespace`), never JavaScript's `trim()` set. Concretely: a
U+FEFF-wrapped integer (`"\uFEFF3"`, `"3\uFEFF"`, `"\uFEFF3\uFEFF"`) is
refused exactly as the pinned `int("\uFEFF3")` raises — the pre-fix `trim()`
fail-open (which made EVOLVE report READY with a fabricated effective integer
while the pinned router returned `router_error` on every call) is closed;
U+0085-wrapped integers coerce exactly like the pinned Python (U+0085 IS its
whitespace, so it is parity, NOT a conservative divergence); U+001C–U+001F
are refused exactly as the pinned `int(...)` raises on them. EVOLVE does NOT
claim universal Python `int(...)` equivalence: it supports the Python-compatible
integer domain only where the result is exactly representable as a JavaScript
safe integer (|n| <= 2^53 - 1 = 9007199254740991), and inside that domain the
effective value is the pinned `int(...)` value exactly (booleans 1/0,
truncation toward zero, underscores between digits, the field bounds
unchanged). Exactly TWO conservative fail-closed differences remain, both
reported as `LOCAL_JEV_CONFIG_INVALID` before any call: (1) a string of
non-ASCII decimal digits (e.g. `"٣"`) is refused even though the pinned
`int(...)` accepts it — the two runtimes' Unicode digit tables need not agree;
(2) an effective integer outside the safe-integer range is refused even though
Python keeps it exactly — an integer string (`"9007199254740992"`), a JSON
integer literal Python's `json` keeps exact but `JSON.parse` would round
(`9007199254740993`), an integral float such as `1e20`, or a literal beyond the
float range. Such a value is never rounded, persisted or digested, so no
accepted configuration can carry an integer that differs from the pinned one;
refusal can never create false readiness or evidence. A safe integer can still
exceed the NobodyWho runtime's own u32 limit for `seed` / `n_ctx` (>= 2^32):
the shared build accepts it and every call on that tier then fails inside the
worker, recorded as an honest failure — EVOLVE adds no u32 check (a documented
runtime limitation, not a coercion-parity difference).
Every other numeric setting the shared router's BUILD coerces on every call
(`sharedRouterBuildProblems`: the `local` provider, which local-first still
builds; TypeSafe `float(timeout_s)` when enabled; both decision tiers'
`1 <= int(samples) <= 15`, `float(temperature)`, `int(seed)`, `int(n_ctx)`,
`float(timeout_s)` and, for a persistent worker, `float(idle_timeout_s)`; the
acceptance `min_stability` / `min_margin` ranges) is mirrored the same way: a
value the shared build refuses would make every call a `router_error`, so
readiness reports `LOCAL_JEV_CONFIG_INVALID` — a refused value is never
normalized and an accepted one never replaced by a default. Tier timeouts are
coerced with the same `float(...)` mirror (`"200"` is 200 s, so the worst case
is never understated by a silent fallback). The
router theoretical worst case is computed from each tier's EFFECTIVE timeout
after the shared configuration's inheritance and defaults are resolved (an
omitted `timeout_s` inherits `local`, then the shared defaults), multiplied by
`1 + normalized max_local_retries` per tier, plus the TypeSafe fallback's own
effective timeout when the shared system enables it; readiness reports the
three distinct bounds (router theoretical worst case, EVOLVE child hard
timeout, PS.2e finalization budget) and fails closed when the worst case
exceeds the frozen bound. The physical-attempt ceiling is derived from the
SHARED router's exact local-first semantics: the router always iterates its
fixed decision-tier slots (tier 1 primary, tier 2 escalation), a model-configured
slot consumes up to `1 + normalized retries` physical attempts, an unconfigured
slot records exactly one failed physical attempt when reached, and the optional
TypeSafe fallback adds one — at most 9 per logical call and at most 120 × 9
physical attempts per run. Readiness fails closed with
`LOCAL_JEV_ATTEMPT_CEILING_EXCEEDS_PS2E_BOUND` if that derived ceiling ever
exceeds the frozen maximum; the bound is never grown for a permissive config.
The `jev.enabled` default is aligned with the pinned shared semantics (omitted
means disabled; only a literal `false` disables — the shared `is not False`
identity check), so readiness can never disagree with the shared router about
the fallback tier. A truncated stdout capture (beyond 1 MiB) is MALFORMED and is
never parsed or accepted; stderr truncation is non-authoritative. On timeout or
finalization the request's own process group (child and any grandchild) is
terminated — scoped to that request's tree only — and the shared configuration
override (`DECISION_ROUTER_CONFIG_DIR`) resolves the SAME config for readiness and
for the spawned child. `EVOLVE_LOCAL_JEV_BIN` is normalized once: a whitespace
override falls back to the documented default (`decision`) in both readiness and
the spawn target.

### 7. Specialized classifier identity, availability and no substitution

The primary classifier pin (`PS2E_PRIMARY_CLASSIFIER`) declares a Tev-style
specialized option-token classifier: runtime and provider `nobodywho`, mode
`local-first`, primary tier `1`, `classifierKind:
specialized-option-token-classifier`, `classifierFamily: tev-style-specialist`,
grammar-constrained option tokens true, thinking OFF, abstain a protocol outcome.
The shared stack now exposes a genuine Tev-style specialist of its own
(fine-tuned Qwen3-0.6B, exported GGUF, provenance manifest), so the pin declares
`available: true` with `pinnedModel: local-jev-tev-specialist-v1` and a pinned
artifact SHA-256 (`4b3fbb5e8ca29bca4e6982ff1cad49b7b2a9d0039241fad19bd474c7cdffc348`);
the precommit enumeration of the then-missing shared interface is retained as a
historical record (`PS2E_MISSING_LOCAL_JEV_INTERFACE`), never as a current claim.
The pin also records a DEVELOPMENT provenance field
(`localJevCompatibilityBaseline`, the shared Local JEV source state this
integration was completed against): the shared CLI exposes no repository commit
identity, so this baseline is provenance only and is never a runtime
requirement. Runtime identity authority comes from the shared Local JEV itself
and is verified on EVERY accepted primary answer: the LIVE policy requires the
complete verified identity contract — `classifierId`, `classifierFamily`,
`classifierKind`, tier `1`, `thinkingEnabled: false`, the Local JEV positive
verification status `verified`, `verifiedBy: loaded_artifact_digest`, and both
`observedSha256` and `expectedSha256`. The live gate requires
`observedSha256 == expectedSha256 == pinnedModelSha256`, the pinned model name,
and no router-reported identity mismatch. Missing identity or attestation
evidence, an untrusted verification source, a non-verified status, or a validly
typed digest disagreement is `PRIMARY_IDENTITY_MISMATCH`; structurally malformed
identity or attestation fields are `MALFORMED`. Nothing is ever guessed from a
model-name string alone. Only the validation-only fixture policy
(`validationOnly: true`) keeps the historical offline compatibility semantics
for older fixture responses without the hardened fields, and that compatibility
path can never apply to a live policy. A fail-closed policy self-check runs
before EVERY call:
`SKIPPED_POLICY_INVALID` when the policy could substitute a generic model, think,
fall back to a remote provider, fail open or exceed its bounds. A primary-tier
answer whose model identity is not the precommitted primary classifier is recorded
as `PRIMARY_IDENTITY_MISMATCH` with its REAL provenance, never as a primary result.
The validation-only classifier policy (`PS2E_VALIDATION_CLASSIFIER_POLICY`) exists
solely to exercise the machinery offline in the validator; the CLI is wired only to
the frozen pin and never to the validation policy.

### 8. Escalation and fallback provenance (no fake numbers)

The shared implementation is the authority on what happened. `classifyLocalJevOutcome`
records the REAL route: `PRIMARY_TEV_CLASSIFIER`, `ESCALATED_LOCAL_TIER`,
`FALLBACK_TYPESAFE_JEV`, `ABSTAINED_WITHOUT_ACCEPTED_TIER`,
`PRIMARY_IDENTITY_MISMATCH`, `MALFORMED`, `FAILED`, `UNAVAILABLE`, or a
`SKIPPED_*` disposition. Escalation to a second local tier, fallback to the
TypeSafe Jev tier and abstention are each recorded with their tier, provider,
model, reason and attempt counts. A grammar-constrained local vote share stays
labelled `sample_stability`; ONLY a shared-reported calibrated number from the
TypeSafe fallback tier is labelled `calibrated_probability`; where no number exists
the kind is `none` and the value is null. `probabilities` stays null for every
local vote. `typeSafeIsNormalProvider` is false: TypeSafe is a fallback tier here,
never the normal provider.

Route attribution is fail-closed against contradictory provenance. For LIVE
`PRIMARY_TEV_CLASSIFIER` attribution every authoritative field the shared router
exposes must agree: `decision_source`, the top-level tier, `decision.provider`,
`decision.model`, the verified classifier-identity contract, and the accepted
specialist attempt's provider / model / tier / role (the genuine route coherently
describes tier `1`, role `specialist`, provider `nobodywho`, model
`local-jev-tev-specialist-v1`). A structurally valid but contradictory provenance
(a decision provider/model that contradicts the accepted attempt or the
precommitted pin) is `PRIMARY_IDENTITY_MISMATCH` and never primary; a
structurally malformed one is `MALFORMED`. The shared local-first protocol admits
exactly ONE authoritative accepted attempt, so every attempt whose semantics
indicate acceptance is collected and checked: an earlier accepted attempt that
contradicts a later one, or any duplicate accepted attempt at all, is a
coherently impossible record and `MALFORMED` — the record is never silently
reduced to the last accepted attempt, and a `skipped` record is never accepted.
Decision, `follow`, the accepted attempt's choice, the abstain flags and
`abstain_reason` metadata, a top-level `abstained` flag when one is exposed and
the router's `decision_source` must describe ONE result: `SUPPORT` /
`DO_NOT_SUPPORT` never simultaneously claim abstention, `ABSTAIN` never carries
an accepted binary attempt, and `ALL_AVAILABLE_TIERS_ABSTAINED` never carries an
accepted binary result. Any contradiction is `MALFORMED`, and a malformed record
never retains a binary decision. Genuine tier-2 generic escalation is not
weakened by these checks: a coherent escalation is still `ESCALATED_LOCAL_TIER`.

### 9. Circuit breaker, queue and worker

A bounded PS.2e queue (capacity 120 under the frozen profile, capacity 2 under the
offline validation profile used only to prove queue-full safety) drops explicitly
with a counted `queue_dropped` record and never blocks the engine. A DEDICATED
PS.2e worker loop drains it sequentially so a slow PS.2e call cannot delay, or
cause drops in, the PS.2 / PS.2a observer work. A circuit breaker opens after 5
consecutive failures for 120000 ms; items dequeued while open are recorded
`SKIPPED_CIRCUIT_OPEN` with NO call, and one half-open probe is allowed after the
cooldown. Final flush: the tap stops admitting; an in-flight call is recorded
`IN_FLIGHT_AT_FINALIZE` and its late answer is ignored; still-queued items are
drained WITHOUT a call and recorded `UNSENT_AT_FINALIZE`.

### 10. Accounting and logical-vs-physical separation

Counters include `received`, `nonGenuineRejected` (by reason),
`genuineProductionOpportunitiesObserved`, `schemaEligible`, the six suppression
counters, `admitted`, `queuedForLocalJev`, `queueDropped`, `processed`,
`logicalCalls`, the route counters, `failures`, `malformed`, `unavailable`, every
`skipped*` counter, `unsentAtFinalize`, `inFlightAtFinalize`,
`lateCompletionsIgnored`, `physicalLocalAttempts`, `physicalFallbackAttempts` and
`totalPhysicalAttempts`. Identities, each reported as a boolean that must hold:

- received = nonGenuineRejected + genuine + buffered (not-yet-sampled tick) +
  tapErrorsUnaccounted
- genuine = schemaEligible + schemaIneligible
- schemaEligible = six suppressions + admitted
- admitted = queuedForLocalJev + queueDropped
- queuedForLocalJev = processed + unsentAtFinalize + queue depth
- processed = logicalCalls + every `skipped*` counter
- logicalCalls = primaryResults + primaryIdentityMismatch + escalatedResults +
  fallbackResults + abstainedWithoutAcceptedTier + failures + malformed +
  unavailable + inFlightAtFinalize
- totalPhysicalAttempts ≤ logicalCalls × physicalAttemptCeilingPerLogicalCall
- logicalCalls ≤ profile global maximum

`ABSTAIN` is counted once and is explicitly cross-cutting (`abstainIsCrossCutting`),
and the per-asset `unavailable` counter is explicitly descriptive rather than a
partition (`perAssetUnavailableIsDescriptive`), so the identities are honest about
what they do and do not prove.

### 11. Latency telemetry (measured only)

Per logical call PS.2e records the observer clock, queue wait, packet build,
local-client dispatch, shared-reported latency, primary attempt, escalation,
fallback and end-to-end, grouped separately as `allLogicalRequests`,
`primaryTevResults`, `escalatedLocalResults` and `typesafeFallbackResults`, with
count/mean/p50/p95/p99/min/max by nearest rank. A measurement the shared runtime
does not expose (`nobodyWhoDispatchMs`, `classifierInferenceMs`, `inputTokens`,
`outputTokens`) is reported as null and listed in `unavailableMeasurements`, never
as zero. No latency target is an acceptance criterion
(`performanceTargetIsAcceptanceCriterion: false`).

### 12. Evidence class, bounded storage and zero authority

The evidence class is `DEVELOPMENT_CROSS_ASSET_TEV_SUPERVISOR_SHADOW` with
`developmentOnly`, `paperOnly`, `shadowOnly`, `noProfitabilityInference`,
`noTradingInference`, `noDeploymentInference`, `noAuthorityPromotion` all true and
`canonical`, `replication`, `temporalReplication`, `predictiveEvidence`,
`outcomeResolved`, `automaticPromotionPermitted` all false. It never reuses the
PS.2d class `DEVELOPMENT_CROSS_ASSET_SUPERVISOR_SHADOW`. Per-observation storage is
one bounded NDJSON line per ADMITTED observation only
(`local-tev-observations.ndjson`), written beneath the session's own root. Every
record passes `auditNoForbiddenResultFields`, contains only finite numbers, and
carries no probability when none exists. Each record persists its bounded,
pre-response `modelInputDescriptor` (the complete digested input minus the packet,
which the record already stores in full), so `jevInputDigest` is independently
recomputable from stored evidence alone; no secret and no post-response field is
in it. A record whose provenance is MALFORMED never carries a directional or
support decision: malformed evidence is recorded as MALFORMED with its honest
failure reason. The shadow exposes no mutation surface: `observeProductionEntry`
returns undefined, and there is no setter, approval, rejection or veto method.

### 13. Live run protocol (prepared, NOT executed in this phase)

CLI flag `--local-tev development` (absent = PS.2e disabled, prior behaviour),
mutually exclusive with `--cross-asset`, and requiring at least 60 minutes. The
CLI validates the Governance v1 external-call policy, computes the shared-stack
projection and readiness, and REFUSES TO START with exit code 2 whenever the
precommitted primary classifier is unavailable or its identity does not match
the pin (enumerating the problems, and the historical missing-interface record
only when the current failure IS a missing specialist interface, clearly labelled
as the historical precommit-time record).
With the verified Tev specialist now registered in the shared Local JEV, that
readiness gate passes and a live run would start — but NO live PS.2e session is
run in this phase: the run protocol is prepared and awaits independent
Governance certification. A generic model is never substituted for the Tev-style
specialist. No commit, no push, no canary.

## Files / scope

- `scripts/jev/supervisor/PS2e.md`
- `scripts/jev/supervisor/local-tev-protocol.mjs`
- `scripts/jev/supervisor/local-tev-scheduler.mjs`
- `scripts/jev/supervisor/local-tev-packet.mjs`
- `scripts/jev/supervisor/local-tev-questions.mjs`
- `scripts/jev/supervisor/local-jev-client.mjs`
- `scripts/jev/supervisor/local-tev-observer.mjs`
- `scripts/jev/supervisor/observer.mjs`
- `scripts/jev/supervisor/summary.mjs`
- `scripts/jev/supervisor/storage.mjs`
- `scripts/jev/supervisor/dashboard.mjs`
- `scripts/jev/supervisor/definition.mjs`
- `scripts/jev/supervisor/settings.mjs`
- `scripts/jev-supervisor.mjs`
- `scripts/validate-phase5i-ps2e.mjs`
- `scripts/validate-phase5i-ps2.mjs`
- `package.json`
- `src/app/page.tsx`

`scripts/engine/simulation.mjs` is deliberately NOT in scope: PS.2e reuses the
unchanged PS.2d tap and adds no engine line. `scripts/validate-phase5i-ps2.mjs`
changes only its package-script assertion (so `validate:jev-supervisor` must run
the PS.2, PS.2d and PS.2e suites) and its process-capability scan (the PS.2e
Local JEV client is the ONE child-process boundary: frozen argv, no command
interpreter, allow-listed environment, hard timeout; every other module stays
fully covered by the original scan). The shared Local JEV stack (the
decision-router installation on this machine, outside this repository) is
read-only and is not part of this repository or this scope.

Protected paths: `.evolve/jev-direction/`, `.evolve/jev-paper-shadow/`, `.evolve/jev-paper-forensics/`, `.evolve/jev-supervisor-observer/`, `.evolve/shadow/`, `.evolve/arenas/`

PS.2e declares no intended write to any protected path. Validation writes only to
temporary directories.

## Global Constraints

Global Constraints digest: d196aaaf46bd22e8a3e3ffb1f9fd2c3096b476426be7598aad492533da66eb94

1. PAPER ONLY unless a separately approved phase explicitly says otherwise.
2. No wallet, signer, swap, order, real-money or write-RPC functionality may be introduced by ordinary development work.
3. Canonical/replication/temporal evidence is immutable.
4. No lookahead.
5. No result-driven parameter tuning.
6. No profitability claim from development/shadow evidence.
7. No weakening of gates/tests/protocols to manufacture a positive result.
8. AI outputs cannot self-certify scientific validity.
9. Arena / untouched future data remains authoritative.
10. Experimental AI components remain shadow/passive until evidence explicitly justifies another authority level.
11. External AI/API calls must be bounded.
12. Failures must fail closed where evidence integrity is concerned.
13. Existing repo attribution must not be modified unless explicitly requested.
14. No AI assistant/co-author attribution.
15. No AGENTS.md or CLAUDE.md.

All fifteen canonical constraints of `scripts/governance/definition.mjs` apply.
PS.2e changes no gate, threshold, genome, score or selection rule, adds no
wallet/signer/swap/order/write-RPC capability, bounds every external call to one
logical local call per admission under a hard timeout with a circuit breaker,
fails closed when the specialized classifier is unavailable, and makes no
profitability claim.

## Review Focus

- Engine influence: any PS.2e value (tap return, thrown error, buffered tick,
  queue state, scheduler decision, shared-stack answer) reaching `best`,
  `bestScore`, market selection, `openPosition`, paper fills, positions, cash,
  equity, fitness, genomes, selection, births/deaths or generation transitions;
  any await, clock, random or id call added to the engine path, and any new line
  in `scripts/engine/simulation.mjs`.
- Boundary drift: an event that is not the finalized production entry proposal
  becoming PS.2e eligible, a genuine entry silently excluded, or PS.2e growing a
  second genuineness definition instead of importing the PS.2d one.
- Shared-stack substitution: the generic NobodyWho tier being used as if it were
  the Tev-style specialist, the validation-only classifier policy reaching the
  CLI, or any vendored, modified or reimplemented copy of the shared decision
  router.
- Real Local JEV identity pin and artifact-digest verification: the pin's
  `pinnedModel` / `pinnedModelSha256` diverging from the shared tier-1
  registration, an accepted primary answer whose worker receipt or exposed
  `observedSha256` does not match the pinned artifact digest
  (`4b3fbb5e…ffc348`), a thinking-enabled contract answer being accepted, or a
  weaker check replacing the name-plus-digest identity comparison. The
  `localJevCompatibilityBaseline` reference (shared Local JEV commit
  `5454aa9d…`, DEVELOPMENT provenance only) must never become a runtime
  requirement, and the historical `PS2E_MISSING_LOCAL_JEV_INTERFACE` record must
  never be presented as a current claim.
- Fake probabilities: a grammar-constrained local vote share relabelled as a
  probability, a calibrated number invented where the shared stack reported none,
  or a `pSupport`-shaped field appearing in a packet, record or dashboard block.
- Escalation provenance: a second-tier escalation, a TypeSafe fallback or an
  abstention being recorded as a primary Tev result, `do_not_support` being
  flipped, or `ABSTAIN` being converted into a binary stance.
- Bucket determinism and fairness: wall-clock, randomness, fitness, score,
  latency, confidence or market direction affecting an admission; quota borrowed
  across buckets; wrong suppression precedence; the within-tick order depending
  on flush timing or population order.
- Incomplete input digest: any model-visible byte (packet, provenance, question
  text, option descriptions, classifier identity or routing configuration) not
  covered by `jevInputDigest`, or two different payloads sharing a digest.
- Lookahead and outcome leakage: a market state stamped after the proposal, an
  outcome/future/horizon/realized/pnl/fill/execution/counterfactual key or value
  entering the packet, or PS.2c counterfactual data feeding eligibility.
- Logical-versus-physical accounting: a physical attempt not counted, a logical
  call double-counted across routes, a skipped disabled-fallback record counted
  as a physical attempt, `logicalCallsWithoutReadableAttempts` not reflecting
  genuinely unreadable attempt traces, an identity reported true while it does
  not hold, or an over-long request reaching the shared stack.
- Historical preservation and evidence contamination: PS.2 / PS.2d / PS.2a / PS.2b
  / PS.2c sessions, packets, digests or evidence classes being rewritten, or a
  PS.2e record claiming canonical, replication, temporal or predictive status.
- Dashboard framing: winner, ranking, green/red or profitability presentation; a
  missing `DEVELOPMENT SHADOW • ZERO AUTHORITY • PAPER ONLY` label; or any
  automatic authority-promotion path.
- External-call governance: fallback or gateway use, unbounded retries, a missing
  circuit breaker, a secret forwarded to the child process, or calls beyond the
  run cap.

## Verification

Dedicated validator: npm run validate:jev-supervisor

`scripts/validate-phase5i-ps2e.mjs` (run by `validate:jev-supervisor` after the
unchanged PS.2 and PS.2d suites) proves, fully offline with network denied: the
evidence class and every zero-authority flag; the freeze and determinism of the
protocol digest; the exact 12 × 5-minute schedule with 10-per-bucket and 120-per-run
ceilings and no cross-bucket borrowing; the retained per-asset cap and cooldown;
exact suppression precedence; that no score, outcome, prior decision, confidence
or latency input can change a decision and that no randomness or wall clock exists;
that the genuineness boundary is literally the PS.2d implementation; the packet v2
value domain, the post-admission-only temporal provenance and that the pre-admission
packet is never mutated; that `jevInputDigest` changes for every model-visible leaf
mutation and reproduces for byte-identical payloads; that the digest's `sampling`
block reflects the EFFECTIVE per-tier inference settings (tier overrides,
`local` inheritance, shared defaults, early_stop included) so a materially
different effective request always changes the digest while different raw
configs resolving to the same effective settings produce the same
effective-settings projection; that float-valued settings follow the pinned
Python `float(...)` exactly (booleans, underscore numerals, Python whitespace,
refused underscore placements and non-numeric strings, fail-closed non-finite
values) for temperature, `min_stability`, `timeout_s`, `idle_timeout_s` and
the TypeSafe timeout, with readiness failing closed on every shared build
refusal; that persisted evidence replays
`jevInputDigest` exactly; that contradictory primary provenance
(decision.provider / decision.model vs the accepted attempt or the pin,
duplicate or disagreeing accepted attempts, binary decisions carrying
abstention metadata, ABSTAIN with an accepted binary result) fails closed as
`PRIMARY_IDENTITY_MISMATCH` / `MALFORMED` while genuine primary and genuine
tier-2 escalation survive; that `max_local_retries` is normalized with the exact
shared semantics (`"3"` is 3 retries, `1.5` is 1, unnormalizable values fail
readiness closed) and that the physical-attempt ceiling and the router
theoretical worst case use the normalized count; that the integer-string
lexical mirror holds the pinned `int(...)` whitespace parity for EVERY integer
call site (`max_local_retries`, `min_margin`, `samples`, `seed`, `n_ctx`):
U+FEFF-wrapped integers refused in every position exactly as Python raises
(a BOM config is `LOCAL_JEV_CONFIG_INVALID` with NO Local JEV call, never the
pre-fix false READY), U+0085-wrapped integers accepted exactly like Python,
U+001C–U+001F refused like Python, and every form (number, numeric string,
boolean, fractional number, invalid decimal string, null, missing, object,
array) resolving to the pinned per-field effective value or the pinned refusal
with the unchanged field bounds; that integers outside the exact JavaScript
safe-integer range (strings, raw JSON literals, integral floats) fail readiness
closed for `min_margin`, `seed` and `n_ctx` instead of being rounded, while
`9007199254740991` stays exact and replays; and that one deterministic
spawned fake child crosses the real spawn/stdin/stdout/cap/parse/live-gate/
evidence/digest-replay pipeline offline; the option-token question set
with no probability and no future language; the read-only shared-stack projection
without secrets and the minimal child environment; every readiness failure mode
distinct and fail-closed; strict validation of the shared answer (echo, mode, skip,
error, token); no retry and no call for an over-long request; the exact
`decision ask --mode local-first --caller evolve` invocation boundary; transport OK
/ non-zero exit / timeout / spawn failure reported as data; primary, escalated,
TypeSafe-fallback, abstain, malformed, failed and unavailable provenance recorded
truthfully; that no classification path invents a probability; the bounded queue,
final flush and in-flight accounting; honest latency statistics; and engine
byte-identity (per-tick population digest, engine digest, trades, positions,
cash/equity, generation, fitness) with the shadow disabled, working, slow, throwing,
malformed, abstaining, escalating, queue-full, local-JEV-unavailable and
primary-classifier-unavailable; plus that `scripts/engine/simulation.mjs` never
names PS.2e, that PS.2e modules import no trading/evolution/selection/arena/research
subsystem, that no wallet/signer/swap/order/write-RPC path exists, that the
dashboard block is compact and probability-free, that historical PS.2 / PS.2d
sessions stay byte-identical, that the PS.2e plan is a valid Governance v1 plan with
the required role split, and that every protected evidence tree is byte-identical
after the whole suite.

Fresh commands: `npm run validate:governance`, `npm run validate:jev-supervisor`,
`npm run validate:phase5i`, `npm run validate`, `npx tsc --noEmit`, `npm run lint`,
`npm run build -- --webpack`, `git diff --check`.

Roles: IMPLEMENTER builds the frozen scope; PROTOCOL_REVIEWER checks the scientific
and evidence-boundary semantics; CODE_REVIEWER checks the diff independently;
VERIFIER runs the fresh commands. IMPLEMENTER CANNOT SELF-CERTIFY, so the run is
incomplete until an independent reviewer and verifier have recorded their review.

No live Jev, Jupiter, supervisor, Temporal or Paper Shadow run. No commit, no push.
