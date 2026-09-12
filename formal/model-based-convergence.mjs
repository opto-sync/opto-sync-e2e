#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const SCHEMA_VERSION = 'opto-sync.model-trace.v1';
const RECEIPT_VERSION = 'opto-sync.model-convergence-receipt.v1';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function canon(value) {
  return JSON.stringify(stable(value));
}

function digest(value) {
  return crypto.createHash('sha256').update(canon(value)).digest('hex');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function rng(seed) {
  let x = seed >>> 0 || 0x9e3779b9;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x >>>= 0;
    x ^= x << 5;
    x >>>= 0;
    return x / 0x100000000;
  };
}

function int(next, max) {
  return Math.floor(next() * max);
}

function pick(next, values) {
  return values[int(next, values.length)];
}

function shuffle(next, values) {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = int(next, i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function hlc(ms, counter, node) {
  return `${String(ms).padStart(13, '0')}-${counter.toString(16).padStart(4, '0')}-${node}`;
}

function compareHlc(a, b) {
  return a === b ? 0 : (a < b ? -1 : 1);
}

function mutationContent(mutation) {
  const {
    clientId,
    mutationId,
    entityId,
    op,
    updatedAt,
    value = null,
    baseRevision = null,
  } = mutation;
  return { clientId, mutationId, entityId, op, updatedAt, value, baseRevision };
}

function mutationKey(mutation) {
  return `${mutation.clientId}:${mutation.mutationId}`;
}

class ServerModel {
  constructor({ dropTombstones = false } = {}) {
    this.dropTombstones = dropTombstones;
    this.records = new Map();
    this.ledger = new Map();
    this.watermarks = new Map();
    this.changes = [];
    this.checkpoint = 0;
  }

  push(mutation) {
    const currentMutation = clone(mutationContent(mutation));
    const key = mutationKey(currentMutation);
    const contentHash = digest(currentMutation);
    const prior = this.ledger.get(key);

    if (prior) {
      if (prior.contentHash !== contentHash) {
        return { kind: 'protocol-conflict', reason: 'mutation-content-reuse' };
      }
      return { ...clone(prior.outcome), duplicate: true };
    }

    const watermark = this.watermarks.get(currentMutation.clientId) ?? 0;
    if (currentMutation.mutationId !== watermark + 1) {
      return {
        kind: 'protocol-conflict',
        reason: 'mutation-gap',
        expectedMutationId: watermark + 1,
      };
    }

    const before = this.records.get(currentMutation.entityId) ?? null;
    let after = before ? clone(before) : null;
    let outcome = { kind: 'applied', effect: 'noop' };

    if (currentMutation.op === 'resurrect') {
      if (!before?.deleted || currentMutation.baseRevision !== before.revision) {
        outcome = { kind: 'rejected', reason: 'resurrection-base-mismatch' };
      } else {
        after = {
          entityId: currentMutation.entityId,
          deleted: false,
          updatedAt: currentMutation.updatedAt,
          value: clone(currentMutation.value),
          revision: before.revision + 1,
        };
        outcome = { kind: 'applied', effect: 'resurrected' };
      }
    } else if (currentMutation.op === 'delete') {
      if (!before || compareHlc(currentMutation.updatedAt, before.updatedAt) >= 0) {
        const revision = (before?.revision ?? 0) + 1;
        after = this.dropTombstones
          ? null
          : {
              entityId: currentMutation.entityId,
              deleted: true,
              updatedAt: currentMutation.updatedAt,
              value: null,
              revision,
            };
        outcome = { kind: 'applied', effect: 'deleted' };
      }
    } else if (currentMutation.op === 'upsert') {
      if (before?.deleted) {
        outcome = { kind: 'rejected', reason: 'explicit-resurrection-required' };
      } else if (!before || compareHlc(currentMutation.updatedAt, before.updatedAt) >= 0) {
        after = {
          entityId: currentMutation.entityId,
          deleted: false,
          updatedAt: currentMutation.updatedAt,
          value: clone(currentMutation.value),
          revision: (before?.revision ?? 0) + 1,
        };
        outcome = { kind: 'applied', effect: before ? 'updated' : 'created' };
      }
    } else {
      throw new Error(`unknown mutation op: ${currentMutation.op}`);
    }

    this.watermarks.set(currentMutation.clientId, currentMutation.mutationId);
    this.ledger.set(key, { contentHash, outcome: clone(outcome) });

    if (canon(before) !== canon(after)) {
      this.checkpoint += 1;
      if (after === null) this.records.delete(currentMutation.entityId);
      else this.records.set(currentMutation.entityId, after);
      this.changes.push({
        checkpoint: this.checkpoint,
        entityId: currentMutation.entityId,
        record: clone(after),
      });
    }

    return {
      ...clone(outcome),
      watermark: currentMutation.mutationId,
      checkpoint: this.checkpoint,
    };
  }

  snapshot() {
    return [...this.records.values()]
      .sort((a, b) => a.entityId.localeCompare(b.entityId))
      .map(clone);
  }
}

class ClientModel {
  constructor(clientId) {
    this.clientId = clientId;
    this.pending = [];
    this.authoritative = new Map();
    this.checkpoint = 0;
    this.nextMutationId = 1;
    this.durableRejections = [];
  }

  acknowledge(mutation, outcome) {
    if (!outcome || outcome.kind === 'protocol-conflict') return;
    const idx = this.pending.findIndex((item) => mutationKey(item) === mutationKey(mutation));
    if (idx >= 0) this.pending.splice(idx, 1);
    if (outcome.kind === 'rejected') {
      this.durableRejections.push({ key: mutationKey(mutation), reason: outcome.reason });
    }
  }

  pull(server) {
    for (const change of server.changes) {
      if (change.checkpoint <= this.checkpoint) continue;
      if (change.record === null) this.authoritative.delete(change.entityId);
      else this.authoritative.set(change.entityId, clone(change.record));
      this.checkpoint = change.checkpoint;
    }
  }

  visible() {
    const view = new Map(
      [...this.authoritative].map(([id, record]) => [id, clone(record)]),
    );
    for (const mutation of this.pending) {
      const current = view.get(mutation.entityId);
      if (mutation.op === 'delete') {
        view.set(mutation.entityId, {
          entityId: mutation.entityId,
          deleted: true,
          updatedAt: mutation.updatedAt,
          value: null,
          revision: current?.revision ?? 0,
        });
      }
      if (mutation.op === 'upsert') {
        view.set(mutation.entityId, {
          entityId: mutation.entityId,
          deleted: false,
          updatedAt: mutation.updatedAt,
          value: clone(mutation.value),
          revision: current?.revision ?? 0,
        });
      }
    }
    return [...view.values()].sort((a, b) => a.entityId.localeCompare(b.entityId));
  }
}

function generateLogicalMutations(seed) {
  const next = rng(seed);
  const clients = ['ts-a1b2c3', 'dart-d4e5f6', 'rust-102030'];
  const entities = ['alpha', 'beta', 'gamma', 'delta'];
  const counters = new Map(clients.map((id) => [id, 0]));
  const ids = new Map(clients.map((id) => [id, 1]));
  const nodeByClient = new Map(clients.map((id) => [id, id.slice(-6)]));
  const mutations = [];

  for (let index = 0; index < 24; index += 1) {
    const clientId = pick(next, clients);
    const entityId = pick(next, entities);
    const mutationId = ids.get(clientId);
    ids.set(clientId, mutationId + 1);
    const counter = counters.get(clientId);
    counters.set(clientId, counter + 1);
    const op = next() < 0.22 ? 'delete' : 'upsert';

    // The randomized convergence subset uses deletion timestamps above every
    // ordinary upsert. This is deliberate: the real protocol requires explicit
    // resurrection after a tombstone, so arbitrary delete/upsert races are not
    // order-independent and must not be mislabeled as convergence.
    const ms = 1_780_000_000_000
      + (op === 'delete' ? 10_000 : int(next, 7) * 100)
      + index;
    const updatedAt = hlc(ms, counter, nodeByClient.get(clientId));

    mutations.push({
      clientId,
      mutationId,
      entityId,
      op,
      updatedAt,
      ...(op === 'upsert'
        ? { value: { writer: clientId.split('-')[0], index, token: int(next, 1_000_000) } }
        : {}),
    });
  }
  return mutations;
}

function generateTransportTrace(seed, mutations) {
  const next = rng(seed ^ 0xa5a5a5a5);
  const events = [];
  const shuffled = shuffle(next, mutations);

  for (const mutation of shuffled) {
    if (next() < 0.18) events.push({ type: 'drop-request', mutation });
    events.push({ type: 'deliver', mutation, loseAck: next() < 0.25 });
    if (next() < 0.25) {
      events.push({ type: 'duplicate-delivery', mutation, loseAck: false });
    }
    if (next() < 0.10) events.push({ type: 'restart-client', clientId: mutation.clientId });
    if (next() < 0.06) events.push({ type: 'restart-server' });
    if (next() < 0.20) events.push({ type: 'pull-all' });
  }

  // Fairness tail: retry every immutable mutation in per-client order. Earlier
  // out-of-order deliveries may have hit the protocol gap guard; this tail is a
  // transport retry, not a change in application conflict semantics.
  for (const mutation of mutations.sort(
    (a, b) => a.clientId.localeCompare(b.clientId) || a.mutationId - b.mutationId,
  )) {
    events.push({ type: 'deliver', mutation, loseAck: false, fairnessRetry: true });
  }
  events.push({ type: 'pull-all', final: true });
  return events;
}

function executeTrace({ mutations, events, dropTombstones = false }) {
  const server = new ServerModel({ dropTombstones });
  const clients = new Map(
    ['ts-a1b2c3', 'dart-d4e5f6', 'rust-102030'].map((id) => [id, new ClientModel(id)]),
  );

  for (const mutation of mutations) {
    const client = clients.get(mutation.clientId);
    client.nextMutationId = Math.max(client.nextMutationId, mutation.mutationId + 1);
    client.pending.push(clone(mutation));
  }

  const outcomes = [];
  for (const [index, event] of events.entries()) {
    if (event.type === 'drop-request') {
      outcomes.push({
        index,
        type: event.type,
        key: mutationKey(event.mutation),
        outcome: 'transport-drop',
      });
      continue;
    }
    if (event.type === 'restart-client') {
      outcomes.push({
        index,
        type: event.type,
        clientId: event.clientId,
        outcome: 'durable-state-preserved',
      });
      continue;
    }
    if (event.type === 'restart-server') {
      outcomes.push({ index, type: event.type, outcome: 'durable-state-preserved' });
      continue;
    }
    if (event.type === 'pull-all') {
      for (const client of clients.values()) client.pull(server);
      outcomes.push({ index, type: event.type, checkpoint: server.checkpoint });
      continue;
    }
    if (event.type === 'deliver' || event.type === 'duplicate-delivery') {
      const outcome = server.push(event.mutation);
      if (!event.loseAck) {
        clients.get(event.mutation.clientId).acknowledge(event.mutation, outcome);
      }
      outcomes.push({
        index,
        type: event.type,
        key: mutationKey(event.mutation),
        loseAck: Boolean(event.loseAck),
        outcome,
      });
      continue;
    }
    throw new Error(`unknown event: ${event.type}`);
  }

  for (const client of clients.values()) client.pull(server);
  return {
    server: server.snapshot(),
    checkpoint: server.checkpoint,
    watermarks: Object.fromEntries([...server.watermarks.entries()].sort()),
    clientViews: Object.fromEntries(
      [...clients]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, client]) => [id, client.visible()]),
    ),
    pendingCounts: Object.fromEntries(
      [...clients]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, client]) => [id, client.pending.length]),
    ),
    durableRejections: Object.fromEntries(
      [...clients]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, client]) => [id, client.durableRejections]),
    ),
    outcomes,
  };
}

