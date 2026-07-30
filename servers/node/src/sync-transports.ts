/**
 * WebSocket and TCP sync transports for the reference node server.
 *
 * Wire contract (shared with the TS/Dart/Rust client transports — do not
 * deviate):
 * - WebSocket endpoint at `/sync/ws` on the HTTP port (upgrade). JSON text
 *   frames, one JSON object per frame.
 * - TCP: the same frames as newline-delimited JSON (NDJSON, UTF-8, no raw
 *   newline inside a frame) on a dedicated listener, enabled only when
 *   `SYNCER_TCP_PORT` is set. TCP exists for native/server-side clients;
 *   browsers cannot open raw TCP sockets and use the WebSocket endpoint.
 * - client→server: `{"v":1,"type":"push"|"pull"|"snapshot","requestId":"<unique>",...body}`
 * - server→client: `{"v":1,"type":"push-result"|"pull-result"|"snapshot-result","requestId",...body}`,
 *   `{"v":1,"type":"error","requestId","code","message","retryable"}`, and the
 *   unsolicited pull hint `{"v":1,"type":"changed","watermark":<number>}`
 *   broadcast to every OTHER connection after a push commits changes.
 *
 * All business logic lives in the shared {@link SyncProtocolRuntime}; this
 * module only parses frames, authenticates connections, and fans out change
 * hints. A malformed frame is answered (or dropped) without ever taking the
 * connection or the process down.
 */
import type { IncomingMessage, Server as HttpServer } from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";

import { WebSocketServer, type WebSocket } from "ws";

import type { AuthenticationResult, ProtocolIdentity } from "./auth.js";
import type { ProtocolCallResult, SyncProtocolRuntime } from "./protocol.js";

export const SYNC_WS_PATH = "/sync/ws";
/** Matches the HTTP express.json limit so no transport widens the quota. */
const MAX_FRAME_BYTES = 32 * 1024 * 1024;
/**
 * `changed` hints are skipped, not queued, for connections this far behind:
 * a hint only says "pull when you can", so dropping it under backpressure is
 * strictly better than growing the buffer of an already-slow consumer.
 */
export const MAX_BROADCAST_BUFFERED_BYTES = 1024 * 1024;

// ── Change hub ───────────────────────────────────────────────────────────

/** Minimal connection surface the hub needs; WS and TCP both adapt to it. */
export type HubConnection = {
  send(text: string): void;
  bufferedBytes(): number;
};

export class SyncChangeHub {
  private readonly connections = new Set<HubConnection>();

  add(connection: HubConnection): void {
    this.connections.add(connection);
  }

  remove(connection: HubConnection): void {
    this.connections.delete(connection);
  }

  size(): number {
    return this.connections.size;
  }

  /**
   * Pull hint, never data. `except` is the pushing connection (undefined for
   * HTTP pushes, which have no realtime connection of their own).
   */
  broadcast(watermark: number, except?: unknown): void {
    const frame = JSON.stringify({ v: 1, type: "changed", watermark });
    for (const connection of this.connections) {
      if (connection === except) continue;
      if (connection.bufferedBytes() >= MAX_BROADCAST_BUFFERED_BYTES) continue;
      try {
        connection.send(frame);
      } catch {
        // A dying socket must not break the fan-out; its own close handler
        // removes it from the hub.
      }
    }
  }
}

// ── Frame router (pure; unit-tested without Postgres) ────────────────────

export type FrameMeta = {
  /** Exact bytes received for this frame; feeds the push byte quota. */
  frameBytes: number;
  /** Optional per-frame bearer token (TCP clients have no URL to carry it). */
  token?: string;
};

/**
 * Transport-agnostic request handlers. Production wires these to the shared
 * {@link SyncProtocolRuntime}; unit tests inject fakes.
 */
export type FrameHandlers = {
  push(
    body: Record<string, unknown>,
    meta: FrameMeta,
  ): Promise<ProtocolCallResult>;
  pull(
    checkpoint: unknown,
    limit: unknown,
    meta: FrameMeta,
  ): Promise<ProtocolCallResult>;
  snapshot(meta: FrameMeta): Promise<ProtocolCallResult>;
};

function errorFrame(
  requestId: string | null,
  code: string,
  message: string,
  retryable: boolean,
): Record<string, unknown> {
  return { v: 1, type: "error", requestId, code, message, retryable };
}

/** Server faults and throttling are worth retrying; client mistakes are not. */
function retryableStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

/**
 * Parse one frame, dispatch it, and answer through `send`. Never throws and
 * never closes the connection: a malformed frame is answered with a
 * `type:"error"` frame carrying the requestId when one was readable, or
 * `requestId:null` when the frame was unparseable.
 */
