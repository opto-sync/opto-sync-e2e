/**
 * Node e2e server — Express + Postgres jsonb + the native syncer C addon.
 *
 * This is the DB-backed reference server for the conformance suite. Unlike the
 * in-memory servers it round-trips every merge through real `jsonb` columns,
 * so it also proves the merge output survives Postgres (key reordering,
 * numeric precision, unicode).
 *
 * Server owns the merge policy: clients cannot dictate conflict resolution.
 * Test builds may set E2E_ALLOW_OPTION_OVERRIDE=1 to permit a per-request
 * X-Syncer-Options header so the suite can exercise non-default strategies.
 */
import express from "express";
import cors from "cors";
import pg from "pg";
import dotenv from "dotenv";
import { z } from "zod";
import { createRequire } from "node:module";
import {
  ensureProtocolSchema,
  installSyncProtocol,
  resetProtocolState,
  type ProtocolMutationHandler,
} from "./protocol.js";
import { createPostgresJsonbMutationHandler } from "./protocol-handlers.js";
import { createProtocolOperations } from "./operations.js";

const DocumentPayloadSchema = z
  .object({
    id: z.string().optional(),
    title: z.string().optional(),
    metadata: z.record(z.any()).optional(),
    settings: z.record(z.any()).optional(),
    // Accept any string: ISO datetimes, nanosecond epoch integers, etc.
    updatedAt: z.union([z.string(), z.number()]).optional(),
    syncedAt: z.union([z.string(), z.number()]).optional(),
    createdAt: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

try {
  dotenv.config({ path: "../../.env" });
} catch {
  /* env comes from env_file under docker */
}

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const PORT = parseInt(process.env.SERVER_PORT || "3003", 10);
const TEST_MODE = process.env.E2E_ALLOW_OPTION_OVERRIDE === "1";
const REQUIRE_NATIVE = process.env.SYNCER_REQUIRE_NATIVE !== "0";
const protocolOperations = createProtocolOperations(TEST_MODE);
let protocolSchemaVersion = 0;
const require = createRequire(import.meta.url);
/**
 * Compare-and-swap retry budget. Measured behavior: no conflicts up to ~5
 * concurrent writers on one document, then rising 409s (25-60% at 20 writers)
 * because every loser retried in lockstep and collided again. A larger budget
 * plus full-jitter backoff de-synchronizes them. Losing the race is never a
 * correctness problem — a 409 means "nothing was written, retry" — but a
 * reference server should absorb ordinary contention itself.
 */
const MAX_CAS_ATTEMPTS = parseInt(process.env.SYNCER_CAS_ATTEMPTS || "12", 10);

/** Full-jitter exponential backoff, capped. */
function casBackoff(attempt: number): Promise<void> {
  const ceiling = Math.min(2 ** attempt, 40);
  return new Promise((resolve) => setTimeout(resolve, Math.random() * ceiling));
}

// ── Seed data ────────────────────────────────────────────────────────────
const SEED_DOCS = [
  {
    id: "doc-1",
    data: {
      title: "Project Alpha",
      metadata: {
        priority: 1,
        tags: ["backend", "api"],
        owner: { name: "Alice", email: "alice@example.com" },
      },
      settings: { theme: "dark", notifications: true },
    },
  },
  {
    id: "doc-2",
    data: {
      title: "Project Beta",
      metadata: {
        priority: 2,
        tags: ["frontend", "ui"],
        owner: { name: "Bob", email: "bob@example.com" },
      },
      settings: { theme: "light", notifications: false },
    },
  },
  {
    id: "doc-3",
    data: {
      title: "Project Gamma",
      metadata: {
        priority: 3,
        tags: ["devops"],
        owner: { name: "Charlie", email: "charlie@example.com" },
        nested: { level1: { level2: { level3: { deep_value: "original" } } } },
      },
    },
  },
  {
    // Array-of-objects fixture: the shape MERGE_BY_KEY exists for.
    id: "doc-rows",
    data: {
      title: "Keyed Rows",
      items: [
        { id: "a", createdAt: 1000, updatedAt: 2000, label: "alpha", qty: 1 },
        { id: "b", createdAt: 1000, updatedAt: 2000, label: "beta", qty: 2 },
      ],
    },
  },
];

// ── Native syncer addon ──────────────────────────────────────────────────
let mergeJson: ((a: string, b: string, opts?: any) => string | null) | null = null;
let syncerVersion = "unknown";
let ArrayStrategy: Record<string, number> = {
  REPLACE: 0,
  APPEND: 1,
  UNION: 2,
  MERGE_BY_INDEX: 3,
  MERGE_BY_KEY: 4,
};

try {
  const syncer = require("@opto-sync/syncer");
  mergeJson = syncer.mergeJson;
  if (syncer.ArrayStrategy) ArrayStrategy = syncer.ArrayStrategy;
  if (typeof syncer.version === "function") syncerVersion = syncer.version();
  console.log(`[syncer] Native C addon loaded (core ${syncerVersion})`);
} catch (err: any) {
  console.warn(`[syncer] Native addon unavailable: ${err?.message}`);
}

if (!mergeJson && REQUIRE_NATIVE) {
  // A JS fallback merge would let the whole e2e suite pass without ever
  // exercising the C core — precisely the false confidence these tests exist
  // to prevent. Refuse to start instead.
  console.error(
    "[syncer] FATAL: native addon required but not loaded. " +
      "Set SYNCER_REQUIRE_NATIVE=0 only for local dev without the addon."
  );
  process.exit(1);
}

/**
 * Server-owned default merge policy.
 *
 * No `fwwKeys`, deliberately. First-write-wins in the C core is a NODE-LEVEL
 * VETO: should_reject_by_crdt_rules drops the ENTIRE incoming node when its FWW
 * key is newer than the base's, regardless of how new its `updatedAt` is.
 *
 *   base     {"doc":{"createdAt":100,"updatedAt":100,"v":"base"}}
 *   incoming {"doc":{"createdAt":200,"updatedAt":999999,"v":"NEWEST WRITE"}}
 *   result   {"doc":{"createdAt":100,"updatedAt":100,"v":"base"}}
 *
 * With `createdAt` in this policy, any replica that ended up holding a later
 * `createdAt` for a record could never write to that record again — silently,
 * behind a 200 OK. Clients that genuinely want the veto ask for it explicitly
 * (in test mode, via `X-Syncer-Options: {"fwwKeys":"createdAt"}`).
 */
const DEFAULT_MERGE_OPTIONS = {
  arrayStrategy: ArrayStrategy.MERGE_BY_KEY,
  arrayMatchKeys: "id",
  resolveByTimestamp: true,
  lwwKeys: "updatedAt,syncedAt",
};

const POLLUTING_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Dev-only fallback; never reached when SYNCER_REQUIRE_NATIVE=1. */
function jsDeepMerge(base: any, incoming: any): any {
  if (
    typeof base !== "object" || base === null ||
    typeof incoming !== "object" || incoming === null ||
    Array.isArray(base) || Array.isArray(incoming)
  ) {
    return incoming;
  }
  const result = { ...base };
  for (const key of Object.keys(incoming)) {
    if (POLLUTING_KEYS.has(key)) continue;
    if (
      Object.prototype.hasOwnProperty.call(result, key) &&
      typeof result[key] === "object" &&
      typeof incoming[key] === "object"
    ) {
      result[key] = jsDeepMerge(result[key], incoming[key]);
    } else {
      result[key] = incoming[key];
    }
  }
  return result;
}

function performMerge(rawBase: string, rawIncoming: string, opts?: any): string {
  if (mergeJson) {
    const merged = mergeJson(rawBase, rawIncoming, opts ?? DEFAULT_MERGE_OPTIONS);
    if (merged == null) {
      throw new Error("syncer merge returned null: input was not valid JSON");
    }
    return merged;
  }
  return JSON.stringify(jsDeepMerge(JSON.parse(rawBase), JSON.parse(rawIncoming)));
}

/** Per-request option override, honored only in test mode. */
function optionsFromRequest(req: express.Request): any {
  if (!TEST_MODE) return DEFAULT_MERGE_OPTIONS;
  const raw = req.header("X-Syncer-Options");
  if (!raw) return DEFAULT_MERGE_OPTIONS;
  try {
    return { ...DEFAULT_MERGE_OPTIONS, ...JSON.parse(raw) };
  } catch {
    throw Object.assign(new Error("X-Syncer-Options is not valid JSON"), { status: 400 });
  }
}

/**
 * Normalize a timestamp of any supported shape to milliseconds, for
 * tombstone-vs-update comparison. Digit strings are epoch values whose unit is
 * inferred from magnitude; anything else goes through Date.parse.
 */
function parseTsToMs(value: unknown): number | null {
  if (value == null) return null;
  const s = String(value);
  if (/^\d+$/.test(s)) {
    if (s.length <= 10) return Number(s) * 1000;      // seconds
    if (s.length <= 13) return Number(s);             // milliseconds
    if (s.length <= 16) return Number(s) / 1000;      // microseconds
    return Number(BigInt(s) / 1000000n);              // nanoseconds
  }
  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? null : parsed;
}

// ── App ──────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(
  express.json({
    limit: "32mb",
    verify: (request, _response, body) => {
      // The protocol quota must account for the bytes actually received,
      // including insignificant JSON whitespace. Re-serializing request.body
      // would let a chunked or padded request bypass that limit.
      (
        request as express.Request & { rawBodyBytes?: number }
      ).rawBodyBytes = body.length;
    },
  }),
);

function sendInternalError(
  response: express.Response,
  error: unknown,
  context: string,
) {
  console.error(`[node-server] ${context}:`, error);
  if (!response.headersSent) {
    response.status(500).json({ error: "Internal server error" });
  }
}

// Express's default handler answers a body-parse failure with an HTML stack
// trace that leaks server paths. Answer in JSON instead, and keep the 400.
app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({ error: "Malformed JSON body" });
  }
  if (err?.type === "entity.too.large") {
    return res.status(413).json({ error: "Payload too large" });
  }
  return next(err);
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    server: "node-postgres",
    syncer: mergeJson ? "native" : "js-fallback",
    coreVersion: syncerVersion,
    protocolSchemaVersion,
    testMode: TEST_MODE,
    defaultOptions: DEFAULT_MERGE_OPTIONS,
  });
});

