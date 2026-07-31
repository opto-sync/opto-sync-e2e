/**
 * WebSocket + TCP transport parity suite for the reference node server.
 *
 * Zero-dependency: Node 22's global WebSocket (undici) and node:net. The
 * server under test must run in test mode (E2E_ALLOW_OPTION_OVERRIDE=1).
 *
 * Asserts, against a running server:
 *  - push/pull/snapshot over `/sync/ws` return byte-for-byte the same bodies
 *    as the HTTP endpoints (the ledger answers an HTTP replay of a WS push
 *    as a duplicate of the same committed mutation);
 *  - a committed push broadcasts `{"v":1,"type":"changed","watermark":N}` to
 *    every OTHER connection, never back to the pusher;
 *  - malformed frames are answered (requestId null) without dropping the
 *    connection;
 *  - when SYNCER_TCP_PORT is set, the same frames work as NDJSON over TCP.
 *
 * Env: BASE_URL (default http://localhost:3003), SYNCER_TCP_PORT (optional),
 * TCP_HOST (default: BASE_URL host).
 */
import assert from "node:assert/strict";
import net from "node:net";

const baseUrl = (process.env.BASE_URL || "http://localhost:3003").replace(/\/$/, "");
const wsUrl = `${baseUrl.replace(/^http/, "ws")}/sync/ws`;
const tcpPort = process.env.SYNCER_TCP_PORT
  ? parseInt(process.env.SYNCER_TCP_PORT, 10)
  : null;
const tcpHost = process.env.TCP_HOST || new URL(baseUrl).hostname;

let assertions = 0;
let cases = 0;
let skipped = 0;

function check(value, message) {
  assertions += 1;
  assert.ok(value, message);
}

function equal(actual, expected, message) {
  assertions += 1;
  assert.deepEqual(actual, expected, message);
}

async function request(method, path, body, extraHeaders = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${method} ${path} returned non-JSON HTTP ${response.status}: ${text}`);
  }
  return { status: response.status, ok: response.ok, json };
}

async function waitForServer() {
  let lastError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const result = await request("GET", "/health");
      if (result.status === 200) return result;
      lastError = new Error(`health returned HTTP ${result.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw lastError ?? new Error("server did not become ready");
}

async function test(name, run) {
  try {
    await run();
    cases += 1;
    console.log(`  PASS ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}`);
    throw error;
  }
}

function sleep(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

// ── Frame clients ────────────────────────────────────────────────────────
// Both expose the same shape: request(), sendRaw(), changed[], anonymous[]
// (error frames with requestId null), nextChanged(), close().

let requestCounter = 0;

function createFrameClient(sendText, closeTransport, label) {
  const pending = new Map();
  const changed = [];
  const anonymous = [];
  const changedWaiters = [];
  const client = {
    changed,
    anonymous,
    handleFrame(text) {
      let frame;
      try {
        frame = JSON.parse(text);
      } catch {
        throw new Error(`${label} sent a non-JSON frame: ${text}`);
      }
      if (frame.type === "changed") {
        changed.push(frame);
        const waiter = changedWaiters.shift();
        if (waiter) waiter(frame);
        return;
      }
      if (frame.requestId === null) {
        anonymous.push(frame);
        return;
      }
      const entry = pending.get(frame.requestId);
      if (entry) {
        pending.delete(frame.requestId);
        clearTimeout(entry.timer);
        entry.resolve(frame);
      }
    },
    fail(error) {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(error);
      }
      pending.clear();
    },
    request(type, body = {}) {
      const requestId = `it-${(requestCounter += 1)}`;
      return new Promise((resolveRequest, reject) => {
        const timer = setTimeout(
          () => {
            pending.delete(requestId);
            reject(new Error(`${label} ${type} ${requestId} timed out`));
          },
          10_000,
        );
        pending.set(requestId, { resolve: resolveRequest, reject, timer });
        sendText(JSON.stringify({ v: 1, type, requestId, ...body }));
      });
    },
    sendRaw(text) {
      sendText(text);
    },
    nextChanged(timeoutMs = 5000) {
      if (changed.length > 0) return Promise.resolve(changed.shift());
      return new Promise((resolveWait, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`${label}: no changed frame within ${timeoutMs}ms`)),
          timeoutMs,
        );
        changedWaiters.push((frame) => {
          clearTimeout(timer);
          const index = changed.indexOf(frame);
          if (index !== -1) changed.splice(index, 1);
          resolveWait(frame);
        });
      });
    },
    close: closeTransport,
  };
  return client;
}

