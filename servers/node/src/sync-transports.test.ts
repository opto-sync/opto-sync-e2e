import assert from "node:assert/strict";
import test from "node:test";

import type { ProtocolCallResult, SyncProtocolRuntime } from "./protocol.js";
import {
  MAX_BROADCAST_BUFFERED_BYTES,
  SyncChangeHub,
  createProtocolFrameHandlers,
  routeFrame,
  type FrameHandlers,
  type FrameMeta,
} from "./sync-transports.js";

type Call =
  | { route: "push"; body: Record<string, unknown>; meta: FrameMeta }
  | { route: "pull"; checkpoint: unknown; limit: unknown; meta: FrameMeta }
  | { route: "snapshot"; meta: FrameMeta };

function fakeHandlers(
  result: ProtocolCallResult | (() => Promise<ProtocolCallResult>),
): { handlers: FrameHandlers; calls: Call[] } {
  const calls: Call[] = [];
  const resolve = () =>
    typeof result === "function" ? result() : Promise.resolve(result);
  return {
    calls,
    handlers: {
      push: (body, meta) => {
        calls.push({ route: "push", body, meta });
        return resolve();
      },
      pull: (checkpoint, limit, meta) => {
        calls.push({ route: "pull", checkpoint, limit, meta });
        return resolve();
      },
      snapshot: (meta) => {
        calls.push({ route: "snapshot", meta });
        return resolve();
      },
    },
  };
}

async function route(
  frame: unknown,
  result: ProtocolCallResult | (() => Promise<ProtocolCallResult>),
): Promise<{ sent: Record<string, unknown>[]; calls: Call[] }> {
  const sent: Record<string, unknown>[] = [];
  const { handlers, calls } = fakeHandlers(result);
  const raw = typeof frame === "string" ? frame : JSON.stringify(frame);
  await routeFrame(raw, handlers, (out) => sent.push(out));
  return { sent, calls };
}

const ok: ProtocolCallResult = { status: 200, body: { protocolVersion: 1 } };

test("a push frame reaches the push handler with the exact HTTP body", async () => {
  const raw = JSON.stringify({
    v: 1,
    type: "push",
    requestId: "r-1",
    protocolVersion: 1,
    clientId: "client-a",
    mutations: [{ mutationId: "1", operation: "delete", table: "docs", recordId: "d" }],
  });
  const { sent, calls } = await route(raw, {
    status: 200,
    body: { protocolVersion: 1, checkpoint: "7", results: [] },
  });
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.route, "push");
  if (call.route !== "push") return;
  // The wire envelope is stripped; what remains is the HTTP push body.
  assert.deepEqual(Object.keys(call.body).sort(), [
    "clientId",
    "mutations",
    "protocolVersion",
  ]);
  assert.equal(call.meta.frameBytes, Buffer.byteLength(raw));
  assert.deepEqual(sent, [
    {
      v: 1,
      type: "push-result",
      requestId: "r-1",
      protocolVersion: 1,
      checkpoint: "7",
      results: [],
    },
  ]);
});

test("an optional token field is lifted into meta and stripped from the body", async () => {
  const { calls } = await route(
    { v: 1, type: "push", requestId: "r-2", token: "secret", clientId: "c", mutations: [] },
    ok,
  );
  const call = calls[0];
  assert.equal(call.route, "push");
  if (call.route !== "push") return;
  assert.equal(call.meta.token, "secret");
  assert.equal("token" in call.body, false);
});

test("a pull frame forwards checkpoint and limit and answers pull-result", async () => {
  const { sent, calls } = await route(
    { v: 1, type: "pull", requestId: "r-3", checkpoint: "41", limit: 25 },
    { status: 200, body: { protocolVersion: 1, checkpoint: "42", hasMore: false, changes: [] } },
  );
  const call = calls[0];
  assert.equal(call.route, "pull");
  if (call.route !== "pull") return;
  assert.equal(call.checkpoint, "41");
  assert.equal(call.limit, 25);
  assert.equal(sent[0].type, "pull-result");
  assert.equal(sent[0].requestId, "r-3");
  assert.equal(sent[0].checkpoint, "42");
});

test("the RESET_REQUIRED 409 pull body is delivered as a pull-result frame", async () => {
  const resetBody = {
    protocolVersion: 1,
    error: "RESET_REQUIRED",
    resetRequired: true,
    minimumCheckpoint: "10",
    snapshotUrl: "/v1/sync/snapshot",
  };
  const { sent } = await route(
    { v: 1, type: "pull", requestId: "r-4", checkpoint: "1", limit: 10 },
    { status: 409, body: resetBody },
  );
  assert.deepEqual(sent, [{ v: 1, type: "pull-result", requestId: "r-4", ...resetBody }]);
});