export async function routeFrame(
  raw: string,
  handlers: FrameHandlers,
  send: (frame: Record<string, unknown>) => void,
): Promise<void> {
  try {
    let frame: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
      frame = parsed as Record<string, unknown>;
    } catch {
      send(errorFrame(null, "MALFORMED_FRAME", "frame is not a JSON object", false));
      return;
    }

    const requestId =
      typeof frame.requestId === "string" &&
      frame.requestId.length >= 1 &&
      frame.requestId.length <= 256
        ? frame.requestId
        : null;
    if (frame.v !== 1) {
      send(
        errorFrame(
          requestId,
          "UNSUPPORTED_PROTOCOL_VERSION",
          "frame field v must be 1",
          false,
        ),
      );
      return;
    }
    if (requestId === null) {
      send(
        errorFrame(
          null,
          "INVALID_REQUEST_ID",
          "requestId must be a string of 1 to 256 characters",
          false,
        ),
      );
      return;
    }
    const type = frame.type;
    if (type !== "push" && type !== "pull" && type !== "snapshot") {
      send(
        errorFrame(
          requestId,
          "UNSUPPORTED_FRAME_TYPE",
          `unknown frame type ${JSON.stringify(frame.type)}`,
          false,
        ),
      );
      return;
    }

    const meta: FrameMeta = {
      frameBytes: Buffer.byteLength(raw),
      ...(typeof frame.token === "string" ? { token: frame.token } : {}),
    };
    let result: ProtocolCallResult;
    try {
      if (type === "push") {
        // The remaining fields are exactly the HTTP push body.
        const { v: _v, type: _t, requestId: _r, token: _token, ...body } = frame;
        result = await handlers.push(body, meta);
      } else if (type === "pull") {
        result = await handlers.pull(frame.checkpoint, frame.limit, meta);
      } else {
        result = await handlers.snapshot(meta);
      }
    } catch (error) {
      // Handler bugs answer this one request; the connection survives.
      console.error(`[sync-transport] ${type} frame failed:`, error);
      send(errorFrame(requestId, "INTERNAL", "Internal server error", true));
      return;
    }

    if (result.responseLoss) return; // test failpoint: committed, stay silent
    const success = result.status >= 200 && result.status < 300;
    // The RESET_REQUIRED 409 body is part of the pull response contract;
    // clients resolve it from a pull-result frame exactly like the HTTP body.
    const resetRequired = type === "pull" && result.body.resetRequired === true;
    if (success || resetRequired) {
      send({ v: 1, type: `${type}-result`, requestId, ...result.body });
      return;
    }
    const code =
      typeof result.body.error === "string"
        ? result.body.error
        : `HTTP_${result.status}`;
    const message =
      typeof result.body.message === "string" ? result.body.message : code;
    send(errorFrame(requestId, code, message, retryableStatus(result.status)));
  } catch (error) {
    // Last-resort guard (including a throwing `send`): never crash the server.
    console.error("[sync-transport] frame router failure:", error);
  }
}

// ── Runtime-backed handlers (shared by WS and TCP) ───────────────────────

/** Resolves the identity for one frame; may consult a per-frame token. */
export type IdentityResolver = (
  frameToken: string | undefined,
) => Promise<AuthenticationResult>;

/**
 * Bind the frame router to the shared protocol runtime, mirroring the HTTP
 * middleware order: authenticate, rate-limit, then dispatch into the same
 * core handlers the Express routes use.
 */
export function createProtocolFrameHandlers(
  runtime: SyncProtocolRuntime,
  resolveIdentity: IdentityResolver,
  origin: unknown,
): FrameHandlers {
  const call = async (
    route: "push" | "pull" | "snapshot",
    meta: FrameMeta,
    dispatch: (identity: ProtocolIdentity) => Promise<ProtocolCallResult>,
  ): Promise<ProtocolCallResult> => {
    const authenticated = await resolveIdentity(meta.token);
    if (authenticated.status === "unavailable") {
      return {
        status: 503,
        body: { protocolVersion: 1, error: "AUTHENTICATION_UNAVAILABLE" },
      };
    }
    if (authenticated.status !== "authenticated") {
      return { status: 401, body: { protocolVersion: 1, error: "UNAUTHORIZED" } };
    }
    const decision = runtime.consumeRateLimit(authenticated.identity, route);
    if (!decision.allowed) {
      return {
        status: 429,
        body: {
          protocolVersion: 1,
          error: "RATE_LIMITED",
          retryAfterSeconds: decision.retryAfterSeconds,
        },
      };
    }
    return dispatch(authenticated.identity);
  };

  return {
    push: (body, meta) =>
      call("push", meta, (identity) =>
        runtime.push(
          {
            requestId: runtime.newRequestId(),
            identity,
            rawBodyBytes: meta.frameBytes,
            origin,
          },
          body,
        ),
      ),
    pull: (checkpoint, limit, meta) =>
      call("pull", meta, (identity) =>
        runtime.pull(
          { requestId: runtime.newRequestId(), identity, origin },
          checkpoint,
          limit,
        ),
      ),
    snapshot: (meta) =>
      call("snapshot", meta, (identity) =>
        runtime.snapshot({ requestId: runtime.newRequestId(), identity, origin }),
      ),
  };
}

