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
 * fix275: every report carries its build ("index-<hash>": taken from whatever the browser sends, or the build live when
 * it came in), and a group is "Fixed by a newer build" as soon as a newer build is live and its last report came from an
 * older one (or its stack's files are gone from the live build) — no 24 h wait; the 24 h rule stays as the fallback.
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
import { adminUrl, addSummaryLine, israelTime } from './adminMail';
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
{
  const cols = (db.prepare('PRAGMA table_info(client_errors)').all() as any[]).map(c => c.name);
  if (!cols.includes('builds')) db.exec(`ALTER TABLE client_errors ADD COLUMN builds TEXT NOT NULL DEFAULT '[]'`);
  // fix275: the build that fixed it (grey "Fixed by a newer build"); the live build an admin reopened it on (not closed again on it)
  if (!cols.includes('fixed_by')) db.exec(`ALTER TABLE client_errors ADD COLUMN fixed_by TEXT`);
  if (!cols.includes('kept_open')) db.exec(`ALTER TABLE client_errors ADD COLUMN kept_open TEXT`);
}

const clean = (v: unknown, n: number) => String(v ?? '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, n);

/** fix275: the build id "index-<hash>" out of whatever arrives (the full script URL from the loader, "index-<hash>.js", the id) */
export function buildId(v: unknown): string | null {
  return (String(v ?? '').match(/index-[A-Za-z0-9_-]+/) || [null])[0]?.slice(0, 40) || null;
}
const buildFirstAt = (v: string | null): string | null =>
  v ? ((db.prepare('SELECT first_at FROM client_builds WHERE version = ?').get(v) as any)?.first_at ?? null) : null;
/** fix275: the build that was live at `iso` (the newest one live by then) */
export function buildAt(iso: string): string | null {
  return ((db.prepare('SELECT version FROM client_builds WHERE first_at <= ? ORDER BY first_at DESC LIMIT 1').get(iso) as any)?.version) ?? null;
}
const buildsOf = (json: string | null): string[] => [...new Set((JSON.parse(json || '[]') as string[]).map(buildId).filter(Boolean) as string[])];

/** "/es/match/575346" → "/match/:id" so the same problem on different games is one row */
export function pageKind(path: string) {
  const p = path.replace(/^\/(es|pt|de|fr|it|tr|id|hi|pl|el|ru|ar|he)(?=\/|$)/, '') || '/';
  return p.replace(/\/\d+(?=\/|$)/g, '/:id').replace(/\/(join)\/[^/]+/, '/$1/:code').slice(0, 80) || '/';
}

/** Messages that are not our bug: browser extensions, network drops, a deploy in progress. */
const NOISE = /ResizeObserver loop|Script error\.?$|chrome-extension:|moz-extension:|safari-extension:|Network Error|Load failed|Failed to fetch|NetworkError|AbortError|cancel(l)?ed|timeout of \d+ms/i;


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
  // fix275: the id only ("index-<hash>"; the loader sends the whole script URL), else the build live right now
  const version = buildId(clean(body?.version, 300)) || buildAt(now);
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
    const builds = buildsOf(row.builds);
    if (version && !builds.includes(version)) builds.push(version);
    // a problem marked fixed that comes back is open again — fix275: but a tab still running a build older than the one
    // that fixed it does not reopen it (counted, stays grey)
    const fixAt = row.resolved_at && row.fixed_by ? buildFirstAt(row.fixed_by) : null;
    const repAt = version && version !== row.fixed_by ? buildFirstAt(version) : null;
    const stale = !!(fixAt && repAt && repAt < fixAt);
    db.prepare(`UPDATE client_errors SET count = count + 1, last_at = ?, pages = ?, browsers = ?, version = ?, builds = ?, where_ = COALESCE(?, where_),
        resolved_at = ${stale ? 'resolved_at' : 'NULL'}, fixed_by = ${stale ? 'fixed_by' : 'NULL'}, kept_open = NULL WHERE sig = ?`)
      .run(now, JSON.stringify(pages.slice(0, 20)), JSON.stringify(browsers.slice(0, 10)), version, JSON.stringify(builds.slice(-10)), where, sig);
  }
  return { ok: true };
}

