import { clientEventSchema, clientInfoSchema, type AnalyticsClientEvent, type AnalyticsMetadata, type ClientInfo } from '../../shared/analytics.js';
import { ApiError, BackendClient, type ConnectionSettings } from './transport.js';

const STORAGE = 'extensionAnalytics';
const TTL = 24 * 60 * 60_000;
const RETRY = 30_000;
interface StoredAnalytics { scope: string; events: AnalyticsClientEvent[]; reported: Array<{ requestId: string; at: number }> }
const identity = (config: ConnectionSettings): string => JSON.stringify([config.backendUrl, config.credentials.deviceId]);

/** Best-effort telemetry. Only local storage work is serialized; network work never joins the action queue. */
export class AnalyticsClient {
  private local: Promise<unknown> = Promise.resolve();
  private state?: StoredAnalytics;
  private enabled?: boolean;
  private info?: ClientInfo;
  private capabilityUntil = 0;
  private retryAt = 0;
  private registered = false;
  private flight?: Promise<void>;
  private generation = 0;
  private resetEpoch = 0;
  constructor(private readonly api: typeof chrome, private readonly settings: () => Promise<ConnectionSettings | undefined>, private readonly now: () => number = Date.now) {}
  metadata(config: ConnectionSettings, currentTabOnly: boolean): AnalyticsMetadata | undefined {
    if (!this.enabled || !this.info || this.state?.scope !== identity(config)) return;
    return { ...this.info, mode: currentTabOnly ? 'current-tab' : 'whole-window' };
  }
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.local.then(operation); this.local = work.catch(() => undefined); return work;
  }
  private prune(): void {
    if (!this.state) return;
    this.state.events = this.state.events.filter(event => event.occurredAt > this.now() - TTL && event.occurredAt <= this.now()).slice(-100);
    this.state.reported = this.state.reported.filter(event => event.at > this.now() - TTL).slice(-100);
  }
  private async save(): Promise<void> { this.prune(); if (this.state) await this.api.storage.local.set({ [STORAGE]: this.state }); }
  private async prepare(config: ConnectionSettings): Promise<void> {
    const scope = identity(config);
    if (this.state?.scope === scope) return;
    const saved = (await this.api.storage.local.get(STORAGE))[STORAGE] as Partial<StoredAnalytics> | undefined;
    this.generation++; this.enabled = undefined; this.info = undefined; this.registered = false; this.retryAt = 0; this.capabilityUntil = 0;
    const events = saved?.scope === scope && Array.isArray(saved.events) ? saved.events.flatMap(event => { const parsed = clientEventSchema.safeParse(event); return parsed.success ? [parsed.data] : []; }) : [];
    const reported = saved?.scope === scope && Array.isArray(saved.reported) ? saved.reported.filter(event => typeof event?.requestId === 'string' && /^[0-9a-f-]{36}$/i.test(event.requestId) && typeof event.at === 'number').map(event => ({ requestId: event.requestId, at: event.at })) : [];
    this.state = { scope, events, reported }; await this.save();
  }
  record(type: AnalyticsClientEvent['type'], reason: AnalyticsClientEvent['reason'], requestId?: string): void {
    // Reconstruct and validate the allowlisted object. Callers cannot attach URLs, raw errors, or identity data.
    const parsed = clientEventSchema.safeParse({ id: crypto.randomUUID(), type, reason, occurredAt: this.now(), ...(requestId === undefined ? {} : { requestId }) });
    if (!parsed.success) return;
    const generation = this.generation;
    void this.settings().then(config => config && this.mutate(async () => {
      if (generation !== this.generation && this.state?.scope !== identity(config)) return;
      await this.prepare(config); this.prune();
      if (this.enabled === false || !this.state) return;
      if (type === 'send_failed' && requestId) {
        if (this.state.reported.some(event => event.requestId === requestId)) return;
        this.state.reported.push({ requestId, at: this.now() });
      }
      this.state.events.push(parsed.data); await this.save();
    })).catch(() => undefined);
  }
  kick(): void {
    if (this.flight) return;
    const work = this.sync(); this.flight = work;
    void work.finally(() => { if (this.flight === work) this.flight = undefined; }).catch(() => undefined);
  }
  private async sync(): Promise<void> {
    const started = this.resetEpoch;
    const config = await this.settings(); if (!config || started !== this.resetEpoch) return;
    const generation = await this.mutate(async () => {
      if (started !== this.resetEpoch) return;
      await this.prepare(config); await this.save(); return this.generation;
    });
    if (generation === undefined) return;
    const current = () => started === this.resetEpoch && generation === this.generation && this.state?.scope === identity(config);
    if (this.now() < this.retryAt) return;
    const backend = new BackendClient(config.backendUrl, config.credentials);
    try {
      if (this.now() >= this.capabilityUntil) {
        const result = await backend.request<{ enabled?: unknown; version?: unknown }>('/api/analytics/capabilities');
        if (!current()) return;
        this.enabled = result.version === 1 && result.enabled === true;
        this.capabilityUntil = this.now() + RETRY;
        if (!this.enabled) { await this.mutate(async () => { if (current() && this.state) { this.state.events = []; this.state.reported = []; await this.save(); } }); return; }
      }
      if (!this.enabled || !current()) return;
      if (!this.info) {
        const platform = await this.api.runtime.getPlatformInfo().catch(() => ({ os: 'unknown' as const }));
        if (!current()) return;
        const version = this.api.runtime.getManifest().version;
        const parsed = clientInfoSchema.safeParse({ version, platform: platform.os });
        if (!parsed.success) return;
        this.info = parsed.data;
      }
      if (!this.registered) { await backend.request('/api/analytics/client', 'POST', this.info); if (!current()) return; this.registered = true; }
      const batch = await this.mutate(async () => { if (!current()) return []; await this.save(); return this.state!.events.slice(); });
      if (!batch.length || !current()) return;
      await backend.request('/api/analytics/events', 'POST', { events: batch });
      await this.mutate(async () => { if (!current() || !this.state) return; const sent = new Set(batch.map(event => event.id)); this.state.events = this.state.events.filter(event => !sent.has(event.id)); await this.save(); });
    } catch (error) {
      if (!current()) return;
      this.retryAt = this.now() + RETRY;
      // Older servers do not advertise this optional protocol. Keep handoffs compatible.
      if (error instanceof ApiError && error.status === 404) { this.enabled = false; this.capabilityUntil = this.now() + 5 * 60_000; }
    }
  }
  async reset(): Promise<void> {
    this.resetEpoch++; this.generation++; this.enabled = undefined; this.info = undefined; this.flight = undefined;
    await this.mutate(async () => { this.state = undefined; this.registered = false; this.retryAt = 0; this.capabilityUntil = 0; await this.api.storage.local.remove(STORAGE); });
  }
}
