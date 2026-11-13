import { normalizeBackendUrl } from '../../shared/protocol.js';
import type { UiState } from '../../shared/ui.js';
import { element, errorMessage, readState, renderConnection, requestUi, showText, startStatePolling } from './ui-client.js';

import { renderPairingRequests } from './pairing-ui.js';

const errorBox = element('error');
const messageBox = element('message');
const dialog = element<HTMLDialogElement>('confirm-dialog');
const nameInput = element<HTMLInputElement>('device-name');
let state: UiState | undefined;
let busy = false;
let actionError: string | undefined;
let pollError: string | undefined;
let pairing: { code: string; expiresAt: number } | undefined;

function render(next: UiState): void {
  state = next;
  element('registration').hidden = next.configured;
  element('configured').hidden = !next.configured;
  renderConnection(next);
  const backendInput = element<HTMLInputElement>('backend-url');
  backendInput.readOnly = !!next.managed;
  if (next.managed && document.activeElement !== backendInput) backendInput.value = next.managedBackendUrl ?? '';
  showText(element('managed-notice'), next.managed ? 'Managed by your organization. The server address comes from Google Admin. Pair only the browsers you trust. Your browser name can be changed below.' : undefined);
  if (document.activeElement !== nameInput) nameInput.value = next.name ?? '';
  element('backend-display').textContent = next.backendUrl ?? '';
  element('device-id').textContent = next.deviceId ?? '';
  element('peer-count').textContent = String(next.devices.length);
  element('no-peers').hidden = next.devices.length > 0;
  element('peers').replaceChildren(...next.devices.map(device => {
    const item = document.createElement('li');
    item.className = 'peer';
    const icon = document.createElement('span');
    icon.className = 'peer-icon';
    icon.textContent = '▱';
    icon.setAttribute('aria-hidden', 'true');
    const content = document.createElement('div');
    content.className = 'peer-content';
    const name = document.createElement('div'); name.className = 'peer-name'; name.textContent = device.name;
    const meta = document.createElement('div'); meta.className = 'peer-meta';
    meta.textContent = device.online ? 'Online · ready to receive' : device.lastSeen ? `Offline · last seen ${new Date(device.lastSeen).toLocaleString()}` : 'Offline';
    content.append(name, meta);
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'text-button'; remove.textContent = 'Remove'; remove.disabled = busy;
    remove.setAttribute('aria-label', `Remove ${device.name}`);
    remove.addEventListener('click', () => {
      void confirmAction('Remove paired browser?', `Remove “${device.name}”? These browsers will no longer be able to send handoffs to each other until paired again.`, 'Remove').then(confirmed => {
        if (confirmed) void runAction(async () => { const result = await requestUi({ action: 'peer.remove', deviceId: device.id }); if (result.state) state = result.state; }, 'Browser removed.');
      });
    });
    item.append(icon, content, remove);
    return item;
  }));
  for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('button:not([value])'))) button.disabled = busy;
  element<HTMLButtonElement>('register-submit').disabled = busy || !!next.managed && !next.managedBackendUrl;
  showText(errorBox, actionError || pollError || next.lastError);
  renderDiscovery(next);
  renderPairing();
}

function renderDiscovery(next: UiState): void {
  const discovery = next.discovery;
  const toggle = element<HTMLInputElement>('discovery-enabled');
  if (!busy) toggle.checked = discovery?.enabled ?? false;
  toggle.disabled = busy;
  const requests = discovery?.requests ?? [];
  renderPairingRequests(element('pairing-requests'), requests, next.deviceId, busy, action => {
    void runAction(async () => { await requestUi(action); }, action.action === 'pairing.accept' ? 'Browsers paired. You can now send handoffs.' : 'Pairing request declined.');
  });
  const suggestions = (discovery?.suggestions ?? []).filter(device => !requests.some(r => r.source.id === device.id || r.destination.id === device.id));
  showText(element('discovery-status'), discovery?.error ?? (!discovery?.enabled ? 'Suggestions are off. You can always use a code below.' : !discovery.available ? 'No primary Chrome account is available. Sign in to the browser profile, or use a code below.' : `Using ${discovery.email ?? 'your Chrome profile account'}. ${suggestions.length ? 'Choose a browser, then approve on that browser.' : requests.length ? 'Waiting for the requests below.' : 'No other browsers found. Enable suggestions on your other browser using the same Chrome account and Handoff server, and keep it awake.'}`));
  const list = element('suggestions');
  const signature = JSON.stringify([suggestions, busy]);
  if (list.dataset.rendered === signature) return;
  list.dataset.rendered = signature;
  list.replaceChildren(...suggestions.map(device => {
    const row = document.createElement('li'); row.className = 'peer';
    const content = document.createElement('div'); content.className = 'peer-content';
    const name = document.createElement('div'); name.className = 'peer-name'; name.textContent = device.name;
    const detail = document.createElement('div'); detail.className = 'peer-meta'; detail.textContent = 'Online · matching Chrome profile';
    content.append(name, detail);
    const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary-button'; button.textContent = 'Easy pair'; button.disabled = busy;
    button.setAttribute('aria-label', `Easy pair with ${device.name}`);
    button.addEventListener('click', () => { void runAction(async () => { await requestUi({ action: 'pairing.request', destinationId: device.id }); }, 'Request sent. Open Handoff on the other browser to accept.'); });
    row.append(content, button); return row;
  }));
}

