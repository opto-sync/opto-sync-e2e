/// Minimal e2e transport. The published client stays transport-neutral.
pub fn request(
  method: String,
  path: String,
  body: String,
) -> Result(#(Int, String), Nil) {
  request_ffi(method, path, body)
}

pub fn unique_id() -> String {
  unique_id_ffi()
}

@external(erlang, "opto_sync_gleam_e2e_ffi", "request")
fn request_ffi(
  method: String,
  path: String,
  body: String,
) -> Result(#(Int, String), Nil)

@external(erlang, "opto_sync_gleam_e2e_ffi", "unique_id")
fn unique_id_ffi() -> String
