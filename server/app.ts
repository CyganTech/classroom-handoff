import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { z } from 'zod';
import { ackSchema, deviceNameSchema, handoffSchema, MAX_MESSAGE_BYTES, type PairingRequest, type ServerMessage } from '../shared/protocol.js';
import { readConfig, type AppConfig } from './config.js';
import { AdminRouter } from './admin-router.js';
import { clientInfoSchema, clientEventSchema } from '../shared/analytics.js';
import { Store, digest, publicCommand, type PairingRequestRow, type CommandRow } from './store.js';

class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
const registrationSchema = z.object({ name: deviceNameSchema }).strict();
const authenticationSchema = z.object({ type: z.literal('authenticate'), deviceId: z.string().uuid(), token: z.string().min(40).max(100) }).strict();
const pairingClaimSchema = z.object({ code: z.string().min(1).max(64) }).strict();
const discoverySchema = z.object({ accountKey: z.string().regex(/^[a-f0-9]{64}$/).nullable() }).strict();
const pairingRequestSchema = z.object({ destinationId: z.string().uuid() }).strict();
const pingSchema = z.object({ type: z.literal('ping') }).strict();
interface Connection { socket: WebSocket; lastSeen: number; lastPing: number }

export function createApp(overrides: Partial<AppConfig> = {}) {
  const config = { ...readConfig(), ...overrides };
  const store = new Store(config.dataDir, undefined, { enabled: config.analyticsEnabled, retentionDays: config.analyticsRetentionDays, now: config.now });
  const connections = new Map<string, Connection>();
  const rateLimits = new Map<string, { count: number; until: number }>();
  const unauthenticated = new Set<WebSocket>();
  let closed = false;
  function rate(key: string, limit: number): void {
    const now = config.now(); let bucket = rateLimits.get(key);
    if (!bucket || bucket.until <= now) { bucket = { count: 0, until: now + config.rateWindowMs }; rateLimits.set(key, bucket); }
    bucket.count++;
    if (bucket.count > limit) throw new HttpError(429, 'Too many requests. Please try again later.');
  }
  function send(socket: WebSocket | undefined, message: ServerMessage): void {
    if (socket?.readyState === WebSocket.OPEN) {
      // Stop writing to a stalled socket; durable pending commands redeliver on reconnect.
      if (socket.bufferedAmount > MAX_MESSAGE_BYTES * 2) socket.close(1013, 'Connection is too slow');
      else socket.send(JSON.stringify(message));
    }
  }
  function online(id: string): boolean {
    const connection = connections.get(id);
    return !!connection && connection.socket.readyState === WebSocket.OPEN && config.now() - connection.lastSeen <= config.heartbeatTimeoutMs;
  }
  function publicPairingRequest(row: PairingRequestRow): PairingRequest {
    return { id: row.id, source: store.device(store.getDevice(row.source_id)!, online(row.source_id)),
      destination: store.device(store.getDevice(row.destination_id)!, online(row.destination_id)), expiresAt: row.expires_at };
  }
  function notifyDevices(id: string): void {
    send(connections.get(id)?.socket, { type: 'devices_changed' });
    for (const peer of store.peerRows(id)) send(connections.get(peer.id)?.socket, { type: 'devices_changed' });
  }
  function notifyCommand(row: CommandRow): void {
    const message: ServerMessage = { type: 'command_updated', command: publicCommand(row) };
    send(connections.get(row.source_id)?.socket, message); send(connections.get(row.destination_id)?.socket, message);
  }
  function deliver(row: CommandRow): void {
    if (!row.payload || row.status !== 'pending' || row.expires_at <= config.now()) return;
    const source = store.getDevice(row.source_id);
    if (!source || !store.arePeers(row.source_id, row.destination_id)) return;
    send(connections.get(row.destination_id)?.socket, { type: 'handoff', command: { ...publicCommand(row), sourceName: source.name, workspace: JSON.parse(row.payload) } });
  }
  function sweep(): void {
    if (closed) return;
    const now = config.now();
    for (const row of store.expire(now, config.retentionMs)) notifyCommand(row);
    for (const [id, connection] of connections) {
      if (now - connection.lastSeen > config.heartbeatTimeoutMs) {
        connections.delete(id); connection.socket.terminate(); notifyDevices(id);
      } else if (now - connection.lastPing >= config.heartbeatIntervalMs && connection.socket.readyState === WebSocket.OPEN) {
        connection.lastPing = now; connection.socket.ping();
      }
    }
    for (const [key, bucket] of rateLimits) if (bucket.until <= now) rateLimits.delete(key);
  }
  function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    res.end(JSON.stringify(body));
  }
  async function body(req: IncomingMessage): Promise<unknown> {
    if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Content-Type must be application/json');
    if (Number(req.headers['content-length'] ?? 0) > MAX_MESSAGE_BYTES) { req.resume(); throw new HttpError(413, 'Request body is too large'); }
    let size = 0; const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += Buffer.byteLength(chunk as Buffer);
      if (size > MAX_MESSAGE_BYTES) throw new HttpError(413, 'Request body is too large');
      chunks.push(Buffer.from(chunk as Buffer));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; } catch { throw new HttpError(400, 'Request body must contain valid JSON'); }
  }
  const admin = new AdminRouter(config, store.analytics, { json, body, rate, fail: (status, message) => { throw new HttpError(status, message); } });
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const path = url.pathname; const method = req.method;
      if (await admin.handle(req, res, url)) return;
      if (url.search) throw new HttpError(400, 'Query parameters are not supported');
      if ((path === '/healthz' || path === '/health') && method === 'GET') { json(res, 200, { ok: true }); return; }
      const ip = req.socket.remoteAddress || 'unknown';
      if (path === '/api/devices/register' && method === 'POST') {
        rate(`register:${ip}`, config.registrationLimit);
        const registration = registrationSchema.parse(await body(req));
        json(res, 201, store.register(registration.name)); return;
      }
      const match = /^Bearer ([A-Za-z0-9_-]{40,100})$/.exec(req.headers.authorization || '');
      const caller = match?.[1] ? store.authenticate(match[1]) : undefined;
      if (!caller) throw new HttpError(401, 'Valid device credentials are required');
      rate(`api:${caller.id}`, config.requestLimit);
      sweep();
      if (path === '/api/analytics/capabilities' && method === 'GET') { json(res, 200, { enabled: config.analyticsEnabled, version: 1 }); return; }
      if (path === '/api/analytics/client' && method === 'POST') {
        const info = clientInfoSchema.parse(await body(req)); store.analytics.client(caller.id, info, config.now()); json(res, 200, {}); return;
      }
      if (path === '/api/analytics/events' && method === 'POST') {
        const { events } = z.object({ events: z.array(clientEventSchema).max(100) }).strict().parse(await body(req));
        store.analytics.events(caller.id, events, config.now()); json(res, 200, {}); return;
      }
      if (path === '/api/discovery' && method === 'PUT') {
        const { accountKey } = discoverySchema.parse(await body(req));
        store.setDiscovery(caller.id, accountKey); json(res, 200, {}); return;
      }
      if (path === '/api/discovery' && method === 'GET') {
        const suggestions = store.suggestions(caller.id).filter(row => online(row.id) && !store.arePeers(caller.id, row.id)).map(row => store.device(row, true));
        json(res, 200, { suggestions, requests: store.pairingRequests(caller.id, config.now()).map(publicPairingRequest) }); return;
      }
      if (path === '/api/pairing-requests' && method === 'GET') {
        json(res, 200, { requests: store.pairingRequests(caller.id, config.now()).map(publicPairingRequest) }); return;
      }
      if (path === '/api/pairing-requests' && method === 'POST') {
        rate(`pair-create:${caller.id}`, config.pairingCreationLimit);
        const { destinationId } = pairingRequestSchema.parse(await body(req));
        if (!store.matches(caller.id, destinationId) || !online(destinationId)) throw new HttpError(409, 'This browser is no longer available for Easy pair. Refresh suggestions or use a code.');
        const now = config.now();
        const request = store.requestPairing(caller.id, destinationId, now + config.pairingTtlMs, now);
        json(res, 201, { request: publicPairingRequest(request) }); return;
      }
      const pairingRequestMatch = /^\/api\/pairing-requests\/([a-f0-9-]{36})\/(accept|decline)$/.exec(path);
      if (pairingRequestMatch && method === 'POST') {
        rate(`pair-claim:${caller.id}`, config.pairingAttemptLimit); rate(`pair-claim-ip:${ip}`, config.pairingAttemptLimit * 4);
        const accepted = pairingRequestMatch[2] === 'accept';
        const request = store.resolvePairing(pairingRequestMatch[1]!, caller.id, accepted, config.now());
        if (!request) throw new HttpError(404, 'Pairing request is unavailable or expired.');
        if (accepted) { notifyDevices(request.source_id); notifyDevices(request.destination_id); }
        json(res, 200, {}); return;
      }
      if (path === '/api/devices' && method === 'GET') {
        json(res, 200, { devices: store.peerRows(caller.id).map(row => store.device(row, online(row.id))) }); return;
      }
      if (path === '/api/device' && method === 'PATCH') {
        const updated = registrationSchema.parse(await body(req)); store.rename(caller.id, updated.name); notifyDevices(caller.id);
        json(res, 200, { device: store.device(store.getDevice(caller.id)!, online(caller.id)) }); return;
      }
      if (path === '/api/device' && method === 'DELETE') {
        const peers = store.peerRows(caller.id);
        // Notify both endpoints before cascading metadata deletion.
        for (const row of store.pending(caller.id)) notifyCommand(store.complete(row.id, 'failed', config.now(), 'Destination device was revoked', [])!);
        for (const peer of peers) for (const row of store.pending(peer.id).filter(row => row.source_id === caller.id)) notifyCommand(store.complete(row.id, 'failed', config.now(), 'Source device was revoked', [])!);
        const connection = connections.get(caller.id); connections.delete(caller.id); connection?.socket.close(4003, 'Device was revoked');
        store.revoke(caller.id);
        for (const peer of peers) send(connections.get(peer.id)?.socket, { type: 'devices_changed' });
        json(res, 200, {}); return;
      }
      if (path === '/api/pairings' && method === 'POST') {
        rate(`pair-create:${caller.id}`, config.pairingCreationLimit);
        const expiresAt = config.now() + config.pairingTtlMs;
        json(res, 201, { code: store.createPairing(caller.id, expiresAt), expiresAt }); return;
      }
      if (path === '/api/pairings/claim' && method === 'POST') {
        rate(`pair-claim:${caller.id}`, config.pairingAttemptLimit); rate(`pair-claim-ip:${ip}`, config.pairingAttemptLimit * 4);
        const claim = pairingClaimSchema.parse(await body(req));
        const normalized = claim.code.toUpperCase().replace(/[\s-]/g, '');
        if (!/^(?:[2-9A-HJ-NP-Z]{8}|[A-F0-9]{18})$/.test(normalized)) throw new HttpError(400, 'Pairing code is invalid, expired, or already used');
        const peerId = store.claimPairing(normalized, caller.id, config.now());
        if (!peerId) throw new HttpError(400, 'Pairing code is invalid, expired, or already used');
        notifyDevices(caller.id); notifyDevices(peerId);
        json(res, 200, { device: store.device(store.getDevice(peerId)!, online(peerId)) }); return;
      }
      const peerMatch = /^\/api\/peers\/([a-f0-9-]{36})$/.exec(path);
      if (peerMatch && method === 'DELETE') {
        const peerId = peerMatch[1]!;
        for (const row of store.removePeer(caller.id, peerId, config.now())) notifyCommand(row);
        notifyDevices(caller.id); notifyDevices(peerId); json(res, 200, {}); return;
      }
      if (path === '/api/handoffs' && method === 'POST') {
        const request = handoffSchema.parse(await body(req));
        const { analytics, ...core } = request;
        const requestHash = digest(JSON.stringify(core));
        const existing = store.byRequest(caller.id, request.requestId);
        if (existing) {
          if (existing.request_hash !== requestHash) throw new HttpError(409, 'This request ID was already used with different contents');
          json(res, 200, { command: publicCommand(existing) }); return;
        }
        const reject = (reason: 'offline' | 'unpaired' | 'busy' | 'size', status: number, message: string): never => { store.analytics.rejected(caller.id, request.requestId, reason, config.now()); throw new HttpError(status, message); };
        if (!store.arePeers(caller.id, request.destinationId)) reject('unpaired', 403, 'Destination device is not paired');
        if (!online(request.destinationId)) reject('offline', 409, 'Destination device is offline. Reconnect it and try again.');
        if (store.pending(request.destinationId).length) reject('busy', 409, 'A handoff to this destination is still pending');
        const now = config.now();
        // Delivery adds metadata to the submitted workspace. Check the complete envelope so
        // every accepted command fits the receiver's independently enforced message bound.
        // Reserve the maximum JSON-escaped name length, including a rename before redelivery.
        const envelope: ServerMessage = { type: 'handoff', command: {
          id: '00000000-0000-4000-8000-000000000000', requestId: request.requestId, sourceId: caller.id,
          destinationId: request.destinationId, status: 'pending', createdAt: now, expiresAt: now + config.commandTtlMs,
          completedAt: null, error: null, warnings: [], sourceName: '\0'.repeat(64), workspace: request.workspace
        } };
        if (Buffer.byteLength(JSON.stringify(envelope)) > MAX_MESSAGE_BYTES) reject('size', 413, 'Workspace is too large to deliver. Close some tabs and try again.');
        const command = store.createCommand(caller.id, request.destinationId, request.requestId, request.workspace, requestHash, now, now + config.commandTtlMs, analytics);
        deliver(command); json(res, 201, { command: publicCommand(command) }); return;
      }
      const commandMatch = /^\/api\/handoffs\/([a-f0-9-]{36})$/.exec(path);
      if (commandMatch && method === 'GET') {
        const command = store.getCommand(commandMatch[1]!);
        if (!command || (command.source_id !== caller.id && command.destination_id !== caller.id)) throw new HttpError(404, 'Handoff was not found');
        json(res, 200, { command: publicCommand(command) }); return;
      }
      throw new HttpError(404, 'Endpoint was not found');
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      req.resume();
      if (error instanceof HttpError) json(res, error.status, { error: error.message });
      else if (error instanceof z.ZodError) json(res, 400, { error: 'Request validation failed', details: error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) });
      else { console.error('Backend request failed'); json(res, 500, { error: 'An internal server error occurred' }); }
    }
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 5000;
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws' || sockets.clients.size >= config.maxConnections) { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return; }
    sockets.handleUpgrade(req, socket, head, ws => sockets.emit('connection', ws, req));
  });
  sockets.on('connection', (socket, req) => {
    let deviceId: string | undefined;
    let messageCount = 0; let messageWindow = config.now();
    unauthenticated.add(socket);
    const authTimer = setTimeout(() => { if (!deviceId) socket.close(4001, 'Authentication timed out'); }, config.authTimeoutMs);
    authTimer.unref();
    socket.on('error', () => { /* A failed connection is handled by close/reconnect; never log credentials. */ });
    socket.on('message', (raw: RawData, binary: boolean) => {
      try {
        if (binary) throw new Error('Text JSON messages are required');
        if (config.now() - messageWindow >= config.rateWindowMs) { messageCount = 0; messageWindow = config.now(); }
        if (++messageCount > config.requestLimit) { socket.close(1008, 'Too many messages'); return; }
        const parsed: unknown = JSON.parse(raw.toString());
        if (!deviceId) {
          rate(`ws-auth:${req.socket.remoteAddress || 'unknown'}`, config.registrationLimit * 4);
          const authentication = authenticationSchema.parse(parsed);
          const row = store.authenticate(authentication.token);
          if (!row || row.id !== authentication.deviceId) { socket.close(4003, 'Authentication failed'); return; }
          clearTimeout(authTimer); unauthenticated.delete(socket); deviceId = row.id;
          const previous = connections.get(deviceId); previous?.socket.close(4001, 'Connection replaced');
          const now = config.now(); connections.set(deviceId, { socket, lastSeen: now, lastPing: now }); store.touch(deviceId, now);
          send(socket, { type: 'ready', deviceId }); sweep(); notifyDevices(deviceId);
          for (const command of store.pending(deviceId)) deliver(command);
          return;
        }
        const connection = connections.get(deviceId);
        if (!connection || connection.socket !== socket || !store.getDevice(deviceId)) { socket.close(4003, 'Authentication is no longer valid'); return; }
        connection.lastSeen = config.now(); store.touch(deviceId, connection.lastSeen);
        if (pingSchema.safeParse(parsed).success) { send(socket, { type: 'pong' }); return; }
        const ack = ackSchema.parse(parsed); sweep();
        const row = store.getCommand(ack.commandId);
        if (!row || row.destination_id !== deviceId) { send(socket, { type: 'error', error: 'Handoff is not available to this device' }); return; }
        if (row.status !== 'pending') { send(socket, { type: 'command_updated', command: publicCommand(row) }); return; }
        const completed = store.complete(row.id, ack.status, config.now(), ack.status === 'failed' ? (ack.error || 'Browser could not restore the workspace') : null, ack.warnings || []);
        if (completed) notifyCommand(completed);
      } catch {
        send(socket, { type: 'error', error: deviceId ? 'Invalid client message' : 'Authentication failed' });
        if (!deviceId) socket.close(4003, 'Authentication failed');
      }
    });
    socket.on('pong', () => {
      if (!deviceId) return; const connection = connections.get(deviceId);
      if (connection?.socket === socket) { connection.lastSeen = config.now(); store.touch(deviceId, connection.lastSeen); }
    });
    socket.on('close', () => {
      clearTimeout(authTimer); unauthenticated.delete(socket);
      if (deviceId && connections.get(deviceId)?.socket === socket) { connections.delete(deviceId); if (!closed) { store.touch(deviceId, config.now()); notifyDevices(deviceId); } }
    });
  });
  const interval = setInterval(sweep, config.sweepIntervalMs); interval.unref();
  // Expire commands before accepting any connection after a process restart.
  sweep();
  return {
    server, store, config, sweep,
    async listen(port = config.port, host = config.host): Promise<{ host: string; port: number; url: string }> {
      if (closed) throw new Error('Application is closed');
      await new Promise<void>((resolve, reject) => { const onError = (error: Error) => reject(error); server.once('error', onError); server.listen(port, host, () => { server.off('error', onError); resolve(); }); });
      const address = server.address() as AddressInfo; const displayHost = address.family === 'IPv6' ? `[${address.address}]` : address.address;
      return { host: address.address, port: address.port, url: `http://${displayHost}:${address.port}` };
    },
    async close(): Promise<void> {
      if (closed) return; closed = true; clearInterval(interval);
      for (const socket of sockets.clients) socket.terminate(); connections.clear(); unauthenticated.clear();
      await new Promise<void>(resolve => sockets.close(() => resolve()));
      if (server.listening) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
      store.close();
    }
  };
}
export type App = ReturnType<typeof createApp>;
