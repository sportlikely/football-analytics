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
