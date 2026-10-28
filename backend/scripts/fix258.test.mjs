// fix258: (1) a restart never drops a staff console login — the login (and the session's "console unlocked" flag) survive
// restarts and the retention job, a lost row comes back from its protected copy or from the newest local backup (the
// security log says who had one); (2) every HTML answer carries its page's own lang + the 13 hreflang links (12
// languages + x-default): the stored crawler copies, the plain app page, and stale copies are found and built again.
// Run: npm run test:fix258 (dist build, scratch databases; each "restart" is a new node process)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, '../dist');
const require = createRequire(import.meta.url);

/* ---------- (1) console logins ---------- */

const consoleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix258-console-'));
/** one start of the site on the scratch database: runs `body` (with db, sc = staffConsole, auth) and prints its JSON */
function start(body) {
  const code = `
    const db = require(${JSON.stringify(DIST + '/db/index.js')}).db;
    const auth = require(${JSON.stringify(DIST + '/services/auth.js')});
    const sc = require(${JSON.stringify(DIST + '/services/staffConsole.js')});
    require(${JSON.stringify(DIST + '/services/securityLog.js')});
    (async () => { const out = await (async () => { ${body} })(); process.stdout.write('\\n@@' + JSON.stringify(out ?? null)); process.exit(0); })()
      .catch(e => { console.error(e); process.exit(1); });`;
  const out = execFileSync(process.execPath, ['--no-warnings', '-e', code], {
    env: { ...process.env, DATA_DIR: consoleDir, NODE_ENV: 'production', LOG_LEVEL: 'error', SL_ROLE: 'worker', ADMIN_EMAILS: 'boss@example.com' }, encoding: 'utf8'
  });
  return JSON.parse(out.slice(out.lastIndexOf('@@') + 2));
}
const log = (event, userId, at) => `db.prepare("INSERT INTO security_log (at, user_id, email, event) VALUES (?, ?, 'boss@example.com', ?)").run(${JSON.stringify(at)}, ${userId}, ${JSON.stringify(event)});`;

let uid = 0, token = '';
test('(1) set up: an admin with a console login, signed in to the console in this session', () => {
  const r = start(`
    const now = new Date().toISOString();
    db.prepare("INSERT INTO users (email, pass_hash, created_at, email_verified) VALUES ('boss@example.com', ?, ?, 1)").run(auth.hashPassword('account-password-1'), now);
    const id = db.prepare("SELECT id FROM users WHERE email = 'boss@example.com'").get().id;
    const s = auth.createSession(id, 'test', true);
    const h = auth.sessionHash(s.token);
    sc.setupOwn(id, h, 'boss.console', 'console-pass-123');
    ${log('console_setup', 'id', '2026-10-20T10:00:00.000Z')}
    sc.lockSession(h);
    sc.consoleLogin(id, h, 'boss.console', 'console-pass-123');
    ${log('console_login_ok', 'id', '2026-10-27T10:00:00.000Z')}
    return { id, token: s.token, unlocked: sc.sessionUnlocked(h), row: !!sc.consoleRow(id) };`);
  assert.equal(r.unlocked, true);
  assert.equal(r.row, true);
  uid = r.id; token = r.token;
});

test('(1) a restart (and the retention job) never drops the console login or the session flag', () => {
  for (let i = 0; i < 3; i++) {
    const r = start(`
      const ret = require(${JSON.stringify(DIST + '/utils/retention.js')});
      await ret.runRetention(db, { now: Date.now() + 400 * 86400000 });
      const h = auth.sessionHash(${JSON.stringify(token)});
      return { row: sc.consoleRow(${uid}), unlocked: sc.sessionUnlocked(h), keep: db.prepare('SELECT username FROM staff_console_keep WHERE user_id = ?').get(${uid}) };`);
    assert.equal(r.row?.username, 'boss.console', `start ${i + 1}: the login is there`);
    assert.equal(r.unlocked, true, `start ${i + 1}: the session stays console-unlocked`);
    assert.equal(r.keep?.username, 'boss.console', `start ${i + 1}: the protected copy is there`);
  }
  const { PROTECTED, RULES } = require(DIST + '/utils/retention.js');
  for (const t of ['staff_console', 'staff_console_keep', 'sessions', 'security_log', 'users']) assert.ok(PROTECTED.has(t), `${t} is on the never-touch list`);
  for (const r of RULES) assert.ok(!['staff_console', 'staff_console_keep', 'sessions'].includes(r.table));
});

