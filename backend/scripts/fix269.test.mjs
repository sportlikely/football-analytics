// fix269: survive a slow volume (28 Oct probe: worst p95 5,358 ms, worst 4 KB read 7,564 ms, worst fsync 15,078 ms).
// (1) reader threads' page cache 1 GB / 512 MB, mmap 2 GB, the repeat-read proof; (2) the web holds the lists / homes /
// standings / news / config copies (300 MB) and refreshes them in the background on the worker's "key changed" push;
// (3) synchronous NORMAL, checkpoints only in the worker's upkeep thread; (4) data health "Volume latency" every 10 min.
// (dist build) Run: npm run test:fix269
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '..', 'dist');
const D = JSON.stringify(DIST);
const run = (code, env = {}, timeout = 120000) => {
  const r = spawnSync(process.execPath, ['--no-warnings', '-e', code], { env: { ...process.env, LOG_LEVEL: 'error', NODE_ENV: 'production', GEO_OFF: '1', ...env }, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 });
  const line = (r.stdout || '').split('\n').find(l => l.startsWith('RESULT '));
  assert.ok(line, `no result (status ${r.status}):\n${(r.stderr || '').slice(-3000)}\n${(r.stdout || '').slice(-1000)}`);
  return JSON.parse(line.slice(7));
};
const tmp = name => fs.mkdtempSync(path.join(os.tmpdir(), `fix269-${name}-`));
const src = f => fs.readFileSync(path.join(here, '..', 'src', f), 'utf8');
const requireCjs = createRequire(import.meta.url);

/* ---------- (1) page cache ---------- */

test('(1) reader threads: 1 GB big / 512 MB small a thread, mmap 2 GB, scaled down in a small container', () => {
  const { cacheMbFor, tunePragmas, cachePlan, cacheTotalMb } = requireCjs(path.join(DIST, 'utils/dbTune.js'));
  assert.equal(cacheMbFor('reader', null), 1024);
  assert.equal(cacheMbFor('readerSmall', null), 512);
  assert.equal(cacheTotalMb({ small: 2, big: 2 }), 2 * 512 + 2 * 1024 + 128 + 64 + 64);
  assert.equal(cacheMbFor('reader', 16384), 1024, 'a 16 GB container holds them all');
  const eight = cachePlan({ small: 2, big: 2 }, 8192);
  assert.ok(eight.bigMb < 1024 && eight.bigMb > 512 && eight.readersTotalMb <= 2048, `8 GB: ¼ for every cache: ${JSON.stringify(eight)}`);
  const p = tunePragmas('reader', null);
  assert.ok(p.includes('PRAGMA cache_size = -1048576') && p.includes('PRAGMA mmap_size = 2147483648') && p.includes('PRAGMA temp_store = MEMORY'));
  assert.match(src('services/pageReader.ts'), /readers: \{ small: SIZES\.small, big: SIZES\.big \}/);
});

test('(1) the same read twice: counted as a repeat, its time in the thread from memory', () => {
  const dir = tmp('repeat');
  const r = run(`
    const { db } = require(${D} + '/db/index.js');
    db.exec("CREATE TABLE t269 (k INTEGER PRIMARY KEY, v TEXT)");
    const ins = db.prepare("INSERT INTO t269 (k, v) VALUES (?, ?)");
    for (let i = 0; i < 2000; i++) ins.run(i, 'x'.repeat(2000));
    const R = require(${D} + '/services/pageReader.js');
    (async () => {
      for (let i = 0; i < 6; i++) await R.readSql('SELECT length(v) AS n FROM t269 WHERE k = ?', [7]);
      await R.readSql('SELECT COUNT(*) AS n FROM t269', [], false, 'big');
      const st = R.pageReaderStatus();
      console.log('RESULT ' + JSON.stringify({ rep: st.repeatReads, cache: st.cache }));
      process.exit(0);
    })();
  `, { DATA_DIR: dir, SL_ROLE: 'web' });
  console.log(`  first reads ${JSON.stringify(r.rep.first)}, repeats ${JSON.stringify(r.rep.repeat)}`);
  assert.equal(r.rep.first.reads, 2);
  assert.equal(r.rep.repeat.reads, 5);
  assert.equal(r.rep.repeat.over50, 0, 'a repeat read never goes to the disk');
  assert.equal(r.cache.readers.big, 2);
  assert.ok(r.cache.bigMb >= 16);
});

/* ---------- (2) held copies on the web ---------- */