protocolOperations.installMetricsEndpoint(app);

app.get("/docs", async (_req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, data, version, updated_at, deleted_at FROM syncer_test_docs ORDER BY id"
    );
    res.json(result.rows);
  } catch (err: any) {
    sendInternalError(res, err, "list documents failed");
  }
});

app.get("/doc/:id", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, data, version, updated_at, deleted_at FROM syncer_test_docs WHERE id = $1",
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Document not found" });
    res.json(result.rows[0]);
  } catch (err: any) {
    sendInternalError(res, err, "read document failed");
  }
});

/** Exact stored jsonb text — lets tests inspect what Postgres did to our JSON. */
app.get("/doc/:id/raw", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT data::text AS raw FROM syncer_test_docs WHERE id = $1",
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Document not found" });
    res.type("application/json").send(result.rows[0].raw);
  } catch (err: any) {
    sendInternalError(res, err, "read raw document failed");
  }
});

/** Create or replace a document outright (test setup, not a merge). */
app.put("/doc/:id", async (req, res) => {
  try {
    const result = await pool.query(
      `INSERT INTO syncer_test_docs (id, data, version, deleted_at)
       VALUES ($1, $2::jsonb, 1, NULL)
       ON CONFLICT (id) DO UPDATE
         SET data = $2::jsonb, version = syncer_test_docs.version + 1,
             updated_at = NOW(), deleted_at = NULL
       RETURNING id, data, version`,
      [req.params.id, JSON.stringify(req.body ?? {})]
    );
    res.json({ created: true, document: result.rows[0] });
  } catch (err: any) {
    sendInternalError(res, err, "replace document failed");
  }
});