test("a snapshot frame answers snapshot-result", async () => {
  const { sent, calls } = await route(
    { v: 1, type: "snapshot", requestId: "r-5" },
    { status: 200, body: { protocolVersion: 1, checkpoint: "9", records: [] } },
  );
  assert.equal(calls[0].route, "snapshot");
  assert.equal(sent[0].type, "snapshot-result");
  assert.equal(sent[0].checkpoint, "9");
});

test("non-2xx results become error frames with status-derived retryability", async () => {
  const conflict = await route(
    { v: 1, type: "push", requestId: "r-6", clientId: "c", mutations: [] },
    { status: 409, body: { protocolVersion: 1, error: "MUTATION_GAP", message: "gap" } },
  );
  assert.deepEqual(conflict.sent, [
    {
      v: 1,
      type: "error",
      requestId: "r-6",
      code: "MUTATION_GAP",
      message: "gap",
      retryable: false,
    },
  ]);

  const throttled = await route(
    { v: 1, type: "pull", requestId: "r-7", checkpoint: "0", limit: 1 },
    { status: 429, body: { protocolVersion: 1, error: "RATE_LIMITED" } },
  );
  assert.equal(throttled.sent[0].code, "RATE_LIMITED");
  assert.equal(throttled.sent[0].retryable, true);

  const failed = await route(
    { v: 1, type: "snapshot", requestId: "r-8" },
    { status: 500, body: { protocolVersion: 1, error: "SNAPSHOT_FAILED", message: "boom" } },
  );
  assert.equal(failed.sent[0].retryable, true);
});

test("a status without a readable error code falls back to HTTP_<status>", async () => {
  const { sent } = await route(
    { v: 1, type: "snapshot", requestId: "r-9" },
    { status: 404, body: {} },
  );
  assert.equal(sent[0].code, "HTTP_404");
  assert.equal(sent[0].message, "HTTP_404");
});

test("a throwing handler answers INTERNAL and never propagates", async () => {
  const { sent } = await route(
    { v: 1, type: "push", requestId: "r-10", clientId: "c", mutations: [] },
    () => Promise.reject(new Error("handler bug")),
  );
  assert.deepEqual(sent, [
    {
      v: 1,
      type: "error",
      requestId: "r-10",
      code: "INTERNAL",
      message: "Internal server error",
      retryable: true,
    },
  ]);
});

test("unparseable and non-object frames answer requestId null without crashing", async () => {
  for (const raw of ["this is not json", "[1,2,3]", '"just a string"', "null"]) {
    const { sent, calls } = await route(raw, ok);
    assert.equal(calls.length, 0, raw);
    assert.deepEqual(sent, [
      {
        v: 1,
        type: "error",
        requestId: null,
        code: "MALFORMED_FRAME",
        message: "frame is not a JSON object",
        retryable: false,
      },
    ]);
  }
});

test("a frame without v:1 is rejected before dispatch", async () => {
  const { sent, calls } = await route({ v: 2, type: "pull", requestId: "r-11" }, ok);
  assert.equal(calls.length, 0);
  assert.equal(sent[0].code, "UNSUPPORTED_PROTOCOL_VERSION");
  assert.equal(sent[0].requestId, "r-11");
});

test("a missing or invalid requestId answers requestId null", async () => {
  for (const frame of [
    { v: 1, type: "pull" },
    { v: 1, type: "pull", requestId: "" },
    { v: 1, type: "pull", requestId: 7 },
    { v: 1, type: "pull", requestId: "x".repeat(300) },
  ]) {
    const { sent, calls } = await route(frame, ok);
    assert.equal(calls.length, 0);
    assert.equal(sent[0].code, "INVALID_REQUEST_ID");
    assert.equal(sent[0].requestId, null);
  }
});

test("an unknown frame type is answered on its requestId", async () => {
  const { sent, calls } = await route({ v: 1, type: "subscribe", requestId: "r-12" }, ok);
  assert.equal(calls.length, 0);
  assert.deepEqual(sent, [
    {
      v: 1,
      type: "error",
      requestId: "r-12",
      code: "UNSUPPORTED_FRAME_TYPE",
      message: 'unknown frame type "subscribe"',
      retryable: false,
    },
  ]);
});

test("a responseLoss result stays silent (after-commit-response-loss parity)", async () => {
  const { sent } = await route(
    { v: 1, type: "push", requestId: "r-13", clientId: "c", mutations: [] },
    { status: 200, body: {}, responseLoss: true },
  );
  assert.deepEqual(sent, []);
});

test("a throwing send callback is contained by the router", async () => {
  const { handlers } = fakeHandlers(ok);
  await assert.doesNotReject(
    routeFrame(JSON.stringify({ v: 1, type: "snapshot", requestId: "r-14" }), handlers, () => {
      throw new Error("socket already gone");
    }),
  );
});

// ── SyncChangeHub ────────────────────────────────────────────────────────

