# Formal-methods change procedure

This repository is where abstract opto-sync protocol claims meet real servers, databases, clients, authentication, crashes, retries, and multiple runtimes. Its formal role is implementation and system refinement: replay model traces through production boundaries and explain every divergence. It is not a second source of protocol semantics.

The checked inventory is [`procedure.toml`](procedure.toml).

## Change procedure

1. Map every changed protocol route, database transition, client behavior, or fault injection to an inventory machine before implementation.
2. Generate traces from the language-neutral protocol model; do not hand-edit traces to favor one server or client. Record model revision, seed, bounds, and trace hash.
3. Replay the same trace across applicable servers and clients. Compare canonical protocol observations—ledger outcome, mutation watermark, pending/confirmed IDs, checkpoint, snapshot, tombstone, tenant, and response class—not incidental JSON ordering or internal tables.
4. Treat transport loss and commit loss separately. A committed mutation whose response vanished must be retried with the same immutable identity; an uncommitted request may be retried without inventing an outcome.
5. Isolate every trace with a fresh tenant/database namespace and deterministic clock/IDs. Clean up even after failure.
6. Run small deterministic model traces on pull requests and wider concurrency, compaction, recovery, auth, and cross-runtime schedules periodically.
7. Publish exact revisions for this repository, `syncer.c`, `opto-sync-clients`, server images, schemas, model, and toolchain.

## Claim language

Allowed claims are **typechecked specification**, **randomized exploration**, **bounded exhaustive verification**, **implementation replay**, **differential replay**, and **unbounded proof**. End-to-end success establishes conformance only for the supplied trace corpus, topology, revisions, database isolation level, and fault schedule. It does not prove Kubernetes, the internet, every PostgreSQL schedule, or every client platform.

## Counterexamples

Retain the original model trace, normalized trace, full service logs, canonical expected/actual states, topology and image digests. Minimize while preserving the failure, then classify model, adapter, server, client, storage, authentication, or environment defect. Add the smallest deterministic regression to the relevant suite and retain the minimized trace under `formal/regressions/`. Do not resolve a divergence by teaching the adapter to ignore a correctness-relevant field.

## Required review triggers

Formal review is mandatory for protocol push/pull/snapshot semantics, mutation identity, acknowledgement, rejection or duplicate classification, checkpoint/compaction, tombstones, tenant/client binding, authentication, rate/size limits that alter reachable behavior, concurrency/load fixtures, cross-server merge policy, client-in-loop behavior, database recovery, or trace normalization.

## System boundaries

The E2E suite should distinguish:

- design-model verification from implementation replay;
- server protocol state from merge-engine document semantics;
- client durable queue state from network-driver state;
- authenticated identity from caller-supplied identifiers;
- database commit from HTTP response delivery; and
- semantic convergence from byte identity where host numeric limits are documented.
