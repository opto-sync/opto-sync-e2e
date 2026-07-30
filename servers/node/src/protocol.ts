import { createHash, timingSafeEqual } from "node:crypto";

import type express from "express";
import type pg from "pg";
import { z } from "zod";
import {
  createProtocolAuthenticator,
  readBearerToken,
  type AuthenticationResult,
  type ProtocolIdentity,
} from "./auth.js";
import {
  auditEvent,
  privacyHash,
  protocolRouteLabel,
  type ProtocolOperations,
} from "./operations.js";

const MAX_I64 = 9_223_372_036_854_775_807n;
const PROTOCOL_VERSION = 1;
const ScopeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const ClientId = ScopeId;

const DecimalId = z
  .string()
  .regex(/^(?:0|[1-9]\d*)$/)
  .refine((value) => BigInt(value) <= MAX_I64, "must fit signed bigint");

const MutationSchema = z
  .object({
    mutationId: DecimalId.refine((value) => value !== "0", "must be positive"),
    operation: z.enum(["upsert", "delete"]),
    table: ScopeId,
    recordId: z.string().min(1).max(512),
    payload: z.record(z.any()).optional(),
    baseRevision: DecimalId.nullish(),
    resurrect: z.boolean().optional(),
  })
  .strict()
  .superRefine((mutation, context) => {
    if (mutation.operation === "upsert" && mutation.payload === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload"],
        message: "upsert requires an object payload",
      });
    }
    if (mutation.operation === "delete" && mutation.payload !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload"],
        message: "delete must not carry a payload",
      });
    }
  });

const PushSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    clientId: ClientId,
    mutations: z.array(MutationSchema).min(1).max(100),
  })
  .strict();

const ExternalWriteSchema = z
  .object({
    operation: z.enum(["upsert", "delete"]),
    recordId: z.string().min(1).max(512),
    payload: z.record(z.any()).optional(),
  })
  .strict()
  .superRefine((write, context) => {
    if (write.operation === "upsert" && write.payload === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload"],
        message: "upsert requires an object payload",
      });
    }
    if (write.operation === "delete" && write.payload !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload"],
        message: "delete must not carry a payload",
      });
    }
  });

export type ProtocolMutation = z.infer<typeof MutationSchema>;
export type MergeFunction = (
  baseJson: string,
  incomingJson: string,
) => string;
export type ProtocolMutationDecision =
  | {
      status: "applied";
      noOp?: boolean;
      document?: Record<string, unknown>;
    }
  | {
      status: "rejected";
      code: string;
      message: string;
      authoritative?: Record<string, unknown>;
    };
export type ProtocolMutationHandlerContext = {
  connection: pg.PoolClient;
  identity: Readonly<ProtocolIdentity>;
  clientId: string;
  mutation: Readonly<ProtocolMutation>;
  merge: MergeFunction;
  priorCheckpoint: bigint;
};
export type ProtocolMutationHandler = (
  context: ProtocolMutationHandlerContext,
) => Promise<ProtocolMutationDecision>;
export type SyncProtocolOptions = {
  /**
   * Exact logical-table allowlist. `docs` is reserved for the built-in
   * reference handler and cannot be replaced.
   */
  mutationHandlers?: Readonly<Record<string, ProtocolMutationHandler>>;
  /**
   * Invoked after a push transaction COMMITs having advanced the protocol
   * checkpoint. Realtime transports broadcast a pull hint from here. `origin`
   * is the opaque connection token from the triggering call's context so the
   * pusher's own connection can be excluded. Best-effort: a throwing listener
   * cannot fail the push.
   */
  onPushCommitted?: (checkpoint: bigint, origin: unknown) => void;
};

/** Transport-independent request envelope for the protocol core handlers. */
export type ProtocolCallContext = {
  requestId: string;
  identity: ProtocolIdentity;
  /**
   * Bytes actually received for the push body. HTTP passes the raw body
   * length; frame transports pass the frame length. Falls back to the
   * re-serialized body size when absent.
   */
  rawBodyBytes?: number;
  /** Test-mode failpoint (HTTP header parity); ignored outside test mode. */
  failpoint?: string;
  /** Opaque connection token excluded from its own change broadcast. */
  origin?: unknown;
};

/** Transport-independent response: an HTTP status plus the JSON body. */
export type ProtocolCallResult = {
  status: number;
  body: Record<string, unknown>;
  /**
   * The after-commit-response-loss failpoint committed but demands that the
   * transport send nothing (HTTP destroys the socket, frames stay silent).
   */
  responseLoss?: boolean;
};

/** Connection credentials presented by a non-HTTP transport. */
export type TransportAuthInput = {
  /** Bearer token carried as `?token=` (WebSocket) or a `token` field (TCP). */
  token?: string | null;
  /** Test-mode identity overrides, mirroring the x-syncer-test-* headers. */
  testTenantId?: string | null;
  testSubject?: string | null;
  testClientId?: string | null;
};

/**
 * The shared protocol engine behind every transport. HTTP routes, the
 * WebSocket endpoint, and the TCP listener all dispatch into these same
 * functions — no transport re-implements push/pull/snapshot semantics.
 */
export type SyncProtocolRuntime = {
  readonly testMode: boolean;
  newRequestId(): string;
  /** Mirrors the HTTP authentication middleware for frame transports. */
  authenticate(input: TransportAuthInput): Promise<AuthenticationResult>;
  /** Same limiter and key shape as the HTTP middleware. */
  consumeRateLimit(
    identity: ProtocolIdentity,
    route: "push" | "pull" | "snapshot",
  ): { allowed: boolean; retryAfterSeconds: number };
  push(context: ProtocolCallContext, body: unknown): Promise<ProtocolCallResult>;
  pull(
    context: ProtocolCallContext,
    checkpoint: unknown,
    limit: unknown,
  ): Promise<ProtocolCallResult>;
  snapshot(context: ProtocolCallContext): Promise<ProtocolCallResult>;
};
type AdminAuth = { tokenHash?: Buffer; error?: string };

type ProtocolError = Error & {
  status?: number;
  code?: string;
  detail?: unknown;
};

type AppliedSchemaMigration = {
  version: number;
  name: string;
  checksum: string;
};

/** Fail closed on edited history or a database created by a newer binary. */
export function validateSchemaMigrationHistory(
  applied: readonly AppliedSchemaMigration[],
  expected: readonly AppliedSchemaMigration[],
): void {
  const known = new Map(expected.map((migration) => [migration.version, migration]));
  for (const migration of applied) {
    const matching = known.get(migration.version);
    if (matching === undefined) {
      throw new Error(
        `database schema migration ${migration.version} is newer than this server`,
      );
    }
    if (
      migration.name !== matching.name ||
      migration.checksum !== matching.checksum
    ) {
      throw new Error(
        `schema migration ${migration.version} checksum/name mismatch`,
      );
    }
  }
}

function protocolError(
  status: number,
  code: string,
  message: string,
  detail?: unknown,
): ProtocolError {
  return Object.assign(new Error(message), { status, code, detail });
}

function publicProtocolFailure(error: unknown, fallbackCode: string) {
  const candidate = error as ProtocolError;
  const known =
    Number.isInteger(candidate?.status) &&
    candidate.status! >= 400 &&
    candidate.status! <= 599 &&
    typeof candidate.code === "string";
  const status = known ? candidate.status! : 500;
  const code = known ? candidate.code! : fallbackCode;

  if (status >= 500) {
    // Keep database/stack details in trusted logs, never in the wire response.
    console.error(`[opto-sync] ${fallbackCode}:`, error);
  }

  return {
    status,
    code,
    message: status >= 500 ? "Internal server error" : candidate.message,
    detail: status < 500 ? candidate.detail : undefined,
  };
}

async function rollbackQuietly(connection: pg.PoolClient) {
  try {
    await connection.query("ROLLBACK");
  } catch {
    // Preserve the original failure if the database connection also died.
  }
}

function tokenHash(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function loadAdminAuth(): AdminAuth {
  const token = process.env.SYNCER_PROTOCOL_ADMIN_TOKEN;
  if (!token) return { error: "protocol administrator authentication is not configured" };
  if (token.length < 32 || token.length > 4096) {
    return { error: "SYNCER_PROTOCOL_ADMIN_TOKEN must contain 32 to 4096 characters" };
  }
  return { tokenHash: tokenHash(token) };
}

function bearerHash(request: express.Request): Buffer | null {
  const token = readBearerToken(request.get("authorization"));
  return token === null ? null : tokenHash(token);
}

/** Canonical JSON for retry identity. Object key order cannot change a mutation. */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}

