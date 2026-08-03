# Opto-Sync coordinated release rollback

This procedure applies to the coordinated Zed release set containing the native reconciliation engine, the polyglot clients, and the E2E conformance package. The engine and clients are one compatibility unit even though they retain independent versions.

## Ownership

The Opto-Sync maintainers own rollback. For a protected publication, the person who approves the GitHub release environment becomes incident commander until the release is either declared healthy or fully contained. A second maintainer must review any yank, deprecation, downstream rollback, or replacement release.

## Non-negotiable rules

1. Never overwrite a registry artifact, move a published version to another commit, or retag an immutable version.
2. Never roll back only `syncer.c` or only `opto-sync-clients`. The embedded client core, the server core, and every consumer lock or legacy gitlink must identify one certified pair.
3. Stop new publication and downstream dispatch before repairing anything.
4. Preserve failed artifacts, checksums, workflow logs, and the release-set manifest for incident analysis. They are evidence, not disposable build output.
5. Do not weaken compatibility, provenance, frozen-install, browser, SQLite, Postgres/Supabase, or cross-runtime gates to make a rollback appear green.

## Before any registry upload

If deterministic packing, source parity, provenance, smoke tests, or publication preflight fails:

1. Leave the release set in `candidate` state.
2. Do not create or push release tags.
3. Do not populate downstream `.zpkg.lock` files from the candidate.
4. Repair the source or release tooling on a new reviewed commit.
5. Regenerate all archives and evidence from scratch; do not reuse a package from the failed attempt.

An unpublished local tag may be deleted only after confirming that no registry, forge package, GitHub Release, consumer lock, or external mirror references it.

## During a partial publication

If one artifact uploads and a later artifact fails:

1. Disable the protected publication workflow or release environment immediately.
2. Record exactly which immutable artifacts and tags exist.
3. Do not replace uploaded bytes under the same version.
4. Mark the incomplete version deprecated or yank it only through the registry's reviewed control plane. Existing locks may continue to resolve it, so the incident record must state whether installation remains permitted.
5. Publish a new patch release set after the defect is corrected and the complete evidence matrix passes.
6. Do not release the E2E package until both engine and client artifacts exist and frozen installation resolves their exact checksums.

## After downstream adoption

For a regression found after wrapper or application rollout:

1. Freeze the release dispatcher and stop automated bump PR creation.
2. Identify the last known-good coordinated release set from committed manifests and locks.
3. Revert each downstream adoption PR as one unit. Restore `.zpkg.toml`, `.zpkg.lock`, native adapter paths, and—where still retained—both legacy gitlinks together.
4. Run the consumer's product-specific E2E suite against the restored set, including offline restart, replay, conflict/tombstone, browser IndexedDB, SQLite, and backend authority checks relevant to that product.
5. For security or data-integrity defects, rotate affected publication credentials and follow each repository's private vulnerability-reporting procedure.
6. Publish a replacement patch release. Never point an existing tag or version at the fix.

## Data and protocol containment

If a release can corrupt queues, checkpoints, tombstones, or storage migrations:

1. Disable write drain and background synchronization before changing local state.
2. Preserve IndexedDB/SQLite diagnostic copies using synthetic or explicitly approved data-handling procedures.
3. Prefer a protocol-declared reset, bounded resync, or migration rollback. Do not delete durable queues merely to restore liveness.
4. Require explicit operator review before re-enabling remote-confirmed financial, identity, consent, lock/lease, or other irreversible product operations.

## Recovery completion

A rollback is complete only when:

- the release manifest identifies the failed and restored release sets;
- registry and tag state is documented;
- all affected downstream locks or gitlinks agree on one certified core/client pair;
- the relevant exact-head CI and product E2E checks pass;
- the incident commander records the decision and evidence in DEN-309/DEN-363; and
- publication and downstream dispatch are re-enabled through reviewed protected controls.
