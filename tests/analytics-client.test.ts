import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnalyticsClient } from '../extension/src/analytics.js';
import { BackgroundController } from '../extension/src/background.js';
import type { ConnectionSettings } from '../extension/src/transport.js';

const deviceId = 'b42056ea-26c6-4c5b-813c-14a4d25fa011';
const destinationId = 'a42056ea-26c6-4c5b-813c-14a4d25fa022';
const settings: ConnectionSettings = { backendUrl: 'https://backend.example', credentials: { deviceId, token: 'secret-token'.repeat(4) } };
function memoryApi(initial: Record<string, unknown> = {}) {
  const data = structuredClone(initial);
  const area = (values: Record<string, unknown>) => ({ get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(values[key])])), set: async (patch: Record<string, unknown>) => { Object.assign(values, structuredClone(patch)); }, remove: async (keys: string | string[]) => { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; }, setAccessLevel: async () => {} });
  const tab = { id: 1, windowId: 1, index: 0, url: 'https://private.example/student?token=secret', active: true, pinned: false, groupId: -1 };
  return { data, tab, api: { runtime: { getManifest: () => ({ version: '0.2.3' }), getPlatformInfo: async () => ({ os: 'mac' }), getURL: (path: string) => `chrome-extension://test/${path}` }, storage: { local: area(data), session: area({}) }, alarms: { create: async () => {} }, permissions: { contains: async () => false }, windows: { getLastFocused: async () => ({ id: 1, type: 'normal' }), get: async () => ({ id: 1, type: 'normal' }) }, tabs: { query: async () => [tab] } } as unknown as typeof chrome };
}
const waitFor = async (predicate: () => boolean) => { for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); } throw Error('Timed out'); };
function fakeFetch(handler: (url: string, body: any, init: RequestInit) => unknown | Promise<unknown>) {
  const original = globalThis.fetch; const calls: Array<{ url: string; body: any; init: RequestInit }> = [];
  globalThis.fetch = (async (input, init = {}) => { const url = String(input); const body = init.body ? JSON.parse(String(init.body)) : undefined; calls.push({ url, body, init }); const result = await handler(url, body, init); return result instanceof Response ? result : Response.json(result ?? {}); }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}
const events = (calls: ReturnType<typeof fakeFetch>['calls']) => calls.filter(c => c.url.endsWith('/events')).flatMap(c => c.body.events);

test('old and explicitly disabled backends receive no metadata or telemetry', async () => {
  for (const response of [new Response('{}', { status: 404 }), { enabled: false, version: 1 }]) {
    const { api, data } = memoryApi(); let now = 1_000;
    const net = fakeFetch(() => response);
    try {
      const client = new AnalyticsClient(api, async () => settings, () => now);
      client.record('capture_failed', 'tab_unsupported'); client.kick();
      await waitFor(() => net.calls.length > 0); await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(client.metadata(settings, false), undefined);
      assert.equal(net.calls.length, 1);
      if (!(response instanceof Response)) assert.equal(JSON.stringify(data).includes('capture_failed'), false);
      now += 1_000; client.kick(); await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(net.calls.length, 1);
    } finally { net.restore(); }
  }
});

test('enabled negotiation registers bounded client info and exposes only actual request mode', async () => {
  const { api } = memoryApi(); const net = fakeFetch(url => url.endsWith('/capabilities') ? { enabled: true, version: 1 } : {});
  try {
    const client = new AnalyticsClient(api, async () => settings);
    assert.equal(client.metadata(settings, true), undefined); client.kick();
    await waitFor(() => net.calls.some(c => c.url.endsWith('/client')));
    assert.deepEqual(net.calls.find(c => c.url.endsWith('/client'))?.body, { version: '0.2.3', platform: 'mac' });
    assert.deepEqual(client.metadata(settings, false), { version: '0.2.3', platform: 'mac', mode: 'whole-window' });
    assert.deepEqual(client.metadata(settings, true), { version: '0.2.3', platform: 'mac', mode: 'current-tab' });
    assert.equal(client.metadata({ ...settings, backendUrl: 'https://other.example' }, true), undefined);
    assert.match(String(net.calls[0]?.init.headers && (net.calls[0].init.headers as Record<string, string>).Authorization), /^Bearer /);
  } finally { net.restore(); }
});

test('failure queue is bounded, expires after a day, deduplicates requests and retries stable event IDs', async () => {
  const { api, data } = memoryApi(); let now = 10_000; let fail = true;
  const net = fakeFetch(url => { if (url.endsWith('/capabilities')) return { enabled: true, version: 1 }; if (url.endsWith('/events') && fail) return new Response('{}', { status: 503 }); return {}; });
  try {
    const client = new AnalyticsClient(api, async () => settings, () => now);
    for (let i = 0; i < 105; i++) client.record('capture_failed', 'capture_error');
    await waitFor(() => JSON.stringify(data).includes('capture_failed')); await new Promise(resolve => setTimeout(resolve, 20));
    client.kick(); await waitFor(() => events(net.calls).length > 0);
    const first = events(net.calls); assert.equal(first.length, 100); assert.equal(new Set(first.map(e => e.id)).size, 100);
    fail = false; now += 30_001; client.kick(); await waitFor(() => events(net.calls).length === 200);
    assert.deepEqual(events(net.calls).slice(100), first);
    const requestId = crypto.randomUUID(); client.record('send_failed', 'network', requestId); client.record('send_failed', 'rejected', requestId);
    await new Promise(resolve => setTimeout(resolve, 15)); now += 30_001; client.kick(); await waitFor(() => events(net.calls).length > 200);
    assert.equal(events(net.calls).filter(e => e.requestId === requestId).length, 1);
    client.record('capture_failed', 'capture_error'); await new Promise(resolve => setTimeout(resolve, 10)); now += 86_400_001; client.kick(); await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(events(net.calls).length, 201);
    assert.equal(JSON.stringify(data).includes('private.example'), false); assert.equal(JSON.stringify(data).includes('secret-token'), false);
  } finally { net.restore(); }
});

test('persistent queue rejects sensitive extra fields and clears on reset or backend identity change', async () => {
  const { api, data } = memoryApi(); let config: ConnectionSettings | undefined = settings;
  const net = fakeFetch(url => url.endsWith('/capabilities') ? { enabled: true, version: 1 } : {});
  try {
    const client = new AnalyticsClient(api, async () => config);
    (client.record.bind(client) as (...args: unknown[]) => void)('capture_failed', 'capture_error', undefined, { url: 'https://private.example', error: 'secret', email: 'student@example.org' } as never);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(JSON.stringify(data).includes('private.example'), false); assert.equal(JSON.stringify(data).includes('student@'), false);
    config = { ...settings, credentials: { ...settings.credentials, deviceId: destinationId } }; client.kick();
    await waitFor(() => net.calls.some(c => c.url.endsWith('/client'))); assert.equal(events(net.calls).length, 0);
    client.record('send_failed', 'network', crypto.randomUUID()); await new Promise(resolve => setTimeout(resolve, 10)); await client.reset();
    assert.equal(client.metadata(config, true), undefined); assert.equal(JSON.stringify(data).includes('send_failed'), false);
    config = undefined; client.kick(); await new Promise(resolve => setTimeout(resolve, 5));
  } finally { net.restore(); }
});

test('hanging capability negotiation never blocks handoff or later normal actions, and old backend payload stays exact', async () => {
  const { api, data } = memoryApi({ configuration: { ...settings, name: 'Teacher', nameSource: 'custom' }, uiPreferences: { theme: 'system', currentTabOnly: true } });
  let pendingSignal: AbortSignal | undefined;
  const net = fakeFetch((url, body, init) => {
    if (url.endsWith('/capabilities')) { pendingSignal = init.signal!; return new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(Error('timeout')))); }
    if (url.endsWith('/api/handoffs')) return { command: { id: crypto.randomUUID(), requestId: body.requestId, sourceId: deviceId, destinationId, status: 'pending', createdAt: Date.now(), expiresAt: Date.now() + 60_000, completedAt: null, error: null, warnings: [] } };
    return { devices: [] };
  });
  const controller = new BackgroundController(api);
  try {
    await controller.start(); await waitFor(() => !!pendingSignal);
    const result = await Promise.race([controller.request({ action: 'handoff', destinationId }), new Promise(resolve => setTimeout(() => resolve('blocked'), 200))]);
    assert.notEqual(result, 'blocked'); assert.equal((result as { ok: boolean }).ok, true);
    const body = net.calls.find(c => c.url.endsWith('/api/handoffs'))!.body;
    assert.deepEqual(Object.keys(body).sort(), ['destinationId', 'requestId', 'workspace']);
    assert.equal(body.workspace.tabs.length, 1);
    const next = await Promise.race([controller.request({ action: 'preferences.update', theme: 'dark' }), new Promise(resolve => setTimeout(() => resolve('blocked'), 200))]); assert.notEqual(next, 'blocked');
    assert.equal((data.uiPreferences as { theme: string }).theme, 'dark');
  } finally { await controller.request({ action: 'reset' }); net.restore(); }
});

