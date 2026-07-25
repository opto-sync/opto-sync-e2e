//! CLIENT-IN-THE-LOOP e2e: opto-sync-client against the live node+Postgres server.
//!
//! Scenario numbering and every fixture value are shared verbatim with the
//! TypeScript and Dart suites via ../fixtures/*.json, so uniform behavior across
//! the three clients is provable rather than assumed.
//!
//! Every test that needs the server starts with `skip_if_no_server!()`, which
//! prints a clear reason and returns instead of hanging on a dead socket.

use opto_sync_client::{
    reconcile, InMemoryStore, MutationStatus, MutationStore, OptoSyncClient, ReconcileOptions,
};
use opto_sync_client_e2e::*;
use serde_json::{json, Value};

/// Print a clear reason and return, rather than hanging or failing, when the
/// server is not reachable. Cargo has no first-class runtime skip, so this is the
/// idiomatic pattern; the message is deliberately loud.
macro_rules! skip_if_no_server {
    () => {
        if let Some(reason) = probe_server() {
            eprintln!(
                "[rust] SKIPPING {} — server unavailable: {reason}",
                std::any::type_name_of_val(&|| ())
            );
            return;
        }
    };
}

fn new_client() -> OptoSyncClient<InMemoryStore> {
    // No options are passed anywhere in this suite: ReconcileOptions::default()
    // already IS the server's policy (see test 0), which is the point.
    OptoSyncClient::new(InMemoryStore::new())
}

fn reconcile_via(client: &OptoSyncClient<InMemoryStore>, local: &Value, incoming: &Value) -> Value {
    let merged = client
        .reconcile_incoming(&local.to_string(), &incoming.to_string())
        .expect("reconcile must not fail on valid JSON");
    serde_json::from_str(&merged).expect("the core must return valid JSON")
}

/* ==================================================================== */
/* 0 — the crate's defaults ARE the server's policy                     */
/* ==================================================================== */

#[test]
fn defaults_match_the_server_policy() {
    // The Rust client is correct by default, unlike @opto-sync/client whose
    // DEFAULT_RECONCILE_OPTIONS omits arrayStrategy and so falls back to
    // REPLACE. Asserted because every other test here relies on it.
    let opts = ReconcileOptions::default();
    assert_eq!(opts.array_match_keys, "id");
    assert!(opts.resolve_by_timestamp);
    assert_eq!(opts.lww_keys, "updatedAt,syncedAt");
    assert_eq!(opts.fww_keys, "createdAt");
    assert_eq!(opts.max_depth, 0);
    // ArrayStrategy has no Debug-stable discriminant to compare against, so
    // assert the OBSERVABLE consequence instead: a keyed array is merged by
    // identity, not replaced.
    let merged: Value = serde_json::from_str(
        &reconcile(
            r#"{"rows":[{"id":"r1","label":"local-only"},{"id":"r2","updatedAt":9000,"label":"fresh"}]}"#,
            r#"{"rows":[{"id":"r2","updatedAt":1,"label":"stale"}]}"#,
            &opts,
        )
        .unwrap(),
    )
    .unwrap();
    assert_json_eq(
        &merged,
        &json!({"rows":[{"id":"r1","label":"local-only"},{"id":"r2","updatedAt":9000,"label":"fresh"}]}),
        "default options must MERGE_BY_KEY on id and reject the stale element",
    );

    assert!(
        opto_sync_client::core_version().as_str() >= "0.2.0",
        "the v0.2.0 core is required"
    );
}

/* ==================================================================== */
/* Scenario 1 — offline queue -> flush -> server merge                  */
/* ==================================================================== */

