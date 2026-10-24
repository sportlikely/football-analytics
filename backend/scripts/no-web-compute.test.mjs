// fix210: the web process never builds a page. Run: npm run test:fix210 (after tsc)
//  - every public GET route (PUBLIC_ROUTES in services/workerRoutes.ts, kept complete by `npm run parity`) and the
//    crawler pages of every sport and language are opened in a real web-role process (no worker) with SL_STRICT_WEB=1:
//    a page builder called there throws, and every database statement is timed
//  - fails when a builder ran, a handler took over 50 ms (second request, so module loading is not counted), or a
//    worker route was answered by the web process instead of being passed on (no worker here: 503)
//  - uses a copy of the newest database snapshot in backend/data (sportlikely-*.sqlite) when there is one, else an
//    empty database
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '../dist').replace(/\\/g, '/');
const DATA = path.join(here, '../data');
const KEYS = ['FOOTBALL_DATA_API_KEY', 'ODDS_API_KEY', 'API_FOOTBALL_KEY', 'API_NFL_KEY', 'TENNIS_API_KEY', 'BALLDONTLIE_KEY', 'YOUTUBE_API_KEY', 'ANTHROPIC_API_KEY', 'API_BASKETBALL_KEY'];
const LIMIT_MS = 50;

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix210-'));
  const snap = fs.existsSync(DATA) ? fs.readdirSync(DATA).filter(f => /^sportlikely-.*\.sqlite$/.test(f)).sort().pop() : null;
  if (snap) fs.copyFileSync(path.join(DATA, snap), path.join(dir, 'bet-to-beat.sqlite'));
  const stat = path.join(dir, 'static');
  fs.mkdirSync(stat);
  fs.writeFileSync(path.join(stat, 'index.html'), '<!doctype html><html><head><title>SportLikely</title></head><body><div id="root"></div></body></html>');
  return { dir, stat, snap };
}

// the child: the whole app as the web process, every sample twice, the second one timed
const CHILD = `
const D = ${JSON.stringify(DIST)};
const { db } = require(D + '/db/index.js');
// the database timer: every statement's run / get / all, added to the request in flight
let dbMs = 0;
const prep = db.prepare.bind(db);
db.prepare = sql => {
  const st = prep(sql);
  const wrap = f => (...a) => { const t = process.hrtime.bigint(); try { return f(...a); } finally { dbMs += Number(process.hrtime.bigint() - t) / 1e6; } };
  return { run: wrap(st.run.bind(st)), get: wrap(st.get.bind(st)), all: wrap(st.all.bind(st)), iterate: st.iterate && st.iterate.bind(st) };
};
const { app } = require(D + '/app.js');
const { webBuilds } = require(D + '/services/builders.js');
const { PUBLIC_ROUTES, PAGE_SAMPLES, workerRouteOf } = require(D + '/services/workerRoutes.js');
const role = require(D + '/services/role.js');
const server = app.listen(0, '127.0.0.1', async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  const builds = () => Object.values(webBuilds()).reduce((n, c) => n + c.n, 0);
  const open = async url => {
    const b0 = builds(); dbMs = 0;
    const t0 = process.hrtime.bigint();
    const r = await fetch(base + url, { headers: { 'User-Agent': 'Mozilla/5.0 (fix210 test)', Accept: 'application/json,text/html' } });
    await r.arrayBuffer();
    return { status: r.status, ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e6), dbMs: Math.round(dbMs), built: builds() - b0 };
  };
  const out = [];
  const samples = [...PUBLIC_ROUTES.map(r => ({ url: r.sample, by: r.by, sport: r.sport })), ...PAGE_SAMPLES.map(url => ({ url, by: 'page', sport: 'all' }))];
  for (const s of samples) {
    const first = await open(s.url);
    const second = await open(s.url);
    out.push({ ...s, onWorker: !!workerRouteOf(s.url.split('?')[0]), first, second });
  }
  console.log(JSON.stringify({ isWeb: role.isWeb, builds: webBuilds(), out }));
  process.exit(0);
});
`;

