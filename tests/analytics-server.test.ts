import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app.js';
async function fixture(t: TestContext) {
  let now = Date.UTC(2026, 10, 13, 18); const key = 'k'.repeat(64);
  const dir = await mkdtemp(join(tmpdir(), 'handoff-analytics-'));
  const app = createApp({ dataDir: dir, analyticsAdminKey: key, analyticsEnabled: true, analyticsRetentionDays: 180, now: () => now });
  const address = await app.listen(0); app.config.publicUrl = address.url;
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const api = (path: string, options: RequestInit = {}) => fetch(address.url + path, { ...options, headers: { 'Content-Type': 'application/json', Origin: address.url, ...options.headers } });
  const login = async () => { const res = await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ key }) }); assert.equal(res.status, 200); return res.headers.get('set-cookie')!.split(';')[0]!; };
  const a = app.store.register('=Teacher'); const b = app.store.register('Display');
  return { app, api, login, a, b, key, dir, now, advance: (ms: number) => { now += ms; } };
}
test('admin authentication is separate from devices, uses protected expiring cookies, and validates origins', async t => {
  const f = await fixture(t);
  assert.equal((await f.api('/api/admin/analytics?from=2026-11-13&to=2026-11-13', { headers: { Authorization: `Bearer ${f.a.token}` } })).status, 401);
  assert.equal((await f.api('/api/admin/login', { method: 'POST', headers: { Origin: 'https://attacker.example' }, body: JSON.stringify({ key: f.key }) })).status, 403);
  assert.equal((await f.api('/api/admin/login', { method: 'POST', body: JSON.stringify({ key: 'incorrect' }) })).status, 401);
  const response = await f.api('/api/admin/login', { method: 'POST', body: JSON.stringify({ key: f.key }) }); const header = response.headers.get('set-cookie')!;
  assert.match(header, /HttpOnly/); assert.match(header, /SameSite=Strict/); assert.match(header, /Max-Age=28800/); assert.equal(header.includes(f.key), false);
  const cookie = header.split(';')[0]!;
  assert.equal((await f.api('/api/admin/analytics?from=2026-11-13&to=2026-11-13', { headers: { Cookie: cookie } })).status, 200);
  f.advance(8 * 3600000 + 1);
  assert.equal((await f.api('/api/admin/analytics', { headers: { Cookie: cookie } })).status, 401);
  const fresh = await f.login();
  assert.equal((await f.api('/api/admin/logout', { method: 'POST', body: '{}', headers: { Cookie: fresh } })).status, 200);
  assert.equal((await f.api('/api/admin/analytics', { headers: { Cookie: fresh } })).status, 401);
});
test('analytics capabilities/ingestion are device-authenticated and reject arbitrary sensitive fields', async t => {
  const f = await fixture(t); const headers = { Authorization: `Bearer ${f.a.token}` };
  assert.equal((await f.api('/api/analytics/capabilities')).status, 401);
  assert.deepEqual(await (await f.api('/api/analytics/capabilities', { headers })).json(), { enabled: true, version: 1 });
  assert.equal((await f.api('/api/analytics/client', { method: 'POST', headers, body: JSON.stringify({ version: '0.2.4', platform: 'cros', email: 'private@example.org' }) })).status, 400);
  assert.equal((await f.api('/api/analytics/client', { method: 'POST', headers, body: JSON.stringify({ version: '0.2.4', platform: 'cros' }) })).status, 200);
  const event = { id: 'cf95a222-e008-4f93-a684-32bbb497720c', type: 'capture_failed', reason: 'tab_unsupported', occurredAt: f.now };
  for (let i = 0; i < 2; i++) assert.equal((await f.api('/api/analytics/events', { method: 'POST', headers, body: JSON.stringify({ events: [event] }) })).status, 200);
  const cookie = await f.login(); const data = await (await f.api('/api/admin/analytics?from=2026-11-13&to=2026-11-13', { headers: { Cookie: cookie } })).json() as any;
  assert.equal(data.summary.captureFailures, 1); assert.equal(data.browsers.find((b: any) => b.id === f.a.deviceId).version, '0.2.4');
});
test('handoff analytics survive operational retention, omit sensitive URLs, and exports are protected/safe', async t => {
  const f = await fixture(t); const privateUrl = 'https://example.org/private-analytics-canary?secret=never-collect';
  const workspace = { version: 1 as const, tabs: [{ url: privateUrl, active: true, pinned: false, groupId: null }], groups: [] };
  const command = f.app.store.createCommand(f.a.deviceId, f.b.deviceId, 'req', workspace, 'hash', f.now, f.now + 1000, { mode: 'current-tab', platform: 'cros', version: '0.2.4' });
  f.app.store.complete(command.id, 'applied', f.now + 150, null, [privateUrl]); f.app.store.complete(command.id, 'failed', f.now + 200, privateUrl, []);
  f.advance(2 * 86400000); f.app.sweep(); assert.equal(f.app.store.getCommand(command.id), undefined);
  const cookie = await f.login(); const query = '?from=2026-11-13&to=2026-11-13';
  const data = await (await f.api('/api/admin/analytics' + query, { headers: { Cookie: cookie } })).json() as any;
  assert.equal(data.summary.handoffs, 1); assert.equal(data.summary.applied, 1); assert.equal(data.summary.medianConfirmationMs, 150);
  const csv = await f.api('/api/admin/analytics.csv' + query + '&report=browsers', { headers: { Cookie: cookie } });
  assert.match(csv.headers.get('content-type')!, /text\/csv/); const text = await csv.text(); assert.ok(text.includes("'=Teacher"));
  for (const content of [JSON.stringify(data), text]) { assert.equal(content.includes(privateUrl), false); assert.equal(content.includes(f.a.token), false); }
  assert.equal((await f.api('/api/admin/analytics.csv' + query + '&report=daily')).status, 401);
  assert.equal((await f.api('/api/admin/analytics?from=2026-02-30&to=2026-11-13', { headers: { Cookie: cookie } })).status, 400);
  assert.equal((await f.api('/api/admin/analytics.csv' + query + '&report=secrets', { headers: { Cookie: cookie } })).status, 400);
});
test('login attempts are rate limited', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 5; i++) assert.equal((await f.api('/api/admin/login', { method: 'POST', body: '{"key":"bad"}' })).status, 401);
  assert.equal((await f.api('/api/admin/login', { method: 'POST', body: JSON.stringify({ key: f.key }) })).status, 429);
});

