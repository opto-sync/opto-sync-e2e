# e2e clients

Thin consumer stubs for future browser/device end-to-end runs. These are not
client libraries themselves — the real client packages live in
[`../../opto-sync-clients`](../../opto-sync-clients) and are pulled in via
path dependencies:

- `dart/` — depends on `opto_sync_client`
  (`../../../opto-sync-clients/clients/dart`) for device-side sync tests.
- `wasm/` — Vite app depending on `@opto-sync/client`
  (`../../../opto-sync-clients/clients/ts`) for browser sync tests.

Neither stub has test code yet; they exist so the e2e harness has a place to
grow client-driven scenarios against the servers in `../servers`.
