import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import type pg from 'pg';
import {
  canonicalFixedScope,
  fixedScopeToken,
  installScopedReadRoutes,
} from './scoped-reads.js';

const scope = { version: 1 as const, table: 'docs' as const, recordIds: ['b', 'a'] };
const identity = { tenantId: 'acme', subject: 'user-1', clientIds: null };

test('fixed scopes are canonical and bound to verified tenant/subject', () => {
  assert.deepEqual(canonicalFixedScope(scope).recordIds, ['a', 'b']);
  assert.equal(fixedScopeToken(scope, identity),
    fixedScopeToken({ version: 1, table: 'docs', recordIds: ['a', 'b'] }, identity));
  assert.notEqual(fixedScopeToken(scope, identity),
    fixedScopeToken(scope, { ...identity, tenantId: 'other' }));
  assert.notEqual(fixedScopeToken(scope, identity),
    fixedScopeToken(scope, { ...identity, subject: 'other' }));
  assert.throws(() => canonicalFixedScope({ version: 1, table: 'docs', recordIds: ['a', 'a'] }));
});

test('scoped snapshot and pull filter at SQL boundary and advance global checkpoint', async () => {
  const calls: { sql: string; params?: unknown[] }[] = [];
  let head = '1';
  const conn = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT last_seq, min_available_seq')) {
        return { rows: [{ last_seq: head, min_available_seq: '1' }] };
      }
      if (sql.startsWith('SELECT last_seq')) return { rows: [{ last_seq: head }] };
      if (sql.startsWith('SELECT COUNT')) return { rows: [{ count: '1', bytes: '50' }] };
      if (sql.startsWith('SELECT record_id')) return {
        rows: [{ record_id: 'a', revision: '1', record: { title: 'a' } }],
      };
      if (sql.startsWith('SELECT seq')) return {
        rows: [{ seq: '2', record_id: 'a', revision: '2',
          operation: 'upsert', record: { title: 'updated' } }],
      };
      return { rows: [] };
    },
    release() { /* no-op */ },
  };
  const pool = { connect: async () => conn } as unknown as pg.Pool;
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  // Emulates authenticated protocol middleware; production uses installSyncProtocol.
  app.use('/v1/sync', (_req, res, next) => {
    res.locals.syncIdentity = identity;
    next();
  });
  installScopedReadRoutes(app, pool, { maxSnapshotRecords: 128, maxSnapshotBytes: 1024 });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const running = app.listen(0, '127.0.0.1', () => resolve(running));
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = 'http://127.0.0.1:' + address.port;
    const post = async (path: string, data: object) => {
      const response = await fetch(origin + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(data),
      });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    const base = { protocolVersion: 1, scopeKey: 'client-session:shape-a-b', scope };
    const snapshot = await post('/v1/sync/scopes/snapshot', base);
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.body.checkpoint, '1');
    assert.equal(snapshot.body.scopeKey, base.scopeKey);
    assert.deepEqual((snapshot.body.records as unknown[]).length, 1);
    const token = snapshot.body.scopeToken;
    assert.equal(typeof token, 'string');

    head = '5';
    const pulled = await post('/v1/sync/scopes/pull', {
      ...base, checkpoint: '1', scopeToken: token, limit: 2,
    });
    assert.equal(pulled.status, 200);
    assert.equal(pulled.body.checkpoint, '5');
    assert.equal(pulled.body.fromCheckpoint, '1');
    assert.equal((pulled.body.changes as unknown[]).length, 1);
    const sql = calls.filter((call) => call.sql.startsWith('SELECT seq') ||
      call.sql.startsWith('SELECT record_id'));
    assert.ok(sql.length >= 2);
    for (const call of sql) {
      assert.match(call.sql, /tenant_id = \$[13]/);
      assert.match(call.sql, /record_id = ANY/);
      assert.ok(call.params?.some((v) => v === identity.tenantId));
      assert.ok(call.params?.some((v) => Array.isArray(v) && v.includes('a')));
    }
    const rotated = await post('/v1/sync/scopes/pull', {
      ...base, checkpoint: '1', scopeToken: 'f'.repeat(64),
    });
    assert.equal(rotated.status, 409);
    assert.equal(rotated.body.error, 'SCOPE_CHANGED');
    const malformed = await post('/v1/sync/scopes/snapshot', {
      ...base, scope: { ...scope, table: 'private_records' },
    });
    assert.equal(malformed.status, 400);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
