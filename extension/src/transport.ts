import { MAX_MESSAGE_BYTES, normalizeBackendUrl, serverMessageSchema, type ClientMessage, type Credentials, type ServerMessage } from '../../shared/protocol.js';
import { errorText } from './workspace.js';
export interface ConnectionSettings { backendUrl: string; credentials: Credentials }
export class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); this.name = 'ApiError'; } }

export class BackendClient {
  readonly backendUrl: string;
  constructor(backendUrl: string, private readonly credentials?: Credentials) { this.backendUrl = normalizeBackendUrl(backendUrl); }
  async request<T = unknown>(path: string, method = 'GET', body?: unknown): Promise<T> {
    if (!path.startsWith('/api/')) throw new Error('Invalid backend API path');
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.credentials) headers.Authorization = `Bearer ${this.credentials.token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response: Response;
    try { response = await fetch(this.backendUrl + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000), credentials: 'omit', redirect: 'error', cache: 'no-store' }); }
    catch { throw new Error('Cannot reach the backend. Check the connection and backend address, then try again.'); }
    if (Number(response.headers.get('content-length')) > MAX_MESSAGE_BYTES) throw new Error('Backend response is too large');
    const raw = await response.text();
    if (raw.length > MAX_MESSAGE_BYTES) throw new Error('Backend response is too large');
    let data: unknown;
    try { data = raw ? JSON.parse(raw) : {}; } catch { throw new Error('Backend returned an invalid response'); }
    if (!response.ok) throw new ApiError(typeof data === 'object' && data && 'error' in data && typeof data.error === 'string' ? data.error.slice(0, 500) : `Backend request failed (${response.status})`, response.status);
    return data as T;
  }
}
interface TransportOptions {
  settings: () => Promise<ConnectionSettings | undefined>;
  onConnected: (connected: boolean) => void | Promise<void>;
  onMessage: (message: ServerMessage) => Promise<void>;
  onError: (error: string) => void | Promise<void>;
  retryBaseMs?: number; heartbeatMs?: number;
}
/** The 20-second ping keeps an authenticated Chrome 120+ worker alive while online. */
export class RealtimeTransport {
  private socket?: WebSocket; private retry?: ReturnType<typeof setTimeout>; private heartbeat?: ReturnType<typeof setInterval>; private authTimeout?: ReturnType<typeof setTimeout>;
  private connecting = false; private connected = false; private stopped = false; private attempt = 0; private lastPong = 0; private generation = 0;
  constructor(private readonly options: TransportOptions) {}
  get isConnected(): boolean { return this.connected; }
  async ensureConnected(): Promise<void> {
    if (this.stopped || this.connecting || this.socket && this.socket.readyState <= WebSocket.OPEN) return;
    this.connecting = true;
    const generation = this.generation;
    try {
      const settings = await this.options.settings();
      if (!settings || this.stopped || generation !== this.generation) return;
      const url = new URL('/ws', normalizeBackendUrl(settings.backendUrl)); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(url); this.socket = socket;
      this.authTimeout = setTimeout(() => { if (!this.connected && this.socket === socket) socket.close(); }, 10_000);
      socket.addEventListener('open', () => { if (this.socket === socket) socket.send(JSON.stringify({ type: 'authenticate', ...settings.credentials } satisfies ClientMessage)); });
      socket.addEventListener('message', event => {
        if (this.socket !== socket) return;
        void this.handleMessage(event.data, socket, settings.credentials.deviceId).catch(async error => { await this.options.onError(errorText(error)); socket.close(); });
      });
      socket.addEventListener('error', () => { void this.options.onError('Connection to the backend was interrupted. Reconnecting…'); });
      socket.addEventListener('close', () => {
        if (this.socket !== socket) return;
        this.clearTimers(); this.socket = undefined; this.connected = false;
        void this.options.onConnected(false); this.scheduleReconnect();
      });
    } catch (error) { await this.options.onError(errorText(error)); this.scheduleReconnect(); }
    finally { this.connecting = false; }
  }
  send(message: ClientMessage): boolean {
    if (!this.connected || this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message)); return true;
  }
  private async handleMessage(data: unknown, socket: WebSocket, deviceId: string): Promise<void> {
    if (typeof data !== 'string' || data.length > MAX_MESSAGE_BYTES) throw new Error('Backend sent an invalid message');
    const parsed = serverMessageSchema.safeParse(JSON.parse(data));
    if (!parsed.success) throw new Error('Backend sent an invalid message');
    const message = parsed.data;
    if (message.type === 'ready') {
      if (message.deviceId !== deviceId) throw new Error('Backend authenticated the wrong device');
      if (this.authTimeout) clearTimeout(this.authTimeout);
      this.authTimeout = undefined; this.connected = true; this.attempt = 0; this.lastPong = Date.now();
      if (this.heartbeat) clearInterval(this.heartbeat);
      const interval = this.options.heartbeatMs ?? 20_000;
      this.heartbeat = setInterval(() => {
        if (Date.now() - this.lastPong > Math.max(45_000, interval * 2.5)) socket.close();
        else this.send({ type: 'ping' });
      }, interval);
      await this.options.onConnected(true);
    } else if (!this.connected) throw new Error('Backend sent a message before authenticating');
    if (message.type === 'pong') this.lastPong = Date.now();
    else if (message.type === 'error') await this.options.onError(message.error);
    await this.options.onMessage(message);
  }
  private scheduleReconnect(): void {
    if (this.stopped || this.retry) return;
    const base = Math.min(30_000, (this.options.retryBaseMs ?? 500) * 2 ** Math.min(this.attempt++, 6));
    this.retry = setTimeout(() => { this.retry = undefined; void this.ensureConnected(); }, base * (0.75 + Math.random() * 0.5));
  }
  private clearTimers(): void { if (this.heartbeat) clearInterval(this.heartbeat); if (this.authTimeout) clearTimeout(this.authTimeout); this.heartbeat = undefined; this.authTimeout = undefined; }
  stop(): void {
    this.stopped = true; this.generation++; this.clearTimers(); if (this.retry) clearTimeout(this.retry); this.retry = undefined;
    const socket = this.socket; this.socket = undefined; this.connected = false; socket?.close(); void this.options.onConnected(false);
  }
  restart(): void { this.stop(); this.stopped = false; this.attempt = 0; void this.ensureConnected(); }
}
