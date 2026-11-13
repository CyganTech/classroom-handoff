import { MAX_TABS, isSupportedUrl, workspaceSchema, type IncomingCommand, type Workspace } from '../../shared/protocol.js';

export interface BrowserApi {
  runtime: Pick<typeof chrome.runtime, 'getURL'>;
  storage: { local: Pick<chrome.storage.StorageArea, 'get' | 'set' | 'remove'>; session: Pick<chrome.storage.StorageArea, 'get' | 'set' | 'remove'> };
  windows: Pick<typeof chrome.windows, 'getLastFocused' | 'get' | 'create' | 'update'>;
  tabs: Pick<typeof chrome.tabs, 'query' | 'get' | 'create' | 'update' | 'remove'> & Partial<Pick<typeof chrome.tabs, 'group'>>;
  tabGroups?: Pick<typeof chrome.tabGroups, 'get' | 'update'>;
}
export interface Receipt { commandId: string; status: 'applied' | 'failed'; warnings: string[]; error?: string; at: number }
interface Ownership { lease: string; windowId: number; tabIds: number[] }
interface Journal { commandId: string; sourceName: string; expiresAt: number; lease: string; windowId: number; previous: number[]; previousActive?: number; staged: number[]; phase: 'staging' | 'committing' | 'rollback'; warnings: string[] }
const OWNER = 'workspaceOwner'; const JOURNAL = 'receiveJournal'; const RECEIPTS = 'receiveReceipts';
export const errorText = (error: unknown): string => (error instanceof Error ? error.message : 'Unexpected browser error').slice(0, 500);

export async function captureWorkspace(api: BrowserApi, windowId?: number, currentTabOnly = false): Promise<{ workspace: Workspace; warnings: string[] }> {
  const win = windowId === undefined ? await api.windows.getLastFocused({ windowTypes: ['normal'] }) : await api.windows.get(windowId);
  if (win.type !== 'normal' || win.id === undefined || win.incognito) throw new Error('Choose a normal, non-incognito browser window');
  const all = (await api.tabs.query({ windowId: win.id })).sort((a, b) => a.index - b.index);
  const selected = currentTabOnly ? all.filter(t => t.active) : all;
  if (currentTabOnly && (selected.length !== 1 || !isSupportedUrl(selected[0]!.pendingUrl ?? selected[0]!.url ?? ''))) throw new Error('The current tab cannot be sent. Choose an HTTP(S) page and try again.');
  const supported = selected.filter(t => isSupportedUrl(t.pendingUrl ?? t.url ?? ''));
  const warnings: string[] = [];
  if (selected.length !== supported.length) warnings.push(`${selected.length - supported.length} restricted or unsupported tab(s) were skipped. Only HTTP(S) pages can be handed off.`);
  if (!supported.length) throw new Error('This window has no supported HTTP(S) tabs to hand off');
  if (supported.length > MAX_TABS) throw new Error(`A handoff supports at most ${MAX_TABS} tabs. Close some tabs and try again.`);
  const groups: Workspace['groups'] = [];
  const supportedGroups = !!api.tabGroups && !!api.tabs.group;
  if (!supportedGroups && supported.some(t => t.groupId >= 0)) warnings.push('Tab groups are unavailable in this browser; tabs will remain ungrouped.');
  if (supportedGroups) for (const id of new Set(supported.filter(t => t.groupId >= 0 && !t.pinned).map(t => t.groupId))) {
    const g = await api.tabGroups!.get(id);
    groups.push({ id: String(id), title: g.title ?? '', color: g.color, collapsed: g.collapsed });
  }
  const activeIndex = Math.max(0, supported.findIndex(t => t.active));
  const workspace = workspaceSchema.parse({ version: 1, tabs: supported.map((t, i) => ({ url: t.pendingUrl ?? t.url!, pinned: t.pinned, active: i === activeIndex, groupId: supportedGroups && t.groupId >= 0 && !t.pinned ? String(t.groupId) : null })), groups });
  return { workspace, warnings };
}

