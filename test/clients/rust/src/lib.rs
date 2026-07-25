//! Shared support for the opto-sync-client client-in-the-loop e2e suite.
//!
//! The crate under test ships no transport, so the transport lives here. What is
//! under test is the crate's own queue lifecycle (`MutationStore`:
//! Pending -> Synced/Failed) and its `reconcile` output, driven against a REAL
//! server that merges with the same syncer.c core, over HTTP, with the document
//! round-tripping through Postgres jsonb.

use std::collections::BTreeMap;
use std::sync::OnceLock;
use std::time::Duration;

use serde_json::{json, Map, Value};

pub const LANG: &str = "rust";

/// `test/clients/rust` — resolved at compile time so any cwd works.
pub const MANIFEST_DIR: &str = env!("CARGO_MANIFEST_DIR");

pub fn base_url() -> &'static str {
    static URL: OnceLock<String> = OnceLock::new();
    URL.get_or_init(|| {
        let raw = std::env::var("OPTO_SYNC_SERVER_URL")
            .unwrap_or_else(|_| "http://localhost:3003".to_string());
        raw.trim_end_matches('/').to_string()
    })
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                           */
/* ------------------------------------------------------------------ */

fn load_fixture(name: &str) -> Value {
    let path = std::path::Path::new(MANIFEST_DIR).join("../fixtures").join(name);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read fixture {}: {e}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|e| panic!("fixture {} is not valid JSON: {e}", path.display()))
}

pub fn scenarios() -> &'static Value {
    static FX: OnceLock<Value> = OnceLock::new();
    FX.get_or_init(|| load_fixture("scenarios.json"))
}

pub fn cross_client() -> &'static Value {
    static FX: OnceLock<Value> = OnceLock::new();
    FX.get_or_init(|| load_fixture("cross_client.json"))
}

/// One scenario block out of `scenarios.json`.
pub fn scenario(name: &str) -> &'static Value {
    scenarios()
        .get("scenarios")
        .and_then(|s| s.get(name))
        .unwrap_or_else(|| panic!("scenarios.json has no scenario \"{name}\""))
}

/// A required field of a fixture block.
pub fn field<'a>(fx: &'a Value, key: &str) -> &'a Value {
    fx.get(key)
        .unwrap_or_else(|| panic!("fixture is missing required key \"{key}\""))
}

pub fn field_str<'a>(fx: &'a Value, key: &str) -> &'a str {
    field(fx, key)
        .as_str()
        .unwrap_or_else(|| panic!("fixture key \"{key}\" is not a string"))
}

/// Namespaced document id so the three language suites never collide.
pub fn doc_id(suffix: &str) -> String {
    format!("{}-{}-{}", field_str(scenarios(), "docIdPrefix"), LANG, suffix)
}

/* ------------------------------------------------------------------ */
/* HTTP                                                               */
/* ------------------------------------------------------------------ */

pub struct HttpResult {
    pub status: u16,
    pub body: String,
}

impl HttpResult {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
    /// Parsed body. Panics on unparseable JSON — every endpoint used here
    /// returns JSON, so that would be a real failure worth surfacing loudly.
    pub fn json(&self) -> Value {
        serde_json::from_str(&self.body)
            .unwrap_or_else(|e| panic!("response body is not JSON ({e}): {}", self.body))
    }
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(3))
        .timeout(Duration::from_secs(10))
        .build()
}

/// Any HTTP status is a value, never an error: failure-marking scenarios need to
/// inspect a 404 the way a client would. Only transport failures are `Err`.
fn request(method: &str, path: &str, body: Option<&Value>) -> Result<HttpResult, String> {
    let url = format!("{}{}", base_url(), path);
    let mut req = agent().request(method, &url);
    let outcome = match body {
        Some(v) => {
            req = req.set("Content-Type", "application/json");
            req.send_string(&serde_json::to_string(v).map_err(|e| e.to_string())?)
        }
        None => req.call(),
    };
    match outcome {
        Ok(res) => {
            let status = res.status();
            let text = res.into_string().map_err(|e| e.to_string())?;
            Ok(HttpResult { status, body: text })
        }
        Err(ureq::Error::Status(status, res)) => {
            let text = res.into_string().unwrap_or_default();
            Ok(HttpResult { status, body: text })
        }
        Err(ureq::Error::Transport(t)) => Err(t.to_string()),
    }
}

fn encode_component(s: &str) -> String {
    // Document ids in this suite are `[A-Za-z0-9-]`; anything else is a
    // fixture bug worth failing on rather than silently mangling.
    assert!(
        s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
        "document id {s:?} needs percent-encoding; keep fixture ids URL-safe"
    );
    s.to_string()
}