test('the web process builds nothing: every public route and crawler page', () => {
  const { dir, stat, snap } = scratch();
  const env = { ...process.env, DATA_DIR: dir, STATIC_DIR: stat, SL_ROLE: 'web', SL_STRICT_WEB: '1', PAGE_WAIT_MS: '1', SEO_WAIT_MS: '1', LOG_LEVEL: 'error', NODE_ENV: 'production', GEO_OFF: '1', BASKETBALL_PUBLIC: '1', NFL_PUBLIC: '1', TENNIS_PUBLIC: '1' };
  for (const k of KEYS) env[k] = '';
  const r = spawnSync(process.execPath, ['-e', CHILD], { env, encoding: 'utf8', timeout: 300000 });
  assert.equal(r.status, 0, `child failed: ${r.stderr || r.stdout}`);
  const res = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(res.isWeb, true, 'the child is not a web process');
  const bad = [];
  for (const x of res.out) {
    if (x.first.built || x.second.built) bad.push(`${x.url}: a page builder ran in the web process`);
    if (x.second.ms > LIMIT_MS) bad.push(`${x.url}: ${x.second.ms} ms (database ${x.second.dbMs} ms) — over ${LIMIT_MS} ms`);
    if (x.by === 'worker' && x.second.status !== 503) bad.push(`${x.url}: answered ${x.second.status} by the web process (a worker route: it must be passed on)`);
    if (x.by !== 'worker' && x.onWorker) bad.push(`${x.url}: listed as ${x.by} but matched by WORKER_ROUTES`);
  }
  const slowest = [...res.out].sort((a, b) => b.second.ms - a.second.ms).slice(0, 5).map(x => `${x.url} ${x.second.ms} ms`);
  console.log(`no-web-compute: ${res.out.length} URLs on ${snap ? `a copy of ${snap}` : 'an empty database'}; slowest: ${slowest.join(', ')}`);
  assert.deepEqual(bad, [], `\n${bad.join('\n')}\nbuilders called: ${JSON.stringify(res.builds)}`);
  assert.deepEqual(res.builds, {});
});

test('the real pair: a worker route is answered by the worker, then served from the signed-out copy; a worker crash is recorded', async () => {
  const port = 41000 + Math.floor(Math.random() * 500);
  const { dir } = scratch();
  const env = { ...process.env, DATA_DIR: dir, PORT: String(port), WORKER_PORT: String(port + 1), API_READ_TOKEN: 'fix210-test', LOG_LEVEL: 'error', NODE_ENV: 'production', GEO_OFF: '1', CANONICAL_HOST: '', WORKER: '', SL_STRICT_WEB: '1' };
  for (const k of KEYS) env[k] = '';
  delete env.SL_ROLE;
  const { spawn } = await import('node:child_process');
  const web = spawn(process.execPath, [path.join(here, '../dist/index.js')], { env, stdio: 'ignore' });
  const get = async p => { try { const r = await fetch(`http://127.0.0.1:${port}${p}`); return { status: r.status, copy: r.headers.get('x-sl-copy'), text: await r.text() }; } catch { return { status: 0, copy: null, text: '' }; } };
  const until = async (fn, ms) => { const t = Date.now(); for (;;) { const v = await fn(); if (v || Date.now() - t > ms) return v; await new Promise(r => setTimeout(r, 250)); } };
  const perf = async () => JSON.parse((await get('/api/perf?token=fix210-test')).text).data;
  try {
    assert.ok(await until(async () => (await get('/api/health')).status === 200, 20000), 'the web process never answered');
    assert.ok(await until(async () => (await perf()).worker.on, 30000), 'the worker never started');
    // first request: built by the worker (passed on), kept; second: the kept copy, from the web process
    const first = await until(async () => { const r = await get('/api/how-it-works/football'); return r.status === 200 ? r : null; }, 60000);
    assert.ok(first, 'the worker never answered the worker route');
    assert.equal(first.copy, 'new');
    const second = await get('/api/how-it-works/football');
    assert.equal(second.status, 200);
    assert.equal(second.copy, 'fresh');
    assert.equal(second.text, first.text);
    const p = await perf();
    assert.deepEqual(p.webBuilds, {}, 'the web process built a page');
    assert.ok(p.workerRoutes.forwarded >= 1 && p.workerRoutes.served >= 1);
    assert.ok(p.memory.worker.heapMb > 0 && Array.isArray(p.hours));
    // the worker dies: the exit is recorded with a reason and it comes back after 5 s
    const pid = p.worker.pid;
    process.kill(pid, 'SIGKILL');
    const back = await until(async () => { const q = await perf(); return q.worker.on && q.worker.pid !== pid ? q : null; }, 30000);
    assert.ok(back, 'the worker did not come back');
    assert.equal(back.worker.restarts, 1);
    assert.equal(back.worker.restarts24h, 1);
    assert.ok(back.worker.lastExit?.reason, 'no exit reason');
    assert.ok(Array.isArray(back.worker.lastExit.stderr));
  } finally {
    web.kill('SIGKILL');
  }
});
