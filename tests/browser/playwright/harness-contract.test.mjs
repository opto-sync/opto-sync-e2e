import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';

process.env.E2E_FRAMEWORK ||= 'playwright';

export const contractEnabled = process.env.E2E_BROWSER_CONTRACT === '1';

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "style-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>E2E Harness Contract</title></head><body><main><h1>Browser harness contract</h1><output id="state" aria-live="polite">booting</output><button id="increment" type="button">Increment</button><output id="count">0</output></main><script src="/app.js" defer></script></body></html>`;
const script = `(async()=>{const state=document.querySelector('#state');const count=document.querySelector('#count');const button=document.querySelector('#increment');const session=await fetch('/api/session',{cache:'no-store'}).then(r=>{if(!r.ok)throw new Error('session request failed: '+r.status);return r.json()});if(!session.cookieSeen)throw new Error('HttpOnly session cookie was not returned to the server');state.textContent='ready';button.addEventListener('click',()=>{count.textContent=String(Number(count.textContent)+1)})})().catch(error=>{document.querySelector('#state').textContent='error';console.error(error)});`;

function writeResponse(request, response, statusCode, headers, body = '') {
  response.statusCode = statusCode;
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  if (request.method === 'HEAD') response.end();
  else response.end(body);
}

async function startHarness() {
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');

    if (!['GET', 'HEAD'].includes(request.method ?? '')) {
      writeResponse(request, response, 405, {
        Allow: 'GET, HEAD',
        'Content-Type': 'text/plain; charset=utf-8',
      }, 'method not allowed');
      return;
    }

    let pathname;
    try {
      pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      writeResponse(request, response, 400, { 'Content-Type': 'text/plain; charset=utf-8' }, 'bad request');
      return;
    }

    if (pathname === '/') {
      writeResponse(request, response, 200, {
        'Content-Security-Policy': CSP,
        'Content-Type': 'text/html; charset=utf-8',
        'Set-Cookie': 'e2e_session=contract; HttpOnly; SameSite=Strict; Path=/',
      }, html);
    } else if (pathname === '/app.js') {
      writeResponse(request, response, 200, { 'Content-Type': 'text/javascript; charset=utf-8' }, script);
    } else if (pathname === '/api/session') {
      writeResponse(request, response, 200, { 'Content-Type': 'application/json; charset=utf-8' }, JSON.stringify({
        cookieSeen: String(request.headers.cookie ?? '').includes('e2e_session=contract'),
        requestId: 'browser-harness-contract',
      }));
    } else if (pathname === '/favicon.ico') {
      writeResponse(request, response, 204, {});
    } else if (pathname === '/healthz') {
      writeResponse(request, response, 200, { 'Content-Type': 'text/plain; charset=utf-8' }, 'ok');
    } else {
      writeResponse(request, response, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'not found');
    }
  });

  server.keepAliveTimeout = 1_000;
  server.headersTimeout = 2_000;
  server.requestTimeout = 5_000;

  await new Promise((resolve, reject) => {
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    server.once('listening', onListening);
    server.once('error', onError);
    server.listen(0, '127.0.0.1');
  });

  const address = server.address();
  assert(address && typeof address === 'object', 'harness did not expose a TCP address');

  return {
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      if (!server.listening) return;
      const forceClose = setTimeout(() => server.closeAllConnections?.(), 1_000);
      forceClose.unref();
      server.closeIdleConnections?.();
      try {
        await new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      } finally {
        clearTimeout(forceClose);
      }
    },
  };
}

async function artifactDirectory(framework) {
  const directory = path.join(process.cwd(), 'artifacts', framework);
  await mkdir(directory, { recursive: true });
  return directory;
}

async function writeArtifact(framework, name, value, encoding = 'utf8') {
  const directory = await artifactDirectory(framework);
  await writeFile(path.join(directory, name), value, encoding);
}

function assertErrors(errors) {
  assert.deepEqual(errors, [], `browser emitted errors:\n${errors.join('\n')}`);
}

function assertMainResponse(status, headers) {
  assert.equal(status, 200);
  assert.match(headers['content-security-policy'] ?? '', /default-src 'none'/);
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['cross-origin-opener-policy'], 'same-origin');
  assert.equal(headers['cross-origin-resource-policy'], 'same-origin');
  assert.match(headers['permissions-policy'] ?? '', /camera=\(\)/);
  assert.match(headers['set-cookie'] ?? '', /HttpOnly/i);
  assert.match(headers['set-cookie'] ?? '', /SameSite=Strict/i);
}

async function assertInPageBoundaries(evaluate) {
  const result = await evaluate(async () => {
    const health = await fetch('/healthz', { cache: 'no-store' });
    return {
      cookie: document.cookie,
      healthBody: await health.text(),
      healthStatus: health.status,
    };
  });
  if (result?.contractError) throw new Error(result.contractError);
  assert.deepEqual(result, {
    cookie: '',
    healthBody: 'ok',
    healthStatus: 200,
  });
}

async function capturePlaywright(page, errors) {
  await Promise.allSettled([
    page.screenshot({ path: path.join(await artifactDirectory('playwright'), 'harness-contract.png'), fullPage: true }),
    page.content().then((content) => writeArtifact('playwright', 'page.html', content)),
    writeArtifact('playwright', 'browser-errors.json', JSON.stringify(errors, null, 2)),
  ]);
}

