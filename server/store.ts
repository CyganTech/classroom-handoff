import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { CommandStatus, Credentials, Device, PublicCommand, Workspace } from '../shared/protocol.js';

interface DeviceRow { id: string; name: string; token_hash: string; last_seen: number | null }
export interface CommandRow {
  id: string; request_id: string; source_id: string; destination_id: string; status: CommandStatus;
  created_at: number; expires_at: number; completed_at: number | null; error: string | null; warnings: string;
  payload: string | null; request_hash: string;
}
export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
export function publicCommand(row: CommandRow): PublicCommand {
  return { id: row.id, requestId: row.request_id, sourceId: row.source_id, destinationId: row.destination_id, status: row.status,
    createdAt: row.created_at, expiresAt: row.expires_at, completedAt: row.completed_at, error: row.error, warnings: JSON.parse(row.warnings) as string[] };
}
export class Store {
  readonly db: DatabaseSync;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dataDir, 'handoff.sqlite'));
    chmodSync(join(dataDir, 'handoff.sqlite'), 0o600);
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, last_seen INTEGER);
      CREATE TABLE IF NOT EXISTS peers (a TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE, b TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE, PRIMARY KEY(a,b), CHECK(a < b));
      CREATE TABLE IF NOT EXISTS pairings (code_hash TEXT PRIMARY KEY, device_id TEXT NOT NULL UNIQUE REFERENCES devices(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, request_id TEXT NOT NULL, source_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        destination_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE, status TEXT NOT NULL CHECK(status IN ('pending','applied','failed','expired')),
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, completed_at INTEGER, error TEXT, warnings TEXT NOT NULL DEFAULT '[]',
        payload TEXT, request_hash TEXT NOT NULL, UNIQUE(source_id,request_id));
      CREATE UNIQUE INDEX IF NOT EXISTS one_pending_destination ON commands(destination_id) WHERE status = 'pending';
      CREATE INDEX IF NOT EXISTS command_expiry ON commands(status,expires_at);`);
  }
  register(name: string): Credentials {
    const deviceId = randomUUID(); const token = randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO devices(id,name,token_hash) VALUES (?,?,?)').run(deviceId, name, digest(token));
    return { deviceId, token };
  }
  authenticate(token: string): DeviceRow | undefined {
    return this.db.prepare('SELECT * FROM devices WHERE token_hash=?').get(digest(token)) as unknown as DeviceRow | undefined;
  }
  getDevice(id: string): DeviceRow | undefined { return this.db.prepare('SELECT * FROM devices WHERE id=?').get(id) as unknown as DeviceRow | undefined; }
  device(row: DeviceRow, online: boolean): Device { return { id: row.id, name: row.name, online, lastSeen: row.last_seen }; }
  peerRows(id: string): DeviceRow[] {
    return this.db.prepare('SELECT d.* FROM devices d JOIN peers p ON (p.a=? AND p.b=d.id) OR (p.b=? AND p.a=d.id) ORDER BY d.name,d.id').all(id, id) as unknown as DeviceRow[];
  }
  arePeers(first: string, second: string): boolean {
    const [a, b] = [first, second].sort(); return !!this.db.prepare('SELECT 1 FROM peers WHERE a=? AND b=?').get(a!, b!);
  }
  rename(id: string, name: string): void { this.db.prepare('UPDATE devices SET name=? WHERE id=?').run(name, id); }
  touch(id: string, now: number): void { this.db.prepare('UPDATE devices SET last_seen=? WHERE id=?').run(now, id); }
  revoke(id: string): void { this.db.prepare('DELETE FROM devices WHERE id=?').run(id); this.purgeDisk(); }
  createPairing(id: string, expiresAt: number): string {
    const raw = randomBytes(9).toString('hex').toUpperCase();
    this.db.prepare('INSERT INTO pairings(code_hash,device_id,expires_at) VALUES(?,?,?) ON CONFLICT(device_id) DO UPDATE SET code_hash=excluded.code_hash,expires_at=excluded.expires_at').run(digest(raw), id, expiresAt);
    return raw.match(/.{1,6}/g)!.join('-');
  }
  claimPairing(code: string, claimingId: string, now: number): string | undefined {
    const row = this.db.prepare('SELECT device_id,expires_at FROM pairings WHERE code_hash=?').get(digest(code)) as { device_id: string; expires_at: number } | undefined;
    if (!row || row.expires_at <= now || row.device_id === claimingId) return undefined;
    const [a, b] = [row.device_id, claimingId].sort();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM pairings WHERE code_hash=?').run(digest(code));
      this.db.prepare('INSERT OR IGNORE INTO peers(a,b) VALUES(?,?)').run(a!, b!);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return row.device_id;
  }
  removePeer(first: string, second: string, now: number): CommandRow[] {
    const [a, b] = [first, second].sort();
    this.db.prepare('DELETE FROM peers WHERE a=? AND b=?').run(a!, b!);
    const commands = this.db.prepare("SELECT * FROM commands WHERE status='pending' AND ((source_id=? AND destination_id=?) OR (source_id=? AND destination_id=?))").all(first, second, second, first) as unknown as CommandRow[];
    for (const row of commands) this.complete(row.id, 'failed', now, 'Device pairing was removed', []);
    return commands.map(row => this.getCommand(row.id)!);
  }
  getCommand(id: string): CommandRow | undefined { return this.db.prepare('SELECT * FROM commands WHERE id=?').get(id) as unknown as CommandRow | undefined; }
  byRequest(source: string, requestId: string): CommandRow | undefined { return this.db.prepare('SELECT * FROM commands WHERE source_id=? AND request_id=?').get(source, requestId) as unknown as CommandRow | undefined; }
  pending(destination: string): CommandRow[] { return this.db.prepare("SELECT * FROM commands WHERE destination_id=? AND status='pending' ORDER BY created_at").all(destination) as unknown as CommandRow[]; }
  createCommand(source: string, destination: string, requestId: string, workspace: Workspace, requestHash: string, now: number, expiresAt: number): CommandRow {
    const id = randomUUID();
    this.db.prepare("INSERT INTO commands(id,request_id,source_id,destination_id,status,created_at,expires_at,payload,request_hash) VALUES(?,?,?,?,'pending',?,?,?,?)").run(id, requestId, source, destination, now, expiresAt, JSON.stringify(workspace), requestHash);
    return this.getCommand(id)!;
  }
  complete(id: string, status: Exclude<CommandStatus, 'pending'>, now: number, error: string | null, warnings: string[]): CommandRow | undefined {
    this.db.prepare("UPDATE commands SET status=?,completed_at=?,error=?,warnings=?,payload=NULL WHERE id=? AND status='pending'").run(status, now, error, JSON.stringify(warnings), id);
    this.purgeDisk(); return this.getCommand(id);
  }
  expire(now: number, retentionMs: number): CommandRow[] {
    const expired = this.db.prepare("SELECT * FROM commands WHERE status='pending' AND expires_at<=?").all(now) as unknown as CommandRow[];
    this.db.prepare("UPDATE commands SET status='expired',completed_at=?,error='Handoff expired before acknowledgement',payload=NULL WHERE status='pending' AND expires_at<=?").run(now, now);
    this.db.prepare('DELETE FROM pairings WHERE expires_at<=?').run(now);
    const deleted = this.db.prepare("DELETE FROM commands WHERE status!='pending' AND completed_at<?").run(now - retentionMs);
    if (expired.length || deleted.changes) this.purgeDisk();
    return expired.map(row => this.getCommand(row.id)!).filter(Boolean);
  }
  private purgeDisk(): void { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); }
  close(): void { this.db.close(); }
}
