//! rust-mash — Maud + Axum + Supabase(REST) + HTMX.
//!
//! This is the only e2e server whose persistence layer is a *REST API* rather
//! than a Postgres connection: every read and write goes out over HTTP to
//! Supabase's `/rest/v1/<table>` endpoint. Merging is done by the statically
//! linked syncer C core through the `syncer-rs` binding.
//!
//! Because Supabase's REST API *is* PostgREST, the e2e suite points this
//! server at a local PostgREST container instead of a cloud project. The only
//! difference between the two is the URL prefix (`/rest/v1/<table>` vs
//! `/<table>`), so the prefix is configurable via `SUPABASE_REST_PREFIX` and
//! defaults to Supabase's `/rest/v1` — real projects keep working unchanged.
//!
//! Environment:
//!   SUPABASE_URL           base URL, e.g. https://<ref>.supabase.co
//!   SUPABASE_KEY           API key sent as `apikey` + `Authorization: Bearer`
//!                          (SUPABASE_ANON_KEY accepted as a legacy fallback)
//!   SUPABASE_REST_PREFIX   REST base path, default "/rest/v1"; set to "" for
//!                          a bare PostgREST instance
//!   SUPABASE_TABLE         table name, default "syncer_test_docs"
//!   SERVER_PORT            default 3001

use axum::{
    extract::{Path, State},
    response::{Html, IntoResponse, Json},
    routing::{get, post, put},
    Router,
};
use maud::{html, Markup, DOCTYPE};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use tower_http::cors::CorsLayer;

// ── Server-owned merge policy ────────────────────────────────────────────
//
// Clients cannot dictate conflict resolution. This mirrors the node server's
// DEFAULT_MERGE_OPTIONS so the Supabase path exercises the same semantics as
// the Postgres path: keyed-array reconciliation by `id`, last-write-wins on
// updatedAt/syncedAt, first-write-wins on createdAt.
const MERGE_ARRAY_STRATEGY: syncer_rs::ArrayMergeStrategy =
    syncer_rs::ArrayMergeStrategy::MergeByKey;
const MERGE_ARRAY_MATCH_KEYS: &str = "id";
const MERGE_LWW_KEYS: &str = "updatedAt,syncedAt";
const MERGE_FWW_KEYS: &str = "createdAt";

#[derive(Clone)]
struct AppState {
    http: Client,
    supabase_url: String,
    supabase_key: String,
    /// REST base path. Normalized to either "" or "/some/path".
    rest_prefix: String,
    table: String,
}

#[derive(Serialize, Deserialize, Debug)]
struct Document {
    id: String,
    data: Value,
    version: i32,
    // Skipped when None so Postgres/PostgREST applies its own default (or a
    // BEFORE UPDATE trigger) instead of us writing an explicit NULL over it.
    #[serde(skip_serializing_if = "Option::is_none")]
    updated_at: Option<String>,
}

// ── Supabase helpers ─────────────────────────────────────────────────────

/// Normalize a REST prefix: `""` stays empty, otherwise exactly one leading
/// slash and no trailing slash. Keeps `{base}{prefix}/{table}` well-formed for
/// both `/rest/v1` (Supabase) and `` (bare PostgREST).
fn normalize_prefix(raw: &str) -> String {
    let trimmed = raw.trim().trim_matches('/');
    if trimmed.is_empty() {
        String::new()
    } else {
        format!("/{}", trimmed)
    }
}

impl AppState {
    fn table_url(&self) -> String {
        format!(
            "{}{}/{}",
            self.supabase_url.trim_end_matches('/'),
            self.rest_prefix,
            self.table
        )
    }