/** Soft delete (tombstone) so delete-vs-update conflicts are observable. */
app.delete("/doc/:id", async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE syncer_test_docs SET deleted_at = NOW(), version = version + 1
       WHERE id = $1 RETURNING id, version, deleted_at`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Document not found" });
    res.json({ deleted: true, document: result.rows[0] });
  } catch (err: any) {
    sendInternalError(res, err, "delete document failed");
  }
});

/**
 * Merge an incoming payload into a document.
 *
 * Compare-and-swap on `version` with bounded retry: two concurrent syncs both
 * read version N, and without the guard the slower write would clobber the
 * faster one's merge. `?noRetry=1` surfaces the 409 instead of retrying, so
 * the suite can test both the conflict signal and convergence-under-retry.
 */
app.post("/doc/:id/sync", async (req, res) => {
  try {
    const parsed = DocumentPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid payload", details: parsed.error.format() });
    }
    const options = optionsFromRequest(req);
    const incomingJson = JSON.stringify(parsed.data);
    const noRetry = req.query.noRetry === "1";
    const attempts = noRetry ? 1 : MAX_CAS_ATTEMPTS;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const current = await pool.query(
        "SELECT data::text AS raw_data, version, deleted_at FROM syncer_test_docs WHERE id = $1",
        [req.params.id]
      );
      if (current.rows.length === 0) return res.status(404).json({ error: "Document not found" });

      const { raw_data: rawBase, version, deleted_at } = current.rows[0];

      // Delete-vs-update: an update strictly newer than the tombstone
      // resurrects the row; anything older stays deleted.
      if (deleted_at) {
        const incomingMs = parseTsToMs((parsed.data as any).updatedAt);
        const tombstoneMs = new Date(deleted_at).getTime();
        if (incomingMs == null || incomingMs <= tombstoneMs) {
          return res.status(410).json({
            error: "Document deleted",
            deleted: true,
            tombstoneAt: deleted_at,
          });
        }
      }

      const mergedRaw = performMerge(rawBase, incomingJson, options);

      const updated = await pool.query(
        `UPDATE syncer_test_docs
         SET data = $1::jsonb, version = version + 1, updated_at = NOW(),
             deleted_at = NULL
         WHERE id = $3 AND version = $2
         RETURNING id, data, version, updated_at`,
        [mergedRaw, version, req.params.id]
      );

      if (updated.rows.length > 0) {
        return res.json({
          merged: true,
          attempts: attempt,
          document: updated.rows[0],
          mergedWith: mergeJson ? "native-c-ffi" : "js-fallback",
          resurrected: Boolean(deleted_at),
        });
      }
      // Lost the CAS race — back off, then re-read and merge again.
      await casBackoff(attempt);
    }

    res.status(409).json({ error: "Concurrent update, retry the sync", conflict: true });
  } catch (err: any) {
    if (err?.status === 400) {
      return res.status(400).json({ error: err.message });
    }
    sendInternalError(res, err, "reconcile document failed");
  }
});

/**
 * Replay a queue of mutations in one transaction — the shape a client's
 * offline queue flushes in. All-or-nothing so a mid-flush failure cannot
 * leave a partially applied batch.
 */
app.post("/sync/batch", async (req, res) => {
  const mutations = Array.isArray(req.body?.mutations) ? req.body.mutations : null;
  if (!mutations) {
    return res.status(400).json({ error: "Body must be { mutations: [{ docId, payload }] }" });
  }
  let options: any;
  try {
    options = optionsFromRequest(req);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const results: any[] = [];
    for (const m of mutations) {
      // Row lock serializes concurrent batches on the same document.
      const current = await client.query(
        "SELECT data::text AS raw_data, version FROM syncer_test_docs WHERE id = $1 FOR UPDATE",
        [m.docId]
      );
      if (current.rows.length === 0) {
        results.push({ docId: m.docId, applied: false, error: "not found" });
        continue;
      }
      const mergedRaw = performMerge(
        current.rows[0].raw_data,
        JSON.stringify(m.payload ?? {}),
        options
      );
      await client.query(
        `UPDATE syncer_test_docs SET data = $1::jsonb, version = version + 1,
         updated_at = NOW() WHERE id = $2`,
        [mergedRaw, m.docId]
      );
      results.push({ docId: m.docId, applied: true });
    }
    await client.query("COMMIT");
    res.json({ applied: results.filter((r) => r.applied).length, results });
  } catch (err: any) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve and log the original transaction failure.
    }
    sendInternalError(res, err, "batch reconciliation failed");
  } finally {
    client.release();
  }
});

const protocolMutationHandlers: Record<string, ProtocolMutationHandler> = {
  tasks: createPostgresJsonbMutationHandler({
    logicalTable: "tasks",
    relation: "public.syncer_protocol_tasks",
    tenantColumn: "tenant_id",
    idColumn: "id",
    recordColumn: "data",
    deletedColumn: "deleted_at",
  }),
};

if (TEST_MODE) {
  // Adversarial conformance handlers. These are never installed in production.
  // The first proves a durable rejection cannot retain writes made while the
  // handler was deciding. The second proves a handler cannot acknowledge a
  // write unless a registered capture trigger advanced the checkpoint.
  protocolMutationHandlers.rollback_probe = async ({
    connection,
    identity,
    mutation,
  }) => {
    await connection.query(
      `INSERT INTO syncer_protocol_tasks(tenant_id, id, data)
       VALUES ($1, $2, $3::JSONB)`,
      [
        identity.tenantId,
        mutation.recordId,
        JSON.stringify({ mustRollBack: true }),
      ],
    );
    return {
      status: "rejected",
      code: "TEST_REJECTION",
      message: "intentional rejection after a captured write",
    };
  };
  protocolMutationHandlers.uncaptured_probe = async () => ({
    status: "applied",
  });
}

installSyncProtocol(
  app,
  pool,
  (baseJson, incomingJson) =>
    performMerge(baseJson, incomingJson, DEFAULT_MERGE_OPTIONS),
  TEST_MODE,
  protocolOperations,
  {
    mutationHandlers: protocolMutationHandlers,
  },
);

/**
 * Reconcile by UNIQUE INDEX rather than primary key: the row's identity is
 * `email`, while its primary key is an unrelated surrogate. Two clients that
 * both "create" the same email must converge onto one row.
 */
app.post("/profile/sync", async (req, res) => {
  const email = req.body?.email;
  if (typeof email !== "string" || email.length === 0) {
    return res.status(400).json({ error: "payload must include an email string" });
  }
  let options: any;
  try {
    options = optionsFromRequest(req);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }

  try {
    for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt++) {
      const current = await pool.query(
        "SELECT id, data::text AS raw_data, version FROM syncer_test_docs_profiles WHERE email = $1",
        [email]
      );

      if (current.rows.length === 0) {
        try {
          const inserted = await pool.query(
            `INSERT INTO syncer_test_docs_profiles (email, data, version)
             VALUES ($1, $2::jsonb, 1) RETURNING id, email, data, version`,
            [email, JSON.stringify(req.body)]
          );
          return res.json({ merged: true, created: true, attempts: attempt, profile: inserted.rows[0] });
        } catch (err: any) {
          if (err.code === "23505") continue; // unique violation: another client won, merge instead
          throw err;
        }
      }

      const { raw_data: rawBase, version } = current.rows[0];
      const mergedRaw = performMerge(rawBase, JSON.stringify(req.body), options);
      const updated = await pool.query(
        `UPDATE syncer_test_docs_profiles
         SET data = $1::jsonb, version = version + 1, updated_at = NOW()
         WHERE email = $3 AND version = $2
         RETURNING id, email, data, version`,
        [mergedRaw, version, email]
      );
      if (updated.rows.length > 0) {
        return res.json({ merged: true, created: false, attempts: attempt, profile: updated.rows[0] });
      }
      await casBackoff(attempt);
    }
    res.status(409).json({ error: "Concurrent update, retry the sync", conflict: true });
  } catch (err: any) {
    sendInternalError(res, err, "reconcile profile failed");
  }
});

app.get("/profile/:email", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, email, data, version FROM syncer_test_docs_profiles WHERE email = $1",
      [req.params.email]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Profile not found" });
    res.json(result.rows[0]);
  } catch (err: any) {
    sendInternalError(res, err, "read profile failed");
  }
});

/** Restore seed state so scenarios start from a known baseline. */
app.post("/reset", async (_req, res) => {
  if (!TEST_MODE) return res.status(403).json({ error: "reset requires E2E_ALLOW_OPTION_OVERRIDE=1" });
  try {
    await pool.query("TRUNCATE syncer_test_docs");
    await pool.query("TRUNCATE syncer_test_docs_profiles");
    await pool.query("TRUNCATE syncer_protocol_tasks");
    await resetProtocolState(pool);
    await seed();
    res.json({ reset: true, seeded: SEED_DOCS.length });
  } catch (err: any) {
    sendInternalError(res, err, "reset failed");
  }
});

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Terminal handler: any unhandled route error answers JSON, never HTML.
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  sendInternalError(res, err, "unhandled request failure");
});

// ── Initialization ───────────────────────────────────────────────────────
async function seed() {
  for (const doc of SEED_DOCS) {
    await pool.query(
      `INSERT INTO syncer_test_docs (id, data, version) VALUES ($1, $2::jsonb, 1)
       ON CONFLICT (id) DO NOTHING`,
      [doc.id, JSON.stringify(doc.data)]
    );
  }
}

async function init() {
  console.log(`[node-server] Initializing on port ${PORT}...`);

  protocolSchemaVersion = await ensureProtocolSchema(pool);

  // PostgreSQL's IF NOT EXISTS does not make concurrent first-time DDL
  // atomic: two replicas can both pass the existence check and collide while
  // creating the relation's composite type. Serialize this reference app
  // schema separately from the protocol migration lock.
  const schemaClient = await pool.connect();
  try {
    await schemaClient.query("BEGIN");
    await schemaClient.query(
      "SELECT pg_advisory_xact_lock(hashtext('opto_sync_reference_app_schema'))"
    );
    await schemaClient.query(`
      CREATE TABLE IF NOT EXISTS syncer_test_docs (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL DEFAULT '{}',
        version INT NOT NULL DEFAULT 1,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        deleted_at TIMESTAMPTZ
      )
    `);
    // Pre-existing deployments predate the tombstone column.
    await schemaClient.query(
      "ALTER TABLE syncer_test_docs ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ"
    );
    await schemaClient.query(`
      CREATE TABLE IF NOT EXISTS syncer_test_docs_profiles (
        id BIGSERIAL PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        data JSONB NOT NULL DEFAULT '{}',
        version INT NOT NULL DEFAULT 1,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await schemaClient.query(`
      CREATE TABLE IF NOT EXISTS syncer_protocol_tasks (
        tenant_id TEXT NOT NULL,
        id TEXT NOT NULL,
        data JSONB NOT NULL DEFAULT '{}',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ,
        PRIMARY KEY (tenant_id, id)
      )
    `);
    await schemaClient.query(
      `SELECT syncer_protocol_register_capture(
         'public.syncer_protocol_tasks'::REGCLASS,
         'tasks',
         'tenant_id',
         'id',
         'data',
         'deleted_at'
       )`
    );
    await schemaClient.query("COMMIT");
  } catch (error) {
    try {
      await schemaClient.query("ROLLBACK");
    } catch {
      // Preserve the original DDL failure if the connection also failed.
    }
    throw error;
  } finally {
    schemaClient.release();
  }
  console.log("[node-server] Tables ensured");

  await seed();
  console.log(`[node-server] Seeded ${SEED_DOCS.length} documents`);

  app.listen(PORT, () => {
    console.log(`[node-server] Listening on http://0.0.0.0:${PORT}`);
  });
}

init().catch((err) => {
  console.error("[node-server] Failed to start:", err);
  process.exit(1);
});
