import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { parseManagedPolicy } from '../extension/src/managed.js';
import { BackgroundController } from '../extension/src/background.js';

test('managed policy validates origin and types without accepting credentials or paths', () => {
  assert.deepEqual(parseManagedPolicy({ BackendUrl: 'https://handoff.example.org/', AutoRegister: false, DeviceName: 'Room display' }), { backendUrl: 'https://handoff.example.org', autoRegister: false, deviceName: 'Room display' });
  for (const value of [{ BackendUrl: 'http://school.example.org' }, { BackendUrl: 'https://user:secret@school.example.org' }, { BackendUrl: 'https://school.example.org/path' }, { AutoRegister: 'true' }, { DeviceName: '' }]) assert.throws(() => parseManagedPolicy(value));
  assert.deepEqual(parseManagedPolicy({}), { autoRegister: true });
});
function memory(policy: Record<string, unknown>) {
  const local: Record<string, unknown> = {}; const session: Record<string, unknown> = {};
  const area = (data: Record<string, unknown>) => ({
    get: async (keys?: string | string[]) => keys === undefined ? structuredClone(data) : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(data[key])])),
    set: async (patch: Record<string, unknown>) => { Object.assign(data, structuredClone(patch)); },
    remove: async (keys: string | string[]) => { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; }, setAccessLevel: async () => {}
  });
  const api = { storage: { local: area(local), session: area(session), managed: area(policy) }, alarms: { create: async () => {} }, permissions: { contains: async () => true } } as unknown as typeof chrome;
  return { api, local, policy };
}
async function fixture(holdFirstRegistration = false) {
  let releaseRegistration = () => {}; let registrationStarted!: () => void;
  const firstRegistration = new Promise<void>(resolve => { registrationStarted = resolve; });
  let registrations = 0;
  const id = 'b42056ea-26c6-4c5b-813c-14a4d25fa011';
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); if (req.url === '/api/devices/register') { registrations++; const send = () => res.end(JSON.stringify({ deviceId: id, token: 'x'.repeat(43) })); if (holdFirstRegistration && registrations === 1) { releaseRegistration = send; registrationStarted(); } else send(); } else res.end(JSON.stringify({ devices: [] })); });
  const ws = new WebSocketServer({ server }); ws.on('connection', socket => socket.on('message', raw => { const message = JSON.parse(raw.toString()); if (message.type === 'authenticate') socket.send(JSON.stringify({ type: 'ready', deviceId: id })); else socket.send(JSON.stringify({ type: 'pong' })); }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url, firstRegistration, releaseRegistration: () => releaseRegistration(), count: () => registrations, close: async () => { for (const socket of ws.clients) socket.terminate(); await new Promise<void>(resolve => ws.close(() => resolve())); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
test('managed install registers once, exposes locked backend and remains unpaired', async () => {
  const f = await fixture(); const m = memory({ BackendUrl: f.url, DeviceName: 'Managed room' }); const c = new BackgroundController(m.api);
  try {
    await c.start(); await c.recover();
    const result = await c.request({ action: 'state' }); assert.ok(result.ok); if (!result.ok) return;
    assert.equal(result.state?.configured, true); assert.equal(result.state?.managed, true); assert.equal(result.state?.managedBackendUrl, f.url); assert.equal(result.state?.name, 'Managed room'); assert.deepEqual(result.state?.devices, []); assert.equal(f.count(), 1);
    const override = await c.request({ action: 'configure', backendUrl: 'https://another.example.org', name: 'Override' }); assert.equal(override.ok, false);
  } finally { await c.request({ action: 'reset' }); await f.close(); }
});
test('AutoRegister false permits a named first registration only at the policy origin', async () => {
  const f = await fixture(); const m = memory({ BackendUrl: f.url, AutoRegister: false }); const c = new BackgroundController(m.api);
  try {
    await c.start(); assert.equal(f.count(), 0);
    const denied = await c.request({ action: 'configure', backendUrl: 'https://other.example.org', name: 'Room' }); assert.equal(denied.ok, false); assert.equal(f.count(), 0);
    const result = await c.request({ action: 'configure', backendUrl: f.url, name: 'Chosen room' }); assert.equal(result.ok, true); assert.equal(f.count(), 1);
  } finally { await c.request({ action: 'reset' }); await f.close(); }
});
test('invalid managed policy fails closed and never registers against an untrusted origin', async () => {
  const m = memory({ BackendUrl: 'http://untrusted.example.org' }); const c = new BackgroundController(m.api);
  await c.start(); const result = await c.request({ action: 'state' }); assert.ok(result.ok); if (result.ok) { assert.equal(result.state?.configured, false); assert.equal(result.state?.connected, false); assert.match(result.state?.lastError ?? '', /policy|HTTPS/i); } assert.equal(m.local.configuration, undefined);
});
test('managed backend changes stop the old connection without deleting identity or migrating peers', async () => {
  const f = await fixture(); const m = memory({ BackendUrl: f.url }); const c = new BackgroundController(m.api);
  try {
    await c.start(); const before = structuredClone(m.local.configuration); m.policy.BackendUrl = 'https://new.example.org'; await c.recover();
    const result = await c.request({ action: 'state' }); assert.ok(result.ok); if (result.ok) { assert.equal(result.state?.connected, false); assert.match(result.state?.lastError ?? '', /changed|disconnect/i); }
    assert.deepEqual(m.local.configuration, before); assert.equal(f.count(), 1);
  } finally { await c.request({ action: 'reset' }); await f.close(); }
});

test('a managed policy update cannot create another identity during manual registration', async () => {
  const f = await fixture(true); const m = memory({ BackendUrl: f.url, AutoRegister: false }); const c = new BackgroundController(m.api);
  try {
    await c.start();
    const manual = c.request({ action: 'configure', backendUrl: f.url, name: 'Chosen classroom' });
    await f.firstRegistration; m.policy.AutoRegister = true;
    const recovery = c.recover();
    await new Promise(resolve => setTimeout(resolve, 30));
    f.releaseRegistration();
    assert.equal((await manual).ok, true); await recovery;
    assert.equal(f.count(), 1, 'policy recovery must share identity serialization with manual setup');
    const result = await c.request({ action: 'state' }); assert.ok(result.ok); if (result.ok) assert.equal(result.state?.name, 'Chosen classroom');
  } finally { f.releaseRegistration(); await c.request({ action: 'reset' }); await f.close(); }
});
