# EVOLVE Development Governance v1

EVOLVE Development Governance is development infrastructure. It records how a substantial change is planned, reviewed, verified, and preserved. It has no trading, evolution, deployment, or research authority and is never scientific evidence.

## Workflow

```text
spec/plan → implementation → independent review → fresh verification → shadow/replication when research-facing
```

The native entrypoint is `scripts/evolve-governance.mjs`. Governance writes records only under `.evolve/governance/`.

## Global Constraints

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

The canonical JavaScript definition is `scripts/governance/definition.mjs`. It supplies the stable `globalConstraintsDigest`; validators use that definition rather than maintaining a second text copy.

## Roles and certification

The five role contracts are defined in `scripts/governance/roles.mjs`: `SCOUT`, `IMPLEMENTER`, `PROTOCOL_REVIEWER`, `CODE_REVIEWER`, and `VERIFIER`. Each contract declares its mission, allowed and forbidden responsibilities, required inputs and outputs, and completion conditions.

`IMPLEMENTER CANNOT SELF-CERTIFY`. A substantial change needs implementation, code review, protocol review when research or evidence semantics are touched, and fresh verification. Identity fields are operator declarations and are not cryptographic proof. A collision between implementer and reviewer or verifier is recorded as incomplete; identities are never fabricated.

## Plan and scope checks

Every substantial plan must contain `Goal`, `Architecture`, `Files / scope`, `Global Constraints`, `Review Focus`, and `Verification`. `Review Focus` must contain at least five concrete project-specific failure modes. The default focus is evidence contamination, hidden lookahead, frozen-protocol drift, observer or research influence on execution, and artifact mutation or replay mismatch.

Every plan must also declare `Research/evidence semantics: yes` or `Research/evidence semantics: no`. This is an explicit protocol-review classification; governance does not infer it from model prose. A `yes` declaration requires a protocol reviewer identity before completion.

The plan checker rejects unresolved placeholder language, requires the canonical constraints digest or complete constraint text, and requires protected paths when evidence-related work is declared. The scope checker classifies changes as `IN_SCOPE`, `JUSTIFIED_ADJACENT`, or `OUT_OF_SCOPE`; unlisted changes require an explicit justification.

## Review packages and verification

Review packages are bounded and include the plan and digest, base/head, commit list, diff statistics, changed files, a bounded diff with truncation metadata, canonical constraints, Review Focus, and scope results. Secret-bearing paths and content such as `.env` files, API keys, authorization headers, cookies, and private keys are excluded or redacted.

The verifier runs commands fresh in the current invocation and records timestamps, duration, exit code, full-stream digests, bounded output, and status for every command. The default suite is `npm run validate`, `npx tsc --noEmit`, `npm run lint`, `npm run build -- --webpack`, `git diff --check`, and `git status --short`, plus a plan-declared validator. No completion claim is valid without fresh evidence.

Protected evidence trees are hashed before and after verification. Missing, new, removed, or changed files fail preservation. Governance testing uses temporary fixtures or its own governance directory and never rewrites historical evidence.

## Incidents and external calls

Incident records move through `OBSERVED`, `REPRODUCED`, `EVIDENCE_GATHERED`, `ROOT_CAUSE_HYPOTHESIS`, `MINIMAL_TEST`, `FIX`, and `VERIFIED`. A fix requires root-cause evidence, a minimal test that failed before and passed after, and fresh verification. Three distinct refuted hypotheses set `architectureReviewRequired`; a fourth ad-hoc fix cannot be marked verified until an architecture review note is recorded.

External-call policy records require a timeout, retry cap, maximum calls per run, provider, model, fallback, cache, authority level, and circuit-breaker policy. Evidence-bearing calls require no fallback and fail closed. The policy validates the frozen authority ladder and never performs external calls.

## Shadow-first authority ladder

```text
OBSERVE
↓
SHADOW
↓
DEVELOPMENT EVIDENCE
↓
INDEPENDENT REPLICATION
↓
TEMPORAL / GENERALIZATION REPLICATION
↓
UNTOUCHED EVALUATION
↓
HUMAN / PROTOCOL GATE
↓
ONLY THEN CONSIDER MORE AUTHORITY
```

One successful run never promotes a model, agent, genome, or governance component. Governance cannot grant trading, deployment, or evolution authority.

## Commands

```bash
npm run governance:roles
npm run governance:plan-check -- --plan <path>
npm run governance:scope-check -- --plan <path> --base <sha> --head WORKTREE
npm run governance:review-package -- --plan <path> --base <sha> --write
npm run governance:verify -- --plan <path>
npm run governance:incident -- --action open --title "<description>" --observed "<symptom>"
npm run governance:external-policy -- --file <policy.json> --evidence-bearing
npm run validate:governance
```

The full orchestration command is available as `npm run governance -- orchestrate --plan <path>`. It writes a run manifest and subordinate records under `.evolve/governance/runs/<run-id>/`.
