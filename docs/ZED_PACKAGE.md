# Zed package

The complete conformance harness is prepared as the whole-repository Zed source
package `opto-sync/opto-sync-e2e@0.1.0`. Do not claim a registry release until
its dependencies have been published, the lockfile has been populated, and the
matching Git tag points at the reviewed commit.

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

The checked-in `.zpkg.lock` currently carries only `version = 1`. That is a
format-valid source placeholder, not a frozen dependency graph. After both
upstream packages exist in the configured registry, run `zed install`, review
the exact artifact hashes, sizes, commits, tags, and sources, then commit the
populated lockfile.

## Validation

The Docker and client workflows remain the behavioral authority. They pin exact
compatible engine/client commits by default, allow explicit compatibility
overrides, remove checkout credentials before executing build code, install
Node dependencies through committed locks, respect the tracked Rust lockfile,
and never print `.env` contents.

The `Zed package contract` workflow additionally:

1. validates the source manifest, lockfile format, MIT license, required topology,
   and both Compose graphs;
2. builds pinned `zed-cli` and `zed-interfaces` revisions;
3. packs and dry-runs the exact package identity;
4. inspects the archive for required entrypoints while rejecting `.env`, logs,
   caches, and build output;
5. extracts the artifact, revalidates it, and runs Compose configuration plus the
   declared package smoke check against the extracted files; and
6. uploads the deterministic package artifact for review.

## Release order

Publish in dependency order after matching reviewed tags point at each release
commit:

1. `opto-sync/syncer@0.2.1`;
2. `opto-sync/opto-sync-clients@0.2.0`;
3. `opto-sync/opto-sync-e2e@0.1.0`.

Then run `zed install` in the client and E2E repositories and commit their
non-empty dependency lockfiles before publishing those dependent packages.
