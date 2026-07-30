use std::fs;
use std::path::Path;

use opto_sync_client::protocol::{PushRequest, PushResponse, SnapshotResponse};
use opto_sync_client::protocol_sync::AtomicProtocolSyncStore;
use opto_sync_client::sqlite::SqliteProtocolStore;
use opto_sync_client_e2e::{protocol_push, protocol_snapshot};
use serde_json::{json, Value};

fn fail(message: impl AsRef<str>) -> ! {
    panic!("{}", message.as_ref())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 5 || !matches!(args[1].as_str(), "prepare" | "recover") {
        eprintln!(
            "usage: protocol_restart <prepare|recover> <sqlite-file> <envelope-file> <record-id>"
        );
        std::process::exit(2);
    }
    let phase = &args[1];
    let state_path = Path::new(&args[2]);
    let envelope_path = Path::new(&args[3]);
    let snapshot_path = format!("{}.snapshot", envelope_path.display());
    let snapshot_path = Path::new(&snapshot_path);
    let record_id = &args[4];

    if phase == "prepare" {
        if state_path.exists() || envelope_path.exists() || snapshot_path.exists() {
            fail("prepare requires fresh state and envelope files");
        }
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let client_id = format!("rust-restart-{}-{nonce}", std::process::id());
        let mut store = SqliteProtocolStore::open(state_path, &client_id).unwrap();
        store
            .queue_upsert_record(
                "docs",
                record_id,
                json!({"title": "rust survived server-commit/client-ack restart"}),
                Some("0".to_string()),
                false,
            )
            .unwrap();
        let mut queue = store.load_queue().unwrap();
        let envelope = serde_json::to_value(queue.push_request(100).unwrap()).unwrap();
        fs::write(envelope_path, serde_json::to_vec(&envelope).unwrap()).unwrap();

        let committed = protocol_push(&envelope);
        assert_eq!(committed.status, 200, "{}", committed.body);
        assert_eq!(
            committed.json()["results"][0]["status"],
            "applied",
            "{}",
            committed.body
        );
        assert_eq!(queue.pending().count(), 1, "prepare must not acknowledge");

        let snapshot_result = protocol_snapshot();
        assert_eq!(snapshot_result.status, 200, "{}", snapshot_result.body);
        let snapshot: SnapshotResponse = serde_json::from_str(&snapshot_result.body).unwrap();
        fs::write(snapshot_path, &snapshot_result.body).unwrap();
        store
            .connection()
            .execute_batch(
                "CREATE TEMP TRIGGER inject_snapshot_failure
                 BEFORE INSERT ON _opto_sync_local
                 BEGIN
                   SELECT RAISE(ABORT, 'injected snapshot replacement interruption');
                 END;",
            )
            .unwrap();
        queue.set_checkpoint(snapshot.checkpoint.clone()).unwrap();
        let interrupted = store.replace_authoritative_and_persist(&snapshot.records, &mut queue);
        assert!(interrupted.is_err());
        let durable = store.load_queue().unwrap();
        assert_eq!(durable.checkpoint(), "0");
        assert_eq!(durable.pending().count(), 1);
        assert_eq!(
            store
                .local_record("docs", record_id)
                .unwrap()
                .unwrap()
                .record["title"],
            "rust survived server-commit/client-ack restart"
        );
        println!(
            "ok - [rust/sqlite restart prepare] committed without local ack; \
             SQLite snapshot transaction interrupted"
        );
        return;
    }

    let original: Value = serde_json::from_slice(&fs::read(envelope_path).unwrap()).unwrap();
    let request: PushRequest = serde_json::from_value(original.clone()).unwrap();
    let mut store = SqliteProtocolStore::open(state_path, &request.client_id).unwrap();
    let mut queue = store.load_queue().unwrap();
    assert_eq!(
        queue.pending().count(),
        1,
        "new process did not recover one pending mutation"
    );
    assert_eq!(queue.checkpoint(), "0");

    let snapshot: SnapshotResponse =
        serde_json::from_slice(&fs::read(snapshot_path).unwrap()).unwrap();
    queue.set_checkpoint(snapshot.checkpoint.clone()).unwrap();
    store
        .replace_authoritative_and_persist(&snapshot.records, &mut queue)
        .unwrap();
    assert_eq!(queue.checkpoint(), snapshot.checkpoint);
    assert_eq!(queue.pending().count(), 1);
    assert!(store
        .authoritative_record("docs", record_id)
        .unwrap()
        .is_some());

    let reconstructed = serde_json::to_value(queue.push_request(100).unwrap()).unwrap();
    assert_eq!(
        reconstructed, original,
        "SDK envelope changed across process restart"
    );

    let retry = protocol_push(&reconstructed);
    assert_eq!(retry.status, 200, "{}", retry.body);
    assert_eq!(retry.json()["results"][0]["status"], "duplicate");
    assert_eq!(retry.json()["results"][0]["originalStatus"], "applied");
    let acknowledgement: PushResponse = serde_json::from_str(&retry.body).unwrap();
    assert_eq!(queue.acknowledge(&acknowledgement, &request).unwrap(), 1);
    store
        .persist_acknowledgement(&mut queue, &request, &acknowledgement)
        .unwrap();
    assert_eq!(queue.pending().count(), 0);
    drop(store);
    let reopened = SqliteProtocolStore::open(state_path, &request.client_id).unwrap();
    assert_eq!(reopened.load_queue().unwrap().pending().count(), 0);
    println!(
        "ok - [rust/sqlite restart recover] snapshot repaired; \
         identical retry deduplicated and acknowledgement survived reopen"
    );
}
