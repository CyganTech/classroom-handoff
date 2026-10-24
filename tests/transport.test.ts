import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { BackendClient, RealtimeTransport } from '../extension/src/transport.js';
const credentials = { deviceId: 'e904291f-0dc4-465f-a410-a5a8dfe0c677', token: 'private-bearer' };
const until = async (predicate: () => boolean) => { const end = Date.now() + 3000; while (!predicate()) { if (Date.now() > end) throw Error('Timed out'); await new Promise(r => setTimeout(r, 10)); } };

test('REST authenticates with header, retains server rejection and never sends tokens in URLs', async () => {
  const seen: { url: string | undefined; auth: string | undefined }[] = [];
  const server = createServer((req, res) => { seen.push({ url: req.url, auth: req.headers.authorization }); res.writeHead(req.url === '/api/devices' ? 200 : 409, { 'content-type': 'application/json' }); res.end(JSON.stringify(req.url === '/api/devices' ? { devices: [] } : { error: 'Destination is offline' })); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const address = server.address() as { port: number };
  try { const api = new BackendClient(`http://127.0.0.1:${address.port}`, credentials); assert.deepEqual(await api.request('/api/devices'), { devices: [] }); await assert.rejects(api.request('/api/handoffs', 'POST', {}), /Destination is offline/); assert.deepEqual(seen, [{ url: '/api/devices', auth: 'Bearer private-bearer' }, { url: '/api/handoffs', auth: 'Bearer private-bearer' }]); }
  finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});

test('socket authenticates in a frame, waits for ready and reconnects after disconnect', async () => {
  const server = createServer(); const wss = new WebSocketServer({ server }); let connections = 0; const frames: unknown[] = []; let state = false;
  wss.on('connection', (socket, req) => { connections++; assert.equal(req.url, '/ws'); socket.on('message', data => { const msg = JSON.parse(data.toString()); frames.push(msg); if (msg.type === 'authenticate') socket.send(JSON.stringify({ type: 'ready', deviceId: credentials.deviceId })); if (msg.type === 'ping') socket.send(JSON.stringify({ type: 'pong' })); }); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const address = server.address() as { port: number };
  const transport = new RealtimeTransport({ settings: async () => ({ backendUrl: `http://127.0.0.1:${address.port}`, credentials }), onConnected: connected => { state = connected; }, onMessage: async () => {}, onError: () => {}, retryBaseMs: 20, heartbeatMs: 30 });
  try { await transport.ensureConnected(); await until(() => state); assert.deepEqual(frames[0], { type: 'authenticate', ...credentials }); await until(() => frames.some((f: any) => f.type === 'ping')); for (const s of wss.clients) s.close(); await until(() => connections >= 2 && state); }
  finally { transport.stop(); for (const socket of wss.clients) socket.terminate(); await new Promise<void>(r => wss.close(() => r())); await new Promise<void>(r => server.close(() => r())); }
});

test('invalid incoming messages never reach the restore callback', async () => {
  const server = createServer(); const wss = new WebSocketServer({ server }); let messages = 0; let errors = 0;
  wss.on('connection', socket => socket.on('message', () => { socket.send(JSON.stringify({ type: 'ready', deviceId: credentials.deviceId })); socket.send(JSON.stringify({ type: 'handoff', command: { workspace: { tabs: [{ url: 'javascript:alert(1)' }] } } })); }));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const address = server.address() as { port: number };
  const transport = new RealtimeTransport({ settings: async () => ({ backendUrl: `http://127.0.0.1:${address.port}`, credentials }), onConnected: () => {}, onMessage: async message => { if (message.type === 'handoff') messages++; }, onError: () => { errors++; }, retryBaseMs: 1000 });
  try { await transport.ensureConnected(); await until(() => errors > 0); assert.equal(messages, 0); }
  finally { transport.stop(); for (const socket of wss.clients) socket.terminate(); await new Promise<void>(r => wss.close(() => r())); await new Promise<void>(r => server.close(() => r())); }
});
