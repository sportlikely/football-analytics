// fix273 (29 Oct morning check). (dist build) Run: npm run test:fix273
//  1. No /api/admin/* route runs more than 50 ms of work on the web thread, on a production-size copy (450,000 visitor
//     rows): every admin route is passed to the worker (no worker here: 503), and the few the web answers itself
//     (WEB_ONLY_API) are timed on their own handler — Admin → Visitors took 13–23 s there; it is now the worker's stored
//     string. The one-pass "by country" query gives the same rows as the old one; the admin pages poll every 5 min and
//     pause in a hidden tab.
//  2. The WAL: PASSIVE passes before TRUNCATE, a wider gate after 2 blocked tries, red over 256 MB / no start-over in an
//     hour, the long reads (backup, job threads) named, reader threads end their read transaction.
//  3. Calibration, young sports (basketball / tennis): isotonic or Platt chosen out of fold, the lower bar (better in both
//     halves, ≥ 75% of resamples), re-tested nightly.
//  4. Names: no empty map is ever sent (202 pending, not cached); the map is built from the stored names at the start.
//  5. The nightly full Site check has a fallback time and a hand run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '../dist').replace(/\\/g, '/');
const SRC = f => fs.readFileSync(path.join(here, '..', f), 'utf8');
const FRONT = f => fs.readFileSync(path.join(here, '../../frontend/src', f), 'utf8');
const require = createRequire(import.meta.url);
const KEYS = ['FOOTBALL_DATA_API_KEY', 'ODDS_API_KEY', 'API_FOOTBALL_KEY', 'API_NFL_KEY', 'TENNIS_API_KEY', 'BALLDONTLIE_KEY', 'YOUTUBE_API_KEY', 'ANTHROPIC_API_KEY', 'API_BASKETBALL_KEY'];
const LIMIT_MS = 50;
const MB = 1048576, DAY = 86400000;

/* ---------- 1. admin routes on the web thread ---------- */

const PEOPLE = '(human = 1 OR signed_in = 1)';
const OLD_BY_COUNTRY = `
  SELECT COALESCE(country, '??') AS country, SUM(person) AS visitors, SUM(signed) AS signedIn, SUM(1 - person) AS bots FROM (
    SELECT vid, MAX(signed_in) AS signed, MAX(CASE WHEN ${PEOPLE} THEN 1 ELSE 0 END) AS person,
      (SELECT v2.country FROM visits v2 WHERE v2.vid = v.vid AND v2.day >= ? AND v2.country IS NOT NULL ORDER BY v2.day DESC LIMIT 1) AS country
    FROM visits v WHERE day >= ? AND ua_bot = 0 GROUP BY vid
  ) GROUP BY COALESCE(country, '??') ORDER BY visitors DESC, bots DESC`;
const COUNTRIES = ['IL', 'US', 'GB', 'DE', 'ES', 'FR', 'IT', 'BR', 'TR', 'IN', 'NG', 'ID', null];