test('(2) the web holds a list copy: a newer copy is read in the background while the old one is still sent', () => {
  const dir = tmp('held');
  const r = run(`
    const { EventEmitter } = require('node:events');
    const ipc = require(${D} + '/services/ipc.js');
    const child = new EventEmitter(); child.connected = true; child.send = () => true;
    ipc.attachWorker(child);
    const { db } = require(${D} + '/db/index.js');
    const P = require(${D} + '/services/pageCache.js');
    const R = require(${D} + '/services/pageReader.js');
    P.definePage({ name: 'list269', freshMs: 3600000, warm: [{}], build: () => ({}), variants: { anon: () => '' } });
    P.definePage({ name: 'plain269', freshMs: 3600000, build: () => ({}), variants: { anon: () => '' } });
    const ins = db.prepare("INSERT OR REPLACE INTO page_cache (key, json, built_at, ms, etag, gz, kb) VALUES (?, ?, ?, 0, ?, NULL, 1)");
    const put = (key, at, text) => { ins.run(key, '{}', at, null); ins.run(key + '#anon', text, at, '"' + text + '"'); };
    const msg = (key, at) => child.emit('message', { t: 'page', key, builtAt: at, kb: { anon: 1 } });
    const tick = ms => new Promise(r => setTimeout(r, ms));
    const text = async name => (await P.getPage(name, {}, { views: ['anon'], waitMs: 1 }))?.view('anon')?.text;
    (async () => {
      await R.readSql('SELECT 1 AS one'); await R.readSql('SELECT 1 AS one', [], false, 'big');
      const t1 = Date.now() - 60000;
      put('list269', t1, 'list-v1'); put('plain269', t1, 'plain-v1'); msg('list269', t1); msg('plain269', t1);
      const out = { a: await text('list269'), pa: await text('plain269') };
      // v2 stored: the push arrives; the held copy answers at once with v1 while v2 is read, then v2
      put('list269', t1 + 1000, 'list-v2'); put('plain269', t1 + 1000, 'plain-v2');
      msg('list269', t1 + 1000); msg('plain269', t1 + 1000);
      const reads0 = R.pageReaderStatus().reads;
      out.during = await text('list269');
      out.readsDuring = R.pageReaderStatus().reads - reads0;
      await tick(300);
      out.after = await text('list269');
      out.pb = await text('plain269');
      // a push for a copy whose rows are not there (cleaned up / a stalled read): the old copy stays
      msg('list269', t1 + 2000);
      await tick(300);
      out.kept = await text('list269');
      out.mem = P.pageMemStatus();
      console.log('RESULT ' + JSON.stringify(out));
      process.exit(0);
    })();
  `, { DATA_DIR: dir, SL_ROLE: 'web' });
  console.log(`  ${JSON.stringify(r.mem)}`);
  assert.equal(r.a, 'list-v1');
  assert.equal(r.pa, 'plain-v1');
  assert.equal(r.during, 'list-v1', 'the held copy is sent while its new copy is read');
  assert.equal(r.readsDuring, 0, 'the request read nothing from the disk');
  assert.equal(r.after, 'list-v2', 'then the new copy');
  assert.equal(r.pb, 'plain-v2', 'a plain copy is dropped and read again (as before)');
  assert.equal(r.kept, 'list-v2', 'a refresh that cannot read the new copy keeps the old one');
  assert.equal(r.mem.held.copies, 1);
  assert.ok(r.mem.held.refreshed >= 1 && r.mem.held.failed >= 1, JSON.stringify(r.mem.held));
  assert.equal(r.mem.held.maxMb, 300);
  assert.equal(r.mem.copies, 1, 'the plain copy in the plain budget');
});

/* ---------- (3) writes ---------- */

test('(3) synchronous NORMAL everywhere; the web never checkpoints; the worker only while its upkeep thread is down', () => {
  const dir = tmp('sync');
  const q = `const { db } = require(${D} + '/db/index.js'); const v = n => Number(Object.values(db.prepare('PRAGMA ' + n).get())[0]);`;
  const web = run(`${q} console.log('RESULT ' + JSON.stringify({ sync: v('synchronous'), ac: v('wal_autocheckpoint'), wal: db.prepare('PRAGMA journal_mode').get().journal_mode }));`, { DATA_DIR: dir, SL_ROLE: 'web' });
  assert.deepEqual(web, { sync: 1, ac: 0, wal: 'wal' });
  const worker = run(`${q} console.log('RESULT ' + JSON.stringify({ sync: v('synchronous'), ac: v('wal_autocheckpoint') }));`, { DATA_DIR: dir, SL_ROLE: 'worker' });
  assert.deepEqual(worker, { sync: 1, ac: 1000 }, 'the worker checkpoints itself until its upkeep thread is up');
  const ds = src('services/dbSpace.ts');
  assert.match(ds, /thread = t;\s*autoCheckpoint\(false\);/);
  assert.match(ds, /thread = null; autoCheckpoint\(true\);/);
  assert.match(src('workers/dbMaint.ts'), /PRAGMA synchronous = NORMAL/);
});

/* ---------- (4) data health ---------- */

test('(4) "Volume latency": red when p95 > 500 ms in the last hour, yellow within 24 h, the hours listed; probe every 10 min', () => {
  const V = requireCjs(path.join(DIST, 'services/volumeProbe.js'));
  const now = Date.parse('2026-10-28T18:30:00Z');
  const s = (at, p95, max = p95, fsyncMs = 5) => ({ at, reads: 32, p50: 1, p95, max, fsyncMs });
  const ok = V.volumeHealth(now, [s('2026-10-28T17:10:00Z', 40), s('2026-10-28T18:20:00Z', 30)]);
  assert.equal(ok.level, 'ok');
  assert.equal(ok.id, 'volume-latency');
  const old = V.volumeHealth(now, [s('2026-10-28T09:10:00Z', 5358, 7564, 15078), s('2026-10-28T18:20:00Z', 68)]);
  assert.equal(old.level, 'warn');
  assert.match(old.detail, /09:00 UTC \(5,358 ms\)/);
  const red = V.volumeHealth(now, [s('2026-10-28T18:00:00Z', 900), s('2026-10-28T18:20:00Z', 68)], ['note']);
  assert.equal(red.level, 'fail');
  assert.match(red.items[0], /^18:00 UTC 2026-10-28: 2 run\(s\), p95 900 ms.*slow$/);
  assert.equal(red.items[red.items.length - 1], 'note');
  assert.equal(V.volumeHealth(now, []).level, 'ok');
  assert.match(src('services/dbSpace.ts'), /every\('volume latency', \(\) => volumeTick\(\), 10 \* 60 \* 1000\)/);
  assert.match(fs.readFileSync(path.join(here, '..', '..', 'frontend', 'src', 'lib', 'adminTabs.ts'), 'utf8'), /match: 'volume-latency'/);
});
