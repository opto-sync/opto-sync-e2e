# AttoLang sync cursor + retry bounded refinement seed

`cursor_retry_model.cjs` explores two tenants, one fixed mutation identity per tenant, response loss, retry, acknowledgement, cursor advancement and cancellation. The model requires positive and negative event witnesses and rejects three deliberately unsafe states.

Safety (within these bounds): a repeated mutation ID cannot increment its durable application count; acknowledgement and pull cursor cannot outrun a committed watermark; cross-tenant and future checkpoints must not authorize. Response loss and cancellation cannot undo an already committed mutation.

`sync_cursor_oracles.atto` is pure AttoLang **source** to use as a future compiler-backed protocol fixture. The model is an admission abstraction, **not** a replay of real clients or servers, and cannot establish database transaction serializability or full cross-runtime convergence. Keep `formal/procedure.toml` as the reviewed machine inventory. Follow up with ITF traces, real HTTP/DB/client E2E, normalization and exact compiler-backed Atto guest receipts; never promote source-free checks to guest evidence.

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