/*
 * fix279: no email for a broken page (Yarin, 29 Oct: "Site problem: a page broke" had nothing for him to do) — the open
 * groups are on the For Claude list (Admin → Needs you) and counted once in the 07:00 summary.
 */
addSummaryLine(() => {
  try {
    const n = (db.prepare('SELECT COUNT(*) AS n FROM client_errors WHERE resolved_at IS NULL').get() as any)?.n || 0;
    return n ? { area: 'For Claude', title: `${n} site error group${n === 1 ? '' : 's'} open (pages that broke for visitors)`, href: adminUrl('needs-you') } : null;
  } catch { return null; }
});

export function clientErrorList(days = 30) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = (db.prepare('SELECT * FROM client_errors WHERE last_at >= ? ORDER BY (resolved_at IS NULL) DESC, last_at DESC LIMIT 200').all(since) as any[]).map(r => ({
    sig: r.sig, message: r.message, where: r.where_, pageKind: r.page_kind, kind: r.kind, count: r.count,
    firstAt: r.first_at, lastAt: r.last_at, pages: JSON.parse(r.pages || '[]'), browsers: JSON.parse(r.browsers || '[]'),
    version: buildId(r.version), builds: buildsOf(r.builds), resolvedAt: r.resolved_at, fixedBy: r.fixed_by as string | null
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
  // fix275: reopened by hand = not closed again on the build live now (a new report or a newer build starts over)
  db.prepare('UPDATE client_errors SET resolved_at = ?, fixed_by = NULL, kept_open = ? WHERE sig = ?')
    .run(resolved ? new Date().toISOString() : null, resolved ? null : currentBuild() || 'unknown', sig);
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
    FROM client_errors e WHERE e.resolved_at IS NULL AND e.kept_open IS NULL AND e.last_at <= ?`).all(new Date(now - CLOSE_AFTER_MS).toISOString()) as any[];
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

/* ---------- fix275: fixed by a newer build = not red, right away ---------- */

/** the hashed file names in a stack ("GameExtras-C0ATdfL8.js", "index-<hash>.js") */
export function stackFiles(where: string | null): string[] {
  return [...new Set((String(where || '').match(/[^/\s()@]+\.js/g) || []).filter(f => /-[A-Za-z0-9_-]{8}\.js$/.test(f)))];
}
let assetsCache: { build: string | null; files: Set<string> | null } = { build: null, files: null };
/** the live build's file names (frontend/dist/assets), read once per build */
export function liveAssets(build: string | null, dir = STATIC_DIR): Set<string> | null {
  if (!build) return null;
  if (assetsCache.build !== build) {
    let files: Set<string> | null = null;
    try { files = new Set(fs.readdirSync(path.join(dir, 'assets'))); } catch { /* no build on disk */ }
    assetsCache = { build, files };
  }
  return assetsCache.files;
}

/**
 * A group is "Fixed by a newer build" (grey, Done for you; out of Needs you, the red totals, the For Claude list and the
 * email) as soon as the live build went live after its last report AND (a) its last report came from an older build
 * (a report without one = the build live then), or (b) a file of its stack is not in the live build. Neither known:
 * the 24 h rule (closeStoppedErrors) decides. A new report from the live build opens it again (reportClientError).
 */
export function closeFixedByBuild(now = Date.now(), live: string | null = currentBuild(), assets: Set<string> | null = liveAssets(live)): number {
  if (!live) return 0;
  const liveAt = buildFirstAt(live);
  if (!liveAt) return 0;
  const rows = db.prepare(`SELECT sig, message, page_kind, count, last_at, version, where_, kept_open FROM client_errors
    WHERE resolved_at IS NULL AND last_at < ?`).all(liveAt) as any[];
  const at = new Date(now).toISOString();
  let n = 0;
  for (const r of rows) {
    if (r.kept_open === live) continue; // an admin reopened it on this build
    const old = buildId(r.version) || buildAt(r.last_at);
    const oldAt = old ? buildFirstAt(old) : null;
    let why = '';
    if (old && old !== live && (!oldAt || oldAt < liveAt)) why = `it last happened on ${old}, no report on the new one`;
    else if (assets) {
      const gone = stackFiles(r.where_).filter(f => !assets.has(f));
      if (gone.length) why = `its code (${gone.slice(0, 2).join(', ')}) is not in the new build, no report on it`;
    }
    if (!why) continue;
    const res = db.prepare('UPDATE client_errors SET resolved_at = ?, fixed_by = ?, kept_open = NULL WHERE sig = ? AND resolved_at IS NULL').run(at, live, r.sig);
    if (!Number(res.changes)) continue;
    n++;
    recordDone({
      kind: 'site-errors', sport: null, ref: `${r.sig}:fixed:${live}`, title: `Fixed by a newer build: “${String(r.message).slice(0, 90)}” (${r.page_kind})`,
      why: `Fixed by build ${live} (live ${israelTime(liveAt)}): ${why}. ${r.count} report(s), the last ${israelTime(r.last_at)}. Opens again by itself if it comes back.`,
      link: adminUrl('site'), undo: { sig: r.sig }
    }, now);
  }
  if (n) logger.info(`site errors: ${n} group(s) fixed by build ${live}`);
  return n;
}
/** worker start / every 5 min: note the live build, then close what it fixed (and the 24 h fallback) */
export function checkSiteErrors(now = Date.now()) {
  const live = currentBuild();
  noteBuild(live, now);
  const fixed = closeFixedByBuild(now, live);
  const quiet = closeStoppedErrors(now);
  return { live, fixed, quiet };
}

/** The daily "for Claude" list: open groups, the 10 with most reports (24 h first), with their counts and builds. */
export function errorsForClaude(now = Date.now()) {
  const dayAgo = new Date(now - 86400000).toISOString();
  const rows = db.prepare(`SELECT message, page_kind, where_, count, first_at, last_at, version, builds FROM client_errors WHERE resolved_at IS NULL
    ORDER BY (last_at >= ?) DESC, count DESC LIMIT 10`).all(dayAgo) as any[];
  const open = (db.prepare('SELECT COUNT(*) AS n FROM client_errors WHERE resolved_at IS NULL').get() as any).n as number;
  return {
    day: new Date(now).toISOString().slice(0, 10), open,
    top: rows.map(r => ({ message: r.message, page: r.page_kind, where: r.where_ ? String(r.where_).split('\n')[0] : null, count: r.count, firstAt: r.first_at, lastAt: r.last_at, builds: buildsOf(r.builds), build: buildId(r.version) }))
  };
}

// fix275: the live build is noted at once (a report in the first minute gets the right build), the check runs a minute
// after the start and every 5 min, so a deploy clears what it fixed within minutes
if (!isWebProc) { try { noteBuild(currentBuild()); } catch { /* table not ready */ } }
if (!isWebProc) after('site errors: this build', () => { checkSiteErrors(); }, 60 * 1000).unref();
if (!isWebProc) every('site errors: fixed by a newer build', () => { try { checkSiteErrors(); } catch (e: any) { logger.warn(`site errors close: ${e.message}`); } }, 5 * 60000).unref();

if (!isWebProc) every('client errors cleanup', () => { // fix210b: worker only
  try { db.prepare('DELETE FROM client_errors WHERE last_at < ?').run(new Date(Date.now() - 30 * 86400000).toISOString()); } catch { /* ignore */ }
}, 12 * 3600000).unref();