    fn auth<'a>(&self, rb: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        rb.header("apikey", &self.supabase_key)
            .header("Authorization", format!("Bearer {}", self.supabase_key))
    }

    async fn list_docs(&self) -> Result<Vec<Document>, String> {
        let resp = self
            .auth(self.http.get(&self.table_url()))
            .query(&[("select", "*"), ("order", "id")])
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = resp.status();
        let body = resp.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("supabase GET {}: {}", status.as_u16(), body));
        }
        serde_json::from_str(&body).map_err(|e| format!("decode: {} — body: {}", e, body))
    }

    async fn get_doc(&self, id: &str) -> Result<Option<Document>, String> {
        let resp = self
            .auth(self.http.get(&self.table_url()))
            .query(&[("id", format!("eq.{}", id)), ("select", "*".into())])
            .send()
            .await
            .map_err(|e| e.to_string())?;

        let status = resp.status();
        let body = resp.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            // Surface the REST layer's own error instead of collapsing it into
            // a decode failure — a 401 from a bad apikey must not look like
            // "document not found".
            return Err(format!("supabase GET {}: {}", status.as_u16(), body));
        }
        let docs: Vec<Document> =
            serde_json::from_str(&body).map_err(|e| format!("decode: {} — body: {}", e, body))?;
        Ok(docs.into_iter().next())
    }

    /// Upsert via PostgREST/Supabase `resolution=merge-duplicates`, asking for
    /// the stored row back so a silent write failure cannot pass for success.
    async fn upsert_doc(&self, doc: &Document) -> Result<Vec<Document>, String> {
        let resp = self
            .auth(self.http.post(&self.table_url()))
            .header("Prefer", "resolution=merge-duplicates,return=representation")
            .json(doc)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        let status = resp.status();
        let body = resp.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("supabase POST {}: {}", status.as_u16(), body));
        }
        serde_json::from_str(&body).map_err(|e| format!("decode: {} — body: {}", e, body))
    }
}

// ── Merge ────────────────────────────────────────────────────────────────

/// Deep-merge `incoming` onto `base` with the server-owned policy.
///
/// Builds `SyncerMergeOptionsC` directly (rather than going through the safe
/// wrapper) so the e2e suite exercises the raw C ABI struct layout, including
/// `array_match_keys`, which must remain the final field.
fn merge_with_policy(base: &str, incoming: &str) -> Option<String> {
    let c_base = std::ffi::CString::new(base).ok()?;
    let c_incoming = std::ffi::CString::new(incoming).ok()?;
    let lww = std::ffi::CString::new(MERGE_LWW_KEYS).ok()?;
    let fww = std::ffi::CString::new(MERGE_FWW_KEYS).ok()?;
    let match_keys = std::ffi::CString::new(MERGE_ARRAY_MATCH_KEYS).ok()?;

    let c_opts = syncer_rs::SyncerMergeOptionsC {
        override_cb: None,
        array_strategy: MERGE_ARRAY_STRATEGY,
        max_depth: 0,
        detect_circular_refs: false,
        resolve_by_timestamp: true,
        lww_keys: lww.as_ptr(),
        fww_keys: fww.as_ptr(),
        array_match_keys: match_keys.as_ptr(),
    };

    unsafe {
        let result_ptr =
            syncer_rs::syncer_merge_json_ex(c_base.as_ptr(), c_incoming.as_ptr(), &c_opts);
        if result_ptr.is_null() {
            return None;
        }
        let result = std::ffi::CStr::from_ptr(result_ptr)
            .to_string_lossy()
            .into_owned();
        syncer_rs::syncer_free(result_ptr as *mut std::ffi::c_void);
        if result.is_empty() {
            None
        } else {
            Some(result)
        }
    }
}

// ── Handlers ─────────────────────────────────────────────────────────────

async fn health(State(state): State<Arc<AppState>>) -> Json<Value> {
    Json(serde_json::json!({
        "status": "ok",
        "server": "rust-mash",
        "stack": "Maud + Axum + Supabase + HTMX",
        // Proves the statically linked C core — not a Rust reimplementation —
        // is what performs the merges.
        "native": true,
        "mergeEngine": "native-c-ffi-rust",
        "coreVersion": syncer_rs::version(),
        "restPrefix": state.rest_prefix,
        "table": state.table,
        "mergePolicy": {
            "arrayStrategy": MERGE_ARRAY_STRATEGY as i32,
            "arrayMatchKeys": MERGE_ARRAY_MATCH_KEYS,
            "resolveByTimestamp": true,
            "lwwKeys": MERGE_LWW_KEYS,
            "fwwKeys": MERGE_FWW_KEYS,
        }
    }))
}

