import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { createApp } from '../server/app.js';
import { readConfig } from '../server/config.js';
import type { AppConfig } from '../server/config.js';
import type { Credentials, ServerMessage, Workspace } from '../shared/protocol.js';

const workspace: Workspace = { version: 1, tabs: [{ url: 'https://example.org/lesson', active: true, pinned: false, groupId: null }], groups: [] };
async function fixture(t: TestContext, config: Partial<AppConfig> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'handoff-test-'));
  const app = createApp({ dataDir, ...config });
  const address = await app.listen(0);
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const api = async (path: string, credentials?: Credentials, method = 'GET', body?: unknown) => {
    const response = await fetch(`${address.url}${path}`, { method, headers: { ...(credentials ? { Authorization: `Bearer ${credentials.token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  const register = async (name: string): Promise<Credentials> => {
    const result = await api('/api/devices/register', undefined, 'POST', { name });
    assert.equal(result.status, 201);
    return result.body;
  };
  const pair = async (a: Credentials, b: Credentials) => {
    const code = await api('/api/pairings', a, 'POST');
    assert.equal(code.status, 201);
    const claim = await api('/api/pairings/claim', b, 'POST', { code: code.body.code });
    assert.equal(claim.status, 200);
    return code.body.code as string;
  };
  const clients: WebSocket[] = [];
  t.after(() => { for (const client of clients) client.terminate(); });
  const connect = async (credentials?: Credentials) => {
    const socket = new WebSocket(`${address.url.replace('http:', 'ws:')}/ws`);
    const messages: ServerMessage[] = [];
    const waiters: Array<{ predicate: (message: ServerMessage) => boolean; resolve: (message: ServerMessage) => void }> = [];
    socket.on('message', data => {
      const message = JSON.parse(data.toString()) as ServerMessage;
      const index = waiters.findIndex(waiter => waiter.predicate(message));
      if (index >= 0) waiters.splice(index, 1)[0]!.resolve(message); else messages.push(message);
    });
    clients.push(socket);
    await once(socket, 'open');
    const next = async (predicate: (message: ServerMessage) => boolean): Promise<ServerMessage> => {
      const index = messages.findIndex(predicate);
      if (index >= 0) return messages.splice(index, 1)[0]!;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for server message; received ${JSON.stringify(messages)}`)), 2000);
        waiters.push({ predicate, resolve: message => { clearTimeout(timer); resolve(message); } });
      });
    };
    if (credentials) { socket.send(JSON.stringify({ type: 'authenticate', ...credentials })); await next(message => message.type === 'ready'); }
    return { socket, next };
  };
  return { app, api, register, pair, connect, dataDir };
}

test('registers credential hashes, authenticates API and exposes only paired devices', async t => {
  const f = await fixture(t); const a = await f.register(' Teacher laptop '); const b = await f.register('Display'); const c = await f.register('Other teacher');
  assert.match(a.deviceId, /^[a-f0-9-]{36}$/); assert.ok(a.token.length >= 40);
  assert.equal((await f.api('/api/devices')).status, 401);
  assert.equal((await f.api('/api/devices', { ...a, token: 'invalid' })).status, 401);
  assert.deepEqual((await f.api('/api/devices', a)).body.devices, []);
  await f.pair(a, b);
  const peers = (await f.api('/api/devices', a)).body.devices;
  assert.equal(peers.length, 1); assert.equal(peers[0].id, b.deviceId); assert.equal(peers[0].online, false);
  assert.equal((await f.api('/api/devices', c)).body.devices.length, 0);
  assert.equal((await f.api('/api/device', a, 'PATCH', { name: 'New name' })).body.device.name, 'New name');
  assert.equal((await f.api('/api/device', a, 'PATCH', { name: ' ' })).status, 400);
  const bytes = await readFile(join(f.dataDir, 'handoff.sqlite'));
  assert.equal(bytes.includes(Buffer.from(a.token)), false);
});

