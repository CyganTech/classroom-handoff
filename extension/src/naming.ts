export type NameSource = 'generated' | 'custom' | 'policy';
const DEFAULT_NAME = 'defaultBrowserName';
const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const initializations = new WeakMap<typeof chrome, Promise<string>>();
export async function defaultBrowserName(api: typeof chrome): Promise<string> {
  const pending = initializations.get(api); if (pending) return pending;
  const work = loadDefaultBrowserName(api); initializations.set(api, work);
  try { return await work; } finally { if (initializations.get(api) === work) initializations.delete(api); }
}
async function loadDefaultBrowserName(api: typeof chrome): Promise<string> {
  const saved = (await api.storage.local.get(DEFAULT_NAME))[DEFAULT_NAME];
  if (typeof saved === 'string' && saved.length > 0) return saved;
  let os: string | undefined;
  try { os = (await api.runtime.getPlatformInfo()).os; } catch { /* No extra permissions are needed; use the generic fallback. */ }
  const label = ({ cros: 'Chromebook', win: 'Windows browser', mac: 'Mac browser', linux: 'Linux browser' } as Record<string, string>)[os ?? ''] ?? 'Browser';
  const suffix = Array.from(crypto.getRandomValues(new Uint8Array(4)), byte => alphabet[byte & 31]).join('');
  const name = `${label} · ${suffix}`;
  await api.storage.local.set({ [DEFAULT_NAME]: name }); return name;
}
export function shouldMigrateName(config: { name: string; nameSource?: NameSource }, policyName?: string): boolean {
  return config.nameSource === undefined && config.name !== policyName && /^Managed browser [a-fA-F0-9]{8}$/.test(config.name);
}
