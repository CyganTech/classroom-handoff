import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureWorkspace, WorkspaceReceiver, type BrowserApi } from '../extension/src/workspace.js';
import type { IncomingCommand, Workspace } from '../shared/protocol.js';

// Stateful simulator models Chrome's tab ordering, window ownership and storage lifetime.
class Browser {
  local: Record<string, unknown> = {}; session: Record<string, unknown> = {};
  windows = new Map<number, chrome.windows.Window>(); tabs = new Map<number, chrome.tabs.Tab>();
  groups = new Map<number, chrome.tabGroups.TabGroup>(); nextTab = 1; nextWindow = 1; nextGroup = 1;
  failGroup = false; failCreateAt = 0; creates = 0;
  area = (data: Record<string, unknown>) => ({
    get: async (key: string) => ({ [key]: structuredClone(data[key]) }),
    set: async (values: Record<string, unknown>) => { Object.assign(data, structuredClone(values)); },
    remove: async (key: string) => { delete data[key]; }
  });
  api = {
    storage: { local: this.area(this.local), session: this.area(this.session) },
    runtime: { getURL: (path: string) => 'chrome-extension://test/' + path },
    windows: {
      getLastFocused: async () => ({ ...this.windows.get(1), id: 1, type: 'normal' }),
      get: async (id: number) => { const w = this.windows.get(id); if (!w) throw Error('No window'); return { ...w }; },
      create: async (props: chrome.windows.CreateData) => { const id = this.nextWindow++; const w = { id, type: 'normal', focused: false } as chrome.windows.Window; this.windows.set(id, w); const t = await this.add(id, typeof props.url === 'string' ? props.url : 'about:blank'); return { ...w, tabs: [t] }; },
      update: async (id: number) => { if (!this.windows.has(id)) throw Error('No window'); return { ...this.windows.get(id) }; }
    },
    tabs: {
      query: async ({ windowId }: { windowId?: number }) => windowId === undefined ? [...this.tabs.values()].map(t => ({ ...t })) : this.inWindow(windowId),
      get: async (id: number) => { const t = this.tabs.get(id); if (!t) throw Error('No tab'); return { ...t }; },
      create: async (props: chrome.tabs.CreateProperties) => { this.creates++; if (this.failCreateAt === this.creates) throw Error('create failed'); return this.add(props.windowId!, props.url!, !!props.pinned, !!props.active); },
      update: async (id: number, props: chrome.tabs.UpdateProperties) => { const t = this.tabs.get(id); if (!t) throw Error('No tab'); if (props.active) for (const other of this.tabs.values()) if (other.windowId === t.windowId) other.active = false; Object.assign(t, props); return { ...t }; },
      remove: async (ids: number | number[]) => { for (const id of Array.isArray(ids) ? ids : [ids]) this.tabs.delete(id); },
      group: async ({ tabIds }: { tabIds: number[] }) => { if (this.failGroup) throw Error('group failed'); const id = this.nextGroup++; for (const tid of tabIds) this.tabs.get(tid)!.groupId = id; this.groups.set(id, { id, windowId: this.tabs.get(tabIds[0]!)!.windowId, title: '', color: 'grey', collapsed: false, shared: false }); return id; }
    },
    tabGroups: {
      get: async (id: number) => { const g = this.groups.get(id); if (!g) throw Error('No group'); return { ...g }; },
      update: async (id: number, props: chrome.tabGroups.UpdateProperties) => { if (this.failGroup) throw Error('group failed'); Object.assign(this.groups.get(id)!, props); return { ...this.groups.get(id)! }; }
    }
  } as unknown as BrowserApi;
  inWindow(id: number) { return [...this.tabs.values()].filter(t => t.windowId === id).sort((a, b) => a.index - b.index).map(t => ({ ...t })); }
  async add(windowId: number, url: string, pinned = false, active = false) {
    if (!this.windows.has(windowId)) this.windows.set(windowId, { id: windowId, type: 'normal' } as chrome.windows.Window);
    this.nextWindow = Math.max(this.nextWindow, windowId + 1);
    const existing = this.inWindow(windowId); const index = pinned ? existing.filter(t => t.pinned).length : existing.length;
    for (const t of this.tabs.values()) if (t.windowId === windowId && t.index >= index) t.index++;
    if (active) for (const t of this.tabs.values()) if (t.windowId === windowId) t.active = false;
    const t = { id: this.nextTab++, windowId, index, url, pinned, active, groupId: -1, highlighted: active, incognito: false, selected: active, discarded: false, autoDiscardable: true } as chrome.tabs.Tab;
    this.tabs.set(t.id!, t); return { ...t };
  }
}
const fixture: Workspace = { version: 1, tabs: [
  { url: 'https://one.example/', active: false, pinned: true, groupId: null },
  { url: 'https://two.example/', active: true, pinned: false, groupId: 'g' },
  { url: 'https://three.example/', active: false, pinned: false, groupId: 'g' }
], groups: [{ id: 'g', title: 'Lesson', color: 'blue', collapsed: false }] };
function command(id = 'b42056ea-26c6-4c5b-813c-14a4d25fa011', workspace = fixture): IncomingCommand { return { id, requestId: id, sourceId: 'source', destinationId: 'dest', status: 'pending', createdAt: Date.now(), expiresAt: Date.now() + 60_000, completedAt: null, error: null, warnings: [], sourceName: 'Teacher', workspace }; }

