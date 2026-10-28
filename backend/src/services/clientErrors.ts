/**
 * Site crash reports (Oct 2026): when a page breaks in a visitor's browser (the "Something went wrong on this page"
 * screen, or an error the page didn't catch), the browser sends a short report here. Same problems are grouped
 * (same message + same kind of page), with a count, the first / last time and the pages it happened on, so the admin
 * sees which pages break and how often (Admin → Site health → Site errors). The first time a new problem shows up, the
 * admin gets one email (at most one email per problem per day, and at most 10 a day).
 *
 * fix253: grouped by message (+ page kind + code line) with the builds each group showed up in. A group with no report
 * for 24 h, once a build newer than its last report went live (fix253b), closes itself (Done for you, Undo = open again); the open
 * groups are a daily "for Claude" list in /api/admin/summary (top 10 messages with their counts), never Needs you.
 *
 * Privacy: no IP address, no user id, no cookies — only the message, a few lines of code location, the page path,
 * the site version and a short browser name. Kept 30 days.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { db } from '../db';
import { isWeb as isWebProc } from './role';
import logger from '../utils/logger';
import { sendAdminMail, adminUrl, siteUrl, israelTime } from './adminMail';
import { every, after } from './perf';
import { onUndo, recordDone } from './doneForYou';

db.exec(`
  CREATE TABLE IF NOT EXISTS client_errors (
    sig TEXT PRIMARY KEY, message TEXT NOT NULL, where_ TEXT, page_kind TEXT NOT NULL, kind TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0, first_at TEXT NOT NULL, last_at TEXT NOT NULL,
    pages TEXT NOT NULL DEFAULT '[]', browsers TEXT NOT NULL DEFAULT '[]', version TEXT,
    resolved_at TEXT, emailed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_client_errors_last ON client_errors(last_at);
  CREATE TABLE IF NOT EXISTS client_builds (version TEXT PRIMARY KEY, first_at TEXT NOT NULL);
`);
if (!(db.prepare('PRAGMA table_info(client_errors)').all() as any[]).some(c => c.name === 'builds')) db.exec(`ALTER TABLE client_errors ADD COLUMN builds TEXT NOT NULL DEFAULT '[]'`);

const clean = (v: unknown, n: number) => String(v ?? '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, n);

/** "/es/match/575346" → "/match/:id" so the same problem on different games is one row */
export function pageKind(path: string) {
  const p = path.replace(/^\/(es|pt|de|fr|it|tr|id|hi|pl|el|ru)(?=\/|$)/, '') || '/';
  return p.replace(/\/\d+(?=\/|$)/g, '/:id').replace(/\/(join)\/[^/]+/, '/$1/:code').slice(0, 80) || '/';
}

/** Messages that are not our bug: browser extensions, network drops, a deploy in progress. */
const NOISE = /ResizeObserver loop|Script error\.?$|chrome-extension:|moz-extension:|safari-extension:|Network Error|Load failed|Failed to fetch|NetworkError|AbortError|cancel(l)?ed|timeout of \d+ms/i;

let emailsToday = { day: '', n: 0 };

