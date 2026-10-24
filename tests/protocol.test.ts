import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workspaceSchema, isSupportedUrl, normalizeBackendUrl, handoffSchema, MAX_TABS } from '../shared/protocol.js';
const plain = () => ({ version: 1, tabs: [{ url: 'https://example.com/lesson?q=one#part', pinned: false, active: true, groupId: null }], groups: [] });
test('validates normal workspace without changing URLs', () => assert.equal(workspaceSchema.parse(plain()).tabs[0]?.url, plain().tabs[0]?.url));
test('rejects executable, local, browser and embedded credential URLs', () => {
  for (const url of ['chrome://settings', 'file:///lesson', 'javascript:alert(1)', 'data:text/html,a', 'about:blank', 'https://user:secret@example.com', 'https://user@example.com', 'not a URL']) {
    assert.equal(isSupportedUrl(url), false, url);
    assert.equal(workspaceSchema.safeParse({ ...plain(), tabs: [{ ...plain().tabs[0], url }] }).success, false, url);
  }
});
test('requires exactly one active tab and enforces count and pinned order', () => {
  assert.equal(workspaceSchema.safeParse({ ...plain(), tabs: [] }).success, false);
  assert.equal(workspaceSchema.safeParse({ ...plain(), tabs: [{ ...plain().tabs[0], active: false }] }).success, false);
  assert.equal(workspaceSchema.safeParse({ ...plain(), tabs: [plain().tabs[0], plain().tabs[0]] }).success, false);
  assert.equal(workspaceSchema.safeParse({ ...plain(), tabs: Array(MAX_TABS + 1).fill(plain().tabs[0]) }).success, false);
  assert.equal(workspaceSchema.safeParse({ ...plain(), tabs: [plain().tabs[0], { ...plain().tabs[0], active: false, pinned: true }] }).success, false);
});
test('validates group membership, uniqueness, contiguous order and pinned incompatibility', () => {
  const group = { id: 'lesson', title: 'Lesson', color: 'cyan', collapsed: false };
  const tab = { ...plain().tabs[0], groupId: 'lesson' };
  assert.equal(workspaceSchema.safeParse({ ...plain(), tabs: [tab], groups: [group] }).success, true);
  assert.equal(workspaceSchema.safeParse({ ...plain(), tabs: [tab] }).success, false);
  assert.equal(workspaceSchema.safeParse({ ...plain(), tabs: [tab], groups: [group, group] }).success, false);
  assert.equal(workspaceSchema.safeParse({ ...plain(), tabs: [{ ...tab, pinned: true }], groups: [group] }).success, false);
  assert.equal(workspaceSchema.safeParse({ ...plain(), tabs: [tab, { ...plain().tabs[0], active: false }, { ...tab, active: false }], groups: [group] }).success, false);
  assert.equal(workspaceSchema.safeParse({ ...plain(), groups: [{ ...group, color: 'invalid' }] }).success, false);
});
test('strict schemas bound extra fields and require UUID request identifiers', () => {
  assert.equal(workspaceSchema.safeParse({ ...plain(), cookies: 'forbidden' }).success, false);
  assert.equal(handoffSchema.safeParse({ workspace: plain(), requestId: 'x', destinationId: 'y' }).success, false);
});
test('backend configuration requires HTTPS outside loopback and accepts origins only', () => {
  for (const url of ['http://school.example', 'ftp://localhost', 'https://x/path', 'https://user:pass@x', 'https://x?q=1', 'https://x/#a']) assert.throws(() => normalizeBackendUrl(url), Error, url);
  assert.equal(normalizeBackendUrl(' https://handoff.example.org/ '), 'https://handoff.example.org');
  assert.equal(normalizeBackendUrl('http://localhost:8787'), 'http://localhost:8787');
  assert.equal(normalizeBackendUrl('http://127.0.0.1:8787/'), 'http://127.0.0.1:8787');
});
