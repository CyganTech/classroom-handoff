import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppConfig } from './config.js';
import { filterAnalyticsBrowsers } from '../shared/analytics-display.js';
import { analyticsDate, type AnalyticsStore, validateRange } from './analytics-store.js';
interface Dependencies {
  json: (res: ServerResponse, status: number, data: unknown) => void;
  body: (req: IncomingMessage) => Promise<unknown>;
  rate: (key: string, limit: number) => void;
  fail: (status: number, message: string) => never;
}
const cookieName = 'handoff_admin_session';
const hash = (text: string) => createHash('sha256').update(text).digest();
export class AdminRouter {
  private sessions = new Map<string, number>();
  constructor(private readonly config: AppConfig, private readonly analytics: AnalyticsStore, private readonly deps: Dependencies) {}
  private cookie(req: IncomingMessage): string | undefined {
    const match = /(?:^|;\s*)handoff_admin_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? '');
    return match?.[1];
  }
  private setCookie(res: ServerResponse, token: string, seconds: number): void {
    res.setHeader('Set-Cookie', `${cookieName}=${token}; Path=/api/admin; Max-Age=${seconds}; HttpOnly; SameSite=Strict${this.config.publicUrl.startsWith('https:') ? '; Secure' : ''}`);
  }
  private requireOrigin(req: IncomingMessage): void {
    if (req.headers.origin !== this.config.publicUrl) this.deps.fail(403, 'A same-origin request is required');
  }
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname;
    if (!(path === '/admin' || path.startsWith('/admin/') || path.startsWith('/api/admin/'))) return false;
    const { json, body, rate } = this.deps;
    const fail: Dependencies['fail'] = this.deps.fail;
    if (!this.config.analyticsAdminKey) { json(res, 503, { error: 'Analytics administrator access is not configured.' }); return true; }
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
    if (path === '/admin' && req.method === 'GET') { res.writeHead(302, { Location: '/admin/analytics' }); res.end(); return true; }
    const assets = new Map([['/admin/analytics', ['index.html', 'text/html; charset=utf-8']], ['/admin/assets/admin.js', ['admin.js', 'text/javascript; charset=utf-8']], ['/admin/assets/admin.css', ['admin.css', 'text/css; charset=utf-8']], ['/admin/assets/logo.svg', ['logo.svg', 'image/svg+xml']]]);
    const asset = assets.get(path);
    if (asset && req.method === 'GET') {
      let data: Buffer;
      try { data = await readFile(new URL('./admin/' + asset[0], import.meta.url)); }
      catch {
        try { data = await readFile(new URL('../dist/server/admin/' + asset[0], import.meta.url)); }
        catch { json(res, 503, { error: 'Dashboard assets are unavailable. Run the server build.' }); return true; }
      }
      res.setHeader('Content-Type', asset[1]!); res.end(data); return true;
    }
    if (!path.startsWith('/api/admin/')) fail(404, 'Admin page not found');
    for (const [key, expires] of this.sessions) if (expires <= this.config.now()) this.sessions.delete(key);
    if (path === '/api/admin/login' && req.method === 'POST') {
      if (url.search) fail(400, 'Query parameters are not supported');
      this.requireOrigin(req); rate(`admin-login:${req.socket.remoteAddress || 'unknown'}`, 5);
      const data = await body(req) as { key?: unknown };
      if (!data || typeof data !== 'object' || Object.keys(data).length !== 1 || typeof data.key !== 'string' || data.key.length > 512 || !timingSafeEqual(hash(data.key), hash(this.config.analyticsAdminKey))) fail(401, 'Invalid administrator access key');
      // A successful login replaces this browser's old session, without persisting secrets.
      const old = this.cookie(req); if (old) this.sessions.delete(hash(old).toString('hex'));
      if (this.sessions.size >= 100) this.sessions.delete(this.sessions.keys().next().value!);
      const token = randomBytes(32).toString('hex'); this.sessions.set(hash(token).toString('hex'), this.config.now() + 8 * 3600000);
      this.setCookie(res, token, 28800); json(res, 200, { ok: true }); return true;
    }
    const token = this.cookie(req); const sessionId = token ? hash(token).toString('hex') : '';
    if (!token || !this.sessions.has(sessionId)) fail(401, 'Administrator sign-in is required');
    rate(`admin-api:${sessionId}`, 120);
    if (path === '/api/admin/logout' && req.method === 'POST') {
      this.requireOrigin(req); this.sessions.delete(sessionId); this.setCookie(res, '', 0); json(res, 200, { ok: true }); return true;
    }
    if ((path === '/api/admin/analytics' || path === '/api/admin/analytics.csv') && req.method === 'GET') {
      if ([...url.searchParams.keys()].some(key => !['from', 'to', 'report', 'q'].includes(key)) || [...new Set(url.searchParams.keys())].some(key => url.searchParams.getAll(key).length !== 1)) fail(400, 'Invalid report parameters');
      const search = url.searchParams.get('q') ?? '';
      if (search.length > 200) fail(400, 'Browser search is too long');
      const to = url.searchParams.get('to') ?? analyticsDate(this.config.now());
      try { validateRange(to, to); } catch { fail(400, 'Choose a valid report end date'); }
      const from = url.searchParams.get('from') ?? new Date(Date.parse(to) - 29 * 86400000).toISOString().slice(0, 10);
      try { validateRange(from, to); } catch { fail(400, 'Choose a valid date range of at most 180 days'); }
      const report = this.analytics.report(from, to);
      if (path.endsWith('.csv')) {
        const kind = url.searchParams.get('report'); if (kind !== 'daily' && kind !== 'browsers') fail(400, 'Choose daily or browsers CSV');
        res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="handoff-${kind}-${from}-${to}.csv"`);
        if (kind === 'browsers') report.browsers = filterAnalyticsBrowsers(report.browsers, search);
        res.end(this.analytics.csv(report, kind));
      } else json(res, 200, report);
      return true;
    }
    fail(404, 'Admin endpoint not found');
  }
}