function renderPairing(): void {
  element('pairing-result').hidden = !pairing;
  if (!pairing) return;
  element<HTMLButtonElement>('copy-code').disabled = busy || pairing.expiresAt <= Date.now();
  element('pairing-code').textContent = pairing.code;
  const seconds = Math.max(0, Math.ceil((pairing.expiresAt - Date.now()) / 1000));
  element('pairing-expiry').textContent = seconds > 0 ? `Expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}. Use it once.` : 'This code has expired. Create a new code to pair another browser.';
}

async function runAction(action: () => Promise<void>, success?: string): Promise<void> {
  if (busy) return;
  busy = true;
  actionError = undefined;
  showText(messageBox, undefined);
  if (state) render(state);
  try { await action(); state = await readState(); showText(messageBox, success); }
  catch (error) { actionError = errorMessage(error); }
  finally { busy = false; if (state) render(state); else showText(errorBox, actionError); }
}

function confirmAction(title: string, text: string, action: string): Promise<boolean> {
  if (dialog.open) return Promise.resolve(false);
  element('confirm-title').textContent = title;
  element('confirm-text').textContent = text;
  element('confirm-action').textContent = action;
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
    dialog.returnValue = 'cancel';
    dialog.showModal();
  });
}

element<HTMLFormElement>('register-form').addEventListener('submit', event => {
  event.preventDefault();
  if (busy) return;
  let backendUrl: string;
  const name = element<HTMLInputElement>('register-name').value.trim();
  try { backendUrl = normalizeBackendUrl(element<HTMLInputElement>('backend-url').value); if (!name) throw new Error('Give this browser a name.'); }
  catch (error) { actionError = errorMessage(error); showText(errorBox, actionError); return; }
  // Begin the permission request synchronously in the user gesture, before any awaits.
  const permission = state?.managed ? Promise.resolve(true) : chrome.permissions.request({ origins: [`${backendUrl}/*`] });
  void runAction(async () => {
    if (!await permission) throw new Error('Server access was not granted. Connect again and allow access to your handoff server.');
    const result = await requestUi({ action: 'configure', backendUrl, name });
    if (result.state) state = result.state;
  }, 'This browser is connected. Pair your other browser below.');
});
element<HTMLFormElement>('rename-form').addEventListener('submit', event => {
  event.preventDefault();
  const name = nameInput.value.trim();
  if (!name) { showText(errorBox, 'Give this browser a name.'); return; }
  void runAction(async () => { const result = await requestUi({ action: 'rename', name }); if (result.state) state = result.state; }, 'Browser name saved.');
});
element<HTMLInputElement>('discovery-enabled').addEventListener('change', event => {
  const enabled = (event.target as HTMLInputElement).checked;
  void runAction(async () => { await requestUi({ action: 'discovery.enable', enabled }); });
});
element('copy-code').addEventListener('click', () => {
  void runAction(async () => {
    if (!pairing || pairing.expiresAt <= Date.now()) throw new Error('Create a new code before copying.');
    try { await navigator.clipboard.writeText(pairing.code); }
    catch { throw new Error('Could not copy. Select the code and copy it manually.'); }
  }, 'Code copied. Paste it into your other browser.');
});
element('create-code').addEventListener('click', () => {
  void runAction(async () => { const result = await requestUi({ action: 'pairing.create' }); if (!result.pairing) throw new Error('The server did not return a pairing code.'); pairing = result.pairing; }, 'Pairing code created. Enter it on your other browser.');
});
element<HTMLFormElement>('claim-form').addEventListener('submit', event => {
  event.preventDefault();
  const code = element<HTMLInputElement>('claim-code').value.trim();
  if (!code) { showText(errorBox, 'Enter a pairing code.'); return; }
  void runAction(async () => { const result = await requestUi({ action: 'pairing.claim', code }); if (result.state) state = result.state; element<HTMLInputElement>('claim-code').value = ''; }, 'Browsers paired. Open the extension popup to send a handoff.');
});
element('reset').addEventListener('click', () => {
  void confirmAction('Disconnect this browser?', 'This forgets this browser’s registration and paired browsers. Existing browser windows remain open. Set up and pair this browser again to use Handoff.', 'Disconnect').then(confirmed => {
    if (confirmed) void runAction(async () => { const result = await requestUi({ action: 'reset' }); pairing = undefined; if (result.state) state = result.state; }, 'Browser disconnected. You can connect it again below.');
  });
});
const countdown = window.setInterval(renderPairing, 1000);
window.addEventListener('pagehide', () => window.clearInterval(countdown), { once: true });
startStatePolling(next => { pollError = undefined; render(next); }, error => { pollError = errorMessage(error); showText(errorBox, actionError || pollError); }, () => busy);
