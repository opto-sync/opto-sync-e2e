use axum::{
    extract::{Path, State},
    response::{Html, IntoResponse, Json},
    routing::{get, post},
    Router,
};
use maud::{html, Markup, DOCTYPE};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use tower_http::cors::CorsLayer;

#[derive(Clone)]
struct AppState {
    http: Client,
    supabase_url: String,
    supabase_key: String,
}

#[derive(Serialize, Deserialize, Debug)]
struct Document {
    id: String,
    data: Value,
    version: i32,
    updated_at: Option<String>,
}

// ── Supabase helpers ─────────────────────────────────────────────────────

impl AppState {
    fn table_url(&self) -> String {
        format!("{}/rest/v1/syncer_test_docs", self.supabase_url)
    }

    async fn get_doc(&self, id: &str) -> Result<Option<Document>, String> {
        let resp = self
            .http
            .get(&self.table_url())
            .header("apikey", &self.supabase_key)
            .header("Authorization", format!("Bearer {}", self.supabase_key))
            .query(&[("id", format!("eq.{}", id)), ("select", "*".into())])
            .send()
            .await
            .map_err(|e| e.to_string())?;

        let docs: Vec<Document> = resp.json().await.map_err(|e| e.to_string())?;
        Ok(docs.into_iter().next())
    }

    async fn upsert_doc(&self, doc: &Document) -> Result<(), String> {
        self.http
            .post(&self.table_url())
            .header("apikey", &self.supabase_key)
            .header("Authorization", format!("Bearer {}", self.supabase_key))
            .header("Prefer", "resolution=merge-duplicates")
            .json(doc)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

// ── Handlers ─────────────────────────────────────────────────────────────

async fn health() -> Json<Value> {
    Json(serde_json::json!({
        "status": "ok",
        "server": "rust-mash",
        "stack": "Maud + Axum + Supabase + HTMX"
    }))
}

async fn get_document(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.get_doc(&id).await {
        Ok(Some(doc)) => Json(serde_json::to_value(doc).unwrap()).into_response(),
        Ok(None) => (
            axum::http::StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "not found"})),
        )
            .into_response(),
        Err(e) => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response(),
    }
}

#[derive(Serialize, Deserialize, Debug)]
struct DocumentPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(rename = "updatedAt", skip_serializing_if = "Option::is_none")]
    updated_at: Option<String>,
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
        Ok(None) => {
            return (
                axum::http::StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "not found"})),
            )
                .into_response()
        }
        Err(e) => {
            return (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e})),
            )
                .into_response()
        }
    };

    // Zero-deserialization: keep as raw strings for the C FFI
    let raw_base = serde_json::to_string(&current.data).unwrap();
    let raw_incoming = serde_json::to_string(&incoming).unwrap();

    // Call syncer-rs FFI
    let merged_raw = unsafe {
        let c_base = std::ffi::CString::new(raw_base.as_str()).unwrap();
        let c_incoming = std::ffi::CString::new(raw_incoming.as_str()).unwrap();
        let ts_key = std::ffi::CString::new("updatedAt").unwrap();

        let c_opts = syncer_rs::SyncerMergeOptionsC {
            override_cb: None,
            array_strategy: syncer_rs::ArrayMergeStrategy::Replace,
            max_depth: 0,
            detect_circular_refs: false,
            resolve_by_timestamp: true,
            lww_keys: ts_key.as_ptr(),
            fww_keys: std::ptr::null(),
        };

        let result_ptr =
            syncer_rs::syncer_merge_json_ex(c_base.as_ptr(), c_incoming.as_ptr(), &c_opts);
        if result_ptr.is_null() {
            return (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "merge failed"})),
            )
                .into_response();
        }
        let result = std::ffi::CStr::from_ptr(result_ptr)
            .to_string_lossy()
            .into_owned();
        syncer_rs::syncer_free(result_ptr as *mut std::ffi::c_void);
        result
    };

    let merged_value: Value = serde_json::from_str(&merged_raw).unwrap();
    let updated = Document {
        id: id.clone(),
        data: merged_value,
        version: current.version + 1,
        updated_at: None,
    };

    if let Err(e) = state.upsert_doc(&updated).await {
        return (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response();
    }

    Json(serde_json::json!({
        "merged": true,
        "document": updated,
        "mergedWith": "native-c-ffi-rust"
    }))
    .into_response()
}

// ── HTMX frontend (Maud) ────────────────────────────────────────────────

async fn index_page(State(state): State<Arc<AppState>>) -> Html<String> {
    let docs_html = match state
        .http
        .get(&state.table_url())
        .header("apikey", &state.supabase_key)
        .header("Authorization", format!("Bearer {}", state.supabase_key))
        .query(&[("select", "*"), ("order", "id")])
        .send()
        .await
    {
        Ok(resp) => {
            let docs: Vec<Document> = resp.json().await.unwrap_or_default();
            html! {
                @for doc in &docs {
                    div class="doc-card" {
                        h3 { (doc.id) " (v" (doc.version) ")" }
                        pre { code { (serde_json::to_string_pretty(&doc.data).unwrap_or_default()) } }
                    }
                }
            }
        }
        Err(_) => html! { p { "Failed to load documents" } },
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
                p { "Maud + Axum + Supabase + HTMX" }
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
    let supabase_key = std::env::var("SUPABASE_ANON_KEY").unwrap_or_else(|_| {
        eprintln!("Warning: SUPABASE_ANON_KEY not set");
        "".to_string()
    });

    let state = Arc::new(AppState {
        http: Client::new(),
        supabase_url,
        supabase_key,
    });

    let port: u16 = std::env::var("SERVER_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3001);

    let app = Router::new()
        .route("/", get(index_page))
        .route("/health", get(health))
        .route("/doc/:id", get(get_document))
        .route("/doc/:id/sync", post(sync_document))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", port))
        .await
        .unwrap();

    println!("[rust-mash] Listening on http://0.0.0.0:{}", port);
    axum::serve(listener, app).await.unwrap();
}