/** the visits table as production has it: `perDay` callers a day for `days` days (returning visitors, bots, countries) */
function seedVisits(file, perDay, days) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS visits (day TEXT NOT NULL, vid TEXT NOT NULL, hits INTEGER NOT NULL DEFAULT 0, signed_in INTEGER NOT NULL DEFAULT 0,
      first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, country TEXT, human INTEGER NOT NULL DEFAULT 0, bot TEXT, ua_bot INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, vid));
    CREATE TABLE IF NOT EXISTS visit_meta (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS who_day (day TEXT PRIMARY KEY, data TEXT NOT NULL);`);
  const ins = db.prepare(`INSERT OR IGNORE INTO visits (day, vid, hits, signed_in, first_seen, last_seen, country, human, bot, ua_bot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let x = 12345;
  const rnd = () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  db.exec('BEGIN');
  for (let d = 0; d < days; d++) {
    const day = new Date(Date.now() - d * DAY).toISOString().slice(0, 10);
    for (let i = 0; i < perDay; i++) {
      // a third come back on other days (the same vid), the rest are new
      const vid = rnd() < 0.33 ? `r${Math.floor(rnd() * perDay)}` : `v${d}-${i}`;
      const bot = rnd() < 0.4;
      ins.run(day, vid, 1 + Math.floor(rnd() * 20), rnd() < 0.02 ? 1 : 0, `${day}T10:00:00Z`, `${day}T10:05:00Z`, COUNTRIES[Math.floor(rnd() * COUNTRIES.length)], bot ? 0 : rnd() < 0.7 ? 1 : 0, bot ? 'datacentre' : null, rnd() < 0.1 ? 1 : 0);
    }
  }
  db.exec('COMMIT');
  db.prepare(`INSERT OR REPLACE INTO who_day (day, data) VALUES (?, ?)`).run(new Date().toISOString().slice(0, 10), JSON.stringify({ day: new Date().toISOString().slice(0, 10), agents: [{ ua: 'Mozilla/5.0', requests: 10, verified: 0, dc: 0, mark: 'browser' }], networks: [], otherRequests: 10, limits: {} }));
  const n = db.prepare('SELECT COUNT(*) AS n FROM visits').get().n;
  db.close();
  return n;
}

test('"by country" in one pass gives the same rows as the old query (a sub-query per visitor)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix273-c-')), file = path.join(dir, 'v.sqlite');
  seedVisits(file, 300, 30);
  const { BY_COUNTRY_SQL } = require(DIST + '/services/visitorSummary.js');
  const db = new DatabaseSync(file);
  for (const days of [7, 30]) {
    const since = new Date(Date.now() - (days - 1) * DAY).toISOString().slice(0, 10);
    const old = db.prepare(OLD_BY_COUNTRY).all(since, since).map(r => ({ ...r }));
    const now = db.prepare(BY_COUNTRY_SQL).all(since).map(r => ({ ...r }));
    const key = rows => rows.map(r => `${r.country}|${r.visitors}|${r.signedIn}|${r.bots}`).sort();
    assert.deepEqual(key(now), key(old), `${days} days`);
  }
  db.close();
});

