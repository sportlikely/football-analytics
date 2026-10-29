// fix272: the database grew 2.97 → 7.88 GB in ~5 h (28–29 Oct). (1) the WAL starts over again: TRUNCATE runs once
// PASSIVE has nearly caught up (it waited for "exactly caught up", never true under constant writes + readers), with a
// longer wait for old readers as the WAL grows — checked on a real SQLite file with a reader on an old snapshot;
// (2) the disk rules: 6-hour growth, red when the volume would fill within 3 days at that rate, a size report of its own
// after 1 GB in 6 h; (3) a stored page rebuilt unchanged only moves its time (no view / gzip rewritten), a changed one
// is written and its leftovers swept; (4) the names job writes in slices and builds the pages' map before Wikidata
// (a Wikidata that fails still leaves the map full). (dist build) Run: npm run test:fix272
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix272-'));
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'warn';
process.env.NAMES_GAP_MS = '0';
process.env.SL_ROLE = 'worker'; // the page store's worker side (the only writer)
const require = createRequire(import.meta.url);
const { db } = require('../dist/db/index.js');
const rules = require('../dist/utils/diskRules.js');
const pages = require('../dist/services/pageCache.js');
require('../dist/services/apiFootball.js'); // af_fixtures
require('../dist/services/playerData.js'); // af_player_season
const names = require('../dist/services/names.js');
const GB = 1073741824, MB = 1048576;

/* ---------- (1) the WAL starts over ---------- */

function maintThread(file) {
  const w = new Worker(path.join(here, '../dist/workers/dbMaint.js'), { workerData: { file } });
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

test('TRUNCATE runs when PASSIVE nearly caught up (a reader on an old snapshot) — the old "exactly caught up" rule never did', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix272-wal-')), file = path.join(dir, 'w.sqlite');
  const wr = new DatabaseSync(file);
  wr.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; PRAGMA synchronous = NORMAL');
  wr.exec('CREATE TABLE t (k INTEGER PRIMARY KEY, v TEXT)');
  const put = n => { const st = wr.prepare('INSERT OR REPLACE INTO t (k, v) VALUES (?, ?)'); wr.exec('BEGIN'); for (let i = 0; i < n; i++) st.run(i % 400, 'x'.repeat(3000)); wr.exec('COMMIT'); };
  put(2000);
  const rd = new DatabaseSync(file);
  const m = maintThread(file);
  try {
    // a reader on a snapshot, then more writes: PASSIVE cannot write those frames back while it reads
    const snapshot = () => { rd.exec('BEGIN'); rd.prepare('SELECT COUNT(*) AS n FROM t').get(); };
    snapshot();
    put(200);
    const old = await m.ask({ op: 'checkpoint', mode: 'TRUNCATE', busyMs: 300, catchUp: 0 }); // fix249's rule (left must be 0)
    assert.equal(old.busy, 1, 'the old rule: busy');
    assert.ok(old.left > 0, `frames left behind the reader: ${old.left}`);
    assert.ok(walSize(file) > MB, 'the WAL did not start over');
    // fix272: a few frames left → TRUNCATE copies them under the writer lock and waits for the reader (it ends in 100 ms)
    setTimeout(() => rd.exec('COMMIT'), 100);
    const t0 = Date.now();
    const now = await m.ask({ op: 'checkpoint', mode: 'TRUNCATE', busyMs: 2000, catchUp: 4096 });
    assert.equal(now.busy, 0, 'TRUNCATE done');
    assert.equal(now.truncated, true);
    assert.equal(walSize(file), 0, 'the WAL file is cut back');
    assert.ok(Date.now() - t0 < 2000, 'it waited for the reader, not the whole wait');
    // many frames left (over catchUp): never copied under the writer lock — next time
    snapshot();
    put(2000);
    const many = await m.ask({ op: 'checkpoint', mode: 'TRUNCATE', busyMs: 300, catchUp: 16 });
    assert.equal(many.busy, 1);
    assert.equal(many.truncated, false);
    rd.exec('COMMIT');
    assert.equal(rd.prepare('SELECT COUNT(*) AS n FROM t').get().n, 400, 'every row there');
  } finally { await m.stop(); rd.close(); wr.close(); }
});

