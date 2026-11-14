/** Dashboard UI integration with deterministic API fixtures; no production sample data.
 * Browser plugin not available. Run after build:server with the installed Playwright
 * browser, or set CHROMIUM_EXECUTABLE_PATH to an existing Chromium executable.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';

const evidence = process.env.ADMIN_EVIDENCE_DIR ?? join(tmpdir(), 'classroom-handoff-admin-qa');
await mkdir(evidence, { recursive: true });
let authenticated = false, empty = false, unavailable = false;
let lastQuery = null, lastExport = null;
const calls = [];
const now = Date.now();
const fixture = {
  timezone: 'America/Chicago', enabled: true, startedAt: now - 86400000 * 60, generatedAt: now,
  summary: { handoffs: 248, applied: 239, failed: 4, expired: 5, pending: 0, successRate: 239 / 248, activeBrowsers: 61, tabs: 730, medianConfirmationMs: 1200, p95ConfirmationMs: 3100, captureFailures: 2, sendFailures: 3, rejectedRequests: 1 },
  modes: { wholeWindow: 171, currentTab: 72, unknown: 5 }, pairings: { easyPair: 8, code: 4 },
  browsers: Array.from({ length: 61 }, (_, index) => ({ id: `browser-${index}`, name: index === 60 ? '<img src=x onerror="window.injected=true">' : `Classroom ${String(index + 1).padStart(2, '0')}`, platform: index % 2 ? 'win' : 'cros', version: '0.2.4', sent: 84, received: 81, applied: 79, failed: 1, expired: 1, pending: 0, lastActivity: index === 0 ? 0 : now - index * 60000 }))
};
const staticAssets = new Map([['/admin/analytics', ['index.html', 'text/html']], ['/admin/assets/admin.js', ['admin.js', 'text/javascript']], ['/admin/assets/admin.css', ['admin.css', 'text/css']], ['/admin/assets/logo.svg', ['logo.svg', 'image/svg+xml']]]);
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  calls.push(url.href);
  const json = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
  if (staticAssets.has(url.pathname)) {
    const [name, type] = staticAssets.get(url.pathname);
    response.writeHead(200, { 'Content-Type': type }); response.end(await readFile(resolve('dist/server/admin', name))); return;
  }
  if (url.pathname === '/api/admin/login') {
    let body = ''; for await (const part of request) body += part;
    authenticated = JSON.parse(body).key === 'test-administrator-key';
    json(authenticated ? 200 : 401, { ok: authenticated }); return;
  }
  if (url.pathname === '/api/admin/logout') { authenticated = false; json(200, { ok: true }); return; }
  if (url.pathname === '/api/admin/analytics' || url.pathname === '/api/admin/analytics.csv') {
    if (!authenticated) { json(401, { error: 'unauthorized' }); return; }
    if (unavailable) { json(503, { error: 'unavailable' }); return; }
    if (url.pathname.endsWith('.csv')) {
      lastExport = Object.fromEntries(url.searchParams);
      response.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="analytics.csv"' }); response.end('date,handoffs\n2026-11-01,1\n'); return;
    }
    lastQuery = Object.fromEntries(url.searchParams);
    const from = url.searchParams.get('from'), to = url.searchParams.get('to');
    const dates = [];
    for (let date = new Date(`${from}T12:00:00Z`); date.toISOString().slice(0, 10) <= to; date.setUTCDate(date.getUTCDate() + 1)) dates.push(date.toISOString().slice(0, 10));
    json(200, { ...fixture, from, to, enabled: !empty, startedAt: empty ? null : fixture.startedAt,
      summary: empty ? Object.fromEntries(Object.keys(fixture.summary).map(key => [key, key === 'successRate' || key.endsWith('Ms') ? null : 0])) : fixture.summary,
      daily: dates.map((date, index) => ({ date, handoffs: empty ? 0 : [5, 7, 10, 6, 3, 6, 6, 8, 10, 7, 6, 10, 11, 10, 12, 11, 15, 20, 14, 13, 11, 7, 6, 10, 12, 8, 13, 9, 8, 9][index % 30], applied: empty ? 0 : 5, failed: 0, expired: 0, pending: 0, tabs: empty ? 0 : 15 })),
      browsers: empty ? [] : fixture.browsers,
      modes: empty ? { wholeWindow: 0, currentTab: 0, unknown: 0 } : fixture.modes,
      pairings: empty ? { easyPair: 0, code: 0 } : fixture.pairings
    }); return;
  }
  response.writeHead(url.pathname === '/favicon.ico' ? 204 : 404); response.end();
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}) });
const context = await browser.newContext({ viewport: { width: 1488, height: 1058 }, colorScheme: 'light', acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
// Expected HTTP failures exercise auth/retry. Record only unexpected console errors.
page.on('console', message => { if (message.type() === 'error' && !message.text().includes('Failed to load resource')) errors.push(message.text()); });
async function visible(selector) { await page.locator(selector).waitFor({ state: 'visible' }); }
async function contains(selector, text) { await page.waitForFunction(({ selector, text }) => document.querySelector(selector)?.textContent.includes(text), { selector, text }); }
async function contrast() {
  const failures = await page.evaluate(() => {
    const luminance = color => { const values = color.match(/[\d.]+/g).slice(0, 3).map(v => { const c = Number(v) / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }); return values[0] * .2126 + values[1] * .7152 + values[2] * .0722; };
    return [...document.querySelectorAll('h1,h2,p,dt,dd,th,td,label,button,select,input,summary,.status,.pagination,.timezone,.bar-row')].filter(node => {
      const style = getComputedStyle(node), rect = node.getBoundingClientRect();
      return rect.width && rect.height && !node.closest('[hidden]') && !node.classList.contains('sr-only') && Number(style.opacity) === 1 && !node.disabled;
    }).flatMap(node => {
      let parent = node, bg;
      while (parent) { bg = getComputedStyle(parent).backgroundColor; if (bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') break; parent = parent.parentElement; }
      const fg = getComputedStyle(node).color;
      const a = luminance(fg), b = luminance(bg), ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
      return ratio < 4.5 ? [{ text: node.textContent.slice(0, 50), ratio, fg, bg }] : [];
    });
  });
  assert.deepEqual(failures, [], 'WCAG AA text contrast');
}
try {
  await page.goto(`${origin}/admin/analytics`);
  assert.equal(await page.title(), 'Analytics · Classroom Handoff');
  await visible('#login');
  await page.locator('#admin-key').fill('incorrect'); await page.locator('#login-button').click(); await contains('#login-error', 'Sign-in failed');
  assert.equal(await page.locator('#admin-key').inputValue(), '');
  await page.locator('#admin-key').fill('test-administrator-key'); await page.locator('#admin-key').press('Enter');
  await contains('#handoffs', '248');
  assert.equal((Date.parse(lastQuery.to) - Date.parse(lastQuery.from)) / 86400000, 29);
  await contains('#success-rate', '96.4%'); await contains('#median', '1.2 s'); await contains('#p95', '3.1 s');
  assert.equal(await page.locator('#browser-rows tr').count(), 25);
  await contains('#browser-rows tr:first-child', 'Never');
  await page.locator('#next').click(); await contains('#browser-count', '26–50');
  await page.locator('#browser-search').fill('<img'); await contains('#browser-count', '1–1 of 1');
  assert.equal(await page.locator('#browser-rows img').count(), 0);
  assert.equal(await page.evaluate(() => window.injected), undefined);
  await page.locator('#browser-search').fill('does-not-exist'); await contains('#browser-rows', 'No browsers match');
  await page.locator('#browser-search').fill('');
  await contrast();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: join(evidence, 'desktop-light.png'), fullPage: false });
  await page.locator('#theme').selectOption('dark'); assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark'); await contrast();
  await page.screenshot({ path: join(evidence, 'desktop-dark.png'), fullPage: false });
  await page.locator('#theme').selectOption('system'); await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.emulateMedia({ colorScheme: 'light' }); await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.locator('#range').selectOption('7'); await contains('#status', 'Updated');
  await page.waitForFunction(() => document.querySelector('#daily-rows').children.length === 7);
  assert.equal((Date.parse(lastQuery.to) - Date.parse(lastQuery.from)) / 86400000, 6);
  await page.locator('#range').selectOption('custom');
  await page.locator('#from').fill('2026-01-01'); await page.locator('#to').fill('2026-11-01'); await page.locator('#custom-range button').click(); await contains('#report-error', '1 to 180 days');
  await page.locator('#from').fill('2026-11-01'); await page.locator('#to').fill('2026-11-03'); await page.locator('#custom-range button').click();
  await page.waitForFunction(() => document.querySelector('#daily-rows').children.length === 3);
  await page.locator('#export-report').selectOption('browsers'); const downloadWait = page.waitForEvent('download'); await page.locator('#export').click(); const download = await downloadWait; assert.equal(download.suggestedFilename(), 'analytics.csv');
  assert.deepEqual(lastExport, { report: 'browsers', from: '2026-11-01', to: '2026-11-03', q: '' });
  unavailable = true; await page.locator('#range').selectOption('30'); await contains('#report-error', 'Unable to load');
  unavailable = false; await page.locator('#retry').click(); await page.waitForFunction(() => document.querySelector('#report-error').hidden && !document.querySelector('#export').disabled);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(evidence, 'mobile-light.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'No page overflow on mobile');
  await page.locator('#theme').selectOption('dark'); await contrast(); await page.screenshot({ path: join(evidence, 'mobile-dark.png'), fullPage: true });
  empty = true; await page.locator('#range').selectOption('180'); await contains('#handoffs', '0'); await visible('#empty-trend'); await contains('#collection-status', 'Collection disabled');
  assert.equal(await page.locator('#success-rate').textContent(), '—'); await contains('#browser-rows', 'No browser activity');
  await page.screenshot({ path: join(evidence, 'mobile-empty.png'), fullPage: true });
  authenticated = false;
  await page.locator('#range').selectOption('90'); await visible('#login'); await contains('#login-error', 'session has ended');
  await page.locator('#admin-key').fill('test-administrator-key'); await page.locator('#admin-key').press('Enter'); await visible('#dashboard');
  await page.locator('#sign-out').click(); await visible('#login'); assert.equal(await page.locator('#admin-key').inputValue(), '');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'admin-key');
  assert.deepEqual(await page.evaluate(() => Object.keys(localStorage)), ['classroom-handoff-admin-theme']);
  assert(calls.every(url => !url.includes('administrator-key') && !url.includes('incorrect')), 'No credentials in URLs');
  assert.deepEqual(errors, []);
  console.log(`Dashboard browser QA passed (desktop/mobile, themes, auth, ranges, exports, search/pagination, empty/error/XSS, contrast). Evidence: ${evidence}`);
} finally {
  await browser.close();
  await new Promise(done => server.close(done));
}
