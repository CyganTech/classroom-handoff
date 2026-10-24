import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';
const root = await mkdtemp(join(tmpdir(), 'handoff-managed-browser-'));
const extension = resolve('artifacts/managed-extension');
const release = JSON.parse(await readFile('site/release.json', 'utf8'));
const context = await chromium.launchPersistentContext(root, { channel: 'chromium', headless: true, ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}), args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`], viewport: { width: 1100, height: 900 } });
try {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  assert.equal(new URL(worker.url()).host, release.extensionId, 'Chrome derives the same stable ID as the signed release');
  const page = await context.newPage(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`chrome-extension://${release.extensionId}/options.html`);
  await page.locator('#managed-notice').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#backend-url').getAttribute('readonly'), '');
  assert.equal(await page.locator('#register-submit').isDisabled(), true);
  const state = await page.evaluate(async () => await chrome.runtime.sendMessage({ action: 'state' }));
  assert.equal(state.ok, true); assert.equal(state.state.managed, true); assert.equal(state.state.configured, false);
  assert.match(state.state.lastError, /administrator.*BackendUrl/);
  const manifest = await page.evaluate(() => chrome.runtime.getManifest());
  assert.equal(manifest.storage?.managed_schema, 'managed-schema.json'); assert.deepEqual(manifest.optional_host_permissions, []);
  assert.deepEqual(errors, []);
  await mkdir('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/managed-setup.png', fullPage: true });
  console.log('Managed browser smoke passed: Chrome-loaded schema, stable signed ID, locked server field, no registration before administrator policy, no runtime page errors.');
} finally { await context.close(); await rm(root, { recursive: true, force: true }); }
