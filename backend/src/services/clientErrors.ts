/**
 * Site crash reports (Oct 2026): when a page breaks in a visitor's browser (the "Something went wrong on this page"
 * screen, or an error the page didn't catch), the browser sends a short report here. Same problems are grouped
 * (same message + same kind of page), with a count, the first / last time and the pages it happened on, so the admin
 * sees which pages break and how often (Admin → Overview → Site errors). The first time a new problem shows up, the
 * admin gets one email (at most one email per problem per day, and at most 10 a day).
 *
 * Privacy: no IP address, no user id, no cookies — only the message, a few lines of code location, the page path,
 * the site version and a short browser name. Kept 30 days.
 */
import crypto from 'crypto';
import { db } from '../db';
import logger from '../utils/logger';
import { sendMail } from './email';
import { every } from './perf';

db.exec(`
  CREATE TABLE IF NOT EXISTS client_errors (
    sig TEXT PRIMARY KEY, message TEXT NOT NULL, where_ TEXT, page_kind TEXT NOT NULL, kind TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0, first_at TEXT NOT NULL, last_at TEXT NOT NULL,
    pages TEXT NOT NULL DEFAULT '[]', browsers TEXT NOT NULL DEFAULT '[]', version TEXT,
    resolved_at TEXT, emailed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_client_errors_last ON client_errors(last_at);
`);

const clean = (v: unknown, n: number) => String(v ?? '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, n);

/** "/es/match/575346" → "/match/:id" so the same problem on different games is one row */
export function pageKind(path: string) {
  const p = path.replace(/^\/(es|pt|de|fr|it|tr)(?=\/|$)/, '') || '/';
  return p.replace(/\/\d+(?=\/|$)/g, '/:id').replace(/\/(join)\/[^/]+/, '/$1/:code').slice(0, 80) || '/';
}

/** Messages that are not our bug: browser extensions, network drops, a deploy in progress. */
const NOISE = /ResizeObserver loop|Script error\.?$|chrome-extension:|moz-extension:|safari-extension:|Network Error|Load failed|Failed to fetch|NetworkError|AbortError|cancel(l)?ed|timeout of \d+ms/i;

let emailsToday = { day: '', n: 0 };

export function reportClientError(body: any) {
  const message = clean(body?.message, 300);
  if (!message || NOISE.test(message) || NOISE.test(clean(body?.stack, 400))) return { ok: true, ignored: true };
  // fix198: 'check' = the sign-up security check (Turnstile) failed in the visitor's browser
  const kind = body?.kind === 'page' ? 'page' : body?.kind === 'check' ? 'check' : 'uncaught';
  const path = clean(body?.page, 200).split('?')[0].split('#')[0] || '/';
  if (!path.startsWith('/')) return { ok: true, ignored: true };
  // first lines of the code location only (no data from the page)
  const where = clean(body?.stack, 2000).split(/\s*\n\s*|\s{2,}(?=at )/).filter(l => /^at |@/.test(l)).slice(0, 4).join('\n').slice(0, 600) || null;
  const pk = pageKind(path);
  const top = (where || '').split('\n')[0].replace(/-[A-Za-z0-9_]{8}\.js/g, '.js').replace(/:\d+:\d+/g, ''); // same bug in a new build = same row
  const sig = crypto.createHash('sha1').update(`${message}|${pk}|${top}`).digest('hex').slice(0, 16);
  const now = new Date().toISOString();
  const version = clean(body?.version, 40) || null;
  const browser = clean(body?.browser, 40);
  const row = db.prepare('SELECT * FROM client_errors WHERE sig = ?').get(sig) as any;
  if (!row) {
    db.prepare(`INSERT INTO client_errors (sig, message, where_, page_kind, kind, count, first_at, last_at, pages, browsers, version)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`).run(sig, message, where, pk, kind, now, now, JSON.stringify([path]), JSON.stringify(browser ? [browser] : []), version);
  } else {
    const pages: string[] = JSON.parse(row.pages || '[]');
    if (!pages.includes(path)) pages.unshift(path);
    const browsers: string[] = JSON.parse(row.browsers || '[]');
    if (browser && !browsers.includes(browser)) browsers.push(browser);
    // a problem marked fixed that comes back is open again
    db.prepare(`UPDATE client_errors SET count = count + 1, last_at = ?, pages = ?, browsers = ?, version = ?, where_ = COALESCE(?, where_), resolved_at = NULL WHERE sig = ?`)
      .run(now, JSON.stringify(pages.slice(0, 20)), JSON.stringify(browsers.slice(0, 10)), version, where, sig);
  }
  maybeEmail(sig).catch(() => undefined);
  return { ok: true };
}

async function maybeEmail(sig: string) {
  const to = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean)[0];
  if (!to) return;
  const r = db.prepare('SELECT * FROM client_errors WHERE sig = ?').get(sig) as any;
  if (!r) return;
  if (r.emailed_at && Date.now() - new Date(r.emailed_at).getTime() < 86400000) return;
  const day = new Date().toISOString().slice(0, 10);
  if (emailsToday.day !== day) emailsToday = { day, n: 0 };
  if (emailsToday.n >= 10) return;
  emailsToday.n++;
  db.prepare('UPDATE client_errors SET emailed_at = ? WHERE sig = ?').run(new Date().toISOString(), sig);
  const pages: string[] = JSON.parse(r.pages || '[]');
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const link = `https://sportlikely.com${pages[0] || '/'}`;
  const text = `A page broke on sportlikely.com.\n\nPage: ${link}\nError: ${r.message}\nTimes so far: ${r.count}\n\nAll site errors: Admin → Overview → Site errors.`;
  const html = `<p>A page broke on sportlikely.com.</p><p><b>Page:</b> <a href="${esc(link)}">${esc(link)}</a><br><b>Error:</b> ${esc(r.message)}<br><b>Times so far:</b> ${r.count}</p><p>All site errors: Admin → Overview → Site errors.</p>`;
  try { await sendMail({ to, subject: `SportLikely: a page broke (${r.page_kind})`, text, html }); }
  catch (e: any) { logger.warn(`client error email: ${e.message}`); }
}

export function clientErrorList(days = 30) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = (db.prepare('SELECT * FROM client_errors WHERE last_at >= ? ORDER BY (resolved_at IS NULL) DESC, last_at DESC LIMIT 200').all(since) as any[]).map(r => ({
    sig: r.sig, message: r.message, where: r.where_, pageKind: r.page_kind, kind: r.kind, count: r.count,
    firstAt: r.first_at, lastAt: r.last_at, pages: JSON.parse(r.pages || '[]'), browsers: JSON.parse(r.browsers || '[]'),
    version: r.version, resolvedAt: r.resolved_at
  }));
  const dayAgo = new Date(Date.now() - 86400000).toISOString();
  return {
    rows,
    open: rows.filter(r => !r.resolvedAt).length,
    last24h: rows.filter(r => r.lastAt >= dayAgo && !r.resolvedAt).reduce((a, r) => a + r.count, 0)
  };
}

/** Admin: mark a problem fixed (it reopens by itself if it happens again). */
export function resolveClientError(sig: string, resolved: boolean) {
  db.prepare('UPDATE client_errors SET resolved_at = ? WHERE sig = ?').run(resolved ? new Date().toISOString() : null, sig);
}

every('client errors cleanup', () => {
  try { db.prepare('DELETE FROM client_errors WHERE last_at < ?').run(new Date(Date.now() - 30 * 86400000).toISOString()); } catch { /* ignore */ }
}, 12 * 3600000).unref();
