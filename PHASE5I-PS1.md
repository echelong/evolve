# Phase 5I-PS.1 — Jev Paper Shadow Forensic Analyzer

Offline, post-hoc development diagnostics for one explicitly named completed
Paper Shadow capture. This instrument is excluded from Phase 5I.0b, canonical
5I.1 replication, temporal 5I.1a replication, future temporal sessions, Arena,
Shadow League, deployment gates, evolution, and research swarm. There is no
live-dashboard integration, provider construction, network access, API-key
requirement, wallet, signing, swap, or RPC-write capability.

```sh
npm run validate:jev-paper-forensics
npm run jev:paper:analyze -- --session jpaper-20260920T154342Z-4734bb
```

The second command is for the operator after validation. The implementation
session did not analyze the real capture. `--latest` and unrecognized arguments
are rejected. `--json` prints the summary. `--out` can select a directory only
within `.evolve/jev-paper-forensics`; it cannot redirect output into another tree.

Each run creates a new, non-overwritable directory:

```text
.evolve/jev-paper-forensics/jforensic-<UTC timestamp>-<source digest suffix>/
  manifest.json
  integrity.json
  signal.json
  horizons.json
  episodes.json
  friction.json
  counterfactuals.json
  summary.json
  report.csv
```

All JSON artifacts persist `purpose: JEV_PAPER_SHADOW_POSTHOC_FORENSICS`,
`developmentOnly`, `postHoc`, and `paperOnly`. Canonical, replication, temporal,
Arena, deployment, profitability inference and parameter-selection eligibility
are false. CSV rows carry the counterfactual development disclaimers. No policy
is ranked or selected. An analysis ID collision fails instead of replacing data.
Symlink write ancestors are rejected.

## Integrity and preservation

The loader reads the three required source files without rewriting them and
hashes their raw bytes with SHA-256. Invalid UTF-8/JSON/NDJSON, source identity
mismatches, incomplete sessions, sequence gaps/duplicates, timestamp regression,
nonfinite values, credential-shaped content, inadmissible classification,
invalid probabilities/intents/fills, inconsistent counts, or inconsistent
summary digests fail closed. Summary fields use the actual runner schema:
`endingCash`, `endingEquity`, `endingPositionValue`, and `totalCosts`.

`RECORDED_BINARY` must reproduce every recorded action, fill and intermediate
account plus the final account. Account tolerance is absolute 1e-9 USD (and
1e-9 for quantity/drawdown comparisons); the separate engine fill check uses
1e-12 times max(1, absolute expected value). Reconstructed episode accounting
must reconcile. Material failure writes no analysis artifacts and does not
repair the source.

The source tree and complete `.evolve/jev-direction` tree are hashed before and
after computation and checked again after output writes. The dedicated validator
also hashes the real source solely for preservation, without analyzing it, and
checks these named directories:

- `replication/jrep-20260920T090716Z-97c862`
- `temporal/jtrp-20260920T151033Z-f1c16a`

File bytes, directory entries and symbolic-link targets are included. The
summary's artifact digest covers the eight artifacts written before the summary;
it deliberately excludes the summary itself to avoid a self-referential digest.

## Diagnostics and accounting conventions

Signal diagnostics report finite probability count, mean, median, sample standard
deviation, extrema, exact 0.50 count, HIGHER/LOWER counts, run lengths, intent flips
and boundary crossings. Missing signals break runs and are not converted to zero.
The ten requested bins are fixed in source. Decimal display labels denote
continuous half-open intervals; every probability strictly between 0.50 and 0.52
belongs to the `0.5001–0.5199` display bin, without rounding the observation.

Forward horizons are fixed at 30/60/90/120/300 seconds. Each uses the first event
at or after its target. No interpolation, price invention, or skipping a missing
price at that first event occurs. Missing/late horizons remain unavailable.
Requested and achieved horizons, prices, returns, outcomes, intentions,
probabilities and correctness are retained.

