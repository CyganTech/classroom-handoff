import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { ProfileDiscovery } from '../extension/src/discovery.js';

test('automatic profile discovery scopes account hashes to the backend and keeps email local', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'discovery-'));
  const app = createApp({ dataDir: dir }); const address = await app.listen(0);
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const config = { backendUrl: address.url, credentials: app.store.register('A') };
  const values: Record<string, unknown> = {}; let identityCalls = 0;
  let profile = { id: 'stable-account', email: 'teacher@example.org' }; let unavailable = false;
  const api = { storage: { local: {
    get: async (key: string) => ({ [key]: values[key] }),
    set: async (patch: Record<string, unknown>) => { Object.assign(values, structuredClone(patch)); }
  } }, identity: { getProfileUserInfo: async (details: unknown) => {
    identityCalls++; assert.deepEqual(details, { accountStatus: 'ANY' });
    if (unavailable) throw new Error('Not available'); return profile;
  } } } as unknown as typeof chrome;
  const discovery = new ProfileDiscovery(api);
  assert.equal((await discovery.sync(config)).enabled, true);
  assert.equal(identityCalls, 1); assert.ok(app.store.discoveryKey(config.credentials.deviceId));
  const enabled = await discovery.sync(config);
  assert.equal(enabled.email, profile.email); assert.equal(enabled.available, true);
  const key = app.store.discoveryKey(config.credentials.deviceId)!;
  assert.match(key, /^[a-f0-9]{64}$/); assert.equal(key.includes(profile.id), false);
  const snapshot = JSON.stringify(app.store.db.prepare('SELECT * FROM discovery').all());
  assert.equal(snapshot.includes(profile.email), false); assert.equal(snapshot.includes(profile.id), false);
  const secondDir = await mkdtemp(join(tmpdir(), 'discovery-other-')); const second = createApp({ dataDir: secondDir }); const other = await second.listen(0);
  t.after(async () => { await second.close(); await rm(secondDir, { recursive: true, force: true }); });
  const otherConfig = { backendUrl: other.url, credentials: second.store.register('Other') };
  const otherValues: Record<string, unknown> = {};
  const otherApi = { ...api, storage: { local: { get: async (key: string) => ({ [key]: otherValues[key] }), set: async (patch: Record<string, unknown>) => { Object.assign(otherValues, patch); } } } } as unknown as typeof chrome;
  const otherDiscovery = new ProfileDiscovery(otherApi); await otherDiscovery.setEnabled(true); await otherDiscovery.sync(otherConfig);
  assert.notEqual(second.store.discoveryKey(otherConfig.credentials.deviceId), key);
  // The same account re-read must not cancel a request; a changed account must.
  const peer = app.store.register('B'); app.store.setDiscovery(peer.deviceId, key);
  const request = app.store.requestPairing(peer.deviceId, config.credentials.deviceId, Date.now() + 300000, Date.now());
  await discovery.sync(config); assert.ok(app.store.getPairingRequest(request.id));
  profile = { id: 'different-account', email: 'other@example.org' }; await discovery.sync(config);
  assert.notEqual(app.store.discoveryKey(config.credentials.deviceId), key); assert.equal(app.store.getPairingRequest(request.id), undefined);
  unavailable = true;
  const missing = await discovery.sync(config); assert.equal(missing.available, false); assert.deepEqual(missing.suggestions, []);
  assert.equal(app.store.discoveryKey(config.credentials.deviceId), undefined);
  unavailable = false; profile = { id: '', email: '' };
  assert.equal((await discovery.sync(config)).available, false);
  profile = { id: 'stable-account', email: 'teacher@example.org' }; await discovery.sync(config);
  await discovery.setEnabled(false); const disabled = await discovery.sync(config);
  assert.equal(disabled.enabled, false); assert.equal(disabled.email, undefined); assert.equal(app.store.discoveryKey(config.credentials.deviceId), undefined);
  assert.equal(app.store.arePeers(config.credentials.deviceId, peer.deviceId), false);
});

