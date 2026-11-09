import assert from 'node:assert/strict';
import { openDurableClient } from './durable-client.mjs';

// A separate OS process is launched for every phase by atto-journal-e2e.mjs.
// This exercises a real journal restart, not an in-memory re-instantiation.
const [phase, path] = process.argv.slice(2);
if (!phase || !path) throw Error('worker needs phase + journal path');
const tenant = 'atto-journal-tenant';
const clientId = 'atto-journal-client';
const client = await openDurableClient(path, { tenant, clientId });
const baseUrl = (process.env.BASE_URL || 'http://localhost:3003').replace(/\/$/, '');
const headers = {
  'content-type': 'application/json',
  'x-syncer-test-tenant': tenant,
  'x-syncer-test-subject': 'atto-journal-subject',
  'x-syncer-test-client-id': clientId,
};
const send = (failpoint) => async body => {
  const response = await fetch(`${baseUrl}/v1/sync/push`, {
    method: 'POST',
    headers: { ...headers, ...(failpoint ? { 'x-syncer-failpoint': failpoint } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
};
const log = result => console.log(JSON.stringify({ phase, result }));
switch (phase) {
  case 'stage-1':
  case 'stage-2':
  case 'stage-3': {
    const id = Number(phase.slice(-1));
    assert.equal(client.snapshot().lastAck, String(id - 1));
    const staged = await client.stage({ recordId: 'atto-journal-record', baseRevision: String(id - 1), payload: { tenant, value: `durable-${id}` } });
    assert.equal(staged.mutationId, String(id));
    log('STAGED');
    break;
  }
  case 'lose-response': {
    assert.equal(client.envelope().mutations[0].mutationId, '1');
    const result = await client.replay(send('after-commit-response-loss'));
    assert.equal(result.kind, 'unknown', 'server must commit then tear down the connection');
    assert.equal(client.snapshot().pending.mutationId, '1');
    log('UNKNOWN_COMMIT');
    break;
  }
  case 'recover-1':
  case 'recover-2': {
    const id = phase.slice(-1);
    assert.equal(client.snapshot().pending.mutationId, id);
    const result = await client.replay(send());
    assert.equal(result.kind, 'acknowledged');
    assert.equal(result.status, 'duplicate', 'lost or unpersisted ACK must replay to duplicate');
    assert.equal(client.snapshot().lastAck, id);
    log('DURABLE_DUPLICATE_ACK');
    break;
  }
  case 'ack-crash': {
    assert.equal(client.snapshot().pending.mutationId, '2');
    try {
      await client.replay(send(), { beforeAckPersist: () => { throw Error('INJECTED_ACK_PERSIST_CRASH'); } });
      throw Error('injection was not executed');
    } catch (error) {
      if (error.message !== 'INJECTED_ACK_PERSIST_CRASH') throw error;
      assert.equal(client.snapshot().lastAck, '1');
      log('INJECTED_ACK_PERSIST_CRASH');
      process.exitCode = 27;
    }
    break;
  }
  case 'forged-ack': {
    assert.equal(client.snapshot().pending.mutationId, '3');
    try {
      await client.replay(async envelope => ({ status: 200, json: {
        protocolVersion: 1, clientId: 'forged-client', lastMutationId: '3', checkpoint: '3',
        results: [{ mutationId: envelope.mutations[0].mutationId, status: 'applied' }],
      } }));
      throw Error('forged ACK was accepted');
    } catch (error) {
      assert.match(error.message, /client ID miscorrelation/);
      assert.equal(client.snapshot().pending.mutationId, '3');
      log('FORGED_ACK_REJECTED');
    }
    break;
  }
  case 'recover-3': {
    const result = await client.replay(send());
    assert.equal(result.kind, 'acknowledged');
    assert.equal(result.status, 'applied');
    log('REAL_ACK');
    break;
  }
  case 'verify':
    assert.equal(client.snapshot().lastAck, '3');
    assert.equal(client.snapshot().pending, null);
    log('JOURNAL_DRAINED');
    break;
  default:
    throw Error(`unsupported phase ${phase}`);
}