test('negotiated handoffs persist their actual capture mode and capture failures use approved categories', async () => {
  const { api, tab } = memoryApi({ configuration: { ...settings, name: 'Teacher', nameSource: 'custom' }, uiPreferences: { theme: 'system', currentTabOnly: true } });
  const net = fakeFetch((url, body) => {
    if (url.endsWith('/capabilities')) return { enabled: true, version: 1 };
    if (url.endsWith('/api/handoffs')) return { command: { id: crypto.randomUUID(), requestId: body.requestId, sourceId: deviceId, destinationId, status: 'applied', createdAt: Date.now(), expiresAt: Date.now() + 60_000, completedAt: Date.now(), error: null, warnings: [] } };
    return { devices: [] };
  });
  const controller = new BackgroundController(api);
  try {
    await controller.start(); await waitFor(() => net.calls.some(c => c.url.endsWith('/client')));
    assert.equal((await controller.request({ action: 'handoff', destinationId })).ok, true);
    assert.equal(net.calls.find(c => c.url.endsWith('/api/handoffs'))?.body.analytics.mode, 'whole-window');
    tab.url = 'chrome://settings'; assert.equal((await controller.request({ action: 'handoff', destinationId, currentTabOnly: true })).ok, false);
    await controller.recover(); await waitFor(() => events(net.calls).length > 0);
    assert.equal(events(net.calls)[0].type, 'capture_failed'); assert.equal(events(net.calls)[0].reason, 'tab_unsupported');
    assert.equal(JSON.stringify(events(net.calls)).includes('chrome://'), false);
  } finally { await controller.request({ action: 'reset' }); net.restore(); }
});

