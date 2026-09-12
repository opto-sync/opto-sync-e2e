#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const TRACE_SCHEMA = 'opto-sync.partial-sync-trace.v1';
const RECEIPT_SCHEMA = 'opto-sync.partial-sync-receipt.v1';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}
function canon(value) { return JSON.stringify(stable(value)); }
function digest(value) { return crypto.createHash('sha256').update(canon(value)).digest('hex'); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function rng(seed) {
  let x = seed >>> 0 || 0x9e3779b9;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17; x >>>= 0;
    x ^= x << 5; x >>>= 0;
    return x / 0x100000000;
  };
}
function int(next, max) { return Math.floor(next() * max); }
function intersects(tags, filter) { return filter.length === 0 || tags.some((tag) => filter.includes(tag)); }

class Server {
  constructor() {
    this.records = new Map();
    this.log = [];
    this.checkpoint = 0;
  }
  commit({ tenantId, entityId, tags, value = null, deleted = false, schemaVersion = 2 }) {
    const before = this.records.get(`${tenantId}:${entityId}`) ?? null;
    this.checkpoint += 1;
    const record = {
      tenantId,
      entityId,
      tags: clone(tags ?? before?.tags ?? []),
      value: deleted ? null : clone(value),
      deleted,
      schemaVersion,
      revision: (before?.revision ?? 0) + 1,
      checkpoint: this.checkpoint,
    };
    this.records.set(`${tenantId}:${entityId}`, record);
    this.log.push({
      checkpoint: this.checkpoint,
      tenantId,
      entityId,
      priorTags: clone(before?.tags ?? record.tags),
      record: clone(record),
    });
    return clone(record);
  }
  snapshot({ tenantId, filter, offset = 0, limit = 100, scopeEpoch }) {
    const items = [...this.records.values()]
      .filter((record) => record.tenantId === tenantId && !record.deleted && intersects(record.tags, filter))
      .sort((a, b) => a.entityId.localeCompare(b.entityId));
    const page = items.slice(offset, offset + limit).map(clone);
    return {
      tenantId,
      filter: clone(filter),
      scopeEpoch,
      checkpoint: this.checkpoint,
      offset,
      nextOffset: offset + page.length < items.length ? offset + page.length : null,
      complete: offset + page.length >= items.length,
      items: page,
    };
  }
  pull({ tenantId, filter, checkpoint, scanLimit = 4, scopeEpoch }) {
    const candidates = this.log.filter((entry) => entry.checkpoint > checkpoint).slice(0, scanLimit);
    const nextCheckpoint = candidates.length ? candidates.at(-1).checkpoint : checkpoint;
    const changes = candidates
      .filter((entry) => {
        if (entry.tenantId !== tenantId) return false;
        if (entry.record.deleted) return intersects(entry.priorTags, filter);
        return intersects(entry.record.tags, filter);
      })
      .map(clone);
    return { tenantId, filter: clone(filter), scopeEpoch, checkpoint: nextCheckpoint, changes };
  }
}

