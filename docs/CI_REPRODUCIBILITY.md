# Cross-repository CI reproducibility

The E2E repository certifies an exact engine/client pair rather than following
mutable upstream branches:

- `opto-sync/syncer.c@7795ce2d1342e17d934d2faafff5c8ed4322609e`
- `opto-sync/opto-sync-clients@54874e9f7df6009fccd9034fce39306daef2c043`

The client repository contains its own root `syncer.c` git submodule. E2E also
checks out `syncer.c` separately because the server images build from the sibling
repository layout. Before any test starts, both workflows require all three
identities to agree:

1. the `syncer.c` gitlink recorded by the client commit;
2. the recursively initialized `opto-sync-clients/syncer.c` commit; and
3. the separately checked-out server `syncer.c` commit.

This prevents a green run in which the clients and servers quietly use different
reconciliation engines.

A manual `workflow_dispatch` may override `syncer_ref` and `clients_ref` for a
candidate compatibility run. Both values must describe a matching pair: if the
candidate client gitlink and server ref differ, the workflow fails before build
or test code executes.

## Security and integrity controls

- Every checkout uses `persist-credentials: false`.
- The client checkout uses `submodules: recursive` and verifies its mode-160000
  gitlink against the initialized nested repository.
- Node dependencies use committed locks through `npm ci`.
- The Rust fixture graph is fetched through `cargo fetch --locked`; CI never
  regenerates its lockfile.
- `.env` values are never printed to Actions logs.
- The default and Supabase Compose graphs are validated before startup.
- `scripts/check-ci-contract.py` ratchets the exact certified SHAs, recursive
  checkout, gitlink equality checks, secret handling, locked installs, Compose
  preflight, and the Zed dependency graph.

## Test gates

The Docker workflow runs ten independent suites covering the full multi-runtime
stack, protocol ordering and idempotency, subject/client and tenant isolation,
Supabase-compatible JWT verification, quotas and metrics, concurrency and
latency, migrations and backup/restore, cross-server convergence, and the
PostgREST/Supabase path.

The client-in-the-loop workflow additionally runs the real TypeScript, Dart,
Rust, and Gleam libraries against a native-core Node/Postgres server, including
browser IndexedDB, process-restart recovery, protocol behavior, and cross-client
convergence.

## Zed package relationship

The E2E source package records compatible ranges for
`opto-sync/syncer@^0.2.1` and `opto-sync/opto-sync-clients@^0.2.0`. Those ranges
express release compatibility; the workflow SHAs identify the exact source pair
certified by this E2E commit.

## Coordinated compatibility and release process

When the engine, client gitlink, package boundary, ABI, or protocol changes:

1. Push upstream feature branches.
2. Dispatch both E2E workflows with the exact candidate engine and client refs.
3. Require the static contract, all ten Docker suites, and the live four-client
   suite to pass.
4. Merge the engine, then clients, then this E2E pin update.
5. Publish Zed packages in the same dependency order.
6. Update downstream consumers such as `sonus-auris/sonus-auris-sync` and
   `voxletra/voxletra-sync`, using recursive submodule initialization so the
   clients' nested core is present.

This keeps every historical E2E commit replayable and makes the complete engine
provenance explicit from downstream parent repository to clients to native core.
