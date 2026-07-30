import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import type express from "express";

const HISTOGRAM_BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

function integerSetting(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export type OperationalConfig = {
  maxPushBytes: number;
  maxMutationBytes: number;
  maxPushMutations: number;
  maxSnapshotRecords: number;
  maxSnapshotBytes: number;
  rateLimitRequests: number;
  rateLimitWindowMs: number;
  metricsTokenDigest?: Buffer;
  metricsConfigurationError?: string;
};

export function loadOperationalConfig(testMode: boolean): OperationalConfig {
  const metricsToken = process.env.SYNCER_METRICS_TOKEN;
  let metricsTokenDigest: Buffer | undefined;
  let metricsConfigurationError: string | undefined;
  if (metricsToken !== undefined) {
    if (metricsToken.length < 32 || metricsToken.length > 4096) {
      metricsConfigurationError = "SYNCER_METRICS_TOKEN must contain 32 to 4096 characters";
    } else {
      metricsTokenDigest = tokenDigest(metricsToken);
    }
  } else if (!testMode) {
    metricsConfigurationError = "metrics authentication is not configured";
  }

  return {
    maxPushBytes: integerSetting(
      "SYNCER_PROTOCOL_MAX_PUSH_BYTES",
      1024 * 1024,
      1024,
      32 * 1024 * 1024,
    ),
    maxMutationBytes: integerSetting(
      "SYNCER_PROTOCOL_MAX_MUTATION_BYTES",
      256 * 1024,
      256,
      16 * 1024 * 1024,
    ),
    maxPushMutations: integerSetting(
      "SYNCER_PROTOCOL_MAX_PUSH_MUTATIONS",
      100,
      1,
      100,
    ),
    maxSnapshotRecords: integerSetting(
      "SYNCER_PROTOCOL_MAX_SNAPSHOT_RECORDS",
      100_000,
      1,
      10_000_000,
    ),
    maxSnapshotBytes: integerSetting(
      "SYNCER_PROTOCOL_MAX_SNAPSHOT_BYTES",
      128 * 1024 * 1024,
      1024,
      1024 * 1024 * 1024,
    ),
    // Set requests to zero only for a deliberately external/distributed
    // limiter. The reference default is generous enough for ordinary clients.
    rateLimitRequests: integerSetting(
      "SYNCER_PROTOCOL_RATE_LIMIT_REQUESTS",
      600,
      0,
      1_000_000,
    ),
    rateLimitWindowMs: integerSetting(
      "SYNCER_PROTOCOL_RATE_LIMIT_WINDOW_MS",
      60_000,
      1000,
      3_600_000,
    ),
    metricsTokenDigest,
    metricsConfigurationError,
  };
}

function escapePrometheus(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

function labelsText(labels: Readonly<Record<string, string>>): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return "";
  return `{${entries
    .map(([key, value]) => `${key}="${escapePrometheus(value)}"`)
    .join(",")}}`;
}

function metricKey(
  name: string,
  labels: Readonly<Record<string, string>>,
): string {
  return `${name}${labelsText(labels)}`;
}

export class ProtocolMetrics {
  private readonly values = new Map<string, number>();
  private readonly types = new Map<string, "counter" | "gauge" | "histogram">();

  increment(
    name: string,
    labels: Readonly<Record<string, string>> = {},
    amount = 1,
  ): void {
    this.types.set(name, "counter");
    const key = metricKey(name, labels);
    this.values.set(key, (this.values.get(key) ?? 0) + amount);
  }

  gauge(
    name: string,
    value: number,
    labels: Readonly<Record<string, string>> = {},
  ): void {
    this.types.set(name, "gauge");
    this.values.set(metricKey(name, labels), value);
  }

  observeRequest(route: string, method: string, status: number, seconds: number): void {
    const labels = {
      method,
      route,
      status_class: `${Math.floor(status / 100)}xx`,
    };
    this.increment("opto_sync_protocol_requests_total", labels);
    this.types.set("opto_sync_protocol_request_duration_seconds", "histogram");
    for (const bucket of HISTOGRAM_BUCKETS_SECONDS) {
      if (seconds <= bucket) {
        this.increment(
          "opto_sync_protocol_request_duration_seconds_bucket",
          { ...labels, le: String(bucket) },
        );
      }
    }
    this.increment(
      "opto_sync_protocol_request_duration_seconds_bucket",
      { ...labels, le: "+Inf" },
    );
    this.increment("opto_sync_protocol_request_duration_seconds_count", labels);
    const sumKey = metricKey("opto_sync_protocol_request_duration_seconds_sum", labels);
    this.values.set(sumKey, (this.values.get(sumKey) ?? 0) + seconds);
  }

  render(): string {
    const lines = [
      "# HELP opto_sync_info Static information about the reference sync service.",
      "# TYPE opto_sync_info gauge",
      'opto_sync_info{protocol_version="1"} 1',
    ];
    for (const [name, type] of [...this.types.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      // Bucket/count/sum families are emitted under the histogram base name.
      if (
        name.endsWith("_bucket") ||
        name.endsWith("_count") ||
        name.endsWith("_sum")
      ) {
        continue;
      }
      lines.push(`# TYPE ${name} ${type}`);
    }
    for (const [key, value] of [...this.values.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      lines.push(`${key} ${Number.isFinite(value) ? value : 0}`);
    }
    return `${lines.join("\n")}\n`;
  }
}

type RateEntry = { windowStartedAt: number; count: number };

export class FixedWindowRateLimiter {
  private readonly entries = new Map<string, RateEntry>();
  private lastSweepAt = 0;

  constructor(
    private readonly requests: number,
    private readonly windowMs: number,
  ) {}

  consume(key: string, now = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
    if (this.requests === 0) return { allowed: true, retryAfterSeconds: 0 };
    this.sweep(now);
    const existing = this.entries.get(key);
    if (!existing || now - existing.windowStartedAt >= this.windowMs) {
      this.entries.set(key, { windowStartedAt: now, count: 1 });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    if (existing.count >= this.requests) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((existing.windowStartedAt + this.windowMs - now) / 1000),
        ),
      };
    }
    existing.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  size(): number {
    return this.entries.size;
  }

  private sweep(now: number): void {
    if (now - this.lastSweepAt < this.windowMs) return;
    this.lastSweepAt = now;
    for (const [key, entry] of this.entries) {
      if (now - entry.windowStartedAt >= this.windowMs) this.entries.delete(key);
    }
  }
}

export function privacyHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function auditEvent(
  event: string,
  fields: Readonly<Record<string, unknown>> = {},
): void {
  // One JSON value per line makes stdout directly ingestible by Loki, OTLP
  // collectors, or a cloud log router. Callers must never include bearer
  // tokens, mutation payloads, or raw record identifiers.
  console.log(
    JSON.stringify({
      schema: "opto_sync.audit.v1",
      timestamp: new Date().toISOString(),
      event,
      ...fields,
    }),
  );
}

function metricsBearerAuthorized(
  request: express.Request,
  expected: Buffer,
): boolean {
  const authorization = request.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return false;
  const actual = tokenDigest(authorization.slice("Bearer ".length));
  return timingSafeEqual(actual, expected);
}

export type ProtocolOperations = {
  config: OperationalConfig;
  metrics: ProtocolMetrics;
  limiter: FixedWindowRateLimiter;
  newRequestId(): string;
  installMetricsEndpoint(app: express.Express): void;
};

export function createProtocolOperations(testMode: boolean): ProtocolOperations {
  const config = loadOperationalConfig(testMode);
  const metrics = new ProtocolMetrics();
  const limiter = new FixedWindowRateLimiter(
    config.rateLimitRequests,
    config.rateLimitWindowMs,
  );

  return {
    config,
    metrics,
    limiter,
    newRequestId: randomUUID,
    installMetricsEndpoint(app) {
      app.get("/metrics", (request, response) => {
        if (config.metricsConfigurationError) {
          return response.status(testMode ? 503 : 404).json({
            error: testMode ? "METRICS_NOT_CONFIGURED" : "Not found",
          });
        }
        if (
          config.metricsTokenDigest &&
          !metricsBearerAuthorized(request, config.metricsTokenDigest)
        ) {
          auditEvent("metrics.authentication_denied", {
            requestId: randomUUID(),
            remoteHash: privacyHash(
              request.ip ?? request.socket.remoteAddress ?? "unknown",
            ),
          });
          return response.status(401).json({ error: "UNAUTHORIZED" });
        }
        metrics.gauge(
          "opto_sync_protocol_rate_limiter_entries",
          limiter.size(),
        );
        response.type("text/plain; version=0.0.4").send(metrics.render());
      });
    },
  };
}

export function protocolRouteLabel(path: string): string {
  if (path === "/push") return "push";
  if (path === "/pull") return "pull";
  if (path === "/snapshot") return "snapshot";
  if (path === "/admin/compact") return "admin_compact";
  if (path === "/admin/external-write") return "admin_external_write";
  return "unknown";
}
