# WebSocket hardening contract

The `/sync/ws` transport carries database synchronization requests and change wake hints. It is independent from the ORES OTEL telemetry connection.

Server guardrails:

- accept JSON text frames only;
- retain at most 32 asynchronous frame handlers per peer;
- enforce the same 32 MiB frame quota as the HTTP protocol endpoint;
- remove closed or errored peers from the change-broadcast hub idempotently;
- close binary peers with WebSocket code `1003`;
- close peers exceeding the in-flight work bound with code `1013`.

The `changed` frame is only a prompt to pull. IndexedDB and SQLite mutation queues remain pending until the authenticated push/pull protocol records and acknowledges their database state.

The integration suite verifies binary rejection, server survival, push/pull/snapshot parity, malformed-frame recovery, and change-hint fan-out against a live reference server.
