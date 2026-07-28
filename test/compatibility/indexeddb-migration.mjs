import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const e2eRoot = resolve(process.env.OPTO_SYNC_E2E_ROOT ?? process.cwd());
const clientsRoot = resolve(
  process.env.OPTO_SYNC_CLIENTS_ROOT ?? resolve(e2eRoot, '../opto-sync-clients'),
);
const fixturePath = resolve(
  e2eRoot,
  'compatibility/fixtures/current/indexeddb-v1.json',
);
const expectedPath = resolve(
  e2eRoot,
  'compatibility/fixtures/current/indexeddb-v2-expected.json',
);
const diagnosticsPath = resolve(
  process.env.INDEXEDDB_MIGRATION_DIAGNOSTICS ??
    join(tmpdir(), 'opto-sync-indexeddb-migration-diagnostics.json'),
);

const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
const expected = JSON.parse(readFileSync(expectedPath, 'utf8'));
const playwrightUrl = pathToFileURL(
  resolve(clientsRoot, 'clients/ts/node_modules/playwright/index.mjs'),
).href;
const helperUrl = pathToFileURL(
  resolve(clientsRoot, 'clients/ts/test/helpers/bundle.mjs'),
).href;
const { chromium } = await import(playwrightUrl);
const { serveBundle } = await import(helperUrl);

