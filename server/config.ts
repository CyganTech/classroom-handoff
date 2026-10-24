import { resolve } from 'node:path';
import { normalizeBackendUrl } from '../shared/protocol.js';

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  publicUrl: string;
  pairingTtlMs: number;
  commandTtlMs: number;
  retentionMs: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  authTimeoutMs: number;
  sweepIntervalMs: number;
  rateWindowMs: number;
  registrationLimit: number;
  pairingAttemptLimit: number;
  pairingCreationLimit: number;
  requestLimit: number;
  maxConnections: number;
  now: () => number;
}
function numeric(env: NodeJS.ProcessEnv, key: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer between ${min} and ${max}`);
  return value;
}
export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    host: env.HOST || '127.0.0.1', port: numeric(env, 'PORT', 8787, 0, 65535),
    dataDir: resolve(env.DATA_DIR || '.data'), publicUrl: normalizeBackendUrl(env.PUBLIC_URL || 'http://localhost:8787'),
    pairingTtlMs: numeric(env, 'PAIRING_TTL_MS', 300_000), commandTtlMs: numeric(env, 'COMMAND_TTL_MS', 120_000),
    retentionMs: numeric(env, 'RETENTION_MS', 86_400_000), heartbeatIntervalMs: numeric(env, 'HEARTBEAT_INTERVAL_MS', 20_000),
    heartbeatTimeoutMs: numeric(env, 'HEARTBEAT_TIMEOUT_MS', 65_000), authTimeoutMs: numeric(env, 'AUTH_TIMEOUT_MS', 5000),
    sweepIntervalMs: numeric(env, 'SWEEP_INTERVAL_MS', 1000), rateWindowMs: numeric(env, 'RATE_WINDOW_MS', 60_000),
    registrationLimit: numeric(env, 'REGISTRATION_LIMIT', 20), pairingAttemptLimit: numeric(env, 'PAIRING_ATTEMPT_LIMIT', 10),
    pairingCreationLimit: numeric(env, 'PAIRING_CREATION_LIMIT', 10), requestLimit: numeric(env, 'REQUEST_LIMIT', 240),
    maxConnections: numeric(env, 'MAX_CONNECTIONS', 1000), now: Date.now
  };
}
