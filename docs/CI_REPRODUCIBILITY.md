# Cross-repository CI reproducibility

The E2E repository builds and runs code from three repositories in one sibling
layout. Ordinary pull-request and `main` CI must therefore identify all three
revisions, not silently follow mutable upstream branches.

Both E2E workflows pin:

- `SYNCER_C_REF` to an exact 40-hex `opto-sync/syncer.c` commit.
- `CLIENTS_REF` to an exact 40-hex `opto-sync/opto-sync-clients` commit.

A `workflow_dispatch` run may override either ref with `main`, a feature branch,
or a candidate SHA. That path is for deliberate forward-compatibility testing;
it does not change the reproducible defaults for the commit under review.

## Security and integrity controls

- Every checkout uses `persist-credentials: false` before package-manager,
  compiler, Compose, or test code executes.
- Node dependencies are installed with `npm ci` from committed lockfiles.
- The tracked Rust fixture lockfile is fetched with `cargo fetch --locked`; CI
  never regenerates it.
- `.env` contents are never printed to Actions logs. Workflows may report that
  the file exists, but values remain redacted.
- Compose configuration is validated before any containers start.
- `scripts/check-ci-contract.py` statically ratchets these requirements.

## Coordinated compatibility test

When either upstream repository changes a shared ABI, path layout, or protocol:

1. Push the upstream feature branches.
2. Manually dispatch both E2E workflows with `syncer_ref` and/or `clients_ref`
   set to those exact feature refs.
3. Require the Docker matrix and client-in-the-loop suite to pass.
4. Merge upstream in dependency order.
5. Update the pinned SHAs here in a pull request and rerun the full matrix.

This keeps a historical E2E commit replayable while still testing candidate
cross-repository changes before they are merged.
