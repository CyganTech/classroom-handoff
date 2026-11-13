export type ThemeChoice = 'system' | 'light' | 'dark';
export interface UiPreferences { theme: ThemeChoice; currentTabOnly: boolean }
export const UI_PREFERENCES = 'uiPreferences';
export async function readPreferences(api: Pick<typeof chrome, 'storage'>): Promise<UiPreferences> {
  const value = (await api.storage.local.get(UI_PREFERENCES))[UI_PREFERENCES] as Partial<UiPreferences> | undefined;
  return { theme: value?.theme === 'light' || value?.theme === 'dark' ? value.theme : 'system', currentTabOnly: value?.currentTabOnly === true };
}