function referenceFinal(mutations) {
  // This reduced convergence model intentionally covers only ordinary
  // upsert/delete whole-entity resolution where any deletion is HLC-dominant.
  // It is not a CRDT, OT, causal-consistency, or field-level merge proof.
  const records = new Map();
  for (const mutation of mutations) {
    const current = records.get(mutation.entityId);
    if (current && compareHlc(mutation.updatedAt, current.updatedAt) < 0) continue;
    records.set(
      mutation.entityId,
      mutation.op === 'delete'
        ? {
            entityId: mutation.entityId,
            deleted: true,
            updatedAt: mutation.updatedAt,
            value: null,
          }
        : {
            entityId: mutation.entityId,
            deleted: false,
            updatedAt: mutation.updatedAt,
            value: clone(mutation.value),
          },
    );
  }
  return [...records.values()].sort((a, b) => a.entityId.localeCompare(b.entityId));
}

function semantic(records) {
  return records.map(({ revision: _revision, ...record }) => record);
}

function brokenControlTrace() {
  return [
    {
      clientId: 'ts-a1b2c3',
      mutationId: 1,
      entityId: 'zombie',
      op: 'upsert',
      updatedAt: hlc(1000, 0, 'a1b2c3'),
      value: { value: 'old' },
    },
    {
      clientId: 'ts-a1b2c3',
      mutationId: 2,
      entityId: 'zombie',
      op: 'delete',
      updatedAt: hlc(2000, 0, 'a1b2c3'),
    },
    {
      clientId: 'dart-d4e5f6',
      mutationId: 1,
      entityId: 'zombie',
      op: 'upsert',
      updatedAt: hlc(1000, 0, 'd4e5f6'),
      value: { value: 'stale-replay' },
    },
  ];
}