function connectWs(url, label) {
  return new Promise((resolveConnect, reject) => {
    const socket = new WebSocket(url);
    const client = createFrameClient(
      (text) => socket.send(text),
      () => socket.close(),
      label,
    );
    const timer = setTimeout(() => reject(new Error(`${label}: dial timed out`)), 10_000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolveConnect(client);
    });
    socket.addEventListener("message", (event) => client.handleFrame(String(event.data)));
    socket.addEventListener("close", () => client.fail(new Error(`${label} closed`)));
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`${label}: websocket error`));
    });
  });
}

function connectTcp(host, port, label) {
  return new Promise((resolveConnect, reject) => {
    const socket = net.connect({ host, port });
    socket.setEncoding("utf8");
    const client = createFrameClient(
      (text) => socket.write(`${text}\n`),
      () => socket.end(),
      label,
    );
    let buffered = "";
    socket.on("connect", () => resolveConnect(client));
    socket.on("data", (chunk) => {
      buffered += chunk;
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
        if (line.trim() !== "") client.handleFrame(line);
      }
    });
    socket.on("error", (error) => {
      client.fail(error);
      reject(new Error(`${label}: ${error.message}`));
    });
    socket.on("close", () => client.fail(new Error(`${label} closed`)));
  });
}

/** Strip the frame envelope; what remains must equal the HTTP body. */
function frameBody(frame) {
  const { v, type, requestId, ...body } = frame;
  return body;
}

function pushBody(clientId, mutationId, mutation) {
  return {
    protocolVersion: 1,
    clientId,
    mutations: [{ mutationId: String(mutationId), ...mutation }],
  };
}

// Exercises one frame transport end to end so WS and TCP stay in lockstep.
async function transportParitySuite(transport, pusher, observer, docPrefix) {
  const clientId = `${docPrefix}-client`;
  const recordId = `${docPrefix}-doc-1`;
  const body = pushBody(clientId, 1, {
    operation: "upsert",
    table: "docs",
    recordId,
    baseRevision: "0",
    payload: { title: `via ${transport}`, source: transport },
  });

  let pushFrame;
  await test(`${transport}: push applies a mutation`, async () => {
    pushFrame = await pusher.request("push", body);
    equal(pushFrame.type, "push-result");
    equal(pushFrame.protocolVersion, 1);
    equal(pushFrame.clientId, clientId);
    equal(pushFrame.lastMutationId, "1");
    equal(pushFrame.results[0].status, "applied");
    equal(pushFrame.results[0].document.recordId, recordId);
  });

  await test(`${transport}: HTTP sees the same committed mutation (ledger parity)`, async () => {
    const replay = await request("POST", "/v1/sync/push", body);
    equal(replay.status, 200);
    equal(replay.json.results[0].status, "duplicate");
    equal(replay.json.results[0].originalStatus, "applied");
    equal(replay.json.lastMutationId, pushFrame.lastMutationId);
    equal(replay.json.checkpoint, pushFrame.checkpoint);
    equal(replay.json.results[0].document, pushFrame.results[0].document);
  });

  await test(`${transport}: changed broadcast reaches the other connection, not the pusher`, async () => {
    const hint = await observer.nextChanged();
    equal(hint, { v: 1, type: "changed", watermark: Number(pushFrame.checkpoint) });
    await sleep(300);
    equal(pusher.changed, [], "the pushing connection must not receive its own hint");
  });

  await test(`${transport}: pull returns exactly the HTTP pull body`, async () => {
    const frame = await pusher.request("pull", { checkpoint: "0", limit: 100 });
    equal(frame.type, "pull-result");
    const viaHttp = await request("GET", "/v1/sync/pull?checkpoint=0&limit=100");
    equal(viaHttp.status, 200);
    equal(frameBody(frame), viaHttp.json);
    check(
      frame.changes.some((change) => change.recordId === recordId),
      "pull must include the pushed record",
    );
  });

  await test(`${transport}: snapshot returns exactly the HTTP snapshot body`, async () => {
    const frame = await pusher.request("snapshot");
    equal(frame.type, "snapshot-result");
    const viaHttp = await request("GET", "/v1/sync/snapshot");
    equal(viaHttp.status, 200);
    equal(frameBody(frame), viaHttp.json);
  });

  await test(`${transport}: a malformed frame is answered without dropping the connection`, async () => {
    const before = pusher.anonymous.length;
    pusher.sendRaw("this is not json");
    for (let attempt = 0; attempt < 40 && pusher.anonymous.length === before; attempt += 1) {
      await sleep(50);
    }
    const answer = pusher.anonymous[before];
    check(answer, "expected an error frame for the malformed line");
    equal(answer.type, "error");
    equal(answer.requestId, null);
    equal(answer.code, "MALFORMED_FRAME");
    // The connection must still serve requests.
    const alive = await pusher.request("snapshot");
    equal(alive.type, "snapshot-result");
  });

  await test(`${transport}: an unknown frame type and an invalid push answer error frames`, async () => {
    const unknown = await pusher.request("subscribe");
    equal(unknown.type, "error");
    equal(unknown.code, "UNSUPPORTED_FRAME_TYPE");
    equal(unknown.retryable, false);

    const invalid = await pusher.request("push", {
      protocolVersion: 1,
      clientId: "bad client id",
      mutations: [],
    });
    equal(invalid.type, "error");
    equal(invalid.code, "INVALID_PUSH");
    equal(invalid.retryable, false);
  });
}

