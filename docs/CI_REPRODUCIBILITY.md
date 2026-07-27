# Cross-repository CI reproducibility

The E2E repository builds and runs code from three repositories in one sibling
layout. Ordinary pull-request and `main` CI must therefore identify all three
revisions, not silently follow mutable upstream branches.

Both E2E workflows currently certify this exact pair:

- `opto-sync/syncer.c@7795ce2d1342e17d934d2faafff5c8ed4322609e`;
- `opto-sync/opto-sync-clients@54874e9f7df6009fccd9034fce39306daef2c043`.

The client repository is cloned recursively. Its root `syncer.c` gitlink must
resolve to the same core SHA as the sibling `syncer.c` checkout used by the
Docker/server topology. CI compares all three identities before package-manager,
compiler, Compose, or test code runs:

1. sibling `syncer.c` `HEAD`;
2. the `opto-sync-clients` mode-160000 gitlink;
3. the initialized nested submodule `HEAD`.

A `workflow_dispatch` run may override either ref with `main`, a feature branch,
or a candidate SHA. That path is for deliberate forward-compatibility testing;
the overridden client ref must still embed the same core selected by
`syncer_ref`, or the parity preflight fails.

## Security and integrity controls

- Every checkout uses `persist-credentials: false` before package-manager,
  compiler, Compose, or test code executes.
- The client checkout uses `submodules: recursive`; a missing or mismatched core
  is a hard failure rather than a fallback to a mutable sibling directory.
- Node dependencies are installed with `npm ci` from committed lockfiles.
- The tracked Rust fixture lockfile is fetched with `cargo fetch --locked`; CI
  never regenerates it.
- `.env` contents are never printed to Actions logs. Workflows may report that
  the file exists and count declared variables, but values remain redacted.
- Compose configuration is validated before any containers start.
- `scripts/check-ci-contract.py` pins the certified pair and statically ratchets
  recursive checkout, core parity, locked installs, secret handling, and the
  root Zed package dependency graph.

## Zed package relationship

The E2E source package records compatible ranges for
`opto-sync/syncer@^0.2.1` and `opto-sync/opto-sync-clients@^0.2.0`. Those ranges
express release compatibility, while the workflow SHAs identify the exact pair
certified by this E2E commit. Both are required:

- ranges make the package graph understandable through Zed;
- immutable SHAs make historical CI reproducible and reviewable;
- the nested gitlink makes the native client source artifact self-contained.

The full harness remains one package because its useful contract is the complete
Compose topology, protocol/auth/operations/recovery/load suites, cross-runtime
servers, and client-in-the-loop fixtures—not any one language directory.

## Coordinated compatibility test

When either upstream repository changes a shared ABI, path layout, package
boundary, or protocol:

1. Push the upstream feature branches.
2. Manually dispatch both E2E workflows with `syncer_ref` and/or `clients_ref`
   set to those exact feature refs.
3. Require the Docker matrix and client-in-the-loop suite to pass, including the
   sibling/nested core parity preflight.
4. Merge upstream in dependency order.
5. Update the pinned SHAs and `scripts/check-ci-contract.py` here in a pull
   request, then rerun the full matrix.
6. Update the `sonus-auris/sonus-auris-sync` and
   `voxletra/voxletra-sync` downstream gitlinks when the certified pair changes.

This keeps a historical E2E commit replayable while still testing candidate
cross-repository changes before they are merged.