test('pairing codes are single-use, expire, and cannot pair a device with itself', async t => {
  let now = 1000; const f = await fixture(t, { now: () => now, pairingTtlMs: 100 });
  const a = await f.register('A'); const b = await f.register('B'); const c = await f.register('C');
  const code = await f.pair(a, b); assert.match(code, /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
  assert.equal((await f.api('/api/pairings/claim', c, 'POST', { code })).status, 400);
  const own = (await f.api('/api/pairings', a, 'POST')).body;
  assert.equal((await f.api('/api/pairings/claim', a, 'POST', { code: own.code })).status, 400);
  now += 101;
  assert.equal((await f.api('/api/pairings/claim', c, 'POST', { code: own.code })).status, 400);
});

test('delivers handoffs, rejects forged acknowledgements, deduplicates requests and purges payloads', async t => {
  const f = await fixture(t); const a = await f.register('A'); const b = await f.register('B'); const c = await f.register('C');
  await f.pair(a, b); const sa = await f.connect(a); const sb = await f.connect(b); const sc = await f.connect(c);
  const request = { requestId: randomUUID(), destinationId: b.deviceId, workspace };
  const sent = await f.api('/api/handoffs', a, 'POST', request); assert.equal(sent.status, 201);
  const message = await sb.next(message => message.type === 'handoff'); assert.equal(message.type, 'handoff'); if (message.type !== 'handoff') return;
  assert.deepEqual(message.command.workspace, workspace); assert.equal(message.command.sourceName, 'A');
  assert.equal((await f.api('/api/handoffs', a, 'POST', request)).body.command.id, sent.body.command.id);
  assert.equal((await f.api('/api/handoffs', a, 'POST', { ...request, requestId: randomUUID() })).status, 409);
  assert.equal((await f.api('/api/handoffs', c, 'POST', { ...request, requestId: randomUUID() })).status, 403);
  assert.equal((await f.api(`/api/handoffs/${sent.body.command.id}`, c)).status, 404);
  sc.socket.send(JSON.stringify({ type: 'ack', commandId: sent.body.command.id, status: 'applied' }));
  await sc.next(message => message.type === 'error');
  assert.equal((await f.api(`/api/handoffs/${sent.body.command.id}`, a)).body.command.status, 'pending');
  sb.socket.send(JSON.stringify({ type: 'ack', commandId: sent.body.command.id, status: 'applied', warnings: ['A supported limitation'] }));
  const updated = await sa.next(message => message.type === 'command_updated'); assert.equal(updated.type, 'command_updated');
  if (updated.type === 'command_updated') { assert.equal(updated.command.status, 'applied'); assert.deepEqual(updated.command.warnings, ['A supported limitation']); }
  assert.equal(f.app.store.getCommand(sent.body.command.id)?.payload, null);
  sb.socket.send(JSON.stringify({ type: 'ack', commandId: sent.body.command.id, status: 'failed' }));
  assert.equal((await f.api(`/api/handoffs/${sent.body.command.id}`, a)).body.command.status, 'applied');
  assert.equal((await f.api('/api/handoffs', a, 'POST', request)).body.command.id, sent.body.command.id);
  assert.equal((await f.api('/api/handoffs', a, 'POST', { ...request, workspace: { ...workspace, tabs: [{ ...workspace.tabs[0], url: 'https://different.test' }] } })).status, 409);
});

test('offline sends fail visibly and pending commands redeliver after reconnect then expire', async t => {
  let now = 1000; const f = await fixture(t, { now: () => now, commandTtlMs: 100, retentionMs: 200 });
  const a = await f.register('A'); const b = await f.register('B'); await f.pair(a, b);
  const request = { requestId: randomUUID(), destinationId: b.deviceId, workspace };
  assert.equal((await f.api('/api/handoffs', a, 'POST', request)).status, 409);
  const first = await f.connect(b);
  const sent = await f.api('/api/handoffs', a, 'POST', request); assert.equal(sent.status, 201);
  await first.next(message => message.type === 'handoff');
  first.socket.close(); await once(first.socket, 'close');
  const second = await f.connect(b); const redelivered = await second.next(message => message.type === 'handoff');
  assert.equal(redelivered.type, 'handoff'); if (redelivered.type === 'handoff') assert.equal(redelivered.command.id, sent.body.command.id);
  now += 101; f.app.sweep();
  assert.equal((await f.api(`/api/handoffs/${sent.body.command.id}`, a)).body.command.status, 'expired');
  assert.equal(f.app.store.getCommand(sent.body.command.id)?.payload, null);
  now += 201; f.app.sweep();
  assert.equal((await f.api(`/api/handoffs/${sent.body.command.id}`, a)).status, 404);
});

test('backend restart retains credentials, peers and pending commands with sockets initially offline', async t => {
  const f = await fixture(t); const a = await f.register('A'); const b = await f.register('B'); await f.pair(a, b);
  const receiver = await f.connect(b); const sent = await f.api('/api/handoffs', a, 'POST', { requestId: randomUUID(), destinationId: b.deviceId, workspace });
  await receiver.next(message => message.type === 'handoff'); await f.app.close();
  const restarted = createApp({ dataDir: f.dataDir }); const address = await restarted.listen(0); t.after(() => restarted.close());
  const response = await fetch(`${address.url}/api/devices`, { headers: { Authorization: `Bearer ${a.token}` } });
  const peers = (await response.json() as any).devices; assert.equal(peers[0].online, false); assert.equal(peers[0].id, b.deviceId);
  const socket = new WebSocket(`${address.url.replace('http:', 'ws:')}/ws`); t.after(() => socket.terminate());
  const handoff = new Promise<any>(resolve => socket.on('message', bytes => { const message = JSON.parse(bytes.toString()); if (message.type === 'handoff') resolve(message); }));
  await once(socket, 'open'); socket.send(JSON.stringify({ type: 'authenticate', ...b }));
  assert.equal((await handoff).command.id, sent.body.command.id);
});

test('peer removal cancels pending transfers and device revocation invalidates tokens and sockets', async t => {
  const f = await fixture(t); const a = await f.register('A'); const b = await f.register('B'); await f.pair(a, b); const sb = await f.connect(b);
  const sent = await f.api('/api/handoffs', a, 'POST', { requestId: randomUUID(), destinationId: b.deviceId, workspace }); await sb.next(message => message.type === 'handoff');
  assert.equal((await f.api(`/api/peers/${b.deviceId}`, a, 'DELETE')).status, 200);
  assert.deepEqual((await f.api('/api/devices', a)).body.devices, []);
  assert.equal((await f.api(`/api/handoffs/${sent.body.command.id}`, a)).body.command.status, 'failed');
  const closed = once(sb.socket, 'close'); assert.equal((await f.api('/api/device', b, 'DELETE')).status, 200); await closed;
  assert.equal((await f.api('/api/devices', b)).status, 401);
});

test('rejects invalid, unauthenticated and stale sockets, malformed payloads, and rate limits registration/pairing', async t => {
  let now = 1000; const f = await fixture(t, { now: () => now, authTimeoutMs: 30, heartbeatTimeoutMs: 50, registrationLimit: 3, pairingAttemptLimit: 3 });
  const a = await f.register('A'); const b = await f.register('B');
  const unauthenticated = await f.connect(); await once(unauthenticated.socket, 'close');
  const bad = await f.connect(); const badClose = once(bad.socket, 'close'); bad.socket.send(JSON.stringify({ type: 'authenticate', ...a, token: 'forged' })); await badClose;
  const stale = await f.connect(a); const staleClose = once(stale.socket, 'close'); now += 51; f.app.sweep(); await staleClose;
  await f.pair(a, b);
  for (let i = 0; i < 2; i++) assert.equal((await f.api('/api/pairings/claim', b, 'POST', { code: 'BAD' })).status, 400);
  assert.equal((await f.api('/api/pairings/claim', b, 'POST', { code: 'BAD' })).status, 429);
  assert.equal((await f.api('/api/devices/register', undefined, 'POST', { name: 'C' })).status, 201);
  assert.equal((await f.api('/api/devices/register', undefined, 'POST', { name: 'D' })).status, 429);
  assert.equal((await f.api('/api/handoffs', a, 'POST', { destinationId: b.deviceId, requestId: randomUUID(), workspace: { ...workspace, tabs: [{ ...workspace.tabs[0], url: 'javascript:alert(1)' }] } })).status, 400);
  assert.equal((await f.api('/api/handoffs', a, 'POST', { noise: 'x'.repeat(512 * 1024) })).status, 413);
});

test('secure public URL configuration requires HTTPS outside localhost and validates numeric settings', () => {
  assert.throws(() => readConfig({ PUBLIC_URL: 'http://school.example' }), /HTTPS/);
  assert.throws(() => readConfig({ PORT: 'NaN' }), /PORT/);
  assert.equal(readConfig({ PUBLIC_URL: 'https://school.example' }).publicUrl, 'https://school.example');
  assert.equal(readConfig({ PUBLIC_URL: 'http://localhost:8787' }).publicUrl, 'http://localhost:8787');
});

test('WebSocket readiness drives presence, application heartbeats work, and credential identity must match', async t => {
  let now = 1000; const f = await fixture(t, { now: () => now }); const a = await f.register('A'); const b = await f.register('B'); await f.pair(a, b);
  const mismatched = await f.connect(); const mismatchClose = once(mismatched.socket, 'close');
  mismatched.socket.send(JSON.stringify({ type: 'authenticate', deviceId: b.deviceId, token: a.token }));
  assert.equal((await mismatchClose)[0], 4003);
  const sa = await f.connect(a); const sb = await f.connect(b);
  await sa.next(message => message.type === 'devices_changed');
  assert.equal((await f.api('/api/devices', a)).body.devices[0].online, true);
  now += 100; sb.socket.send(JSON.stringify({ type: 'ping' })); await sb.next(message => message.type === 'pong');
  assert.equal((await f.api('/api/devices', a)).body.devices[0].lastSeen, 1100);
  sb.socket.close(); await once(sb.socket, 'close');
  assert.equal((await f.api('/api/devices', a)).body.devices[0].online, false);
});

test('expiry notifies the sender, late acknowledgements cannot apply, and payload bytes are purged from disk', async t => {
  let now = 1000; const f = await fixture(t, { now: () => now, commandTtlMs: 50 });
  const a = await f.register('A'); const b = await f.register('B'); await f.pair(a, b); const sa = await f.connect(a); const sb = await f.connect(b);
  const privateUrl = 'https://example.org/unique-sensitive-lesson-resource-52969872';
  const sent = await f.api('/api/handoffs', a, 'POST', { requestId: randomUUID(), destinationId: b.deviceId, workspace: { ...workspace, tabs: [{ url: privateUrl, active: true, pinned: false, groupId: null }] } });
  await sb.next(message => message.type === 'handoff'); now += 51; f.app.sweep();
  const expired = await sa.next(message => message.type === 'command_updated');
  assert.equal(expired.type === 'command_updated' && expired.command.status, 'expired');
  sb.socket.send(JSON.stringify({ type: 'ack', commandId: sent.body.command.id, status: 'applied' }));
  assert.equal((await f.api(`/api/handoffs/${sent.body.command.id}`, a)).body.command.status, 'expired');
  assert.equal((await readFile(join(f.dataDir, 'handoff.sqlite'))).includes(Buffer.from(privateUrl)), false);
  assert.equal((await readFile(join(f.dataDir, 'handoff.sqlite-wal'))).includes(Buffer.from(privateUrl)), false);
});

test('HTTP rejects unsupported media types and invalid JSON without exposing credentials', async t => {
  const f = await fixture(t); const address = f.app.server.address(); assert.ok(address && typeof address !== 'string'); const url = `http://127.0.0.1:${address.port}`;
  const plain = await fetch(`${url}/api/devices/register`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"name":"A"}' }); assert.equal(plain.status, 415);
  const malformed = await fetch(`${url}/api/devices/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken' }); assert.equal(malformed.status, 400);
  const health = await fetch(`${url}/healthz`); assert.equal(health.status, 200); assert.deepEqual(await health.json(), { ok: true });
});

test('rejects a workspace whose delivered envelope would exceed the receiver message limit', async t => {
  const f = await fixture(t); const a = await f.register('A'); const b = await f.register('B'); await f.pair(a, b); await f.connect(b);
  const tabs = Array.from({ length: 64 }, (_, index) => ({ url: `https://example.org/${'x'.repeat(8172)}`, active: index === 0, pinned: false, groupId: null }));
  const request = { requestId: randomUUID(), destinationId: b.deviceId, workspace: { version: 1, tabs, groups: [] } };
  const excess = Buffer.byteLength(JSON.stringify(request)) - (512 * 1024 - 1);
  tabs[63]!.url = tabs[63]!.url.slice(0, -excess);
  assert.equal(Buffer.byteLength(JSON.stringify(request)), 512 * 1024 - 1);
  const result = await f.api('/api/handoffs', a, 'POST', request);
  assert.equal(result.status, 413);
});


test('short codes normalize whitespace and case, and legacy codes remain claimable', async t => {
  const f = await fixture(t); const a = await f.register('A'); const b = await f.register('B');
  const code = (await f.api('/api/pairings', a, 'POST')).body.code;
  assert.match(code, /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
  assert.equal((await f.api('/api/pairings/claim', b, 'POST', { code: '  ' + code.toLowerCase().replace('-', ' - ') + '  ' })).status, 200);
  const { digest } = await import('../server/store.js');
  f.app.store.db.prepare('INSERT INTO pairings VALUES(?,?,?)').run(digest('ABCDEF123456789012'), a.deviceId, Date.now() + 300000);
  assert.equal((await f.api('/api/pairings/claim', b, 'POST', { code: 'ABCDEF-123456-789012' })).status, 200);
});

test('discovery is opt-in and exposes only matching online unpaired browsers without account keys', async t => {
  const f = await fixture(t); const a = await f.register('A'); const b = await f.register('B'); const c = await f.register('C');
  await f.connect(a); await f.connect(b); await f.connect(c);
  const key = 'a'.repeat(64);
  assert.equal((await f.api('/api/discovery', undefined)).status, 401);
  assert.deepEqual((await f.api('/api/discovery', a)).body.suggestions, []);
  assert.equal((await f.api('/api/discovery', a, 'PUT', { accountKey: key })).status, 200);
  assert.deepEqual((await f.api('/api/discovery', a)).body.suggestions, []);
  await f.api('/api/discovery', b, 'PUT', { accountKey: key });
  await f.api('/api/discovery', c, 'PUT', { accountKey: 'c'.repeat(64) });
  const discovery = await f.api('/api/discovery', a);
  assert.deepEqual(discovery.body.suggestions.map((d: any) => d.id), [b.deviceId]);
  assert.equal(JSON.stringify(discovery.body).includes(key), false);
  assert.equal((await f.api('/api/discovery', a, 'PUT', { accountKey: 'email@example.org' })).status, 400);
  await f.pair(a, b);
  assert.deepEqual((await f.api('/api/discovery', a)).body.suggestions, []);
});

test('Easy pair requires receiver approval, deduplicates requests, and consumes acceptance atomically', async t => {
  const f = await fixture(t); const a = await f.register('A'); const b = await f.register('B'); const c = await f.register('C');
  await f.connect(a); await f.connect(b); await f.connect(c);
  for (const device of [a, b, c]) await f.api('/api/discovery', device, 'PUT', { accountKey: 'a'.repeat(64) });
  const create = () => f.api('/api/pairing-requests', a, 'POST', { destinationId: b.deviceId });
  const created = await create(); assert.equal(created.status, 201);
  const id = created.body.request.id;
  assert.equal((await create()).body.request.id, id);
  assert.equal((await f.api('/api/pairing-requests', b, 'POST', { destinationId: a.deviceId })).body.request.id, id);
  assert.equal((await f.api('/api/pairing-requests', b)).body.requests[0].source.name, 'A');
  assert.deepEqual((await f.api('/api/devices', a)).body.devices, []);
  assert.equal((await f.api('/api/handoffs', a, 'POST', { destinationId: b.deviceId, requestId: randomUUID(), workspace })).status, 403);
  for (const unauthorized of [a, c]) assert.equal((await f.api(`/api/pairing-requests/${id}/accept`, unauthorized, 'POST')).status, 404);
  const results = await Promise.all([0, 1].map(() => f.api(`/api/pairing-requests/${id}/accept`, b, 'POST')));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 404]);
  assert.equal((await f.api('/api/devices', a)).body.devices[0].id, b.deviceId);
  assert.deepEqual((await f.api('/api/pairing-requests', b)).body.requests, []);
});

test('Easy pair handles decline, expiry, changed accounts, disabling, offline targets and revocation', async t => {
  let now = 1000; const f = await fixture(t, { now: () => now, pairingTtlMs: 100, pairingCreationLimit: 30 });
  const a = await f.register('A'); const b = await f.register('B'); const c = await f.register('C');
  await f.connect(a); const sb = await f.connect(b);
  const key = 'a'.repeat(64);
  const enable = async (device: Credentials, accountKey: string | null = key) => f.api('/api/discovery', device, 'PUT', { accountKey });
  await enable(a); await enable(b); await enable(c);
  const create = async () => { const r = await f.api('/api/pairing-requests', a, 'POST', { destinationId: b.deviceId }); assert.equal(r.status, 201); return r.body.request.id; };
  const accept = (id: string) => f.api(`/api/pairing-requests/${id}/accept`, b, 'POST');
  assert.equal((await f.api('/api/pairing-requests', a, 'POST', { destinationId: a.deviceId })).status, 409);
  assert.equal((await f.api('/api/pairing-requests', a, 'POST', { destinationId: c.deviceId })).status, 409);
  let id = await create();
  assert.equal((await f.api(`/api/pairing-requests/${id}/decline`, b, 'POST')).status, 200); assert.equal((await accept(id)).status, 404);
  id = await create(); now += 101; assert.equal((await accept(id)).status, 404);
  id = await create(); await enable(b, 'b'.repeat(64)); assert.equal((await accept(id)).status, 404);
  assert.deepEqual((await f.api('/api/discovery', a)).body.suggestions, []);
  await enable(b); id = await create(); await enable(b, null); assert.equal((await accept(id)).status, 404);
  await enable(b); id = await create(); await f.api('/api/device', a, 'DELETE'); assert.equal((await accept(id)).status, 404);
  sb.socket.close(); await once(sb.socket, 'close');
  assert.deepEqual((await f.api('/api/discovery', c)).body.suggestions, []);
});

test('Easy pair shares the manual pairing creation and attempt rate limits', async t => {
  const f = await fixture(t, { pairingCreationLimit: 1, pairingAttemptLimit: 1 });
  const a = await f.register('A'); const b = await f.register('B'); await f.connect(a); await f.connect(b);
  for (const device of [a, b]) await f.api('/api/discovery', device, 'PUT', { accountKey: 'a'.repeat(64) });
  const request = await f.api('/api/pairing-requests', a, 'POST', { destinationId: b.deviceId }); assert.equal(request.status, 201);
  assert.equal((await f.api('/api/pairings', a, 'POST')).status, 429);
  assert.equal((await f.api('/api/pairings/claim', b, 'POST', { code: 'BAD' })).status, 400);
  assert.equal((await f.api(`/api/pairing-requests/${request.body.request.id}/accept`, b, 'POST')).status, 429);
});

test('short-code collision retries preserve other browsers codes', async t => {
  const { Store } = await import('../server/store.js');
  const dir = await mkdtemp(join(tmpdir(), 'pairing-collision-'));
  const candidates = ['23456789', '23456789', 'ABCDEFGH', 'JKLMNPQR'];
  const store = new Store(dir, () => candidates.shift()!);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const a = store.register('A'); const b = store.register('B'); const c = store.register('C');
  assert.equal(store.createPairing(a.deviceId, 100), '2345-6789');
  assert.equal(store.createPairing(b.deviceId, 100), 'ABCD-EFGH');
  assert.equal(store.claimPairing('23456789', c.deviceId, 1), a.deviceId);
  assert.equal(store.claimPairing('ABCDEFGH', c.deviceId, 1), b.deviceId);
  const old = store.createPairing(a.deviceId, 100);
  assert.equal(old, 'JKLM-NPQR');
});

test('discovery and pending requests survive restart while disabling discovery preserves existing peers', async t => {
  const f = await fixture(t); const a = await f.register('A'); const b = await f.register('B');
  const key = 'a'.repeat(64); f.app.store.setDiscovery(a.deviceId, key); f.app.store.setDiscovery(b.deviceId, key);
  const request = f.app.store.requestPairing(a.deviceId, b.deviceId, Date.now() + 300000, Date.now());
  await f.app.close();
  const restarted = createApp({ dataDir: f.dataDir }); t.after(() => restarted.close());
  assert.equal(restarted.store.discoveryKey(a.deviceId), key);
  assert.equal(restarted.store.pairingRequests(b.deviceId, Date.now())[0]?.id, request.id);
  assert.ok(restarted.store.resolvePairing(request.id, b.deviceId, true, Date.now()));
  restarted.store.setDiscovery(a.deviceId, null); restarted.store.setDiscovery(b.deviceId, null);
  assert.equal(restarted.store.arePeers(a.deviceId, b.deviceId), true);
});