export function reportClientError(body: any) {
  const message = clean(body?.message, 300);
  if (!message || NOISE.test(message) || NOISE.test(clean(body?.stack, 400))) return { ok: true, ignored: true };
  const kind = body?.kind === 'page' ? 'page' : 'uncaught';
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
    db.prepare(`INSERT INTO client_errors (sig, message, where_, page_kind, kind, count, first_at, last_at, pages, browsers, version, builds)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`).run(sig, message, where, pk, kind, now, now, JSON.stringify([path]), JSON.stringify(browser ? [browser] : []), version, JSON.stringify(version ? [version] : []));
  } else {
    const pages: string[] = JSON.parse(row.pages || '[]');
    if (!pages.includes(path)) pages.unshift(path);
    const browsers: string[] = JSON.parse(row.browsers || '[]');
    if (browser && !browsers.includes(browser)) browsers.push(browser);
    const builds: string[] = JSON.parse(row.builds || '[]');
    if (version && !builds.includes(version)) builds.push(version);
    // a problem marked fixed that comes back is open again
    db.prepare(`UPDATE client_errors SET count = count + 1, last_at = ?, pages = ?, browsers = ?, version = ?, builds = ?, where_ = COALESCE(?, where_), resolved_at = NULL WHERE sig = ?`)
      .run(now, JSON.stringify(pages.slice(0, 20)), JSON.stringify(browsers.slice(0, 10)), version, JSON.stringify(builds.slice(-10)), where, sig);
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
  // fix239: the admin template, the page as a clean link, times in Israel time
  const link = siteUrl(pages[0] || '/');
  await sendAdminMail(`Site problem: a page broke (${r.page_kind})`, {
    label: 'Site errors', tone: 'fail',
    title: `A page broke for visitors (${r.page_kind})`,
    what: `The ${r.page_kind} page showed an error in a visitor’s browser ${r.count === 1 ? 'once' : `${r.count} times`} so far: “${String(r.message).slice(0, 160)}”.`,
    todo: 'Nothing to press: it is on the daily “for Claude” list, and it closes itself once a new build stops it.',
    rows: [{ title: link, titleHref: link, when: `First seen ${israelTime(r.first_at || r.last_at)} · last ${israelTime(r.last_at)}`, detail: [r.where_ ? `Where: ${r.where_}` : '', pages.length > 1 ? `Also on: ${pages.slice(1, 4).join(', ')}` : ''].filter(Boolean).join(' · ') || undefined }],
    buttons: [{ text: 'Open site errors in Admin', href: adminUrl('site') }, { text: 'Open the page', href: link, kind: 'secondary' }]
  });
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

/* ---------- fix253: groups close themselves after a build that stops them; the daily "for Claude" list ---------- */

/** fix253b: a group closes after this long with no report, once a newer build went live after its last one */
export const CLOSE_AFTER_MS = 24 * 3600 * 1000;
const STATIC_DIR = process.env.STATIC_DIR || path.resolve(__dirname, '../../../frontend/dist');
/** the build the site serves now: its main file name ("index-AbC123"), as the browser reports it */
export function currentBuild(dir = STATIC_DIR): string | null {
  try { return (fs.readFileSync(path.join(dir, 'index.html'), 'utf8').match(/index-[A-Za-z0-9_-]+(?=\.js)/) || [null])[0]; } catch { return null; }
}
/** remember when a build first went live (worker start) */
export function noteBuild(version: string | null, now = Date.now()) {
  if (version) db.prepare('INSERT OR IGNORE INTO client_builds (version, first_at) VALUES (?, ?)').run(version, new Date(now).toISOString());
}

/**
 * Open groups closed by themselves, each in Done for you. fix253b: the rule is "no report for 24 h, and a build newer than
 * the last report went live" — the build that stopped it is the first one live after its last report, so the group's
 * own (unknown, "builds: []") build always counts as older, and a deploy no longer restarts the wait (fix253 waited 6 h
 * from the newest build only: every deploy started the clock again and 47 groups stayed open).
 */
export function closeStoppedErrors(now = Date.now()): number {
  const rows = db.prepare(`SELECT e.sig, e.message, e.page_kind, e.count, e.last_at, e.builds,
      (SELECT b.version FROM client_builds b WHERE b.first_at > e.last_at ORDER BY b.first_at LIMIT 1) AS bv,
      (SELECT b.first_at FROM client_builds b WHERE b.first_at > e.last_at ORDER BY b.first_at LIMIT 1) AS bat
    FROM client_errors e WHERE e.resolved_at IS NULL AND e.last_at <= ?`).all(new Date(now - CLOSE_AFTER_MS).toISOString()) as any[];
  const at = new Date(now).toISOString();
  let n = 0;
  for (const row of rows) {
    if (!row.bv) continue; // no build since its last report: the bug may still be live
    const r = row, b = { version: row.bv, first_at: row.bat };
    n++;
    db.prepare('UPDATE client_errors SET resolved_at = ? WHERE sig = ? AND resolved_at IS NULL').run(at, r.sig);
    recordDone({
      kind: 'site-errors', sport: null, ref: `${r.sig}:${b.version}`, title: `Closed: “${String(r.message).slice(0, 90)}” (${r.page_kind})`,
      why: `${r.count} report(s), the last ${israelTime(r.last_at)}; none in the 24 h since, and build ${b.version} went live after it (${israelTime(b.first_at)}), so a newer build fixed it. It opens again by itself if it comes back.`,
      link: adminUrl('site'), undo: { sig: r.sig }
    }, now);
  }
  if (n) logger.info(`site errors: ${n} group(s) closed — no report for 24 h, a newer build live since (${rows.length - n} quiet but no build since)`);
  return n;
}
onUndo('site-errors', (p: { sig: string }) => { resolveClientError(p.sig, false); return 'Open again.'; });

/** The daily "for Claude" list: open groups, the 10 with most reports (24 h first), with their counts and builds. */
export function errorsForClaude(now = Date.now()) {
  const dayAgo = new Date(now - 86400000).toISOString();
  const rows = db.prepare(`SELECT message, page_kind, where_, count, first_at, last_at, builds FROM client_errors WHERE resolved_at IS NULL
    ORDER BY (last_at >= ?) DESC, count DESC LIMIT 10`).all(dayAgo) as any[];
  const open = (db.prepare('SELECT COUNT(*) AS n FROM client_errors WHERE resolved_at IS NULL').get() as any).n as number;
  return {
    day: new Date(now).toISOString().slice(0, 10), open,
    top: rows.map(r => ({ message: r.message, page: r.page_kind, where: r.where_ ? String(r.where_).split('\n')[0] : null, count: r.count, firstAt: r.first_at, lastAt: r.last_at, builds: JSON.parse(r.builds || '[]') }))
  };
}

if (!isWebProc) after('site errors: this build', () => { noteBuild(currentBuild()); closeStoppedErrors(); }, 60 * 1000).unref();
if (!isWebProc) every('site errors: close stopped groups', () => { try { closeStoppedErrors(); } catch (e: any) { logger.warn(`site errors close: ${e.message}`); } }, 3600000).unref();

if (!isWebProc) every('client errors cleanup', () => { // fix210b: worker only
  try { db.prepare('DELETE FROM client_errors WHERE last_at < ?').run(new Date(Date.now() - 30 * 86400000).toISOString()); } catch { /* ignore */ }
}, 12 * 3600000).unref();
