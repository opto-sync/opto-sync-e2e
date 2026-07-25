/**
 * In-cluster driver for the opto-sync remote browser suite.
 *
 * Runs as a Kubernetes Job next to the `dd-selenium-server` pods, because the
 * browser needs an HTTP origin it can actually reach: IndexedDB is unavailable
 * on the opaque origins of `file:` and `data:` URLs, and a page served from a
 * laptop is not reachable from inside the cluster. So this Job serves the page
 * on its own pod IP and points the remote browser at that.
 *
 * Zero dependencies on purpose — the W3C WebDriver protocol is plain
 * HTTP+JSON, so `fetch` is enough and the Job needs no npm install (and no
 * egress) to run.
 *
 * It talks to the grid's :4444 directly rather than the Java API on :8105,
 * because that API ships with SELENIUM_ALLOW_EVALUATE=false — arbitrary
 * in-page script execution is deliberately off in production manifests, and
 * collecting results from the page requires exactly that.
 *
 * Env:
 *   GRID_URL   http://<grid-pod-ip>:4444  (required)
 *   PAGE_DIR   directory holding index.html + suite.mjs + the bundle
 *   PORT       port to serve the page on (default 8080)
 *   TIMEOUT_MS overall budget for the in-page suite (default 120000)
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { networkInterfaces } from 'node:os';

const GRID_URL = process.env.GRID_URL;
const PAGE_DIR = process.env.PAGE_DIR || '/page';
const PORT = Number(process.env.PORT || 8080);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 120000);

if (!GRID_URL) {
  console.error('GRID_URL is required (e.g. http://10.244.0.183:4444)');
  process.exit(2);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
};

/** First non-loopback IPv4 — the address the remote browser must dial. */
function podIp() {
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  throw new Error('no non-loopback IPv4 address found');
}

function servePage() {
  const server = createServer(async (req, res) => {
    try {
      const rel = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
      const file = join(PAGE_DIR, rel === '/' || rel === '.' ? 'index.html' : rel);
      const info = await stat(file).catch(() => null);
      if (!info || !info.isFile()) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('not found');
      }
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': MIME[extname(file)] || 'application/octet-stream',
        'content-length': body.length,
        // Same-origin isolation headers are not needed: the suite uses no
        // SharedArrayBuffer, and requiring them would complicate the origin.
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(err));
    }
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(PORT, '0.0.0.0', () => resolve(server));
  });
}

async function wd(method, path, body) {
  const res = await fetch(`${GRID_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`WebDriver ${method} ${path} -> ${res.status}, non-JSON: ${text.slice(0, 400)}`);
  }
  if (!res.ok || json?.value?.error) {
    throw new Error(
      `WebDriver ${method} ${path} -> ${res.status} ${json?.value?.error ?? ''}: ${
        json?.value?.message ?? text.slice(0, 400)
      }`,
    );
  }
  return json.value;
}

async function waitForGrid() {
  const deadline = Date.now() + 60000;
  let last = 'never attempted';
  while (Date.now() < deadline) {
    try {
      const status = await wd('GET', '/status');
      if (status?.ready) return status;
      last = JSON.stringify(status).slice(0, 200);
    } catch (err) {
      last = err.message;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`grid at ${GRID_URL} never reported ready: ${last}`);
}

async function main() {
  const server = await servePage();
  const ip = podIp();
  const pageUrl = `http://${ip}:${PORT}/index.html`;
  console.log(`[runner] serving ${PAGE_DIR} at ${pageUrl}`);
  console.log(`[runner] grid ${GRID_URL}`);

  const status = await waitForGrid();
  console.log(`[runner] grid ready: ${JSON.stringify(status.nodes?.length ?? status).slice(0, 120)}`);

  let sessionId;
  try {
    const session = await wd('POST', '/session', {
      capabilities: {
        alwaysMatch: {
          browserName: 'chrome',
          'goog:chromeOptions': {
            // --no-sandbox: the grid container runs unprivileged with a
            // seccomp profile; Chrome's own sandbox cannot initialize there.
            args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'],
          },
        },
      },
    });
    sessionId = session.sessionId ?? session.capabilities?.sessionId;
    if (!sessionId) throw new Error(`no sessionId in ${JSON.stringify(session).slice(0, 300)}`);
    console.log(`[runner] session ${sessionId}`);

    await wd('POST', `/session/${sessionId}/timeouts`, { script: 30000, pageLoad: 60000 });
    await wd('POST', `/session/${sessionId}/url`, { url: pageUrl });

    // Poll for the suite's published result rather than sleeping a fixed time.
    const deadline = Date.now() + TIMEOUT_MS;
    let result = null;
    while (Date.now() < deadline) {
      result = await wd('POST', `/session/${sessionId}/execute/sync`, {
        script: 'return window.__OPTO_RESULT || null;',
        args: [],
      });
      if (result) break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    if (!result) {
      const title = await wd('GET', `/session/${sessionId}/title`).catch(() => '<unavailable>');
      const source = await wd('GET', `/session/${sessionId}/source`).catch(() => '');
      throw new Error(
        `suite never published a result within ${TIMEOUT_MS}ms (title=${title}); ` +
          `page start: ${String(source).slice(0, 300)}`,
      );
    }

    console.log(`\n[runner] browser: ${result.env?.userAgent ?? 'unknown'}`);
    console.log(`[runner] origin:  ${result.env?.origin ?? 'unknown'}\n`);
    for (const r of result.results ?? []) {
      console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : `\n       ${r.error}`}`);
    }
    if (result.fatal) console.log(`\nFATAL: ${result.fatal}`);
    console.log(`\n=== ${result.passed ?? 0} passed, ${result.failed ?? '?'} failed ===`);

    return result.ok ? 0 : 1;
  } finally {
    if (sessionId) await wd('DELETE', `/session/${sessionId}`).catch(() => {});
    server.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[runner] ERROR ${err.stack ?? err.message}`);
    process.exit(1);
  });