test('unavailable identity APIs do not prevent manual setup', async t => {
  const values: Record<string, unknown> = {};
  const api = { storage: { local: { get: async (key: string) => ({ [key]: values[key] }), set: async (patch: Record<string, unknown>) => { Object.assign(values, patch); } } } } as unknown as typeof chrome;
  const discovery = new ProfileDiscovery(api); await discovery.setEnabled(true);
  assert.equal((await discovery.sync(undefined)).available, false);
  const dir = await mkdtemp(join(tmpdir(), 'discovery-missing-')); const app = createApp({ dataDir: dir }); const address = await app.listen(0);
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const state = await discovery.sync({ backendUrl: address.url, credentials: app.store.register('A') });
  assert.equal(state.available, false); assert.deepEqual(state.requests, []);
});


test('an older backend reports discovery failure without failing the UI state', async t => {
  const { createServer } = await import('node:http');
  const server = createServer((_req, res) => { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Endpoint not found' })); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); t.after(() => new Promise<void>(done => server.close(() => done())));
  const values: Record<string, unknown> = {};
  const api = { storage: { local: { get: async (key: string) => ({ [key]: values[key] }), set: async (patch: Record<string, unknown>) => { Object.assign(values, patch); } } }, identity: { getProfileUserInfo: async () => ({ id: 'account', email: 'teacher@example.org' }) } } as unknown as typeof chrome;
  const discovery = new ProfileDiscovery(api); await discovery.setEnabled(true);
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const state = await discovery.sync({ backendUrl: `http://127.0.0.1:${address.port}`, credentials: { deviceId: 'test', token: 'x'.repeat(43) } });
  assert.equal(state.enabled, true); assert.match(state.error!, /still use a pairing code/);
  assert.deepEqual(state.suggestions, []); assert.deepEqual(state.requests, []);
});

test('uncertain first publication is cleared after opt-out or identity loss', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'discovery-uncertain-'));
  const app = createApp({ dataDir: dir }); const address = await app.listen(0);
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const config = { backendUrl: address.url, credentials: app.store.register('A') };
  const values: Record<string, unknown> = {}; let id = 'account'; let loseResponse = true; let failWrite = false;
  const api = { storage: { local: {
    get: async (key: string) => ({ [key]: structuredClone(values[key]) }),
    set: async (patch: Record<string, unknown>) => {
      if (failWrite && 'discoveryPublished' in patch) throw new Error('Storage failed');
      Object.assign(values, structuredClone(patch));
    }
  } }, identity: { getProfileUserInfo: async () => ({ id, email: 'teacher@example.org' }) } } as unknown as typeof chrome;
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => {
    const response = await originalFetch(...args);
    if (args[1]?.method === 'PUT' && loseResponse) { loseResponse = false; throw new Error('Response lost after commit'); }
    return response;
  });
  const discovery = new ProfileDiscovery(api); await discovery.setEnabled(true);
  assert.match((await discovery.sync(config)).error!, /Cannot reach the backend/);
  assert.ok(app.store.discoveryKey(config.credentials.deviceId), 'server committed initial PUT');
  await discovery.setEnabled(false);
  assert.equal((await discovery.sync(config)).error, undefined);
  assert.equal(app.store.discoveryKey(config.credentials.deviceId), undefined, 'opt-out clears uncertain publication');
  await discovery.setEnabled(true); loseResponse = true;
  await discovery.sync(config); id = '';
  assert.equal((await discovery.sync(config)).available, false);
  assert.equal(app.store.discoveryKey(config.credentials.deviceId), undefined, 'identity loss clears uncertain publication');
  id = 'account'; failWrite = true;
  assert.match((await discovery.sync(config)).error!, /Storage failed/);
  assert.equal(app.store.discoveryKey(config.credentials.deviceId), undefined, 'do not publish without durable cleanup intent');
  failWrite = false; await discovery.sync(config);
  assert.ok(app.store.discoveryKey(config.credentials.deviceId));
  await discovery.setEnabled(false); loseResponse = true;
  assert.ok((await discovery.sync(config)).error);
  await discovery.sync(config);
  assert.equal(app.store.discoveryKey(config.credentials.deviceId), undefined, 'uncertain clearing is retried');
});


