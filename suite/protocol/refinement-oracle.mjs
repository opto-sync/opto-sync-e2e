import assert from 'node:assert/strict';

// Host-side contract assertions for observed HTTP replies. This is NOT an
// AttoLang compiler, typechecker, or substitute for its runtime execution.
const CANONICAL_DECIMAL = /^(0|[1-9][0-9]*)$/;

export function decimal(value, field) {
  assert.equal(typeof value, 'string', `${field} must remain a decimal string`);
  assert.match(value, CANONICAL_DECIMAL, `${field} must be canonical`);
  return BigInt(value);
}

export function assertPushCorrelation(sent, reply, options = {}) {
  const { status = 'applied', originalStatus, checkpoint } = options;
  assert.equal(sent.mutations?.length, 1, 'the oracle is limited to one mutation');
  assert.equal(reply.status, 200, 'push must succeed');
  assert.equal(reply.json?.protocolVersion, 1);
  assert.equal(reply.json?.clientId, sent.clientId, 'client ID miscorrelation');
  assert.equal(reply.json?.lastMutationId, sent.mutations[0].mutationId, 'ledger watermark miscorrelation');
  assert.equal(reply.json?.results?.length, 1, 'missing or extra ACK');
  const result = reply.json.results[0];
  assert.equal(result.mutationId, sent.mutations[0].mutationId, 'mutation ACK miscorrelation');
  assert.equal(result.status, status);
  if (originalStatus !== undefined) assert.equal(result.originalStatus, originalStatus);
  const actualCheckpoint = decimal(reply.json.checkpoint, 'push checkpoint');
  if (checkpoint !== undefined) {
    assert.equal(actualCheckpoint, decimal(checkpoint, 'expected checkpoint'), 'retry advanced checkpoint');
  }
  return actualCheckpoint;
}

export function assertPullIsolation(reply, { tenant, from = '0', minimumChanges = 1 }) {
  assert.equal(reply.status, 200);
  assert.equal(reply.json?.protocolVersion, 1);
  const checkpoint = decimal(reply.json.checkpoint, 'page checkpoint');
  let previous = decimal(from, 'requested checkpoint');
  assert.ok(checkpoint >= previous, 'page checkpoint regressed');
  assert.ok(Array.isArray(reply.json.changes), 'changes must be an array');
  assert.ok(reply.json.changes.length >= minimumChanges, 'missing expected changes');
  if (reply.json.hasMore) assert.ok(reply.json.changes.length > 0, 'empty hasMore page');
  for (const change of reply.json.changes) {
    const current = decimal(change.checkpoint, 'change checkpoint');
    assert.ok(current > previous, 'duplicate or reordered change');
    assert.ok(current <= checkpoint, 'page skipped past returned change');
    assert.equal(change.record?.tenant, tenant, 'cross-tenant record disclosure');
    previous = current;
  }
  return checkpoint;
}