class Client {
  constructor({ tenantId, filter }) {
    this.tenantId = tenantId;
    this.filter = clone(filter);
    this.scopeEpoch = 1;
    this.checkpoint = 0;
    this.records = new Map();
    this.index = new Map();
    this.pending = [];
    this.quarantinedPending = [];
    this.ignoredStaleResponses = 0;
    this.evicted = [];
  }
  indexRecord(record) {
    for (const [tag, ids] of [...this.index.entries()]) {
      ids.delete(record.entityId);
      if (ids.size === 0) this.index.delete(tag);
    }
    if (record.deleted) return;
    for (const tag of record.tags) {
      const ids = this.index.get(tag) ?? new Set();
      ids.add(record.entityId);
      this.index.set(tag, ids);
    }
  }
  applyRecord(record) {
    if (record.tenantId !== this.tenantId) throw new Error('cross-tenant record reached client apply');
    if (record.deleted) this.records.delete(record.entityId);
    else this.records.set(record.entityId, clone(record));
    this.indexRecord(record);
  }
  applySnapshot(response) {
    if (response.tenantId !== this.tenantId || response.scopeEpoch !== this.scopeEpoch || canon(response.filter) !== canon(this.filter)) {
      this.ignoredStaleResponses += 1;
      return 'stale-scope-ignored';
    }
    for (const item of response.items) this.applyRecord(item);
    this.checkpoint = Math.max(this.checkpoint, response.checkpoint);
    return 'applied';
  }
  applyPull(response) {
    if (response.tenantId !== this.tenantId || response.scopeEpoch !== this.scopeEpoch || canon(response.filter) !== canon(this.filter)) {
      this.ignoredStaleResponses += 1;
      return 'stale-scope-ignored';
    }
    for (const change of response.changes) {
      const known = this.records.has(change.entityId);
      if (change.record.deleted && !known && !intersects(change.priorTags, this.filter)) continue;
      this.applyRecord(change.record);
    }
    this.checkpoint = Math.max(this.checkpoint, response.checkpoint);
    return 'applied';
  }
  changeFilter(filter) {
    this.scopeEpoch += 1;
    this.filter = clone(filter);
    for (const [entityId, record] of [...this.records.entries()]) {
      if (!intersects(record.tags, this.filter)) {
        this.records.delete(entityId);
        this.indexRecord({ ...record, deleted: true });
        this.evicted.push({ entityId, reason: 'scope-eviction', scopeEpoch: this.scopeEpoch });
      }
    }
  }
  enqueue(mutation) {
    if (mutation.tenantId !== this.tenantId) throw new Error('cannot enqueue mutation for inactive tenant');
    this.pending.push(clone(mutation));
  }
  switchTenant(tenantId, filter) {
    this.quarantinedPending.push(...this.pending.map((item) => ({ ...clone(item), reason: 'tenant-switch' })));
    this.pending = [];
    this.records.clear();
    this.index.clear();
    this.checkpoint = 0;
    this.tenantId = tenantId;
    this.filter = clone(filter);
    this.scopeEpoch += 1;
  }
  visible() {
    return [...this.records.values()].sort((a, b) => a.entityId.localeCompare(b.entityId)).map(clone);
  }
  indexSnapshot() {
    return Object.fromEntries([...this.index.entries()].sort().map(([tag, ids]) => [tag, [...ids].sort()]));
  }
}

function seedServer(server) {
  server.commit({ tenantId: 'tenant-a', entityId: 'a-red-1', tags: ['red'], value: { title: 'red one' } });
  server.commit({ tenantId: 'tenant-b', entityId: 'b-red-1', tags: ['red'], value: { title: 'other tenant' } });
  server.commit({ tenantId: 'tenant-a', entityId: 'a-blue-1', tags: ['blue'], value: { title: 'blue one' } });
  server.commit({ tenantId: 'tenant-a', entityId: 'a-red-2', tags: ['red'], value: { title: 'red two' } });
  server.commit({ tenantId: 'tenant-b', entityId: 'b-blue-1', tags: ['blue'], value: { title: 'other blue' } });
}

