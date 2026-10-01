# E2E contract authority boundary

`opto-sync-e2e` qualifies contracts and implementations; it does not author a third public wire authority.

- Human-authored TypeSpec and JSON Schema Draft 2020-12 in `opto-sync-interfaces` are independent peer authorities.
- `ORESoftware/typespec-json-schema-validator` is the fail-closed parity/admission mechanism for those peers.
- Generated JSON Schema, OpenAPI, Protobuf, Contract IR, language types, and fixtures are evidence/projections only.
- Implementation repositories own their executable runtime behavior. E2E may bind an exact implementation commit to a model/fixture, but a model does not replace implementation execution.
- Database schema evolution is qualified through Declarative Migrations against disposable databases; application startup must not mutate server schema.

The registry in `conformance/evidence-registry.tsv` records the evidence class of each E2E property so modeling-only checks cannot be presented as runtime or production proof.
