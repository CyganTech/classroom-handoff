import { normalizeBackendUrl } from '../../shared/protocol.js';
export function httpsUrl(value: string): string { const u = new URL(value); if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw new Error('Release URLs must be HTTPS without credentials, query or fragment'); return u.href; }
export function createManagedManifest(original: Record<string, unknown>, publicKey: Buffer, updateUrl: string, backendUrl?: string): Record<string, any> {
  const backend = backendUrl ? normalizeBackendUrl(backendUrl) : undefined;
  if (backend && !backend.startsWith('https://')) throw new Error('Managed deployment requires HTTPS');
  return { ...original, key: publicKey.toString('base64'), update_url: httpsUrl(updateUrl), host_permissions: [backend ? `${backend}/*` : 'https://*/*'], optional_host_permissions: [], storage: { managed_schema: 'managed-schema.json' } };
}
export function updateManifest(id: string, version: string, codebase: string): string {
  if (!/^[a-p]{32}$/.test(id) || !/^\d+(\.\d+){0,3}$/.test(version) || version.split('.').some(v => Number(v) > 65535)) throw new Error('Invalid extension identity or version');
  const url = httpsUrl(codebase).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0"><app appid="${id}"><updatecheck codebase="${url}" version="${version}" /></app></gupdate>\n`;
}
export function googleAdminPolicy(backendUrl: string) { return { BackendUrl: { Value: normalizeBackendUrl(backendUrl) }, AutoRegister: { Value: true } }; }
interface ReleaseIdentity { extensionId: string; version: string; crxSha256: string }
export function assertReleaseUpdate(previous: ReleaseIdentity, next: ReleaseIdentity): void {
  if (previous.extensionId !== next.extensionId) throw new Error('Signing key identity differs from the published extension. Restore the original key.');
  const oldParts = previous.version.split('.').map(Number); const newParts = next.version.split('.').map(Number);
  let comparison = 0;
  for (let i = 0; i < 4; i++) { const difference = (newParts[i] ?? 0) - (oldParts[i] ?? 0); if (difference) { comparison = Math.sign(difference); break; } }
  if (comparison < 0 || comparison === 0 && previous.crxSha256 !== next.crxSha256) throw new Error('Increment the Chrome extension version before changing a published package; version bytes are immutable.');
}

import { realpath } from 'node:fs/promises';
import { resolve, dirname, basename, join, sep } from 'node:path';
async function resolvedDestination(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; const parent = dirname(path); if (parent === path) throw error; return join(await resolvedDestination(parent), basename(path)); }
}
export async function assertPrivateKeyOutsidePublicOutput(output: string, privateKey: string): Promise<void> {
  let site = await resolvedDestination(resolve(output)); let key = await resolvedDestination(resolve(privateKey));
  if (process.platform === 'darwin' || process.platform === 'win32') { site = site.toLowerCase(); key = key.toLowerCase(); }
  if (key === site || key.startsWith(site + sep)) throw new Error('The private signing key must stay outside the public output directory (including symlink destinations).');
}
