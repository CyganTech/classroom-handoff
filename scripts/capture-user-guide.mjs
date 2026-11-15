/** Documentation pictures only: real built UI with fictional, local-only state. */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import assert from 'node:assert/strict';
const directory = resolve('artifacts/extension');
const output = resolve('docs/images');
await mkdir(output, { recursive: true });
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (!/^\/(popup\.html|options\.html|[a-z-]+\.(js|css)|icons\/[a-z0-9.-]+)$/.test(path)) { response.writeHead(404).end(); return; }
  try {
    const bytes = await readFile(directory + path);
    response.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' })[extname(path)] ?? 'application/octet-stream');
    response.end(bytes);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}) });
try {
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' });
  await context.addInitScript(() => {
    const peer = { id: 'example-display', name: 'Classroom display', online: true, lastSeen: null };
    const state = { configured: true, connected: true, name: 'Teacher laptop', deviceId: 'example-laptop', backendUrl: 'https://handoff.example.org', preferences: { theme: 'light', currentTabOnly: false }, devices: [peer], preferredDestinationId: peer.id, discovery: { enabled: true, available: true, suggestions: [peer], requests: [] } };
    if (location.pathname === '/options.html') state.devices = [];
    window.chrome = {
      runtime: { sendMessage: async request => ({ ok: true, state, ...(request.action === 'pairing.create' ? { pairing: { code: 'K7MP-4RTX', expiresAt: Date.now() + 300000 } } : {}) }), openOptionsPage: async () => {}, getURL: path => path },
      storage: { local: { get: async () => ({ uiPreferences: state.preferences }) }, onChanged: { addListener: () => {} } },
      permissions: { request: async () => true }, tabs: { create: async () => {} }
    };
  });
  const page = await context.newPage(); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/popup.html');
  await page.locator('#handoff:not([disabled])').waitFor();
  await page.locator('.popup-shell').screenshot({ path: output + '/user-guide-popup.png' });
  await page.goto(origin + '/options.html');
  await page.locator('#suggestions button').waitFor();
  await page.locator('#suggestions').screenshot({ path: output + '/user-guide-suggestion.png' });
  await page.locator('#create-code').click();
  await page.locator('#pairing-result').waitFor({ state: 'visible' });
  // A fixed example expiry keeps the guide pictures reproducible.
  await page.locator('#pairing-expiry').evaluate(node => { node.textContent = 'Expires in 5:00. Use it once.'; });
  await page.locator('.pairing-columns').screenshot({ path: output + '/user-guide-code.png' });
  assert.deepEqual(errors, []);
  console.log('Captured three example guide pictures from the actual built extension UI.');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
