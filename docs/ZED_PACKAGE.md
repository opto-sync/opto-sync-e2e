# Zed package

The complete conformance harness is packaged as
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
4. runs deterministic `zed pack` and a non-mutating publish dry run;
5. requires `pkg/LICENSE` in the generated archive;
6. proves that the real `pkg/.env` is excluded; and
7. uploads the package artifact for inspection.

The separate Docker and client-in-the-loop matrices cover protocol ordering and
idempotency, auth and JWT tenant isolation, operational limits and metrics,
concurrency/load, backup and recovery, cross-runtime convergence, the
Supabase/PostgREST route, and live TypeScript, Dart, Rust, and Gleam clients.

## Release order and publication

Publish in dependency order after matching reviewed tags point at each release
commit:

1. `opto-sync/syncer@0.2.1`;
2. `opto-sync/opto-sync-clients@0.2.0`;
3. `opto-sync/opto-sync-e2e@0.1.0`.

`.github/workflows/zed-publish.yml` dry-runs package publication on pull
requests and performs a real registry write only from a selected or pushed
`v*` tag. It fetches full tag history, disables persisted checkout credentials,
rejects branch publication, builds pinned Zed tooling, and accepts registry
authority only through the repository secret `ZED_PKG_TOKEN`.

After the two dependency packages resolve in the registry, provision this
repository's `ZED_PKG_TOKEN`, place `v0.1.0` on the reviewed `main` commit, and
let the tag workflow publish the conformance package. Then run `zed install` and
commit the resulting non-empty `.zpkg.lock` with the exact dependency artifact
hashes. Until those registry entries exist, the checked-in lockfile contains
only the lockfile format version.

Manual preflight:

```sh
zed pack
zed publish --dry-run
```

Package-ready source and green tests do not, by themselves, prove that a
registry upload has occurred; the successful tag workflow is the release
record.
