import { analyticsPlatforms as platforms, filterAnalyticsBrowsers } from '../../shared/analytics-display.js';
import type { AnalyticsReport } from '../../shared/analytics.js';

const element = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing dashboard element: ${id}`);
  return node as T;
};
const show = (id: string, visible: boolean) => { element(id).hidden = !visible; };
const setText = (id: string, value: string) => { element(id).textContent = value; };
const number = new Intl.NumberFormat('en-US');
const count = (value: number) => number.format(value);
const timeZone = 'America/Chicago';
const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
const dateFormatter = new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric', year: 'numeric' });
const activityFormatter = new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const shortDay = (date: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(`${date}T12:00:00Z`));
function today(): string {
  const parts = dayFormatter.formatToParts(new Date());
  const part = (type: string) => parts.find(value => value.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
function daysBefore(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}
function duration(ms: number | null): string {
  if (ms === null) return '—';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${number.format(Math.round(ms / 100) / 10)} s`;
}

let report: AnalyticsReport | null = null;
let page = 0;
const pageSize = 25;
let requestGeneration = 0;
let requestController: AbortController | undefined;
let selectedRange = { from: daysBefore(today(), 29), to: today() };
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
const themeInput = element<HTMLSelectElement>('theme');
try {
  const saved = localStorage.getItem('classroom-handoff-admin-theme');
  if (saved === 'light' || saved === 'dark' || saved === 'system') themeInput.value = saved;
} catch { /* Theme persistence is optional. */ }
function applyTheme() {
  document.documentElement.dataset.theme = themeInput.value === 'system' ? (systemTheme.matches ? 'dark' : 'light') : themeInput.value;
  drawDailyChart();
}
themeInput.addEventListener('change', () => {
  try { localStorage.setItem('classroom-handoff-admin-theme', themeInput.value); } catch { /* Optional. */ }
  applyTheme();
});
systemTheme.addEventListener('change', applyTheme);
applyTheme();

