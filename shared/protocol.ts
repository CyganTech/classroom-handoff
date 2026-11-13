import { z } from 'zod';

export const MAX_TABS = 100;
export const MAX_MESSAGE_BYTES = 512 * 1024;
export const groupColors = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'] as const;
export function isSupportedUrl(value: string): boolean {
  try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password; } catch { return false; }
}
export const tabSchema = z.object({
  url: z.string().min(1).max(8192).refine(isSupportedUrl, 'Only HTTP(S) URLs without embedded credentials are supported'),
  pinned: z.boolean(), active: z.boolean(), groupId: z.string().max(64).nullable()
}).strict();
export const groupSchema = z.object({ id: z.string().min(1).max(64), title: z.string().max(200), color: z.enum(groupColors), collapsed: z.boolean() }).strict();
export const workspaceSchema = z.object({ version: z.literal(1), tabs: z.array(tabSchema).min(1).max(MAX_TABS), groups: z.array(groupSchema).max(MAX_TABS) }).strict().superRefine((w, ctx) => {
  const ids = new Set(w.groups.map(g => g.id));
  if (ids.size !== w.groups.length) ctx.addIssue({ code: 'custom', message: 'Duplicate group ID' });
  if (w.tabs.filter(t => t.active).length !== 1) ctx.addIssue({ code: 'custom', message: 'Exactly one tab must be active' });
  let unpinnedSeen = false;
  const closedGroups = new Set<string>(); let lastGroup: string | null = null;
  for (const t of w.tabs) {
    if (!t.pinned) unpinnedSeen = true;
    if (t.pinned && unpinnedSeen) ctx.addIssue({ code: 'custom', message: 'Pinned tabs must precede unpinned tabs' });
    if (t.groupId !== null && (!ids.has(t.groupId) || t.pinned)) ctx.addIssue({ code: 'custom', message: 'Invalid group membership' });
    if (t.groupId !== lastGroup) { if (lastGroup) closedGroups.add(lastGroup); if (t.groupId && closedGroups.has(t.groupId)) ctx.addIssue({ code: 'custom', message: 'Group tabs must be contiguous' }); lastGroup = t.groupId; }
  }
});
export type Workspace = z.infer<typeof workspaceSchema>;
export type WorkspaceTab = z.infer<typeof tabSchema>;
export type WorkspaceGroup = z.infer<typeof groupSchema>;
export const deviceNameSchema = z.string().trim().min(1).max(64);
export interface Credentials { deviceId: string; token: string }
export interface Device { id: string; name: string; online: boolean; lastSeen: number | null }
export interface PairingRequest { id: string; source: Device; destination: Device; expiresAt: number }
export interface DiscoveryResult { suggestions: Device[]; requests: PairingRequest[] }
export type CommandStatus = 'pending' | 'applied' | 'failed' | 'expired';
export interface PublicCommand { id: string; requestId: string; sourceId: string; destinationId: string; status: CommandStatus; createdAt: number; expiresAt: number; completedAt: number | null; error: string | null; warnings: string[] }
export interface IncomingCommand extends PublicCommand { sourceName: string; workspace: Workspace }
export type ServerMessage = { type: 'ready'; deviceId: string } | { type: 'pong' } | { type: 'devices_changed' } | { type: 'handoff'; command: IncomingCommand } | { type: 'command_updated'; command: PublicCommand } | { type: 'error'; error: string };
export type ClientMessage = { type: 'authenticate'; deviceId: string; token: string } | { type: 'ping' } | { type: 'ack'; commandId: string; status: 'applied' | 'failed'; error?: string; warnings?: string[] };
export const ackSchema = z.object({ type: z.literal('ack'), commandId: z.string().uuid(), status: z.enum(['applied', 'failed']), error: z.string().max(500).optional(), warnings: z.array(z.string().max(300)).max(30).optional() }).strict();
export const handoffSchema = z.object({ destinationId: z.string().uuid(), requestId: z.string().uuid(), workspace: workspaceSchema }).strict();
export function normalizeBackendUrl(value: string): string {
  const u = new URL(value.trim());
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) throw new Error('Use a backend origin only, such as https://handoff.example.org');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new Error('HTTPS is required except on localhost');
  return u.origin;
}

export const commandStatusSchema = z.enum(['pending', 'applied', 'failed', 'expired']);
const commandShape = {
  id: z.string().uuid(), requestId: z.string().uuid(), sourceId: z.string().uuid(), destinationId: z.string().uuid(),
  status: commandStatusSchema, createdAt: z.number().int().nonnegative(), expiresAt: z.number().int().nonnegative(),
  completedAt: z.number().int().nonnegative().nullable(), error: z.string().max(500).nullable(), warnings: z.array(z.string().max(300)).max(30)
};
export const publicCommandSchema = z.object(commandShape).strict();
export const incomingCommandSchema = z.object({ ...commandShape, sourceName: deviceNameSchema, workspace: workspaceSchema }).strict();
export const serverMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), deviceId: z.string().uuid() }).strict(),
  z.object({ type: z.literal('pong') }).strict(),
  z.object({ type: z.literal('devices_changed') }).strict(),
  z.object({ type: z.literal('handoff'), command: incomingCommandSchema }).strict(),
  z.object({ type: z.literal('command_updated'), command: publicCommandSchema }).strict(),
  z.object({ type: z.literal('error'), error: z.string().max(500) }).strict()
]);
