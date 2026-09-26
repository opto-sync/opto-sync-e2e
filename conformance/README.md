# Conformance evidence classes

Every Opto Sync qualification claim in this repository must be classified before it can be used for promotion.

## Classes

- `declaration-only`: a falsifiable contract/property declaration. No runtime proof is implied.
- `modeling-only`: deterministic model/state-machine evidence. It may expose counterexamples but does not prove a concrete runtime.
- `implementation-linked`: an executable check bound to an immutable implementation revision.
- `cross-runtime`: implementation-linked evidence comparing every runtime for which parity is promised.

The evidence registry is validated by `tools/evidence-governance.rs` in CI.

## Promotion rule

A lower-strength class cannot be restated as a stronger claim. In particular, a deterministic model is not production durability, availability, runtime convergence, causal consistency, or total ordering. Runtime claims require exact implementation identity and actually executed exact-head jobs; cross-runtime claims require every named runtime to execute.

Queued, skipped, zero-step, stale-head, historical-only, runner-admission, billing-blocked, or missing runs are not green evidence.

## Counterexamples

Modeling lanes that carry broken controls must persist the counterexample identity in the registry. Controls prove that the lane can detect the targeted defect; they do not make the model a runtime proof.

Implementation-linked and cross-runtime registry rows must bind one source as
`owner/repository@<40 lowercase hex commit>`. Branches, tags, short hashes,
all-zero placeholders, and URLs are rejected. This is structural admission:
it does not verify that a commit exists, that its code was executed, or that
all claimed runtimes passed. Those obligations still require execution receipts.
