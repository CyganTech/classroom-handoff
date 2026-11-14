/** Real administrator UI + sessions + SQLite reporting. Fixtures stay in a disposable database. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { createApp } from '../server/app.js';
import { analyticsDate } from '../server/analytics-store.js';
const root = await mkdtemp(join(tmpdir(), 'handoff-analytics-browser-'));
const evidence = resolve('test-results'); await mkdir(evidence, { recursive: true });
let now = Date.now() - 30 * 86400000;
const key = 'disposable-test-admin-key-' + randomUUID();
const app = createApp({ dataDir: root, analyticsAdminKey: key, analyticsEnabled: true, now: () => now });
const address = await app.listen(0); app.config.publicUrl = address.url;
const a = app.store.register('Chromebook · 7K2M'); const b = app.store.register('<img src=x onerror=alert(1)>');
const canary = 'https://example.org/analytics-private-canary?secret=never-export';
const workspace = { version: 1 as const, tabs: [{ url: canary, pinned: false, active: true, groupId: null }], groups: [] };
for (let i = 0; i < 30; i++) {
  now += 86400000;
  const c = app.store.createCommand(a.deviceId, b.deviceId, randomUUID(), workspace, 'hash', now, now + 120000, { mode: i % 2 ? 'current-tab' : 'whole-window', version: '0.2.4', platform: 'cros' });
  app.store.complete(c.id, i % 9 === 0 ? 'failed' : 'applied', now + 1200 + i * 10, null, []);
}
now = Date.now();
const browser = await chromium.launch({ channel: 'chromium', ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}) });
try {
  const context = await browser.newContext({ viewport: { width: 1488, height: 1058 } }); const page = await context.newPage(); const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(address.url + '/admin/analytics');
  await page.locator('#login').waitFor({ state: 'visible' });
  // A 401 on initial session discovery is expected; retain all other browser errors.
  errors.length = 0;
  await page.locator('#admin-key').fill(key); await page.locator('#login-button').click();
  await page.locator('#dashboard').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#handoffs')?.textContent !== '—');
  assert.equal(await page.locator('#admin-key').inputValue(), '');
  assert.ok(Number((await page.locator('#handoffs').innerText()).replaceAll(',', '')) > 0);
  assert.ok((await page.locator('#browser-rows').innerText()).includes('<img src=x onerror=alert(1)>'));
  assert.equal(await page.locator('#browser-rows img').count(), 0);
  const cookies = await context.cookies(); assert.ok(cookies.some(c => c.name === 'handoff_admin_session' && c.httpOnly && c.sameSite === 'Strict'));
  assert.equal((await page.evaluate(() => JSON.stringify(localStorage))).includes(key), false);
  for (const theme of ['light', 'dark']) {
    await page.locator('#theme').selectOption(theme);
    await page.screenshot({ path: join(evidence, `analytics-${theme}.png`), fullPage: true });
  }
  await page.locator('#export-report').selectOption('browsers');
  const download = page.waitForEvent('download'); await page.locator('#export').click();
  const file = await download; const location = await file.path(); assert.ok(location);
  const csv = await readFile(location, 'utf8'); assert.equal(csv.includes(canary), false); assert.equal(csv.includes(a.token), false);
  await page.locator('#browser-search').fill('Chromebook'); assert.equal(await page.locator('#browser-rows tr').count(), 1);
  const filteredDownload = page.waitForEvent('download'); await page.locator('#export').click();
  const filteredFile = await filteredDownload; const filteredPath = await filteredFile.path(); assert.ok(filteredPath);
  const filteredCsv = await readFile(filteredPath, 'utf8'); assert.ok(filteredCsv.includes('Chromebook')); assert.equal(filteredCsv.includes('<img'), false);
  await page.locator('#range').selectOption('custom'); await page.locator('#from').fill(analyticsDate(now)); await page.locator('#to').fill(analyticsDate(now));
  await page.locator('#custom-range button').click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(evidence, 'analytics-mobile.png'), fullPage: true });
  await page.locator('#sign-out').click(); await page.locator('#login').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#browser-rows').textContent(), '', 'sign-out clears previously rendered data');
  const unauthorized = await context.request.get(address.url + '/api/admin/analytics'); assert.equal(unauthorized.status(), 401);
  assert.deepEqual(errors, [], 'No real dashboard CSP/runtime/resource errors');
  console.log('PASS real analytics dashboard: cookie login/logout, real reports/CSV, safe names, both themes, mobile fit, no secret persistence or browser errors');
} finally { await browser.close(); await app.close(); await rm(root, { recursive: true, force: true }); }