// a child process: the whole app in one role on the seeded copy
function child(role, dir, code) {
  const stat = path.join(dir, 'static');
  fs.mkdirSync(stat, { recursive: true });
  fs.writeFileSync(path.join(stat, 'index.html'), '<!doctype html><html lang="en"><head><title>SportLikely</title></head><body><div id="root"></div></body></html>');
  const env = { ...process.env, DATA_DIR: dir, STATIC_DIR: stat, SL_ROLE: role, THREAD_JOBS: '0', LOG_LEVEL: 'error', NODE_ENV: 'production', GEO_OFF: '1', PAGE_WAIT_MS: '1', SEO_WAIT_MS: '1' };
  for (const k of KEYS) env[k] = '';
  const r = spawnSync(process.execPath, ['--no-warnings', '-e', `const D = ${JSON.stringify(DIST)};\n${code}`], { env, encoding: 'utf8', timeout: 300000 });
  assert.equal(r.status, 0, `${role} child failed: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

// the web process: every /api/admin/* route of app.ts (GET and POST); the ones it answers itself timed on their handler
const WEB_CHILD = `
const { app } = require(D + '/app.js');
require(D + '/services/readiness.js').markReady({ loadMs: 0, states: 0 });
const role = require(D + '/services/role.js');
const shared = require(D + '/services/shared.js');
const routes = [];
for (const l of app._router.stack) if (l.route && /^\\/api\\/admin\\//.test(String(l.route.path))) for (const m of Object.keys(l.route.methods)) routes.push({ path: String(l.route.path), method: m.toUpperCase(), handle: l.route.stack[l.route.stack.length - 1].handle });
const sample = p => p.replace(/:([A-Za-z]+)(\\([^)]*\\))?/g, (_, n, re) => { const alt = re ? re.slice(1, -1).split('|')[0].replace(/[^A-Za-z0-9_-]/g, '') : ''; return alt || '1'; });
// a handler called as the web process would (an admin's request after the console check)
const call = r => new Promise(resolve => {
  const t0 = process.hrtime.bigint();
  let body = '';
  const res = { statusCode: 200, headers: {}, set(k, v) { if (typeof k === 'object') Object.assign(this.headers, k); else this.headers[k] = v; return this; }, type() { return this; }, status(c) { this.statusCode = c; return this; },
    json(b) { body = JSON.stringify(b); return this.end(); }, send(b) { body = String(b); return this.end(); }, end() { resolve({ ms: Number(process.hrtime.bigint() - t0) / 1e6, status: this.statusCode, body }); return this; }, on() { return this; }, once() { return this; }, setHeader() {}, getHeader() {} };
  const req = { method: r.method, path: sample(r.path).slice(4), originalUrl: sample(r.path), url: sample(r.path), query: {}, params: {}, body: {}, headers: {}, get: () => '', access: 'admin', user: { id: 1, email: 'admin@test' }, perms: new Set() };
  try { const p = r.handle(req, res, () => resolve({ ms: Number(process.hrtime.bigint() - t0) / 1e6, status: 0, body })); if (p && p.catch) p.catch(e => resolve({ ms: 0, status: 500, body: String(e) })); } catch (e) { resolve({ ms: 0, status: 500, body: String(e) }); }
});
const server = app.listen(0, '127.0.0.1', async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  await shared.loadNewerStates(true).catch(() => {});
  const out = [];
  for (const r of routes) {
    const url = sample(r.path);
    const open = async () => { const t0 = process.hrtime.bigint(); const x = await fetch(base + url, { method: r.method, headers: { 'content-type': 'application/json' }, body: r.method === 'GET' ? undefined : '{}' }); await x.arrayBuffer(); return { status: x.status, ms: Number(process.hrtime.bigint() - t0) / 1e6 }; };
    await open();
    const viaHttp = await open();
    let own = null;
    if (viaHttp.status !== 503) { await call(r); own = await call(r); }
    out.push({ path: r.path, method: r.method, url, viaHttp, own: own && { ms: own.ms, status: own.status, head: own.body.slice(0, 400) } });
  }
  console.log(JSON.stringify({ isWeb: role.isWeb, out }));
  process.exit(0);
});`;

test('no /api/admin/* route blocks the web thread over 50 ms on a production-size copy (450,000 visitor rows)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix273-w-'));
  const rows = seedVisits(path.join(dir, 'bet-to-beat.sqlite'), 22000, 30);
  assert.ok(rows > 400000, `${rows} rows`);
  // before the worker built the summary: the web sends "pending" at once
  const before = child('web', dir, WEB_CHILD);
  assert.equal(before.isWeb, true);
  // the worker builds the summary (here in-process: THREAD_JOBS=0) and publishes it
  const built = child('worker', dir, `
    require(D + '/app.js');
    require(D + '/services/visitors.js').refreshVisitorSummary().then(s => { console.log(JSON.stringify({ ms: s.ms, bytes: s.text.length })); process.exit(0); });`);
  assert.ok(built.bytes > 1000, 'the summary was stored');
  const after = child('web', dir, WEB_CHILD);
  const bad = [];
  for (const res of [before, after]) {
    assert.ok(res.out.length > 50, `only ${res.out.length} admin routes found`);
    for (const x of res.out) {
      if (x.viaHttp.status === 503) { if (x.viaHttp.ms > LIMIT_MS) bad.push(`${x.method} ${x.url}: passed on in ${Math.round(x.viaHttp.ms)} ms`); continue; }
      // answered by the web process itself: its own handler, timed (second call)
      if (!x.own) { bad.push(`${x.method} ${x.url}: answered ${x.viaHttp.status} by the web, handler not found`); continue; }
      if (x.own.ms > LIMIT_MS) bad.push(`${x.method} ${x.url}: ${Math.round(x.own.ms)} ms of work on the web thread (over ${LIMIT_MS} ms)`);
    }
  }
  assert.deepEqual(bad, [], `\n${bad.join('\n')}`);
  const vis = r => r.out.find(x => x.path === '/api/admin/visitors');
  assert.ok(vis(before) && vis(after), 'Admin → Visitors is a web route');
  assert.match(vis(before).own.head, /"pending":true/, 'before the first build: pending');
  assert.match(vis(after).own.head, /"onlineNow":0/, 'the live part');
  assert.match(vis(after).own.head, /"today":\d+/, 'the stored part');
  const web = [...before.out, ...after.out].filter(x => x.viaHttp.status !== 503).map(x => x.path);
  console.log(`fix273: ${after.out.length} admin routes; answered by the web itself: ${[...new Set(web)].join(', ') || 'none'}; summary built in ${built.ms} ms on the worker`);
});

test('the admin pages poll every 5 min and pause in a hidden tab (src)', () => {
  const p = FRONT('lib/poll.ts');
  assert.match(p, /ADMIN_POLL_MS = 5 \* 60 \* 1000/);
  assert.match(p, /visibilityState === 'hidden'/);
  for (const f of ['components/VisitorsCard.tsx', 'pages/Admin.tsx', 'pages/Crm.tsx']) {
    const s = FRONT(f);
    assert.doesNotMatch(s, /setInterval\((load|reload|loadList|\(\) => load\(\))\s*,/, `${f}: a plain setInterval poll`);
    assert.match(s, /poll\(/, f);
  }
  assert.match(SRC('src/app.ts'), /app\.get\('\/api\/admin\/visitors', \(_req, res\) => \{ res\.set\('Cache-Control', 'no-store'\)\.type\('application\/json'\)\.send\(visitorsAnswer\(\)\); \}\);/);
  assert.match(SRC('src/jobs.ts'), /every\('visitors summary', visitorsSummary, 5 \* 60 \* 1000\)/);
});

/* ---------- 2. the WAL ---------- */

function maintThread(file) {
  const w = new Worker(path.join(DIST, 'workers/dbMaint.js'), { workerData: { file } });
  let seq = 0;
  const ask = msg => new Promise((resolve, reject) => {
    const id = ++seq;
    const on = m => { if (m.id !== id) return; w.off('message', on); m.error ? reject(new Error(m.error)) : resolve(m.out); };
    w.on('message', on);
    w.postMessage({ id, ...msg });
  });
  return { ask, stop: () => w.terminate() };
}
const walSize = file => { try { return fs.statSync(`${file}-wal`).size; } catch { return 0; } };

test('TRUNCATE: PASSIVE passes stop when a reader holds the frames (named as blocked), and the WAL starts over once it is gone', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix273-wal-')), file = path.join(dir, 'w.sqlite');
  const wr = new DatabaseSync(file);
  wr.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; PRAGMA synchronous = NORMAL; CREATE TABLE t (k INTEGER PRIMARY KEY, v TEXT)');
  const put = n => { const st = wr.prepare('INSERT OR REPLACE INTO t (k, v) VALUES (?, ?)'); wr.exec('BEGIN'); for (let i = 0; i < n; i++) st.run(i % 400, 'x'.repeat(3000)); wr.exec('COMMIT'); };
  put(2000);
  const rd = new DatabaseSync(file);
  const m = maintThread(file);
  try {
    rd.exec('BEGIN'); rd.prepare('SELECT COUNT(*) AS n FROM t').get();
    put(2000);
    const held = await m.ask({ op: 'checkpoint', mode: 'TRUNCATE', busyMs: 200, catchUp: 16 });
    assert.equal(held.busy, 1);
    assert.equal(held.truncated, false);
    assert.equal(held.passes, 2, 'a second pass that gains nothing ends the passes');
    assert.ok(held.left > 16);
    rd.exec('COMMIT');
    const done = await m.ask({ op: 'checkpoint', mode: 'TRUNCATE', busyMs: 200, catchUp: 16 });
    assert.equal(done.truncated, true, 'the reader is gone: PASSIVE catches up, TRUNCATE starts the WAL over');
    assert.equal(walSize(file), 0);
  } finally { await m.stop(); rd.close(); wr.close(); }
});

test('a reader thread ends its read transaction after every read (src) and node:sqlite reads hold no snapshot', () => {
  const s = SRC('src/workers/pageReader.ts');
  assert.match(s, /isTransaction\) db\.exec\('ROLLBACK'\)/);
  assert.equal((s.match(/release\(\);/g) || []).length, 3, 'after a sql read, a stored-page read and an error');
  // get() / all() on a prepared statement leave no snapshot: TRUNCATE succeeds right after
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix273-r-')), file = path.join(dir, 'r.sqlite');
  const a = new DatabaseSync(file);
  a.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (x)');
  for (let i = 0; i < 100; i++) a.prepare('INSERT INTO t VALUES (?)').run(i);
  const r = new DatabaseSync(file, { readOnly: true });
  const st = r.prepare('SELECT x FROM t');
  st.get(); st.all();
  a.prepare('INSERT INTO t VALUES (1)').run();
  assert.equal(a.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy, 0);
  r.close(); a.close();
});

test('the gate widens after 2 blocked tries; Disk is red over 256 MB of WAL or with no start-over in an hour', () => {
  const rules = require(DIST + '/utils/diskRules.js');
  assert.deepEqual(rules.truncatePlan(10 * MB, 0), { busyMs: 300, catchUp: 4096 });
  assert.equal(rules.truncatePlan(10 * MB, 2).catchUp, 65536);
  assert.equal(rules.truncatePlan(2350 * MB, 8).catchUp, 65536);
  const base = { volFree: 40e9, volTotal: 50e9, dbBytes: 2.83e9, growth7d: null };
  assert.equal(rules.diskVerdict({ ...base, walBytes: 2350 * MB }).level, 'fail', 'the 29 Oct WAL');
  assert.equal(rules.diskVerdict({ ...base, walBytes: 257 * MB }).level, 'fail');
  assert.equal(rules.diskVerdict({ ...base, walBytes: 100 * MB }).level, 'ok', 'fix276: under 256 MB with TRUNCATE working = plain ok');
  assert.equal(rules.diskVerdict({ ...base, walBytes: 0, truncateAgeMs: 61 * 60000 }).level, 'fail');
  assert.equal(rules.diskVerdict({ ...base, walBytes: 0, truncateAgeMs: 20 * 60000 }).level, 'ok');
  assert.equal(rules.diskVerdict({ ...base, walBytes: 0, truncateAgeMs: null }).level, 'ok');
});

test('long reads: the backup and job threads are named; the WAL is asked to start over when the last one ends', () => {
  const lr = require(DIST + '/services/longReads.js');
  let calls = 0;
  lr.onLongReadsEnded(() => calls++);
  const real = Date.now;
  try {
    let t = real();
    Date.now = () => t;
    const a = lr.longRead('backup (VACUUM INTO)'), b = lr.longRead('thread: bb tune');
    t += 38 * 60000;
    assert.deepEqual(lr.longReadsNow(t).map(x => [x.name, x.forMin]), [['backup (VACUUM INTO)', 38], ['thread: bb tune', 38]]);
    a();
    assert.equal(calls, 0, 'another long read is still open');
    b(); b();
    assert.equal(calls, 1);
    const c = lr.longRead('thread: short');
    t += 5000;
    c();
    assert.equal(calls, 1, 'a short read does not ask');
  } finally { Date.now = real; }
  assert.match(SRC('src/services/backup.ts'), /longRead\('backup \(VACUUM INTO\)'\)/);
  assert.match(SRC('src/services/threadJob.ts'), /longRead\(`thread: \$\{job\}`\)/);
  assert.match(SRC('src/services/dbSpace.ts'), /onLongReadsEnded\(/);
  assert.match(SRC('src/services/dbSpace.ts'), /wal_1h/);
});

/* ---------- 3. calibration, young sports ---------- */

const { mulberry32 } = require(DIST + '/utils/dailyRules.js');
const rc = require(DIST + '/utils/recentCalib.js');
const NOW = Date.parse('2026-10-29T05:00:00Z'), DAY0 = Math.floor(NOW / DAY) * DAY;
function rows2(n, days, truth, seed = 7) {
  const r = mulberry32(seed);
  return Array.from({ length: n }, (_, i) => {
    const top = 0.5 + 0.38 * r(), home = r() < 0.5, hit = r() < truth(top), p = home ? top : 1 - top;
    return { p: [p, 0, 1 - p], y: hit === home ? 0 : 2, t: DAY0 - Math.floor(((i + 0.5) / n) * days * DAY) };
  });
}

const over = top => 0.5 + (top - 0.5) * 0.45; // said 65 → happened ~57: over-confident like basketball on 29 Oct
const under = top => Math.min(0.97, 0.5 + (top - 0.5) * 1.8); // said 65 → happened ~77: like tennis
const young = (rows, last = null) => rc.decideRecent(rows, null, null, last, NOW, undefined, 273, undefined, { young: true });
const rate = (n, truth, f = young) => { let k = 0; for (let s = 1; s <= 20; s++) if (f(rows2(n, 4, truth, s)).decision === 'promote') k++; return k; };
/** a sample the rule promotes (the rates above say how often that is) */
const promoted = (n, truth) => { for (let s = 1; s <= 20; s++) { const r = rows2(n, 4, truth, s); if (young(r).decision === 'promote') return r; } return rows2(n, 4, truth, 1); };

test('basketball-like (said 55–65, happened 47–59), 400 games in 4 days: the young rule promotes a layer that says less', () => {
  assert.ok(rate(400, over) >= 17, 'promoted on at least 17 of 20 samples');
  const d = young(promoted(400, over));
  assert.equal(d.mode, 'young');
  assert.equal(d.decision, 'promote', d.reason);
  assert.match(d.kindWhy, /out of fold/);
  const b = d.bands.find(x => x.lo === 60);
  assert.ok(b.cal < b.said, `60–70%: said ${b.said} → ${b.cal}, happened ${b.happened}`);
  assert.ok(Math.abs(b.cal - b.happened) < Math.abs(b.said - b.happened), 'closer to what happened');
});

test('tennis-like (said 65, happened 76: under-confident), 300 games: promoted, says more', () => {
  assert.equal(rate(300, under), 20);
  const d = young(rows2(300, 4, under, 5));
  const b = d.bands.find(x => x.lo === 60);
  assert.ok(b.cal > b.said, `60–70%: said ${b.said} → ${b.cal}, happened ${b.happened}`);
});

test('young rule: an honest model rarely gets a layer; a gain in one half only is not enough; one promotion a day, not a week', () => {
  assert.ok(rate(400, top => top) <= 5, 'an honest model: a layer on at most 5 of 20 samples');
  // a candidate that helps the earlier half and hurts the later one fails, however the total comes out
  const rows = rows2(400, 4, top => top, 9).sort((a, b) => a.t - b.t);
  const firstHalf = new Set(rows.slice(0, 200));
  const truthOf = r => (r.y === 0 ? [1, 0, 0] : [0, 0, 1]);
  const v = rc.judgeYoung(rows, r => (firstHalf.has(r) ? truthOf(r).map(x => 0.9 * x + 0.05) : r.p.map((x, i) => i === 1 ? 0 : x === Math.max(...r.p) ? x + 0.02 : x - 0.02)), r => r.p);
  assert.equal(v.pass, false, v.why);
  assert.ok(v.halves[0] < 0, 'better in the earlier half');
  // promoted yesterday: may move again tonight (fix270's rule waited 7 days)
  const d = young(promoted(400, over), '2026-10-28');
  assert.equal(d.decision, 'promote', d.reason);
  // not young (football): fix270's rule as before
  assert.equal(rc.decideRecent(rows2(400, 4, over, 2), null, null, null, NOW).mode, 'cross-fit');
  assert.equal(rc.YOUNG_CONFIDENCE, 0.75);
});

test('the nightly run uses the young rule for basketball and tennis, and a fix270 run does not count as today\'s (src)', () => {
  const s = SRC('src/services/recentCalib.ts');
  assert.match(s, /RECENT_RULE = 'fix273'/);
  assert.match(s, /\{ young: sport !== 'football'(, refit: !!opts\.refit)? \}/); // fix293: + the one-time refit
});

/* ---------- 4. names ---------- */

test('names: never an empty map (202 pending, not cached); the map from the stored names one minute after a start', () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix273-n-'));
  process.env.LOG_LEVEL = 'error';
  const names = require(DIST + '/services/names.js');
  assert.equal(names.namesJson('he'), '', 'not built: no empty map');
  assert.equal(names.namesJson('es'), null);
  const app = SRC('src/app.ts');
  assert.match(app, /if \(!j\) return res\.status\(202\)\.set\('Cache-Control', 'no-store'\)\.json\(\{ pending: true \}\)/);
  const jobs = SRC('src/jobs.ts');
  assert.match(jobs, /after\('names map', \(\) => buildMaps\(yieldEvery\(50, 100\)\), 60 \* 1000\)/);
  assert.match(jobs, /\n  every\('names', \(\) => namesTick\(\), 30 \* 60 \* 1000\)\.unref\(\);/, 'the 30-min runs scheduled at once');
  const front = FRONT('lib/names.ts');
  assert.match(front, /!Object\.keys\(kept\.names\)\.length\) kept = null/);
  assert.match(front, /!j\?\.names \|\| !Object\.keys\(j\.names\)\.length\) return/);
});

/* ---------- 5. the nightly full Site check ---------- */

test('the nightly full Site check: 01:17 UTC, a 04:43 fallback when no run of today exists, a hand run', () => {
  const y = fs.readFileSync(path.join(here, '../../.github/workflows/site-nightly.yml'), 'utf8');
  assert.match(y, /cron: '17 1 \* \* \*'/);
  assert.match(y, /cron: '43 4 \* \* \*'/);
  assert.match(y, /workflow_dispatch:/);
  assert.match(y, /needs\.due\.outputs\.run == 'true'/);
  assert.match(y, /uses: \.\/\.github\/workflows\/site-check\.yml/);
  assert.match(y, /mode: full/);
});
