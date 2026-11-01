/**
 * Experimental fixed-ID scoped replication reads for protocol v1.
 * Reuses existing PostgreSQL log and tenant authentication middleware.
 * Only reference 'docs' is allowed; deployments requiring per-record ACLs
 * must add explicit authorization before enabling this experimental route.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type express from 'express';
import type pg from 'pg';
import { z } from 'zod';
import type { ProtocolIdentity } from './auth.js';

const MAX_I64 = 9223372036854775807n;
const Decimal = z.string().regex(/^(?:0|[1-9][0-9]*)$/)
  .refine((v) => BigInt(v) <= MAX_I64, 'signed int64 required');
const ScopeSchema = z.object({
  version: z.literal(1),
  table: z.literal('docs'),
  recordIds: z.array(z.string().min(1).max(512)).min(1).max(128),
}).strict().superRefine((scope, ctx) => {
  if (new Set(scope.recordIds).size !== scope.recordIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate record IDs in scope' });
  }
});
const BaseRequest = z.object({
  protocolVersion: z.literal(1),
  scopeKey: z.string().min(1).max(131072),
  scope: ScopeSchema,
}).strict();
const PullRequest = BaseRequest.extend({
  checkpoint: Decimal,
  scopeToken: z.string().regex(/^[0-9a-f]{64}$/),
  limit: z.number().int().min(1).max(1000).optional(),
});
export type FixedRecordIdScopeV1 = z.infer<typeof ScopeSchema>;

export function canonicalFixedScope(scope: FixedRecordIdScopeV1): FixedRecordIdScopeV1 {
  const parsed = ScopeSchema.parse(scope);
  // Fixed 128-ID cap: immutable insertion instead of in-place sorting.
  const ids = parsed.recordIds.reduce<string[]>((acc, id) => {
    const at = acc.findIndex((other) => other > id);
    return at < 0 ? [...acc, id] : [...acc.slice(0, at), id, ...acc.slice(at)];
  }, []);
  return { version: 1, table: 'docs', recordIds: ids };
}

/** Scope discriminator is NOT authorization; validate the bearer on every read. */
export function fixedScopeToken(scope: FixedRecordIdScopeV1, identity: ProtocolIdentity): string {
  const canonical = canonicalFixedScope(scope);
  return createHash('sha256').update(JSON.stringify([
    'opto.fixed-scope.v1', identity.tenantId, identity.subject,
    canonical.table, canonical.recordIds,
  ])).digest('hex');
}

async function withReadSnapshot<T>(pool: pg.Pool, work: (conn: pg.PoolClient) => Promise<T>): Promise<T> {
  const conn = await pool.connect();
  try {
    await conn.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await work(conn);
    await conn.query('COMMIT');
    return result;
  } catch (error) {
    try { await conn.query('ROLLBACK'); } catch { /* preserve failure */ }
    return Promise.reject(error);
  } finally {
    conn.release();
  }
}

function fail(error: string): { protocolVersion: number; error: string } {
  return { protocolVersion: 1, error };
}

interface ScopedReadQuotas {
  readonly maxSnapshotRecords: number;
  readonly maxSnapshotBytes: number;
}

/**
 * Called for each requested ID, on every snapshot and pull.
 * Missing/throwing policy fails closed; tenant-level auth is not an ACL.
 */
export type ScopedRecordAuthorizer = (
  connection: pg.PoolClient, identity: ProtocolIdentity, table: string, recordId: string,
) => Promise<boolean>;

