// fix250: nothing ever waits — (1) a public GET not answered in 900 ms gets { pending: true } (a page: the plain app
// page), the work goes on and its answer is sent at once next time (X-SL-Copy: late; stale ones refreshed); requests
// over 1 s are counted and data health "Slow requests" fails on them; (2) the game bundle's byte ranges are each part's
// own answer; (3) a stored view over 2 MB is kept in parts and read back whole (synchronous and reader thread); (4) a
// read over 500 ms is logged with its SQL, thread time and size. (dist build) Run: npm run test:fix250
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '../dist').replace(/\\/g, '/');
const env = (extra = {}) => ({ ...process.env, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'fix250-')), NODE_ENV: 'production', LOG_LEVEL: 'error', THREAD_JOBS: '0', ...extra });
const run = (code, e, timeout = 120000) => {
  const r = spawnSync(process.execPath, ['--no-warnings', '-e', code], { env: e, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
  const line = (r.stdout || '').split('\n').find(l => l.startsWith('RESULT '));
  assert.ok(line, `no result (status ${r.status}):\n${(r.stderr || '').slice(-3000)}\n${(r.stdout || '').slice(-1500)}`);
  return JSON.parse(line.slice(7));
};

test('the one-second rule: pending at 900 ms, the late answer kept and sent at once, a page gets the app page', () => {
  const r = run(`
    const express = require('express');
    const D = require('${DIST}/services/deadline.js');
    const app = express();
    app.use(D.deadlineStart({ isApi: p => p.startsWith('/api/'), sendAppPage: res => { res.status(200).type('html').end('APP PAGE'); return true; },
      label: req => 'GET ' + req.path, crawler: req => req.get('x-crawler') === '1' }));
    app.use((req, _res, next) => { if (req.get('x-user')) { req.user = { id: Number(req.get('x-user')) }; req.access = 'free'; } next(); });
    app.use(D.lateCopy);
    let runs = 0;
    app.get('/api/slow', (req, res) => { runs++; setTimeout(() => res.json({ ok: runs }), 1500); });
    app.get('/api/fast', (req, res) => res.json({ fast: true }));
    app.get('/api/stream', (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); setTimeout(() => res.end('{}'), 1300); });
    app.get('/page', (req, res) => setTimeout(() => res.type('html').end('FULL PAGE'), 2000));
    app.post('/api/unlock', (req, res) => res.json({ ok: true }));
    const srv = app.listen(0, async () => {
      const base = 'http://127.0.0.1:' + srv.address().port;
      const get = async (p, h = {}) => { const t0 = Date.now(); const x = await fetch(base + p, { headers: { accept: p.startsWith('/api') ? 'application/json' : 'text/html', ...h } }); return { status: x.status, ms: Date.now() - t0, body: await x.text(), copy: x.headers.get('x-sl-copy'), stale: x.headers.get('x-sl-stale'), pending: x.headers.get('x-sl-pending') }; };
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const out = {};
      out.first = await get('/api/slow');
      await sleep(900);
      out.second = await get('/api/slow');
      out.fast = await get('/api/fast');
      out.page = await get('/page');
      out.crawler = await get('/api/slow?c=1', { 'x-crawler': '1' });
      // a signed-in person's own copy, dropped when they change something
      out.u1 = await get('/api/slow', { 'x-user': '7' });
      await sleep(900);
      out.u2 = await get('/api/slow', { 'x-user': '7' });
      await fetch(base + '/api/unlock', { method: 'POST', headers: { 'x-user': '7' } });
      out.u3 = await get('/api/slow', { 'x-user': '7' });
      out.stream = await get('/api/stream');
      await sleep(200);
      out.slow = D.slowRequests();
      console.log('RESULT ' + JSON.stringify(out));
      process.exit(0);
    });
  `, env({ SL_ROLE: 'web' }));
  assert.equal(r.first.status, 202, 'not answered in 900 ms: pending');
  assert.ok(r.first.ms < 1000, `pending sent in ${r.first.ms} ms`);
  assert.equal(JSON.parse(r.first.body).pending, true);
  assert.equal(r.second.status, 200, 'the late answer was kept');
  assert.equal(r.second.copy, 'late');
  assert.ok(r.second.ms < 100, `kept answer at once (${r.second.ms} ms)`);
  assert.equal(JSON.parse(r.second.body).ok, 1);
  assert.equal(r.fast.status, 200); assert.equal(r.fast.copy, null);
  assert.equal(r.page.body, 'APP PAGE', 'a page: the plain app page');
  assert.ok(r.page.ms < 1000);
  assert.equal(r.crawler.status, 200, 'a verified search engine waits for the full answer');
  assert.ok(r.crawler.ms >= 1400);
  assert.equal(r.u1.status, 202, 'a signed-in person has their own copies');
  assert.equal(r.u2.copy, 'late');
  assert.equal(r.u3.status, 202, 'after their POST their copies are gone');
  // counted: the stream (headers sent, body late), the search engine's wait and (fix266) the cut requests
  const routes = Object.fromEntries(r.slow.lastHour.map(x => [x.route, x]));
  assert.ok(routes['GET /api/stream']?.n >= 1, JSON.stringify(r.slow.lastHour));
  assert.equal(routes['GET /api/slow']?.crawler, 1, 'the search engine counted apart');
  // fix266: a cut request counts until its handler ended (1.5 s here): the visitor waited for that answer
  assert.ok(routes['GET /api/slow']?.n >= 4, `cut requests count their whole time: ${JSON.stringify(routes['GET /api/slow'])}`);
  assert.ok(r.slow.pendingSent >= 3 && r.slow.appPageSent === 1 && r.slow.lateServed >= 2);
});

test('data health "Slow requests": fails on a public request over 1 s in the last hour, search engines apart', () => {
  const r = run(`
    const { db } = require('${DIST}/db/index.js');
    const D = require('${DIST}/services/deadline.js');
    const m = Math.floor(Date.now() / 60000);
    const ok = D.slowRequestsHealth();
    db.prepare('INSERT INTO slow_requests (minute, route, n, max_ms, crawler) VALUES (?, ?, ?, ?, ?)').run(m - 5, 'GET /api/search', 3, 1800, 0);
    db.prepare('INSERT INTO slow_requests (minute, route, n, max_ms, crawler) VALUES (?, ?, ?, ?, ?)').run(m - 6, 'GET /fr/:page', 2, 2500, 2);
    db.prepare('INSERT INTO slow_requests (minute, route, n, max_ms, crawler) VALUES (?, ?, ?, ?, ?)').run(m - 90, 'GET /api/old', 9, 9000, 0);
    console.log('RESULT ' + JSON.stringify({ ok, bad: D.slowRequestsHealth() }));
    process.exit(0);
  `, env());
  assert.equal(r.ok.level, 'ok');
  assert.equal(r.bad.level, 'warn', 'fix276: 1–5 = yellow, red over 5 outside the warm-up');
  assert.match(r.bad.detail, /^3 public request/);
  assert.deepEqual(r.bad.items, ['GET /api/search: 3 × over 1 s, longest 1.8 s']);
});

test('game bundle: one answer, each part\'s byte range is that route\'s own answer', () => {
  const r = run(`
    const http = require('http');
    const srv = http.createServer((req, res) => {
      if (req.url.includes('/details')) return res.end(JSON.stringify({ data: { match: { id: 5, name: 'Ünïcode — ok' } } }));
      if (req.url.includes('/extras/')) return res.end(JSON.stringify({ data: { weather: null } }));
      if (req.url.includes('/season-forecast/')) { res.statusCode = 404; return res.end('{"error":"Not found"}'); }
      res.end(JSON.stringify({ data: [1, 2, 3], ua: req.headers['user-agent'] }));
    }).listen(0, async () => {
      process.env.PORT = String(srv.address().port);
      const G = require('${DIST}/services/gameBundle.js');
      const b = await G.buildBundle('football', 5, { 'user-agent': 'UA-X', cookie: 'sl=1' }, '1.2.3.4');
      const whole = JSON.parse(b.body.toString('utf8'));
      const parts = G.partsOf(b.parts).map(p => ({ path: p.path, json: JSON.parse(b.body.subarray(p.start, p.end).toString('utf8')) }));
      console.log('RESULT ' + JSON.stringify({ list: G.bundleParts('football', 5), tennis: G.bundleParts('tennis', -3), whole, parts, got: b.got }));
      process.exit(0);
    });
  `, env());
  assert.deepEqual(r.list, ['/api/matches/5/details', '/api/extras/football/game/5', '/api/season-forecast/football/game/5', '/api/more/football/5']);
  assert.deepEqual(r.tennis, ['/api/tennis/match/-3', '/api/extras/tennis/game/-3', '/api/more/tennis/-3']);
  assert.equal(r.got, 3);
  assert.equal(r.whole.data.parts['/api/season-forecast/football/game/5'], null, 'a 404 part is null (the route answers it itself)');
  assert.equal(r.whole.data.parts['/api/matches/5/details'].data.match.name, 'Ünïcode — ok');
  assert.equal(r.parts.length, 3);
  for (const p of r.parts) assert.deepEqual(p.json, r.whole.data.parts[p.path], `${p.path}: the byte range is the part`);
  assert.equal(r.whole.data.parts['/api/more/football/5'].ua, 'UA-X', 'asked with the visitor\'s headers');
});

test('a stored view over 2 MB is kept in parts and read back whole (synchronous and in the reader thread)', () => {
  const r = run(`
    const { db } = require('${DIST}/db/index.js');
    const P = require('${DIST}/services/pageCache.js');
    const R = require('${DIST}/services/pageReader.js');
    const big = 'x'.repeat(5 * 1024 * 1024 + 123) + 'é';
    let n = 0;
    P.definePage({ name: 'fix250-big', freshMs: 60000, build: () => ({ n: ++n }), variants: { full: () => JSON.stringify({ big, n }) } });
    (async () => {
      await P.storePage('fix250-big');
      await P.storePage('fix250-big'); // a second build: the first one's parts are gone
      const rows = db.prepare("SELECT key, length(json) AS len FROM page_cache WHERE key LIKE 'fix250-big#full%' ORDER BY key").all();
      P._forgetPageMemory();
      const s = await P.getPage('fix250-big');
      const sync = s.view('full').text;
      const thread = await R.readStored('fix250-big#full', s.builtAt);
      console.log('RESULT ' + JSON.stringify({ rows, syncOk: sync === JSON.stringify({ big, n: 2 }), threadOk: thread.text === sync, gz: !!s.view('full').gz }));
      process.exit(0);
    })();
  `, env());
  assert.equal(r.rows.length, 4, `marker + 3 parts of 2 MB: ${JSON.stringify(r.rows)}`);
  assert.ok(r.rows[0].len < 20, 'the main row is a marker');
  assert.ok(r.rows.slice(1).every(x => x.len <= 2 * 1024 * 1024));
  assert.ok(r.syncOk, 'synchronous read: whole');
  assert.ok(r.threadOk, 'reader thread: whole');
  assert.ok(r.gz, 'the gzip copy stays whole');
});

test('a read over 500 ms is logged with its SQL, its time in the thread and its size', () => {
  const r = run(`
    const R = require('${DIST}/services/pageReader.js');
    (async () => {
      await R.readSql('SELECT 1 AS one');
      await R.readSql("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 9000000) SELECT COUNT(*) AS n, 'abc' AS t FROM c");
      console.log('RESULT ' + JSON.stringify(R.pageReaderStatus()));
      process.exit(0);
    })();
  `, env({ READER_THREADS: '3' }));
  assert.equal(r.size, 3, 'READER_THREADS sets the pool');
  assert.ok(r.over500 >= 1, `a read over 500 ms (${JSON.stringify(r.slowest)})`);
  const s = r.slowLog[0];
  assert.match(s.what, /WITH RECURSIVE/);
  assert.ok(s.threadMs > 400 && s.kb === 0, JSON.stringify(s));
});
