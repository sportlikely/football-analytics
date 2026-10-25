// fix227: no 502 / 503 for the site's files during a restart — run: npm run test:fix227 (dist build, scratch database)
//  - the server (dist/boot.js, the container's entry: web process + its worker) is restarted twice, the way Railway does it with a
//    volume: the old process gets SIGTERM, the new one starts once the old one is gone
//  - meanwhile /, /assets/<app file>.js and /api/matches/upcoming are asked for every 100 ms for 60 s
//    (RESTART_TEST_MS to change it)
//  - every answer for / and the app file is a 200: 0 errors allowed; the API may answer 503 "Starting up" (the app
//    asks again: lib/startupRetry.ts), never another 5xx
//  - the gap with nothing listening (old gone → new listening) stays under 1.5 s each time: boot.js listens before
//    the app's modules load (Railway's proxy answers 502 only in that gap)
//  - a stored crawler page made for another build is never sent (its app file would be a 404): the plain app page instead
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '../dist');
const KEYS = ['FOOTBALL_DATA_API_KEY', 'ODDS_API_KEY', 'API_FOOTBALL_KEY', 'API_NFL_KEY', 'API_BASKETBALL_KEY', 'TENNIS_API_KEY', 'BALLDONTLIE_KEY', 'YOUTUBE_API_KEY', 'ANTHROPIC_API_KEY'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

/** a small built site: index.html naming its app file, the file itself, an icon */
function site() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix227-site-'));
  fs.mkdirSync(path.join(dir, 'assets'));
  const app = '/assets/index-Fix227abc.js';
  fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html><html lang="en"><head><title>SportLikely</title><meta name="description" content="x" /><link rel="canonical" href="https://sportlikely.com/" /><script type="module" crossorigin src="${app}"></script></head><body><div id="root"></div></body></html>`);
  fs.writeFileSync(path.join(dir, app), 'console.log("app")\n'.repeat(2000));
  fs.writeFileSync(path.join(dir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  return { dir, app };
}

const get = (port, p) => new Promise(res => {
  const req = http.get({ host: '127.0.0.1', port, path: p, agent: false, timeout: 15000 }, r => {
    let body = '';
    r.setEncoding('utf8');
    r.on('data', d => { body += d; });
    r.on('end', () => res({ status: r.statusCode, body }));
  });
  req.on('timeout', () => { req.destroy(); res({ status: 0, err: 'timeout' }); });
  req.on('error', e => res({ status: 0, err: e.code || String(e) }));
});

test('restart (fix227): the page and the app file never fail, the API only says "Starting up", the gap stays short', { timeout: 240000 }, async () => {
  const { dir: staticDir, app } = site();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix227-data-'));
  const port = await freePort();
  const e = { ...process.env, DATA_DIR: dataDir, STATIC_DIR: staticDir, PORT: String(port), LOG_LEVEL: 'error', NODE_ENV: 'production', GEO_OFF: '1' };
  for (const k of KEYS) e[k] = '';
  delete e.SL_ROLE; delete e.SITE_PASSWORD; delete e.WORKER;
  let out = '';
  const start = () => {
    const p = spawn(process.execPath, [path.join(DIST, 'boot.js')], { env: e, stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; });
    return p;
  };
  const listening = async (max = 30000) => { const t = Date.now(); while (Date.now() - t < max) { const r = await get(port, '/favicon.svg'); if (r.status) return true; await sleep(20); } return false; };

  let proc = start();
  assert.ok(await listening(), `never listened: ${out.slice(-800)}`);
  const WINDOW = Number(process.env.RESTART_TEST_MS || 60000);
  const tally = { page: {}, file: {}, api: {} };
  const bad = { page: [], file: [], api: [] };
  const gaps = [];
  let running = true;
  const poll = async (kind, p, okBody) => {
    while (running) {
      const t = Date.now();
      const r = await get(port, p);
      const key = r.status || r.err;
      tally[kind][key] = (tally[kind][key] || 0) + 1;
      // a refused connection is the gap with no process (counted in `gaps`); any answer must be right
      if (r.status && (kind === 'api' ? r.status >= 500 && !(r.status === 503 && /"ready":false/.test(r.body)) : r.status !== 200 || !okBody(r.body))) bad[kind].push(`${r.status} ${r.body.slice(0, 80)}`);
      if (r.err && r.err !== 'ECONNREFUSED' && r.err !== 'ECONNRESET') bad[kind].push(r.err);
      await sleep(Math.max(0, 100 - (Date.now() - t)));
    }
  };
  const pollers = [
    poll('page', '/', b => b.includes(app)),
    poll('file', app, b => b.startsWith('console.log')),
    poll('api', '/api/matches/upcoming', () => true)
  ];
  const t0 = Date.now();
  try {
    for (const at of [WINDOW / 3, (2 * WINDOW) / 3]) {
      await sleep(Math.max(0, t0 + at - Date.now()));
      // Railway with a volume: SIGTERM, wait until the old process is gone, then start the new one
      const exited = new Promise(r => proc.once('exit', r));
      proc.kill('SIGTERM');
      await exited;
      const gone = Date.now();
      proc = start();
      assert.ok(await listening(), `new process never listened: ${out.slice(-800)}`);
      gaps.push(Date.now() - gone);
    }
    await sleep(Math.max(0, t0 + WINDOW - Date.now()));
  } finally {
    running = false;
    await Promise.all(pollers);
    proc.kill('SIGTERM');
    await sleep(500);
    proc.kill('SIGKILL');
  }
  console.log('fix227 restart:', JSON.stringify({ tally, gaps }));
  assert.deepEqual(bad.page, [], `the page failed: ${bad.page.slice(0, 5).join(' | ')}`);
  assert.deepEqual(bad.file, [], `the app file failed: ${bad.file.slice(0, 5).join(' | ')}`);
  assert.deepEqual(bad.api, [], `the API answered another 5xx: ${bad.api.slice(0, 5).join(' | ')}`);
  for (const g of gaps) assert.ok(g < 1500, `${g} ms with nothing listening (target < 1.5 s)`);
  assert.ok((tally.page[200] || 0) > WINDOW / 400, `only ${tally.page[200] || 0} page answers`);
});

test('the files before the state (earlyStatic): app file, icons, the plain page; a missing app file is a 404, never the page; the build\'s app file name', () => {
  const { dir: staticDir, app } = site();
  const code = `
    const { serveEarly, currentMainScript, needsState } = require(${JSON.stringify(path.join(DIST, 'services/earlyStatic.js'))});
    const ask = (url, method = 'GET') => {
      let st = 0, body = ''; const h = {};
      const res = { setHeader: (k, v) => { h[k.toLowerCase()] = v; }, writeHead: (s, hh) => { st = s; for (const k in hh) h[k.toLowerCase()] = hh[k]; }, end: b => { body = b ? String(b) : ''; } };
      const done = serveEarly({ method, url }, res);
      return { done, st, cache: h['cache-control'], type: h['content-type'], body: body.slice(0, 60) };
    };
    console.log(JSON.stringify({ main: currentMainScript(), app: ask('${app}?r=1'), gone: ask('/assets/index-OLD.js'), page: ask('/es/basketball/game/1'),
      icon: ask('/favicon.svg'), api: ask('/api/matches/upcoming'), health: ask('/health'), post: ask('/', 'POST'), head: ask('/', 'HEAD'),
      up: ask('/../../etc/passwd'), states: [needsState('/api/x'), needsState('/socket.io/'), needsState('/health'), needsState('/assets/a.js')] }));`;
  const r = spawnSync(process.execPath, ['-e', code], { env: { ...process.env, STATIC_DIR: staticDir }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(o.main, app);
  assert.deepEqual([o.app.done, o.app.st, o.app.cache], [true, 200, 'public, max-age=31536000, immutable']);
  assert.ok(o.app.type.startsWith('application/javascript'));
  assert.deepEqual([o.gone.done, o.gone.st, o.gone.cache], [true, 404, 'no-store']);
  assert.deepEqual([o.page.done, o.page.st, o.page.cache], [true, 200, 'no-cache']);
  assert.ok(o.page.body.startsWith('<!doctype html>'));
  assert.deepEqual([o.icon.done, o.icon.st], [true, 200]);
  assert.equal(o.api.done, false);
  assert.equal(o.health.done, false);
  assert.equal(o.post.done, false);
  assert.deepEqual([o.head.done, o.head.st, o.head.body], [true, 200, '']);
  assert.ok(!(o.up.done && o.up.st === 200 && o.up.body.includes('root:')), 'a path outside the build was sent');
  assert.deepEqual(o.states, [true, true, true, false]);
});

// fix232: no empty lists after a deploy — every sport's list answers 200 from its stored copy during a model rebuild
//  - first start: the lists are built and stored; then a restart with a long "bb model" rebuild (SL_TEST_MODEL_MS)
//  - /api/basketball/games, /api/nfl/home, /api/tennis/home and /api/matches/upcoming are asked every second: after
//    "Starting up" no 5xx (never 503 "Loading"), each with X-SL-Built-At (the copy's build time)
//  - the model rebuild starts after the first round of page builds, and while it runs a list is rebuilt (newer
//    X-SL-Built-At) and a list never stored before is built in the page lane (200, not "Loading")
//  - /api/perf: the summary stays under 50 KB; ?full=1 has the stored pages, ?shared=1 the shared states
test('restart (fix232): every sport\'s list from its stored copy during a model rebuild; /api/perf summary under 50 KB', { timeout: 300000 }, async () => {
  const { dir: staticDir } = site();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix232-data-'));
  const port = await freePort();
  const MODEL_MS = 60000;
  const e = { ...process.env, DATA_DIR: dataDir, STATIC_DIR: staticDir, PORT: String(port), WORKER_PORT: String(port + 1), LOG_LEVEL: 'info', NODE_ENV: 'production', GEO_OFF: '1',
    BASKETBALL_PUBLIC: '1', NFL_PUBLIC: '1', TENNIS_PUBLIC: '1', API_READ_TOKEN: 'fix232-test', CANONICAL_HOST: '' };
  for (const k of KEYS) e[k] = '';
  delete e.SL_ROLE; delete e.SITE_PASSWORD; delete e.WORKER;
  let out = '';
  const start = env => {
    const p = spawn(process.execPath, [path.join(DIST, 'boot.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; });
    return p;
  };
  const ask = (p) => new Promise(res => {
    const req = http.get({ host: '127.0.0.1', port, path: p, agent: false, timeout: 20000 }, r => {
      let body = '';
      r.setEncoding('utf8');
      r.on('data', d => { body += d; });
      r.on('end', () => res({ status: r.statusCode, body, builtAt: r.headers['x-sl-built-at'] || null }));
    });
    req.on('timeout', () => { req.destroy(); res({ status: 0, err: 'timeout' }); });
    req.on('error', err => res({ status: 0, err: err.code || String(err) }));
  });
  const until = async (fn, ms) => { const t = Date.now(); for (;;) { const v = await fn(); if (v || Date.now() - t > ms) return v; await sleep(250); } };
  const LISTS = ['/api/basketball/games?days=7', '/api/nfl/home', '/api/tennis/home', '/api/matches/upcoming'];
  const perf = async (q = '') => { const r = await ask(`/api/perf?token=fix232-test${q}`); return { size: Buffer.byteLength(r.body || ''), data: r.status === 200 ? JSON.parse(r.body).data : null }; };

  // first start: every list stored once
  let proc = start(e);
  try {
    assert.ok(await until(async () => (await Promise.all(LISTS.map(ask))).every(r => r.status === 200 && r.builtAt), 120000), `the lists were never stored: ${out.slice(-1500)}`);
  } finally {
    const exited = new Promise(r => proc.once('exit', r));
    proc.kill('SIGTERM');
    await exited;
  }

  // restart with a long model rebuild
  out = '';
  proc = start({ ...e, SL_TEST_MODEL_MS: String(MODEL_MS) });
  const bad = [], seen = {};
  let running = true;
  const poll = async u => {
    while (running) {
      const r = await ask(u);
      if (r.status === 200) { if (!r.builtAt) bad.push(`${u}: 200 without X-SL-Built-At`); (seen[u] ||= new Set()).add(r.builtAt); }
      else if (r.status >= 500 && !(r.status === 503 && /"ready":false/.test(r.body))) bad.push(`${u}: ${r.status} ${String(r.body).slice(0, 80)}`);
      await sleep(1000); // (the visitor rate limit: 4 lists a second stay under it)
    }
  };
  const pollers = LISTS.map(poll);
  try {
    // the model rebuild runs — after the first round of page builds
    const during = await until(async () => { const p = await perf(); const h = p.data?.worker?.heavy; return h?.running === 'bb model' ? p : null; }, 150000);
    assert.ok(during, `the model rebuild never ran: ${out.slice(-1500)}`);
    assert.equal(during.data.worker.heavy.pages.firstRoundDone, true, 'the model rebuild started before the first round of page builds');
    assert.match(out, /stored pages: first round done/);
    // while it runs: a list is rebuilt (a newer copy than when the rebuild started) …
    const bbAt = (await ask(LISTS[0])).builtAt;
    const newer = await until(async () => { const r = await ask(LISTS[0]); return r.builtAt && r.builtAt > bbAt ? r : null; }, 30000);
    assert.ok(newer, 'no list was rebuilt while the model rebuild ran (the page builds waited behind it)');
    // … and a list never stored before is built in the page lane, not "Loading"
    const fresh = await ask('/api/basketball/games?league=NBA&days=10');
    assert.equal(fresh.status, 200, `a new list during the model rebuild: ${fresh.status} ${String(fresh.body).slice(0, 100)}`);
    assert.equal((await perf()).data.worker.heavy.running, 'bb model', 'the model rebuild ended too early for the check');
    // /api/perf: the summary is small; the detail and the shared states only when asked for
    const sum = await perf();
    assert.ok(sum.size < 50 * 1024, `/api/perf summary is ${Math.round(sum.size / 1024)} KB (target ≤ 50 KB)`);
    assert.equal(sum.data.summary, true);
    assert.ok(Array.isArray(sum.data.web.topStalls) && sum.data.web.jobs.length <= 30 && sum.data.web.memByJob.length <= 10);
    assert.ok(sum.data.worker.jobs.length <= 30 && sum.data.worker.topStalls.length <= 20);
    assert.equal(sum.data.pages, undefined);
    assert.equal(sum.data.shared, undefined);
    const full = await perf('&full=1');
    assert.ok(full.data && Array.isArray(full.data.pages?.lists) && full.data.pages.lists.some(p => p.key.startsWith('bb-games')), 'full=1 has no stored-page list');
    assert.ok(full.data.jobs && full.data.worker);
    const shared = await perf('&shared=1');
    assert.ok(shared.data && 'shared' in shared.data);
    // /api/perf is not a web stall
    assert.ok(!(sum.data.web.topStalls || []).some(s => /api\/perf/.test(s.job || '')), 'a /api/perf stall was counted');
  } finally {
    running = false;
    await Promise.all(pollers);
    proc.kill('SIGTERM');
    await sleep(500);
    proc.kill('SIGKILL');
  }
  console.log('fix232 restart:', JSON.stringify(Object.fromEntries(Object.entries(seen).map(([u, s]) => [u, s.size]))));
  assert.deepEqual(bad, [], `a list failed during the model rebuild: ${bad.slice(0, 5).join(' | ')}`);
  for (const u of LISTS) assert.ok(seen[u]?.size, `${u} never answered 200`);
});

test('the stored lists are never dropped by the weekly clean-up (fix232); on-demand pages are', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix232-clean-'));
  const code = `
    const { db } = require(${JSON.stringify(path.join(DIST, 'db/index.js'))});
    const pc = require(${JSON.stringify(path.join(DIST, 'services/pageCache.js'))});
    pc.definePage({ name: 'list-x', freshMs: 1000, warm: [{ days: 7 }], build: () => ({}) });
    pc.definePage({ name: 'game-x', freshMs: 1000, refresh: false, build: () => ({}) });
    const old = Date.now() - 9 * 86400000;
    const ins = db.prepare('INSERT INTO page_cache (key, json, built_at) VALUES (?, ?, ?)');
    for (const k of ['list-x?days=7', 'list-x?days=7#anon', 'list-x?days=3', 'game-x?id=1']) ins.run(k, '{}', old);
    pc.cleanPageCache();
    console.log(JSON.stringify(db.prepare('SELECT key FROM page_cache ORDER BY key').all().map(r => r.key)));`;
  const r = spawnSync(process.execPath, ['-e', code], { env: { ...process.env, DATA_DIR: dataDir, LOG_LEVEL: 'error', SL_ROLE: 'worker' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()), ['list-x?days=7', 'list-x?days=7#anon']);
});