/** Serializes receipts and browser mutations. Numeric IDs are trusted only with a live session lease. */
export class WorkspaceReceiver {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly api: BrowserApi, private readonly now = Date.now) {}
  receive(command: IncomingCommand): Promise<Receipt> {
    const work = this.queue.then(() => this.apply(command));
    this.queue = work.catch(() => undefined);
    return work;
  }
  recover(): Promise<void> {
    const work = this.queue.then(() => this.recoverJournal());
    this.queue = work.catch(() => undefined);
    return work;
  }
  private async get<T>(area: BrowserApi['storage']['local'], key: string): Promise<T | undefined> { return (await area.get(key))[key] as T | undefined; }
  private marker(lease: string, commandId: string, index: number): string { return `${this.api.runtime.getURL('staging.html')}#${lease}/${commandId}/${index}`; }
  private async owned(owner: Ownership | undefined): Promise<Ownership | undefined> {
    if (!owner) return undefined;
    if (owner.windowId === -1) {
      // The window may have been created immediately before worker termination.
      const marker = this.marker(owner.lease, 'window', 0);
      const tab = (await this.api.tabs.query({})).find(t => t.url === marker || t.pendingUrl === marker);
      if (tab?.id === undefined) return undefined;
      owner = { ...owner, windowId: tab.windowId, tabIds: [tab.id] };
      await this.api.storage.session.set({ [OWNER]: owner });
    }
    try { const window = await this.api.windows.get(owner.windowId); return window.type === 'normal' ? owner : undefined; } catch { return undefined; }
  }
  private async removeOwned(ids: number[], windowId: number): Promise<void> {
    // Snapshot the window and recheck each ID immediately before removing it. Moved tabs survive.
    const current = new Set((await this.api.tabs.query({ windowId })).map(t => t.id));
    for (const id of ids) {
      if (!current.has(id)) continue;
      let tab: chrome.tabs.Tab;
      try { tab = await this.api.tabs.get(id); } catch { continue; }
      if (tab.windowId === windowId) await this.api.tabs.remove(id);
    }
  }
  private async saveReceipt(receipt: Receipt): Promise<void> {
    const receipts = (await this.get<Receipt[]>(this.api.storage.local, RECEIPTS)) ?? [];
    const fresh = receipts.filter(r => r.commandId !== receipt.commandId && r.at > this.now() - 2 * 86400_000).slice(-499);
    await this.api.storage.local.set({ [RECEIPTS]: [...fresh, receipt] });
  }
  private async recoverJournal(): Promise<void> {
    const j = await this.get<Journal>(this.api.storage.local, JOURNAL);
    if (!j) return;
    const owner = await this.owned(await this.get<Ownership>(this.api.storage.session, OWNER));
    if (!owner || owner.lease !== j.lease || owner.windowId !== j.windowId) {
      // A full browser restart clears session storage. Never use old IDs to remove restored/user tabs.
      await this.api.storage.local.remove(JOURNAL); return;
    }
    if (j.phase === 'committing') await this.commit(j);
    else await this.rollback(j);
  }
  private assertDeadline(expiresAt: number): void { if (this.now() >= expiresAt) throw new Error('Handoff expired before restoration completed'); }
  private async rollback(j: Journal): Promise<void> {
    const prefix = `${this.api.runtime.getURL('staging.html')}#${j.lease}/${j.commandId}/`;
    const markers = (await this.api.tabs.query({ windowId: j.windowId })).filter(t => (t.pendingUrl ?? t.url ?? '').startsWith(prefix)).flatMap(t => t.id === undefined ? [] : [t.id]);
    await this.removeOwned([...new Set([...j.staged, ...markers])], j.windowId);
    if (j.previousActive !== undefined) {
      let tab: chrome.tabs.Tab | undefined;
      try { tab = await this.api.tabs.get(j.previousActive); } catch { /* The user may have closed it. */ }
      if (tab?.windowId === j.windowId) await this.api.tabs.update(j.previousActive, { active: true });
    }
    await this.api.storage.local.remove(JOURNAL);
  }
  private async commit(j: Journal): Promise<Receipt> {
    await this.removeOwned(j.previous, j.windowId);
    await this.api.storage.session.set({ [OWNER]: { lease: j.lease, windowId: j.windowId, tabIds: j.staged } satisfies Ownership });
    const receipt: Receipt = { commandId: j.commandId, status: 'applied', warnings: j.warnings, at: this.now() };
    await this.saveReceipt(receipt);
    await this.api.storage.local.set({ lastReceived: { at: receipt.at, sourceName: j.sourceName, warnings: j.warnings } });
    await this.api.storage.local.remove(JOURNAL);
    return receipt;
  }
  private async apply(command: IncomingCommand): Promise<Receipt> {
    await this.recoverJournal();
    const previousReceipt = (await this.get<Receipt[]>(this.api.storage.local, RECEIPTS))?.find(r => r.commandId === command.id);
    if (previousReceipt) return previousReceipt;
    let workspace: Workspace;
    try {
      if (command.status !== 'pending' || !Number.isFinite(command.expiresAt) || command.expiresAt <= this.now()) throw new Error('Handoff expired before it could be applied');
      workspace = workspaceSchema.parse(command.workspace);
    } catch (error) { const result: Receipt = { commandId: command.id, status: 'failed', warnings: [], error: errorText(error), at: this.now() }; await this.saveReceipt(result); return result; }
    let owner = await this.owned(await this.get<Ownership>(this.api.storage.session, OWNER));
    let placeholder: number | undefined;
    if (!owner) {
      owner = { lease: crypto.randomUUID(), windowId: -1, tabIds: [] };
      await this.api.storage.session.set({ [OWNER]: owner });
      const window = await this.api.windows.create({ url: this.marker(owner.lease, 'window', 0), type: 'normal', focused: false });
      if (!window || window.id === undefined) throw new Error('Chrome did not create a handoff window');
      placeholder = window.tabs?.[0]?.id;
      owner = { lease: owner.lease, windowId: window.id, tabIds: placeholder === undefined ? [] : [placeholder] };
      await this.api.storage.session.set({ [OWNER]: owner });
    }
    const previousActive = (await this.api.tabs.query({ windowId: owner.windowId })).find(t => t.active)?.id;
    const j: Journal = { commandId: command.id, sourceName: command.sourceName, expiresAt: command.expiresAt, previousActive, lease: owner.lease, windowId: owner.windowId, previous: owner.tabIds, staged: [], phase: 'staging', warnings: [] };
    await this.api.storage.local.set({ [JOURNAL]: j });
    try {
      for (const tab of workspace.tabs) {
        this.assertDeadline(j.expiresAt);
        const created = await this.api.tabs.create({ windowId: owner.windowId, url: this.marker(j.lease, command.id, j.staged.length), pinned: tab.pinned, active: false });
        if (created.id === undefined) throw new Error('Chrome did not return a created tab ID');
        j.staged.push(created.id);
        await this.api.storage.local.set({ [JOURNAL]: j });
        this.assertDeadline(j.expiresAt);
        await this.api.tabs.update(created.id, { url: tab.url });
        this.assertDeadline(j.expiresAt);
      }
      if (workspace.groups.length && (!this.api.tabGroups || !this.api.tabs.group)) j.warnings.push('Tab groups are unavailable in this browser; tabs were restored ungrouped.');
      else for (const group of workspace.groups) {
        this.assertDeadline(j.expiresAt);
        const ids = workspace.tabs.flatMap((t, i) => t.groupId === group.id ? [j.staged[i]!] : []);
        if (!ids.length) continue;
        const id = await this.api.tabs.group!({ tabIds: ids as [number, ...number[]], createProperties: { windowId: owner.windowId } });
        this.assertDeadline(j.expiresAt);
        await this.api.tabGroups!.update(id, { title: group.title, color: group.color, collapsed: group.collapsed });
      }
      this.assertDeadline(j.expiresAt);
      await this.api.tabs.update(j.staged[workspace.tabs.findIndex(t => t.active)]!, { active: true });
      this.assertDeadline(j.expiresAt);
      await this.api.windows.update(owner.windowId, { focused: true });
      this.assertDeadline(j.expiresAt);
    } catch (error) {
      j.phase = 'rollback';
      // Storage may itself be the failure. Always remove in-memory staged IDs and marker tabs.
      try { await this.api.storage.local.set({ [JOURNAL]: j }); } catch { /* Recovery also discovers unrecorded markers. */ }
      try { await this.rollback(j); } catch (cleanupError) { throw new Error(`${errorText(error)}; cleanup failed: ${errorText(cleanupError)}`); }
      const receipt: Receipt = { commandId: command.id, status: 'failed', warnings: j.warnings, error: errorText(error), at: this.now() };
      try { await this.saveReceipt(receipt); } catch { throw error; }
      return receipt;
    }
    // Once committing, retries finish cleanup instead of opening a second copy.
    j.phase = 'committing'; await this.api.storage.local.set({ [JOURNAL]: j });
    return this.commit(j);
  }
}