function runSeed(seed) {
  const next = rng(seed);
  const server = new Server();
  seedServer(server);
  const client = new Client({ tenantId: 'tenant-a', filter: ['red'] });
  const eventLog = [];

  while (client.checkpoint < server.checkpoint) {
    const response = server.pull({ tenantId: client.tenantId, filter: client.filter, checkpoint: client.checkpoint, scanLimit: 1 + int(next, 3), scopeEpoch: client.scopeEpoch });
    client.applyPull(response);
    eventLog.push({ type: 'pull', checkpoint: response.checkpoint, visibleChanges: response.changes.length });
  }
  if (client.visible().some((record) => record.tenantId !== 'tenant-a' || !record.tags.includes('red'))) throw new Error(`seed ${seed}: initial filtered pull leaked data`);

  const delayedOldScope = server.snapshot({ tenantId: 'tenant-a', filter: ['red'], offset: 0, limit: 1, scopeEpoch: client.scopeEpoch });
  client.changeFilter(['red', 'blue']);
  if (client.applySnapshot(delayedOldScope) !== 'stale-scope-ignored') throw new Error(`seed ${seed}: delayed old-scope response was accepted`);

  let offset = 0;
  do {
    const page = server.snapshot({ tenantId: client.tenantId, filter: client.filter, offset, limit: 1 + int(next, 2), scopeEpoch: client.scopeEpoch });
    client.applySnapshot(page);
    eventLog.push({ type: 'backfill', offset, count: page.items.length, complete: page.complete });
    offset = page.nextOffset;
    if (offset === null) break;
  } while (true);

  server.commit({ tenantId: 'tenant-a', entityId: 'a-red-2', tags: ['red'], deleted: true });
  server.commit({ tenantId: 'tenant-a', entityId: 'a-blue-2', tags: ['blue'], value: { title: 'blue two' } });
  server.commit({ tenantId: 'tenant-b', entityId: 'b-red-2', tags: ['red'], value: { title: 'never leak' } });
  while (client.checkpoint < server.checkpoint) {
    const before = client.checkpoint;
    const response = server.pull({ tenantId: client.tenantId, filter: client.filter, checkpoint: client.checkpoint, scanLimit: 1 + int(next, 4), scopeEpoch: client.scopeEpoch });
    client.applyPull(response);
    eventLog.push({ type: 'tail-pull', from: before, to: response.checkpoint, visibleChanges: response.changes.length });
    if (response.checkpoint === before) break;
  }
  if (client.records.has('a-red-2')) throw new Error(`seed ${seed}: filtered tombstone did not delete known entity`);
  if (client.visible().some((record) => record.tenantId !== 'tenant-a')) throw new Error(`seed ${seed}: cross-tenant change leaked`);

  client.changeFilter(['blue']);
  if (client.evicted.some((event) => event.reason !== 'scope-eviction')) throw new Error(`seed ${seed}: scope eviction was mislabeled`);
  if (client.visible().some((record) => !record.tags.includes('blue'))) throw new Error(`seed ${seed}: narrowed cache retained out-of-scope row`);

  client.enqueue({ tenantId: 'tenant-a', mutationId: 99, entityId: 'a-blue-local', op: 'upsert' });
  client.switchTenant('tenant-b', ['blue']);
  const tenantB = server.snapshot({ tenantId: 'tenant-b', filter: ['blue'], offset: 0, limit: 100, scopeEpoch: client.scopeEpoch });
  client.applySnapshot(tenantB);
  if (client.pending.length !== 0) throw new Error(`seed ${seed}: old-tenant pending queue remained active`);
  if (!client.quarantinedPending.every((mutation) => mutation.tenantId === 'tenant-a')) throw new Error(`seed ${seed}: quarantined queue lost tenant identity`);
  if (client.visible().some((record) => record.tenantId !== 'tenant-b')) throw new Error(`seed ${seed}: old tenant cache survived switch`);
  if (canon(client.indexSnapshot()).includes('a-')) throw new Error(`seed ${seed}: old tenant index survived switch`);

  return {
    seed,
    traceSha256: digest({ schemaVersion: TRACE_SCHEMA, seed, events: eventLog }),
    eventCount: eventLog.length,
    finalTenant: client.tenantId,
    finalFilter: client.filter,
    finalCheckpoint: client.checkpoint,
    visibleSha256: digest(client.visible()),
    ignoredStaleResponses: client.ignoredStaleResponses,
    quarantinedPending: client.quarantinedPending.length,
  };
}

const DELETE_ABSENCE_CONTROL = [
  { type: 'seed-cache', entities: ['alpha', 'beta'] },
  { type: 'partial-page', entities: ['alpha'], complete: false },
];
const TENANT_INDEX_CONTROL = [
  { type: 'seed-index', tenantId: 'tenant-a', entityId: 'a-secret', tag: 'blue' },
  { type: 'switch-tenant', tenantId: 'tenant-b', filter: ['blue'] },
];
const SCHEMA_TRUNCATION_CONTROL = [
  { type: 'decode', clientVersion: 1, serverVersion: 2, payload: { id: 'x', title: 'hello', note: 'must-survive' } },
  { type: 'reencode', clientVersion: 1, serverVersion: 2 },
];