function directEvents(mutations) {
  return mutations
    .map((mutation) => ({ type: 'deliver', mutation, loseAck: false }))
    .concat({ type: 'pull-all', final: true });
}

function diverges(trace) {
  const good = semantic(
    executeTrace({ mutations: trace, events: directEvents(trace), dropTombstones: false }).server,
  );
  const broken = semantic(
    executeTrace({ mutations: trace, events: directEvents(trace), dropTombstones: true }).server,
  );
  return canon(good) !== canon(broken);
}

function minimize(trace) {
  let current = clone(trace);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < current.length; i += 1) {
      const candidate = [...current.slice(0, i), ...current.slice(i + 1)];
      if (candidate.length > 0 && diverges(candidate)) {
        current = candidate;
        changed = true;
        break;
      }
    }
  }
  return current;
}

function parseArgs(argv) {
  const options = {
    seeds: [1, 7, 42, 20260912],
    receipt: null,
    controlFixture: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--seeds') {
      options.seeds = argv[++i].split(',').map((seed) => Number(seed.trim()));
    } else if (argv[i] === '--receipt') {
      options.receipt = argv[++i];
    } else if (argv[i] === '--control-fixture') {
      options.controlFixture = argv[++i];
    } else {
      throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  if (options.seeds.some((seed) => !Number.isInteger(seed) || seed < 0)) {
    throw new Error('seeds must be non-negative integers');
  }
  return options;
}

function verifyControlFixture(fixturePath, minimized) {
  if (!fixturePath) return null;
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  if (fixture.schemaVersion !== SCHEMA_VERSION || fixture.kind !== 'checker-control') {
    throw new Error('control fixture metadata is invalid');
  }
  if (canon(fixture.events) !== canon(minimized)) {
    throw new Error('checked counterexample no longer matches the minimized checker-control trace');
  }
  return { path: fixturePath, sha256: digest(fixture) };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const results = [];

  for (const seed of options.seeds) {
    const mutations = generateLogicalMutations(seed);
    const events = generateTransportTrace(seed, clone(mutations));
    const observed = executeTrace({ mutations, events });
    const expected = referenceFinal(mutations);
    const actual = semantic(observed.server);

    if (canon(actual) !== canon(expected)) {
      throw new Error(
        `seed ${seed} diverged from reduced reference model\nexpected=${canon(expected)}\nactual=${canon(actual)}`,
      );
    }
    if (Object.values(observed.pendingCounts).some((count) => count !== 0)) {
      throw new Error(`seed ${seed} ended with pending mutations: ${canon(observed.pendingCounts)}`);
    }
    for (const [clientId, view] of Object.entries(observed.clientViews)) {
      if (canon(semantic(view)) !== canon(actual)) {
        throw new Error(`seed ${seed}: ${clientId} visible state did not converge after final pull`);
      }
    }

    results.push({
      seed,
      mutationCount: mutations.length,
      transportEventCount: events.length,
      traceSha256: digest({ schemaVersion: SCHEMA_VERSION, seed, mutations, events }),
      finalStateSha256: digest(actual),
      checkpoint: observed.checkpoint,
    });
  }

  const control = brokenControlTrace();
  if (!diverges(control)) {
    throw new Error('intentionally broken tombstone mutation was NOT detected');
  }
  const minimized = minimize(control);
  if (!diverges(minimized)) {
    throw new Error('minimized checker-control trace no longer fails');
  }
  const fixture = verifyControlFixture(options.controlFixture, minimized);

  const receipt = {
    schemaVersion: RECEIPT_VERSION,
    traceSchemaVersion: SCHEMA_VERSION,
    guaranteeScope:
      'reduced whole-entity HLC/LWW ordering + stable mutation identity + explicit tombstone replay; no CRDT, OT, field-level, or causal-consistency claim',
    transportVsApplicationSemantics: {
      transportRetry:
        'drop/lost acknowledgement keeps the same immutable mutation identity pending and retries it',
      protocolConflict:
        'mutation gaps or content reuse do not advance the durable mutation outcome',
      applicationConflict:
        'explicit resurrection-base mismatch is a durable rejection and is distinct from transport retry',
    },
    runtimeReplay: {
      status: 'modeling-only',
      promisedRuntimes: ['typescript', 'dart', 'rust'],
      note:
        'This lane emits deterministic traces and checker controls. Existing suite/clients remains the implementation replay gate; this receipt alone is not cross-runtime certification.',
    },
    implementationCommits: {
      e2e: process.env.OPTO_SYNC_E2E_SHA || 'UNSET',
      clients: process.env.OPTO_SYNC_CLIENTS_SHA || 'UNSET',
      syncerCClientGitlink: process.env.SYNCER_C_SHA || 'UNSET',
      syncerCMain: process.env.SYNCER_C_MAIN_SHA || 'UNSET',
      syncerRust: process.env.SYNCER_RS_SHA || 'UNSET',
    },
    seeds: results,
    checkerControl: {
      intentionallyBrokenMutation:
        'drop explicit tombstones and collapse durable deletion into absence',
      detected: true,
      originalEventCount: control.length,
      minimizedEventCount: minimized.length,
      minimizedTraceSha256: digest(minimized),
      events: minimized,
      fixture,
    },
  };

  if (Object.values(receipt.implementationCommits).some((sha) => sha === 'UNSET')) {
    throw new Error('exact implementation commit environment is required for durable receipt evidence');
  }

  if (options.receipt) {
    fs.mkdirSync(path.dirname(path.resolve(options.receipt)), { recursive: true });
    fs.writeFileSync(options.receipt, `${JSON.stringify(receipt, null, 2)}\n`);
  }
  console.log(JSON.stringify(receipt, null, 2));
}

main();