/// Probe the server. `None` when healthy, otherwise a human-readable reason so
/// the suite SKIPs with a clear message instead of hanging on a dead socket.
pub fn probe_server() -> Option<String> {
    let res = match request("GET", "/health", None) {
        Ok(r) => r,
        Err(e) => {
            return Some(format!(
                "{} is unreachable ({e}). Start the stack \
                 (docker compose up -d postgres node) or set OPTO_SYNC_SERVER_URL.",
                base_url()
            ))
        }
    };
    if !res.ok() {
        return Some(format!("{}/health returned HTTP {}", base_url(), res.status));
    }
    let health = res.json();
    if health.get("status").and_then(Value::as_str) != Some("ok") {
        return Some(format!(
            "{}/health reported status={:?}",
            base_url(),
            health.get("status")
        ));
    }
    match health.get("syncer").and_then(Value::as_str) {
        Some("native") => None,
        other => Some(format!(
            "server is running the {other:?} merge, not the native syncer.c core \
             — client/server convergence would be meaningless"
        )),
    }
}

/// Create-or-replace a document outright (test setup, not a merge).
pub fn put_doc(id: &str, payload: &Value) {
    let res = request("PUT", &format!("/doc/{}", encode_component(id)), Some(payload))
        .unwrap_or_else(|e| panic!("PUT /doc/{id}: {e}"));
    assert!(res.ok(), "PUT /doc/{id} failed: HTTP {} {}", res.status, res.body);
}

/// The full row: `{ id, data, version, updated_at, deleted_at }`.
pub fn get_doc_row(id: &str) -> Value {
    let res = request("GET", &format!("/doc/{}", encode_component(id)), None)
        .unwrap_or_else(|e| panic!("GET /doc/{id}: {e}"));
    assert!(res.ok(), "GET /doc/{id} failed: HTTP {} {}", res.status, res.body);
    res.json()
}

/// The parsed document body (the jsonb `data` column).
pub fn get_doc_data(id: &str) -> Value {
    get_doc_row(id)
        .get("data")
        .cloned()
        .unwrap_or_else(|| panic!("GET /doc/{id} returned no `data`"))
}

/// Exact stored jsonb text — proves the suite never depends on key ordering.
pub fn get_doc_raw(id: &str) -> String {
    let res = request("GET", &format!("/doc/{}/raw", encode_component(id)), None)
        .unwrap_or_else(|e| panic!("GET /doc/{id}/raw: {e}"));
    assert!(res.ok(), "GET /doc/{id}/raw failed: HTTP {}", res.status);
    res.body
}

pub fn sync_doc(id: &str, payload: &Value) -> HttpResult {
    request("POST", &format!("/doc/{}/sync", encode_component(id)), Some(payload))
        .unwrap_or_else(|e| panic!("POST /doc/{id}/sync: {e}"))
}

/// POST /sync/batch — the shape an offline queue flushes in.
pub fn sync_batch(mutations: Vec<(String, Value)>) -> Value {
    let body = json!({
        "mutations": mutations
            .into_iter()
            .map(|(doc_id, payload)| json!({ "docId": doc_id, "payload": payload }))
            .collect::<Vec<_>>()
    });
    let res = request("POST", "/sync/batch", Some(&body))
        .unwrap_or_else(|e| panic!("POST /sync/batch: {e}"));
    assert!(res.ok(), "POST /sync/batch failed: HTTP {} {}", res.status, res.body);
    res.json()
}

/* ------------------------------------------------------------------ */
/* Semantic comparison                                                */
/* ------------------------------------------------------------------ */