test('the wait for old readers and the frames TRUNCATE may copy grow with the WAL and with failed tries', () => {
  assert.deepEqual(rules.truncatePlan(10 * MB, 0), { busyMs: 300, catchUp: 4096 });
  assert.equal(rules.truncatePlan(300 * MB, 0).busyMs, 1000);
  assert.equal(rules.truncatePlan(10 * MB, 3).busyMs, 1000);
  assert.deepEqual(rules.truncatePlan(2 * GB, 0), { busyMs: 2000, catchUp: 16384 });
  assert.equal(rules.truncatePlan(4 * GB, 0).busyMs, 4000);
  assert.equal(rules.truncatePlan(10 * MB, 12).busyMs, 4000);
});

test('the upkeep schedule: PASSIVE every minute, TRUNCATE every 5 min while the WAL is over 64 MB (src)', () => {
  const s = fs.readFileSync(path.join(here, '../src/services/dbSpace.ts'), 'utf8');
  assert.match(s, /every\('db checkpoint', \(\) => checkpoint\('PASSIVE'\), 60 \* 1000\)/);
  assert.match(s, /every\('db checkpoint', \(\) => checkpointTick\(\), 5 \* 60 \* 1000\)/);
  assert.match(s, /files\(\)\.wal > 64 \* 1048576/);
});

/* ---------- (2) disk rules ---------- */