test('configuration keeps analytics off without a key and caps retained usage at 180 days', async () => {
  const { readConfig } = await import('../server/config.js');
  assert.equal(readConfig({}).analyticsEnabled, false);
  assert.equal(readConfig({ ANALYTICS_ADMIN_KEY: 'k'.repeat(64) }).analyticsEnabled, true);
  assert.equal(readConfig({ ANALYTICS_ADMIN_KEY: 'k'.repeat(64), ANALYTICS_ENABLED: 'false' }).analyticsEnabled, false);
  assert.throws(() => readConfig({ ANALYTICS_ADMIN_KEY: 'short' }), /key|KEY/);
  assert.throws(() => readConfig({ ANALYTICS_RETENTION_DAYS: '181' }), /RETENTION/);
});


test('new pairings are counted once and a later re-pair uses its actual method', async t => {
  const f = await fixture(t);
  const source = { Authorization: `Bearer ${f.a.token}` }; const destination = { Authorization: `Bearer ${f.b.token}` };
  for (let i = 0; i < 2; i++) {
    const generated = await (await f.api('/api/pairings', { method: 'POST', headers: source, body: '{}' })).json() as { code: string };
    assert.equal((await f.api('/api/pairings/claim', { method: 'POST', headers: destination, body: JSON.stringify({ code: generated.code }) })).status, 200);
  }
  f.app.store.removePeer(f.a.deviceId, f.b.deviceId, f.now);
  f.app.store.setDiscovery(f.a.deviceId, 'a'.repeat(64)); f.app.store.setDiscovery(f.b.deviceId, 'a'.repeat(64));
  const request = f.app.store.requestPairing(f.a.deviceId, f.b.deviceId, f.now + 300000, f.now);
  assert.ok(f.app.store.resolvePairing(request.id, f.b.deviceId, true, f.now));
  assert.equal(f.app.store.resolvePairing(request.id, f.b.deviceId, true, f.now), undefined);
  assert.deepEqual(f.app.store.analytics.report('2026-11-13', '2026-11-13').pairings, { code: 1, easyPair: 1 });
});
test('analytics survive backend restart but administrator sessions do not', async t => {
  const f = await fixture(t); const cookie = await f.login();
  const workspace = { version: 1 as const, tabs: [{ url: 'https://example.org/', active: true, pinned: false, groupId: null }], groups: [] };
  const command = f.app.store.createCommand(f.a.deviceId, f.b.deviceId, 'restart-request', workspace, 'hash', f.now, f.now + 1000);
  f.app.store.complete(command.id, 'applied', f.now + 20, null, []);
  await f.app.close();
  const restart = createApp({ dataDir: f.dir, analyticsAdminKey: f.key, analyticsEnabled: true, now: () => f.now }); const address = await restart.listen(0); restart.config.publicUrl = address.url;
  t.after(() => restart.close());
  assert.equal((await fetch(address.url + '/api/admin/analytics', { headers: { Cookie: cookie } })).status, 401);
  assert.equal(restart.store.analytics.report('2026-11-13', '2026-11-13').summary.handoffs, 1);
});

test('HTTPS deployments issue Secure cookies', async t => {
  const f = await fixture(t); f.app.config.publicUrl = 'https://handoff.example.org';
  const login = await f.api('/api/admin/login', { method: 'POST', headers: { Origin: 'https://handoff.example.org' }, body: JSON.stringify({ key: f.key }) });
  assert.equal(login.status, 200); assert.match(login.headers.get('set-cookie')!, /; Secure/);
});


test('browser CSV export honors search while preserving the selected date range', async t => {
  const f = await fixture(t); const cookie = await f.login();
  const response = await f.api('/api/admin/analytics.csv?from=2026-11-13&to=2026-11-13&report=browsers&q=teacher', { headers: { Cookie: cookie } });
  assert.equal(response.status, 200); const csv = await response.text();
  assert.ok(csv.includes("'=Teacher")); assert.equal(csv.includes('Display'), false);
  assert.equal((await f.api('/api/admin/analytics.csv?report=browsers&q=' + 'x'.repeat(201), { headers: { Cookie: cookie } })).status, 400);
});
