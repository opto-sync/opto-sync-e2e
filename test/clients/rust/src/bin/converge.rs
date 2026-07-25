//! Scenario 7 phase runner for opto-sync-client — cross-client convergence.
//!
//! Invoked by run_all.sh as one step of an orchestrated sequence:
//!
//!   cargo run --offline --quiet --bin converge -- setup   # PUT the fresh document
//!   cargo run --offline --quiet --bin converge -- flush   # queue + flush this client
//!   cargo run --offline --quiet --bin converge -- verify  # assert final doc + reconcile
//!
//! Split into phases on purpose: `flush` must run once per language, in the
//! fixture's declared order, against the SAME document, so the phases cannot live
//! inside a single language's test process.

use std::process::ExitCode;

use opto_sync_client::{InMemoryStore, MutationStore, OptoSyncClient};
use opto_sync_client_e2e::*;
use serde_json::Value;

struct Phase {
    name: String,
    checks: usize,
}

impl Phase {
    fn ok(&mut self, what: &str) {
        self.checks += 1;
        println!("ok - [{LANG}/converge/{}] {what}", self.name);
    }

    fn check(&mut self, condition: bool, what: &str) {
        assert!(condition, "{what}");
        self.ok(what);
    }

    fn check_eq(&mut self, actual: &Value, expected: &Value, what: &str) {
        assert_json_eq(actual, expected, what);
        self.ok(what);
    }
}

fn fixture_doc_id() -> &'static str {
    field_str(cross_client(), "docId")
}

fn payload() -> &'static Value {
    field(cross_client(), "payloads")
        .get(LANG)
        .unwrap_or_else(|| panic!("fixture has no payload for \"{LANG}\""))
}

fn setup(p: &mut Phase) {
    let base = field(cross_client(), "base");
    put_doc(fixture_doc_id(), base);
    let what = format!("fresh document {} written", fixture_doc_id());
    p.check_eq(&get_doc_data(fixture_doc_id()), base, &what);
}

fn flush(p: &mut Phase) {
    let doc = fixture_doc_id();
    let mut client = OptoSyncClient::new(InMemoryStore::new());
    let mut routes = Routes::new();

    let mid = routes.queue(&mut client, doc, payload());
    p.check(client.store().pending().len() == 1, "payload queued as pending");

    let res = flush_one(&mut client, &routes, mid);
    p.check(res.status == 200, &format!("flushed to {doc} (HTTP {})", res.status));
    p.check(
        res.json().get("mergedWith").and_then(Value::as_str) == Some("native-c-ffi"),
        "server merged with the native C core",
    );

    let counts = status_counts(&client);
    let drained = counts.synced == 1 && counts.pending == 0 && counts.failed == 0;
    p.check(drained, &format!("queue drained ({counts:?})"));
}

fn verify(p: &mut Phase) {
    let doc = fixture_doc_id();
    let server_final = get_doc_data(doc);
    let expected = field(cross_client(), "expectedFinal");

    // (a) strict, order-sensitive: the server document is fully determined.
    p.check_eq(
        &server_final,
        expected,
        "final server document matches the predicted merge exactly",
    );

    // Spot-check the load-bearing policy claims, so a failure names the rule.
    let revision = server_final.get("revision").unwrap();
    let items = server_final.get("items").and_then(Value::as_array).unwrap();
    let item = |id: &str| {
        items
            .iter()
            .find(|i| i.get("id").and_then(Value::as_str) == Some(id))
            .unwrap_or_else(|| panic!("no item with id {id}"))
    };

    p.check(
        server_final.get("title").and_then(Value::as_str) == Some("rust title"),
        "unguarded root scalar follows arrival order (last flusher wins)",
    );
    p.check(
        revision.get("owner").and_then(Value::as_str) == Some("dart")
            && revision.get("updatedAt").and_then(Value::as_u64) == Some(4000),
        "guarded object follows updatedAt, NOT flush order: rust flushed last but is stale",
    );
    p.check(
        revision.get("priority").and_then(Value::as_u64) == Some(2),
        "rust's stale revision was rejected WHOLESALE",
    );
    // Base-only root scalar: no client payload sends a root `createdAt`, so
    // nothing can overwrite it. (`createdAt` is no longer a guarded key on any
    // tier — FWW is a node-level veto and is opt-in.)
    p.check(
        server_final.get("createdAt").and_then(Value::as_u64) == Some(1000),
        "base-only root createdAt untouched by every client",
    );
    p.check(items.len() == 5, "exactly three new identities appended");

    let shared = item("shared");
    p.check(
        shared.get("label").and_then(Value::as_str) == Some("dart-shared")
            && shared.get("qty").and_then(Value::as_u64) == Some(20)
            && shared.get("createdAt").and_then(Value::as_u64) == Some(1000),
        "the shared element carries dart's write deep-merged onto the base element",
    );
    p.check(
        item("keep").get("label").and_then(Value::as_str) == Some("untouched"),
        "the element nobody touched is preserved verbatim",
    );
    let order: Vec<&str> = items
        .iter()
        .map(|i| i.get("id").and_then(Value::as_str).unwrap_or(""))
        .collect();
    p.check(
        order.join(",") == "keep,shared,ts-new,dart-new,rust-new",
        "appended identities appear in flush order at the end of the array",
    );

    // (b) this client's own local reconcile of the final state.
    let client = OptoSyncClient::new(InMemoryStore::new());
    let merged = client
        .reconcile_incoming(&payload().to_string(), &server_final.to_string())
        .expect("reconcile must not fail on valid JSON");
    let reconciled: Value = serde_json::from_str(&merged).expect("core must return valid JSON");
    assert_json_eq_keyed(
        &reconciled,
        expected,
        &format!("{LANG} local reconcile of the final server state"),
    );
    p.ok(&format!(
        "{LANG} local reconcile of the final server state agrees with every other client"
    ));
}

fn main() -> ExitCode {
    let name = std::env::args().nth(1).unwrap_or_default();
    let run: fn(&mut Phase) = match name.as_str() {
        "setup" => setup,
        "flush" => flush,
        "verify" => verify,
        _ => {
            eprintln!("usage: converge <setup|flush|verify>");
            return ExitCode::from(2);
        }
    };

    if let Some(reason) = probe_server() {
        eprintln!("[{LANG}] SKIP converge/{name} — server unavailable: {reason}");
        return ExitCode::SUCCESS;
    }

    let mut phase = Phase { name: name.clone(), checks: 0 };
    // Assertion failures inside a phase must be a clean non-zero exit with a
    // single readable line, not a raw Rust panic dump in the orchestrator's log.
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(&mut phase)));
    if outcome.is_err() {
        eprintln!("not ok - [{LANG}/converge/{name}] see the panic message above");
        return ExitCode::FAILURE;
    }
    println!(
        "# [{LANG}] converge/{name}: {} checks passed against {}",
        phase.checks,
        base_url()
    );
    ExitCode::SUCCESS
}
