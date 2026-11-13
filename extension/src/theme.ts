import { readPreferences, UI_PREFERENCES, type ThemeChoice } from './preferences.js';
const system = window.matchMedia('(prefers-color-scheme: dark)');
let choice: ThemeChoice = 'system';
function apply(): void {
  document.documentElement.dataset.theme = choice === 'system' ? system.matches ? 'dark' : 'light' : choice;
}
async function refresh(): Promise<void> {
  try { choice = (await readPreferences(chrome)).theme; } catch { choice = 'system'; }
  apply();
}
apply();
void refresh();
system.addEventListener('change', apply);
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && UI_PREFERENCES in changes) void refresh(); });
