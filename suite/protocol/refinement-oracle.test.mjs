import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPullIsolation, assertPushCorrelation, decimal } from './refinement-oracle.mjs';

const sent = { protocolVersion: 1, clientId: 'shared-client', mutations: [{ mutationId: '2' }] };
const reply = {
  status: 200,
  json: { protocolVersion: 1, clientId: 'shared-client', lastMutationId: '2', checkpoint: '3', results: [{ mutationId: '2', status: 'duplicate', originalStatus: 'applied' }] },
};
const page = {
  status: 200,
  json: { protocolVersion: 1, checkpoint: '4', hasMore: false, changes: [
    { checkpoint: '1', record: { tenant: 'tenant-a' } },
    { checkpoint: '3', record: { tenant: 'tenant-a' } },
  ] },
};

const rejects = (run, reason) => assert.throws(run, (error) => error.message.includes(reason));

test('accepts exactly correlated durable duplicate and scoped ordered page', () => {
  assert.equal(assertPushCorrelation(sent, reply, { status: 'duplicate', originalStatus: 'applied', checkpoint: '3' }), 3n);
  assert.equal(assertPullIsolation(page, { tenant: 'tenant-a', minimumChanges: 2 }), 4n);
});

test('rejects client and mutation ACK miscorrelation', () => {
  rejects(() => assertPushCorrelation(sent, { ...reply, json: { ...reply.json, clientId: 'tenant-b-client' } }, { status: 'duplicate' }), 'client ID miscorrelation');
  rejects(() => assertPushCorrelation(sent, { ...reply, json: { ...reply.json, results: [{ mutationId: '9', status: 'duplicate' }] } }, { status: 'duplicate' }), 'mutation ACK miscorrelation');
});

test('rejects phantom results, ledger mismatch, and fake duplicate outcome', () => {
  rejects(() => assertPushCorrelation(sent, { ...reply, json: { ...reply.json, results: [] } }), 'missing or extra ACK');
  rejects(() => assertPushCorrelation(sent, { ...reply, json: { ...reply.json, lastMutationId: '1' } }), 'ledger watermark miscorrelation');
  rejects(() => assertPushCorrelation(sent, { ...reply, json: { ...reply.json, results: [{ mutationId: '2', status: 'applied' }] } }, { status: 'duplicate' }), 'Expected values to be strictly equal:');
});

test('rejects replay that advances its committed checkpoint', () => {
  rejects(() => assertPushCorrelation(sent, { ...reply, json: { ...reply.json, checkpoint: '4' } }, { status: 'duplicate', checkpoint: '3' }), 'retry advanced checkpoint');
});

test('rejects cross-tenant leakage and a reordered page', () => {
  rejects(() => assertPullIsolation({ ...page, json: { ...page.json, changes: [{ checkpoint: '1', record: { tenant: 'tenant-b' } }] } }, { tenant: 'tenant-a' }), 'cross-tenant record disclosure');
  rejects(() => assertPullIsolation({ ...page, json: { ...page.json, changes: [page.json.changes[1], page.json.changes[0]] } }, { tenant: 'tenant-a' }), 'duplicate or reordered change');
});

test('rejects forward skips, page rollback, and empty hasMore pages', () => {
  rejects(() => assertPullIsolation({ ...page, json: { ...page.json, checkpoint: '2' } }, { tenant: 'tenant-a' }), 'page skipped past returned change');
  rejects(() => assertPullIsolation(page, { tenant: 'tenant-a', from: '5' }), 'page checkpoint regressed');
  rejects(() => assertPullIsolation({ ...page, json: { ...page.json, hasMore: true, changes: [] } }, { tenant: 'tenant-a', minimumChanges: 0 }), 'empty hasMore page');
});

test('requires lossless canonical decimal strings', () => {
  for (const value of ['01', '-1', '1.0', '1e3', 123, '']) {
    assert.throws(() => decimal(value, 'checkpoint'));
  }
  assert.equal(decimal('9007199254740993', 'checkpoint'), 9007199254740993n);
});
