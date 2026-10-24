import type { UiRequest, UiResponse, UiState } from '../../shared/ui.js';

export function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing UI element: ${id}`);
  return node as T;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

export async function requestUi(request: UiRequest): Promise<Extract<UiResponse, { ok: true }>> {
  const response: UiResponse | undefined = await chrome.runtime.sendMessage(request);
  if (!response) throw new Error('The extension did not respond. Reload the extension and try again.');
  if (!response.ok) throw new Error(response.error);
  return response;
}

export async function readState(): Promise<UiState> {
  const result = await requestUi({ action: 'state' });
  if (!result.state) throw new Error('The extension did not return its current state.');
  return result.state;
}

export function showText(node: HTMLElement, text: string | undefined): void {
  node.textContent = text ?? '';
  node.hidden = !text;
}

export function renderConnection(state: UiState): void {
  const status = element('connection-status');
  const dot = element('connection-dot');
  status.textContent = !state.configured ? 'Setup needed' : state.connected ? 'Connected to handoff server' : 'Reconnecting to handoff server…';
  dot.classList.toggle('online', state.connected);
  dot.classList.toggle('offline', state.configured && !state.connected);
}

export function startStatePolling(onState: (state: UiState) => void, onError: (error: unknown) => void, isBusy: () => boolean): () => void {
  let inFlight = false;
  let disposed = false;
  const refresh = async () => {
    if (inFlight || disposed || isBusy()) return;
    inFlight = true;
    try { const state = await readState(); if (!disposed && !isBusy()) onState(state); }
    catch (error) { if (!disposed) onError(error); }
    finally { inFlight = false; }
  };
  void refresh();
  const timer = window.setInterval(() => { void refresh(); }, 2000);
  const stop = () => { disposed = true; window.clearInterval(timer); };
  window.addEventListener('pagehide', stop, { once: true });
  return stop;
}