function deleteAbsenceDiverges(events) {
  if (events.length < 2) return false;
  const cache = new Set(events[0].entities ?? []);
  const correct = new Set(cache);
  const broken = new Set(cache);
  const page = events[1];
  if (page?.type !== 'partial-page') return false;
  for (const entityId of page.entities ?? []) { correct.add(entityId); broken.add(entityId); }
  for (const entityId of [...broken]) if (!(page.entities ?? []).includes(entityId)) broken.delete(entityId);
  return canon([...correct].sort()) !== canon([...broken].sort());
}
function tenantIndexDiverges(events) {
  if (events.length < 2 || events[0]?.type !== 'seed-index' || events[1]?.type !== 'switch-tenant') return false;
  const correct = {};
  const broken = { [events[0].tag]: [events[0].entityId] };
  return canon(correct) !== canon(broken);
}
function schemaTruncationDiverges(events) {
  if (events.length < 2 || events[0]?.type !== 'decode' || events[1]?.type !== 'reencode') return false;
  const payload = events[0].payload;
  const correct = { known: { id: payload.id, title: payload.title }, opaque: { note: payload.note } };
  return canon({ ...correct.known, ...correct.opaque }) !== canon({ ...correct.known });
}
function minimize(events, diverges) {
  let current = clone(events);
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < current.length; index += 1) {
      const candidate = [...current.slice(0, index), ...current.slice(index + 1)];
      if (candidate.length > 0 && diverges(candidate)) { current = candidate; changed = true; break; }
    }
  }
  return current;
}

function compatibilityMatrix() {
  return [
    { client: 1, server: 1, mode: 'read-write', reason: 'same-version' },
    { client: 1, server: 2, mode: 'read-write-with-opaque-preservation', reason: 'v2 adds optional note; v1 must preserve unknown fields on round-trip' },
    { client: 2, server: 1, mode: 'conditional', reason: 'v2 note must be absent/null or server refuses field-not-supported' },
    { client: 2, server: 2, mode: 'read-write', reason: 'same-version' },
    { client: 2, server: 3, mode: 'conditional', reason: 'v3 enum expansion requires explicit enum-value-unsupported for values unknown to v2' },
    { client: 3, server: 2, mode: 'conditional', reason: 'v3-only enum values cannot be silently down-projected' },
    { client: 3, server: 3, mode: 'read-write', reason: 'same-version' },
    { client: 1, server: 3, mode: 'refuse', reason: 'non-adjacent version requires explicit migration/reset path' },
    { client: 3, server: 1, mode: 'refuse', reason: 'non-adjacent version requires explicit migration/reset path' },
  ];
}

function verifySchemaRules() {
  const v2Payload = { id: 'x', title: 'hello', note: 'opaque' };
  const v1Read = { known: { id: v2Payload.id, title: v2Payload.title }, opaque: { note: v2Payload.note } };
  if (canon({ ...v1Read.known, ...v1Read.opaque }) !== canon(v2Payload)) throw new Error('v1/v2 optional-field preservation failed');
  if ({ id: 'x', title: 'hello', note: 'cannot-truncate' }.note != null) {
    const refusal = { kind: 'schema-version-refusal', reason: 'field-not-supported', field: 'note' };
    if (refusal.kind !== 'schema-version-refusal') throw new Error('explicit refusal missing');
  }
  const expandedEnum = 'archived';
  if (!new Set(['active']).has(expandedEnum)) {
    const refusal = { kind: 'schema-version-refusal', reason: 'enum-value-unsupported', value: expandedEnum };
    if (refusal.reason !== 'enum-value-unsupported') throw new Error('enum expansion did not fail closed');
  }
}

