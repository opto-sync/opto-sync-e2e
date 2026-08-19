# Zed declared consumer impact

`opto-sync/opto-sync-clients` is a package boundary, so a source-only test matrix is incomplete unless it also knows which packages declare it and which product suites exercise those consumers.

The impact controller in `scripts/zed_consumer_graph.py` performs a caller-scoped census:

1. Enumerate the complete package list visible to the supplied Zed credentials.
2. Select every visible version for the nightly census (`all-visible`) or only the newest visible version for a bounded canary.
3. Fetch the immutable `view=declared` graph for each selected package version.
4. Validate the Zed schema, graph-digest format, `X-Zpkg-Graph-Digest`, strong `ETag`, and `Vary: Accept` transport contract.
5. Invert direct declaration edges and compute cycle-safe direct and transitive consumers of `opto-sync/opto-sync-clients`.
6. Reconcile discovery with `operations/downstream-wrapper-fleet.v1.json`, which says how each known wrapper is tested.
7. Apply the conservative taxonomy in `operations/opto-sync-consumer-classification.v1.json`: `exact-pin`, `package-release`, `adapted-concept`, or `candidate`.

## Truth boundary

The Zed v1 declared graph contains unresolved requirements. It is not an exact lock resolution and the registry does not currently expose a reverse-dependents endpoint. The controller therefore reports:

- `graph-only`: a package declares Opto-Sync but has no curated execution mapping; scheduled strict runs fail.
- `curated-only`: a rollout entry is not visible in the current declared-graph inventory; this remains evidence, but is not automatically a failure because unpublished/private/migration candidates can be legitimate.
- `unclassified`: a graph-discovered package lacks reviewed adoption classification; scheduled strict runs fail.
- `missingGraphs`: a selected visible package version has no declared graph; strict live collection fails rather than silently shrinking coverage.

Private packages are visible only when the supplied token authorizes them. Every report labels this limitation and includes an inventory digest over the exact visible package/version edge set.

## Repository configuration

The scheduled live job reads:

- repository variable `ZED_REGISTRY_URL`;
- optional secret `ZED_REGISTRY_TOKEN`;
- optional repository variable `OPTO_SYNC_REQUIRE_LIVE_ZED_GRAPH=true` to make missing live configuration fatal.

No credential is accepted on the command line, written to an artifact, or included in the inventory digest.

## Local deterministic contract

```bash
python3 -m unittest suite.operations.test_zed_consumer_graph -v
python3 scripts/zed_consumer_graph.py \
  --snapshot suite/fixtures/zed-consumer-graph/inventory.json \
  --curated-fleet suite/fixtures/zed-consumer-graph/curated-fleet.json \
  --classification-policy suite/fixtures/zed-consumer-graph/classification.json \
  --output /tmp/opto-sync-consumer-impact.json \
  --dot-output /tmp/opto-sync-consumer-impact.dot \
  --mermaid-output /tmp/opto-sync-consumer-impact.mmd
```

The JSON, DOT, and Mermaid outputs are deterministic and contain no collection timestamp. Workflow-run metadata supplies the temporal context without changing the graph identity.
