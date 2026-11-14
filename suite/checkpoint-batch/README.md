# Checkpoint batch CLI black-box conformance

This suite verifies the actual `opto-sync` CLI's **read-only** checkpoint-batch
validator, rather than restating the policy in JavaScript or running a mocked
client. It does not exercise remote database durability or durable ACK semantics.

The CI job `.github/workflows/checkpoint-batch-cli-e2e.yml` checks out the
reviewed CLI merge commit
`e2e79692edbd4d5f5f934d288b5c8de8c635ddd7`, confirms its exact Git
revision, builds `opto-sync` with `cargo build --locked`, and executes the 17
black-box cases on Node.js 22. All input data is synthetic.

Run locally with an existing Rust CLI binary:

```sh
cargo build --locked --manifest-path ../opto-sync-cli/Cargo.toml --bin opto-sync
OPTO_SYNC_CLI_BIN=../opto-sync-cli/target/debug/opto-sync \
  node suite/checkpoint-batch/run.mjs
```

The suite **fails** when the binary is missing; it never substitutes a
JavaScript checkpoint implementation. It checks successful ordered admission,
duplicate replay, count and final checkpoint, the redacted versioned JSON
envelope, monotonic regression, noncanonical initial and operation checkpoints, invalid IDs, window
exhaustion, malformed JSON, unknown fields, wrong schema, missing required values,
invalid value types, checked u64 overflow, empty and oversized batches, and symlinks escaping the configured trust root. Failed validation
must exit nonzero with no success output; the input must remain byte-identical.

This is a pinned **consumer compatibility gate**, not a moving-branch test.
Update the pinned CLI SHA explicitly after reviewing CLI compatibility changes.