// ── WebSocket transport ──────────────────────────────────────────────────

/**
 * Attach the `/sync/ws` upgrade endpoint to an HTTP server. Authentication
 * mirrors the HTTP path: test mode is unauthenticated (with the same
 * x-syncer-test-* overrides accepted as query parameters), production mode
 * verifies the bearer token the client appended as `?token=...`.
 */
export function attachWebSocketTransport(
  server: HttpServer,
  runtime: SyncProtocolRuntime,
  hub: SyncChangeHub,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  const bindConnection = (client: WebSocket, identity: ProtocolIdentity) => {
    const connection: HubConnection = {
      send: (text) => client.send(text),
      bufferedBytes: () => client.bufferedAmount,
    };
    // The socket was authenticated at upgrade time; every frame reuses it.
    const resolved: AuthenticationResult = { status: "authenticated", identity };
    const handlers = createProtocolFrameHandlers(
      runtime,
      async () => resolved,
      connection,
    );
    hub.add(connection);
    client.on("close", () => hub.remove(connection));
    client.on("error", () => {
      // `close` follows and cleans up; an errored peer must not crash us.
    });
    client.on("message", (data) => {
      void routeFrame(data.toString(), handlers, (frame) => {
        if (client.readyState === client.OPEN) client.send(JSON.stringify(frame));
      });
    });
  };

  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://localhost");
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== SYNC_WS_PATH) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    void (async () => {
      const authenticated = await runtime.authenticate({
        token: url.searchParams.get("token"),
        testTenantId: url.searchParams.get("x-syncer-test-tenant"),
        testSubject: url.searchParams.get("x-syncer-test-subject"),
        testClientId: url.searchParams.get("x-syncer-test-client-id"),
      });
      if (authenticated.status !== "authenticated") {
        const line =
          authenticated.status === "unavailable"
            ? "HTTP/1.1 503 Service Unavailable"
            : "HTTP/1.1 401 Unauthorized";
        socket.write(`${line}\r\nConnection: close\r\n\r\n`);
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (client) => {
        bindConnection(client, authenticated.identity);
      });
    })().catch((error) => {
      console.error("[sync-transport] websocket upgrade failed:", error);
      socket.destroy();
    });
  });

  return wss;
}

// ── TCP NDJSON transport (native/server-side clients only) ───────────────

/**
 * Start the NDJSON listener for native clients. Browsers cannot open raw TCP
 * sockets — they use the WebSocket endpoint — so this listener only starts
 * when SYNCER_TCP_PORT is explicitly configured. Production-mode clients
 * authenticate with a `token` field on each request frame (verified once per
 * connection per token); test mode mirrors the unauthenticated HTTP default.
 */
export function startTcpTransport(
  port: number,
  runtime: SyncProtocolRuntime,
  hub: SyncChangeHub,
  host = "0.0.0.0",
): net.Server {
  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    // Let Node reassemble multi-byte UTF-8 sequences split across packets.
    socket.setEncoding("utf8");

    const connection: HubConnection = {
      send: (text) => {
        socket.write(`${text}\n`);
      },
      bufferedBytes: () => socket.writableLength,
    };
    const verified = new Map<string, AuthenticationResult>();
    const resolveIdentity: IdentityResolver = async (frameToken) => {
      const key = frameToken ?? "";
      const cached = verified.get(key);
      if (cached !== undefined) return cached;
      const result = await runtime.authenticate({ token: frameToken ?? null });
      // Terminal outcomes are cached; a transient verifier outage is not.
      if (result.status !== "unavailable") verified.set(key, result);
      return result;
    };
    const handlers = createProtocolFrameHandlers(runtime, resolveIdentity, connection);
    hub.add(connection);

    let buffered = "";
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      if (buffered.length > MAX_FRAME_BYTES) {
        // A frame this large without a newline is a broken or hostile peer.
        socket.destroy();
        return;
      }
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        const line = buffered.slice(0, newline).replace(/\r$/, "");
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
        if (line.trim() === "") continue;
        void routeFrame(line, handlers, (frame) => {
          if (!socket.destroyed) socket.write(`${JSON.stringify(frame)}\n`);
        });
      }
    });
    socket.on("close", () => hub.remove(connection));
    socket.on("error", () => {
      // `close` follows and cleans up.
    });
  });

  server.on("error", (error) => {
    console.error("[sync-transport] TCP listener error:", error);
  });
  server.listen(port, host, () => {
    const address = server.address();
    const bound = typeof address === "object" && address !== null ? address.port : port;
    console.log(`[sync-transport] TCP NDJSON sync listener on ${host}:${bound}`);
  });
  return server;
}
