import type { AnalyticsReport } from './analytics.js';
export const analyticsPlatforms: Record<string, string> = { cros: 'Chrome OS', win: 'Windows', mac: 'macOS', linux: 'Linux', openbsd: 'OpenBSD', android: 'Android', unknown: 'Unknown' };
export function filterAnalyticsBrowsers(browsers: AnalyticsReport['browsers'], query: string): AnalyticsReport['browsers'] {
  const search = query.trim().toLocaleLowerCase('en-US');
  return browsers.filter(browser => [browser.name, browser.id, analyticsPlatforms[browser.platform] ?? browser.platform, browser.version].some(value => value.toLocaleLowerCase('en-US').includes(search)));
}