test('6-hour growth: red when the volume would fill within 3 days at that rate (28–29 Oct: +4.9 GB in 5 h, 34.7 GB free)', () => {
  const at = h => new Date(Date.parse('2026-10-29T01:40:00Z') - h * 3600000).toISOString();
  const rows = [{ at: at(5.2), bytes: 2.97 * GB }, { at: at(3), bytes: 5 * GB }, { at: at(1), bytes: 7 * GB }];
  const g = rules.growthOver(rows, { at: at(0), bytes: 7.88 * GB }, 6);
  assert.ok(Math.abs(g.bytes - 4.91 * GB) < 0.01 * GB);
  assert.ok(Math.abs(g.hours - 5.2) < 0.01);
  const v = rules.diskVerdict({ volFree: 34.7 * GB, volTotal: 50 * GB, dbBytes: 3 * GB, walBytes: 4.88 * GB, growth7d: null, perDay6h: g.perDay });
  assert.equal(v.level, 'fail');
  assert.ok(v.daysToFull6h < 2, `full in ${v.daysToFull6h} days`);
  assert.ok(v.reasons.some(r => /last 6 hours' growth/.test(r)));
  // a slow 6 hours: no red from it
  const calm = rules.diskVerdict({ volFree: 34.7 * GB, volTotal: 50 * GB, dbBytes: 3 * GB, walBytes: 0, growth7d: null, perDay6h: 0.3 * GB });
  assert.equal(calm.level, 'ok');
  // under an hour of rows: unknown; the WAL shrinking: negative growth, no full date
  assert.equal(rules.growthOver([{ at: at(0.5), bytes: GB }], { at: at(0), bytes: 2 * GB }), null);
  assert.equal(rules.diskVerdict({ volFree: 30 * GB, volTotal: 50 * GB, dbBytes: 3 * GB, walBytes: 0, growth7d: null, perDay6h: -20 * GB }).daysToFull6h, null);
});

test('a size report of its own after 1 GB+ in 6 h, at most every 6 h', () => {
  const now = Date.parse('2026-10-29T01:40:00Z');
  assert.equal(rules.reportDue(4.9 * GB, now - 20 * 3600000, now), true);
  assert.equal(rules.reportDue(4.9 * GB, now - 2 * 3600000, now), false);
  assert.equal(rules.reportDue(0.4 * GB, null, now), false);
  assert.equal(rules.reportDue(null, null, now), false);
});

/* ---------- (3) the page store: unchanged builds only move their time ---------- */

test('a stored page rebuilt unchanged only moves built_at; a changed one is written, its old parts / views swept', async () => {
  let body = { data: { list: Array.from({ length: 50 }, (_, i) => ({ id: i, name: `Team ${i}`, pad: 'y'.repeat(200) })) } };
  let extra = true;
  pages.definePage({ name: 'fix272-list', freshMs: 1000, build: () => body, variants: { full: b => JSON.stringify(b), extra: b => (extra ? JSON.stringify(b.data.list.slice(0, 5)) : null) } });
  const rows = () => db.prepare(`SELECT key, built_at, length(json) AS n, gz IS NOT NULL AS gz FROM page_cache WHERE key = 'fix272-list' OR key LIKE 'fix272-list#%' ORDER BY key`).all();
  const changes = () => Number(db.prepare('SELECT total_changes() AS n').get().n);
  await pages.storePage('fix272-list');
  const a = rows();
  assert.deepEqual(a.map(r => r.key), ['fix272-list', 'fix272-list#extra', 'fix272-list#full']);
  assert.equal(a[2].gz, 1, 'the full view has its gzip copy');
  const before = pages.pageMemStatus().builds;
  await new Promise(r => setTimeout(r, 5));
  const c0 = changes();
  await pages.storePage('fix272-list');
  const b = rows();
  assert.equal(changes() - c0, 3, 'one UPDATE of 3 rows (the page and its 2 views), nothing inserted or deleted');
  assert.ok(b.every(r => r.built_at > a[0].built_at && r.built_at === b[0].built_at), 'every row has the new time');
  assert.deepEqual(b.map(r => [r.key, r.n, r.gz]), a.map(r => [r.key, r.n, r.gz]), 'the same texts and gzip copies');
  assert.equal(pages.pageMemStatus().builds.touched, before.touched + 1);
  // the page reads back at its new time
  pages._forgetPageMemory();
  const s = await pages.getPage('fix272-list', {}, { views: ['full'] });
  assert.equal(s.builtAt, b[0].built_at);
  assert.equal(JSON.parse(s.view('full').text).data.list.length, 50);
  // changed: written, and the view this build has no more is gone
  body = { data: { list: body.data.list.slice(0, 10) } };
  extra = false;
  await pages.storePage('fix272-list');
  const c = rows();
  assert.deepEqual(c.map(r => r.key), ['fix272-list', 'fix272-list#full'], 'the dropped view swept');
  assert.ok(c[1].n < a[2].n);
  assert.equal(pages.pageMemStatus().builds.written, before.written + 1);
});

/* ---------- (4) the names job ---------- */

test('the names job writes in slices and fills the pages\' map before Wikidata (Wikidata failing leaves it full)', async () => {
  const day = new Date().toISOString().slice(0, 10);
  const ins = db.prepare(`INSERT OR REPLACE INTO af_fixtures (fixture_id, league_id, season, grp, division, kickoff, date, home_id, away_id, home_name, away_name, status) VALUES (?, 39, 2026, 'AF39', 'Premier League', ?, ?, ?, ?, ?, ?, 'NS')`);
  db.exec('BEGIN');
  for (let i = 0; i < 1500; i++) ins.run(800000 + i, `${day}T15:00:00Z`, day, 70000 + i, 72000 + i, `Club Number ${i} United`, `Athletic Side ${i}`);
  ins.run(899999, `${day}T15:00:00Z`, day, 42, 49, 'Arsenal', 'Chelsea');
  db.exec('COMMIT');
  names.setNamesFetcher(async () => ({ ok: false, status: 503, json: async () => ({}) }));
  const c0 = Number(db.prepare('SELECT total_changes() AS n').get().n);
  const run = await names.namesTick({ collect: true, wd: 20 });
  assert.match(String(run.error), /Wikidata HTTP 503/);
  assert.ok(run.items >= 3002, `${run.items} names collected`);
  assert.ok(Number(db.prepare('SELECT total_changes() AS n').get().n) - c0 >= 3002 * 3, 'items + he + ar rows written');
  const he = JSON.parse(names.namesJson('he')).names, ar = JSON.parse(names.namesJson('ar')).names;
  assert.equal(he.Arsenal, 'ארסנל', 'press spelling in the map');
  assert.ok(Object.keys(he).length >= 3000 && Object.keys(ar).length >= 3000, `map: he ${Object.keys(he).length}, ar ${Object.keys(ar).length}`);
  const h = names.namesHealth();
  assert.equal(h.id, 'local-names');
  assert.equal(h.level, 'ok');
  assert.match(h.detail, /^he: [\d,]+ entries \([\d,]+ teams, \d+ leagues\), [\d,]+ in the pages' map · ar: /);
  assert.ok(h.items.some(x => /Wikidata HTTP 503/.test(x)));
  // the source: one transaction a slice, never one commit per row
  const src = fs.readFileSync(path.join(here, '../src/services/names.ts'), 'utf8');
  assert.match(src, /await inSlices\(items,/);
  assert.match(src, /await inSlices\(rows,/);
  names.setNamesFetcher(null);
});