let backup = '';
test('(1) a row the table lost comes back from its protected copy at the next start (sign-in step, never "Create")', () => {
  // a backup copy of the database as it is now (for the next test)
  backup = path.join(consoleDir, 'backups', 'sportlikely-20261028-024000.sqlite.gz');
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  const raw = path.join(consoleDir, 'snap.sqlite');
  start(`db.exec("VACUUM INTO '${raw.replace(/'/g, "''")}'"); return 1;`);
  fs.writeFileSync(backup, zlib.gzipSync(fs.readFileSync(raw)));
  fs.rmSync(raw);

  start(`db.prepare('DELETE FROM staff_console WHERE user_id = ?').run(${uid}); return 1;`);
  const r = start(`
    const atStart = sc.restoreFromKeep();
    return { atStart, row: sc.consoleRow(${uid}), ok: (() => { try { sc.consoleLogin(${uid}, auth.sessionHash(${JSON.stringify(token)}), 'boss.console', 'console-pass-123'); return true; } catch (e) { return e.message; } })(),
      logged: db.prepare("SELECT detail FROM security_log WHERE event = 'console_restored' ORDER BY id DESC").get()?.detail };`);
  assert.deepEqual(r.atStart, [uid]);
  assert.equal(r.row?.username, 'boss.console');
  assert.equal(r.ok, true, 'the old console password still works');
  assert.match(r.logged, /restored from its protected copy/);
  // and on demand: the status read itself brings it back
  start(`db.prepare('DELETE FROM staff_console WHERE user_id = ?').run(${uid}); return 1;`);
  assert.equal(start(`return sc.consoleRow(${uid})?.username;`), 'boss.console');
});

test('(1) without a protected copy: the security log names who lost it, the newest local backup gives it back', () => {
  const r = start(`
    db.prepare('DELETE FROM staff_console WHERE user_id = ?').run(${uid});
    db.prepare('DELETE FROM staff_console_keep WHERE user_id = ?').run(${uid});
    const lost = sc.lostBySecurityLog();
    const res = await sc.restoreFromBackups([${JSON.stringify(backup)}], { tempDir: ${JSON.stringify(path.join(consoleDir, 'tmp'))} });
    return { lost, res, row: sc.consoleRow(${uid}), keep: !!db.prepare('SELECT 1 FROM staff_console_keep WHERE user_id = ?').get(${uid}) };`);
  assert.deepEqual(r.lost, [uid]);
  assert.deepEqual(r.res.restored, [uid]);
  assert.equal(r.res.from, path.basename(backup));
  assert.equal(r.row?.username, 'boss.console');
  assert.equal(r.keep, true, 'the restored row is copied again');
  assert.deepEqual(fs.readdirSync(path.join(consoleDir, 'tmp')), [], 'the unpacked copy is deleted');
});

test('(1) a reset on purpose stays reset (no restore from the copy or a backup)', () => {
  const r = start(`
    sc.resetOwn(${uid});
    ${log('console_reset_admin', uid, '2026-10-28T12:00:00.000Z')}
    const k = sc.restoreFromKeep();
    const b = await sc.restoreFromBackups([${JSON.stringify(backup)}]);
    return { k, lost: b.lost, row: sc.consoleRow(${uid}) };`);
  assert.deepEqual(r.k, []);
  assert.deepEqual(r.lost, []);
  assert.equal(r.row, null);
  // set up again after the reset: the security log counts it as a login again, the copy follows
  const r2 = start(`
    const h = auth.sessionHash(${JSON.stringify(token)});
    sc.setupOwn(${uid}, h, 'boss.console2', 'console-pass-456');
    ${log('console_setup', uid, '2026-10-28T12:05:00.000Z')}
    return db.prepare('SELECT username, removed_at FROM staff_console_keep WHERE user_id = ?').get(${uid});`);
  assert.deepEqual({ ...r2 }, { username: 'boss.console2', removed_at: null });
});

/* ---------- (2) page languages ---------- */

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix258-pages-'));
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'warn';
require('../dist/db/index.js');
const { renderIndex, seoPage } = require('../dist/services/seo.js');
const { appPageFor, copyLooksRight, hreflangLinks, PAGE_LANGS } = require('../dist/utils/pageLang.js');
const { definePage, pageKey, sweepCopies } = require('../dist/services/pageCache.js');
const { db } = require('../dist/db/index.js');

const ALL = ['en', 'es', 'pt', 'de', 'fr', 'it', 'tr', 'id', 'hi', 'pl', 'el', 'ru'];
const pre = l => (l === 'en' ? '' : `/${l}`);
const INDEX = fs.readFileSync(path.resolve(here, '../../frontend/index.html'), 'utf8');
const PAGES = ['/', '/football', '/football/matches', '/basketball/matches', '/football/match/arsenal-vs-chelsea-2026-11-01', '/football/match/arsenal-vs-chelsea-2026-11-01/stats'];
const alternates = html => [...html.matchAll(/hreflang="([^"]+)" href="([^"]+)"/g)].map(m => [m[1], m[2]]);

test('(2) the hreflang set is 13 links: the 12 languages + x-default', () => {
  assert.deepEqual([...PAGE_LANGS], ALL);
  const links = hreflangLinks('/football/matches');
  assert.equal(links.length, 13);
  assert.ok(links.at(-1).includes('hreflang="x-default" href="https://sportlikely.com/football/matches"'));
});

