# Linear ticket drafts (team DEN)

Ready to file. Written 2026-08-01 from verified session evidence — every claim
below was reproduced or measured, not inferred.

**Why this file exists:** the `linear` / `linear-readonly` MCP servers are
configured in `~/.claude.json` but were not connected in the session that wrote
this, and `LINEAR_API_KEY` is unset (so `scripts/canary_delivery_linear.py` also
fails its own `"LINEAR_API_KEY is required for live delivery"` guard). Filing is
blocked on either reconnecting MCP via `/mcp` in an interactive session, or
exporting the key. Delete this file once the tickets exist.

---

## 1. CLOSE — DEN-587: Gleam client fails to compile

**Status:** fixed, verified. Close it.

`opto-sync-clients/clients/gleam/src/opto_sync_formal_projection.gleam` called
`decode.field` positionally with 3 args. It is continuation-style — every other
call site in the repo uses `use x <- decode.field(...)`.

Impact was larger than a compile error: the failure cascaded into **silently
skipping the entire cross-client convergence phase** of the e2e client suite.
After the fix, `suite/clients/run_all.sh` went from 1-of-7 steps failing to
**14/14 passing**.

Upstream independently landed `4c1ec11` with a byte-identical tree.

---

## 2. NEW — `createdAt` removed from the default merge policy (behavioral change)

**Priority: high.** Adopters must know; this changes merge results.

First-write-wins in the C core is a **node-level veto**, not field protection.
`should_reject_by_crdt_rules` discards the *entire* incoming node when its FWW
key is newer, regardless of `updatedAt`. Verified repro:

```
base     {"createdAt":100,"updatedAt":100,"v":"base"}
incoming {"createdAt":200,"updatedAt":999999,"v":"NEWEST WRITE"}
result   {"createdAt":100,"updatedAt":100,"v":"base"}   ← newest write discarded
```

Consequence: any replica holding a later `createdAt` for a record could **never
write to that record again** — permanently, silently, behind a `200 OK`. Two
devices creating the same id offline guarantees it. `createdAt` was in the
*default* policy, so this shipped to everyone.

**Change:** removed from the default in 3 clients, 5 servers, and 9 plugins. FWW
remains fully supported as an explicit opt-in (`FWW_POLICY`, `fwwOptions()`),
and no coverage was deleted — the FWW *behaviour* tests now pass the key
explicitly. Regression tests using the repro exist in 5 places (gorm, diesel,
sqlx, seaorm, TS core-contract).

**Migration note for adopters:** if you relied on `createdAt` FWW, pass
`fwwKeys: "createdAt"` explicitly — and read the veto semantics first, because
it probably is not doing what you think.

Docs: `syncer.c/docs/MERGE_SEMANTICS.md` (FWW callout), `docs/PLUGINS.md`.

---

## 3. NEW — Hybrid logical clocks for `updatedAt` in all clients

**Priority: high.** Correctness of last-write-wins depended on this.

Clients previously trusted whatever `updatedAt` the application supplied. Of
~12 sync engines surveyed (Electric, PowerSync, Zero/Replicache, Triplit, RxDB,
WatermelonDB, Dexie, Evolu, cr-sqlite, Automerge, Yjs, Figma/Linear), **none**
order writes by a client wall clock. RxDB states it outright: *"client side
clocks can never be trusted."* PowerSync's docs describe our exact former design
and name the failure mode.

Three concrete failures fixed:
- **Skew** — a device 5 minutes fast wins every conflict permanently.
- **Rollback** — an NTP correction makes a device's later edits lose to its own
  earlier ones and vanish.
- **Ties** — equal timestamps are "neither newer", so arrival order decides and
  replicas diverge.

**Change:** all three clients stamp from an HLC with a byte-identical wire
format `<13-digit millis>-<4-hex counter>-<nodeId>` (fixed width because the
core compares non-digit strings lexicographically). Node id is a durable device
id **plus a per-instance suffix** — several writers can share one store, and a
purely persisted id lets two of them emit identical timestamps. `observe()`
refuses remote timestamps beyond a 60s drift bound (`ClockDriftError`);
without a bound, one broken or hostile clock poisons every peer permanently.

**Watch item:** mixing timestamp *formats* is dangerous — ISO-8601 sorts above
an HLC string lexicographically until 2286, so an ISO writer would beat an HLC
writer on every conflict. All clients must stamp, or none.

---

## 4. COMMENT — DEN-309 (mutation layer blocked)

`DOWNSTREAM_BUMP_PLANNER.md` records the mutation layer as blocked by DEN-309.
That may need re-evaluating: the layer now has HLC-ordered timestamps with a
bounded drift check, and the FWW veto that could permanently lock a replica out
of a record is gone. Worth confirming what "blocked" still refers to.

---

## 5. NEW — The real remaining gap: this is not yet a sync engine

**Priority: medium (architectural).** Full analysis in
`opto-sync-clients/docs/SYNC_PATTERNS.md`.

opto-sync is a shared conflict-resolution engine plus a durable write queue —
genuinely unusual (one C engine, byte-identical across languages, per-element
identity inside jsonb arrays). It is **not** a complete sync engine. Missing,
each with the failure it causes:

| Gap | Failure without it |
|---|---|
| Server-issued ack watermark (per-client monotonic id, committed atomically with the effect) | retries double any non-idempotent effect — counters, list appends, side effects |
| Commit-order pull cursor (LSN / `xid8`, **not** `updatedAt >`) | a transaction committing after the cursor advanced is invisible forever |
| Element-level tombstones | `MERGE_BY_KEY` cannot express removal, so deleted array elements resurrect |
| Divergence detection + reset path | silent permanent divergence with no repair |
| Rejection as a queue state | merge is a total function, so "the server said no" has nowhere to live |

**Structural limit to decide on explicitly:** intent is erased. Two offline
clients each incrementing 5 merge to 6; no timestamp discipline recovers 7. Zero
and Replicache avoid this by shipping *function calls* the server re-executes.
Note Electric shipped a CRDT engine — from the team that invented rich CRDTs for
Postgres — and abandoned it in 2024 for server authority, on complexity grounds.

The decision this ticket should force: does opto-sync stay a conflict-resolution
engine that applications compose into their own sync loop, or grow into a full
engine (pending layer, cursor, watermark, rebase, reset)?
