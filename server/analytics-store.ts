import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AnalyticsClientEvent, AnalyticsMetadata, AnalyticsReport, ClientInfo } from '../shared/analytics.js';
export interface AnalyticsOptions { enabled: boolean; retentionDays: number; now: () => number }
const dayMs = 86400000;
const calendar = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' });
export function analyticsDate(timestamp: number): string {
  const parts = Object.fromEntries(calendar.formatToParts(timestamp).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export function validateRange(from: string, to: string): void {
  for (const date of [from, to]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw Error('Invalid report date');
  }
  if (from > to || (Date.parse(to) - Date.parse(from)) / dayMs > 179) throw Error('Report range must contain 1–180 days');
}
export function csvCell(value: unknown): string {
  let text = String(value ?? '');
  if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
export class AnalyticsStore {
  private nextPurge = 0;
  constructor(private readonly db: DatabaseSync, readonly options: AnalyticsOptions) {
    db.exec(`CREATE TABLE IF NOT EXISTS analytics_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS analytics_browsers (device_id TEXT PRIMARY KEY, name TEXT NOT NULL, removed INTEGER NOT NULL DEFAULT 0, platform TEXT NOT NULL DEFAULT 'unknown', version TEXT NOT NULL DEFAULT 'unknown', updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS analytics_handoffs (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, destination_id TEXT NOT NULL, created_at INTEGER NOT NULL, completed_at INTEGER, status TEXT NOT NULL, tabs INTEGER NOT NULL, mode TEXT NOT NULL DEFAULT 'unknown');
      CREATE INDEX IF NOT EXISTS analytics_handoff_date ON analytics_handoffs(created_at);
      CREATE TABLE IF NOT EXISTS analytics_pairings (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, destination_id TEXT NOT NULL, method TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS analytics_pairing_date ON analytics_pairings(created_at);
      CREATE TABLE IF NOT EXISTS analytics_events (id TEXT NOT NULL, device_id TEXT NOT NULL, type TEXT NOT NULL, reason TEXT NOT NULL, occurred_at INTEGER NOT NULL, PRIMARY KEY(device_id,id));
      CREATE INDEX IF NOT EXISTS analytics_event_date ON analytics_events(occurred_at);`);
    db.function('analytics_day', { deterministic: true }, value => analyticsDate(Number(value)));
    if (options.enabled) db.prepare("INSERT OR IGNORE INTO analytics_meta VALUES('started_at',?)").run(options.now());
  }
  private write(action: () => void, force = false): void {
    if (!this.options.enabled && !force) return;
    try { this.db.exec('SAVEPOINT analytics_write'); action(); this.db.exec('RELEASE analytics_write'); }
    catch {
      try { this.db.exec('ROLLBACK TO analytics_write; RELEASE analytics_write'); } catch { /* Do not mask the operational result. */ }
      console.error('Analytics persistence failed');
    }
  }
  private browser(id: string, now: number): void {
    const device = this.db.prepare('SELECT name FROM devices WHERE id=?').get(id) as { name: string } | undefined;
    if (!device) return;
    this.db.prepare(`INSERT INTO analytics_browsers(device_id,name,updated_at) VALUES(?,?,?) ON CONFLICT(device_id) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at`).run(id, device.name, now);
  }
  client(id: string, info: ClientInfo, now: number): void {
    this.write(() => { this.browser(id, now); this.db.prepare('UPDATE analytics_browsers SET platform=?,version=?,updated_at=? WHERE device_id=? AND removed=0').run(info.platform, info.version, now, id); });
  }
  accepted(id: string, source: string, destination: string, tabs: number, now: number, metadata?: AnalyticsMetadata): void {
    this.write(() => {
      const result = this.db.prepare("INSERT OR IGNORE INTO analytics_handoffs(id,source_id,destination_id,created_at,status,tabs,mode) VALUES(?,?,?,?,'pending',?,?)").run(id, source, destination, now, tabs, metadata?.mode ?? 'unknown');
      if (!result.changes) return;
      this.browser(source, now); this.browser(destination, now);
      if (metadata) this.db.prepare('UPDATE analytics_browsers SET platform=?,version=? WHERE device_id=?').run(metadata.platform, metadata.version, source);
    });
  }
  terminal(id: string, status: 'applied' | 'failed' | 'expired', now: number): void {
    this.write(() => { this.db.prepare("UPDATE analytics_handoffs SET status=?,completed_at=? WHERE id=? AND status='pending'").run(status, now, id); });
  }
  paired(source: string, destination: string, method: 'code' | 'easy-pair', now: number): void {
    this.write(() => {
      this.browser(source, now); this.browser(destination, now);
      this.db.prepare('INSERT INTO analytics_pairings VALUES(?,?,?,?,?)').run(randomUUID(), source, destination, method, now);
    });
  }
  events(id: string, events: AnalyticsClientEvent[], now: number): void {
    this.write(() => {
      this.browser(id, now);
      const insert = this.db.prepare('INSERT OR IGNORE INTO analytics_events VALUES(?,?,?,?,?)');
      const startedAt = Number(this.db.prepare("SELECT value FROM analytics_meta WHERE key='started_at'").get()?.value ?? now);
      for (const event of events) if (event.occurredAt >= Math.max(startedAt, now - dayMs) && event.occurredAt <= now + 300000) insert.run(event.id, id, event.type, event.reason, Math.min(now, event.occurredAt));
    });
  }
  rejected(id: string, requestId: string, reason: 'offline' | 'unpaired' | 'busy' | 'size', now: number): void {
    this.write(() => { this.browser(id, now); this.db.prepare('INSERT OR IGNORE INTO analytics_events VALUES(?,?,?,?,?)').run(`rejected:${requestId}`, id, 'server_rejected', reason, now); });
  }
  removed(id: string): void {
    this.write(() => { this.db.prepare("UPDATE analytics_browsers SET name='Removed browser',removed=1 WHERE device_id=?").run(id); }, true);
  }
  purge(now: number): void {
    if (now < this.nextPurge) return;
    this.nextPurge = now + 60000;
    this.write(() => {
      const cutoff = now - this.options.retentionDays * dayMs;
      this.db.prepare('DELETE FROM analytics_handoffs WHERE created_at<?').run(cutoff);
      this.db.prepare('DELETE FROM analytics_pairings WHERE created_at<?').run(cutoff);
      this.db.prepare('DELETE FROM analytics_events WHERE occurred_at<?').run(cutoff);
      this.db.prepare(`DELETE FROM analytics_browsers WHERE updated_at<? AND device_id NOT IN (SELECT source_id FROM analytics_handoffs UNION SELECT destination_id FROM analytics_handoffs UNION SELECT source_id FROM analytics_pairings UNION SELECT destination_id FROM analytics_pairings UNION SELECT device_id FROM analytics_events)`).run(cutoff);
    }, true);
  }
  report(from: string, to: string): AnalyticsReport {
    validateRange(from, to); const now = this.options.now(); this.purge(now);
    const range = [Math.max(Date.parse(from), now - this.options.retentionDays * dayMs), Date.parse(to) + 2 * dayMs, from, to];
    const where = 'created_at>=? AND created_at<? AND analytics_day(created_at)>=? AND analytics_day(created_at)<=?';
    const cohort = `SELECT * FROM analytics_handoffs WHERE ${where}`;
    const sum = this.db.prepare(`SELECT COUNT(*) handoffs,COALESCE(SUM(tabs),0) tabs,COALESCE(SUM(status='applied'),0) applied,COALESCE(SUM(status='failed'),0) failed,COALESCE(SUM(status='expired'),0) expired,COALESCE(SUM(status='pending'),0) pending,COALESCE(SUM(mode='whole-window'),0) wholeWindow,COALESCE(SUM(mode='current-tab'),0) currentTab,COALESCE(SUM(mode='unknown'),0) unknown FROM (${cohort})`).get(...range) as unknown as Record<string, number>;
    const daily = this.db.prepare(`SELECT analytics_day(created_at) date,COUNT(*) handoffs,SUM(tabs) tabs,SUM(status='applied') applied,SUM(status='failed') failed,SUM(status='expired') expired,SUM(status='pending') pending FROM (${cohort}) GROUP BY date ORDER BY date`).all(...range) as unknown as AnalyticsReport['daily'];
    const byDay = new Map(daily.map(d => [d.date, d]));
    const days: AnalyticsReport['daily'] = [];
    for (let ts = Date.parse(from); ts <= Date.parse(to); ts += dayMs) { const date = new Date(ts).toISOString().slice(0, 10); days.push(byDay.get(date) ?? { date, handoffs: 0, tabs: 0, applied: 0, failed: 0, expired: 0, pending: 0 }); }
    const appliedCount = sum.applied!;
    const durationAt = (offset: number) => Number((this.db.prepare(`SELECT completed_at-created_at duration FROM (${cohort}) WHERE status='applied' ORDER BY duration LIMIT 1 OFFSET ?`).get(...range, offset) as { duration: number }).duration);
    const median = appliedCount ? appliedCount % 2 ? durationAt(Math.floor(appliedCount / 2)) : (durationAt(appliedCount / 2 - 1) + durationAt(appliedCount / 2)) / 2 : null;
    const p95 = appliedCount ? durationAt(Math.ceil(appliedCount * .95) - 1) : null;
    const roles = `WITH cohort AS (${cohort}), roles AS (SELECT source_id id,1 sent,0 received,status,created_at FROM cohort UNION ALL SELECT destination_id id,0 sent,1 received,status,created_at FROM cohort), totals AS (SELECT id,SUM(sent) sent,SUM(received) received,SUM(status='applied') applied,SUM(status='failed') failed,SUM(status='expired') expired,SUM(status='pending') pending,MAX(created_at) lastActivity FROM roles GROUP BY id), ids AS (SELECT id FROM devices UNION SELECT device_id id FROM analytics_browsers) SELECT ids.id,COALESCE(d.name,b.name,'Removed browser') name,COALESCE(b.platform,'unknown') platform,COALESCE(b.version,'unknown') version,COALESCE(t.sent,0) sent,COALESCE(t.received,0) received,COALESCE(t.applied,0) applied,COALESCE(t.failed,0) failed,COALESCE(t.expired,0) expired,COALESCE(t.pending,0) pending,COALESCE(t.lastActivity,0) lastActivity FROM ids LEFT JOIN totals t ON t.id=ids.id LEFT JOIN devices d ON d.id=ids.id LEFT JOIN analytics_browsers b ON b.device_id=ids.id ORDER BY lastActivity DESC,name,ids.id`;
    const browsers = this.db.prepare(roles).all(...range) as unknown as AnalyticsReport['browsers'];
    const pairings = this.db.prepare(`SELECT COALESCE(SUM(method='code'),0) code,COALESCE(SUM(method='easy-pair'),0) easyPair FROM analytics_pairings WHERE ${where}`).get(...range) as unknown as AnalyticsReport['pairings'];
    const events = this.db.prepare(`SELECT COALESCE(SUM(type='capture_failed'),0) captureFailures,COALESCE(SUM(type='send_failed'),0) sendFailures,COALESCE(SUM(type='server_rejected'),0) rejectedRequests FROM analytics_events WHERE occurred_at>=? AND occurred_at<? AND analytics_day(occurred_at)>=? AND analytics_day(occurred_at)<=?`).get(...range) as unknown as { captureFailures: number; sendFailures: number; rejectedRequests: number };
    const terminal = sum.applied! + sum.failed! + sum.expired!;
    return { timezone: 'America/Chicago', retentionDays: this.options.retentionDays, from, to, enabled: this.options.enabled, startedAt: (this.db.prepare("SELECT value FROM analytics_meta WHERE key='started_at'").get() as { value: number } | undefined)?.value ?? null, generatedAt: now,
      summary: { handoffs: sum.handoffs!, applied: sum.applied!, failed: sum.failed!, expired: sum.expired!, pending: sum.pending!, tabs: sum.tabs!, activeBrowsers: browsers.filter(b => b.sent + b.received > 0).length, successRate: terminal ? sum.applied! / terminal : null, medianConfirmationMs: median, p95ConfirmationMs: p95, ...events },
      daily: days, modes: { wholeWindow: sum.wholeWindow!, currentTab: sum.currentTab!, unknown: sum.unknown! }, pairings: { ...pairings }, browsers };
  }
  csv(report: AnalyticsReport, kind: 'daily' | 'browsers'): string {
    const fields = kind === 'daily' ? ['date', 'handoffs', 'applied', 'failed', 'expired', 'pending', 'tabs'] : ['name', 'platform', 'version', 'sent', 'received', 'applied', 'failed', 'expired', 'pending', 'lastActivity'];
    const rows = kind === 'daily' ? report.daily : report.browsers;
    return [fields.map(field => csvCell(field === 'lastActivity' ? 'lastActivityUTC' : field)).join(','), ...rows.map(row => fields.map(field => { const value = (row as unknown as Record<string, unknown>)[field]; return csvCell(field === 'lastActivity' ? value ? new Date(Number(value)).toISOString() : '' : value); }).join(','))].join('\r\n') + '\r\n';
  }
}
