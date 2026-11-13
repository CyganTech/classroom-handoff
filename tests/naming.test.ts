import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultBrowserName, shouldMigrateName } from '../extension/src/naming.js';

test('browser defaults describe the platform with a stable unambiguous suffix and need no account information', async () => {
  for (const [os, label] of [['cros', 'Chromebook'], ['win', 'Windows browser'], ['mac', 'Mac browser'], ['linux', 'Linux browser'], ['unknown', 'Browser']]) {
    const values: Record<string, unknown> = {}; let calls = 0;
    const api = { runtime: { getPlatformInfo: async () => { calls++; return { os }; } }, storage: { local: { get: async (key: string) => ({ [key]: values[key] }), set: async (patch: Record<string, unknown>) => { Object.assign(values, patch); } } } } as unknown as typeof chrome;
    const first = await defaultBrowserName(api);
    assert.ok(first.startsWith(label + ' · ')); assert.match(first.split(' · ')[1]!, /^[2-9A-HJ-NP-Z]{4}$/);
    assert.equal(await defaultBrowserName(api), first); assert.equal(calls, 1);
  }
});
test('platform failures produce a usable generic default', async () => {
  const values: Record<string, unknown> = {};
  const api = { runtime: { getPlatformInfo: async () => { throw Error('Unavailable'); } }, storage: { local: { get: async (key: string) => ({ [key]: values[key] }), set: async (patch: Record<string, unknown>) => { Object.assign(values, patch); } } } } as unknown as typeof chrome;
  assert.match(await defaultBrowserName(api), /^Browser · [2-9A-HJ-NP-Z]{4}$/);
});
test('legacy migration is restricted to untouched generated names and excludes policy and custom names', () => {
  assert.equal(shouldMigrateName({ name: 'Managed browser ab12cd34' }), true);
  for (const name of ['Teacher laptop', 'Managed browser example', 'Managed browser ab12cd345', 'Chromebook · 7K2M']) assert.equal(shouldMigrateName({ name }), false);
  assert.equal(shouldMigrateName({ name: 'Managed browser ab12cd34', nameSource: 'custom' }), false);
  assert.equal(shouldMigrateName({ name: 'Managed browser ab12cd34' }, 'Managed browser ab12cd34'), false);
});

test('concurrent default-name initialization produces one suffix for migration and UI', async () => {
  const values: Record<string, unknown> = {}; let platformCalls = 0;
  const api = { runtime: { getPlatformInfo: async () => { platformCalls++; return { os: 'cros' }; } }, storage: { local: {
    get: async (key: string) => { const value = values[key]; await new Promise(resolve => setTimeout(resolve, 5)); return { [key]: value }; },
    set: async (patch: Record<string, unknown>) => { await new Promise(resolve => setTimeout(resolve, 5)); Object.assign(values, patch); }
  } } } as unknown as typeof chrome;
  const names = await Promise.all([defaultBrowserName(api), defaultBrowserName(api), defaultBrowserName(api)]);
  assert.equal(new Set(names).size, 1); assert.equal(platformCalls, 1); assert.equal(values.defaultBrowserName, names[0]);
});