#[test]
fn scenario_1a_offline_queue_flushed_individually() {
    skip_if_no_server!();
    let fx = scenario("offlineQueue");
    let id = doc_id(field_str(fx, "docSuffixIndividual"));
    put_doc(&id, field(fx, "base"));

    let mut client = new_client();
    let mut routes = Routes::new();
    let mutations = field(fx, "mutations").as_array().unwrap();

    // "Offline": queue everything, send nothing.
    let queued: Vec<u64> = mutations
        .iter()
        .map(|m| routes.queue(&mut client, &id, m))
        .collect();

    assert_eq!(
        client.store().pending().len(),
        mutations.len(),
        "all mutations must be queued as pending"
    );
    assert_eq!(
        status_counts(&client),
        StatusCounts { total: 3, pending: 3, synced: 0, failed: 0 },
        "nothing may be marked synced before a flush"
    );
    assert!(
        get_doc_data(&id).get("m1").is_none(),
        "server must be untouched while offline"
    );

    // Back online: flush in queue order.
    for mutation_id in &queued {
        let res = flush_one(&mut client, &routes, *mutation_id);
        assert_eq!(res.status, 200, "sync of mutation {mutation_id}: {}", res.body);
        let body = res.json();
        assert_eq!(body.get("merged"), Some(&Value::Bool(true)));
        assert_eq!(
            body.get("mergedWith").and_then(Value::as_str),
            Some("native-c-ffi"),
            "the server must merge with the C core"
        );
    }

    assert!(client.store().pending().is_empty(), "queue must be drained");
    assert_eq!(
        status_counts(&client),
        StatusCounts { total: 3, pending: 0, synced: 3, failed: 0 }
    );

    assert_json_eq(
        &get_doc_data(&id),
        field(fx, "expected"),
        "server document after individual flush",
    );
}

#[test]
fn scenario_1b_offline_queue_flushed_via_batch() {
    skip_if_no_server!();
    let fx = scenario("offlineQueue");
    let id = doc_id(field_str(fx, "docSuffixBatch"));
    put_doc(&id, field(fx, "base"));

    let mut client = new_client();
    let mut routes = Routes::new();
    for m in field(fx, "mutations").as_array().unwrap() {
        routes.queue(&mut client, &id, m);
    }

    let pending = client.store().pending();
    assert_eq!(pending.len(), 3);

    let batch: Vec<(String, Value)> = pending
        .iter()
        .map(|m| (id.clone(), serde_json::from_str(&m.payload).unwrap()))
        .collect();
    let result = sync_batch(batch);
    assert_eq!(
        result.get("applied").and_then(Value::as_u64),
        Some(3),
        "all three mutations must apply: {result}"
    );

    for m in &pending {
        assert!(client.store_mut().mark_synced(m.id));
    }
    assert_eq!(
        status_counts(&client),
        StatusCounts { total: 3, pending: 0, synced: 3, failed: 0 }
    );

    assert_json_eq(
        &get_doc_data(&id),
        field(fx, "expected"),
        "server document after batch flush",
    );
}

/* ==================================================================== */
/* Scenario 2 — optimistic local write, then pull-back reconcile        */
/* ==================================================================== */

#[test]
fn scenario_2_optimistic_write_then_pullback() {
    skip_if_no_server!();
    let fx = scenario("optimisticPullback");
    let id = doc_id(field_str(fx, "docSuffix"));
    put_doc(&id, field(fx, "base"));

    let mut client = new_client();
    let mut routes = Routes::new();

    // Optimistic: apply the mutation to the local copy through the crate's own
    // reconcile path (NOT a hand-rolled merge) before any network I/O.
    let local_after_optimistic = reconcile_via(&client, field(fx, "base"), field(fx, "mutation"));
    assert_json_eq(
        &local_after_optimistic,
        field(fx, "expected"),
        "local copy after optimistic apply",
    );

    // Push, then pull the server's own view back.
    let mid = routes.queue(&mut client, &id, field(fx, "mutation"));
    let res = flush_one(&mut client, &routes, mid);
    assert_eq!(res.status, 200, "{}", res.body);

    let server_data = get_doc_data(&id);
    assert_json_eq(&server_data, field(fx, "expected"), "server document after push");

    // Reconcile the pulled server state back into the local copy.
    let local_after_pullback = reconcile_via(&client, &local_after_optimistic, &server_data);
    assert_json_eq(
        &local_after_pullback,
        &server_data,
        "local copy after pull-back vs server",
    );
    assert_json_eq(
        &local_after_pullback,
        field(fx, "expected"),
        "local copy after pull-back vs expectation",
    );

    // The stored jsonb text is NOT the string we sent — proof that comparing raw
    // strings would be wrong, and that we never do.
    let raw: Value = serde_json::from_str(&get_doc_raw(&id)).unwrap();
    assert_json_eq(&raw, field(fx, "expected"), "raw jsonb text parses to the same value");
}

