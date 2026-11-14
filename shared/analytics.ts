import { z } from 'zod';
export const clientInfoSchema = z.object({ version: z.string().regex(/^\d+(\.\d+){0,3}$/).max(32), platform: z.enum(['cros', 'win', 'mac', 'linux', 'openbsd', 'android', 'unknown']) }).strict();
export type ClientInfo = z.infer<typeof clientInfoSchema>;
export const analyticsMetadataSchema = clientInfoSchema.extend({ mode: z.enum(['whole-window', 'current-tab']) }).strict();
export type AnalyticsMetadata = z.infer<typeof analyticsMetadataSchema>;
export const clientEventSchema = z.object({ id: z.string().uuid(), type: z.enum(['capture_failed', 'send_failed']), reason: z.enum(['tab_unsupported', 'capture_error', 'network', 'rejected', 'unknown']), occurredAt: z.number().int().nonnegative(), requestId: z.string().uuid().optional() }).strict();
export type AnalyticsClientEvent = z.infer<typeof clientEventSchema>;
export interface AnalyticsReport {
  timezone: string; retentionDays: number; from: string; to: string; enabled: boolean; startedAt: number | null; generatedAt: number;
  summary: { handoffs: number; applied: number; failed: number; expired: number; pending: number; successRate: number | null; activeBrowsers: number; tabs: number; medianConfirmationMs: number | null; p95ConfirmationMs: number | null; captureFailures: number; sendFailures: number; rejectedRequests: number };
  daily: Array<{ date: string; handoffs: number; applied: number; failed: number; expired: number; pending: number; tabs: number }>;
  modes: { wholeWindow: number; currentTab: number; unknown: number };
  pairings: { code: number; easyPair: number };
  browsers: Array<{ id: string; name: string; platform: string; version: string; sent: number; received: number; applied: number; failed: number; expired: number; pending: number; lastActivity: number }>;
}