test('transient handoff retries emit no failure until local expiry and terminal rejections emit once', async () => {
  const { api, data } = memoryApi({ configuration: { ...settings, name: 'Teacher', nameSource: 'custom' } });
  let reject = false;
  const net = fakeFetch(url => {
    if (url.endsWith('/capabilities')) return { enabled: true, version: 1 };
    if (url.endsWith('/api/handoffs')) { if (reject) return new Response('{}', { status: 403 }); throw Error('contains sensitive transport details'); }
    return { devices: [] };
  });
  const controller = new BackgroundController(api);
  try {
    await controller.start(); await waitFor(() => net.calls.some(c => c.url.endsWith('/client')));
    assert.equal((await controller.request({ action: 'handoff', destinationId })).ok, false);
    await controller.recover(); assert.equal(events(net.calls).length, 0);
    const outbound = data.outboundRequest as { createdAt: number; requestId: string };
    const expiredId = outbound.requestId; outbound.createdAt = Date.now() - 60_001;
    await controller.recover(); await new Promise(resolve => setTimeout(resolve, 10)); await controller.recover();
    await waitFor(() => events(net.calls).length > 0);
    assert.equal(events(net.calls).filter(e => e.requestId === expiredId).length, 1);
    assert.equal(events(net.calls)[0].reason, 'network');
    reject = true; assert.equal((await controller.request({ action: 'handoff', destinationId })).ok, false);
    await new Promise(resolve => setTimeout(resolve, 10)); await controller.recover(); await waitFor(() => events(net.calls).length === 2);
    assert.equal(events(net.calls)[1].reason, 'rejected');
    assert.equal(JSON.stringify(events(net.calls)).includes('sensitive'), false);
    assert.equal(data.outboundRequest, undefined);
  } finally { await controller.request({ action: 'reset' }); net.restore(); }
});

