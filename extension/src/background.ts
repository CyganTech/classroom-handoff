import { z } from 'zod';
import { deviceNameSchema, normalizeBackendUrl, publicCommandSchema, type Credentials, type Device, type PublicCommand, type ServerMessage, type Workspace } from '../../shared/protocol.js';
import type { UiRequest, UiResponse, UiState } from '../../shared/ui.js';
import { ApiError, BackendClient, RealtimeTransport, type ConnectionSettings } from './transport.js';
import { captureWorkspace, errorText, WorkspaceReceiver } from './workspace.js';
import { ProfileDiscovery, DISCOVERY_ENABLED, DISCOVERY_PUBLISHED } from './discovery.js';
import { isManagedRelease, parseManagedPolicy, type ManagedPolicy } from './managed.js';
interface Configuration extends ConnectionSettings { name: string }
type Status = Omit<UiState, 'configured' | 'backendUrl' | 'deviceId' | 'name' | 'lastReceived'>;
interface Outbound { requestId: string; destinationId: string; workspace: Workspace; createdAt: number }
const CONFIG = 'configuration'; const STATUS = 'uiStatus'; const OUTBOUND = 'outboundRequest'; const ALARM = 'handoff-recovery';
const registrationSchema = z.object({ deviceId: z.string().uuid(), token: z.string().min(32).max(512) });

