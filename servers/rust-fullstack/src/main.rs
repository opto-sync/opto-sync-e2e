use axum::{
    extract::{Path, State},
    response::{Html, IntoResponse, Json},
    routing::{get, post},
    Router,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashMap, sync::Arc};
use tokio::sync::RwLock;
use tower_http::cors::CorsLayer;

// ── In-memory store ───────────────────────────────────────────────────────

#[derive(Clone, Serialize, Deserialize, Debug)]
struct Document {
    id: String,
    data: Value,
    version: i32,
}

type Db = Arc<RwLock<HashMap<String, Document>>>;

// ── Payload validation ────────────────────────────────────────────────────

#[derive(Deserialize, Debug)]
struct SyncPayload {
    #[serde(rename = "updatedAt")]
    updated_at: Option<String>,
    #[serde(flatten)]
    extra: HashMap<String, Value>,
}

// ── Handlers ─────────────────────────────────────────────────────────────

async fn health() -> Json<Value> {
    Json(serde_json::json!({
        "status": "ok",
        "server": "rust-fullstack",
        "stack": "Axum SSR + syncer-rs C FFI"
    }))
}

async fn list_docs(State(db): State<Db>) -> Json<Value> {
    let db = db.read().await;
    let docs: Vec<&Document> = db.values().collect();
    Json(serde_json::to_value(docs).unwrap())
}

async fn get_doc(State(db): State<Db>, Path(id): Path<String>) -> impl IntoResponse {
    let db = db.read().await;
    match db.get(&id) {
        Some(doc) => Json(serde_json::to_value(doc).unwrap()).into_response(),
        None => (
            axum::http::StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "not found"})),
        )
            .into_response(),
    }
}

async fn sync_doc(
    State(db): State<Db>,
    Path(id): Path<String>,
    Json(payload): Json<SyncPayload>,
) -> impl IntoResponse {
    let mut db = db.write().await;
    let doc = match db.get_mut(&id) {
        Some(d) => d,
        None => {
            return (
                axum::http::StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "not found"})),
            )
                .into_response()
        }
    };

    // Reconstruct incoming json from validated payload
    let mut incoming_map = payload.extra;
    if let Some(ts) = payload.updated_at {
        incoming_map.insert("updatedAt".to_string(), Value::String(ts));
    }
    let incoming_val = Value::Object(incoming_map.into_iter().collect());

    let raw_base = serde_json::to_string(&doc.data).unwrap();
    let raw_incoming = serde_json::to_string(&incoming_val).unwrap();

    let merged_raw = unsafe {
        let c_base = std::ffi::CString::new(raw_base.as_str()).unwrap();
        let c_incoming = std::ffi::CString::new(raw_incoming.as_str()).unwrap();
        // Same policy as every other opto-sync server, so the conformance
        // expectations are uniform across runtimes. CStrings must outlive the
        // merge call — they are bound here, not inlined into the struct.
        //
        // `fww_keys` is a genuine NULL, deliberately (never a dangling pointer):
        // FWW in the core is a NODE-LEVEL VETO — an incoming node whose FWW key
        // is newer is dropped WHOLESALE, even when its `updatedAt` is the newest
        // write anywhere. With "createdAt" here, a replica holding a later
        // createdAt for a record could never write to it again, behind a 200 OK.
        let lww_keys = std::ffi::CString::new("updatedAt,syncedAt").unwrap();
        let match_keys = std::ffi::CString::new("id").unwrap();

        let c_opts = syncer_rs::SyncerMergeOptionsC {
            override_cb: None,
            array_strategy: syncer_rs::ArrayMergeStrategy::MergeByKey,
            max_depth: 0,
            detect_circular_refs: false,
            resolve_by_timestamp: true,
            lww_keys: lww_keys.as_ptr(),
            fww_keys: std::ptr::null(),
            array_match_keys: match_keys.as_ptr(),
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
    doc.data = merged_value;
    doc.version += 1;

    let response_doc = doc.clone();
    Json(serde_json::json!({
        "merged": true,
        "document": response_doc,
        "mergedWith": "native-c-ffi-rust-fullstack"
    }))
    .into_response()
}

async fn index_page() -> Html<String> {
    Html(r#"<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>opto-sync — Rust Full-Stack</title>
  <style>
    body { font-family: system-ui; max-width: 800px; margin: 2rem auto; background: #0d1117; color: #c9d1d9; }
    h1 { color: #58a6ff; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 1rem; margin: 1rem 0; }
    code { color: #e6edf3; }
  </style>
</head>
<body>
  <h1>🦀 opto-sync — Rust Full-Stack SSR</h1>
  <div class="card">
    <p>Axum SSR server with native <code>syncer-rs</code> C FFI for CRDT JSON merging.</p>
    <p>API: <code>GET /doc/:id</code> | <code>POST /doc/:id/sync</code></p>
  </div>
  <div id="docs">
    <p>Use <code>GET /docs</code> to list all documents.</p>
  </div>
</body>
</html>"#.to_string())
}

// ── Main ─────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();

    // Seed in-memory DB
    let db: Db = Arc::new(RwLock::new(HashMap::new()));
    {
        let mut store = db.write().await;
        store.insert("doc-a".to_string(), Document {
            id: "doc-a".to_string(),
            data: serde_json::json!({
                "title": "Fullstack Alpha",
                "metadata": { "tags": ["rust", "ssr"], "priority": 1 },
                "updatedAt": "1000000000000000000"
            }),
            version: 1,
        });
        store.insert("doc-b".to_string(), Document {
            id: "doc-b".to_string(),
            data: serde_json::json!({
                "title": "Fullstack Beta",
                "settings": { "theme": "dark" },
                "updatedAt": "1000000000000000000"
            }),
            version: 1,
        });
    }

    let port: u16 = std::env::var("SERVER_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3002);

    let app = Router::new()
        .route("/", get(index_page))
        .route("/health", get(health))
        .route("/docs", get(list_docs))
        .route("/doc/:id", get(get_doc))
        .route("/doc/:id/sync", post(sync_doc))
        .layer(CorsLayer::permissive())
        .with_state(db);

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", port))
        .await
        .unwrap();

    println!("[rust-fullstack] Listening on http://0.0.0.0:{}", port);
    axum::serve(listener, app).await.unwrap();
}
