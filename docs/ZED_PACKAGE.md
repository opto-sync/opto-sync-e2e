# Zed package

The complete conformance harness is distributed as
`opto-sync/opto-sync-e2e@0.1.0`.

This is intentionally one package rather than a language fan-out: its value is
the coordinated topology—Compose files, Postgres, servers, protocol fixtures,
auth and operations adversarial suites, cross-runtime checks, client-in-the-loop
runners, and recovery/load tests. Splitting those files would destroy the test
contract the package exists to preserve.

## Dependency graph

The root manifest records:

```toml
[dependencies]
"opto-sync/syncer" = "^0.2.1"
"opto-sync/opto-sync-clients" = "^0.2.0"
```

The native Docker and GitHub Actions workflows still check the repositories out
as siblings because their Docker build contexts and native path dependencies
were designed that way. The Zed graph records package provenance and prepares a
migration away from mutable sibling branches; it does not claim those existing
paths have already been rewritten.

## Validation

The existing Docker and client workflows remain the behavioral authority. The
additional `Zed package contract` workflow:

1. validates the default Compose graph;
2. checks the primary protocol, client, and cross-server entrypoints;
3. builds pinned `zed-cli` and `zed-interfaces` revisions;
4. runs deterministic `zed pack` and a non-mutating publish dry run; and
5. uploads the package artifact for inspection.

## Release order

Publish in dependency order after matching reviewed tags point at each release
commit:

1. `opto-sync/syncer@0.2.1`;
2. `opto-sync/opto-sync-clients@0.2.0`;
3. `opto-sync/opto-sync-e2e@0.1.0`.

Then generate non-empty lockfiles against the registry and commit the exact
artifact hashes. Until the dependency packages exist in the registry, the
checked-in lockfiles contain only the lockfile format version.
