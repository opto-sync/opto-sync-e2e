# AttoLang sync cursor and retry admission (candidate)

This is a **bounded host-only abstract refinement**, not an SDK or a demonstration of
AttoLang compiler execution. The canonical protocol still lives in the Opto Sync
Quint model, PostgreSQL server, and actual client adapters.

## Coverage and reproduction

Run from the repository root:

```sh
node formal/atto-sync/cursor_retry_model.cjs
node --test formal/atto-sync/cursor_retry_model.test.cjs
```

The model enumerates finite schedules for **two separate tenants**, each with
one fixed mutation identity, and a depth bound of ten. It exercises send,
durable commit, exact correlated ACK, pull cursor, duplicate retry,
lost response, cancel-after-commit, and cross-tenant, future, stale and
precommit denials. Checks require each action to be reachable, reject
mutation of committed state on a denied operation, and preserve monotonic
watermarks, exactly-one effect, and matching in-flight response identity.
The regression suite additionally exhausts malformed tenant, mutation ID
and checkpoint values (including strings, non-integers and null).

`sync_cursor_oracles.atto` expresses the corresponding **source-level**
AttoLang candidate predicates; `self_check()` has positive and negative
cases. Neither the Node model nor its assertions execute this source.
Do not claim real AttoLang guest, Wasm/browser, Java/GraalVM, LLVM,
Forge or .NET NativeAOT parity from this workflow.

## Actual system E2E boundary

`suite/protocol/auth.mjs` runs against the real production-auth
Node/PostgreSQL server in the existing Docker E2E matrix. It now includes
rotated-token mutation-identity conflict tests and adversarial tenant
spoofing headers. These exercise the server, **not** the AttoLang guest.
The existing cross-repository native C core check is still required.

Next gate: run exact-head stepful Docker auth/protocol jobs; then compile
the exact `.atto` candidate using reviewed, pinned compiler/runtime binaries
for each backend, assert results and negative controls, and record source,
compiler, runtime, artifact and run/job SHA provenance. Finally replay
common traces through actual AttoLang client adapters before any SDK or
five-backend support claim. Missing execution is **NOT_EXECUTED**; all
backend certification remains **NOT_CERTIFIED**.

## Live protocol refinement (stacked follow-up)

The existing Docker `protocol` suite now automatically invokes
`suite/protocol/atto-refinement.mjs` after the baseline protocol suite.
The new replay starts by resetting its **test-only** database and requires
`/health` to advertise the actual native sync engine. It verifies:

- two tenants reusing the same record/client/mutation IDs without data leakage;
- a post-commit lost response followed by an identical, durable duplicate;
- a mutated replay rejected as `MUTATION_ID_REUSED` and a forged client rejected;
- exact ACK client/mutation/watermark correlation, monotonic ordered pull pages,
  exact per-tenant change counts, and corresponding snapshots;
- future and malformed pull cursors rejected without moving a checkpoint.

Run the **host-only** negative controls without Docker with:
`node --test suite/protocol/refinement-oracle.test.mjs`.
Run the **real** PostgreSQL/native-server E2E via:
`docker compose --profile protocol up --build --exit-code-from protocol`
in the repository's usual sibling checkout topology.

The default test identity headers are an explicit E2E-mode fixture; they are
**not** a production token/RLS authorization proof. The real replay executes
Node HTTP requests against native-backed protocol handlers, **not** AttoLang
bytecode or any of its five compiler backends. `sync_cursor_oracles.atto` is
still a source candidate. Host-only and real-HTTP evidence must never be
reported as AttoLang guest execution or cross-backend parity.