Horizon metrics include counts, HIGHER/LOWER/TIE outcomes, direction accuracy,
Brier, log loss, and mean/median returns following each intent. Direction accuracy
uses available observations with an intent; ties are incorrect directions.
Brier/log loss target the binary event “price went HIGHER,” so TIE has target 0.
Log loss clips probabilities at 1e-12 and 1−1e-12, with clipping counts reported.
Bucket outcome rate/accuracy use the 30-second horizon; returns use each requested
30/60/120/300-second horizon and their available observations.

Episodes retain entry/exit sequence, time, reference/executed price, probability,
hold duration, decisions held, percentage reference move, gross/net P&L, fees and
execution costs. The recorded runner does not persist `realizedGrossPnl` on an
event: episode gross P&L is quantity times the reference-price change. An open
position remains open, with no fabricated exit or round-trip profit.

Whole-session friction includes open-position costs and mark-to-market values:
`net = gross − costs`, and `costs = fees + execution friction`. Contribution
terms are accounting identities, not causal explanations. Observed break-even
movement is `100 × round-trip costs / (entry quantity × entry reference price)`
in percent. It is descriptive and is never fed into a policy. Churn reports
entry/exit/round-trip counts, duration statistics, time LONG/FLAT, flips,
0.50 entries, exits within 30/60/90 seconds and per-round-trip costs/gross/net P&L.

## Five frozen counterfactuals

| Policy | Definition |
| --- | --- |
| NO_TRADE | Always cash. |
| RECORDED_BINARY | HIGHER at pHigher ≥ 0.50; ENTER/HOLD for HIGHER, EXIT/CASH for LOWER. |
| TWO_SIGNAL_CONFIRMATION | Enter on the second consecutive HIGHER; exit on the second consecutive LOWER. |
| MIN_HOLD_60S | Binary policy; an intent-driven exit requires at least 60 seconds since entry. |
| TWO_SIGNAL_PLUS_60S | Both confirmation and the 60-second minimum hold. |

The current signal counts toward confirmation. Missing intent breaks the streak.
Existing feed/missing-price/no-signal guards remain in effect. Policies use the
same paper account functions, which import `simulateEntry`/`simulateExit` directly
from `scripts/engine/paper.mjs`. The friction verifier also calls that engine.

Friction defaults are fixed before reading outcomes, resolved with an empty
environment and no environment-file loading. Legacy captures did not persist the
full friction configuration. The analyzer verifies those fixed defaults against
every fill and account; it fails closed for configurations that do not reproduce.
It does not fit friction coefficients from later fills. Original inactive cap and
liquidity-limit values cannot be uniquely established from legacy fills; the
counterfactual manifest explicitly records this limitation. This is not parameter
validation or a claim that unobserved original settings were recovered.

Each policy reports entries, exits, round trips, time in market, starting cash,
ending cash/position value/equity, gross/net P&L, costs, max drawdown, turnover and
mean holding duration. Every policy carries:

```text
POST-HOC COUNTERFACTUAL DEVELOPMENT ANALYSIS
NOT OUT-OF-SAMPLE
NOT REPLICATION EVIDENCE
NOT PARAMETER VALIDATION
```

There is no threshold sweep, grid, Bayesian or adaptive search, result-based
parameter selection, policy generator, ranking, winner, or promotion hook. The
five-policy array is emitted in declaration order. Each action receives only the
current observation and previously accumulated state. Deterministic tests compare
all prefixes and alter every suffix's prices/probabilities/fills for every policy;
actions, fills and accounts at or before the cut remain byte-for-byte equal.
Forward scoring is a separate pass and never feeds policy state.

## Instrumentation investigations

**Upstream.** `scripts/jev/providers/typesafe-jev.mjs` returns a provider with
`name`, `model`, and `transport`, but no `upstream`. Paper Shadow previously read
only `provider.upstream`, producing null. `paperShadowUpstreamFor` now resolves the
provider name through the existing `JEV_PROVIDER_UPSTREAM` registry. The Paper
Shadow runner honors explicit upstream fields first and otherwise uses that
registry, yielding `typesafe-ai` for `typesafe-jev`. A virtual-clock test with a
provider-shaped fixture lacking upstream proves the new session and summary
persist it. No real provider is constructed/called. Old artifacts and canonical
contracts are unchanged.