test('capture keeps order, pinned selection and group metadata, omits restricted pages', async () => {
  const b = new Browser(); await b.add(1, 'https://one.example/', true); const two = await b.add(1, 'https://two.example/'); await b.add(1, 'chrome://settings', false, true);
  b.tabs.get(two.id!)!.groupId = 7; b.groups.set(7, { id: 7, windowId: 1, title: 'Lesson', color: 'red', collapsed: true, shared: false });
  const { workspace, warnings } = await captureWorkspace(b.api, 1);
  assert.deepEqual(workspace.tabs.map(t => [t.url, t.pinned, t.active]), [['https://one.example/', true, true], ['https://two.example/', false, false]]);
  assert.deepEqual(workspace.groups, [{ id: '7', title: 'Lesson', color: 'red', collapsed: true }]); assert.equal(warnings.length, 1);
});
test('capture rejects empty and oversized workspaces', async () => { const b = new Browser(); await b.add(1, 'chrome://newtab'); await assert.rejects(captureWorkspace(b.api, 1), /supported/i); for (let i = 0; i < 101; i++) await b.add(1, `https://a.example/${i}`); await assert.rejects(captureWorkspace(b.api, 1), /100/); });
test('restore stages ordered pinned tabs, groups and active tab, then deduplicates delivery', async () => {
  const b = new Browser(); await b.add(1, 'https://unrelated.example/'); const r = new WorkspaceReceiver(b.api); const c = command();
  assert.equal((await r.receive(c)).status, 'applied'); const managed = b.inWindow(2); assert.deepEqual(managed.map(t => [t.url, t.pinned, t.active]), [['https://one.example/', true, false], ['https://two.example/', false, true], ['https://three.example/', false, false]]); assert.equal(b.groups.get(managed[1]!.groupId)?.title, 'Lesson');
  assert.equal((await new WorkspaceReceiver(b.api).receive(c)).status, 'applied'); assert.equal(b.tabs.size, 4);
});
test('repeat removes only owned tabs still in window, preserving moved and untracked tabs', async () => {
  const b = new Browser(); await b.add(1, 'https://unrelated.example/'); const r = new WorkspaceReceiver(b.api); await r.receive(command());
  const old = b.inWindow(2); b.tabs.get(old[0]!.id!)!.windowId = 1; await b.add(2, 'https://user-added.example/');
  await r.receive(command('a42056ea-26c6-4c5b-813c-14a4d25fa022', { version: 1, groups: [], tabs: [{ url: 'https://new.example/', active: true, pinned: false, groupId: null }] }));
  assert.deepEqual(b.inWindow(2).map(t => t.url), ['https://user-added.example/', 'https://new.example/']); assert.equal(b.inWindow(1).length, 2);
});
test('failed staging leaves old workspace intact and persists a failed receipt', async () => {
  const b = new Browser(); const r = new WorkspaceReceiver(b.api); await r.receive(command()); const oldIds = [...b.tabs.keys()]; b.failGroup = true;
  const result = await r.receive(command('a42056ea-26c6-4c5b-813c-14a4d25fa022')); assert.equal(result.status, 'failed'); assert.match(result.error!, /group failed/); assert.deepEqual([...b.tabs.keys()], oldIds);
  b.failGroup = false; assert.equal((await new WorkspaceReceiver(b.api).receive(command('a42056ea-26c6-4c5b-813c-14a4d25fa022'))).status, 'failed');
});
test('full browser restart cannot close reused numeric window or tab IDs', async () => {
  const b = new Browser(); await new WorkspaceReceiver(b.api).receive(command()); const survivor = [...b.tabs.keys()]; b.session = {}; b.api.storage.session = b.area(b.session) as never;
  const result = await new WorkspaceReceiver(b.api).receive(command('a42056ea-26c6-4c5b-813c-14a4d25fa022')); assert.equal(result.status, 'applied'); for (const id of survivor) assert.ok(b.tabs.has(id)); assert.equal(b.windows.size, 2);
});
test('expired commands cannot mutate browser state', async () => { const b = new Browser(); const c = command(); c.expiresAt = Date.now() - 1; assert.equal((await new WorkspaceReceiver(b.api).receive(c)).status, 'failed'); assert.equal(b.tabs.size, 0); });

