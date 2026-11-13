import type { UiState } from '../../shared/ui.js';
import { element, errorMessage, renderConnection, requestUi, showText, startStatePolling } from './ui-client.js';

import { renderPairingRequests } from './pairing-ui.js';

const destination = element<HTMLSelectElement>('destination');
const handoff = element<HTMLButtonElement>('handoff');
const errorBox = element('error');
let state: UiState | undefined;
let busy = false;
let actionError: string | undefined;
let pollError: string | undefined;

function render(next: UiState): void {
  state = next;
  renderConnection(next);
  if (!busy) element<HTMLInputElement>('current-tab-only').checked = next.preferences?.currentTabOnly ?? false;
  element<HTMLInputElement>('current-tab-only').disabled = busy;
  renderPairingRequests(element('pairing-requests'), next.discovery?.requests ?? [], next.deviceId, busy, action => {
    void runAction(async () => { const result = await requestUi(action); if (result.state) state = result.state; });
  });
  element('welcome').hidden = next.configured;
  element('handoff-panel').hidden = !next.configured;
  element('device-name').textContent = next.name ?? 'Classroom Handoff';
  const chosen = destination.value || next.preferredDestinationId || '';
  const options = next.devices.map(device => {
    const option = document.createElement('option');
    option.value = device.id;
    option.textContent = `${device.name} · ${device.online ? 'Online' : 'Offline'}`;
    return option;
  });
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = next.devices.length ? 'Choose a device' : 'No paired browsers yet';
  destination.replaceChildren(placeholder, ...options);
  const preferred = next.devices.some(d => d.id === chosen) ? chosen : next.devices.some(d => d.id === next.preferredDestinationId) ? next.preferredDestinationId! : '';
  destination.value = preferred;
  destination.disabled = busy || next.devices.length === 0;
  const selected = next.devices.find(d => d.id === preferred);
  element('destination-help').textContent = !next.devices.length ? 'Choose Pair another browser to get started.' : selected && !selected.online ? 'This browser is offline. Reconnect it, then send again.' : 'The receiving browser opens your workspace automatically.';
  handoff.disabled = busy || !next.connected || !selected?.online || next.lastCommand?.status === 'pending';
  handoff.querySelector('span')!.textContent = busy ? 'Sending…' : 'Handoff';
  const commandBox = element('command-status');
  const command = next.lastCommand;
  commandBox.className = `notice ${command?.status ?? ''}`;
  const targetName = next.devices.find(d => d.id === command?.destinationId)?.name ?? 'the receiving browser';
  const statusText = command?.status === 'pending' ? `Waiting for ${targetName} to apply your workspace. This is not yet confirmed.` : command?.status === 'applied' ? `Workspace opened on ${targetName}.` : command?.status === 'expired' ? 'No acknowledgement arrived before this handoff expired. Check the receiving browser before sending again.' : command?.status === 'failed' ? `The receiving browser could not apply this handoff. ${command.error ?? 'Please try again.'}` : undefined;
  showText(commandBox, statusText);
  const warnings = [...new Set([...(next.captureWarnings ?? []), ...(command?.warnings ?? [])])];
  const warningList = element('capture-warnings');
  warningList.replaceChildren(...warnings.map(warning => { const item = document.createElement('li'); item.textContent = warning; return item; }));
  warningList.hidden = warnings.length === 0;
  const received = next.lastReceived;
  showText(element('received-status'), received ? `Last received from ${received.sourceName} at ${new Date(received.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.${received.warnings.length ? ` ${received.warnings.join(' ')}` : ''}` : undefined);
  showText(errorBox, actionError || pollError || next.lastError);
}

async function runAction(action: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  actionError = undefined;
  if (state) render(state);
  try { await action(); }
  catch (error) { actionError = errorMessage(error); }
  finally { busy = false; if (state) render(state); else showText(errorBox, actionError); }
}

const openSetup = () => { void chrome.runtime.openOptionsPage().catch(error => showText(errorBox, errorMessage(error))); };
for (const id of ['open-settings', 'start-setup', 'manage-devices']) element(id).addEventListener('click', openSetup);
element('pair-browser').addEventListener('click', () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('options.html#pair-browser') }).catch(error => showText(errorBox, errorMessage(error)));
});
destination.addEventListener('change', () => {
  const deviceId = destination.value;
  if (!deviceId) { if (state) render(state); return; }
  void runAction(async () => { const result = await requestUi({ action: 'destination', deviceId }); if (result.state) state = result.state; });
});
element<HTMLInputElement>('current-tab-only').addEventListener('change', event => {
  const currentTabOnly = (event.target as HTMLInputElement).checked;
  void runAction(async () => { const result = await requestUi({ action: 'preferences.update', currentTabOnly }); if (result.state) state = result.state; });
});
handoff.addEventListener('click', () => {
  const destinationId = destination.value;
  if (!destinationId) return;
  void runAction(async () => {
    let source = await chrome.windows.getCurrent({ populate: false });
    if (source.type !== 'normal') source = await chrome.windows.getLastFocused({ populate: false, windowTypes: ['normal'] });
    if (source.id === undefined || source.type !== 'normal') throw new Error('Open a normal browser window to send a workspace.');
    const result = await requestUi({ action: 'handoff', destinationId, windowId: source.id, currentTabOnly: element<HTMLInputElement>('current-tab-only').checked });
    if (result.state) state = result.state;
    else if (result.command && state) state = { ...state, lastCommand: result.command };
  });
});
startStatePolling(next => { pollError = undefined; render(next); }, error => { pollError = errorMessage(error); showText(errorBox, actionError || pollError); }, () => busy);
