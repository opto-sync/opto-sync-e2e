'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const playwrightModule = process.env.PLAYWRIGHT_MODULE;
assert.ok(playwrightModule, 'PLAYWRIGHT_MODULE is required');
const {chromium} = require(playwrightModule);
const mode = process.env.APP_MODE || 'http';
const requestedUrl = process.env.APP_URL || 'http://127.0.0.1:4173/';
const appRoot = path.resolve(process.env.APP_ROOT || '.');
const appPage = process.env.APP_PAGE || 'index.html';

async function openApplication() {
  if (mode !== 'extension') {
    const browser = await chromium.launch({headless: true});
    const context = await browser.newContext();
    const page = await context.newPage();
    return {browser, context, page, appUrl: requestedUrl, extension: false};
  }

  assert.ok(fs.existsSync(path.join(appRoot, 'manifest.json')), `manifest.json not found in ${appRoot}`);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opto-extension-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${appRoot}`,
      `--load-extension=${appRoot}`,
    ],
  });

  let worker = context.serviceWorkers()[0];
  let background = context.backgroundPages()[0];
  if (!worker && !background) {
    await Promise.race([
      context.waitForEvent('serviceworker').then((value) => { worker = value; }),
      context.waitForEvent('backgroundpage').then((value) => { background = value; }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('extension did not start a service worker/background page')), 20_000),
      ),
    ]);
  }
  const runtimeUrl = worker?.url() || background?.url();
  assert.ok(runtimeUrl?.startsWith('chrome-extension://'), `unexpected extension runtime URL: ${runtimeUrl}`);
  const extensionId = new URL(runtimeUrl).host;
  const page = await context.newPage();
  return {
    browser: null,
    context,
    page,
    appUrl: `chrome-extension://${extensionId}/${appPage}`,
    extension: true,
    userDataDir,
  };
}

(async () => {
  const target = await openApplication();
  const {browser, context, page, appUrl, extension} = target;
  const consoleErrors = [];
  const pageErrors = [];

  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  const response = await page.goto(appUrl, {waitUntil: 'domcontentloaded', timeout: 45_000});
  if (!extension) {
    assert.ok(response, `no navigation response for ${appUrl}`);
    assert.ok(response.status() < 400, `unexpected HTTP ${response.status()} for ${appUrl}`);
  }
  await page.waitForLoadState('networkidle', {timeout: 15_000}).catch(() => {});

  const shell = await page.evaluate(() => ({
    title: document.title,
    text: document.body?.innerText?.trim() ?? '',
    htmlLength: document.documentElement.outerHTML.length,
  }));
  assert.ok(shell.htmlLength > 80, 'application shell is unexpectedly empty');
  assert.ok(shell.title.length > 0 || shell.text.length > 0, 'application has neither a title nor visible text');

  const databaseName = `opto-real-app-${Date.now()}`;
  await page.evaluate(async (name) => {
    await new Promise((resolve, reject) => {
      const open = indexedDB.open(name, 1);
      open.onupgradeneeded = () => open.result.createObjectStore('records');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const database = open.result;
        const transaction = database.transaction('records', 'readwrite');
        transaction.objectStore('records').put({id: 'roundtrip', value: 'persisted-before-reload'}, 'roundtrip');
        transaction.oncomplete = () => { database.close(); resolve(); };
        transaction.onerror = () => reject(transaction.error);
      };
    });
  }, databaseName);

  await page.reload({waitUntil: 'domcontentloaded'});
  const persisted = await page.evaluate(async (name) => new Promise((resolve, reject) => {
    const open = indexedDB.open(name);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const database = open.result;
      const transaction = database.transaction('records', 'readonly');
      const get = transaction.objectStore('records').get('roundtrip');
      get.onsuccess = () => { database.close(); resolve(get.result); };
      get.onerror = () => reject(get.error);
    };
  }), databaseName);
  assert.equal(persisted.value, 'persisted-before-reload');

  const registrations = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return [];
    return (await navigator.serviceWorker.getRegistrations()).map((entry) => entry.scope);
  });
  if (extension || registrations.length > 0) {
    await page.waitForTimeout(750);
    await context.setOffline(true);
    await page.reload({waitUntil: 'domcontentloaded', timeout: 20_000});
    assert.equal(await page.locator('body').count(), 1, 'application did not restore an offline shell');
    await context.setOffline(false);
  }

  await page.evaluate(async (name) => new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  }), databaseName);

  const actionableConsoleErrors = consoleErrors.filter(
    (message) => !/favicon\.ico|Failed to load resource.*404|source map/i.test(message),
  );
  assert.deepEqual(pageErrors, [], `uncaught page errors:\n${pageErrors.join('\n')}`);
  assert.deepEqual(actionableConsoleErrors, [], `console errors:\n${actionableConsoleErrors.join('\n')}`);

  await context.close();
  if (browser) await browser.close();
  if (target.userDataDir) fs.rmSync(target.userDataDir, {recursive: true, force: true});
  process.stdout.write(JSON.stringify({
    appUrl,
    mode,
    title: shell.title,
    serviceWorkers: registrations.length,
    indexedDbRoundTrip: true,
    offlineReload: extension || registrations.length > 0,
  }, null, 2) + '\n');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