function loginView(message = '', focus = false) {
  requestGeneration++;
  requestController?.abort();
  report = null;
  for (const id of ['daily-rows', 'browser-rows', 'modes', 'pairings']) element(id).replaceChildren();
  for (const id of ['handoffs', 'success-rate', 'active-browsers', 'median', 'applied', 'failed', 'expired', 'pending', 'tabs', 'capture-failures', 'send-failures', 'rejected']) setText(id, '—');
  setText('collection-status', ''); setText('browser-count', ''); setText('status', '');
  element<HTMLButtonElement>('export').disabled = true;
  const canvas = element<HTMLCanvasElement>('daily-chart'); canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
  show('initial-status', false);
  show('dashboard', false);
  show('sign-out', false);
  show('login', true);
  setText('login-error', message);
  element<HTMLInputElement>('admin-key').value = '';
  if (focus) element('admin-key').focus();
}
function dashboardView() {
  show('initial-status', false);
  show('login', false);
  show('dashboard', true);
  show('sign-out', true);
}
element('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const input = element<HTMLInputElement>('admin-key');
  const button = element<HTMLButtonElement>('login-button');
  if (!input.value) return;
  let body = JSON.stringify({ key: input.value });
  input.value = '';
  button.disabled = true;
  setText('login-error', '');
  try {
    const response = await fetch('/api/admin/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body });
    body = '';
    if (!response.ok) {
      setText('login-error', response.status === 429 ? 'Too many sign-in attempts. Please wait a few minutes and try again.' : response.status === 401 || response.status === 403 ? 'Sign-in failed. Check the administrator key and try again.' : 'Analytics sign-in is unavailable. Please try again.');
      input.focus();
      return;
    }
    dashboardView();
    element('range').focus();
    await loadReport();
  } catch { setText('login-error', 'Unable to reach the server. Please try again.'); }
  finally { body = ''; button.disabled = false; }
});
element('sign-out').addEventListener('click', async () => {
  const button = element<HTMLButtonElement>('sign-out');
  button.disabled = true;
  try {
    const response = await fetch('/api/admin/logout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!response.ok && response.status !== 401) throw new Error('logout');
    loginView('', true);
  } catch { showReportError('Unable to sign out. Please try again.'); }
  finally { button.disabled = false; }
});

const fromInput = element<HTMLInputElement>('from');
const toInput = element<HTMLInputElement>('to');
fromInput.value = selectedRange.from;
toInput.value = selectedRange.to;
toInput.max = today();
fromInput.max = today();
function showReportError(message: string) {
  setText('report-error-message', message);
  show('report-error', true);
}
function selectDates() {
  const from = fromInput.value;
  const to = toInput.value;
  const start = Date.parse(`${from}T12:00:00Z`);
  const end = Date.parse(`${to}T12:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || from > to || to > today() || (end - start) / 86400000 > 179) {
    showReportError('Choose a range of 1 to 180 days, ending today or earlier.');
    return;
  }
  selectedRange = { from, to };
  void loadReport();
}
element('range').addEventListener('change', () => {
  const value = element<HTMLSelectElement>('range').value;
  show('custom-range', value === 'custom');
  if (value === 'custom') { fromInput.focus(); return; }
  selectedRange = { from: daysBefore(today(), Number(value) - 1), to: today() };
  fromInput.value = selectedRange.from;
  toInput.value = selectedRange.to;
  void loadReport();
});
element('range-form').addEventListener('submit', event => { event.preventDefault(); selectDates(); });
element('retry').addEventListener('click', () => { void loadReport(); });
element('export').addEventListener('click', () => {
  if (!report) return;
  const params = new URLSearchParams({ report: element<HTMLSelectElement>('export-report').value, from: report.from, to: report.to });
  if (params.get('report') === 'browsers') params.set('q', element<HTMLInputElement>('browser-search').value);
  const anchor = document.createElement('a');
  anchor.href = `/api/admin/analytics.csv?${params}`;
  anchor.download = '';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
});

async function loadReport() {
  const generation = ++requestGeneration;
  requestController?.abort();
  const controller = new AbortController();
  requestController = controller;
  show('report-error', false);
  element<HTMLButtonElement>('export').disabled = true;
  element('dashboard').setAttribute('aria-busy', 'true');
  setText('status', 'Loading analytics…');
  try {
    const response = await fetch(`/api/admin/analytics?${new URLSearchParams(selectedRange)}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
    if (generation !== requestGeneration) return;
    if (response.status === 401) { loginView(report ? 'Your session has ended. Sign in again to continue.' : '', !!report); return; }
    if (!response.ok) throw new Error('report');
    const next = await response.json() as AnalyticsReport;
    if (generation !== requestGeneration) return;
    report = next;
    page = 0;
    dashboardView();
    renderReport(next);
    element<HTMLButtonElement>('export').disabled = false;
  } catch (error) {
    if (controller.signal.aborted || generation !== requestGeneration) return;
    dashboardView();
    setText('status', report ? `Showing the previous report: ${shortDay(report.from)} – ${shortDay(report.to)}.` : 'Analytics could not be loaded.');
    showReportError('Unable to load analytics. Check your connection and try again.');
  } finally {
    if (generation === requestGeneration) element('dashboard').removeAttribute('aria-busy');
  }
}

function renderReport(data: AnalyticsReport) {
  const s = data.summary;
  setText('retention-note', `${data.retentionDays ?? 180}-day retention · Browser installations, not unique people`);
  for (const [id, value] of Object.entries({ handoffs: s.handoffs, 'active-browsers': s.activeBrowsers, applied: s.applied, failed: s.failed, expired: s.expired, pending: s.pending, tabs: s.tabs, 'capture-failures': s.captureFailures, 'send-failures': s.sendFailures, rejected: s.rejectedRequests })) setText(id, count(value));
  setText('success-rate', s.successRate === null ? '—' : `${(s.successRate * 100).toFixed(1)}%`);
  setText('median', duration(s.medianConfirmationMs));
  setText('p95', `95th percentile: ${duration(s.p95ConfirmationMs)}`);
  setText('status', `${shortDay(data.from)} – ${shortDay(data.to)} · Updated ${activityFormatter.format(new Date(data.generatedAt))}`);
  setText('collection-status', `Collection ${data.enabled ? 'enabled' : 'disabled'}${data.startedAt === null ? ' · No collection history yet' : ` · Started ${dateFormatter.format(new Date(data.startedAt))}`}`);
  show('empty-trend', s.handoffs === 0);
  bars('modes', [['Whole window', data.modes.wholeWindow], ['Current tab', data.modes.currentTab], ['Unknown', data.modes.unknown]]);
  bars('pairings', [['Easy pair', data.pairings.easyPair], ['Code', data.pairings.code]]);
  const dailyRows = element('daily-rows');
  dailyRows.replaceChildren();
  for (const day of data.daily) {
    const row = document.createElement('tr');
    for (const value of [day.date, day.handoffs, day.applied, day.failed, day.expired, day.pending, day.tabs]) {
      const cell = document.createElement('td');
      cell.textContent = typeof value === 'number' ? count(value) : value;
      row.append(cell);
    }
    dailyRows.append(row);
  }
  renderBrowsers();
  requestAnimationFrame(drawDailyChart);
}
function bars(id: string, values: Array<[string, number]>) {
  const container = element(id);
  container.replaceChildren();
  const total = values.reduce((sum, [, value]) => sum + value, 0);
  for (const [label, value] of values) {
    const row = document.createElement('div'); row.className = 'bar-row';
    const name = document.createElement('span'); name.textContent = label;
    const track = document.createElement('div'); track.className = 'bar-track'; track.setAttribute('aria-hidden', 'true');
    const fill = document.createElement('div'); fill.className = 'bar-fill'; fill.style.width = `${total > 0 ? value / total * 100 : 0}%`;
    track.append(fill);
    const countLabel = document.createElement('span'); countLabel.className = 'bar-value'; countLabel.textContent = count(value);
    row.append(name, track, countLabel); container.append(row);
  }
}

function renderBrowsers() {
  if (!report) return;
  const search = element<HTMLInputElement>('browser-search').value.trim().toLocaleLowerCase();
  const rows = filterAnalyticsBrowsers(report.browsers, search);
  page = Math.max(0, Math.min(page, Math.ceil(rows.length / pageSize) - 1));
  const body = element('browser-rows'); body.replaceChildren();
  for (const browser of rows.slice(page * pageSize, (page + 1) * pageSize)) {
    const row = document.createElement('tr');
    const name = document.createElement('td'); name.className = 'browser-name'; name.textContent = browser.name;
    const id = document.createElement('span'); id.className = 'browser-id'; id.textContent = browser.id; name.append(id); row.append(name);
    for (const value of [`${platforms[browser.platform] ?? browser.platform} · ${browser.version || 'Unknown version'}`, count(browser.sent), count(browser.received), count(browser.applied), `${count(browser.failed)} / ${count(browser.expired)}`, count(browser.pending), browser.lastActivity > 0 ? activityFormatter.format(new Date(browser.lastActivity)) : 'Never']) {
      const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
    }
    body.append(row);
  }
  if (rows.length === 0) {
    const row = document.createElement('tr'); const cell = document.createElement('td'); cell.colSpan = 8; cell.className = 'table-empty'; cell.textContent = search ? 'No browsers match your search.' : 'No browser activity in this date range.'; row.append(cell); body.append(row);
  }
  setText('browser-count', rows.length ? `${count(page * pageSize + 1)}–${count(Math.min((page + 1) * pageSize, rows.length))} of ${count(rows.length)} browsers` : '0 browsers');
  element<HTMLButtonElement>('previous').disabled = page === 0;
  element<HTMLButtonElement>('next').disabled = (page + 1) * pageSize >= rows.length;
}
element('browser-search').addEventListener('input', () => { page = 0; renderBrowsers(); });
element('previous').addEventListener('click', () => { page--; renderBrowsers(); });
element('next').addEventListener('click', () => { page++; renderBrowsers(); });

function drawDailyChart() {
  const canvas = element<HTMLCanvasElement>('daily-chart');
  if (!report || element('dashboard').hidden) return;
  const context = canvas.getContext('2d');
  if (!context) return;
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0) return;
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * scale); canvas.height = Math.round(rect.height * scale);
  context.scale(scale, scale);
  const style = getComputedStyle(document.documentElement);
  const width = rect.width, height = rect.height;
  const left = 32, right = width - 12, top = 10, bottom = height - 28;
  const days = report.daily;
  const maxValue = Math.max(4, ...days.map(day => day.handoffs));
  const step = Math.max(1, Math.ceil(maxValue / 4));
  const max = step * 4;
  context.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  context.lineWidth = 1;
  for (let tick = 0; tick <= 4; tick++) {
    const y = bottom - (bottom - top) * tick / 4;
    context.strokeStyle = style.getPropertyValue('--line').trim(); context.beginPath(); context.moveTo(left, y); context.lineTo(right, y); context.stroke();
    context.fillStyle = style.getPropertyValue('--muted').trim(); context.textAlign = 'right'; context.fillText(count(step * tick), left - 9, y + 4);
  }
  const x = (index: number) => days.length <= 1 ? (left + right) / 2 : left + (right - left) * index / (days.length - 1);
  const y = (value: number) => bottom - (bottom - top) * value / max;
  const labelCount = Math.max(2, Math.floor((right - left) / 74));
  const indices = new Set<number>();
  if (days.length) for (let i = 0; i < labelCount; i++) indices.add(Math.round(i * (days.length - 1) / (labelCount - 1)));
  context.fillStyle = style.getPropertyValue('--muted').trim();
  for (const index of indices) {
    context.textAlign = index === 0 ? 'left' : index === days.length - 1 ? 'right' : 'center';
    context.fillText(shortDay(days[index]!.date), x(index), height - 7);
  }
  if (!days.length) return;
  context.strokeStyle = style.getPropertyValue('--accent').trim(); context.lineWidth = 2.2; context.lineJoin = 'round'; context.beginPath();
  days.forEach((day, index) => { if (index === 0) context.moveTo(x(index), y(day.handoffs)); else context.lineTo(x(index), y(day.handoffs)); }); context.stroke();
  if (days.length <= 35) for (const [index, day] of days.entries()) {
    context.beginPath(); context.arc(x(index), y(day.handoffs), 3, 0, Math.PI * 2); context.fillStyle = style.getPropertyValue('--surface').trim(); context.fill(); context.stroke();
  }
  canvas.setAttribute('aria-label', `Daily handoffs from ${report.from} to ${report.to}: ${count(report.summary.handoffs)} total. Exact values are in the daily data table.`);
}
new ResizeObserver(() => { drawDailyChart(); }).observe(element('daily-chart'));
void loadReport();