function mutationHash(mutation: ProtocolMutation): string {
  return createHash("sha256").update(stableJson(mutation)).digest("hex");
}

function parseCheckpoint(value: unknown, name: string): bigint {
  const parsed = DecimalId.safeParse(String(value ?? "0"));
  if (!parsed.success) {
    throw protocolError(400, "INVALID_CHECKPOINT", `${name} must be an unsigned decimal bigint`);
  }
  return BigInt(parsed.data);
}

function publicDocument(row: any): Record<string, unknown> {
  return {
    table: "docs",
    recordId: row.id,
    record: row.deleted_at ? null : row.data,
    revision: String(row.version),
    deleted: Boolean(row.deleted_at),
    deletedAt: row.deleted_at ?? null,
  };
}

async function readLockedCheckpoint(client: pg.PoolClient): Promise<bigint> {
  const state = await client.query(
    `SELECT last_seq FROM syncer_protocol_state
      WHERE singleton = TRUE`,
  );
  return BigInt(state.rows[0].last_seq);
}

async function rejectMutation(
  client: pg.PoolClient,
  mutation: ProtocolMutation,
  code: string,
  message: string,
  checkpoint: bigint,
  authoritative?: Record<string, unknown>,
) {
  return {
    mutationId: mutation.mutationId,
    status: "rejected",
    code,
    message,
    checkpoint: checkpoint.toString(),
    ...(authoritative ? { authoritative } : {}),
  };
}

