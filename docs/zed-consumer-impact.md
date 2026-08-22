# Zed declared consumer impact

`opto-sync/opto-sync-clients` is a package boundary, so a source-only test matrix is incomplete unless it also knows which packages declare it and which product suites exercise those consumers.

The impact controller in `scripts/zed_consumer_graph.py` performs a bounded registry census:

1. Enumerate the current registry package index. The current `/v1/packages` route is registry-wide rather than a caller-scoped visibility snapshot.
2. Select every indexed version for the nightly census (`all-visible`) or only the newest indexed version for a bounded canary.
3. Fetch the immutable `view=declared` graph for each selected package version under the supplied caller credentials.
4. Validate the Zed schema, single-registry identity, graph digest, authoritative marker, exact `Content-Length`, strong `ETag`, cache policy, and `Vary` transport contract.
5. Invert direct declaration edges and compute cycle-safe direct and transitive consumers of `opto-sync/opto-sync-clients`.
6. Reconcile discovery with `operations/downstream-wrapper-fleet.v1.json`, which says how each known wrapper is tested.
7. Apply the conservative taxonomy in `operations/opto-sync-consumer-classification.v1.json`: `exact-pin`, `package-release`, `adapted-concept`, or `candidate`.

## Truth boundary

The Zed v1 declared graph contains unresolved requirements. It is not an exact lock resolution and the registry does not currently expose a reverse-dependents endpoint. The controller therefore reports:

- `graph-only`: a package declares Opto-Sync but has no curated execution mapping; scheduled strict runs fail.
- `curated-only`: a rollout entry is not visible in the current declared-graph inventory; this remains evidence, but is not automatically a failure because unpublished/private/migration candidates can be legitimate.
- `unclassified`: a graph-discovered package lacks reviewed adoption classification; scheduled strict runs fail.
- `missingGraphs`: a selected indexed package version has no declared graph; strict live collection fails rather than silently shrinking coverage.

The package index and graph authorization boundaries are different. The current package-list route enumerates the registry index, while protected graph reads require caller authorization and deliberately return the same no-store `404` for inaccessible, unknown, or absent graphs. A missing graph is therefore recorded as `not-found-or-inaccessible`; strict runs fail rather than guessing which condition occurred.

Every report labels this limitation and includes an inventory digest that binds the registry identity, inventory scope, stable advertised total, selected versions, graph counts, missing-graph evidence, and exact declared edges. Pagination verifies a stable total but the current API does not expose a registry checkpoint for this declared-graph census, so the report does not claim an atomic global snapshot. Ambiguous duplicate JSON object keys and inventories that cannot establish one registry identity are rejected before impact evidence is rendered.

## Repository configuration

The scheduled live job reads:

- repository variable `ZED_REGISTRY_URL`;
- optional secret `ZED_REGISTRY_TOKEN`;
- optional repository variable `OPTO_SYNC_REQUIRE_LIVE_ZED_GRAPH=true` to make missing live configuration fatal.

No credential is accepted on the command line, written to an artifact, or included in the inventory digest. Registry URLs reject userinfo, non-loopback plaintext HTTP, queries, fragments, and redirects. Bearer credentials therefore cannot be forwarded to a redirect target. Response bodies, package counts, version counts, edge counts, and request timeouts are bounded and fail closed.

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

The JSON, DOT, and Mermaid outputs are deterministic and contain no collection timestamp. Workflow-run metadata supplies the temporal context without changing the graph identity. The default safety ceilings are 16 MiB per response, 50,000 packages, 250,000 selected versions, 100,000 declared edges, and 300 seconds per request; explicit CLI flags may lower or raise the count/body ceilings for a reviewed environment.

## Credential binding

When `ZED_REGISTRY_TOKEN` is configured, live CI also requires `ZED_REGISTRY_TOKEN_ORIGIN` to contain the exact normalized scheme, host, and optional port expected to receive that token. The launcher rejects duplicate options and path-bearing origin declarations. The underlying client rejects every redirect, so authorization is never forwarded through a redirect—even to the same origin.
