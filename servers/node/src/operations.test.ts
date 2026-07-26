import assert from "node:assert/strict";
import test from "node:test";

import {
  auditEvent,
  FixedWindowRateLimiter,
  loadOperationalConfig,
  privacyHash,
  ProtocolMetrics,
  protocolRouteLabel,
} from "./operations.js";

test("fixed-window limiter resets exactly at the next window", () => {
  const limiter = new FixedWindowRateLimiter(2, 1000);
  assert.deepEqual(limiter.consume("principal", 100), {
    allowed: true,
    retryAfterSeconds: 0,
  });
  assert.deepEqual(limiter.consume("principal", 200), {
    allowed: true,
    retryAfterSeconds: 0,
  });
  assert.deepEqual(limiter.consume("principal", 300), {
    allowed: false,
    retryAfterSeconds: 1,
  });
  assert.deepEqual(limiter.consume("principal", 1100), {
    allowed: true,
    retryAfterSeconds: 0,
  });
});

test("zero requests delegates limiting to an external implementation", () => {
  const limiter = new FixedWindowRateLimiter(0, 1000);
  for (let index = 0; index < 100; index += 1) {
    assert.equal(limiter.consume("principal", index).allowed, true);
  }
  assert.equal(limiter.size(), 0);
});

test("Prometheus rendering uses bounded labels and cumulative histograms", () => {
  const metrics = new ProtocolMetrics();
  metrics.observeRequest("push", "POST", 200, 0.02);
  metrics.observeRequest("push", "POST", 413, 0.2);
  metrics.increment("opto_sync_protocol_mutations_total", {
    outcome: "applied",
  });
  const rendered = metrics.render();
  assert.match(rendered, /# TYPE opto_sync_protocol_request_duration_seconds histogram/);
  assert.match(
    rendered,
    /opto_sync_protocol_request_duration_seconds_bucket\{le="0.025",method="POST",route="push",status_class="2xx"\} 1/,
  );
  assert.match(
    rendered,
    /opto_sync_protocol_requests_total\{method="POST",route="push",status_class="4xx"\} 1/,
  );
  assert.doesNotMatch(rendered, /tenant|subject|client_id|record_id/);
});

test("audit output is one versioned JSON object and identifiers can be hashed", () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (value?: unknown) => lines.push(String(value));
  try {
    auditEvent("protocol.test", {
      principalHash: privacyHash("tenant\u0000subject"),
      outcome: "allowed",
    });
  } finally {
    console.log = original;
  }
  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]);
  assert.equal(event.schema, "opto_sync.audit.v1");
  assert.equal(event.event, "protocol.test");
  assert.match(event.principalHash, /^[a-f0-9]{16}$/);
  assert.equal(event.outcome, "allowed");
  assert.ok(Number.isFinite(Date.parse(event.timestamp)));
  assert.doesNotMatch(lines[0], /tenant|subject/);
});

test("invalid operational environment fails startup configuration", () => {
  const prior = process.env.SYNCER_PROTOCOL_MAX_PUSH_BYTES;
  process.env.SYNCER_PROTOCOL_MAX_PUSH_BYTES = "not-an-integer";
  try {
    assert.throws(
      () => loadOperationalConfig(true),
      /SYNCER_PROTOCOL_MAX_PUSH_BYTES must be an integer/,
    );
  } finally {
    if (prior === undefined) {
      delete process.env.SYNCER_PROTOCOL_MAX_PUSH_BYTES;
    } else {
      process.env.SYNCER_PROTOCOL_MAX_PUSH_BYTES = prior;
    }
  }
});

test("route labels cannot gain unbounded record-id cardinality", () => {
  assert.equal(protocolRouteLabel("/push"), "push");
  assert.equal(protocolRouteLabel("/admin/compact"), "admin_compact");
  assert.equal(protocolRouteLabel("/anything/user-controlled"), "unknown");
});
