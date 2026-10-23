// fix202: the web process / worker split (dist build, scratch databases). Run: npm run test:fix202
//  - the web entry never loads the job modules (source and runtime)
//  - stored pages: a cold web process serves the stored copy at once; a missing one answers (null) without a worker;
//    one process (WORKER=0) builds in place and serves the old copy while it rebuilds
//  - model state: built and published in a worker-role process, read in a web-role process, same predictions
//    (basketball and NFL from made-up games)
//  - live games: the worker's rows are what the web process pushes
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, '../src'), DIST = path.join(here, '../dist').replace(/\\/g, '/');
const KEYS = ['FOOTBALL_DATA_API_KEY', 'ODDS_API_KEY', 'API_FOOTBALL_KEY', 'API_NFL_KEY', 'TENNIS_API_KEY', 'BALLDONTLIE_KEY', 'YOUTUBE_API_KEY', 'ANTHROPIC_API_KEY'];
// every child gets D (the dist folder) and done(x): print x as JSON and exit (timers of the services keep a process up)
const PRELUDE = `const D = ${JSON.stringify(DIST)};\nconst done = x => { console.log(JSON.stringify(x === undefined ? null : x)); process.exit(0); };\n`;

/** run `code` (CommonJS) in a fresh node with this role (null = one process) and database folder; returns what it passed to done() */
function child(role, dataDir, code, env = {}) {
  const e = { ...process.env, DATA_DIR: dataDir, LOG_LEVEL: 'error', NODE_ENV: 'production', GEO_OFF: '1', ...env };
  for (const k of KEYS) e[k] = '';
  if (role) e.SL_ROLE = role; else delete e.SL_ROLE;
  const r = spawnSync(process.execPath, ['-e', PRELUDE + code], { env: e, encoding: 'utf8', timeout: 180000 });
  if (r.status !== 0) throw new Error(`child (${role || 'all'}) failed (${r.status}): ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fix202-'));

test('the web entry never loads the job modules', () => {
  for (const f of ['index.ts', 'app.ts']) {
    const s = fs.readFileSync(path.join(SRC, f), 'utf8');
    assert.ok(!/^import[^;]*from '\.\/(jobs|worker)'/m.test(s), `${f} imports the jobs / worker module`);
    assert.ok(!/\bstart\w*Scheduler\(|startJobs\(|startPageWarmer\(/.test(s.replace("void import('./jobs').then(j => j.startJobs())", '')), `${f} starts a scheduler`);
  }
  // the only way the web entry reaches the jobs: WORKER=0, loaded after listen
  assert.match(fs.readFileSync(path.join(SRC, 'index.ts'), 'utf8'), /\} else \{\r?\n\s+\/\/ WORKER=0[^\n]*\n\s+void import\('\.\/jobs'\)/);
  assert.match(fs.readFileSync(path.join(SRC, 'worker.ts'), 'utf8'), /import \{ startJobs \} from '\.\/jobs';/);
  // at run time: the whole app loaded as the web process has no job module in memory
  const loaded = child('web', scratch(), `require(D + '/app.js'); done(Object.keys(require.cache).filter(k => /[\\\\/]dist[\\\\/](jobs|worker)\\.js$/.test(k)));`);
  assert.deepEqual(loaded, []);
});

test('stored pages: a cold web process serves the stored copy at once', () => {
  const dir = scratch();
  // the worker (here: a worker-role process without a parent) builds and stores two pages
  child('worker', dir, `
    const pc = require(D + '/services/pageCache.js');
    pc.definePage({ name: 't', freshMs: 60000, build: q => ({ data: 'built ' + q.n }), variants: { up: b => JSON.stringify(b).toUpperCase() } });
    Promise.all([pc.getPage('t', { n: 1 }), pc.getPage('t', { n: 2 })]).then(() => done(true));`);
  const r = child('web', dir, `
    const pc = require(D + '/services/pageCache.js');
    let built = 0;
    pc.definePage({ name: 't', freshMs: 60000, build: () => { built++; return { data: 'built in the web process' }; } });
    (async () => {
      const t0 = Date.now();
      const a = await pc.getPage('t', { n: 1 });
      const ms = Date.now() - t0;
      const missing = await pc.getPage('t', { n: 3 }); // never built: asks the worker (none here) and answers null
      done({ body: a.body, up: a.variant('up'), ms, built, missing });
    })();`, { PAGE_WAIT_MS: '300' });
  assert.deepEqual(r.body, { data: 'built 1' });
  assert.equal(r.up, '{"DATA":"BUILT 1"}');
  assert.ok(r.ms < 200, `the stored copy took ${r.ms} ms`);
  assert.equal(r.built, 0, 'the web process built a page');
  assert.equal(r.missing, null);
});

test('stored pages: one process (WORKER=0) builds in place, then serves the old copy while it rebuilds', () => {
  const r = child(null, scratch(), `
    const pc = require(D + '/services/pageCache.js');
    let n = 0;
    pc.definePage({ name: 'c', freshMs: 50, build: async () => { n++; await new Promise(r => setTimeout(r, 100)); return { n }; } });
    (async () => {
      const first = (await pc.getPage('c')).body.n;
      await new Promise(r => setTimeout(r, 80)); // now stale
      const t0 = Date.now();
      const stale = (await pc.getPage('c')).body.n;
      const ms = Date.now() - t0;
      await new Promise(r => setTimeout(r, 250));
      pc._forgetPageMemory(); // the next read comes from the table: the rebuilt copy
      const fresh = (await pc.getPage('c')).body.n;
      done({ first, stale, ms, fresh });
    })();`);
  assert.equal(r.first, 1);
  assert.equal(r.stale, 1);
  assert.ok(r.ms < 50, `a stale copy waited ${r.ms} ms`);
  assert.equal(r.fresh, 2);
});

test('model state: built in the worker, the same predictions in the web process (basketball, NFL)', () => {
  const dir = scratch();
  // made-up leagues: 2 basketball seasons + upcoming games, 3 NFL seasons + upcoming games
  child('worker', dir, `
    const { db } = require(D + '/db/index.js');
    require(D + '/services/basketball.js'); require(D + '/services/nfl.js');
    let seed = 202;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const now = Date.now(), DAY = 86400000, iso = t => new Date(t).toISOString();
    const bb = db.prepare("INSERT INTO bb_games (game_id, code, league_id, season, kickoff, status, home_id, home_name, away_id, away_name, hs, as_, updated_at) VALUES (?, 'NBA', 12, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const nfl = db.prepare("INSERT INTO nfl_games (game_id, league, season, week, stage, kickoff, home_id, home_name, away_id, away_name, status, home_pts, away_pts, venue, updated_at) VALUES (?, 1, ?, ?, 'Regular Season', ?, ?, ?, ?, ?, ?, ?, ?, 'Stadium', ?)");
    db.exec('BEGIN');
    let id = 1;
    for (let k = 0; k < 700; k++) {
      const t = now - (700 - k) * 1.2 * DAY, h = 1 + Math.floor(rnd() * 16); let a = 1 + Math.floor(rnd() * 16); if (a === h) a = (a % 16) + 1;
      bb.run(id++, k < 350 ? '2024-2025' : '2025-2026', iso(t), 'FT', h, 'Team ' + h, a, 'Team ' + a, 90 + Math.floor(rnd() * 40) + (h % 5), 90 + Math.floor(rnd() * 40), iso(t));
    }
    for (let k = 0; k < 20; k++) { const h = 1 + (k % 16), a = 1 + ((k + 5) % 16); bb.run(id++, '2025-2026', iso(now + (k + 1) * DAY / 2), 'NS', h, 'Team ' + h, a, 'Team ' + a, null, null, iso(now)); }
    let g = 1;
    for (let k = 0; k < 300; k++) {
      const t = now - (300 - k) * 3 * DAY, h = 1 + Math.floor(rnd() * 12); let a = 1 + Math.floor(rnd() * 12); if (a === h) a = (a % 12) + 1;
      nfl.run(g++, 2023 + Math.floor(k / 100), String(1 + (k % 17)), iso(t), h, 'Club ' + h, a, 'Club ' + a, 'FT', 14 + Math.floor(rnd() * 21) + (h % 4), 14 + Math.floor(rnd() * 21), iso(t));
    }
    for (let k = 0; k < 10; k++) nfl.run(g++, 2025, '18', iso(now + (k + 1) * DAY), 1 + k, 'Club ' + (1 + k), 12 - k, 'Club ' + (12 - k), 'NS', null, null, iso(now));
    db.exec('COMMIT');
    const bbm = require(D + '/services/bbModel.js'), nm = require(D + '/services/nflModel.js');
    (async () => { await bbm.buildAll(['NBA'], true); await nm.rebuildLive(1); done(true); })();`);
  const predict = (load) => `
    const { db } = require(D + '/db/index.js');
    const bbm = require(D + '/services/bbModel.js'), nm = require(D + '/services/nflModel.js'), shared = require(D + '/services/shared.js');
    (async () => {
      ${load}
      for (let i = 0; i < 50 && !nm.predictNfl(301); i++) await new Promise(r => setTimeout(r, 100)); // the NFL join is async
      const games = db.prepare("SELECT game_id, code, season, kickoff, status, home_id, away_id, hs, as_, home_name, away_name FROM bb_games WHERE status = 'NS' ORDER BY game_id").all();
      const r6 = x => Math.round(x * 1e6) / 1e6;
      const bb = games.map(g => { const p = bbm.predictGame(g); return p && [r6(p.pHome), r6(p.margin), r6(p.total)]; });
      const nfl = [301, 302, 303, 304, 305].map(id => { const p = nm.predictNfl(id); return p && [p.pHome, p.margin, p.total]; });
      done({ bb, nfl });
    })();`;
  // the worker's own numbers (its memory) against the web process's (the published state)
  const fromWorker = child('worker', dir, predict("await bbm.buildAll(['NBA'], true); await nm.rebuildLive(1);"));
  const fromWeb = child('web', dir, predict('await shared.loadNewerStates();'));
  assert.equal(fromWorker.bb.filter(Boolean).length, 20, 'basketball predictions in the worker');
  assert.equal(fromWorker.nfl.filter(Boolean).length, 5, 'NFL predictions in the worker');
  assert.deepEqual(fromWeb, fromWorker);
});

test('the real pair: the web process answers at once, admin requests go to the worker, the worker leaves with it', async () => {
  const port = 39000 + Math.floor(Math.random() * 500);
  const env = { ...process.env, DATA_DIR: scratch(), PORT: String(port), WORKER_PORT: String(port + 1), API_READ_TOKEN: 'split-test', LOG_LEVEL: 'error', NODE_ENV: 'production', GEO_OFF: '1', CANONICAL_HOST: '', WORKER: '' };
  for (const k of KEYS) env[k] = '';
  delete env.SL_ROLE;
  const { spawn } = await import('node:child_process');
  const web = spawn(process.execPath, [path.join(here, '../dist/index.js')], { env, stdio: 'ignore' });
  const get = async (p, base = `http://127.0.0.1:${port}`) => { try { const r = await fetch(base + p); return { status: r.status, text: await r.text() }; } catch { return { status: 0, text: '' }; } };
  const until = async (fn, ms) => { const t = Date.now(); for (;;) { const v = await fn(); if (v || Date.now() - t > ms) return v; await new Promise(r => setTimeout(r, 200)); } };
  try {
    const t0 = Date.now();
    assert.ok(await until(async () => (await get('/api/health')).status === 200, 20000), 'the web process never answered');
    const upMs = Date.now() - t0;
    // a maintenance-token read outside the public API is answered by the worker's copy of the app
    const fwd = await until(async () => { const r = await get('/api/history/status?token=split-test'); return r.status === 200 ? r : null; }, 60000);
    assert.ok(fwd, 'the forwarded request never got an answer from the worker');
    assert.ok(JSON.parse(fwd.text).data !== undefined);
    // the worker's port answers only the web process
    assert.equal((await get('/api/health', `http://127.0.0.1:${port + 1}`)).status, 403);
    // /api/perf (web) reports the worker
    const perf = JSON.parse((await get('/api/perf?token=split-test')).text).data;
    assert.equal(perf.process, 'web');
    assert.equal(perf.worker.on, true);
    assert.ok(upMs < 15000, `the web process took ${upMs} ms to answer`);
  } finally {
    web.kill('SIGKILL');
  }
  // the worker goes when the web process goes
  assert.ok(await until(async () => (await get('/api/health', `http://127.0.0.1:${port + 1}`)).status === 0, 15000), 'the worker outlived the web process');
});

test('live games: the web process pushes what the worker wrote', () => {
  const dir = scratch();
  child('worker', dir, `
    const ls = require(D + '/services/liveState.js');
    ls.writeLive('football', [{ id: 7, score: '1-0', minute: 12 }, { id: 9, score: '0-0', minute: 3 }]);
    ls.writeLive('football', [{ id: 9, score: '0-1', minute: 4 }, { id: 7, score: '1-0', minute: 12 }]);
    done(true);`);
  const r = child('web', dir, `
    const ls = require(D + '/services/liveState.js');
    ls.loadLiveRows();
    done(ls.liveList('football').sort((a, b) => a.id - b.id));`);
  assert.deepEqual(r, [{ id: 7, score: '1-0', minute: 12 }, { id: 9, score: '0-1', minute: 4 }]);
});