fn err(status: axum::http::StatusCode, msg: impl Into<String>) -> axum::response::Response {
    (status, Json(serde_json::json!({"error": msg.into()}))).into_response()
}

async fn list_documents(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match state.list_docs().await {
        Ok(docs) => Json(serde_json::to_value(docs).unwrap()).into_response(),
        Err(e) => err(axum::http::StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn get_document(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.get_doc(&id).await {
        Ok(Some(doc)) => Json(serde_json::to_value(doc).unwrap()).into_response(),
        Ok(None) => err(axum::http::StatusCode::NOT_FOUND, "not found"),
        Err(e) => err(axum::http::StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

/// Create (or reset) a document. Writes `data` verbatim through the REST layer
/// — no merge — so tests have a deterministic starting state without needing
/// direct database access.
async fn put_document(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(data): Json<Value>,
) -> impl IntoResponse {
    if !data.is_object() {
        return err(
            axum::http::StatusCode::BAD_REQUEST,
            "body must be a JSON object",
        );
    }
    let doc = Document {
        id: id.clone(),
        data,
        version: 1,
        updated_at: None,
    };
    match state.upsert_doc(&doc).await {
        Ok(stored) => (
            axum::http::StatusCode::CREATED,
            Json(serde_json::json!({
                "created": true,
                "document": stored.into_iter().next(),
            })),
        )
            .into_response(),
        Err(e) => err(axum::http::StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

#[derive(Serialize, Deserialize, Debug)]
struct DocumentPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(rename = "updatedAt", skip_serializing_if = "Option::is_none")]
    updated_at: Option<Value>,
    // Catch-all for optimistic partial updates
    #[serde(flatten)]
    extra: std::collections::HashMap<String, Value>,
}

async fn sync_document(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(incoming): Json<DocumentPayload>,
) -> impl IntoResponse {
    let current = match state.get_doc(&id).await {
        Ok(Some(doc)) => doc,
        Ok(None) => return err(axum::http::StatusCode::NOT_FOUND, "not found"),
        Err(e) => return err(axum::http::StatusCode::INTERNAL_SERVER_ERROR, e),
    };

    // Zero-deserialization: keep as raw strings for the C FFI
    let raw_base = serde_json::to_string(&current.data).unwrap();
    let raw_incoming = serde_json::to_string(&incoming).unwrap();

    let merged_raw = match merge_with_policy(&raw_base, &raw_incoming) {
        Some(s) => s,
        None => return err(axum::http::StatusCode::INTERNAL_SERVER_ERROR, "merge failed"),
    };

    let merged_value: Value = match serde_json::from_str(&merged_raw) {
        Ok(v) => v,
        Err(e) => {
            return err(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("merge produced invalid JSON: {}", e),
            )
        }
    };

    let updated = Document {
        id: id.clone(),
        data: merged_value,
        version: current.version + 1,
        updated_at: None,
    };

    let stored = match state.upsert_doc(&updated).await {
        Ok(rows) => rows.into_iter().next(),
        Err(e) => return err(axum::http::StatusCode::INTERNAL_SERVER_ERROR, e),
    };

    Json(serde_json::json!({
        "merged": true,
        // The row as the REST layer actually stored it, not our local copy —
        // if the write silently lost the merge, the response shows it.
        "document": stored,
        "mergedWith": "native-c-ffi-rust",
        "coreVersion": syncer_rs::version(),
    }))
    .into_response()
}

// ── HTMX frontend (Maud) ────────────────────────────────────────────────

async fn index_page(State(state): State<Arc<AppState>>) -> Html<String> {
    let docs_html = match state.list_docs().await {
        Ok(docs) => html! {
            @for doc in &docs {
                div class="doc-card" {
                    h3 { (doc.id) " (v" (doc.version) ")" }
                    pre { code { (serde_json::to_string_pretty(&doc.data).unwrap_or_default()) } }
                }
            }
        },
        Err(e) => html! { p { "Failed to load documents: " (e) } },
    };

    let page: Markup = html! {
        (DOCTYPE)
        html lang="en" {
            head {
                meta charset="utf-8";
                title { "Syncer.c — MASH Dashboard" }
                script src="https://unpkg.com/htmx.org@1.9.12" {}
                style {
                    "body { font-family: system-ui; max-width: 800px; margin: 2rem auto; background: #0d1117; color: #c9d1d9; }"
                    ".doc-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 1rem; margin: 1rem 0; }"
                    "pre { background: #0d1117; padding: 0.5rem; border-radius: 4px; overflow-x: auto; }"
                    "h1 { color: #58a6ff; }"
                }
            }
            body {
                h1 { "🔄 Syncer.c — MASH Stack" }
                p { "Maud + Axum + Supabase + HTMX — core v" (syncer_rs::version()) }
                div id="docs" { (docs_html) }
            }
        }
    };

    Html(page.into_string())
}

// ── Main ─────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();

    let supabase_url = std::env::var("SUPABASE_URL").unwrap_or_else(|_| {
        eprintln!("Warning: SUPABASE_URL not set");
        "http://localhost:54321".to_string()
    });
    let supabase_key = std::env::var("SUPABASE_KEY")
        .or_else(|_| std::env::var("SUPABASE_ANON_KEY")) // legacy fallback
        .unwrap_or_else(|_| {
            eprintln!("Warning: SUPABASE_KEY not set");
            "".to_string()
        });
    // Supabase serves tables under /rest/v1; a bare PostgREST serves them at
    // the root. Default keeps real Supabase working with no config.
    let rest_prefix = normalize_prefix(
        &std::env::var("SUPABASE_REST_PREFIX").unwrap_or_else(|_| "/rest/v1".to_string()),
    );
    let table = std::env::var("SUPABASE_TABLE").unwrap_or_else(|_| "syncer_test_docs".to_string());

    let state = Arc::new(AppState {
        http: Client::new(),
        supabase_url,
        supabase_key,
        rest_prefix,
        table,
    });

    let port: u16 = std::env::var("SERVER_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3001);

    let app = Router::new()
        .route("/", get(index_page))
        .route("/health", get(health))
        .route("/docs", get(list_documents))
        .route("/doc/:id", get(get_document).put(put_document))
        .route("/doc/:id/sync", post(sync_document))
        .layer(CorsLayer::permissive())
        .with_state(state.clone());

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", port))
        .await
        .unwrap();

    println!(
        "[rust-mash] core v{} — REST target {} — listening on http://0.0.0.0:{}",
        syncer_rs::version(),
        state.table_url(),
        port
    );
    axum::serve(listener, app).await.unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefix_normalization() {
        assert_eq!(normalize_prefix("/rest/v1"), "/rest/v1");
        assert_eq!(normalize_prefix("rest/v1"), "/rest/v1");
        assert_eq!(normalize_prefix("/rest/v1/"), "/rest/v1");
        assert_eq!(normalize_prefix(""), "");
        assert_eq!(normalize_prefix("/"), "");
    }

    #[test]
    fn merge_policy_reconciles_keyed_arrays() {
        let base = r#"{"items":[{"id":"a","updatedAt":2000,"qty":1}]}"#;
        let incoming = r#"{"items":[{"id":"a","updatedAt":3000,"qty":9},{"id":"b"}]}"#;
        let merged = merge_with_policy(base, incoming).expect("merge");
        assert!(merged.contains("\"qty\":9"), "{merged}");
        assert!(merged.contains("\"id\":\"b\""), "{merged}");
    }

    #[test]
    fn merge_policy_rejects_stale_elements() {
        let base = r#"{"items":[{"id":"a","updatedAt":5000,"qty":1}]}"#;
        let incoming = r#"{"items":[{"id":"a","updatedAt":1000,"qty":9}]}"#;
        let merged = merge_with_policy(base, incoming).expect("merge");
        assert!(merged.contains("\"qty\":1"), "{merged}");
    }
}