// ── Suite ────────────────────────────────────────────────────────────────

console.log("\n=== opto-sync websocket/TCP transport parity ===");
console.log(`target: ${baseUrl} (ws: ${wsUrl}${tcpPort ? `, tcp: ${tcpHost}:${tcpPort}` : ", tcp: disabled"})`);

await test("server is healthy and in test mode", async () => {
  const health = await waitForServer();
  equal(health.status, 200);
  equal(health.json.testMode, true, "this suite requires E2E_ALLOW_OPTION_OVERRIDE=1");
});

await test("reset clears protocol state", async () => {
  const result = await request("POST", "/reset", {});
  equal(result.status, 200);
});

const wsA = await connectWs(wsUrl, "ws-a");
const wsB = await connectWs(wsUrl, "ws-b");

await transportParitySuite("websocket", wsA, wsB, "ws-tp");

await test("an HTTP push broadcasts changed to every websocket", async () => {
  // Drain hints left over from the parity suite before provoking a new one.
  wsA.changed.length = 0;
  wsB.changed.length = 0;
  const viaHttp = await request(
    "POST",
    "/v1/sync/push",
    pushBody("http-tp-client", 1, {
      operation: "upsert",
      table: "docs",
      recordId: "http-tp-doc-1",
      baseRevision: "0",
      payload: { title: "via http" },
    }),
  );
  equal(viaHttp.status, 200);
  const watermark = Number(viaHttp.json.checkpoint);
  equal(await wsA.nextChanged(), { v: 1, type: "changed", watermark });
  equal(await wsB.nextChanged(), { v: 1, type: "changed", watermark });
});

if (tcpPort) {
  const tcp = await connectTcp(tcpHost, tcpPort, "tcp-a");
  await transportParitySuite("tcp", tcp, wsB, "tcp-tp");
  await test("tcp: websocket pushes reach TCP observers too", async () => {
    tcp.changed.length = 0;
    const frame = await wsA.request(
      "push",
      pushBody("ws-tp-client", 2, {
        operation: "upsert",
        table: "docs",
        recordId: "ws-tp-doc-1",
        payload: { title: "second write" },
      }),
    );
    equal(frame.type, "push-result");
    equal(frame.results[0].status, "applied");
    equal(await tcp.nextChanged(), {
      v: 1,
      type: "changed",
      watermark: Number(frame.checkpoint),
    });
  });
  tcp.close();
} else {
  skipped += 1;
  console.log("  SKIP tcp parity (SYNCER_TCP_PORT is not set)");
}

wsA.close();
wsB.close();

console.log(
  `\nTransport parity: ${cases} cases passed, ${assertions} assertions passed` +
    (skipped ? `, ${skipped} skipped` : "") +
    "\n",
);
