import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { AnalyticsStore, analyticsDate, validateRange, csvCell } from '../server/analytics-store.js';
function fixture(now = Date.UTC(2026, 10, 13, 18)) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE devices(id TEXT PRIMARY KEY, name TEXT NOT NULL)');
  db.prepare('INSERT INTO devices VALUES(?,?)').run('a', '=Teacher'); db.prepare('INSERT INTO devices VALUES(?,?)').run('b', 'Display');
  const store = new AnalyticsStore(db, { enabled: true, retentionDays: 180, now: () => now });
  return { db, store, now };
}
test('analytics counts logical handoffs and outcomes once, excludes pending from success, and preserves unknown metadata', () => {
  const { db, store, now } = fixture();
  try {
    store.accepted('one', 'a', 'b', 3, now, { mode: 'current-tab', version: '0.2.4', platform: 'cros' });
    store.accepted('one', 'a', 'b', 3, now); store.terminal('one', 'applied', now + 1200); store.terminal('one', 'failed', now + 1300);
    store.accepted('two', 'a', 'b', 1, now); store.terminal('two', 'expired', now + 2000);
    store.accepted('pending', 'a', 'b', 2, now);
    store.paired('a', 'b', 'code', now); store.paired('a', 'b', 'easy-pair', now + 1);
    const report = store.report('2026-11-13', '2026-11-13');
    assert.equal(report.summary.handoffs, 3); assert.equal(report.summary.applied, 1); assert.equal(report.summary.expired, 1); assert.equal(report.summary.pending, 1);
    assert.equal(report.summary.successRate, 0.5); assert.equal(report.summary.medianConfirmationMs, 1200); assert.equal(report.summary.p95ConfirmationMs, 1200);
    assert.equal(report.summary.activeBrowsers, 2); assert.equal(report.summary.tabs, 6);
    assert.deepEqual(report.modes, { currentTab: 1, wholeWindow: 0, unknown: 2 });
    assert.equal(report.browsers.find(b => b.id === 'a')?.sent, 3); assert.equal(report.browsers.find(b => b.id === 'b')?.received, 3);
    assert.equal(report.browsers.find(b => b.id === 'a')?.version, '0.2.4');
  } finally { db.close(); }
});
test('analytics ignores pre-collection commands, purges history independently, and redacts removed installations', () => {
  const { db, store, now } = fixture();
  try {
    store.terminal('untracked-old-command', 'applied', now);
    store.accepted('one', 'a', 'b', 1, now); store.terminal('one', 'failed', now + 1);
    store.removed('a'); db.prepare('DELETE FROM devices WHERE id=?').run('a');
    const report = store.report('2026-11-13', '2026-11-13');
    assert.equal(report.summary.handoffs, 1); assert.equal(report.browsers.find(b => b.id === 'a')?.name, 'Removed browser');
    store.purge(now + 181 * 86400000);
    assert.equal(Number((db.prepare('SELECT COUNT(*) n FROM analytics_handoffs').get() as any).n), 0);
  } finally { db.close(); }
});
test('disabled collection preserves reports but stores no new usage or sensitive fields', () => {
  const { db, store, now } = fixture();
  try {
    store.accepted('one', 'a', 'b', 1, now); store.terminal('one', 'applied', now + 4);
    const disabled = new AnalyticsStore(db, { enabled: false, retentionDays: 180, now: () => now });
    disabled.accepted('two', 'a', 'b', 1, now);
    disabled.client('a', { version: '0.2.4', platform: 'win' }, now);
    assert.equal(disabled.report('2026-11-13', '2026-11-13').summary.handoffs, 1);
    const tables = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name LIKE 'analytics_%'").all().map(r => r.sql).join(' ');
    for (const forbidden of ['payload', 'url', 'email', 'token', 'account_key', 'warnings', 'error TEXT']) assert.equal(tables.includes(forbidden), false);
  } finally { db.close(); }
});
test('event ingestion deduplicates IDs, separates captures/send failures/rejections and drops stale client timestamps', () => {
  const { db, store, now } = fixture();
  try {
    const event = { id: 'cf95a222-e008-4f93-a684-32bbb497720c', type: 'capture_failed' as const, reason: 'tab_unsupported' as const, occurredAt: now };
    store.events('a', [event, event], now); store.rejected('a', 'request', 'offline', now); store.rejected('a', 'request', 'offline', now);
    store.events('a', [{ ...event, id: 'ae95a222-e008-4f93-a684-32bbb497720c', occurredAt: now - 2 * 86400000 }], now);
    const report = store.report('2026-11-13', '2026-11-13');
    assert.equal(report.summary.captureFailures, 1); assert.equal(report.summary.rejectedRequests, 1); assert.equal(report.summary.handoffs, 0);
  } finally { db.close(); }
});
test('report dates follow Chicago DST/calendar boundaries and CSV prevents formula execution', () => {
  assert.equal(analyticsDate(Date.UTC(2026, 2, 8, 5, 59)), '2026-03-07');
  assert.equal(analyticsDate(Date.UTC(2026, 2, 8, 6)), '2026-03-08');
  assert.equal(analyticsDate(Date.UTC(2026, 10, 1, 5)), '2026-11-01');
  assert.throws(() => validateRange('2026-02-30', '2026-03-01'), /date|range/i);
  assert.throws(() => validateRange('2026-11-13', '2026-11-12'), /range/i);
  assert.throws(() => validateRange('2020-01-01', '2026-11-13'), /range/i);
  assert.ok(csvCell(' \t+cmd').startsWith("\"'"));
  assert.equal(csvCell('=Teacher'), '"\'=Teacher"'); assert.equal(csvCell(' \\t+cmd'), '" \\t+cmd"');
  assert.equal(csvCell('a,"b"'), '"a,""b"""');
});


test('client events before the initial collection boundary are never backfilled', () => {
  const { db, store, now } = fixture();
  try {
    store.events('a', [{ id: 'cf95a222-e008-4f93-a684-32bbb497720c', type: 'capture_failed', reason: 'capture_error', occurredAt: now - 1 }], now);
    assert.equal(store.report('2026-11-13', '2026-11-13').summary.captureFailures, 0);
  } finally { db.close(); }
});