async function authorizedRecords(
  connection: pg.PoolClient,
  identity: ProtocolIdentity,
  scope: FixedRecordIdScopeV1,
  authorizer?: ScopedRecordAuthorizer,
): Promise<boolean> {
  if (authorizer === undefined) return false;
  try {
    for (const id of scope.recordIds) {
      if (await authorizer(connection, identity, scope.table, id) !== true) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Must be called AFTER installSyncProtocol's /v1/sync auth middleware. */
export function installScopedReadRoutes(
  app: express.Express, pool: pg.Pool, quotas: ScopedReadQuotas,
  authorizeRecord?: ScopedRecordAuthorizer,
): void {
  app.post('/v1/sync/scopes/snapshot', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    const parsed = BaseRequest.safeParse(request.body);
    if (!parsed.success) return response.status(400).json(fail('INVALID_SCOPE'));
    // BaseRequest validates scope + duplicate IDs before this point.
    const scope = canonicalFixedScope(parsed.data.scope);
    const identity = response.locals.syncIdentity as ProtocolIdentity;
    const scopeToken = fixedScopeToken(scope, identity);
    try {
      const result = await withReadSnapshot(pool, async (conn) => {
        if (!await authorizedRecords(conn, identity, scope, authorizeRecord)) {
          return { status: 403, body: fail('SCOPE_FORBIDDEN') };
        }
        const state = await conn.query(
          'SELECT last_seq FROM syncer_protocol_state WHERE singleton = TRUE',
        );
        const summary = await conn.query(
          'SELECT COUNT(*)::BIGINT AS count, ' +
          'COALESCE(SUM(octet_length(record::text)), 0)::BIGINT AS bytes ' +
          'FROM syncer_protocol_records ' +
          'WHERE tenant_id = $1 AND table_name = $2 AND ' +
          'record_id = ANY($3::text[]) AND deleted_at IS NULL',
          [identity.tenantId, scope.table, scope.recordIds],
        );
        if (BigInt(summary.rows[0].count) > BigInt(quotas.maxSnapshotRecords) ||
            BigInt(summary.rows[0].bytes) > BigInt(quotas.maxSnapshotBytes)) {
          return { status: 413, body: fail('SNAPSHOT_QUOTA_EXCEEDED') };
        }
        const data = await conn.query(
          'SELECT record_id, revision, record FROM syncer_protocol_records ' +
          'WHERE tenant_id = $1 AND table_name = $2 AND ' +
          'record_id = ANY($3::text[]) AND deleted_at IS NULL ORDER BY record_id',
          [identity.tenantId, scope.table, scope.recordIds],
        );
        return {
          status: 200,
          body: {
            protocolVersion: 1,
            scopeKey: parsed.data.scopeKey,
            scopeToken,
            checkpoint: String(state.rows[0].last_seq),
            records: data.rows.map((row) => ({
              recordId: row.record_id,
              revision: String(row.revision),
              record: row.record,
            })),
          },
        };
      });
      return response.status(result.status).json(result.body);
    } catch {
      return response.status(500).json(fail('SCOPED_SNAPSHOT_FAILED'));
    }
  });

  app.post('/v1/sync/scopes/pull', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    const parsed = PullRequest.safeParse(request.body);
    if (!parsed.success) return response.status(400).json(fail('INVALID_SCOPE_PULL'));
    // PullRequest already validated the canonicalizable scope shape.
    const scope = canonicalFixedScope(parsed.data.scope);
    const identity = response.locals.syncIdentity as ProtocolIdentity;
    const expected = fixedScopeToken(scope, identity);
    const actual = parsed.data.scopeToken;
    if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'))) {
      return response.status(409).json(fail('SCOPE_CHANGED'));
    }
    const from = BigInt(parsed.data.checkpoint);
    const limit = parsed.data.limit ?? 100;
    try {
      const result = await withReadSnapshot(pool, async (conn) => {
        if (!await authorizedRecords(conn, identity, scope, authorizeRecord)) {
          return { status: 403, body: fail('SCOPE_FORBIDDEN') };
        }
        const state = await conn.query(
          'SELECT last_seq, min_available_seq FROM syncer_protocol_state WHERE singleton = TRUE',
        );
        const last = BigInt(state.rows[0].last_seq);
        const min = BigInt(state.rows[0].min_available_seq);
        if (from > last) return { status: 400, body: fail('CHECKPOINT_AHEAD') };
        if (from + 1n < min) {
          return {
            status: 409,
            body: {
              ...fail('RESET_REQUIRED'),
              resetRequired: true,
              minimumCheckpoint: (min - 1n).toString(),
              snapshotUrl: '/v1/sync/scopes/snapshot',
            },
          };
        }
        const data = await conn.query(
          'SELECT seq, record_id, operation, record, revision ' +
          'FROM syncer_protocol_changes WHERE seq > $1 AND seq <= $2 ' +
          'AND tenant_id = $3 AND table_name = $4 ' +
          'AND record_id = ANY($5::text[]) ORDER BY seq LIMIT $6',
          [from.toString(), last.toString(), identity.tenantId,
           scope.table, scope.recordIds, limit + 1],
        );
        const hasMore = data.rows.length > limit;
        const page = data.rows.slice(0, limit);
        const next = hasMore ? BigInt(page[page.length - 1].seq) : last;
        return {
          status: 200,
          body: {
            protocolVersion: 1,
            scopeKey: parsed.data.scopeKey,
            scopeToken: expected,
            fromCheckpoint: parsed.data.checkpoint,
            checkpoint: next.toString(),
            hasMore,
            changes: page.map((row) => ({
              checkpoint: String(row.seq),
              recordId: row.record_id,
              revision: String(row.revision),
              operation: row.operation,
              ...(row.operation === 'delete' ? {} : { record: row.record }),
            })),
          },
        };
      });
      return response.status(result.status).json(result.body);
    } catch {
      return response.status(500).json(fail('SCOPED_PULL_FAILED'));
    }
  });
}