async function runPlaywright(origin) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('console', (message) => message.type() === 'error' && errors.push(`console: ${message.text()}`));
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  try {
    const response = await page.goto(origin, { waitUntil: 'networkidle', timeout: 15_000 });
    assert(response, 'navigation did not return a response');
    assertMainResponse(response.status(), await response.allHeaders());
    await page.waitForFunction(() => document.querySelector('#state')?.textContent === 'ready');
    assert.equal(await page.title(), 'E2E Harness Contract');
    await page.click('#increment');
    await page.click('#increment');
    assert.equal(await page.textContent('#count'), '2');
    await assertInPageBoundaries((fn) => page.evaluate(fn));
    assertErrors(errors);
  } finally {
    await capturePlaywright(page, errors);
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function capturePuppeteer(page, errors) {
  await Promise.allSettled([
    page.screenshot({ path: path.join(await artifactDirectory('puppeteer'), 'harness-contract.png'), fullPage: true }),
    page.content().then((content) => writeArtifact('puppeteer', 'page.html', content)),
    writeArtifact('puppeteer', 'browser-errors.json', JSON.stringify(errors, null, 2)),
  ]);
}

async function runPuppeteer(origin) {
  const { default: puppeteer } = await import('puppeteer');
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  assert(executablePath, 'PUPPETEER_EXECUTABLE_PATH must identify the CI Chrome binary');
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  page.setDefaultNavigationTimeout(15_000);
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('console', (message) => message.type() === 'error' && errors.push(`console: ${message.text()}`));
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  try {
    const response = await page.goto(origin, { waitUntil: 'networkidle0' });
    assert(response, 'navigation did not return a response');
    assertMainResponse(response.status(), response.headers());
    await page.waitForFunction(() => document.querySelector('#state')?.textContent === 'ready');
    assert.equal(await page.title(), 'E2E Harness Contract');
    await page.click('#increment');
    await page.click('#increment');
    assert.equal(await page.$eval('#count', (element) => element.textContent), '2');
    await assertInPageBoundaries((fn) => page.evaluate(fn));
    assertErrors(errors);
  } finally {
    await capturePuppeteer(page, errors);
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function captureSelenium(driver, browserErrors) {
  const tasks = [
    driver.takeScreenshot().then((png) => writeArtifact('selenium', 'harness-contract.png', png, 'base64')),
    driver.getPageSource().then((source) => writeArtifact('selenium', 'page.html', source)),
    writeArtifact('selenium', 'browser-errors.json', JSON.stringify(browserErrors, null, 2)),
  ];
  await Promise.allSettled(tasks);
}

async function runSelenium(origin) {
  const [webdriver, chromeModule, loggingModule] = await Promise.all([
    import('selenium-webdriver'),
    import('selenium-webdriver/chrome.js'),
    import('selenium-webdriver/lib/logging.js'),
  ]);
  const { Builder, By, until } = webdriver;
  const chrome = chromeModule.default ?? chromeModule;
  const logging = loggingModule.default ?? loggingModule;
  const preferences = new logging.Preferences();
  preferences.setLevel(logging.Type.BROWSER, logging.Level.ALL);
  const options = new chrome.Options();
  options.addArguments('--headless=new', '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--window-size=1280,720');
  const driver = await new Builder()
    .forBrowser('chrome')
    .setLoggingPrefs(preferences)
    .setChromeOptions(options)
    .build();
  const browserErrors = [];
  let testError;
  try {
    await driver.manage().setTimeouts({ implicit: 0, pageLoad: 15_000, script: 15_000 });
    await driver.get(origin);
    const state = await driver.wait(until.elementLocated(By.id('state')), 10_000);
    await driver.wait(until.elementTextIs(state, 'ready'), 10_000);
    assert.equal(await driver.getTitle(), 'E2E Harness Contract');
    const increment = await driver.findElement(By.id('increment'));
    await increment.click();
    await increment.click();
    assert.equal(await driver.findElement(By.id('count')).getText(), '2');
    await assertInPageBoundaries((fn) => driver.executeAsyncScript(`
      const done = arguments[arguments.length - 1];
      (${fn.toString()})().then(done, (error) => done({ contractError: error.message }));
    `));
  } catch (error) {
    testError = error;
  } finally {
    const entries = await driver.manage().logs().get(logging.Type.BROWSER).catch((error) => {
      browserErrors.push(`webdriver-log: ${error.message}`);
      return [];
    });
    browserErrors.push(...entries
      .filter((entry) => entry.level.value >= logging.Level.SEVERE.value)
      .map((entry) => `${entry.level.name}: ${entry.message}`));
    await captureSelenium(driver, browserErrors);
    await driver.quit().catch(() => {});
  }
  if (testError) throw testError;
  assertErrors(browserErrors);
}

export async function runBrowserContract(framework) {
  const harness = await startHarness();
  try {
    if (framework === 'playwright') await runPlaywright(harness.origin);
    else if (framework === 'puppeteer') await runPuppeteer(harness.origin);
    else if (framework === 'selenium') await runSelenium(harness.origin);
    else throw new TypeError(`unsupported framework: ${framework}`);
  } finally {
    await harness.close();
  }
}

test('local harness enforces HTTP and security boundaries', {
  skip: process.env.E2E_FRAMEWORK !== 'playwright',
  timeout: 10_000,
}, async () => {
  const harness = await startHarness();
  try {
    const response = await fetch(harness.origin, { redirect: 'error' });
    const headers = Object.fromEntries(response.headers.entries());
    assertMainResponse(response.status, headers);
    assert.equal(await response.text(), html);

    const head = await fetch(harness.origin, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');

    const rejected = await fetch(`${harness.origin}/healthz`, { method: 'POST' });
    assert.equal(rejected.status, 405);
    assert.equal(rejected.headers.get('allow'), 'GET, HEAD');

    const missing = await fetch(`${harness.origin}/missing`);
    assert.equal(missing.status, 404);
  } finally {
    await harness.close();
  }
});

test('playwright satisfies the browser harness contract', {
  skip: !contractEnabled || process.env.E2E_FRAMEWORK !== 'playwright',
  timeout: 45_000,
}, () => runBrowserContract('playwright'));