/* ==================================================================== */
/* Scenario 3 — stale-write rejection round-trip, both directions       */
/* ==================================================================== */

#[test]
fn scenario_3_stale_rejection_round_trip() {
    skip_if_no_server!();
    let fx = scenario("staleRejection");
    let id = doc_id(field_str(fx, "docSuffix"));
    let client = new_client();

    // Server holds an OLDER state than the local copy.
    put_doc(&id, field(fx, "serverStale"));
    let stale = get_doc_data(&id);
    assert_json_eq(&stale, field(fx, "serverStale"), "server precondition (stale)");

    let survived = reconcile_via(&client, field(fx, "local"), &stale);
    assert_json_eq(
        &survived,
        field(fx, "expectedLocalSurvives"),
        "local value must survive a stale server pull",
    );
    assert!(
        survived.get("sOnly").is_none(),
        "whole-object rejection: no key from the stale doc may leak in"
    );

    // Now the server holds a NEWER state.
    put_doc(&id, field(fx, "serverFresh"));
    let fresh = get_doc_data(&id);
    let overwritten = reconcile_via(&client, field(fx, "local"), &fresh);
    assert_json_eq(
        &overwritten,
        field(fx, "expectedServerWins"),
        "fresher server state must win",
    );
    assert_eq!(
        overwritten.get("lOnly").and_then(Value::as_str),
        Some("local-marker"),
        "the accepted merge must descend and keep local-only keys"
    );
}

/* ==================================================================== */
/* Scenario 4 — keyed-array reconciliation through the full stack       */
/* ==================================================================== */

#[test]
fn scenario_4_keyed_array_through_full_stack() {
    skip_if_no_server!();
    let fx = scenario("keyedArray");
    let id = doc_id(field_str(fx, "docSuffix"));
    put_doc(&id, field(fx, "base"));

    let mut client = new_client();
    let mut routes = Routes::new();
    let local_copy = reconcile_via(&client, field(fx, "base"), field(fx, "mutation"));
    assert_json_eq(
        &local_copy,
        field(fx, "expected"),
        "client-side keyed-array reconcile",
    );

    let mid = routes.queue(&mut client, &id, field(fx, "mutation"));
    assert_eq!(flush_one(&mut client, &routes, mid).status, 200);

    let server_data = get_doc_data(&id);
    assert_json_eq(&server_data, field(fx, "expected"), "server keyed-array merge");

    let rows = server_data.get("rows").and_then(Value::as_array).unwrap();
    let row = |id: &str| rows.iter().find(|r| r.get("id").and_then(Value::as_str) == Some(id));
    assert_eq!(rows.len(), 4, "exactly one new identity may be appended");
    assert_eq!(
        rows.iter()
            .filter(|r| r.get("id").and_then(Value::as_str) == Some("r4"))
            .count(),
        1,
        "r4 must not be duplicated"
    );
    assert_eq!(
        rows[3].get("id").and_then(Value::as_str),
        Some("r4"),
        "a new identity is appended at the END of the base array"
    );
    assert_eq!(
        row("r3").unwrap().get("label").and_then(Value::as_str),
        Some("server-fresh"),
        "the stale element must not be applied"
    );
    assert_eq!(
        row("r1").unwrap().get("label").and_then(Value::as_str),
        Some("untouched"),
        "the untouched element must be preserved"
    );

    // And the client's reconcile of the pulled state agrees.
    assert_json_eq(
        &reconcile_via(&client, &local_copy, &server_data),
        field(fx, "expected"),
        "client reconcile of the pulled keyed array",
    );
}

