# AttoLang sync cursor + retry bounded refinement seed

`cursor_retry_model.cjs` explores two tenants, one fixed mutation identity per tenant, response loss, retry, acknowledgement, cursor advancement and cancellation. The model requires positive and negative event witnesses and rejects three deliberately unsafe states.

Safety (within these bounds): a repeated mutation ID cannot increment its durable application count; acknowledgement and pull cursor cannot outrun a committed watermark; cross-tenant and future checkpoints must not authorize. Response loss and cancellation cannot undo an already committed mutation.

`sync_cursor_oracles.atto` is pure AttoLang **source** to use as a future compiler-backed protocol fixture. The model is an admission abstraction, **not** a replay of real clients or servers, and cannot establish database transaction serializability or full cross-runtime convergence. Keep `formal/procedure.toml` as the reviewed machine inventory. Follow up with ITF traces, real HTTP/DB/client E2E, normalization and exact compiler-backed Atto guest receipts; never promote source-free checks to guest evidence.
