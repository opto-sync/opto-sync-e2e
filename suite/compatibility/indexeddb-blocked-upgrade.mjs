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
const diagnosticsPath = resolve(
  process.env.INDEXEDDB_BLOCKED_UPGRADE_DIAGNOSTICS ??
    join(tmpdir(), 'opto-sync-indexeddb-blocked-upgrade-diagnostics.json'),
);

const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
const playwrightUrl = pathToFileURL(
  resolve(clientsRoot, 'clients/ts/node_modules/playwright/index.mjs'),
).href;
const helperUrl = pathToFileURL(
  resolve(clientsRoot, 'clients/ts/test/helpers/bundle.mjs'),
).href;
const { chromium } = await import(playwrightUrl);
const { serveBundle } = await import(helperUrl);

const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>opto-sync blocked IndexedDB upgrade</title></head>
<body><script src="/opto-sync.browser.js"></script></body></html>`;

// Dexie logical versions are persisted as native IndexedDB versions * 10.
const NATIVE_INDEXEDDB_V1 = 10;
const NATIVE_INDEXEDDB_V2 = 20;
const NATIVE_INDEXEDDB_V3 = 30;

const profileDir = mkdtempSync(join(tmpdir(), 'opto-sync-indexeddb-multitab-'));
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
    clientId: 'fixturedevice',
    mutationId: '1',
    fixtureMutationId: mutation.mutationId,
    operation: 'upsert',
    attempts: 0,
  };
}

async function loadPage(page) {
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`${server.origin}/`, { waitUntil: 'load' });
  const environment = await page.evaluate(() => ({
    origin: location.origin,
    indexedDbTag: Object.prototype.toString.call(indexedDB),
    exports: Object.keys(window.OptoSync ?? {}).sort(),
  }));
  assert.match(environment.origin, /^http:\/\/127\.0\.0\.1:/);
  assert.equal(environment.indexedDbTag, '[object IDBFactory]');
  for (const name of ['OptoSyncClient', 'OptoSyncDatabase']) {
    assert.ok(environment.exports.includes(name), `${name} is missing from the browser bundle`);
  }
  return errors;
}

try {
  server = await serveBundle(HTML);
  context = await chromium.launchPersistentContext(profileDir, { headless: true });
  const pageA = context.pages()[0] ?? (await context.newPage());
  const pageB = await context.newPage();
  const errorsA = await loadPage(pageA);
  const errorsB = await loadPage(pageB);
  const row = fixtureRow(fixture);

  await pageA.evaluate(async ({ name, row, nativeVersion }) => {
    await new Promise((resolve) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    });

    await new Promise((resolve, reject) => {
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
          window.__optoBlockingDb = db;
          window.__optoVersionChangeSeen = false;
          db.onversionchange = () => {
            window.__optoVersionChangeSeen = true;
            // Deliberately keep the old tab open. The upgrade must report
            // `blocked` and wait rather than corrupting or bypassing it.
          };
          resolve();
        };
      };
    });
  }, {
    name: fixture.databaseName,
    row,
    nativeVersion: NATIVE_INDEXEDDB_V1,
  });

  await pageB.evaluate(({ name, nativeVersion }) => {
    window.__optoUpgradeState = {
      blocked: false,
      completed: false,
      errorName: null,
      nativeIndexedDbVersion: null,
      stores: [],
    };
    const request = indexedDB.open(name, nativeVersion);
    request.onblocked = () => {
      window.__optoUpgradeState.blocked = true;
    };
    request.onupgradeneeded = () => {
      const meta = request.result.createObjectStore('meta', { keyPath: 'key' });
      for (const [key, value] of [
        ['storage_version', '2'],
        ['migration_state', 'complete'],
        ['hlc.nodeId', 'fixturedevice'],
        ['mutation.seq', '1'],
        ['pull.checkpoint', '0'],
      ]) {
        meta.put({ key, value });
      }
    };
    request.onerror = () => {
      window.__optoUpgradeState.errorName = request.error?.name ?? 'unknown';
      window.__optoUpgradeState.completed = true;
    };
    request.onsuccess = () => {
      window.__optoUpgradeState.nativeIndexedDbVersion = request.result.version;
      window.__optoUpgradeState.stores = Array.from(request.result.objectStoreNames).sort();
      request.result.close();
      window.__optoUpgradeState.completed = true;
    };
  }, {
    name: fixture.databaseName,
    nativeVersion: NATIVE_INDEXEDDB_V2,
  });

  await pageB.waitForFunction(
    () => window.__optoUpgradeState?.blocked === true,
    null,
    { timeout: 5_000 },
  );
  await pageA.waitForFunction(
    () => window.__optoVersionChangeSeen === true,
    null,
    { timeout: 5_000 },
  );

  diagnostics.stages.blocked = {
    upgradeBlocked: await pageB.evaluate(() => window.__optoUpgradeState.blocked),
    versionChangeObservedByOldTab: await pageA.evaluate(
      () => window.__optoVersionChangeSeen,
    ),
  };
  assert.deepEqual(diagnostics.stages.blocked, {
    upgradeBlocked: true,
    versionChangeObservedByOldTab: true,
  });

  await pageA.evaluate(() => {
    window.__optoBlockingDb.close();
    window.__optoBlockingDb = null;
  });
  await pageB.waitForFunction(
    () => window.__optoUpgradeState?.completed === true,
    null,
    { timeout: 5_000 },
  );

  const upgraded = await pageB.evaluate(() => window.__optoUpgradeState);
  diagnostics.stages.upgradedAfterBlockerClosed = upgraded;
  assert.deepEqual(upgraded, {
    blocked: true,
    completed: true,
    errorName: null,
    nativeIndexedDbVersion: NATIVE_INDEXEDDB_V2,
    stores: ['localMutations', 'meta'],
  });
  assert.deepEqual(errorsA, []);
  assert.deepEqual(errorsB, []);

  await context.close();
  context = null;

  context = await chromium.launchPersistentContext(profileDir, { headless: true });
  const reopenedPage = context.pages()[0] ?? (await context.newPage());
  const reopenedErrors = await loadPage(reopenedPage);
  const recovered = await reopenedPage.evaluate(async ({ name, expectedRow }) => {
    const beforeProductOpen = await new Promise((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction('localMutations', 'readonly');
        const all = transaction.objectStore('localMutations').getAll();
        all.onerror = () => reject(all.error);
        all.onsuccess = () => {
          resolve({
            nativeIndexedDbVersion: db.version,
            stores: Array.from(db.objectStoreNames).sort(),
            rows: all.result,
          });
          db.close();
        };
      };
    });

    const { OptoSyncDatabase } = window.OptoSync;
    const database = new OptoSyncDatabase(name);
    await database.open();
    const afterProductOpen = {
      implementationStorageVersion: database.verno,
      nativeIndexedDbVersion: database.backendDB().version,
      stores: database.tables.map((table) => table.name).sort(),
      rows: await database.localMutations.toArray(),
    };
    database.close();

    return {
      beforeProductOpen,
      afterProductOpen,
      expectedRow,
    };
  }, {
    name: fixture.databaseName,
    expectedRow: row,
  });
  diagnostics.stages.reopened = recovered;

  assert.equal(recovered.beforeProductOpen.nativeIndexedDbVersion, NATIVE_INDEXEDDB_V2);
  assert.deepEqual(recovered.beforeProductOpen.stores, ['localMutations', 'meta']);
  assert.deepEqual(recovered.beforeProductOpen.rows, [row]);
  assert.equal(recovered.afterProductOpen.nativeIndexedDbVersion, NATIVE_INDEXEDDB_V3);
  assert.deepEqual(recovered.afterProductOpen.rows, [row]);
  assert.deepEqual(reopenedErrors, []);

  writeFileSync(
    diagnosticsPath,
    JSON.stringify({ ...diagnostics, passed: true }, null, 2),
  );
  console.log(
    'IndexedDB blocked-upgrade certification passed: the stale tab observed versionchange, the upgrading tab observed blocked, closing the stale connection released the upgrade, the durable queue survived persistent-profile reopen, and the current Opto Sync database opened it successfully',
  );
} catch (error) {
  writeFileSync(
    diagnosticsPath,
    JSON.stringify(
      {
        ...diagnostics,
        passed: false,
        error: String(error?.stack || error),
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