const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>opto-sync IndexedDB migration</title></head>
<body><script src="/opto-sync.browser.js"></script></body></html>`;

// Dexie stores schema version N as native IndexedDB version N * 10. Creating
// native versions 1 and 2 would make Dexie interpret them as pre-v1 databases
// and replay v1/v2 schema declarations, including recreating the meta store.
// Keep logical contract versions distinct while matching Dexie's native scale.
const NATIVE_INDEXEDDB_V1 = 10;
const NATIVE_INDEXEDDB_V2 = 20;
const NATIVE_INDEXEDDB_V3 = 30;

const profileDir = mkdtempSync(join(tmpdir(), 'opto-sync-indexeddb-profile-'));
const diagnostics = {
  schemaVersion: 1,
  fixture: fixture.databaseName,
  stages: {},
};
let context = null;
let server = null;

function fixtureRow(source) {
  const stores = Object.fromEntries(
    source.objectStores.map((store) => [store.name, store]),
  );
  const record = stores.records.rows[0];
  const mutation = stores.mutations.rows[0];
  return {
    id: 1,
    tableName: 'records',
    recordId: record.documentId,
    jsonPayload: JSON.stringify(record.payload),
    createdAt: Number(record.updatedAt),
    syncStatus: 0,
    clientId: 'fixture-device',
    mutationId: '1',
    fixtureMutationId: mutation.mutationId,
    operation: 'upsert',
    attempts: 0,
  };
}

async function openPage() {
  context = await chromium.launchPersistentContext(profileDir, { headless: true });
  const page = context.pages()[0] ?? (await context.newPage());
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`${server.origin}/`, { waitUntil: 'load' });
  const environment = await page.evaluate(() => ({
    origin: location.origin,
    indexedDbTag: Object.prototype.toString.call(indexedDB),
    hasProcess: typeof process !== 'undefined',
    exports: Object.keys(window.OptoSync ?? {}).sort(),
  }));
  assert.match(environment.origin, /^http:\/\/127\.0\.0\.1:/);
  assert.equal(environment.indexedDbTag, '[object IDBFactory]');
  assert.equal(environment.hasProcess, false);
  for (const name of ['OptoSyncClient', 'OptoSyncDatabase']) {
    assert.ok(environment.exports.includes(name), `${name} is missing from the browser bundle`);
  }
  return { page, errors };
}

try {
  server = await serveBundle(HTML);
  const row = fixtureRow(fixture);

  let opened = await openPage();
  const seed = await opened.page.evaluate(async ({ name, row, nativeVersion }) => {
    await new Promise((resolve) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    });
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(name, nativeVersion);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore('localMutations', {
          keyPath: 'id',
          autoIncrement: true,
        });
        store.createIndex('tableName', 'tableName');
        store.createIndex('recordId', 'recordId');
        store.createIndex('syncStatus', 'syncStatus');
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction('localMutations', 'readwrite');
        transaction.objectStore('localMutations').put(row);
        transaction.onerror = () => reject(transaction.error);
        transaction.oncomplete = () => {
          const nativeIndexedDbVersion = db.version;
          const stores = Array.from(db.objectStoreNames).sort();
          db.close();
          resolve({
            logicalStorageVersion: 1,
            nativeIndexedDbVersion,
            stores,
          });
        };
      };
    });
  }, {
    name: fixture.databaseName,
    row,
    nativeVersion: NATIVE_INDEXEDDB_V1,
  });
  diagnostics.stages.seed = seed;
  assert.deepEqual(seed, {
    logicalStorageVersion: 1,
    nativeIndexedDbVersion: NATIVE_INDEXEDDB_V1,
    stores: ['localMutations'],
  });

  const interrupted = await opened.page.evaluate(async ({ name, nativeVersion }) => {
    return new Promise((resolve) => {
      const request = indexedDB.open(name, nativeVersion);
      request.onupgradeneeded = () => {
        const transaction = request.transaction;
        const meta = request.result.createObjectStore('meta', { keyPath: 'key' });
        meta.put({ key: 'storage_version', value: '2' });
        meta.put({ key: 'migration_state', value: 'started' });
        transaction.abort();
      };
      request.onerror = () => {
        resolve({
          aborted: true,
          errorName: request.error?.name ?? 'unknown',
          targetNativeIndexedDbVersion: nativeVersion,
        });
      };
      request.onsuccess = () => {
        request.result.close();
        resolve({
          aborted: false,
          errorName: null,
          targetNativeIndexedDbVersion: nativeVersion,
        });
      };
    });
  }, {
    name: fixture.databaseName,
    nativeVersion: NATIVE_INDEXEDDB_V2,
  });
  diagnostics.stages.interrupted = interrupted;
  assert.deepEqual(interrupted, {
    aborted: true,
    errorName: 'AbortError',
    targetNativeIndexedDbVersion: NATIVE_INDEXEDDB_V2,
  });
  assert.deepEqual(opened.errors, []);

  await context.close();
  context = null;

  opened = await openPage();
  const reopened = await opened.page.evaluate(async (name) => {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction('localMutations', 'readonly');
        const all = transaction.objectStore('localMutations').getAll();
        all.onerror = () => reject(all.error);
        all.onsuccess = () => {
          const result = {
            nativeIndexedDbVersion: db.version,
            stores: Array.from(db.objectStoreNames).sort(),
            rows: all.result,
          };
          db.close();
          resolve(result);
        };
      };
    });
  }, fixture.databaseName);
  diagnostics.stages.reopenedAfterAbort = reopened;
  assert.equal(reopened.nativeIndexedDbVersion, NATIVE_INDEXEDDB_V1);
  assert.deepEqual(reopened.stores, ['localMutations']);
  assert.deepEqual(reopened.rows, [row]);

  const retried = await opened.page.evaluate(async ({ name, nativeVersion }) => {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(name, nativeVersion);
      request.onupgradeneeded = () => {
        const meta = request.result.createObjectStore('meta', { keyPath: 'key' });
        for (const entry of [
          ['storage_version', '2'],
          ['migration_state', 'complete'],
          ['hlc.nodeId', 'fixture-device'],
          ['mutation.seq', '1'],
          ['pull.checkpoint', '0'],
        ]) {
          meta.put({ key: entry[0], value: entry[1] });
        }
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const result = {
          logicalStorageVersion: 2,
          nativeIndexedDbVersion: request.result.version,
          stores: Array.from(request.result.objectStoreNames).sort(),
        };
        request.result.close();
        resolve(result);
      };
    });
  }, {
    name: fixture.databaseName,
    nativeVersion: NATIVE_INDEXEDDB_V2,
  });
  diagnostics.stages.retryToLogicalV2 = retried;
  assert.deepEqual(retried, {
    logicalStorageVersion: 2,
    nativeIndexedDbVersion: NATIVE_INDEXEDDB_V2,
    stores: ['localMutations', 'meta'],
  });

  const actual = await opened.page.evaluate(async ({ name, sourceMutationId }) => {
    const { OptoSyncDatabase, OptoSyncClient, SYNC_STATUS } = window.OptoSync;
    const database = new OptoSyncDatabase(name);
    await database.open();
    const implementationStorageVersion = database.verno;
    const nativeIndexedDbVersion = database.backendDB().version;
    const objectStores = database.tables.map((table) => table.name).sort();
    const mutationIdentityIndexPresent = database.localMutations.schema.indexes.some(
      (index) => index.name === '[tableName+recordId]' || index.src === '[tableName+recordId]',
    );
    database.close();

    const client = new OptoSyncClient({ databaseName: name, stampUpdatedAt: false });
    const durableClientId = await client.clientId();
    if (durableClientId !== 'fixture-device') {
      throw new Error(
        `durable client identity changed during migration: ${durableClientId}`,
      );
    }
    const pendingRows = await client.pendingMutations();
    const pendingBeforeAcknowledgement = pendingRows.map((mutation) => ({
      id: mutation.id,
      tableName: mutation.tableName,
      recordId: mutation.recordId,
      payload: JSON.parse(mutation.jsonPayload),
      syncStatus: mutation.syncStatus,
      clientId: mutation.clientId,
      mutationId: mutation.mutationId,
      fixtureMutationId: mutation.fixtureMutationId,
      operation: mutation.operation,
      attempts: mutation.attempts,
    }));
    const pushRequest = await client.protocolPushRequest();
    const duplicateAcknowledgement = {
      protocolVersion: 1,
      clientId: pushRequest.clientId,
      lastMutationId: '1',
      checkpoint: '1',
      results: [
        {
          mutationId: '1',
          status: 'duplicate',
          originalStatus: 'applied',
          checkpoint: '1',
        },
      ],
    };
    await client.setPullCheckpoint('1');
    const acknowledgedCount = await client.acknowledgePush(
      duplicateAcknowledgement,
      pushRequest,
    );
    const pendingAfterAcknowledgement = (await client.pendingMutations()).length;
    const stored = await client.db.localMutations.get(1);
    const checkpoint = await client.pullCheckpoint();
    const meta = Object.fromEntries(
      (await client.db.meta.toArray())
        .map((entry) => [entry.key, entry.value])
        .filter(([key]) => [
          'hlc.nodeId',
          'migration_state',
          'mutation.seq',
          'pull.checkpoint',
          'storage_version',
        ].includes(key))
        .sort(([a], [b]) => a.localeCompare(b)),
    );
    client.db.close();

    return {
      formatVersion: 1,
      databaseName: name,
      sourceMutationId,
      interruptedUpgrade: {
        rolledBack: true,
        logicalStorageVersion: 1,
        nativeIndexedDbVersion: 10,
        objectStores: ['localMutations'],
        pendingRows: 1,
        metaStorePresent: false,
      },
      recovered: {
        logicalStorageVersion: Number(meta.storage_version),
        implementationStorageVersion,
        nativeIndexedDbVersion,
        durableClientId,
        objectStores,
        mutationIdentityIndexPresent,
        pendingBeforeAcknowledgement,
        pushRequest,
        duplicateAcknowledgement,
        acknowledgedCount,
        pendingAfterAcknowledgement,
        storedSyncStatus: stored?.syncStatus ?? null,
        checkpoint,
        meta,
      },
    };
  }, {
    name: fixture.databaseName,
    sourceMutationId: fixture.objectStores.find((store) => store.name === 'mutations').rows[0].mutationId,
  });
  diagnostics.stages.actual = actual;
  assert.equal(actual.recovered.nativeIndexedDbVersion, NATIVE_INDEXEDDB_V3);
  assert.deepEqual(actual, expected);
  assert.deepEqual(opened.errors, []);

  writeFileSync(
    diagnosticsPath,
    JSON.stringify({ ...diagnostics, passed: true }, null, 2),
  );
  console.log(
    'IndexedDB migration certification passed: native 10→20 interruption rolled back, persistent-profile reopen preserved the logical-v1 queue, retry reached logical v2, Dexie upgraded 20→30 without replacing the durable client identity, and duplicate acknowledgement advanced checkpoint 1',
  );
} catch (error) {
  writeFileSync(
    diagnosticsPath,
    JSON.stringify(
      {
        ...diagnostics,
        passed: false,
        error: String(error?.stack || error),
        expected,
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  if (context) await context.close().catch(() => undefined);
  if (server) await server.close().catch(() => undefined);
  rmSync(profileDir, { recursive: true, force: true });
}