test('(2) the plain app page: every language gets its own lang, canonical and the 13 hreflang links', () => {
  for (const l of ALL) for (const p of PAGES) {
    const html = appPageFor(INDEX, `${pre(l)}${p}`);
    assert.ok(html.includes(`<html lang="${l}"`), `${l} ${p}: lang`);
    const page = p.replace(/\/stats$/, '');
    assert.ok(html.includes(`<link rel="canonical" href="https://sportlikely.com${pre(l)}${page === '/' && l !== 'en' ? '' : page}"`), `${l} ${p}: canonical`);
    const alt = alternates(html);
    assert.equal(alt.length, 13, `${l} ${p}: 13 alternates`);
    assert.deepEqual(alt.map(a => a[0]), [...ALL, 'x-default']);
    assert.ok(copyLooksRight(html, l), `${l} ${p}: passes the check`);
  }
  // private pages: their lang, no alternates
  const acc = appPageFor(INDEX, '/es/account');
  assert.ok(acc.includes('<html lang="es"') && !acc.includes('hreflang'));
});

test('(2) every stored crawler copy (renderIndex) passes the check in all 12 languages; the old copies do not', () => {
  for (const l of ALL) for (const p of ['/', '/football', '/football/matches', '/basketball/matches', '/how-it-works']) {
    const html = renderIndex(INDEX, seoPage(`${pre(l)}${p}`));
    assert.ok(html.includes(`<html lang="${l}"`), `${l} ${p}`);
    assert.ok(copyLooksRight(html, l), `${l} ${p}: lang + hreflang`);
  }
  // what /es/football/matches could return on 28 Oct: index.html as built, or a copy with fix256's old 7-language set
  assert.equal(copyLooksRight(INDEX, 'es'), false);
  const seven = renderIndex(INDEX, seoPage('/es/football/matches')).replace(/\s*<link rel="alternate" hreflang="(id|hi|pl|el|ru)"[^>]*>/g, '');
  assert.equal(copyLooksRight(seven, 'es'), false);
  assert.equal(copyLooksRight(renderIndex(INDEX, seoPage('/football/matches')), 'es'), false, 'an English copy is not the Spanish page');
});

test('(2) the stale copies are found and built again (on-demand: dropped, built on the next request)', async () => {
  definePage({ name: 'seo-page', freshMs: 600000, refresh: false, keepMs: 2 * 86400000, build: () => null });
  const put = (p, html) => {
    const key = pageKey('seo-page', { path: p });
    db.prepare('INSERT OR REPLACE INTO page_cache (key, json, built_at, ms) VALUES (?, ?, ?, 0)').run(key, '{}', Date.now());
    db.prepare('INSERT OR REPLACE INTO page_cache (key, json, built_at, ms) VALUES (?, ?, ?, 0)').run(`${key}#html`, html, Date.now());
    return key;
  };
  const good = [], bad = [];
  for (const l of ALL) {
    good.push(put(`${pre(l)}/football/matches`, renderIndex(INDEX, seoPage(`${pre(l)}/football/matches`))));
    if (l !== 'en') bad.push(put(`${pre(l)}/basketball/matches`, INDEX)); // lang="en", no hreflang
  }
  const { langOfPath } = require('../dist/utils/pageLang.js');
  const r = await sweepCopies(['seo-page'], (q, head) => !copyLooksRight(head, langOfPath(q.path).lang));
  assert.equal(r.checked, good.length + bad.length);
  assert.equal(r.dropped, bad.length);
  for (const k of good) assert.ok(db.prepare('SELECT 1 FROM page_cache WHERE key = ?').get(`${k}#html`), `${k} kept`);
  for (const k of bad) assert.equal(db.prepare('SELECT COUNT(*) AS n FROM page_cache WHERE key = ? OR key LIKE ?').get(k, `${k}#%`).n, 0, `${k} dropped`);
});

test('(2) the web answers: every fallback sends the plain page through appPageFor, a wrong-language copy is never sent', () => {
  const app = fs.readFileSync(path.resolve(here, '../src/app.ts'), 'utf8');
  const route = app.slice(app.indexOf("app.get(/^(?!\\/api\\/|\\/socket\\.io\\/).*/"));
  assert.ok(route.length > 1000);
  assert.ok(!/res\.sendFile\(path\.join\(STATIC_DIR, 'index\.html'\)\);\n/.test(route.slice(0, route.indexOf("logger.info(`Serving frontend"))), 'no bare index.html in the page route');
  assert.ok(route.includes("!copyLooksRight(html.text, lang0)"));
  assert.ok(app.includes('page = appPageOf(res.req.path)'), 'the 900 ms cut sends the page with its language');
  assert.ok(fs.readFileSync(path.resolve(here, '../src/services/earlyStatic.ts'), 'utf8').includes('appPageFor(indexHtml()'), 'start-up page too');
});
