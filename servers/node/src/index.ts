import express from "express";
import cors from "cors";
import pg from "pg";
import dotenv from "dotenv";
import { z } from "zod";

// Base schema for validation
const DocumentPayloadSchema = z.object({
  id: z.string().optional(),
  title: z.string().optional(),
  metadata: z.record(z.any()).optional(),
  settings: z.record(z.any()).optional(),
  updatedAt: z.string().datetime().optional(),
}).passthrough(); // Allow other fields to pass through during optimistic updates

dotenv.config({ path: "../../.env" });

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const PORT = parseInt(process.env.SERVER_PORT || "3003", 10);

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
        nested: {
          level1: {
            level2: {
              level3: { deep_value: "original" },
            },
          },
        },
      },
    },
  },
];

// ── Try to load the native syncer addon ──────────────────────────────────
let mergeJson: ((a: string, b: string, opts?: any) => string) | null = null;
try {
  // Try loading via npm package first (works in Docker and local npm install)
  const syncer = require("@opto-sync/syncer");
  mergeJson = syncer.mergeJson;
  console.log("[syncer] Native C addon loaded successfully via npm package");
} catch (_) {
  try {
    // Fallback: direct path for local dev without npm install
    const syncer = require("../../../../syncer.c/bindings/typescript/build/Release/syncer.node");
    mergeJson = syncer.mergeJson;
    console.log("[syncer] Native C addon loaded successfully via direct path");
  } catch (err) {
    console.warn("[syncer] Native addon not available, using JS fallback");
  }
}

/**
 * JS fallback deep merge (used when the native addon is not compiled).
 */
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
    if (key in result && typeof result[key] === "object" && typeof incoming[key] === "object") {
      result[key] = jsDeepMerge(result[key], incoming[key]);
    } else {
      result[key] = incoming[key];
    }
  }
  return result;
}

function performMerge(rawBase: string, rawIncoming: string, opts?: any): string {
  if (mergeJson) {
    return mergeJson(rawBase, rawIncoming, opts);
  }
  // JS fallback
  const merged = jsDeepMerge(JSON.parse(rawBase), JSON.parse(rawIncoming));
  return JSON.stringify(merged);
}

// ── Express app ──────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", server: "node-drizzle", syncer: mergeJson ? "native" : "js-fallback" });
});

// GET /doc/:id — Fetch a document
app.get("/doc/:id", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, data, version, updated_at FROM syncer_test_docs WHERE id = $1",
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Document not found" });
    }
    res.json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /doc/:id/sync — Merge incoming JSON with existing document
app.post("/doc/:id/sync", async (req, res) => {
  try {
    // 1. Validate incoming payload using Zod
    const validationResult = DocumentPayloadSchema.safeParse(req.body);
    if (!validationResult.success) {
      return res.status(400).json({ error: "Invalid payload", details: validationResult.error.format() });
    }

    const incomingJson = JSON.stringify(validationResult.data);

    // Fetch current raw JSON as TEXT to avoid deserialization
    const current = await pool.query(
      "SELECT data::text AS raw_data, version FROM syncer_test_docs WHERE id = $1",
      [req.params.id]
    );

    if (current.rows.length === 0) {
      return res.status(404).json({ error: "Document not found" });
    }

    const rawBase = current.rows[0].raw_data;
    const currentVersion = current.rows[0].version;

    // Perform merge via C FFI (or JS fallback)
    const mergedRaw = performMerge(rawBase, incomingJson, {
      resolveByTimestamp: true,
      timestampKey: "updatedAt"
    });

    // Update with merged result
    const updated = await pool.query(
      `UPDATE syncer_test_docs 
       SET data = $1::jsonb, version = $2, updated_at = NOW() 
       WHERE id = $3
       RETURNING id, data, version, updated_at`,
      [mergedRaw, currentVersion + 1, req.params.id]
    );

    res.json({
      merged: true,
      document: updated.rows[0],
      mergedWith: mergeJson ? "native-c-ffi" : "js-fallback",
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /docs — List all documents
app.get("/docs", async (_req, res) => {
  try {
    const result = await pool.query("SELECT id, data, version, updated_at FROM syncer_test_docs ORDER BY id");
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Initialization ───────────────────────────────────────────────────────
async function init() {
  console.log(`[node-server] Initializing on port ${PORT}...`);

  // Create table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS syncer_test_docs (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL DEFAULT '{}',
      version INT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log("[node-server] Table syncer_test_docs ensured");

  // Seed documents
  for (const doc of SEED_DOCS) {
    await pool.query(
      `INSERT INTO syncer_test_docs (id, data, version) VALUES ($1, $2, 1)
       ON CONFLICT (id) DO NOTHING`,
      [doc.id, JSON.stringify(doc.data)]
    );
  }
  console.log(`[node-server] Seeded ${SEED_DOCS.length} documents`);

  app.listen(PORT, () => {
    console.log(`[node-server] Listening on http://0.0.0.0:${PORT}`);
  });
}

init().catch((err) => {
  console.error("[node-server] Failed to start:", err);
  process.exit(1);
});