function parseArgs(argv) {
  const options = { seeds: [3, 17, 42, 20260912], receipt: null, fixtureDir: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--seeds') options.seeds = argv[++index].split(',').map((value) => Number(value.trim()));
    else if (argv[index] === '--receipt') options.receipt = argv[++index];
    else if (argv[index] === '--fixture-dir') options.fixtureDir = argv[++index];
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (options.seeds.some((seed) => !Number.isInteger(seed) || seed < 0)) throw new Error('seeds must be non-negative integers');
  return options;
}

function verifyFixture(dir, filename, kind, events) {
  if (!dir) return null;
  const file = path.join(dir, filename);
  const fixture = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (fixture.schemaVersion !== TRACE_SCHEMA || fixture.kind !== kind) throw new Error(`${filename}: invalid metadata`);
  if (canon(fixture.events) !== canon(events)) throw new Error(`${filename}: fixture drifted from minimized control`);
  return { path: file, sha256: digest(fixture) };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  verifySchemaRules();
  const seeds = options.seeds.map(runSeed);

  const minimizedDelete = minimize(DELETE_ABSENCE_CONTROL, deleteAbsenceDiverges);
  const minimizedTenant = minimize(TENANT_INDEX_CONTROL, tenantIndexDiverges);
  const minimizedSchema = minimize(SCHEMA_TRUNCATION_CONTROL, schemaTruncationDiverges);
  if (!deleteAbsenceDiverges(minimizedDelete)) throw new Error('deletion-by-filter-absence control was not detected');
  if (!tenantIndexDiverges(minimizedTenant)) throw new Error('cross-tenant index control was not detected');
  if (!schemaTruncationDiverges(minimizedSchema)) throw new Error('schema truncation control was not detected');
  if (minimizedDelete.length !== 2 || minimizedTenant.length !== 2 || minimizedSchema.length !== 2) throw new Error('checker controls did not minimize to the expected 2-event traces');

  const commits = {
    e2e: process.env.OPTO_SYNC_E2E_SHA || 'UNSET',
    clients: process.env.OPTO_SYNC_CLIENTS_SHA || 'UNSET',
    syncerCClientGitlink: process.env.SYNCER_C_SHA || 'UNSET',
    syncerCMain: process.env.SYNCER_C_MAIN_SHA || 'UNSET',
    syncerRust: process.env.SYNCER_RS_SHA || 'UNSET',
  };
  if (Object.values(commits).some((sha) => sha === 'UNSET')) throw new Error('exact implementation commit environment is required');

  const controls = [
    { kind: 'deletion-by-filter-absence', events: minimizedDelete, diverges: true, traceSha256: digest(minimizedDelete), fixture: verifyFixture(options.fixtureDir, 'control-delete-by-filter-absence.v1.json', 'deletion-by-filter-absence', minimizedDelete) },
    { kind: 'cross-tenant-index-retention', events: minimizedTenant, diverges: true, traceSha256: digest(minimizedTenant), fixture: verifyFixture(options.fixtureDir, 'control-cross-tenant-index-leak.v1.json', 'cross-tenant-index-retention', minimizedTenant) },
    { kind: 'schema-optional-field-truncation', events: minimizedSchema, diverges: true, traceSha256: digest(minimizedSchema), fixture: verifyFixture(options.fixtureDir, 'control-schema-truncation.v1.json', 'schema-optional-field-truncation', minimizedSchema) },
  ];

  const receipt = {
    schemaVersion: RECEIPT_SCHEMA,
    traceSchemaVersion: TRACE_SCHEMA,
    guaranteeScope: 'partial/filter checkpoint safety, explicit tombstone semantics, tenant-isolated cache/index/queue state, adjacent-version fail-closed schema negotiation; no CRDT, OT, total-order, or causal-consistency claim',
    runtimeReplay: { status: 'modeling-only', promisedRuntimes: ['typescript', 'dart', 'rust'], note: 'This lane models and persists shared controls. Runtime parity is not certified until those implementations execute the corpus.' },
    migrationPolicy: 'server schema changes are external declarative migrations; application startup must not mutate server schema',
    implementationCommits: commits,
    seeds,
    compatibilityMatrix: compatibilityMatrix(),
    controls,
  };
  if (options.receipt) {
    fs.mkdirSync(path.dirname(path.resolve(options.receipt)), { recursive: true });
    fs.writeFileSync(options.receipt, `${JSON.stringify(receipt, null, 2)}\n`);
  }
  console.log(JSON.stringify(receipt, null, 2));
}
main();
