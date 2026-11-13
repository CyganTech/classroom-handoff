import type { PairingRequest } from '../../shared/protocol.js';
import type { UiRequest } from '../../shared/ui.js';

type PairingAction = Extract<UiRequest, { action: 'pairing.accept' | 'pairing.decline' }>;
export function renderPairingRequests(node: HTMLElement, requests: PairingRequest[], deviceId: string | undefined, busy: boolean, act: (action: PairingAction) => void): void {
  const signature = JSON.stringify([requests, deviceId, busy]);
  if (node.dataset.rendered === signature) return;
  node.dataset.rendered = signature;
  node.replaceChildren(...requests.map(request => {
    const incoming = request.destination.id === deviceId;
    const row = document.createElement('li'); row.className = 'pairing-request';
    const title = document.createElement('strong');
    title.textContent = incoming ? `${request.source.name} wants to pair` : `Request sent to ${request.destination.name}`;
    const detail = document.createElement('p'); detail.className = 'field-help';
    detail.textContent = `${incoming ? 'Accept only if you recognize this browser. Pairing allows automatic incoming handoffs in both directions.' : 'Open Handoff on that browser and accept the request.'} Expires at ${new Date(request.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`;
    row.append(title, detail);
    if (incoming) {
      const actions = document.createElement('div'); actions.className = 'pairing-actions';
      for (const [label, action] of [['Accept', 'pairing.accept'], ['Decline', 'pairing.decline']] as const) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary-button'; button.textContent = label; button.disabled = busy;
        button.setAttribute('aria-label', `${label} pairing with ${request.source.name}`);
        button.addEventListener('click', () => act({ action, requestId: request.id })); actions.append(button);
      }
      row.append(actions);
    }
    return row;
  }));
  node.hidden = requests.length === 0;
}