/// Sort every array-of-objects-with-`id` by id, recursively.
///
/// MERGE_BY_KEY matches array elements by IDENTITY, not position, so when a
/// client merges the server's document into a local copy that started with a
/// different subset of identities the resulting order legitimately differs while
/// the identity set and every element's content must match exactly. Only used
/// where order is genuinely undetermined; the server document is compared
/// strictly.
pub fn normalize_keyed_arrays(value: &Value) -> Value {
    match value {
        Value::Array(items) => {
            let mut mapped: Vec<Value> = items.iter().map(normalize_keyed_arrays).collect();
            let all_keyed = !mapped.is_empty()
                && mapped
                    .iter()
                    .all(|v| v.as_object().is_some_and(|o| o.contains_key("id")));
            if all_keyed {
                mapped.sort_by_key(|v| ident_of(v));
            }
            Value::Array(mapped)
        }
        Value::Object(obj) => {
            // serde_json::Map is a BTreeMap here (preserve_order is off), so
            // rebuilding it also normalizes key order.
            let mut out = Map::new();
            for (k, v) in obj {
                out.insert(k.clone(), normalize_keyed_arrays(v));
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

fn ident_of(v: &Value) -> String {
    match v.get("id") {
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

fn render(value: &Value) -> String {
    serde_json::to_string_pretty(&normalize_keyed_arrays(value)).unwrap_or_else(|_| value.to_string())
}

/// Structural equality over PARSED JSON. Postgres jsonb reorders object keys, so
/// raw strings are never compared anywhere in this suite.
#[track_caller]
pub fn assert_json_eq(actual: &Value, expected: &Value, what: &str) {
    if actual == expected {
        return;
    }
    panic!(
        "{what}: parsed values differ.\n--- expected ---\n{}\n--- actual ---\n{}",
        render(expected),
        render(actual)
    );
}

/// Deep equality that treats keyed arrays as identity sets.
#[track_caller]
pub fn assert_json_eq_keyed(actual: &Value, expected: &Value, what: &str) {
    let a = normalize_keyed_arrays(actual);
    let e = normalize_keyed_arrays(expected);
    if a == e {
        return;
    }
    panic!(
        "{what}: parsed values differ (keyed arrays normalized by id).\n\
         --- expected ---\n{}\n--- actual ---\n{}",
        render(&e),
        render(&a)
    );
}

/* ------------------------------------------------------------------ */
/* Queue accounting                                                   */
/* ------------------------------------------------------------------ */

use opto_sync_client::{InMemoryStore, MutationStatus, MutationStore, OptoSyncClient};

#[derive(Debug, PartialEq, Eq)]
pub struct StatusCounts {
    pub total: usize,
    pub pending: usize,
    pub synced: usize,
    pub failed: usize,
}

pub fn status_counts(client: &OptoSyncClient<InMemoryStore>) -> StatusCounts {
    let all = client.store().all();
    StatusCounts {
        total: all.len(),
        pending: all.iter().filter(|m| m.status == MutationStatus::Pending).count(),
        synced: all.iter().filter(|m| m.status == MutationStatus::Synced).count(),
        failed: all.iter().filter(|m| m.status == MutationStatus::Failed).count(),
    }
}

/// Routing table from queued mutation id -> target document id.
///
/// `opto-sync-client`'s `Mutation` records only `{ id, payload, status }` — no
/// table/record identity, unlike the TypeScript (`tableName`/`recordId`) and Dart
/// (`table_name`/`record_id`) queues. Until the crate carries that itself, the
/// harness holds the routing so the flush loop can still be driven entirely
/// through the crate's public queue API.
#[derive(Default)]
pub struct Routes(BTreeMap<u64, String>);

impl Routes {
    pub fn new() -> Self {
        Self::default()
    }

    /// Queue an optimistic write through the client and remember where it goes.
    pub fn queue(
        &mut self,
        client: &mut OptoSyncClient<InMemoryStore>,
        doc_id: &str,
        payload: &Value,
    ) -> u64 {
        let id = client
            .queue_mutation(payload.to_string())
            .expect("queue_mutation must accept a well-formed JSON payload");
        self.0.insert(id, doc_id.to_string());
        id
    }

    pub fn doc_of(&self, mutation_id: u64) -> &str {
        self.0
            .get(&mutation_id)
            .unwrap_or_else(|| panic!("no route recorded for mutation {mutation_id}"))
    }
}

/// Flush one queued mutation through the real client lifecycle: read it back out
/// of the queue, push it, then mark it synced or failed according to what the
/// server actually said.
pub fn flush_one(
    client: &mut OptoSyncClient<InMemoryStore>,
    routes: &Routes,
    mutation_id: u64,
) -> HttpResult {
    let mutation = client
        .store()
        .all()
        .iter()
        .find(|m| m.id == mutation_id)
        .unwrap_or_else(|| panic!("mutation {mutation_id} is not in the store"))
        .clone();
    let payload: Value = serde_json::from_str(&mutation.payload)
        .unwrap_or_else(|e| panic!("queued payload is not JSON ({e}): {}", mutation.payload));

    let res = sync_doc(routes.doc_of(mutation_id), &payload);
    let marked = if res.ok() {
        client.store_mut().mark_synced(mutation_id)
    } else {
        client.store_mut().mark_failed(mutation_id)
    };
    assert!(marked, "the store must acknowledge marking mutation {mutation_id}");
    res
}