test('a restarted worker retries persisted analytics IDs and omits previously stored handoff metadata before negotiation', async () => {
  const { api, data } = memoryApi({ configuration: { ...settings, name: 'Teacher', nameSource: 'custom' } });
  let eventFail = true;
  const net = fakeFetch((url, body) => {
    if (url.endsWith('/capabilities')) return { enabled: true, version: 1 };
    if (url.endsWith('/events') && eventFail) return new Response('{}', { status: 503 });
    if (url.endsWith('/api/handoffs')) return { command: { id: crypto.randomUUID(), requestId: body.requestId, sourceId: deviceId, destinationId, status: 'applied', createdAt: Date.now(), expiresAt: Date.now() + 60_000, completedAt: Date.now(), error: null, warnings: [] } };
    return { devices: [] };
  });
  let controller: BackgroundController | undefined;
  try {
    const first = new AnalyticsClient(api, async () => settings); first.record('send_failed', 'network', crypto.randomUUID());
    await new Promise(resolve => setTimeout(resolve, 10)); first.kick(); await waitFor(() => events(net.calls).length === 1);
    const id = events(net.calls)[0].id; eventFail = false;
    const second = new AnalyticsClient(api, async () => settings); second.kick(); await waitFor(() => events(net.calls).length === 2);
    assert.equal(events(net.calls)[1].id, id);
    data.outboundRequest = { requestId: crypto.randomUUID(), destinationId, createdAt: Date.now(), workspace: { version: 1, tabs: [{ url: 'https://private.example', pinned: false, active: true, groupId: null }], groups: [] }, analytics: { version: '0.2.3', platform: 'mac', mode: 'current-tab' } };
    controller = new BackgroundController(api);
    await controller.request({ action: 'handoff', destinationId });
    assert.equal(net.calls.find(c => c.url.endsWith('/api/handoffs'))?.body.analytics, undefined);
  } finally { if (controller) await controller.request({ action: 'reset' }); net.restore(); }
});

test('reset invalidates a discovery task that is still reading its old configuration', async () => {
  const { api, data } = memoryApi(); let resolveSettings!: (config: ConnectionSettings) => void;
  const delayedSettings = new Promise<ConnectionSettings>(resolve => { resolveSettings = resolve; });
  const net = fakeFetch(() => ({ enabled: true, version: 1 }));
  try {
    const client = new AnalyticsClient(api, () => delayedSettings);
    client.kick(); await client.reset(); resolveSettings(settings);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(net.calls.length, 0); assert.equal(data.extensionAnalytics, undefined);
    assert.equal(client.metadata(settings, false), undefined);
  } finally { net.restore(); }
});

test('old-backend capability backoff still purges persisted events at their 24-hour expiry', async () => {
  const { api, data } = memoryApi(); let now = 1_000;
  const net = fakeFetch(() => new Response('{}', { status: 404 }));
  try {
    const client = new AnalyticsClient(api, async () => settings, () => now);
    client.record('capture_failed', 'capture_error');
    await waitFor(() => (data.extensionAnalytics as { events: unknown[] } | undefined)?.events.length === 1);
    now = 86_400_000; client.kick(); await waitFor(() => net.calls.length === 1);
    await new Promise(resolve => setTimeout(resolve, 10));
    now = 86_401_001; client.kick(); await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual((data.extensionAnalytics as { events: unknown[] }).events, []);
    assert.equal(net.calls.length, 1);
  } finally { net.restore(); }
});

test('unavailable platform information keeps version and capture mode with unknown platform', async () => {
  const { api } = memoryApi(); api.runtime.getPlatformInfo = async () => { throw Error('unavailable'); };
  const net = fakeFetch(url => url.endsWith('/capabilities') ? { enabled: true, version: 1 } : {});
  try {
    const client = new AnalyticsClient(api, async () => settings); client.kick();
    await waitFor(() => net.calls.some(c => c.url.endsWith('/client')));
    assert.deepEqual(net.calls.find(c => c.url.endsWith('/client'))?.body, { version: '0.2.3', platform: 'unknown' });
    assert.deepEqual(client.metadata(settings, true), { version: '0.2.3', platform: 'unknown', mode: 'current-tab' });
  } finally { net.restore(); }
});