for (const previous of [undefined, false, true]) {
  test(`discovery automatically enables and migrates legacy preference ${previous}`, async () => {
    const values: Record<string, unknown> = previous === undefined ? {} : { discoveryEnabled: previous };
    const writes: Record<string, unknown>[] = [];
    const api = { storage: { local: {
      get: async (key: string) => ({ [key]: values[key] }),
      set: async (patch: Record<string, unknown>) => { writes.push(structuredClone(patch)); Object.assign(values, patch); }
    } } } as unknown as typeof chrome;
    const discovery = new ProfileDiscovery(api);
    assert.equal((await discovery.sync(undefined)).enabled, true);
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0], { discoveryEnabled: true, discoveryPreferencesVersion: 1 });
    assert.equal((await new ProfileDiscovery(api).sync(undefined)).enabled, true);
    assert.equal(writes.length, 1, 'migration is performed once');
    await discovery.setEnabled(false);
    assert.deepEqual(writes[1], { discoveryEnabled: false, discoveryPreferencesVersion: 1 });
    for (let restart = 0; restart < 3; restart++) assert.equal((await new ProfileDiscovery(api).sync(undefined)).enabled, false);
    assert.equal(writes.length, 2, 'later restarts preserve an explicit opt-out');
    await discovery.setEnabled(true);
    assert.equal((await new ProfileDiscovery(api).sync(undefined)).enabled, true);
  });
}

test('an explicit opt-out before first sync completes migration without re-enabling', async () => {
  const values: Record<string, unknown> = {};
  const api = { storage: { local: { get: async (key: string) => ({ [key]: values[key] }), set: async (patch: Record<string, unknown>) => { Object.assign(values, patch); } } } } as unknown as typeof chrome;
  await new ProfileDiscovery(api).setEnabled(false);
  assert.equal((await new ProfileDiscovery(api).sync(undefined)).enabled, false);
  assert.equal(values.discoveryPreferencesVersion, 1);
});

test('advanced opt-out clears pending requests and preserves already paired browsers', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'discovery-optout-')); const app = createApp({ dataDir: dir }); const address = await app.listen(0);
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const credentials = app.store.register('A'); const config = { backendUrl: address.url, credentials };
  const values: Record<string, unknown> = {};
  const api = { storage: { local: { get: async (key: string) => ({ [key]: values[key] }), set: async (patch: Record<string, unknown>) => { Object.assign(values, patch); } } }, identity: { getProfileUserInfo: async () => ({ id: 'account', email: 'teacher@example.org' }) } } as unknown as typeof chrome;
  const discovery = new ProfileDiscovery(api); await discovery.sync(config);
  const key = app.store.discoveryKey(credentials.deviceId)!; assert.ok(key);
  const peer = app.store.register('Paired'); const pending = app.store.register('Pending');
  app.store.setDiscovery(peer.deviceId, key); app.store.setDiscovery(pending.deviceId, key);
  const first = app.store.requestPairing(credentials.deviceId, peer.deviceId, Date.now() + 300000, Date.now());
  app.store.resolvePairing(first.id, peer.deviceId, true, Date.now());
  const request = app.store.requestPairing(pending.deviceId, credentials.deviceId, Date.now() + 300000, Date.now());
  await discovery.setEnabled(false); await discovery.sync(config);
  assert.equal(app.store.discoveryKey(credentials.deviceId), undefined);
  assert.equal(app.store.getPairingRequest(request.id), undefined);
  assert.equal(app.store.arePeers(credentials.deviceId, peer.deviceId), true);
  await new ProfileDiscovery(api).sync(config);
  assert.equal(app.store.discoveryKey(credentials.deviceId), undefined);
});
