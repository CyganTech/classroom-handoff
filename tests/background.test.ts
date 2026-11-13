import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTrustedSender } from '../extension/src/background.js';
test('runtime controls are limited to the installed extension popup and setup pages', () => {
  const root = 'chrome-extension://abcdefghijklmnop/'; const id = 'abcdefghijklmnop';
  assert.equal(isTrustedSender({ id, url: `${root}options.html` }, id, root), true);
  assert.equal(isTrustedSender({ id, url: `${root}popup.html` }, id, root), true);
  assert.equal(isTrustedSender({ id, url: 'https://attacker.example/' }, id, root), false);
  assert.equal(isTrustedSender({ id: 'another-extension', url: `${root}options.html` }, id, root), false);
  assert.equal(isTrustedSender({ id, url: `${root}unknown.html` }, id, root), false);
  assert.equal(isTrustedSender({ id }, id, root), false);
});

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { BackgroundController } from '../extension/src/background.js';
import type { PublicCommand } from '../shared/protocol.js';
function memoryApi(initial: Record<string, unknown> = {}) {
  const data = structuredClone(initial); const session: Record<string, unknown> = {};
  const area = (values: Record<string, unknown>) => ({ get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(values[key])])), set: async (patch: Record<string, unknown>) => { Object.assign(values, structuredClone(patch)); }, remove: async (keys: string | string[]) => { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; }, setAccessLevel: async () => {} });
  return { data, api: { storage: { local: area(data), session: area(session) }, alarms: { create: async () => {} }, permissions: { contains: async () => false } } as unknown as typeof chrome };
}
const waitFor = async (predicate: () => boolean) => { const end = Date.now() + 3000; while (!predicate()) { if (Date.now() > end) throw Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 10)); } };
test('a received command update cannot replace the last outgoing handoff status', async () => {
  const deviceId = 'b42056ea-26c6-4c5b-813c-14a4d25fa011'; const peerId = 'a42056ea-26c6-4c5b-813c-14a4d25fa022';
  const outgoing: PublicCommand = { id: 'c42056ea-26c6-4c5b-813c-14a4d25fa033', requestId: 'c42056ea-26c6-4c5b-813c-14a4d25fa033', sourceId: deviceId, destinationId: peerId, status: 'applied', createdAt: 1, expiresAt: 2, completedAt: 2, error: null, warnings: [] };
  const received = { ...outgoing, id: 'd42056ea-26c6-4c5b-813c-14a4d25fa044', sourceId: peerId, destinationId: deviceId, createdAt: 10 };
  let requests = 0; const server = createServer((_req, res) => { requests++; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ devices: [] })); }); const wss = new WebSocketServer({ server });
  wss.on('connection', socket => socket.on('message', () => { socket.send(JSON.stringify({ type: 'ready', deviceId })); socket.send(JSON.stringify({ type: 'command_updated', command: received })); socket.send(JSON.stringify({ type: 'devices_changed' })); }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address() as { port: number };
  const { api, data } = memoryApi({ configuration: { backendUrl: `http://127.0.0.1:${address.port}`, name: 'Device', credentials: { deviceId, token: 'x'.repeat(32) } }, uiStatus: { devices: [], lastCommand: outgoing } });
  const controller = new BackgroundController(api);
  try { await controller.start(); await waitFor(() => requests >= 2); const state = await controller.request({ action: 'state' }); assert.equal(state.ok, true); if (state.ok) assert.equal(state.state?.lastCommand?.id, outgoing.id); assert.equal((data.uiStatus as { lastCommand: PublicCommand }).lastCommand.id, outgoing.id); }
  finally { await controller.request({ action: 'reset' }); for (const socket of wss.clients) socket.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('setup rejects ungranted host access and reset preserves credentials when revocation is unreachable', async () => {
  const empty = memoryApi(); const unconfigured = new BackgroundController(empty.api);
  const denied = await unconfigured.request({ action: 'configure', backendUrl: 'https://handoff.example.org', name: 'Teacher' }); assert.equal(denied.ok, false); assert.equal(empty.data.configuration, undefined);
  const seeded = memoryApi({ configuration: { backendUrl: 'http://127.0.0.1:9', name: 'Teacher', credentials: { deviceId: 'b42056ea-26c6-4c5b-813c-14a4d25fa011', token: 'x'.repeat(32) } } });
  const controller = new BackgroundController(seeded.api); const reset = await controller.request({ action: 'reset' }); assert.equal(reset.ok, false); assert.ok(seeded.data.configuration);
});

test('reset clears locally invalid credentials after the backend rejects them with 401', async () => {
  const server = createServer((req, res) => { assert.equal(req.method, 'DELETE'); assert.equal(req.url, '/api/device'); res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid credentials' })); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address() as { port: number };
  const seeded = memoryApi({ configuration: { backendUrl: `http://127.0.0.1:${address.port}`, name: 'Teacher', credentials: { deviceId: 'b42056ea-26c6-4c5b-813c-14a4d25fa011', token: 'x'.repeat(32) } } });
  try { const controller = new BackgroundController(seeded.api); const reset = await controller.request({ action: 'reset' }); assert.equal(reset.ok, true); if (reset.ok) assert.equal(reset.state?.configured, false); assert.equal(seeded.data.configuration, undefined); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('a purged pending command becomes an unconfirmed expiry, allowing another handoff', async () => {
  const deviceId = 'b42056ea-26c6-4c5b-813c-14a4d25fa011';
  const pending: PublicCommand = { id: 'c42056ea-26c6-4c5b-813c-14a4d25fa033', requestId: 'c42056ea-26c6-4c5b-813c-14a4d25fa033', sourceId: deviceId, destinationId: 'a42056ea-26c6-4c5b-813c-14a4d25fa022', status: 'pending', createdAt: 1, expiresAt: 2, completedAt: null, error: null, warnings: [] };
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); if (req.url?.startsWith('/api/handoffs/')) { res.statusCode = 404; res.end(JSON.stringify({ error: 'Command not found' })); } else res.end(JSON.stringify({ devices: [] })); });
  const wss = new WebSocketServer({ server }); wss.on('connection', socket => socket.on('message', () => socket.send(JSON.stringify({ type: 'ready', deviceId }))));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address() as { port: number };
  const seeded = memoryApi({ configuration: { backendUrl: `http://127.0.0.1:${address.port}`, name: 'Teacher', credentials: { deviceId, token: 'x'.repeat(32) } }, uiStatus: { devices: [], lastCommand: pending } }); const controller = new BackgroundController(seeded.api);
  try { const result = await controller.request({ action: 'state' }); assert.equal(result.ok, true); if (result.ok) { assert.equal(result.state?.lastCommand?.status, 'expired'); assert.match(result.state?.lastCommand?.error ?? '', /could not be confirmed/); assert.match(result.state?.lastError ?? '', /check the receiving browser/i); } }
  finally { await controller.request({ action: 'reset' }); for (const socket of wss.clients) socket.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('a delayed 404 cannot replace a newer command that completed while status was being checked', async () => {
  const deviceId = 'b42056ea-26c6-4c5b-813c-14a4d25fa011';
  const pending: PublicCommand = { id: 'c42056ea-26c6-4c5b-813c-14a4d25fa033', requestId: 'c42056ea-26c6-4c5b-813c-14a4d25fa033', sourceId: deviceId, destinationId: 'a42056ea-26c6-4c5b-813c-14a4d25fa022', status: 'pending', createdAt: 1, expiresAt: 2, completedAt: null, error: null, warnings: [] };
  const newer: PublicCommand = { ...pending, id: 'd42056ea-26c6-4c5b-813c-14a4d25fa044', status: 'applied', createdAt: 3, completedAt: 4 };
  let data: Record<string, unknown>;
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); if (req.url?.startsWith('/api/handoffs/')) { data.uiStatus = { devices: [], lastCommand: newer }; res.statusCode = 404; res.end(JSON.stringify({ error: 'Command not found' })); } else res.end(JSON.stringify({ devices: [] })); });
  const wss = new WebSocketServer({ server }); wss.on('connection', socket => socket.on('message', () => socket.send(JSON.stringify({ type: 'ready', deviceId }))));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address() as { port: number };
  const seeded = memoryApi({ configuration: { backendUrl: `http://127.0.0.1:${address.port}`, name: 'Teacher', credentials: { deviceId, token: 'x'.repeat(32) } }, uiStatus: { devices: [], lastCommand: pending } }); data = seeded.data; const controller = new BackgroundController(seeded.api);
  try { const result = await controller.request({ action: 'state' }); assert.equal(result.ok, true); if (result.ok) { assert.equal(result.state?.lastCommand?.id, newer.id); assert.equal(result.state?.lastCommand?.status, 'applied'); assert.equal(result.state?.lastCommand?.error, null); } }
  finally { await controller.request({ action: 'reset' }); for (const socket of wss.clients) socket.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('appearance and current-tab preferences persist independently and reject invalid values', async () => {
  const { api, data } = memoryApi(); const controller = new BackgroundController(api);
  const initial = await controller.request({ action: 'state' }); assert.ok(initial.ok);
  if (initial.ok) assert.deepEqual(initial.state?.preferences, { theme: 'system', currentTabOnly: false });
  assert.ok((await controller.request({ action: 'preferences.update', theme: 'dark' })).ok);
  assert.ok((await controller.request({ action: 'preferences.update', currentTabOnly: true })).ok);
  assert.deepEqual(data.uiPreferences, { theme: 'dark', currentTabOnly: true });
  const reopened = await new BackgroundController(api).request({ action: 'state' }); assert.ok(reopened.ok);
  if (reopened.ok) assert.deepEqual(reopened.state?.preferences, { theme: 'dark', currentTabOnly: true });
  assert.equal((await controller.request({ action: 'preferences.update', theme: 'invalid' } as never)).ok, false);
  assert.deepEqual(data.uiPreferences, { theme: 'dark', currentTabOnly: true });
});
