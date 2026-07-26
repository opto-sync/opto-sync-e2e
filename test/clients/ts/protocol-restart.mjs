/**
 * Real browser-process restart test.
 *
 * Chromium process 1 queues into native IndexedDB and commits to PostgreSQL,
 * then exits without acknowledging. Process 2 launches with the same browser
 * profile, reconstructs the exact SDK envelope from IndexedDB, receives the
 * durable duplicate result, and acknowledges. Process 3 proves that the local
 * acknowledgement itself survived another browser process boundary.
 */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

import { chromium } from '../../../../opto-sync-clients/clients/ts/node_modules/playwright/index.mjs';
import {
  bundleBrowserClient,
  serveBundle,
} from '../../../../opto-sync-clients/clients/ts/test/helpers/bundle.mjs';

const [profileArgument, recordId] = process.argv.slice(2);
if (!profileArgument || !recordId) {
  console.error('usage: node protocol-restart.mjs <browser-profile-dir> <record-id>');
  process.exit(2);
}

const profileDir = resolve(profileArgument);
const serverUrl = (
  process.env.OPTO_SYNC_SERVER_URL || 'http://localhost:3003'
).replace(/\/$/, '');
const databaseName = `opto-browser-restart-${recordId}`;
const HTML =
  '<!doctype html><meta charset="utf-8">' +
  '<title>opto-sync restart</title><script src="/opto-sync.browser.js"></script>';

await bundleBrowserClient();
const pageServer = await serveBundle(HTML);

async function launchPhase(run) {
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: true,
  });
  try {
    const pages = context.pages();
    const page = pages[0] ?? (await context.newPage());
    await page.goto(`${pageServer.origin}/`, { waitUntil: 'load' });
    return await run(page);
  } finally {
    await context.close();
  }
}

try {
  const firstState = await launchPhase((page) =>
    page.evaluate(
      async ({ databaseName: dbName, recordId: id, serverUrl: base }) => {
        const { initOptoSync, OptoSyncClient } = window.OptoSync;
        await initOptoSync();
        const client = new OptoSyncClient({ databaseName: dbName });
        await client.queueMutation(
          'docs',
          id,
          { title: 'indexeddb survived server-commit/client-ack restart' },
          { baseRevision: '0' },
        );
        const envelope = await client.protocolPushRequest();
        const response = await fetch(`${base}/v1/sync/push`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(envelope),
        });
        const result = await response.json();
        if (!response.ok || result.results?.[0]?.status !== 'applied') {
          throw new Error(`initial push failed: ${response.status} ${JSON.stringify(result)}`);
        }
        const pending = await client.pendingMutations();
        if (pending.length !== 1) {
          throw new Error(`prepare must leave one pending mutation, got ${pending.length}`);
        }

        const snapshotResponse = await fetch(`${base}/v1/sync/snapshot`);
        const snapshot = await snapshotResponse.json();
        if (!snapshotResponse.ok) {
          throw new Error(
            `snapshot failed: ${snapshotResponse.status} ${JSON.stringify(snapshot)}`,
          );
        }
        let interrupted = false;
        try {
          await client.installSnapshot(snapshot, async () => {
            localStorage.setItem('restart-authoritative', 'partial');
            throw new Error('injected snapshot replacement interruption');
          });
        } catch (error) {
          if (!String(error).includes('injected snapshot replacement interruption')) throw error;
          interrupted = true;
        }
        if (
          !interrupted ||
          (await client.pullCheckpoint()) !== '0' ||
          (await client.pendingMutations()).length !== 1
        ) {
          throw new Error('interrupted snapshot advanced checkpoint or changed pending work');
        }
        client.db.close();
        return { envelope, snapshot };
      },
      { databaseName, recordId, serverUrl },
    ),
  );
  console.log(
    'ok - [ts/restart prepare] Chromium committed without local ack; ' +
      'snapshot replacement interrupted',
  );

  await launchPhase((page) =>
    page.evaluate(
      async ({ databaseName: dbName, original, snapshot, serverUrl: base }) => {
        const { initOptoSync, OptoSyncClient } = window.OptoSync;
        await initOptoSync();
        const client = new OptoSyncClient({ databaseName: dbName });
        const pending = await client.pendingMutations();
        if (pending.length !== 1) {
          throw new Error(`restart recovered ${pending.length} pending mutations, expected 1`);
        }
        if (
          (await client.pullCheckpoint()) !== '0' ||
          localStorage.getItem('restart-authoritative') !== 'partial'
        ) {
          throw new Error('new Chromium process did not observe interrupted snapshot state');
        }
        await client.installSnapshot(snapshot, async (records) => {
          localStorage.setItem('restart-authoritative', JSON.stringify(records));
        });
        if (
          (await client.pullCheckpoint()) !== snapshot.checkpoint ||
          (await client.pendingMutations()).length !== 1 ||
          localStorage.getItem('restart-authoritative') === 'partial'
        ) {
          throw new Error('snapshot retry did not repair authoritative state');
        }
        const reconstructed = await client.protocolPushRequest();
        if (JSON.stringify(reconstructed) !== JSON.stringify(original)) {
          throw new Error(
            `envelope changed across browser restart: ` +
              `${JSON.stringify(original)} != ${JSON.stringify(reconstructed)}`,
          );
        }
        const response = await fetch(`${base}/v1/sync/push`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(reconstructed),
        });
        const result = await response.json();
        const mutation = result.results?.[0];
        if (
          !response.ok ||
          mutation?.status !== 'duplicate' ||
          mutation?.originalStatus !== 'applied'
        ) {
          throw new Error(`retry was not deduplicated: ${response.status} ${JSON.stringify(result)}`);
        }
        const acknowledged = await client.acknowledgePush(
          result,
          reconstructed,
        );
        if (acknowledged !== 1 || (await client.pendingMutations()).length !== 0) {
          throw new Error('recovered acknowledgement did not drain exactly one mutation');
        }
        client.db.close();
      },
      {
        databaseName,
        original: firstState.envelope,
        snapshot: firstState.snapshot,
        serverUrl,
      },
    ),
  );
  console.log(
    'ok - [ts/restart recover] snapshot repaired; ' +
      'identical retry deduplicated and acknowledged',
  );

  await launchPhase((page) =>
    page.evaluate(async ({ databaseName: dbName, snapshotCheckpoint }) => {
      const { initOptoSync, OptoSyncClient } = window.OptoSync;
      await initOptoSync();
      const client = new OptoSyncClient({ databaseName: dbName });
      const pending = await client.pendingMutations();
      if (pending.length !== 0) {
        throw new Error(`acknowledged mutation returned after second restart: ${pending.length}`);
      }
      if ((await client.pullCheckpoint()) !== snapshotCheckpoint) {
        throw new Error('installed snapshot checkpoint did not survive second restart');
      }
      const authoritative = localStorage.getItem('restart-authoritative');
      if (!authoritative || authoritative === 'partial' || !Array.isArray(JSON.parse(authoritative))) {
        throw new Error('repaired authoritative snapshot did not survive second restart');
      }
      await client.db.delete();
      localStorage.removeItem('restart-authoritative');
    }, { databaseName, snapshotCheckpoint: firstState.snapshot.checkpoint }),
  );
  console.log(
    'ok - [ts/restart verify] snapshot checkpoint and acknowledgement survived ' +
      'a second Chromium process',
  );
  assert.ok(firstState.envelope.clientId, 'SDK envelope did not contain a clientId');
} finally {
  await pageServer.close();
}
