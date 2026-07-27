# Cross-repository CI reproducibility

The E2E repository builds and runs code from three repositories in one sibling
layout. Ordinary pull-request and `main` CI must therefore identify all three
revisions, not silently follow mutable upstream branches.

Both E2E workflows pin:

- `SYNCER_C_REF` to `opto-sync/syncer.c@7795ce2d1342e17d934d2faafff5c8ed4322609e`;
- `CLIENTS_REF` to `opto-sync/opto-sync-clients@54874e9f7df6009fccd9034fce39306daef2c043`.

The client commit contains a mode-160000 root gitlink to the same engine commit.
The live-client workflow initializes that nested submodule and fails if its SHA
differs from the sibling engine compiled into the E2E server images. This proves
that server and client runtimes are tested against one reconciliation engine,
without relying on two independently chosen compatible-looking revisions.

A `workflow_dispatch` run may override either ref with `main`, a feature branch,
or a candidate SHA. When overriding `clients_ref`, its nested engine gitlink must
match `syncer_ref`; the provenance step fails closed on a mismatch.

## Security and integrity controls

- Every checkout uses `persist-credentials: false` before package-manager,
  compiler, Compose, or test code executes.
- The client checkout uses `submodules: recursive` and verifies the real gitlink.
- Node dependencies are installed with `npm ci` from committed lockfiles.
- The tracked Rust fixture lockfile is fetched with `cargo fetch --locked`; CI
  never regenerates it.
- `.env` contents are never printed to Actions logs. Workflows may report that
  the file exists and count declared variables, but values remain redacted.
- Compose configuration is validated before any containers start.
- `scripts/check-ci-contract.py` statically ratchets these requirements and the
  root Zed package dependency graph in a lightweight job.

## Zed package relationship

The E2E source package records compatible ranges for
`opto-sync/syncer@^0.2.1` and `opto-sync/opto-sync-clients@^0.2.0`. Those ranges
express release compatibility, while the workflow SHAs and client gitlink
identify the exact source pair certified by this E2E commit.

The full harness remains one package because its useful contract is the complete
Compose topology, protocol/auth/operations/recovery/load suites, cross-runtime
servers, and client-in-the-loop fixtures—not any one language directory.

## Coordinated compatibility test

When either upstream repository changes a shared ABI, gitlink, path layout,
package boundary, or protocol:

1. Push the upstream feature branches.
2. Ensure the client feature branch points its root gitlink at the candidate
   engine commit and passes its four-language/package suites.
3. Manually dispatch both E2E workflows with `syncer_ref` and `clients_ref` set
   to the exact candidate refs.
4. Require the Docker matrix and client-in-the-loop suite to pass.
5. Merge upstream in dependency order and update the pinned SHAs here.
6. Update `sonus-auris/sonus-auris-sync` and `voxletra/voxletra-sync` when their
   external engine/client gitlink pair changes.

This keeps a historical E2E commit replayable while still testing candidate
cross-repository changes before they are merged.
