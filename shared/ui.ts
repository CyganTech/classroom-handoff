import type { Device, PairingRequest, PublicCommand } from './protocol.js';
export interface DiscoveryState {
  enabled: boolean; available: boolean; email?: string; error?: string;
  suggestions: Device[]; requests: PairingRequest[];
}
export interface UiState {
  discovery?: DiscoveryState;
  managed?: boolean; managedBackendUrl?: string;
  configured: boolean; backendUrl?: string; deviceId?: string; name?: string;
  connected: boolean; devices: Device[]; preferredDestinationId?: string;
  lastCommand?: PublicCommand; lastError?: string; captureWarnings?: string[];
  lastReceived?: { at: number; sourceName: string; warnings: string[] };
}
export type UiRequest =
  | { action: 'state' }
  | { action: 'configure'; backendUrl: string; name: string }
  | { action: 'rename'; name: string }
  | { action: 'discovery.enable'; enabled: boolean }
  | { action: 'pairing.request'; destinationId: string }
  | { action: 'pairing.accept' | 'pairing.decline'; requestId: string }
  | { action: 'pairing.create' }
  | { action: 'pairing.claim'; code: string }
  | { action: 'peer.remove'; deviceId: string }
  | { action: 'destination'; deviceId: string }
  | { action: 'handoff'; destinationId: string; windowId?: number }
  | { action: 'reset' };
export type UiResponse = { ok: true; state?: UiState; pairing?: { code: string; expiresAt: number }; command?: PublicCommand } | { ok: false; error: string };