export function isTrustedSender(sender: Pick<chrome.runtime.MessageSender, 'id' | 'url'>, extensionId: string, root: string): boolean {
  if (sender.id !== extensionId || !sender.url) return false;
  return ['popup.html', 'options.html'].some(path => sender.url!.split(/[?#]/)[0] === root + path);
}

export class BackgroundController {
  private readonly discovery: ProfileDiscovery;
  private readonly receiver: WorkspaceReceiver;
  private readonly transport: RealtimeTransport;
  private statusQueue: Promise<unknown> = Promise.resolve();
  private actionQueue: Promise<unknown> = Promise.resolve();
  private policy: ManagedPolicy = { autoRegister: true };
  private policyError?: string;
  private policyQueue: Promise<unknown> = Promise.resolve();
  private nextRegistrationAttempt = 0;
  private sending?: Promise<PublicCommand | undefined>;
  constructor(private readonly api: typeof chrome) {
    this.discovery = new ProfileDiscovery(api);
    this.receiver = new WorkspaceReceiver(api);
    this.transport = new RealtimeTransport({
      settings: () => this.configuration(),
      onConnected: async connected => { await this.updateStatus({ connected }); if (connected) { await this.updateStatus({ lastError: undefined }); await this.refreshDevices(); await this.retryOutbound().catch(() => undefined); await this.refreshCommand(); } },
      onMessage: message => this.serverMessage(message),
      onError: error => this.updateStatus({ lastError: error })
    });
  }
  private async localConfiguration(): Promise<Configuration | undefined> { return (await this.api.storage.local.get(CONFIG))[CONFIG] as Configuration | undefined; }
  private async configuration(): Promise<Configuration | undefined> {
    const config = await this.localConfiguration();
    if (this.policyError || this.policy.backendUrl && config?.backendUrl !== this.policy.backendUrl) return undefined;
    return config;
  }
  private applyManagedPolicy(): Promise<void> {
    const work = this.policyQueue.then(() => this.syncManagedPolicy());
    this.policyQueue = work.catch(() => undefined); return work;
  }
  private async syncManagedPolicy(): Promise<void> {
    const wasBlocked = !!this.policyError;
    const previousUrl = this.policy.backendUrl;
    try {
      this.policy = parseManagedPolicy(this.api.storage.managed ? await this.api.storage.managed.get() : {});
      this.policyError = undefined;
      if (isManagedRelease && !this.policy.backendUrl) throw new Error('Waiting for your administrator to set the BackendUrl extension policy in Google Admin.');
      const config = await this.localConfiguration();
      if (config && this.policy.backendUrl && config.backendUrl !== this.policy.backendUrl) throw new Error('The managed backend policy changed. Disconnect this browser to revoke its old identity, then register with the new server.');
      if (previousUrl !== this.policy.backendUrl) this.nextRegistrationAttempt = 0;
      if (!config && this.policy.backendUrl && this.policy.autoRegister && Date.now() >= this.nextRegistrationAttempt) {
        this.nextRegistrationAttempt = Date.now() + 30_000;
        if (!await this.api.permissions.contains({ origins: [`${this.policy.backendUrl}/*`] })) throw new Error('The managed backend is outside this extension package’s permitted server origin. Install a release built for this server.');
        const name = this.policy.deviceName ?? `Managed browser ${crypto.randomUUID().slice(0, 8)}`;
        const credentials = registrationSchema.parse(await new BackendClient(this.policy.backendUrl).request('/api/devices/register', 'POST', { name }));
        await this.api.storage.local.set({ [CONFIG]: { backendUrl: this.policy.backendUrl, name, credentials } satisfies Configuration });
        await this.updateStatus({ connected: false, devices: [], lastError: undefined });
        this.transport.restart();
      } else if (wasBlocked && await this.configuration()) this.transport.restart();
    } catch (error) {
      this.policyError = `Managed policy: ${errorText(error)}`;
      this.transport.stop();
      await this.updateStatus({ connected: false, lastError: this.policyError });
    }
  }
  private async client(): Promise<BackendClient> { const config = await this.configuration(); if (!config) throw new Error(this.policyError ?? 'Set up this browser first'); return new BackendClient(config.backendUrl, config.credentials); }
  private updateStatus(patch: Partial<Status>): Promise<void> {
    const result = this.statusQueue.then(async () => { const current = (await this.api.storage.local.get(STATUS))[STATUS] ?? { connected: false, devices: [] }; await this.api.storage.local.set({ [STATUS]: { ...current, ...patch } }); });
    this.statusQueue = result.catch(() => undefined); return result;
  }
  private async recordCommand(command: PublicCommand): Promise<void> {
    const work = this.statusQueue.then(async () => {
      const current = (await this.api.storage.local.get(STATUS))[STATUS] as Status | undefined;
      const old = current?.lastCommand;
      if (old && (old.createdAt > command.createdAt || old.id === command.id && old.status !== 'pending' && command.status === 'pending')) return;
      await this.api.storage.local.set({ [STATUS]: { ...current, devices: current?.devices ?? [], connected: this.transport.isConnected, lastCommand: command } });
    }); this.statusQueue = work.catch(() => undefined); await work;
  }
  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.actionQueue.then(operation);
    this.actionQueue = result.catch(() => undefined); return result;
  }
  start(): Promise<void> {
    return this.enqueueOperation(async () => {
      await Promise.all([this.api.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }), this.api.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })]);
      await this.api.alarms.create(ALARM, { periodInMinutes: 0.5 });
      await this.applyManagedPolicy(); await this.receiver.recover(); await this.discovery.sync(await this.configuration()); await this.transport.ensureConnected();
    });
  }
  recover(): Promise<void> {
    return this.enqueueOperation(async () => {
      try { await this.applyManagedPolicy(); await this.receiver.recover(); await this.discovery.sync(await this.configuration()); await this.transport.ensureConnected(); await this.retryOutbound(); await this.refreshCommand(); }
      catch (error) { await this.updateStatus({ lastError: errorText(error) }); }
    });
  }
  private async refreshDevices(): Promise<void> {
    if (!await this.configuration()) return;
    try { const result = await (await this.client()).request<{ devices: Device[] }>('/api/devices'); await this.updateStatus({ devices: result.devices }); }
    catch (error) { await this.updateStatus({ lastError: errorText(error) }); }
  }
  private async refreshCommand(): Promise<void> {
    if (!await this.configuration()) return;
    const status = (await this.api.storage.local.get(STATUS))[STATUS] as Status | undefined;
    if (status?.lastCommand?.status !== 'pending') return;
    try { const { command } = await (await this.client()).request<{ command: PublicCommand }>(`/api/handoffs/${status.lastCommand.id}`); await this.recordCommand(publicCommandSchema.parse(command)); }
    catch (error) {
      if (error instanceof ApiError && error.status === 404) await this.markMissingCommand(status.lastCommand);
      else await this.updateStatus({ lastError: errorText(error) });
    }
  }
  private async markMissingCommand(expected: PublicCommand): Promise<void> {
    const work = this.statusQueue.then(async () => {
      const current = (await this.api.storage.local.get(STATUS))[STATUS] as Status | undefined;
      if (current?.lastCommand?.id !== expected.id || current.lastCommand.status !== 'pending') return;
      const error = 'The backend no longer retains this handoff. Its outcome could not be confirmed; check the receiving browser before sending again.';
      await this.api.storage.local.set({ [STATUS]: { ...current, lastCommand: { ...expected, status: 'expired', completedAt: Date.now(), error }, lastError: error } });
    });
    this.statusQueue = work.catch(() => undefined); await work;
  }
  private async serverMessage(message: ServerMessage): Promise<void> {
    if (message.type === 'devices_changed') await this.refreshDevices();
    else if (message.type === 'command_updated') {
      const config = await this.configuration();
      if (config && message.command.sourceId === config.credentials.deviceId) await this.recordCommand(message.command);
    }
    else if (message.type === 'handoff') {
      const config = await this.configuration();
      if (!config || message.command.destinationId !== config.credentials.deviceId) throw new Error('Handoff addressed to a different browser');
      try {
        const result = await this.receiver.receive(message.command);
        this.transport.send({ type: 'ack', commandId: result.commandId, status: result.status, ...(result.error ? { error: result.error } : {}), warnings: result.warnings });
        if (result.status === 'failed') await this.updateStatus({ lastError: result.error ?? 'The workspace could not be restored' });
      } catch (error) { await this.updateStatus({ lastError: errorText(error) }); this.transport.restart(); }
    }
  }
  private async state(refresh = true): Promise<UiState> {
    const config = await this.localConfiguration();
    if (refresh && config) { await this.transport.ensureConnected(); await this.refreshDevices(); await this.refreshCommand(); }
    const values = await this.api.storage.local.get([STATUS, 'lastReceived']);
    const status = values[STATUS] as Status | undefined;
    const discovery = await this.discovery.sync(await this.configuration());
    return { ...status, discovery, managed: isManagedRelease || !!this.policy.backendUrl || !!this.policyError, managedBackendUrl: this.policy.backendUrl, configured: !!config, ...(config ? { backendUrl: config.backendUrl, deviceId: config.credentials.deviceId, name: config.name } : {}), connected: this.transport.isConnected, devices: status?.devices ?? [], ...(values.lastReceived ? { lastReceived: values.lastReceived as UiState['lastReceived'] } : {}) };
  }
  private retryOutbound(): Promise<PublicCommand | undefined> {
    if (this.sending) return this.sending;
    const work = this.submitOutbound(); this.sending = work;
    void work.finally(() => { if (this.sending === work) this.sending = undefined; }).catch(() => undefined);
    return work;
  }
  private async submitOutbound(): Promise<PublicCommand | undefined> {
    const outbound = (await this.api.storage.local.get(OUTBOUND))[OUTBOUND] as Outbound | undefined;
    if (!outbound) return;
    if (Date.now() - outbound.createdAt > 60_000) { await this.api.storage.local.remove(OUTBOUND); await this.updateStatus({ lastError: 'The previous send could not be confirmed. Check the destination before sending again.' }); return; }
    try {
      const { createdAt: _createdAt, ...request } = outbound;
      const result = await (await this.client()).request<{ command: PublicCommand }>('/api/handoffs', 'POST', request);
      const command = publicCommandSchema.parse(result.command);
      await this.recordCommand(command); await this.api.storage.local.remove(OUTBOUND); await this.updateStatus({ lastError: undefined }); return command;
    } catch (error) {
      if (error instanceof ApiError) await this.api.storage.local.remove(OUTBOUND);
      await this.updateStatus({ lastError: errorText(error) }); throw error;
    }
  }
  request(request: UiRequest): Promise<UiResponse> {
    return this.enqueueOperation(async () => {
      try { await this.applyManagedPolicy(); return await this.handle(request); }
      catch (error) { const message = errorText(error); await this.updateStatus({ lastError: message }); return { ok: false, error: message }; }
    });
  }
  private async handle(request: UiRequest): Promise<UiResponse> {
    if (!request || typeof request !== 'object') throw new Error('Invalid extension request');
    switch (request.action) {
      case 'state': return { ok: true, state: await this.state() };
      case 'configure': {
        if (await this.configuration()) throw new Error('This browser is already registered. Reset it before changing the backend.');
        if (this.policyError) throw new Error(this.policyError);
        const backendUrl = normalizeBackendUrl(request.backendUrl);
        if (this.policy.backendUrl && backendUrl !== this.policy.backendUrl) throw new Error('The server address is managed by your administrator.');
        const name = deviceNameSchema.parse(request.name);
        if (!await this.api.permissions.contains({ origins: [`${backendUrl}/*`] })) throw new Error(this.policy.backendUrl ? 'The managed backend is outside this package’s permitted server origin. Install a release built for this server.' : 'Allow access to this backend from the setup page, then try again.');
        const registration = registrationSchema.parse(await new BackendClient(backendUrl).request('/api/devices/register', 'POST', { name }));
        await this.api.storage.local.set({ [CONFIG]: { backendUrl, name, credentials: registration } satisfies Configuration });
        await this.updateStatus({ connected: false, devices: [], lastError: undefined }); this.transport.restart();
        return { ok: true, state: await this.state() };
      }
      case 'rename': {
        const name = deviceNameSchema.parse(request.name); const config = await this.configuration(); if (!config) throw new Error('Set up this browser first');
        await (await this.client()).request('/api/device', 'PATCH', { name }); await this.api.storage.local.set({ [CONFIG]: { ...config, name } }); return { ok: true, state: await this.state() };
      }
      case 'discovery.enable': {
        z.boolean().parse(request.enabled);
        await this.discovery.setEnabled(request.enabled);
        return { ok: true, state: await this.state() };
      }
      case 'pairing.request':
      case 'pairing.accept':
      case 'pairing.decline': {
        const discovery = await this.discovery.sync(await this.configuration());
        if (discovery.error || !discovery.enabled || !discovery.available) throw new Error(discovery.error ?? 'Enable suggestions with a signed-in Chrome profile, or use a pairing code.');
        const client = await this.client();
        if (request.action === 'pairing.request') {
          const destinationId = z.string().uuid().parse(request.destinationId);
          await client.request('/api/pairing-requests', 'POST', { destinationId });
        } else {
          const id = z.string().uuid().parse(request.requestId);
          await client.request(`/api/pairing-requests/${id}/${request.action === 'pairing.accept' ? 'accept' : 'decline'}`, 'POST');
        }
        return { ok: true, state: await this.state() };
      }
      case 'pairing.create': return { ok: true, pairing: await (await this.client()).request('/api/pairings', 'POST', {}) };
      case 'pairing.claim': {
        const code = z.string().trim().min(1).max(100).parse(request.code); await (await this.client()).request('/api/pairings/claim', 'POST', { code }); return { ok: true, state: await this.state() };
      }
      case 'peer.remove': {
        const id = z.string().uuid().parse(request.deviceId); await (await this.client()).request(`/api/peers/${id}`, 'DELETE'); const status = (await this.api.storage.local.get(STATUS))[STATUS] as Status | undefined;
        if (status?.preferredDestinationId === id) await this.updateStatus({ preferredDestinationId: undefined }); return { ok: true, state: await this.state() };
      }
      case 'destination': {
        const id = z.string().uuid().parse(request.deviceId); await this.refreshDevices(); const state = await this.state(false); if (!state.devices.some(d => d.id === id)) throw new Error('Choose a paired destination'); await this.updateStatus({ preferredDestinationId: id }); return { ok: true, state: await this.state(false) };
      }
      case 'handoff': {
        const destinationId = z.string().uuid().parse(request.destinationId);
        if (request.windowId !== undefined) z.number().int().nonnegative().parse(request.windowId);
        if ((await this.api.storage.local.get(OUTBOUND))[OUTBOUND]) { await this.retryOutbound(); throw new Error('The previous send has been checked. Review its status before sending another workspace.'); }
        const { workspace, warnings } = await captureWorkspace(this.api, request.windowId);
        const outbound: Outbound = { requestId: crypto.randomUUID(), destinationId, workspace, createdAt: Date.now() };
        await this.api.storage.local.set({ [OUTBOUND]: outbound }); await this.updateStatus({ preferredDestinationId: destinationId, captureWarnings: warnings, lastError: undefined });
        const command = await this.retryOutbound(); if (!command) throw new Error('The handoff could not be submitted');
        return { ok: true, command, state: await this.state(false) };
      }
      case 'reset': {
        await this.receiver.recover();
        const existing = await this.localConfiguration();
        if (existing) {
          try { await new BackendClient(existing.backendUrl, existing.credentials).request('/api/device', 'DELETE'); }
          catch (error) { if (!(error instanceof ApiError) || error.status !== 401) throw error; }
        }
        this.transport.stop(); await this.api.storage.local.remove([CONFIG, STATUS, OUTBOUND, DISCOVERY_ENABLED, DISCOVERY_PUBLISHED]); return { ok: true, state: await this.state(false) };
      }
      default: throw new Error('Unknown extension request');
    }
  }
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  const controller = new BackgroundController(chrome);
  chrome.runtime.onMessage.addListener((request: UiRequest, sender, sendResponse: (response: UiResponse) => void) => {
    if (!isTrustedSender(sender, chrome.runtime.id, chrome.runtime.getURL(''))) { sendResponse({ ok: false, error: 'Untrusted extension request' }); return false; }
    void controller.request(request).then(sendResponse); return true;
  });
  chrome.identity?.onSignInChanged?.addListener(() => { void controller.recover(); });
  chrome.storage.onChanged.addListener((_changes, area) => { if (area === 'managed') void controller.recover(); });
  chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) void controller.recover(); });
  chrome.runtime.onInstalled.addListener(() => { void controller.start().catch(() => undefined); });
  chrome.runtime.onStartup.addListener(() => { void controller.start().catch(() => undefined); });
  void controller.start().catch(() => undefined);
}