test('worker interruption during staging is rolled back before command replay', async () => {
  const b = new Browser(); await b.add(1, 'https://unrelated.example/');
  const originalSet = b.api.storage.local.set.bind(b.api.storage.local);
  let paused!: () => void; const boundary = new Promise<void>(resolve => { paused = resolve; }); let blocked = false;
  b.api.storage.local.set = (async (values: Record<string, any>) => {
    await originalSet(values);
    if (!blocked && values.receiveJournal?.phase === 'staging' && values.receiveJournal.staged.length === 1) { blocked = true; paused(); await new Promise(() => {}); }
  }) as typeof b.api.storage.local.set;
  void new WorkspaceReceiver(b.api).receive(command()); await boundary;
  b.api.storage.local.set = originalSet;
  const receipt = await new WorkspaceReceiver(b.api).receive(command());
  assert.equal(receipt.status, 'applied'); assert.equal(b.tabs.size, 4); assert.equal(b.inWindow(1)[0]!.url, 'https://unrelated.example/');
});

test('worker interruption after staging commits the existing tabs without opening duplicates', async () => {
  const b = new Browser(); await b.add(1, 'https://unrelated.example/');
  const originalSet = b.api.storage.local.set.bind(b.api.storage.local);
  let paused!: () => void; const boundary = new Promise<void>(resolve => { paused = resolve; }); let blocked = false;
  b.api.storage.local.set = (async (values: Record<string, any>) => {
    await originalSet(values);
    if (!blocked && values.receiveJournal?.phase === 'committing') { blocked = true; paused(); await new Promise(() => {}); }
  }) as typeof b.api.storage.local.set;
  void new WorkspaceReceiver(b.api).receive(command()); await boundary;
  const staged = b.inWindow(2).filter(t => t.url?.startsWith('https://')).map(t => t.id);
  b.api.storage.local.set = originalSet;
  assert.equal((await new WorkspaceReceiver(b.api).receive(command())).status, 'applied');
  assert.deepEqual(b.inWindow(2).map(t => t.id), staged); assert.equal(b.tabs.size, 4);
});

test('cleanup failure cannot acknowledge applied and retry resumes commit without duplicating tabs', async () => {
  const b = new Browser(); const r = new WorkspaceReceiver(b.api); await r.receive(command());
  const oldId = [...b.tabs.keys()][0]!; const originalRemove = b.api.tabs.remove.bind(b.api.tabs); let fail = true;
  b.api.tabs.remove = (async (id: number) => { if (fail && id === oldId) throw Error('remove failed'); return originalRemove(id); }) as typeof b.api.tabs.remove;
  const c = command('a42056ea-26c6-4c5b-813c-14a4d25fa022'); await assert.rejects(r.receive(c), /remove failed/);
  assert.equal((b.local.receiveReceipts as { commandId: string }[]).some(receipt => receipt.commandId === c.id), false);
  const staged = b.inWindow(1).filter(t => t.id! > 4).map(t => t.id); fail = false;
  assert.equal((await new WorkspaceReceiver(b.api).receive(c)).status, 'applied'); assert.deepEqual(b.inWindow(1).map(t => t.id), staged); assert.equal(b.tabs.size, 3);
});

test('deadline reached during a Chrome API call rolls back staging and preserves the prior workspace', async () => {
  const b = new Browser(); let now = 1000; const r = new WorkspaceReceiver(b.api, () => now); await r.receive(command());
  const oldIds = [...b.tabs.keys()]; const oldActive = b.inWindow(1).find(t => t.active)!.id;
  const create = b.api.tabs.create.bind(b.api.tabs); b.api.tabs.create = (async props => { const tab = await create(props); now = 1200; return tab; }) as typeof b.api.tabs.create;
  const c = command('a42056ea-26c6-4c5b-813c-14a4d25fa022'); c.expiresAt = 1100;
  const result = await r.receive(c); assert.equal(result.status, 'failed'); assert.match(result.error!, /expired/); assert.deepEqual([...b.tabs.keys()], oldIds); assert.equal(b.inWindow(1).find(t => t.active)?.id, oldActive);
});

