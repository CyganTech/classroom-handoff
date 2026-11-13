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
  let registrations = 0; const renames: string[] = []; let failRename = false; let holdRename = false; let releaseRename = () => {}; let renameStarted!: () => void; const firstRename = new Promise<void>(resolve => { renameStarted = resolve; });
  const id = 'b42056ea-26c6-4c5b-813c-14a4d25fa011';
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); if (req.url === '/api/devices/register') { registrations++; const send = () => res.end(JSON.stringify({ deviceId: id, token: 'x'.repeat(43) })); if (holdFirstRegistration && registrations === 1) { releaseRegistration = send; registrationStarted(); } else send(); } else if (req.url === '/api/device' && req.method === 'PATCH') {
    let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', () => {
      renames.push(JSON.parse(raw).name); renameStarted();
      if (holdRename) { holdRename = false; releaseRename = () => res.end('{}'); }
      else if (failRename) { failRename = false; res.statusCode = 503; res.end(JSON.stringify({ error: 'Temporary failure' })); }
      else res.end('{}');
    });
  } else res.end(JSON.stringify({ devices: [] })); });
  const ws = new WebSocketServer({ server }); ws.on('connection', socket => socket.on('message', raw => { const message = JSON.parse(raw.toString()); if (message.type === 'authenticate') socket.send(JSON.stringify({ type: 'ready', deviceId: id })); else socket.send(JSON.stringify({ type: 'pong' })); }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url, renames, firstRename, holdNextRename: () => { holdRename = true; }, releaseRename: () => releaseRename(), failNextRename: () => { failRename = true; }, id, firstRegistration, releaseRegistration: () => releaseRegistration(), count: () => registrations, close: async () => { for (const socket of ws.clients) socket.terminate(); await new Promise<void>(resolve => ws.close(() => resolve())); await new Promise<void>(resolve => server.close(() => resolve())); } };
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


test('legacy generated names migrate once, retry failures, and preserve explicit user renames', async () => {
  const f = await fixture(); const m = memory({ BackendUrl: f.url });
  m.local.configuration = { backendUrl: f.url, name: 'Managed browser ab12cd34', credentials: { deviceId: f.id, token: 'x'.repeat(43) } };
  let now = Date.now(); f.failNextRename(); const c = new BackgroundController(m.api, () => now);
  try {
    await c.start(); await f.firstRename;
    await waitUntil(async () => { const result = await c.request({ action: 'state' }); return result.ok && !!result.state?.nameWarning; });
    assert.equal((m.local.configuration as any).name, 'Managed browser ab12cd34');
    assert.equal(f.renames.length, 1);
    now += 30_001; await c.recover();
    await waitUntil(() => (m.local.configuration as any).nameSource === 'generated');
    const state = await c.request({ action: 'state' }); assert.ok(state.ok); if (!state.ok) return;
    assert.match(state.state?.name ?? '', /^Browser · [2-9A-HJ-NP-Z]{4}$/);
    assert.equal(state.state?.connected, true); assert.equal(f.renames.length, 2); assert.equal(f.renames[0], f.renames[1]);
    assert.equal((m.local.configuration as any).nameSource, 'generated');
    await c.recover(); assert.equal(f.renames.length, 2);
    await c.request({ action: 'rename', name: 'Managed browser abcdef12' });
    await c.recover(); assert.equal((m.local.configuration as any).name, 'Managed browser abcdef12'); assert.equal((m.local.configuration as any).nameSource, 'custom');
  } finally { await c.request({ action: 'reset' }); await f.close(); }
});
test('existing custom and current policy-specified names never migrate', async () => {
  for (const name of ['Teacher laptop', 'Managed browser ab12cd34']) {
    const f = await fixture(); const m = memory({ BackendUrl: f.url, ...(name.startsWith('Managed') ? { DeviceName: name } : {}) });
    m.local.configuration = { backendUrl: f.url, name, credentials: { deviceId: f.id, token: 'x'.repeat(43) } };
    const c = new BackgroundController(m.api);
    try { await c.start(); await c.recover(); assert.equal(f.renames.length, 0); assert.equal((m.local.configuration as any).name, name); }
    finally { await c.request({ action: 'reset' }); await f.close(); }
  }
});


test('a stalled generated-name migration cannot block other extension controls', async () => {
  const f = await fixture(); const m = memory({ BackendUrl: f.url });
  m.local.configuration = { backendUrl: f.url, name: 'Managed browser ab12cd34', credentials: { deviceId: f.id, token: 'x'.repeat(43) } };
  const c = new BackgroundController(m.api); f.holdNextRename();
  const pending = c.request({ action: 'state' });
  try {
    await f.firstRename;
    const preference = c.request({ action: 'preferences.update', currentTabOnly: true });
    const responsive = await Promise.race([preference.then(result => result.ok), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 300))]);
    const custom = c.request({ action: 'rename', name: 'Teacher display' });
    f.releaseRename(); await pending; await preference; await custom;
    assert.equal((m.local.configuration as any).name, 'Teacher display');
    assert.deepEqual(f.renames.slice(-1), ['Teacher display']);
    assert.equal(responsive, true, 'name migration must not occupy the action queue');
  } finally { f.releaseRename(); await pending; await c.request({ action: 'reset' }); await f.close(); }
});

async function waitUntil(predicate: () => boolean | Promise<boolean>) { const end = Date.now() + 3000; while (!await predicate()) { if (Date.now() > end) throw Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 10)); } }


test('a background name response after disconnect cannot restore revoked local credentials', async () => {
  const f = await fixture(); const m = memory({ BackendUrl: f.url, AutoRegister: false });
  m.local.configuration = { backendUrl: f.url, name: 'Managed browser ab12cd34', credentials: { deviceId: f.id, token: 'x'.repeat(43) } };
  const c = new BackgroundController(m.api); f.holdNextRename();
  try {
    const initial = c.request({ action: 'state' }); await f.firstRename; await initial;
    assert.ok((await c.request({ action: 'reset' })).ok);
    f.releaseRename();
    await new Promise(resolve => setTimeout(resolve, 30));
    const state = await c.request({ action: 'state' }); assert.ok(state.ok); if (state.ok) assert.equal(state.state?.configured, false);
    assert.equal(m.local.configuration, undefined);
  } finally { f.releaseRename(); await c.request({ action: 'reset' }); await f.close(); }
});