function hubConnection(buffered = 0) {
  const received: string[] = [];
  return {
    received,
    connection: {
      send: (text: string) => {
        received.push(text);
      },
      bufferedBytes: () => buffered,
    },
  };
}

test("broadcast reaches every connection except the pushing origin", () => {
  const hub = new SyncChangeHub();
  const origin = hubConnection();
  const other = hubConnection();
  hub.add(origin.connection);
  hub.add(other.connection);

  hub.broadcast(17, origin.connection);
  assert.deepEqual(origin.received, []);
  assert.deepEqual(other.received, [JSON.stringify({ v: 1, type: "changed", watermark: 17 })]);

  // An HTTP push has no realtime origin: everyone gets the hint.
  hub.broadcast(18, undefined);
  assert.equal(origin.received.length, 1);
  assert.equal(other.received.length, 2);
});

test("backpressured connections are skipped and a throwing send is isolated", () => {
  const hub = new SyncChangeHub();
  const slow = hubConnection(MAX_BROADCAST_BUFFERED_BYTES);
  const broken = {
    send: () => {
      throw new Error("socket closed mid-send");
    },
    bufferedBytes: () => 0,
  };
  const healthy = hubConnection();
  hub.add(slow.connection);
  hub.add(broken);
  hub.add(healthy.connection);

  assert.doesNotThrow(() => hub.broadcast(3));
  assert.deepEqual(slow.received, []);
  assert.equal(healthy.received.length, 1);

  hub.remove(slow.connection);
  hub.remove(broken);
  assert.equal(hub.size(), 1);
});

// ── createProtocolFrameHandlers (fake runtime, no Postgres) ──────────────

function fakeRuntime(overrides: Partial<SyncProtocolRuntime> = {}): {
  runtime: SyncProtocolRuntime;
  pushes: { context: Record<string, unknown>; body: unknown }[];
} {
  const pushes: { context: Record<string, unknown>; body: unknown }[] = [];
  const runtime = {
    testMode: true,
    newRequestId: () => "req-fixed",
    authenticate: async () => ({
      status: "authenticated" as const,
      identity: { subject: "s", tenantId: "t", clientIds: null },
    }),
    consumeRateLimit: () => ({ allowed: true, retryAfterSeconds: 0 }),
    push: async (context: unknown, body: unknown) => {
      pushes.push({ context: context as Record<string, unknown>, body });
      return { status: 200, body: { protocolVersion: 1, checkpoint: "3" } };
    },
    pull: async () => ({ status: 200, body: { protocolVersion: 1 } }),
    snapshot: async () => ({ status: 200, body: { protocolVersion: 1 } }),
    ...overrides,
  } as SyncProtocolRuntime;
  return { runtime, pushes };
}

const authenticated = async (): Promise<
  Awaited<ReturnType<SyncProtocolRuntime["authenticate"]>>
> => ({
  status: "authenticated",
  identity: { subject: "s", tenantId: "t", clientIds: null },
});

test("frame handlers thread identity, frame bytes, and origin into the runtime", async () => {
  const { runtime, pushes } = fakeRuntime();
  const origin = { marker: true };
  const handlers = createProtocolFrameHandlers(runtime, authenticated, origin);
  const result = await handlers.push(
    { clientId: "c", mutations: [] },
    { frameBytes: 123 },
  );
  assert.equal(result.status, 200);
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].context.rawBodyBytes, 123);
  assert.equal(pushes[0].context.origin, origin);
  assert.equal(pushes[0].context.requestId, "req-fixed");
  assert.deepEqual(pushes[0].body, { clientId: "c", mutations: [] });
});

test("a denied identity answers 401 without touching the runtime handlers", async () => {
  const { runtime, pushes } = fakeRuntime();
  const handlers = createProtocolFrameHandlers(
    runtime,
    async () => ({ status: "denied" }),
    undefined,
  );
  const result = await handlers.push({ clientId: "c" }, { frameBytes: 10 });
  assert.deepEqual(result, {
    status: 401,
    body: { protocolVersion: 1, error: "UNAUTHORIZED" },
  });
  assert.equal(pushes.length, 0);
});

test("an unavailable verifier answers 503 and a rate-limited frame answers 429", async () => {
  const { runtime } = fakeRuntime();
  const unavailable = createProtocolFrameHandlers(
    runtime,
    async () => ({ status: "unavailable" }),
    undefined,
  );
  assert.equal((await unavailable.snapshot({ frameBytes: 2 })).status, 503);

  const { runtime: throttling } = fakeRuntime({
    consumeRateLimit: () => ({ allowed: false, retryAfterSeconds: 9 }),
  });
  const limited = createProtocolFrameHandlers(throttling, authenticated, undefined);
  const result = await limited.pull("0", 10, { frameBytes: 2 });
  assert.deepEqual(result, {
    status: 429,
    body: { protocolVersion: 1, error: "RATE_LIMITED", retryAfterSeconds: 9 },
  });
});
