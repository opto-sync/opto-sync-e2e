import test from 'node:test';

process.env.E2E_FRAMEWORK ||= 'playwright';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

export const contractEnabled = process.env.E2E_BROWSER_CONTRACT === '1';

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>E2E Harness Contract</title></head><body><main><h1>Browser harness contract</h1><output id="state" aria-live="polite">booting</output><button id="increment" type="button">Increment</button><output id="count">0</output></main><script src="/app.js" defer></script></body></html>`;
const script = `(async()=>{const state=document.querySelector('#state');const count=document.querySelector('#count');const button=document.querySelector('#increment');const session=await fetch('/api/session',{cache:'no-store'}).then(r=>{if(!r.ok)throw new Error('session request failed: '+r.status);return r.json()});if(!session.cookieSeen)throw new Error('HttpOnly session cookie was not returned to the server');state.textContent='ready';button.addEventListener('click',()=>{count.textContent=String(Number(count.textContent)+1)})})().catch(error=>{document.querySelector('#state').textContent='error';console.error(error)});`;

async function startHarness() {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    if (pathname === '/') {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        'Set-Cookie': 'e2e_session=contract; HttpOnly; SameSite=Strict; Path=/',
      });
      response.end(html);
    } else if (pathname === '/app.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      response.end(script);
    } else if (pathname === '/api/session') {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ cookieSeen: String(request.headers.cookie ?? '').includes('e2e_session=contract') }));
    } else if (pathname === '/healthz') {
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('ok');
    } else {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('not found');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function artifactPath(framework) {
  const directory = path.join(process.cwd(), 'artifacts', framework);
  await mkdir(directory, { recursive: true });
  return path.join(directory, 'harness-contract.png');
}

function assertErrors(errors) {
  assert.deepEqual(errors, [], `browser emitted errors:\n${errors.join('\n')}`);
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
    assert.equal(response?.status(), 200);
    await page.waitForFunction(() => document.querySelector('#state')?.textContent === 'ready');
    assert.equal(await page.title(), 'E2E Harness Contract');
    await page.click('#increment'); await page.click('#increment');
    assert.equal(await page.textContent('#count'), '2');
    assert.equal(await page.evaluate(() => document.cookie), '');
    assert.equal(await page.evaluate(() => fetch('/healthz').then((result) => result.text())), 'ok');
    await page.screenshot({ path: await artifactPath('playwright'), fullPage: true });
    assertErrors(errors);
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function runPuppeteer(origin) {
  const { default: puppeteer } = await import('puppeteer');
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('console', (message) => message.type() === 'error' && errors.push(`console: ${message.text()}`));
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  try {
    const response = await page.goto(origin, { waitUntil: 'networkidle0' });
    assert.equal(response?.status(), 200);
    await page.waitForFunction(() => document.querySelector('#state')?.textContent === 'ready');
    assert.equal(await page.title(), 'E2E Harness Contract');
    await page.click('#increment'); await page.click('#increment');
    assert.equal(await page.$eval('#count', (element) => element.textContent), '2');
    assert.equal(await page.evaluate(() => document.cookie), '');
    assert.equal(await page.evaluate(() => fetch('/healthz').then((result) => result.text())), 'ok');
    await page.screenshot({ path: await artifactPath('puppeteer'), fullPage: true });
    assertErrors(errors);
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function runSelenium(origin) {
  const [{ Builder, By, until }, { default: chrome }] = await Promise.all([
    import('selenium-webdriver'),
    import('selenium-webdriver/chrome.js'),
  ]);
  const options = new chrome.Options();
  options.addArguments('--headless=new', '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--window-size=1280,720');
  const driver = await new Builder().forBrowser('chrome').setChromeOptions(options).build();
  try {
    await driver.manage().setTimeouts({ implicit: 0, pageLoad: 15_000, script: 15_000 });
    await driver.get(origin);
    const state = await driver.wait(until.elementLocated(By.id('state')), 10_000);
    await driver.wait(until.elementTextIs(state, 'ready'), 10_000);
    assert.equal(await driver.getTitle(), 'E2E Harness Contract');
    const increment = await driver.findElement(By.id('increment'));
    await increment.click(); await increment.click();
    assert.equal(await driver.findElement(By.id('count')).getText(), '2');
    assert.equal(await driver.executeScript('return document.cookie'), '');
    const health = await driver.executeAsyncScript("const done=arguments[arguments.length-1];fetch('/healthz').then(r=>r.text()).then(done,e=>done('ERROR:'+e.message));");
    assert.equal(health, 'ok');
    await writeFile(await artifactPath('selenium'), await driver.takeScreenshot(), 'base64');
  } finally {
    await driver.quit().catch(() => {});
  }
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

test(
  'playwright satisfies the browser harness contract',
  { skip: !contractEnabled || process.env.E2E_FRAMEWORK !== 'playwright', timeout: 45_000 },
  () => runBrowserContract('playwright'),
);
