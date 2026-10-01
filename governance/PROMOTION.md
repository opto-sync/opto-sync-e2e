# E2E promotion governance

Promotion is evidence-strength preserving and fail-closed.

## Exact-head rule

For a PR or release candidate, evidence is admissible only when the relevant workflow checks out and executes against the exact candidate head/immutable implementation revision. Queued, skipped, zero-step, stale-head, historical-only, billing/admission-blocked, runner-admission, or missing results are not green.

## Evidence-strength rule

The `conformance/evidence-registry.tsv` class is a ceiling on what the listed lane can prove by itself:

- `declaration-only` cannot prove execution;
- `modeling-only` cannot prove runtime/production behavior;
- `implementation-linked` can support only the immutable implementation it actually executed;
- `cross-runtime` requires every parity runtime and fixture version named by the claim to execute.

Do not infer CRDT/OT, total ordering, causal consistency, production availability, crash durability, or physical-device behavior from a weaker lane.

## Required receipts

Promotion comments/receipts should carry the candidate SHA, implementation source identities, workflow/run and relevant job/step evidence, schema/contract version, seed/event trace where applicable, counterexample/control identities, and explicit blockers/non-claims.

## Recovery semantics

A later scheduled exact-head green may mark a prior product incident recovered. A manually dispatched or unrelated green, a skipped schedule, or delayed callback from an older revision cannot regress or overwrite newer incident state.