async function applyMutation(
  client: pg.PoolClient,
  tenantId: string,
  mutation: ProtocolMutation,
  checkpoint: bigint,
  merge: MergeFunction,
): Promise<{ result: Record<string, unknown>; checkpoint: bigint }> {
  if (mutation.table !== "docs") {
    return {
      checkpoint,
      result: await rejectMutation(
        client,
        mutation,
        "UNSUPPORTED_TABLE",
        `table ${JSON.stringify(mutation.table)} is not exposed by protocol v1`,
        checkpoint,
      ),
    };
  }

  const selected = await client.query(
    `SELECT id, data, data::text AS raw_data, version, deleted_at
       FROM syncer_protocol_docs
      WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [tenantId, mutation.recordId],
  );
  const current = selected.rows[0];
  const expectedRevision =
    mutation.baseRevision == null ? null : BigInt(mutation.baseRevision);

  if (mutation.operation === "delete") {
    if (!current) {
      return {
        checkpoint,
        result: await rejectMutation(
          client,
          mutation,
          "NOT_FOUND",
          "cannot delete a record that does not exist",
          checkpoint,
        ),
      };
    }
    if (expectedRevision !== null && expectedRevision !== BigInt(current.version)) {
      return {
        checkpoint,
        result: await rejectMutation(
          client,
          mutation,
          "REVISION_CONFLICT",
          `baseRevision ${expectedRevision} does not match ${current.version}`,
          checkpoint,
          publicDocument(current),
        ),
      };
    }

    // A second delete with a new mutation id is an acknowledged no-op. It must
    // advance the client's mutation watermark, but it does not create a fake
    // data change or a new pull checkpoint.
    if (current.deleted_at) {
      return {
        checkpoint,
        result: {
          mutationId: mutation.mutationId,
          status: "applied",
          noOp: true,
          checkpoint: checkpoint.toString(),
          document: publicDocument(current),
        },
      };
    }

    const deleted = await client.query(
      `UPDATE syncer_protocol_docs
          SET version = version + 1, deleted_at = NOW(), updated_at = NOW()
        WHERE tenant_id = $1 AND id = $2
        RETURNING id, data, version, deleted_at`,
      [tenantId, mutation.recordId],
    );
    checkpoint = await readLockedCheckpoint(client);
    const document = publicDocument(deleted.rows[0]);
    return {
      checkpoint,
      result: {
        mutationId: mutation.mutationId,
        status: "applied",
        checkpoint: checkpoint.toString(),
        document,
      },
    };
  }

  if (!current) {
    if (expectedRevision !== null && expectedRevision !== 0n) {
      return {
        checkpoint,
        result: await rejectMutation(
          client,
          mutation,
          "NOT_FOUND",
          "record is absent; creation requires baseRevision 0 or no baseRevision",
          checkpoint,
        ),
      };
    }
    const inserted = await client.query(
      `INSERT INTO syncer_protocol_docs
         (tenant_id, id, data, version, deleted_at, updated_at)
       VALUES ($1, $2, $3::jsonb, 1, NULL, NOW())
       RETURNING id, data, version, deleted_at`,
      [tenantId, mutation.recordId, JSON.stringify(mutation.payload)],
    );
    checkpoint = await readLockedCheckpoint(client);
    const document = publicDocument(inserted.rows[0]);
    return {
      checkpoint,
      result: {
        mutationId: mutation.mutationId,
        status: "applied",
        checkpoint: checkpoint.toString(),
        document,
      },
    };
  }

  if (expectedRevision !== null && expectedRevision !== BigInt(current.version)) {
    return {
      checkpoint,
      result: await rejectMutation(
        client,
        mutation,
        "REVISION_CONFLICT",
        `baseRevision ${expectedRevision} does not match ${current.version}`,
        checkpoint,
        publicDocument(current),
      ),
    };
  }
  if (current.deleted_at && !mutation.resurrect) {
    return {
      checkpoint,
      result: await rejectMutation(
        client,
        mutation,
        "TOMBSTONED",
        "record is deleted; set resurrect=true with its current baseRevision",
        checkpoint,
        publicDocument(current),
      ),
    };
  }
  if (current.deleted_at && expectedRevision === null) {
    return {
      checkpoint,
      result: await rejectMutation(
        client,
        mutation,
        "REVISION_REQUIRED",
        "resurrection requires the tombstone baseRevision",
        checkpoint,
        publicDocument(current),
      ),
    };
  }

  const merged = merge(current.raw_data, JSON.stringify(mutation.payload));
  const updated = await client.query(
    `UPDATE syncer_protocol_docs
        SET data = $1::jsonb, version = version + 1,
            deleted_at = NULL, updated_at = NOW()
      WHERE tenant_id = $2 AND id = $3
      RETURNING id, data, version, deleted_at`,
    [merged, tenantId, mutation.recordId],
  );
  checkpoint = await readLockedCheckpoint(client);
  const document = publicDocument(updated.rows[0]);
  return {
    checkpoint,
    result: {
      mutationId: mutation.mutationId,
      status: "applied",
      checkpoint: checkpoint.toString(),
      document,
      resurrected: Boolean(current.deleted_at),
    },
  };
}

function validateHandlerDecision(
  mutation: ProtocolMutation,
  decision: ProtocolMutationDecision,
): void {
  if (decision === null || typeof decision !== "object") {
    throw protocolError(
      500,
      "INVALID_MUTATION_HANDLER_RESULT",
      "mutation handler returned an invalid decision",
    );
  }
  if (decision.status === "rejected") {
    if (
      !/^[A-Z][A-Z0-9_]{0,63}$/.test(decision.code) ||
      decision.message.length < 1 ||
      decision.message.length > 500
    ) {
      throw protocolError(
        500,
        "INVALID_MUTATION_HANDLER_RESULT",
        "mutation handler returned an invalid rejection",
      );
    }
    return;
  }
  if (decision.status !== "applied") {
    throw protocolError(
      500,
      "INVALID_MUTATION_HANDLER_RESULT",
      "mutation handler returned an unknown status",
    );
  }
  if (decision.document !== undefined) {
    if (
      decision.document.table !== mutation.table ||
      decision.document.recordId !== mutation.recordId ||
      typeof decision.document.revision !== "string" ||
      !/^[1-9]\d*$/.test(decision.document.revision)
    ) {
      throw protocolError(
        500,
        "INVALID_MUTATION_HANDLER_RESULT",
        "mutation handler returned a document for another record",
      );
    }
  }
}

async function applyRegisteredMutation(
  connection: pg.PoolClient,
  identity: ProtocolIdentity,
  clientId: string,
  mutation: ProtocolMutation,
  checkpoint: bigint,
  merge: MergeFunction,
  handler: ProtocolMutationHandler,
): Promise<{ result: Record<string, unknown>; checkpoint: bigint }> {
  await connection.query("SAVEPOINT syncer_protocol_handler");
  let decision: ProtocolMutationDecision;
  try {
    decision = await handler({
      connection,
      identity,
      clientId,
      mutation,
      merge,
      priorCheckpoint: checkpoint,
    });
    validateHandlerDecision(mutation, decision);
  } catch (error) {
    await connection.query("ROLLBACK TO SAVEPOINT syncer_protocol_handler");
    await connection.query("RELEASE SAVEPOINT syncer_protocol_handler");
    throw error;
  }

  if (decision.status === "rejected") {
    // A permanent rejection advances the client ledger, but no accidental
    // writes performed while deciding may survive.
    await connection.query("ROLLBACK TO SAVEPOINT syncer_protocol_handler");
    await connection.query("RELEASE SAVEPOINT syncer_protocol_handler");
    return {
      checkpoint,
      result: {
        mutationId: mutation.mutationId,
        status: "rejected",
        code: decision.code,
        message: decision.message,
        checkpoint: checkpoint.toString(),
        ...(decision.authoritative === undefined
          ? {}
          : { authoritative: decision.authoritative }),
      },
    };
  }

  await connection.query("RELEASE SAVEPOINT syncer_protocol_handler");
  const nextCheckpoint = await readLockedCheckpoint(connection);
  if (nextCheckpoint < checkpoint) {
    throw protocolError(
      500,
      "CHECKPOINT_REGRESSION",
      "mutation handler regressed the protocol checkpoint",
    );
  }
  if (!decision.noOp && nextCheckpoint === checkpoint) {
    throw protocolError(
      500,
      "MUTATION_NOT_CAPTURED",
      `handler for table ${JSON.stringify(mutation.table)} did not emit a captured change`,
    );
  }
  return {
    checkpoint: nextCheckpoint,
    result: {
      mutationId: mutation.mutationId,
      status: "applied",
      checkpoint: nextCheckpoint.toString(),
      ...(decision.noOp ? { noOp: true } : {}),
      ...(decision.document === undefined
        ? {}
        : { document: decision.document }),
    },
  };
}

export async function ensureProtocolSchema(pool: pg.Pool): Promise<number> {
  const createCurrentSchema = `
    CREATE TABLE IF NOT EXISTS syncer_protocol_state (
      singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
      last_seq BIGINT NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
      min_available_seq BIGINT NOT NULL DEFAULT 1 CHECK (min_available_seq >= 1)
    );
    INSERT INTO syncer_protocol_state(singleton) VALUES (TRUE)
      ON CONFLICT (singleton) DO NOTHING;

    CREATE TABLE IF NOT EXISTS syncer_protocol_docs (
      tenant_id TEXT NOT NULL,
      id TEXT NOT NULL,
      data JSONB NOT NULL DEFAULT '{}',
      version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at TIMESTAMPTZ,
      PRIMARY KEY (tenant_id, id)
    );

    CREATE TABLE IF NOT EXISTS syncer_protocol_clients (
      tenant_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      last_mutation_id BIGINT NOT NULL DEFAULT 0 CHECK (last_mutation_id >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, client_id)
    );

    CREATE TABLE IF NOT EXISTS syncer_protocol_mutations (
      tenant_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      mutation_id BIGINT NOT NULL CHECK (mutation_id > 0),
      request_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('applied', 'rejected')),
      response JSONB NOT NULL,
      committed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, client_id, mutation_id),
      FOREIGN KEY (tenant_id, client_id)
        REFERENCES syncer_protocol_clients(tenant_id, client_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS syncer_protocol_changes (
      seq BIGINT PRIMARY KEY CHECK (seq > 0),
      tenant_id TEXT NOT NULL,
      table_name TEXT NOT NULL,
      record_id TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
      record JSONB,
      revision BIGINT NOT NULL CHECK (revision > 0),
      client_id TEXT,
      mutation_id BIGINT,
      actor_subject TEXT,
      committed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT syncer_protocol_changes_source_pair_check
        CHECK ((client_id IS NULL) = (mutation_id IS NULL)),
      UNIQUE (tenant_id, client_id, mutation_id)
    );
  `;

  // Upgrade the original unscoped reference tables without discarding their
  // ledger. Existing rows belong to the legacy "default" tenant. Production
  // deployments can run this same checksummed migration in a maintenance
  // release; startup serializes it and never partially applies it.
  const upgradeLegacySchema = `
    ALTER TABLE syncer_protocol_clients
      ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
    ALTER TABLE syncer_protocol_clients
      ADD COLUMN IF NOT EXISTS subject TEXT NOT NULL DEFAULT 'legacy';
    ALTER TABLE syncer_protocol_mutations
      ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
    ALTER TABLE syncer_protocol_changes
      ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
    ALTER TABLE syncer_protocol_changes
      ADD COLUMN IF NOT EXISTS actor_subject TEXT;
    ALTER TABLE syncer_protocol_changes
      ALTER COLUMN client_id DROP NOT NULL;
    ALTER TABLE syncer_protocol_changes
      ALTER COLUMN mutation_id DROP NOT NULL;

    ALTER TABLE syncer_protocol_mutations
      DROP CONSTRAINT IF EXISTS syncer_protocol_mutations_client_id_fkey;
    ALTER TABLE syncer_protocol_mutations
      DROP CONSTRAINT IF EXISTS syncer_protocol_mutations_tenant_id_client_id_fkey;
    ALTER TABLE syncer_protocol_clients
      DROP CONSTRAINT IF EXISTS syncer_protocol_clients_pkey;
    ALTER TABLE syncer_protocol_mutations
      DROP CONSTRAINT IF EXISTS syncer_protocol_mutations_pkey;
    ALTER TABLE syncer_protocol_changes
      DROP CONSTRAINT IF EXISTS syncer_protocol_changes_client_id_mutation_id_key;
    ALTER TABLE syncer_protocol_changes
      DROP CONSTRAINT IF EXISTS syncer_protocol_changes_tenant_id_client_id_mutation_id_key;
    ALTER TABLE syncer_protocol_changes
      DROP CONSTRAINT IF EXISTS syncer_protocol_changes_source_pair_check;

    ALTER TABLE syncer_protocol_clients
      ADD CONSTRAINT syncer_protocol_clients_pkey
      PRIMARY KEY (tenant_id, client_id);
    ALTER TABLE syncer_protocol_mutations
      ADD CONSTRAINT syncer_protocol_mutations_pkey
      PRIMARY KEY (tenant_id, client_id, mutation_id);
    ALTER TABLE syncer_protocol_mutations
      ADD CONSTRAINT syncer_protocol_mutations_tenant_id_client_id_fkey
      FOREIGN KEY (tenant_id, client_id)
      REFERENCES syncer_protocol_clients(tenant_id, client_id) ON DELETE CASCADE;
    ALTER TABLE syncer_protocol_changes
      ADD CONSTRAINT syncer_protocol_changes_tenant_id_client_id_mutation_id_key
      UNIQUE (tenant_id, client_id, mutation_id);
    ALTER TABLE syncer_protocol_changes
      ADD CONSTRAINT syncer_protocol_changes_source_pair_check
      CHECK ((client_id IS NULL) = (mutation_id IS NULL));

    CREATE INDEX IF NOT EXISTS syncer_protocol_changes_tenant_seq_idx
      ON syncer_protocol_changes (tenant_id, seq);

    CREATE OR REPLACE FUNCTION syncer_protocol_prepare_doc_update()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $trigger$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'physical deletes are forbidden; write a tombstone via deleted_at';
      END IF;
      IF NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id THEN
        RAISE EXCEPTION 'protocol document identity is immutable';
      END IF;
      NEW.version := OLD.version + 1;
      NEW.updated_at := NOW();
      RETURN NEW;
    END
    $trigger$;

    CREATE OR REPLACE FUNCTION syncer_protocol_capture_doc_change()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $trigger$
    DECLARE
      next_seq BIGINT;
      source_client TEXT;
      source_mutation BIGINT;
      source_subject TEXT;
    BEGIN
      UPDATE syncer_protocol_state
         SET last_seq = last_seq + 1
       WHERE singleton = TRUE
       RETURNING last_seq INTO next_seq;

      source_client := NULLIF(current_setting('opto_sync.client_id', TRUE), '');
      source_mutation :=
        NULLIF(current_setting('opto_sync.mutation_id', TRUE), '')::BIGINT;
      source_subject := NULLIF(current_setting('opto_sync.subject', TRUE), '');

      INSERT INTO syncer_protocol_changes
        (seq, tenant_id, table_name, record_id, operation, record, revision,
         client_id, mutation_id, actor_subject)
      VALUES
        (next_seq, NEW.tenant_id, 'docs', NEW.id,
         CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,
         CASE WHEN NEW.deleted_at IS NULL THEN NEW.data ELSE NULL END,
         NEW.version, source_client, source_mutation, source_subject);
      RETURN NEW;
    END
    $trigger$;

    DROP TRIGGER IF EXISTS syncer_protocol_docs_prepare_update
      ON syncer_protocol_docs;
    CREATE TRIGGER syncer_protocol_docs_prepare_update
      BEFORE UPDATE OR DELETE ON syncer_protocol_docs
      FOR EACH ROW EXECUTE FUNCTION syncer_protocol_prepare_doc_update();

    DROP TRIGGER IF EXISTS syncer_protocol_docs_capture_change
      ON syncer_protocol_docs;
    CREATE TRIGGER syncer_protocol_docs_capture_change
      AFTER INSERT OR UPDATE ON syncer_protocol_docs
      FOR EACH ROW EXECUTE FUNCTION syncer_protocol_capture_doc_change();
  `;

  const addGenericTableCapture = `
    CREATE TABLE syncer_protocol_records (
      tenant_id TEXT NOT NULL,
      table_name TEXT NOT NULL,
      record_id TEXT NOT NULL,
      record JSONB,
      revision BIGINT NOT NULL CHECK (revision > 0),
      deleted_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, table_name, record_id),
      CHECK ((record IS NULL) = (deleted_at IS NOT NULL))
    );

    INSERT INTO syncer_protocol_records
      (tenant_id, table_name, record_id, record, revision, deleted_at, updated_at)
    SELECT tenant_id, 'docs', id,
           CASE WHEN deleted_at IS NULL THEN data ELSE NULL END,
           version, deleted_at, updated_at
      FROM syncer_protocol_docs;

    CREATE INDEX syncer_protocol_records_tenant_table_idx
      ON syncer_protocol_records (tenant_id, table_name, record_id)
      WHERE deleted_at IS NULL;

    CREATE OR REPLACE FUNCTION syncer_protocol_capture_change()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $trigger$
    DECLARE
      logical_table TEXT;
      tenant_column TEXT;
      id_column TEXT;
      record_column TEXT;
      deleted_column TEXT;
      row_value JSONB;
      tenant_value TEXT;
      id_value TEXT;
      record_value JSONB;
      deleted_value JSONB;
      is_deleted BOOLEAN;
      next_seq BIGINT;
      next_revision BIGINT;
      source_client TEXT;
      source_mutation BIGINT;
      source_subject TEXT;
    BEGIN
      IF TG_NARGS < 4 OR TG_NARGS > 5 THEN
        RAISE EXCEPTION
          'syncer_protocol_capture_change requires logical table, tenant column, id column, record column, and optional deleted column';
      END IF;
      logical_table := TG_ARGV[0];
      tenant_column := TG_ARGV[1];
      id_column := TG_ARGV[2];
      record_column := TG_ARGV[3];
      deleted_column := CASE WHEN TG_NARGS = 5 THEN TG_ARGV[4] ELSE NULL END;
      IF logical_table IS NULL OR logical_table = '' OR length(logical_table) > 128
         OR logical_table !~ '^[A-Za-z0-9_.:-]+$' THEN
        RAISE EXCEPTION 'invalid logical protocol table name';
      END IF;

      IF TG_OP = 'DELETE' THEN
        row_value := to_jsonb(OLD);
      ELSE
        row_value := to_jsonb(NEW);
      END IF;
      IF NOT (row_value ? tenant_column) OR NOT (row_value ? id_column) THEN
        RAISE EXCEPTION
          'capture columns are missing on %.%', TG_TABLE_SCHEMA, TG_TABLE_NAME;
      END IF;
      tenant_value := row_value ->> tenant_column;
      id_value := row_value ->> id_column;
      IF tenant_value IS NULL OR tenant_value = ''
         OR id_value IS NULL OR id_value = '' THEN
        RAISE EXCEPTION 'capture tenant and record identity must be non-empty';
      END IF;

      is_deleted := TG_OP = 'DELETE';
      IF NOT is_deleted AND deleted_column IS NOT NULL THEN
        IF NOT (row_value ? deleted_column) THEN
          RAISE EXCEPTION 'deleted column "%" is missing', deleted_column;
        END IF;
        deleted_value := row_value -> deleted_column;
        is_deleted :=
          deleted_value IS NOT NULL
          AND deleted_value <> 'null'::JSONB
          AND deleted_value <> 'false'::JSONB
          AND deleted_value <> '0'::JSONB
          AND deleted_value <> '""'::JSONB;
      END IF;

      IF NOT is_deleted THEN
        IF record_column = '*' THEN
          record_value := row_value;
        ELSIF row_value ? record_column THEN
          record_value := row_value -> record_column;
        ELSE
          RAISE EXCEPTION 'record column "%" is missing', record_column;
        END IF;
        IF record_value IS NULL OR jsonb_typeof(record_value) <> 'object' THEN
          RAISE EXCEPTION 'captured protocol record must be a JSON object';
        END IF;
      ELSE
        record_value := NULL;
      END IF;

      UPDATE syncer_protocol_state
         SET last_seq = last_seq + 1
       WHERE singleton = TRUE
       RETURNING last_seq INTO next_seq;
      IF next_seq IS NULL THEN
        RAISE EXCEPTION 'protocol state row is missing';
      END IF;

      INSERT INTO syncer_protocol_records
        (tenant_id, table_name, record_id, record, revision, deleted_at, updated_at)
      VALUES
        (tenant_value, logical_table, id_value, record_value, 1,
         CASE WHEN is_deleted THEN NOW() ELSE NULL END, NOW())
      ON CONFLICT (tenant_id, table_name, record_id) DO UPDATE
        SET record = EXCLUDED.record,
            revision = syncer_protocol_records.revision + 1,
            deleted_at = EXCLUDED.deleted_at,
            updated_at = NOW()
      RETURNING revision INTO next_revision;

      source_client := NULLIF(current_setting('opto_sync.client_id', TRUE), '');
      source_mutation :=
        NULLIF(current_setting('opto_sync.mutation_id', TRUE), '')::BIGINT;
      source_subject := NULLIF(current_setting('opto_sync.subject', TRUE), '');

      INSERT INTO syncer_protocol_changes
        (seq, tenant_id, table_name, record_id, operation, record, revision,
         client_id, mutation_id, actor_subject)
      VALUES
        (next_seq, tenant_value, logical_table, id_value,
         CASE WHEN is_deleted THEN 'delete' ELSE 'upsert' END,
         record_value, next_revision, source_client, source_mutation,
         source_subject);

      IF TG_OP = 'DELETE' THEN
        RETURN OLD;
      END IF;
      RETURN NEW;
    END
    $trigger$;

    COMMENT ON FUNCTION syncer_protocol_capture_change() IS
      'AFTER-row capture: arguments are logical table, tenant column, id column, record column (* for whole row), and optional nullable/truthy deleted column.';

    DROP TRIGGER syncer_protocol_docs_capture_change
      ON syncer_protocol_docs;
    CREATE TRIGGER syncer_protocol_docs_capture_change
      AFTER INSERT OR UPDATE ON syncer_protocol_docs
      FOR EACH ROW EXECUTE FUNCTION syncer_protocol_capture_change(
        'docs', 'tenant_id', 'id', 'data', 'deleted_at'
      );
  `;

  const addOrderedCaptureRegistration = `
    CREATE OR REPLACE FUNCTION syncer_protocol_lock_state()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $trigger$
    BEGIN
      -- Protocol pushes lock state before authoritative rows. A direct SQL
      -- statement must use the same order; otherwise its row-level AFTER
      -- trigger can hold a row while waiting for state as a push holds state
      -- while waiting for that row.
      PERFORM last_seq
        FROM syncer_protocol_state
       WHERE singleton = TRUE
       FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'protocol state row is missing';
      END IF;
      RETURN NULL;
    END
    $trigger$;

    CREATE OR REPLACE FUNCTION syncer_protocol_register_capture(
      p_source_table REGCLASS,
      p_logical_table TEXT,
      p_tenant_column TEXT,
      p_id_column TEXT,
      p_record_column TEXT,
      p_deleted_column TEXT DEFAULT NULL
    )
    RETURNS VOID
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $register$
    DECLARE
      relation_kind "char";
      lock_trigger TEXT := 'syncer_protocol_lock_' || p_source_table::OID;
      capture_trigger TEXT := 'syncer_protocol_capture_' || p_source_table::OID;
      candidate_column TEXT;
      capture_arguments TEXT;
    BEGIN
      SELECT relkind INTO relation_kind
        FROM pg_class
       WHERE oid = p_source_table;
      IF relation_kind IS NULL OR relation_kind NOT IN ('r', 'p') THEN
        RAISE EXCEPTION 'capture source must be a table or partitioned table';
      END IF;
      IF p_logical_table IS NULL OR p_logical_table = ''
         OR length(p_logical_table) > 128
         OR p_logical_table !~ '^[A-Za-z0-9_.:-]+$' THEN
        RAISE EXCEPTION 'invalid logical protocol table name';
      END IF;
      IF p_tenant_column IS NULL OR p_tenant_column = ''
         OR p_id_column IS NULL OR p_id_column = ''
         OR p_record_column IS NULL OR p_record_column = '' THEN
        RAISE EXCEPTION 'capture column names must be non-empty';
      END IF;

      FOREACH candidate_column IN ARRAY ARRAY[
        p_tenant_column,
        p_id_column,
        CASE WHEN p_record_column = '*' THEN NULL ELSE p_record_column END,
        p_deleted_column
      ]
      LOOP
        IF candidate_column IS NOT NULL AND NOT EXISTS (
          SELECT 1
            FROM pg_attribute
           WHERE attrelid = p_source_table
             AND attname = candidate_column
             AND attnum > 0
             AND NOT attisdropped
        ) THEN
          RAISE EXCEPTION 'capture column "%" is missing on %',
            candidate_column, p_source_table;
        END IF;
      END LOOP;

      EXECUTE format(
        'DROP TRIGGER IF EXISTS %I ON %s',
        lock_trigger,
        p_source_table
      );
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %s '
        'FOR EACH STATEMENT EXECUTE FUNCTION syncer_protocol_lock_state()',
        lock_trigger,
        p_source_table
      );

      EXECUTE format(
        'DROP TRIGGER IF EXISTS %I ON %s',
        capture_trigger,
        p_source_table
      );
      capture_arguments := format(
        '%L, %L, %L, %L',
        p_logical_table,
        p_tenant_column,
        p_id_column,
        p_record_column
      );
      IF p_deleted_column IS NOT NULL THEN
        capture_arguments :=
          capture_arguments || format(', %L', p_deleted_column);
      END IF;
      EXECUTE format(
        'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %s '
        'FOR EACH ROW EXECUTE FUNCTION syncer_protocol_capture_change(%s)',
        capture_trigger,
        p_source_table,
        capture_arguments
      );
    END
    $register$;

    COMMENT ON FUNCTION syncer_protocol_lock_state() IS
      'BEFORE-statement lock that orders direct SQL capture state before source rows.';
    COMMENT ON FUNCTION syncer_protocol_register_capture(
      REGCLASS, TEXT, TEXT, TEXT, TEXT, TEXT
    ) IS
      'Registers paired BEFORE-statement lock and AFTER-row capture triggers after validating the source relation and columns.';

    DROP TRIGGER syncer_protocol_docs_capture_change
      ON syncer_protocol_docs;
    SELECT syncer_protocol_register_capture(
      'syncer_protocol_docs'::REGCLASS,
      'docs',
      'tenant_id',
      'id',
      'data',
      'deleted_at'
    );
  `;

  const migrations = [
    {
      version: 1,
      name: "protocol_v1_tenant_ledger_and_capture",
      sql: `${createCurrentSchema}\n${upgradeLegacySchema}`,
    },
    {
      version: 2,
      name: "generic_application_table_capture",
      sql: addGenericTableCapture,
    },
    {
      version: 3,
      name: "ordered_capture_registration",
      sql: addOrderedCaptureRegistration,
    },
  ] as const;

  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    // Session-local concurrent starts must not race DDL or mark a partially
    // applied migration. The transaction lock is released on commit/rollback.
    await connection.query(
      "SELECT pg_advisory_xact_lock(hashtext('opto_sync_protocol_schema'))",
    );
    await connection.query(`
      CREATE TABLE IF NOT EXISTS syncer_protocol_schema_migrations (
        version INTEGER PRIMARY KEY CHECK (version > 0),
        name TEXT NOT NULL UNIQUE,
        checksum TEXT NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const applied = await connection.query<{
      version: number;
      name: string;
      checksum: string;
    }>(
      `SELECT version, name, checksum
         FROM syncer_protocol_schema_migrations
        ORDER BY version`,
    );
    const expected = migrations.map((migration) => ({
      version: migration.version,
      name: migration.name,
      checksum: createHash("sha256").update(migration.sql).digest("hex"),
    }));
    validateSchemaMigrationHistory(applied.rows, expected);

    for (const migration of migrations) {
      const checksum = expected.find(
        (candidate) => candidate.version === migration.version,
      )!.checksum;
      const existing = applied.rows.find(
        (candidate) => candidate.version === migration.version,
      );
      if (existing !== undefined) {
        continue;
      }
      await connection.query(migration.sql);
      await connection.query(
        `INSERT INTO syncer_protocol_schema_migrations(version, name, checksum)
         VALUES ($1, $2, $3)`,
        [migration.version, migration.name, checksum],
      );
    }
    await connection.query("COMMIT");
    return migrations[migrations.length - 1].version;
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

export async function resetProtocolState(pool: pg.Pool): Promise<void> {
  await pool.query(`
    TRUNCATE syncer_protocol_changes, syncer_protocol_mutations,
      syncer_protocol_clients, syncer_protocol_records, syncer_protocol_docs;
    UPDATE syncer_protocol_state SET last_seq = 0, min_available_seq = 1
      WHERE singleton = TRUE;
  `);
}

export function installSyncProtocol(
  app: express.Express,
  pool: pg.Pool,
  merge: MergeFunction,
  testMode: boolean,
  operations: ProtocolOperations,
  options: SyncProtocolOptions = {},
): void {
  const auth = testMode ? null : createProtocolAuthenticator();
  const adminAuth = loadAdminAuth();
  const { config, limiter, metrics } = operations;
  const mutationHandlers = new Map<string, ProtocolMutationHandler>();
  for (const [table, handler] of Object.entries(
    options.mutationHandlers ?? {},
  )) {
    if (!ScopeId.safeParse(table).success || table === "docs") {
      throw new Error(
        `invalid or reserved protocol mutation handler table ${JSON.stringify(table)}`,
      );
    }
    if (typeof handler !== "function") {
      throw new Error(
        `protocol mutation handler for ${JSON.stringify(table)} is not callable`,
      );
    }
    mutationHandlers.set(table, handler);
  }

  app.use("/v1/sync", (request, response, next) => {
    const requestId = operations.newRequestId();
    const startedAt = process.hrtime.bigint();
    response.locals.syncRequestId = requestId;
    response.set("x-request-id", requestId);
    response.once("finish", () => {
      const elapsedSeconds =
        Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
      metrics.observeRequest(
        protocolRouteLabel(request.path),
        request.method,
        response.statusCode,
        elapsedSeconds,
      );
    });
    next();
  });

  const rateLimit = (
    request: express.Request,
    response: express.Response,
    next: express.NextFunction,
    principal: string,
    kind: "tenant" | "admin" | "test",
  ) => {
    const route = protocolRouteLabel(request.path);
    const principalHash = privacyHash(principal);
    const decision = limiter.consume(`${kind}:${principalHash}:${route}`);
    if (!decision.allowed) {
      metrics.increment("opto_sync_protocol_rate_limited_total", { route });
      auditEvent("protocol.rate_limited", {
        requestId: response.locals.syncRequestId,
        principalHash,
        principalKind: kind,
        route,
        retryAfterSeconds: decision.retryAfterSeconds,
      });
      response.set("retry-after", String(decision.retryAfterSeconds));
      return response.status(429).json({
        protocolVersion: PROTOCOL_VERSION,
        error: "RATE_LIMITED",
        retryAfterSeconds: decision.retryAfterSeconds,
      });
    }
    return next();
  };

  const denyAuthentication = (
    request: express.Request,
    response: express.Response,
    event: string,
  ) => {
    const route = protocolRouteLabel(request.path);
    const remoteHash = privacyHash(
      request.ip ?? request.socket.remoteAddress ?? "unknown",
    );
    const decision = limiter.consume(`unauthenticated:${remoteHash}:${route}`);
    if (!decision.allowed) {
      metrics.increment("opto_sync_protocol_rate_limited_total", {
        route,
      });
      auditEvent("protocol.authentication_rate_limited", {
        requestId: response.locals.syncRequestId,
        remoteHash,
        route,
        retryAfterSeconds: decision.retryAfterSeconds,
      });
      response.set("retry-after", String(decision.retryAfterSeconds));
      return response.status(429).json({
        protocolVersion: PROTOCOL_VERSION,
        error: "RATE_LIMITED",
        retryAfterSeconds: decision.retryAfterSeconds,
      });
    }
    auditEvent(event, {
      requestId: response.locals.syncRequestId,
      remoteHash,
      route,
    });
    return response.status(401).json({
      protocolVersion: PROTOCOL_VERSION,
      error: "UNAUTHORIZED",
    });
  };

  app.use("/v1/sync", async (request, response, next) => {
    if (testMode) {
      const tenantId = request.get("x-syncer-test-tenant") ?? "e2e";
      const subject = request.get("x-syncer-test-subject") ?? "e2e";
      const clientId = request.get("x-syncer-test-client-id");
      if (!ScopeId.safeParse(tenantId).success || !ScopeId.safeParse(subject).success) {
        auditEvent("protocol.test_identity_rejected", {
          requestId: response.locals.syncRequestId,
          route: protocolRouteLabel(request.path),
        });
        return response.status(400).json({
          protocolVersion: PROTOCOL_VERSION,
          error: "INVALID_TEST_IDENTITY",
        });
      }
      if (clientId !== undefined && !ClientId.safeParse(clientId).success) {
        auditEvent("protocol.test_identity_rejected", {
          requestId: response.locals.syncRequestId,
          route: protocolRouteLabel(request.path),
        });
        return response.status(400).json({
          protocolVersion: PROTOCOL_VERSION,
          error: "INVALID_TEST_IDENTITY",
        });
      }
      response.locals.syncIdentity = {
        subject,
        tenantId,
        clientIds: clientId === undefined ? null : new Set([clientId]),
      } satisfies ProtocolIdentity;
      return rateLimit(
        request,
        response,
        next,
        `${tenantId}\u0000${subject}`,
        "test",
      );
    }
    if (request.path.startsWith("/admin/")) {
      if (adminAuth.error || !adminAuth.tokenHash) {
        auditEvent("protocol.admin_unavailable", {
          requestId: response.locals.syncRequestId,
          route: protocolRouteLabel(request.path),
        });
        return response.status(503).json({
          protocolVersion: PROTOCOL_VERSION,
          error: "ADMIN_NOT_CONFIGURED",
          message: adminAuth.error,
        });
      }
      const actual = bearerHash(request);
      if (!actual || !timingSafeEqual(actual, adminAuth.tokenHash)) {
        return denyAuthentication(
          request,
          response,
          "protocol.admin_authentication_denied",
        );
      }
      return rateLimit(
        request,
        response,
        next,
        adminAuth.tokenHash.toString("hex"),
        "admin",
      );
    }
    const authenticated = await auth!.authenticateAuthorization(
      request.get("authorization"),
    );
    if (authenticated.status === "unavailable") {
      auditEvent("protocol.authentication_unavailable", {
        requestId: response.locals.syncRequestId,
        route: protocolRouteLabel(request.path),
      });
      return response.status(503).json({
        protocolVersion: PROTOCOL_VERSION,
        error: "AUTHENTICATION_UNAVAILABLE",
      });
    }
    if (authenticated.status === "denied") {
      return denyAuthentication(
        request,
        response,
        "protocol.authentication_denied",
      );
    }
    const identity = authenticated.identity;
    response.locals.syncIdentity = identity;
    return rateLimit(
      request,
      response,
      next,
      `${identity.tenantId}\u0000${identity.subject}`,
      "tenant",
    );
  });

  const pushCore = async (
    context: ProtocolCallContext,
    rawBody: unknown,
  ): Promise<ProtocolCallResult> => {
    const body = rawBody as any;
    const requestId = context.requestId;
    const rawBodyBytes =
      context.rawBodyBytes ?? Buffer.byteLength(JSON.stringify(body ?? null));
    if (rawBodyBytes > config.maxPushBytes) {
      metrics.increment("opto_sync_protocol_quota_rejections_total", {
        quota: "push_bytes",
      });
      auditEvent("protocol.push_rejected", {
        requestId,
        code: "PUSH_TOO_LARGE",
        bodyBytes: rawBodyBytes,
        limitBytes: config.maxPushBytes,
      });
      return {
        status: 413,
        body: {
          protocolVersion: PROTOCOL_VERSION,
          error: "PUSH_TOO_LARGE",
          limitBytes: config.maxPushBytes,
        },
      };
    }
    if (
      Array.isArray(body?.mutations) &&
      body.mutations.length > config.maxPushMutations
    ) {
      metrics.increment("opto_sync_protocol_quota_rejections_total", {
        quota: "push_mutations",
      });
      auditEvent("protocol.push_rejected", {
        requestId,
        code: "PUSH_MUTATION_LIMIT",
        mutationCount: body.mutations.length,
        limit: config.maxPushMutations,
      });
      return {
        status: 413,
        body: {
          protocolVersion: PROTOCOL_VERSION,
          error: "PUSH_MUTATION_LIMIT",
          limit: config.maxPushMutations,
        },
      };
    }
    if (Array.isArray(body?.mutations)) {
      const oversizedIndex = body.mutations.findIndex(
        (mutation: unknown) =>
          Buffer.byteLength(stableJson(mutation)) > config.maxMutationBytes,
      );
      if (oversizedIndex !== -1) {
        metrics.increment("opto_sync_protocol_quota_rejections_total", {
          quota: "mutation_bytes",
        });
        auditEvent("protocol.push_rejected", {
          requestId,
          code: "MUTATION_TOO_LARGE",
          mutationIndex: oversizedIndex,
          limitBytes: config.maxMutationBytes,
        });
        return {
          status: 413,
          body: {
            protocolVersion: PROTOCOL_VERSION,
            error: "MUTATION_TOO_LARGE",
            mutationIndex: oversizedIndex,
            limitBytes: config.maxMutationBytes,
          },
        };
      }
    }
    const parsed = PushSchema.safeParse(body);
    if (!parsed.success) {
      metrics.increment("opto_sync_protocol_push_rejections_total", {
        code: "INVALID_PUSH",
      });
      return {
        status: 400,
        body: {
          protocolVersion: PROTOCOL_VERSION,
          error: "INVALID_PUSH",
          details: parsed.error.format(),
        },
      };
    }
    const identity = context.identity;
    if (
      identity.clientIds !== null &&
      !identity.clientIds.has(parsed.data.clientId)
    ) {
      auditEvent("protocol.client_binding_denied", {
        requestId,
        principalHash: privacyHash(
          `${identity.tenantId}\u0000${identity.subject}`,
        ),
        clientHash: privacyHash(parsed.data.clientId),
      });
      return {
        status: 403,
        body: {
          protocolVersion: PROTOCOL_VERSION,
          error: "CLIENT_ID_FORBIDDEN",
          message: "the authenticated identity is not bound to this clientId",
        },
      };
    }

    const failpoint = testMode ? context.failpoint : undefined;
    if (
      failpoint !== undefined &&
      ![
        "after-effect",
        "after-ledger",
        "before-commit",
        "after-commit-response-loss",
      ].includes(failpoint)
    ) {
      return {
        status: 400,
        body: {
          protocolVersion: PROTOCOL_VERSION,
          error: "INVALID_FAILPOINT",
        },
      };
    }
    const injectFailure = (stage: string) => {
      if (failpoint === stage) {
        throw protocolError(500, "INJECTED_FAILURE", `test failure at ${stage}`);
      }
    };

    const connection = await pool.connect();
    try {
      await connection.query("BEGIN");
      // The singleton lock makes checkpoint allocation reflect transaction
      // commit order. A bare sequence cannot provide that guarantee.
      const protocolState = await connection.query(
        `SELECT last_seq, min_available_seq
           FROM syncer_protocol_state WHERE singleton = TRUE FOR UPDATE`,
      );
      let checkpoint = BigInt(protocolState.rows[0].last_seq);
      const initialCheckpoint = checkpoint;
      await connection.query(
        `INSERT INTO syncer_protocol_clients(tenant_id, client_id, subject)
         VALUES ($1, $2, $3) ON CONFLICT (tenant_id, client_id) DO NOTHING`,
        [identity.tenantId, parsed.data.clientId, identity.subject],
      );
      const clientState = await connection.query(
        `SELECT subject, last_mutation_id FROM syncer_protocol_clients
          WHERE tenant_id = $1 AND client_id = $2 FOR UPDATE`,
        [identity.tenantId, parsed.data.clientId],
      );
      if (clientState.rows[0].subject !== identity.subject) {
        throw protocolError(
          403,
          "CLIENT_OWNERSHIP_CONFLICT",
          "clientId is durably bound to another authenticated subject",
        );
      }
      let lastMutationId = BigInt(clientState.rows[0].last_mutation_id);
      const results: Record<string, unknown>[] = [];

      for (const mutation of parsed.data.mutations) {
        const mutationId = BigInt(mutation.mutationId);
        const hash = mutationHash(mutation);

        if (mutationId <= lastMutationId) {
          const prior = await connection.query(
            `SELECT request_hash, status, response
               FROM syncer_protocol_mutations
              WHERE tenant_id = $1 AND client_id = $2 AND mutation_id = $3`,
            [identity.tenantId, parsed.data.clientId, mutation.mutationId],
          );
          if (prior.rows.length === 0) {
            throw protocolError(
              500,
              "LEDGER_INCONSISTENT",
              "client watermark has no matching mutation ledger row",
            );
          }
          if (prior.rows[0].request_hash !== hash) {
            throw protocolError(
              409,
              "MUTATION_ID_REUSED",
              `mutationId ${mutation.mutationId} was already used for different content`,
            );
          }
          results.push({
            ...prior.rows[0].response,
            status: "duplicate",
            originalStatus: prior.rows[0].status,
          });
          continue;
        }

        if (mutationId !== lastMutationId + 1n) {
          throw protocolError(
            409,
            "MUTATION_GAP",
            `expected mutationId ${lastMutationId + 1n}, received ${mutationId}`,
            { lastMutationId: lastMutationId.toString() },
          );
        }

        // Expose immutable attribution to applyMutation's change insert without
        // interpolating it into each SQL statement.
        await connection.query("SELECT set_config('opto_sync.client_id', $1, true)", [
          parsed.data.clientId,
        ]);
        await connection.query("SELECT set_config('opto_sync.mutation_id', $1, true)", [
          mutation.mutationId,
        ]);
        await connection.query("SELECT set_config('opto_sync.subject', $1, true)", [
          identity.subject,
        ]);
        const handler = mutationHandlers.get(mutation.table);
        const applied =
          mutation.table === "docs"
            ? await applyMutation(
                connection,
                identity.tenantId,
                mutation,
                checkpoint,
                merge,
              )
            : handler === undefined
              ? {
                  checkpoint,
                  result: await rejectMutation(
                    connection,
                    mutation,
                    "UNSUPPORTED_TABLE",
                    `table ${JSON.stringify(mutation.table)} is not exposed by protocol v1`,
                    checkpoint,
                  ),
                }
              : await applyRegisteredMutation(
                  connection,
                  identity,
                  parsed.data.clientId,
                  mutation,
                  checkpoint,
                  merge,
                  handler,
                );
        checkpoint = applied.checkpoint;
        injectFailure("after-effect");
        const ledgerStatus = applied.result.status === "rejected" ? "rejected" : "applied";
        await connection.query(
          `INSERT INTO syncer_protocol_mutations
             (tenant_id, client_id, mutation_id, request_hash, status, response)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
          [
            identity.tenantId,
            parsed.data.clientId,
            mutation.mutationId,
            hash,
            ledgerStatus,
            JSON.stringify(applied.result),
          ],
        );
        injectFailure("after-ledger");
        lastMutationId = mutationId;
        results.push(applied.result);
      }

      await connection.query(
        `UPDATE syncer_protocol_clients
            SET last_mutation_id = $2, updated_at = NOW()
          WHERE tenant_id = $1 AND client_id = $3`,
        [identity.tenantId, lastMutationId.toString(), parsed.data.clientId],
      );
      injectFailure("before-commit");
      await connection.query("COMMIT");

      // Model the hardest retry window: the durable transaction committed but
      // the process or network disappeared before the client received an
      // acknowledgement. The next identical request must be answered entirely
      // from the immutable mutation ledger.
      if (failpoint === "after-commit-response-loss") {
        response.socket?.destroy();
        return;
      }

      const outcomes = results.reduce<Record<string, number>>((counts, result) => {
        const outcome = String(result.status);
        counts[outcome] = (counts[outcome] ?? 0) + 1;
        metrics.increment("opto_sync_protocol_mutations_total", { outcome });
        return counts;
      }, {});
      metrics.increment("opto_sync_protocol_push_batches_total");
      metrics.increment(
        "opto_sync_protocol_push_bytes_total",
        {},
        rawBodyBytes,
      );
      auditEvent("protocol.push_committed", {
        requestId,
        principalHash: privacyHash(
          `${identity.tenantId}\u0000${identity.subject}`,
        ),
        clientHash: privacyHash(parsed.data.clientId),
        mutationCount: parsed.data.mutations.length,
        outcomes,
        checkpoint: checkpoint.toString(),
      });
      return response.json({
        protocolVersion: PROTOCOL_VERSION,
        clientId: parsed.data.clientId,
        lastMutationId: lastMutationId.toString(),
        checkpoint: checkpoint.toString(),
        results,
      });
    } catch (error) {
      await rollbackQuietly(connection);
      const failure = publicProtocolFailure(error, "PUSH_FAILED");
      metrics.increment("opto_sync_protocol_push_rejections_total", {
        code: failure.code,
      });
      auditEvent("protocol.push_rolled_back", {
        requestId,
        principalHash: privacyHash(
          `${identity.tenantId}\u0000${identity.subject}`,
        ),
        clientHash: privacyHash(parsed.data.clientId),
        mutationCount: parsed.data.mutations.length,
        code: failure.code,
      });
      return response.status(failure.status).json({
        protocolVersion: PROTOCOL_VERSION,
        error: failure.code,
        message: failure.message,
        ...(failure.detail === undefined ? {} : { detail: failure.detail }),
      });
    } finally {
      connection.release();
    }
  });

  app.get("/v1/sync/pull", async (request, response) => {
    let connection: pg.PoolClient | undefined;
    try {
      const identity = response.locals.syncIdentity as ProtocolIdentity;
      const checkpoint = parseCheckpoint(request.query.checkpoint, "checkpoint");
      const limitRaw = Number(request.query.limit ?? 100);
      if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 1000) {
        throw protocolError(400, "INVALID_LIMIT", "limit must be an integer from 1 to 1000");
      }
      connection = await pool.connect();
      await connection.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const state = await connection.query(
        `SELECT last_seq, min_available_seq FROM syncer_protocol_state WHERE singleton = TRUE`,
      );
      const last = BigInt(state.rows[0].last_seq);
      const minimum = BigInt(state.rows[0].min_available_seq);
      if (checkpoint > last) {
        throw protocolError(400, "CHECKPOINT_AHEAD", "checkpoint is ahead of the server");
      }
      if (checkpoint + 1n < minimum) {
        await connection.query("COMMIT");
        return response.status(409).json({
          protocolVersion: PROTOCOL_VERSION,
          error: "RESET_REQUIRED",
          resetRequired: true,
          minimumCheckpoint: (minimum - 1n).toString(),
          snapshotUrl: "/v1/sync/snapshot",
        });
      }

      const changes = await connection.query(
        `SELECT seq, table_name, record_id, operation, record, revision,
                client_id, mutation_id, committed_at
           FROM syncer_protocol_changes
          WHERE seq > $1 AND seq <= $2 AND tenant_id = $3
          ORDER BY seq
          LIMIT $4`,
        [
          checkpoint.toString(),
          last.toString(),
          identity.tenantId,
          limitRaw + 1,
        ],
      );
      const hasMore = changes.rows.length > limitRaw;
      const page = changes.rows.slice(0, limitRaw);
      const next =
        hasMore
          ? BigInt(page[page.length - 1].seq)
          : last;
      await connection.query("COMMIT");
      return response.json({
        protocolVersion: PROTOCOL_VERSION,
        checkpoint: next.toString(),
        hasMore,
        changes: page.map((row) => ({
          checkpoint: String(row.seq),
          table: row.table_name,
          recordId: row.record_id,
          operation: row.operation,
          record: row.record,
          revision: String(row.revision),
          ...(row.client_id == null
            ? {}
            : {
                source: {
                  clientId: row.client_id,
                  mutationId: String(row.mutation_id),
                },
              }),
          committedAt: row.committed_at,
        })),
      });
    } catch (error) {
      if (connection) await rollbackQuietly(connection);
      const failure = publicProtocolFailure(error, "PULL_FAILED");
      return response.status(failure.status).json({
        protocolVersion: PROTOCOL_VERSION,
        error: failure.code,
        message: failure.message,
      });
    } finally {
      connection?.release();
    }
  });

  app.get("/v1/sync/snapshot", async (_request, response) => {
    const identity = response.locals.syncIdentity as ProtocolIdentity;
    const requestId = response.locals.syncRequestId as string;
    const connection = await pool.connect();
    try {
      await connection.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const state = await connection.query(
        `SELECT last_seq FROM syncer_protocol_state WHERE singleton = TRUE`,
      );
      const summary = await connection.query(
        `SELECT COUNT(*)::BIGINT AS record_count,
                COALESCE(SUM(octet_length(record::text)), 0)::BIGINT AS data_bytes
           FROM syncer_protocol_records
          WHERE tenant_id = $1 AND deleted_at IS NULL`,
        [identity.tenantId],
      );
      const recordCount = BigInt(summary.rows[0].record_count);
      const dataBytes = BigInt(summary.rows[0].data_bytes);
      if (
        recordCount > BigInt(config.maxSnapshotRecords) ||
        dataBytes > BigInt(config.maxSnapshotBytes)
      ) {
        await connection.query("COMMIT");
        metrics.increment("opto_sync_protocol_quota_rejections_total", {
          quota: "snapshot",
        });
        auditEvent("protocol.snapshot_rejected", {
          requestId,
          principalHash: privacyHash(
            `${identity.tenantId}\u0000${identity.subject}`,
          ),
          code: "SNAPSHOT_QUOTA_EXCEEDED",
          recordCount: recordCount.toString(),
          dataBytes: dataBytes.toString(),
          maxRecords: config.maxSnapshotRecords,
          maxBytes: config.maxSnapshotBytes,
        });
        return response.status(413).json({
          protocolVersion: PROTOCOL_VERSION,
          error: "SNAPSHOT_QUOTA_EXCEEDED",
          recordCount: recordCount.toString(),
          dataBytes: dataBytes.toString(),
          maxRecords: config.maxSnapshotRecords,
          maxBytes: config.maxSnapshotBytes,
        });
      }
      const records = await connection.query(
        `SELECT table_name, record_id, record, revision
           FROM syncer_protocol_records
          WHERE tenant_id = $1 AND deleted_at IS NULL
          ORDER BY table_name, record_id`,
        [identity.tenantId],
      );
      await connection.query("COMMIT");
      metrics.increment("opto_sync_protocol_snapshots_total");
      metrics.increment(
        "opto_sync_protocol_snapshot_records_total",
        {},
        records.rows.length,
      );
      return response.json({
        protocolVersion: PROTOCOL_VERSION,
        checkpoint: String(state.rows[0].last_seq),
        records: records.rows.map((row) => ({
          table: row.table_name,
          recordId: row.record_id,
          record: row.record,
          revision: String(row.revision),
        })),
      });
    } catch (error) {
      await rollbackQuietly(connection);
      metrics.increment("opto_sync_protocol_snapshot_failures_total");
      auditEvent("protocol.snapshot_failed", {
        requestId,
        principalHash: privacyHash(
          `${identity.tenantId}\u0000${identity.subject}`,
        ),
        code: "SNAPSHOT_FAILED",
      });
      return response.status(500).json({
        protocolVersion: PROTOCOL_VERSION,
        error: "SNAPSHOT_FAILED",
        message: publicProtocolFailure(error, "SNAPSHOT_FAILED").message,
      });
    } finally {
      connection.release();
    }
  });

  /**
   * Test-only direct table writer. It deliberately bypasses the mutation
   * ledger and session attribution, exercising the database trigger used by
   * migrations, administrative jobs, and other non-protocol writers.
   */
  app.post("/v1/sync/admin/external-write", async (request, response) => {
    if (!testMode) {
      return response.status(403).json({ error: "test mode required" });
    }
    const parsed = ExternalWriteSchema.safeParse(request.body);
    if (!parsed.success) {
      return response.status(400).json({
        protocolVersion: PROTOCOL_VERSION,
        error: "INVALID_EXTERNAL_WRITE",
        details: parsed.error.format(),
      });
    }
    const identity = response.locals.syncIdentity as ProtocolIdentity;
    const connection = await pool.connect();
    try {
      await connection.query("BEGIN");
      let written;
      if (parsed.data.operation === "upsert") {
        written = await connection.query(
          `INSERT INTO syncer_protocol_docs
             (tenant_id, id, data, version, deleted_at, updated_at)
           VALUES ($1, $2, $3::jsonb, 1, NULL, NOW())
           ON CONFLICT (tenant_id, id) DO UPDATE
             SET data = EXCLUDED.data, deleted_at = NULL
           RETURNING id, data, version, deleted_at`,
          [
            identity.tenantId,
            parsed.data.recordId,
            JSON.stringify(parsed.data.payload),
          ],
        );
      } else {
        written = await connection.query(
          `UPDATE syncer_protocol_docs
              SET deleted_at = NOW()
            WHERE tenant_id = $1 AND id = $2
            RETURNING id, data, version, deleted_at`,
          [identity.tenantId, parsed.data.recordId],
        );
        if (written.rows.length === 0) {
          throw protocolError(404, "NOT_FOUND", "external delete target does not exist");
        }
      }
      const checkpoint = await readLockedCheckpoint(connection);
      if (request.get("x-syncer-failpoint") === "after-external-effect") {
        throw protocolError(
          500,
          "INJECTED_FAILURE",
          "test failure after direct table effect",
        );
      }
      await connection.query("COMMIT");
      return response.json({
        protocolVersion: PROTOCOL_VERSION,
        checkpoint: checkpoint.toString(),
        document: publicDocument(written.rows[0]),
      });
    } catch (error) {
      await rollbackQuietly(connection);
      const failure = publicProtocolFailure(error, "EXTERNAL_WRITE_FAILED");
      return response.status(failure.status).json({
        protocolVersion: PROTOCOL_VERSION,
        error: failure.code,
        message: failure.message,
      });
    } finally {
      connection.release();
    }
  });

  app.post("/v1/sync/admin/compact", async (request, response) => {
    const requestId = response.locals.syncRequestId as string;
    const connection = await pool.connect();
    try {
      const through = parseCheckpoint(request.body?.throughCheckpoint, "throughCheckpoint");
      const failpoint = testMode ? request.get("x-syncer-failpoint") : undefined;
      if (
        failpoint !== undefined &&
        !["after-compaction-delete", "before-compaction-commit"].includes(failpoint)
      ) {
        throw protocolError(400, "INVALID_FAILPOINT", "unknown compaction failpoint");
      }
      await connection.query("BEGIN");
      const state = await connection.query(
        `SELECT last_seq, min_available_seq
           FROM syncer_protocol_state WHERE singleton = TRUE FOR UPDATE`,
      );
      const last = BigInt(state.rows[0].last_seq);
      const oldMinimum = BigInt(state.rows[0].min_available_seq);
      if (through > last) {
        throw protocolError(400, "CHECKPOINT_AHEAD", "cannot compact past the server checkpoint");
      }
      await connection.query("DELETE FROM syncer_protocol_changes WHERE seq <= $1", [
        through.toString(),
      ]);
      if (failpoint === "after-compaction-delete") {
        throw protocolError(500, "INJECTED_FAILURE", "test failure after compaction delete");
      }
      const minimum = oldMinimum > through + 1n ? oldMinimum : through + 1n;
      await connection.query(
        `UPDATE syncer_protocol_state SET min_available_seq = $1 WHERE singleton = TRUE`,
        [minimum.toString()],
      );
      if (failpoint === "before-compaction-commit") {
        throw protocolError(500, "INJECTED_FAILURE", "test failure before compaction commit");
      }
      await connection.query("COMMIT");
      metrics.increment("opto_sync_protocol_compactions_total", {
        outcome: "committed",
      });
      auditEvent("protocol.compaction_committed", {
        requestId,
        compactedThrough: through.toString(),
        minimumCheckpoint: (minimum - 1n).toString(),
      });
      return response.json({
        protocolVersion: PROTOCOL_VERSION,
        compactedThrough: through.toString(),
        minimumCheckpoint: (minimum - 1n).toString(),
      });
    } catch (error) {
      await rollbackQuietly(connection);
      const failure = publicProtocolFailure(error, "COMPACTION_FAILED");
      metrics.increment("opto_sync_protocol_compactions_total", {
        outcome: "rolled_back",
      });
      auditEvent("protocol.compaction_rolled_back", {
        requestId,
        code: failure.code,
      });
      return response.status(failure.status).json({
        protocolVersion: PROTOCOL_VERSION,
        error: failure.code,
        message: failure.message,
      });
    } finally {
      connection.release();
    }
  });
}