**Equal digests.** The Paper Shadow runner independently calls
`packetStateDigestOf(packet)` and `packetDigestOf(packet)` on the same packet.
`direction/packet.mjs` hashes its stable projection for the packet digest and
delegates the state digest to `jevStateDigestOf` in `decision-packet.mjs`.
Both projections recursively sort keys and omit `createdAt`/`generatedBy`.
`direction/runner.mjs` explicitly rejects unequal state and packet digests.
Equality is intentional, not an instrumentation defect. The forensic audit
records source paths/lines and checks equality, volatility invariance and
sensitivity to content changes. No digest semantics were changed.

## Validation

`validate:jev-paper-forensics` is deterministic and blocks network entry points
before importing the analyzer. It covers integrity rejection, exact statistics,
all frozen bins and policies, irregular horizon matching, missing horizons,
scoring calculations, closed/open episode accounting, replay reproduction,
no-lookahead, output isolation, preservation and instrumentation. It also walks
the transitive analyzer import graph to verify direct engine reuse and absence
of provider, network and wallet dependencies. Fixtures are temporary; only those
owned by this validation invocation are removed afterward.

## Resumption record

Resumed HEAD: `10f79bc88bf2cb458ea8202514cff84b58a843f1`.
The working tree was inspected before edits. It already contained changes to
`package.json`, Paper Shadow's `definition.mjs` and `runner.mjs`, the untracked
forensic CLI, and all 13 forensic modules. The dedicated validator was missing.
Those modules were reviewed and continued in place; no Git reset/restore,
checkout, cleanup, commit, or push was performed.

Corrections include the actual persisted summary/event schema, recorded-policy
lookup, current-signal confirmation timing, null-probability handling, raw-byte
SHA-256, missing horizon-price handling, closed/open accounting, missing fill
rejection, output containment and collision protection, and the actual nested
locations of the two protected manifests. Future-fill friction fitting was
replaced by fixed settings plus fail-closed reproduction. This document and
`scripts/validate-phase5i-ps1.mjs` were added during the resumed work.

Existing validators were left unchanged. Full validation initially exposed
vocabulary-scan conflicts in the partial analyzer's credential list, the new
validator's inline deny regex, and a redundant protected-directory list entry.
The fixes reuse shared credential detection, declare the deny vocabulary in the
existing convention, and retain the stronger exclusive output-directory guard.
Stricter summary-digest testing also corrected a fixture's missing model field
and explicitly accounts for storage adding `updatedAt` after digest computation.

## Completed validation and preservation

- `npm run validate:jev-paper-forensics`: **70 passed, 0 failed**.
- `npm run validate:jev-paper`: **52 passed, 0 failed**.
- `npm run validate:phase5i`: **290/290 canonical/development checks and 39/39 temporal checks passed**.
- `npm run validate`: **passed**, including the forensic suite and smoke checks.
- `npx tsc --noEmit`: **passed**.
- `npm run lint`: **passed**, with one pre-existing unused `random` warning at `scripts/engine/families.mjs:250`; no new warnings.
- `npm run build -- --webpack`: **passed**.
- `git diff --check`: **passed**.

The broader commands ran with external network entry points blocked. The final
independent raw-byte SHA-256 inventory exactly matches the initial inventory:
**5 real Paper Shadow files and all 1,860 canonical-tree files unchanged**. Both
named replication/temporal directories and all their files are included. The
dedicated validator also verifies directory entries and symlink targets.

Real source file hashes (identical before/after; hashing only, no analysis):

| File | SHA-256 |
| --- | --- |
| `session.json` | `d2b94dc69db41186ed51ad94baeb237c164426bc860b9f9855b2025b5a493659` |
| `summary.json` | `0d31ae377d01cd8e4f02486da7d902dc8d8e936940e33b52537e8cdfccb866b5` |
| `events.ndjson` | `8c10f0a3bf29972ddcea4f5bcce535c353cefde8ad49af41de37bd92471bc9a3` |

No real forensic run, live Paper Shadow, Jev/TypeSafe/Jupiter call, market recorder,
or temporal session was started. No commit or push was made.