test('persistent storage write failures still clean up newly created tabs before retry', async () => {
  const b = new Browser(); const set = b.api.storage.local.set.bind(b.api.storage.local); let failed = false;
  b.api.storage.local.set = (async (values: Record<string, any>) => { if (values.receiveJournal?.staged.length === 1) failed = true; if (failed) throw Error('Storage quota exceeded'); await set(values); }) as typeof b.api.storage.local.set;
  const c = command(); await assert.rejects(new WorkspaceReceiver(b.api).receive(c), /Storage quota exceeded/);
  b.api.storage.local.set = set; assert.equal((await new WorkspaceReceiver(b.api).receive(c)).status, 'applied');
  assert.deepEqual(b.inWindow(1).map(t => t.url), ['https://one.example/', 'https://two.example/', 'https://three.example/']);
});

test('worker death after tab creation but before recording its ID recovers the staging marker', async () => {
  const b = new Browser(); const create = b.api.tabs.create.bind(b.api.tabs); let paused!: () => void; const boundary = new Promise<void>(resolve => { paused = resolve; });
  b.api.tabs.create = (async props => { await create(props); paused(); return new Promise(() => {}); }) as typeof b.api.tabs.create;
  const c = command(); void new WorkspaceReceiver(b.api).receive(c); await boundary;
  b.api.tabs.create = create; assert.equal((await new WorkspaceReceiver(b.api).receive(c)).status, 'applied');
  assert.deepEqual(b.inWindow(1).map(t => t.url), ['https://one.example/', 'https://two.example/', 'https://three.example/']);
});

test('worker death after initial window creation discovers the session lease marker without another window', async () => {
  const b = new Browser(); const create = b.api.windows.create.bind(b.api.windows); let paused!: () => void; const boundary = new Promise<void>(resolve => { paused = resolve; });
  b.api.windows.create = (async (props: chrome.windows.CreateData) => { await create(props); paused(); return new Promise(() => {}); }) as typeof b.api.windows.create;
  const c = command(); void new WorkspaceReceiver(b.api).receive(c); await boundary;
  b.api.windows.create = create; assert.equal((await new WorkspaceReceiver(b.api).receive(c)).status, 'applied');
  assert.equal(b.windows.size, 1); assert.deepEqual(b.inWindow(1).map(t => t.url), ['https://one.example/', 'https://two.example/', 'https://three.example/']);
});

test('a browser without tab grouping support restores tabs with a limitation warning', async () => {
  const b = new Browser(); delete b.api.tabGroups; delete b.api.tabs.group;
  const result = await new WorkspaceReceiver(b.api).receive(command()); assert.equal(result.status, 'applied'); assert.match(result.warnings[0]!, /ungrouped/); assert.equal(b.tabs.size, 3);
});

test('current-tab capture sends only the selected tab with its group and leaves full-window capture unchanged', async () => {
  const b = new Browser(); await b.add(1, 'https://one.example/'); const selected = await b.add(1, 'https://two.example/', false, true); await b.add(1, 'https://three.example/');
  b.tabs.get(selected.id!)!.groupId = 7; b.groups.set(7, { id: 7, windowId: 1, title: 'Lesson', color: 'red', collapsed: false, shared: false });
  const result = await captureWorkspace(b.api, 1, true);
  assert.deepEqual(result.workspace.tabs, [{ url: 'https://two.example/', pinned: false, active: true, groupId: '7' }]);
  assert.equal(result.workspace.groups[0]?.title, 'Lesson'); assert.deepEqual(result.warnings, []);
  assert.equal((await captureWorkspace(b.api, 1)).workspace.tabs.length, 3);
});
test('current-tab capture rejects a restricted selected tab without substituting a supported tab', async () => {
  const b = new Browser(); await b.add(1, 'https://one.example/'); await b.add(1, 'chrome://settings', false, true);
  await assert.rejects(captureWorkspace(b.api, 1, true), /current tab.*HTTP\(S\)/i);
});
test('current-tab capture preserves a pinned selected tab and ignores the full-window tab limit', async () => {
  const b = new Browser(); await b.add(1, 'https://selected.example/', true, true);
  for (let i = 0; i < 101; i++) await b.add(1, `https://other.example/${i}`);
  const result = await captureWorkspace(b.api, 1, true);
  assert.equal(result.workspace.tabs.length, 1); assert.equal(result.workspace.tabs[0]?.pinned, true); assert.equal(result.workspace.tabs[0]?.active, true);
});
