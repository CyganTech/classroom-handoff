/** Real extension + HTTP/WebSocket + SQLite integration. No handoff transport mocks. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { createApp } from '../server/app.js';
import type { UiRequest, UiResponse, UiState } from '../shared/ui.js';

const root = await mkdtemp(join(tmpdir(), 'classroom-handoff-e2e-'));
const evidence = resolve('test-results');
await mkdir(evidence, { recursive: true });
let app = createApp({ dataDir: join(root, 'data') });
const address = await app.listen(0);
const web = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(`<html><head><title>Lesson ${req.url}</title></head><body><h1>Classroom test ${req.url}</h1></body></html>`); });
await new Promise<void>((done, reject) => { web.once('error', reject); web.listen(0, '127.0.0.1', done); });
const webAddress = web.address(); assert.ok(webAddress && typeof webAddress !== 'string');
const lessonOrigin = `http://127.0.0.1:${webAddress.port}`;
const extensionPath = resolve('artifacts/extension');
const contexts: BrowserContext[] = [];
const pageErrors: string[] = [];
const browserOptions = {
  channel: 'chromium', headless: process.env.E2E_HEADED !== '1',
  ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}),
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--no-first-run', '--test-type'],
  viewport: { width: 1200, height: 950 }
};
async function browser(profile: string) {
  const context = await chromium.launchPersistentContext(join(root, profile), browserOptions);
  contexts.push(context);
  context.on('page', page => { page.on('console', message => { if (page.url().startsWith('chrome-extension://') && message.type() === 'error') pageErrors.push(message.text()); }); page.on('pageerror', error => { if (page.url().startsWith('chrome-extension://')) pageErrors.push(error.message); }); });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 20000 });
  const extensionId = new URL(worker.url()).host;
  // Chrome's native optional-host bubble is outside page automation. Grant only the
  // fixture backend through the browser's own extension settings API in this
  // disposable test profile; application registration and handoffs remain real.
  const settings = await context.newPage();
  await settings.goto('chrome://extensions/');
  await settings.evaluate(async ({ extensionId, origin }) => {
    const developer = (chrome as unknown as { developerPrivate: { addHostPermission(id: string, host: string): Promise<void> } }).developerPrivate;
    await developer.addHostPermission(extensionId, `${origin}/*`);
  }, { extensionId, origin: address.url });
  await settings.close();
  // Controlled profile identity only; discovery HTTP, SQLite, approval, and handoff
  // all run through the shipped extension. Never add identity overrides to production.
  await worker.evaluate("Object.defineProperty(chrome.identity, 'getProfileUserInfo', { configurable: true, value: async () => ({ id: 'e2e-primary-account', email: 'teacher@example.test' }) })");
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  return { context, worker, extensionId, options };
}
async function request(page: Page, message: UiRequest): Promise<UiResponse> {
  return page.evaluate(async value => await chrome.runtime.sendMessage(value), message);
}
async function state(page: Page): Promise<UiState> {
  const result = await request(page, { action: 'state' });
  if (!result.ok || !result.state) throw new Error(result.ok ? 'Missing UI state' : result.error);
  return result.state;
}
async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean, label: string, timeout = 20000): Promise<T> {
  const started = Date.now(); let last: T | undefined;
  while (Date.now() - started < timeout) { last = await read(); if (predicate(last)) return last; await new Promise(done => setTimeout(done, 250)); }
  throw new Error(`Timeout: ${label}. Last value: ${JSON.stringify(last)}`);
}
async function checkContrast(page: Page): Promise<void> {
  const pairs = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('label,p,h1,h2,h3,button,select,input,dt,dd,summary,.peer-name,.peer-meta')).filter(node => {
    const style = getComputedStyle(node);
    return node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0 && !node.hasAttribute('disabled') && Number(style.opacity) === 1 && !node.closest('[hidden]');
  }).map(node => {
    let current: Element | null = node; let background = '';
    while (current) { background = getComputedStyle(current).backgroundColor; if (background !== 'rgba(0, 0, 0, 0)' && background !== 'transparent') break; current = current.parentElement; }
    return { text: node.textContent?.slice(0, 50), foreground: getComputedStyle(node).color, background };
  }));
  for (const pair of pairs) {
    const luminance = (color: string) => {
      const values = color.match(/[\d.]+/g)!.slice(0, 3).map(v => { const c = Number(v) / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
      return values[0]! * 0.2126 + values[1]! * 0.7152 + values[2]! * 0.0722;
    };
    const a = luminance(pair.foreground); const b = luminance(pair.background);
    assert.ok((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5, `Text contrast: ${JSON.stringify(pair)}`);
  }
}
async function themeIs(page: Page, expected: string) {
  await until(() => page.locator('html').getAttribute('data-theme'), value => value === expected, `theme ${expected}`);
}

async function register(page: Page, name: string) {
  await page.locator('#backend-url').fill(address.url);
  await page.locator('#register-name').fill(name);
  await page.locator('#register-submit').click();
  await until(() => state(page), value => value.configured && value.connected, `${name} registration/connection`);
}
try {
  console.log('Launching two independently stored extension installations…');
  const a = await browser('sender'); let b = await browser('receiver');
  await until(() => a.options.locator('#register-name').inputValue(), value => / · [2-9A-HJ-NP-Z]{4}$/.test(value), 'prefilled platform browser name');
  await register(a.options, 'Teacher laptop'); await register(b.options, 'Classroom display');
  await a.options.locator('#create-code').click();
  const code = await until(() => a.options.locator('#pairing-code').innerText(), text => /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/.test(text), 'pairing code');
  await b.options.locator('#claim-code').fill(code);
  await b.options.locator('#claim-form button[type=submit]').click();
  const paired = await until(() => state(a.options), value => value.devices.some(d => d.name === 'Classroom display' && d.online), 'paired destination presence');
  const destinationId = paired.devices.find(d => d.name === 'Classroom display')!.id;
  const senderId = paired.deviceId;
  console.log('PASS A: real registration, single-use pairing and online presence');
  await a.options.screenshot({ path: join(evidence, 'setup-paired.png'), fullPage: true });
  assert.equal((await state(a.options)).discovery?.enabled, true);
  assert.equal(await a.options.locator('#advanced-settings').getAttribute('open'), null, 'advanced controls start collapsed');
  assert.equal(await a.options.locator('#discovery-enabled').isVisible(), false);
  await a.options.bringToFront();
  await a.options.locator('#copy-code').click();
  await until(() => a.options.locator('#message').innerText(), text => text.includes('Code copied'), 'copy feedback');
  // Copy feedback follows a successful real clipboard write; clipboard reads need
  // a separate permission that the production extension deliberately does not use.
  await request(a.options, { action: 'peer.remove', deviceId: destinationId });
  await until(() => a.options.getByRole('button', { name: 'Easy pair with Classroom display' }).isVisible(), Boolean, 'same-profile suggestion');
  await a.options.locator('#suggestions').screenshot({ path: join(evidence, 'automatic-suggestions.png') });
  // Suggestions must appear before touching any settings. Verify the advanced off
  // switch removes discovery and survives a page reload, then re-enable for pairing.
  await a.options.locator('#advanced-settings summary').click();
  await a.options.locator('#discovery-enabled').uncheck();
  await until(() => state(a.options), value => value.discovery?.enabled === false, 'advanced opt-out');
  await a.options.reload();
  await until(() => state(a.options), value => value.discovery?.enabled === false && value.discovery.suggestions.length === 0, 'opt-out survives reload');
  await a.options.locator('#advanced-settings summary').click();
  await a.options.locator('#discovery-enabled').check();
  await until(() => a.options.getByRole('button', { name: 'Easy pair with Classroom display' }).isVisible(), Boolean, 're-enabled suggestions');
  await a.options.locator('#advanced-settings summary').click();
  await a.options.getByRole('button', { name: 'Easy pair with Classroom display' }).click();
  await until(() => state(b.options), value => (value.discovery?.requests.length ?? 0) === 1, 'incoming Easy pair request');
  assert.equal((await state(a.options)).devices.length, 0, 'request alone does not grant handoff rights');
  await a.options.screenshot({ path: join(evidence, 'easy-pair-pending.png'), fullPage: true });
  const approval = await b.context.newPage();
  await approval.goto(`chrome-extension://${b.extensionId}/popup.html`);
  await approval.getByRole('button', { name: 'Decline pairing with Teacher laptop' }).click();
  await until(() => state(a.options), value => value.discovery?.requests.length === 0, 'declined request clears');
  await until(() => a.options.getByRole('button', { name: 'Easy pair with Classroom display' }).isVisible(), Boolean, 'suggestion after decline');
  await a.options.getByRole('button', { name: 'Easy pair with Classroom display' }).click();
  await approval.getByRole('button', { name: 'Accept pairing with Teacher laptop' }).waitFor();
  await approval.screenshot({ path: join(evidence, 'easy-pair-approval.png') });
  await approval.getByRole('button', { name: 'Accept pairing with Teacher laptop' }).click();
  await until(() => state(a.options), value => value.devices.some(d => d.id === destinationId), 'Easy pair approval creates peers');
  await a.options.setViewportSize({ width: 390, height: 844 });
  await a.options.screenshot({ path: join(evidence, 'setup-mobile.png'), fullPage: true });
  assert.equal(await a.options.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'setup fits mobile width');
  await a.options.setViewportSize({ width: 1200, height: 950 });
  await approval.getByRole('button', { name: 'Pair another browser', exact: true }).click();
  const setupShortcut = await until(async () => b.context.pages().find(p => p.url().endsWith('/options.html#pair-browser')), Boolean, 'popup pairing shortcut');
  assert.ok(setupShortcut); await setupShortcut.close();
  await approval.close();
  await a.options.locator('#advanced-settings summary').click();
  await b.options.locator('#advanced-settings summary').click();
  await a.options.locator('#discovery-enabled').uncheck();
  await b.options.locator('#discovery-enabled').uncheck();
  assert.equal((await state(a.options)).devices.length, 1, 'disabling discovery preserves established pairing');
  console.log('PASS: short-code copy, automatic suggestions, persistent advanced opt-out, decline, popup approval, mobile setup, and pairing shortcut');
  const unrelated = await b.context.newPage(); await unrelated.goto(`${lessonOrigin}/unrelated`);
  await b.options.close(); // Receiving needs no open extension UI.
  const urls = Array.from({ length: 5 }, (_, i) => `${lessonOrigin}/lesson-${i + 1}`);
  const source = await a.worker.evaluate(async ({ urls, popupUrl }) => {
    const win = await chrome.windows.create({ url: urls, focused: true, type: 'normal' });
    if (!win || win.id === undefined) throw new Error('Missing source window');
    const tabs = await chrome.tabs.query({ windowId: win.id });
    await chrome.tabs.update(tabs[0]!.id!, { pinned: true });
    const g1 = await chrome.tabs.group({ tabIds: [tabs[1]!.id!, tabs[2]!.id!] });
    await chrome.tabGroups.update(g1, { title: 'Science', color: 'blue' });
    const g2 = await chrome.tabs.group({ tabIds: [tabs[3]!.id!, tabs[4]!.id!] });
    await chrome.tabGroups.update(g2, { title: 'Reading', color: 'yellow', collapsed: true });
    await chrome.tabs.create({ windowId: win.id, url: popupUrl, active: false });
    await chrome.tabs.update(tabs[2]!.id!, { active: true });
    return { windowId: win.id, tabIds: tabs.map(t => t.id!) };
  }, { urls, popupUrl: `chrome-extension://${a.extensionId}/popup.html` });
  const popup = await until(async () => a.context.pages().find(p => p.url().endsWith('/popup.html')), value => !!value, 'popup page');
  assert.ok(popup);
  await popup.locator('#destination').selectOption(destinationId);
  await until(() => popup.locator('#handoff').isEnabled(), Boolean, 'handoff button ready');
  await popup.locator('#handoff').click();
  const applied = await until(() => state(a.options), value => value.lastCommand?.status === 'applied', 'receiver applied acknowledgement');
  assert.equal(applied.lastCommand?.destinationId, destinationId);
  const readReceiver = async () => b.worker.evaluate(async prefix => {
    const tabs = (await chrome.tabs.query({})).filter(t => (t.url ?? '').startsWith(prefix + '/lesson-')).sort((x, y) => x.index - y.index);
    const groups = await Promise.all([...new Set(tabs.map(t => t.groupId).filter(id => id >= 0))].map(id => chrome.tabGroups.get(id)));
    return { tabs, groups };
  }, lessonOrigin);
  const restored = await readReceiver();
  assert.deepEqual(restored.tabs.map(t => t.url), urls);
  assert.deepEqual(restored.tabs.map(t => t.pinned), [true, false, false, false, false]);
  assert.deepEqual(restored.tabs.map(t => t.active), [false, false, true, false, false]);
  assert.deepEqual(restored.groups.map(g => [g.title, g.color]), [['Science', 'blue'], ['Reading', 'yellow']]);
  assert.equal(restored.groups[1]?.collapsed, true);
  assert.equal(unrelated.isClosed(), false);
  console.log('PASS B/C: popup Handoff -> backend -> receiver (UI closed) restores five ordered tabs, pinned flag, active tab and two groups');
  await until(() => popup.locator('#command-status').innerText(), text => text.includes('Workspace opened'), 'applied UI feedback');
  await popup.locator('body').screenshot({ path: join(evidence, 'popup-applied.png') });
  await a.options.emulateMedia({ colorScheme: 'light' }); await popup.emulateMedia({ colorScheme: 'light' });
  await themeIs(popup, 'light');
  for (const theme of ['dark', 'light'] as const) {
    await a.options.locator('#theme-choice').selectOption(theme);
    await themeIs(a.options, theme); await themeIs(popup, theme);
    await until(() => a.options.locator('#theme-choice').isEnabled(), Boolean, 'appearance save completed');
    await checkContrast(popup); await checkContrast(a.options);
    await popup.locator('body').screenshot({ path: join(evidence, `popup-${theme}.png`) });
    await a.options.screenshot({ path: join(evidence, `setup-${theme}.png`), fullPage: true });
  }
  await a.options.reload(); await themeIs(a.options, 'light');
  await a.options.locator('#theme-choice').selectOption('system');
  await a.options.emulateMedia({ colorScheme: 'dark' }); await popup.emulateMedia({ colorScheme: 'dark' });
  await themeIs(popup, 'dark'); await themeIs(a.options, 'dark');
  await until(() => a.options.locator('#theme-choice').isEnabled(), Boolean, 'system appearance save completed');
  await a.options.setViewportSize({ width: 390, height: 844 });
  assert.equal(await a.options.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await a.options.screenshot({ path: join(evidence, 'setup-dark-mobile.png'), fullPage: true });
  await a.options.setViewportSize({ width: 1200, height: 950 });
  await a.options.locator('#reset').click();
  await a.options.locator('#confirm-dialog').waitFor({ state: 'visible' });
  await checkContrast(a.options);
  await a.options.screenshot({ path: join(evidence, 'dialog-dark.png') });
  await a.options.locator('#confirm-dialog button[value=cancel]').click();
  await a.options.locator('#theme-choice').selectOption('light');
  // The simulated popup is a tab. Restore the lesson as the active source tab,
  // then exercise the actual checkbox and Handoff controls.
  await popup.locator('#current-tab-only').check();
  await until(() => state(a.options), value => value.preferences?.currentTabOnly === true, 'saved single-tab preference');
  await popup.reload(); await until(() => popup.locator('#current-tab-only').isChecked(), Boolean, 'single-tab preference after reopen');
  await a.worker.evaluate(async id => { await chrome.tabs.update(id, { active: true }); }, source.tabIds[2]!);
  await popup.locator('#handoff').click();
  const single = await until(() => state(a.options), value => value.lastCommand?.status === 'applied' && value.lastCommand.id !== applied.lastCommand!.id, 'single-tab handoff applied');
  assert.deepEqual((await readReceiver()).tabs.map(t => t.url), [urls[2]]);
  assert.equal((await readReceiver()).groups[0]?.title, 'Science');
  const restricted = await a.worker.evaluate(async windowId => { const tab = await chrome.tabs.create({ windowId, url: 'chrome://settings', active: true }); return tab.id!; }, source.windowId);
  const rejected = await request(a.options, { action: 'handoff', destinationId, windowId: source.windowId, currentTabOnly: true });
  assert.equal(rejected.ok, false);
  assert.equal((await state(a.options)).lastCommand?.id, single.lastCommand?.id);
  assert.deepEqual((await readReceiver()).tabs.map(t => t.url), [urls[2]]);
  await a.worker.evaluate(async ({ restricted, active }) => { await chrome.tabs.remove(restricted); await chrome.tabs.update(active, { active: true }); }, { restricted, active: source.tabIds[2]! });
  await popup.locator('#current-tab-only').uncheck();
  await until(() => state(a.options), value => value.preferences?.currentTabOnly === false, 'restore whole-window preference');
  console.log('PASS: both themes, system changes, synchronized overrides, contrast, dialog/mobile setup, saved single-tab capture and restricted-tab rejection');
  console.log('Checking receiver stays available beyond the 30-second worker idle window…');
  await new Promise(done => setTimeout(done, 35000));
  const cdp = await b.context.newCDPSession(unrelated);
  const versions = new Map<string, { versionId: string; scriptURL: string; runningStatus: string }>();
  cdp.on('ServiceWorker.workerVersionUpdated', event => { for (const version of event.versions) versions.set(version.versionId, version); });
  await cdp.send('ServiceWorker.enable');
  const currentWorker = await until(async () => [...versions.values()].find(v => v.scriptURL === `chrome-extension://${b.extensionId}/background.js` && v.runningStatus === 'running'), Boolean, 'receiver worker version');
  assert.ok(currentWorker);
  await cdp.send('ServiceWorker.stopWorker', { versionId: currentWorker.versionId });
  await until(async () => versions.get(currentWorker.versionId), value => value?.runningStatus === 'stopped', 'worker forced stop');
  await until(async () => ({
    peer: (await state(a.options)).devices.find(d => d.id === destinationId),
    status: versions.get(currentWorker.versionId)?.runningStatus,
    workers: b.context.serviceWorkers().map(w => w.url())
  }), value => value.peer?.online === true && value.status === 'running', 'alarm-driven worker restart', 45000);
  b.worker = b.context.serviceWorkers().find(w => w.url().includes(b.extensionId))!;
  assert.ok(b.worker, 'Playwright observes restarted receiver worker');
  await cdp.detach();
  console.log('PASS: stopped receiver service worker recovers through its alarm without opening receiver UI');
  await a.worker.evaluate(async ({ tabIds }) => { await chrome.tabs.remove([tabIds[3]!, tabIds[4]!]); await chrome.tabs.update(tabIds[1]!, { active: true }); }, source);
  const previousId = (await state(a.options)).lastCommand!.id;
  await until(() => popup.locator('#handoff').isEnabled(), Boolean, 'repeat handoff button ready');
  await popup.locator('#handoff').click();
  await until(() => state(a.options), value => value.lastCommand?.status === 'applied' && value.lastCommand.id !== previousId, 'repeat applied');
  const repeated = await readReceiver();
  assert.deepEqual(repeated.tabs.map(t => t.url), urls.slice(0, 3));
  assert.equal(unrelated.isClosed(), false);
  assert.equal(repeated.tabs[0]?.windowId, restored.tabs[0]?.windowId, 'worker restart retains managed window ownership');
  assert.ok(restored.tabs.every(old => !repeated.tabs.some(next => next.id === old.id)));
  console.log('PASS D: repeat replaces extension-owned tabs, preserves unrelated receiver tab');
  await b.context.close();
  await until(() => state(a.options), value => value.devices.some(d => d.id === destinationId && !d.online), 'offline receiver presence');
  await until(() => popup.locator('#handoff').isDisabled(), Boolean, 'offline Handoff disabled');
  const offline = await request(a.options, { action: 'handoff', destinationId, windowId: source.windowId });
  assert.equal(offline.ok, false);
  console.log('PASS E: offline receiver is visible and send reports failure, never success');
  b = await browser('receiver');
  await until(() => state(b.options), value => value.connected && value.deviceId === destinationId, 'receiver profile restart identity');
  await until(() => state(a.options), value => value.devices.some(d => d.id === destinationId && d.online), 'receiver reconnect');
  await b.options.close();
  await app.close();
  app = createApp({ dataDir: join(root, 'data') }); await app.listen(address.port);
  await until(() => state(a.options), value => value.connected && value.deviceId === senderId && value.devices.some(d => d.id === destinationId && d.online), 'backend restart reconnect', 45000);
  const result = await request(a.options, { action: 'handoff', destinationId, windowId: source.windowId });
  assert.equal(result.ok, true);
  const sentId = result.ok ? result.command?.id ?? result.state?.lastCommand?.id : undefined;
  assert.ok(sentId);
  await until(() => state(a.options), value => value.lastCommand?.id === sentId && value.lastCommand.status === 'applied', 'post-restart handoff applied');
  console.log('PASS F: browser profile and backend restart retain identity/pairing and resume actual handoffs');
  assert.deepEqual(pageErrors, [], 'No extension page runtime errors');
  console.log(`PASS: real two-profile extension end-to-end. Browser ${b.context.browser()?.version() ?? 'Chromium'}. Evidence: ${evidence}`);
} catch (error) {
  for (let i = 0; i < contexts.length; i++) { const page = contexts[i]?.pages().find(p => p.url().includes('options.html')); if (page) await page.screenshot({ path: join(evidence, `failure-${i}.png`), fullPage: true }).catch(() => {}); }
  throw error;
} finally {
  await Promise.allSettled(contexts.map(context => context.close()));
  await app.close();
  await new Promise<void>(done => web.close(() => done()));
  await rm(root, { recursive: true, force: true });
}