/* ==================================================================== */
/* Scenario 5 — replay / retry idempotency                             */
/* ==================================================================== */

#[test]
fn scenario_5_replay_idempotency() {
    skip_if_no_server!();
    let fx = scenario("replayIdempotency");
    let id = doc_id(field_str(fx, "docSuffix"));
    put_doc(&id, field(fx, "base"));

    let mut client = new_client();
    let mut routes = Routes::new();
    let mid = routes.queue(&mut client, &id, field(fx, "mutation"));
    let payload: Value =
        serde_json::from_str(&client.store().pending()[0].payload).unwrap();

    // First flush.
    assert_eq!(sync_doc(&id, &payload).status, 200);
    let after_first = get_doc_row(&id);
    assert_json_eq(
        after_first.get("data").unwrap(),
        field(fx, "expected"),
        "document after first flush",
    );

    // Ambiguous network failure: the client never learned the first attempt
    // landed, so it replays the very same payload.
    assert_eq!(sync_doc(&id, &payload).status, 200);
    let after_second = get_doc_row(&id);

    let v1 = after_first.get("version").and_then(Value::as_u64).unwrap();
    let v2 = after_second.get("version").and_then(Value::as_u64).unwrap();
    assert!(v2 > v1, "the replay must really have written (version {v1} -> {v2})");

    assert_json_eq(
        after_second.get("data").unwrap(),
        after_first.get("data").unwrap(),
        "replay must not change the document",
    );
    assert_json_eq(
        after_second.get("data").unwrap(),
        field(fx, "expected"),
        "document after replay",
    );
    let data = after_second.get("data").unwrap();
    assert_eq!(
        data.get("tags").and_then(Value::as_array).unwrap().len(),
        2,
        "identity-less array elements must not duplicate on replay"
    );
    assert_eq!(
        data.get("rows").and_then(Value::as_array).unwrap().len(),
        2,
        "keyed array elements must not duplicate on replay"
    );

    assert!(client.store_mut().mark_synced(mid));
    assert_eq!(
        status_counts(&client),
        StatusCounts { total: 1, pending: 0, synced: 1, failed: 0 }
    );
}

/* ==================================================================== */
/* Scenario 6 — failure marking                                        */
/* ==================================================================== */

#[test]
fn scenario_6_failure_marking() {
    skip_if_no_server!();
    let fx = scenario("failureMarking");
    let missing_id = doc_id(field_str(fx, "missingSuffix"));
    let ok_id = doc_id(field_str(fx, "okSuffix"));
    put_doc(&ok_id, field(fx, "okBase"));

    let mut client = new_client();
    let mut routes = Routes::new();
    let doomed = routes.queue(&mut client, &missing_id, field(fx, "mutationDoomed"));

    let res = flush_one(&mut client, &routes, doomed);
    assert_eq!(
        res.status, 404,
        "the server must reject an unknown document: {}",
        res.body
    );

    assert_eq!(
        status_counts(&client),
        StatusCounts { total: 1, pending: 0, synced: 0, failed: 1 },
        "the failed mutation must be FAILED and must not count as pending or synced"
    );
    assert_eq!(client.store().all()[0].status, MutationStatus::Failed);

    // A subsequent good mutation must not inherit the failure.
    let good = routes.queue(&mut client, &ok_id, field(fx, "mutationOk"));
    assert_eq!(
        status_counts(&client),
        StatusCounts { total: 2, pending: 1, synced: 0, failed: 1 },
        "pending/failed accounting must be per-mutation"
    );
    assert_eq!(flush_one(&mut client, &routes, good).status, 200);

    assert_eq!(
        status_counts(&client),
        StatusCounts { total: 2, pending: 0, synced: 1, failed: 1 },
        "final accounting: one synced, one failed, nothing pending"
    );
    assert_json_eq(
        &get_doc_data(&ok_id),
        field(fx, "expectedOk"),
        "the good mutation still landed",
    );
}
