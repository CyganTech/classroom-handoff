import { z } from 'zod';
import { deviceNameSchema, normalizeBackendUrl } from '../../shared/protocol.js';
export interface ManagedPolicy { backendUrl?: string; autoRegister: boolean; deviceName?: string }
const policySchema = z.object({ BackendUrl: z.string().optional(), AutoRegister: z.boolean().optional(), DeviceName: deviceNameSchema.optional() });
export function parseManagedPolicy(value: unknown): ManagedPolicy {
  const raw = policySchema.parse(value);
  return { ...(raw.BackendUrl !== undefined ? { backendUrl: normalizeBackendUrl(raw.BackendUrl) } : {}), autoRegister: raw.AutoRegister ?? true, ...(raw.DeviceName ? { deviceName: raw.DeviceName } : {}) };
}
declare const __HANDOFF_MANAGED_RELEASE__: boolean;
export const isManagedRelease = typeof __HANDOFF_MANAGED_RELEASE__ !== 'undefined' && __HANDOFF_MANAGED_RELEASE__;
