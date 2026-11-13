import type { DiscoveryResult } from '../../shared/protocol.js';
import type { DiscoveryState } from '../../shared/ui.js';
import { BackendClient, type ConnectionSettings } from './transport.js';
import { errorText } from './workspace.js';

export const DISCOVERY_ENABLED = 'discoveryEnabled';
export const DISCOVERY_PUBLISHED = 'discoveryPublished';
interface Published { backendUrl: string; deviceId: string; key: string | null }

/** Profile identity is a discovery hint only; peer creation still requires approval. */
export class ProfileDiscovery {
  constructor(private readonly api: typeof chrome) {}
  async setEnabled(enabled: boolean): Promise<void> {
    await this.api.storage.local.set({ [DISCOVERY_ENABLED]: enabled });
  }
  async sync(config: ConnectionSettings | undefined): Promise<DiscoveryState> {
    const enabled = (await this.api.storage.local.get(DISCOVERY_ENABLED))[DISCOVERY_ENABLED] === true;
    const state: DiscoveryState = { enabled, available: false, suggestions: [], requests: [] };
    if (!config) return state;
    let key: string | null = null;
    if (enabled) {
      try {
        const profile = await this.api.identity?.getProfileUserInfo({ accountStatus: 'ANY' });
        if (profile?.id) {
          const scoped = new TextEncoder().encode(JSON.stringify(['classroom-handoff-discovery-v1', new URL(config.backendUrl).origin, profile.id]));
          key = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', scoped)), byte => byte.toString(16).padStart(2, '0')).join('');
          state.available = true;
          state.email = profile.email || undefined;
        }
      } catch { /* Missing permissions/profile information must preserve manual pairing. */ }
    }
    try {
      const previous = (await this.api.storage.local.get(DISCOVERY_PUBLISHED))[DISCOVERY_PUBLISHED] as Published | undefined;
      const client = new BackendClient(config.backendUrl, config.credentials);
      if (key !== null || previous && previous.key !== null) {
        // Re-publish even unchanged keys: membership is durable on the server,
        // and PUT is idempotent without invalidating requests for the same key.
        const published = { backendUrl: config.backendUrl, deviceId: config.credentials.deviceId, key } satisfies Published;
        // Record cleanup intent before publishing: a lost HTTP response can still
        // mean the server committed. Keep a non-null marker until clearing is confirmed.
        if (key) await this.api.storage.local.set({ [DISCOVERY_PUBLISHED]: published });
        await client.request('/api/discovery', 'PUT', { accountKey: key });
        if (!key) await this.api.storage.local.set({ [DISCOVERY_PUBLISHED]: published });
      }
      if (enabled && key) {
        const result = await client.request<DiscoveryResult>('/api/discovery');
        state.suggestions = result.suggestions;
        state.requests = result.requests;
      }
    } catch (error) { state.error = `Suggestions unavailable: ${errorText(error)} You can still use a pairing code.`; }
    return state;
  }
}
