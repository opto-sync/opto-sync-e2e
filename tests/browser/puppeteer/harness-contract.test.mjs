import test from 'node:test';

process.env.E2E_FRAMEWORK ||= 'puppeteer';
const { contractEnabled, runBrowserContract } = await import('../playwright/harness-contract.test.mjs');

test('puppeteer satisfies the browser harness contract', { skip: !contractEnabled, timeout: 45_000 }, () => runBrowserContract('puppeteer'));
