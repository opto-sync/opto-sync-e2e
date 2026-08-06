import gleam/int
import gleam/list
import gleam/option.{None, Some}
import gleam/string
import gleeunit
import gleeunit/should
import live_support
import opto_sync_client

pub fn main() {
  gleeunit.main()
}

pub fn real_protocol_push_retry_pull_and_delete_test() {
  let nonce = live_support.unique_id()
  let client_id = "gleam-live-" <> nonce
  let record_id = "gleam-task-" <> nonce
  let assert Ok(queue) = opto_sync_client.new(client_id)
  let assert Ok(#(queue, _)) =
    opto_sync_client.enqueue_upsert(
      queue,
      "tasks",
      record_id,
      "{\"title\":\"offline from Gleam\",\"updatedAt\":200}",
      None,
      False,
    )
  let assert Ok(request) = opto_sync_client.build_push_request(queue, 100)
  let body = opto_sync_client.encode_push_request(request)

  let assert Ok(#(200, response_body)) =
    live_support.request("POST", "/v1/sync/push", body)
  let assert Ok(response) = opto_sync_client.decode_push_response(response_body)
  let assert opto_sync_client.PushResponse(
    1,
    _,
    "1",
    push_checkpoint,
    [opto_sync_client.MutationResult("1", opto_sync_client.Applied, None, _, _)],
  ) = response
  let assert Ok(queue) = opto_sync_client.acknowledge(queue, request, response)
  opto_sync_client.pending(queue)
  |> should.equal([])

  // The byte-identical retry must be deduplicated by the PostgreSQL ledger.
  let assert Ok(#(200, duplicate_body)) =
    live_support.request("POST", "/v1/sync/push", body)
  let assert Ok(opto_sync_client.PushResponse(
    1,
    _,
    "1",
    _,
    [
      opto_sync_client.MutationResult(
        "1",
        opto_sync_client.Duplicate,
        Some(opto_sync_client.Applied),
        _,
        _,
      ),
    ],
  )) = opto_sync_client.decode_push_response(duplicate_body)

  // Pull proves the mutation traversed the database-backed change ledger.
  let assert Ok(push_checkpoint_number) = int.parse(push_checkpoint)
  let assert Ok(#(200, pulled)) =
    live_support.request(
      "GET",
      "/v1/sync/pull?checkpoint="
        <> int.to_string(push_checkpoint_number - 1)
        <> "&limit=100",
      "",
    )
  string.contains(pulled, record_id)
  |> should.be_true
  string.contains(pulled, "\"operation\":\"upsert\"")
  |> should.be_true

  // Native reconciliation remains available from the same client package.
  opto_sync_client.reconcile(
    "{\"title\":\"local\",\"updatedAt\":300}",
    "{\"title\":\"stale\",\"updatedAt\":100}",
  )
  |> should.equal(Ok("{\"title\":\"local\",\"updatedAt\":300}"))

  // Continue from the acknowledged queue: the tombstone must use id 2.
  let assert Ok(#(queue, _)) =
    opto_sync_client.enqueue_delete(queue, "tasks", record_id, None)
  let assert Ok(delete_request) =
    opto_sync_client.build_push_request(queue, 100)
  let assert opto_sync_client.PushRequest(
    1,
    _,
    [
      opto_sync_client.PushMutation(
        "2",
        opto_sync_client.Delete,
        "tasks",
        _,
        None,
      ),
    ],
  ) = delete_request
  let assert Ok(#(200, delete_body)) =
    live_support.request(
      "POST",
      "/v1/sync/push",
      opto_sync_client.encode_push_request(delete_request),
    )
  let assert Ok(delete_response) =
    opto_sync_client.decode_push_response(delete_body)
  let assert Ok(queue) =
    opto_sync_client.acknowledge(queue, delete_request, delete_response)
  queue
  |> opto_sync_client.pending
  |> list.length
  |> should.equal(0)
}
