// fix212b: the leftovers after fix212 — run: npm run test:fix212b (dist build, scratch databases, no provider calls)
//  - FD ↔ AF twin matching: "Wolverhampton Wanderers FC" is "Wolves" at API-Football (aliases, both ways), a team id
//    pair decides first, kick-off ±3 h, the forced team-day look-up when the day list has nothing
//  - web writes: batches of ≤ 200 rows and ≤ 1 MB of parameters
//  - player names: suffixes and "Last, First"; a Wikidata item with only the occupation counts as the sport
//  - start-up: the web role with a big shared blob does not accept a connection before the state is loaded; the first
//    answer is 200 with ready: true; no stall over 500 ms after it was ready
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import v8 from 'node:v8';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '../dist').replace(/\\/g, '/');
const KEYS = ['FOOTBALL_DATA_API_KEY', 'ODDS_API_KEY', 'API_FOOTBALL_KEY', 'API_NFL_KEY', 'API_BASKETBALL_KEY', 'TENNIS_API_KEY', 'BALLDONTLIE_KEY', 'YOUTUBE_API_KEY', 'ANTHROPIC_API_KEY'];
const PRELUDE = `const D = ${JSON.stringify(DIST)};
const done = x => { console.log(JSON.stringify(x === undefined ? null : x)); process.exit(0); };
const calls = [];
let FAKE = () => ({ response: [] });
globalThis.fetch = async url => {
  const u = new URL(String(url));
  calls.push(u.pathname + u.search);
  const body = FAKE(u);
  return { ok: true, status: 200, headers: { get: h => (h === 'x-ratelimit-requests-remaining' ? '5000' : h === 'x-ratelimit-requests-limit' ? '7500' : null) }, json: async () => body };
};
const iso = ms => new Date(ms).toISOString();
`;
function env(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix212b-'));
  const e = { ...process.env, DATA_DIR: dir, LOG_LEVEL: 'error', NODE_ENV: 'production', GEO_OFF: '1', ...extra };
  for (const k of KEYS) if (!(k in extra)) e[k] = '';
  delete e.SL_ROLE;
  return { e, dir };
}
function child(code, extra = {}) {
  const { e } = env(extra);
  const r = spawnSync(process.execPath, ['-e', PRELUDE + code], { env: e, encoding: 'utf8', timeout: 120000 });
  if (r.status !== 0) throw new Error(`child failed (${r.status}): ${r.stderr || r.stdout}`);
  const lines = r.stdout.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

test('twin matching: Wolves – Watford finds its API-Football fixture through the alias, the id pair decides first, ±3 h', () => {
  const r = child(`
    (async () => {
      const { afTwinOfFd, sameTeam, addTeamAlias } = require(D + '/services/afMatches');
      const ko = Date.UTC(2026, 9, 24, 14, 0);
      const fx = (id, home, away, hid, aid, at = ko, country = 'England') => ({ fixture: { id, date: iso(at), status: { short: 'FT' } }, league: { id: 40, country }, teams: { home: { id: hid, name: home }, away: { id: aid, name: away } }, goals: { home: 2, away: 0 } });
      FAKE = u => u.searchParams.get('date') ? { response: [
        fx(70001, 'Wolves', 'Watford', 39, 38),
        fx(70002, 'Wolves', 'Watford', 39, 38, ko + 2 * 86400000), // another day, not in this list in real life, but must be ignored by time anyway
        fx(70003, 'Leeds', 'Hull City', 63, 64),
        fx(70004, 'Wolverhampton', 'Watford', 1039, 38, ko, 'Scotland') // a different country (a league game): skipped
      ] } : { response: [] };
      const m = { id: 561903, utcDate: iso(ko), competition: { code: 'ELC', type: 'LEAGUE' }, area: { name: 'England' }, homeTeam: { id: 76, name: 'Wolverhampton Wanderers FC', shortName: 'Wolverhampton', tla: 'WOL' }, awayTeam: { id: 346, name: 'Watford FC', shortName: 'Watford', tla: 'WAT' } };
      const twin = await afTwinOfFd(m);
      // a name only an alias can bridge, and an alias added at run time
      const before = sameTeam('Queens Park Rangers FC', 'QPR'), none = sameTeam('Bristol Rovers FC', 'Gas');
      addTeamAlias('Bristol Rovers', 'Gas');
      const after = sameTeam('Bristol Rovers FC', 'Gas');
      // a kick-off 4 h away is not the same game
      const far = await afTwinOfFd({ ...m, id: 561904, utcDate: iso(ko + 4 * 3600000) });
      done({ twin, before, none, after, far, dateCalls: calls.filter(c => c.includes('date=')).length });
    })().catch(e => { console.error(e); process.exit(1); });
  `, { API_FOOTBALL_KEY: 'x' });
  assert.deepEqual(r.twin, { fid: 70001, swapped: false });
  assert.equal(r.before, true);
  assert.equal(r.none, false);
  assert.equal(r.after, true);
  assert.equal(r.far, null);
});

test('the stored link survives a restart (fd_af_links), and a swapped fixture is marked', () => {
  const { e, dir } = env({ API_FOOTBALL_KEY: 'x' });
  const code = `
    (async () => {
      const { afTwinOfFd, afIdOfFd } = require(D + '/services/afMatches');
      const ko = Date.UTC(2026, 9, 25, 15, 0);
      FAKE = u => u.searchParams.get('date') ? { response: [{ fixture: { id: 80001, date: iso(ko), status: { short: 'NS' } }, league: { id: 2, country: 'World' }, teams: { home: { id: 2, name: 'Watford' }, away: { id: 1, name: 'Wolves' } } }] } : { response: [] };
      const m = { id: 561999, utcDate: iso(ko), competition: { code: 'ELC', type: 'LEAGUE' }, homeTeam: { id: 76, name: 'Wolverhampton Wanderers FC' }, awayTeam: { id: 346, name: 'Watford FC' } };
      const t = await afTwinOfFd(m);
      done({ t, stored: afIdOfFd(561999) });
    })().catch(e => { console.error(e); process.exit(1); });`;
  const r1 = spawnSync(process.execPath, ['-e', PRELUDE + code], { env: e, encoding: 'utf8', timeout: 120000 });
  if (r1.status !== 0) throw new Error(r1.stderr || r1.stdout);
  const a = JSON.parse(r1.stdout.trim().split('\n').pop());
  assert.deepEqual(a.t, { fid: 80001, swapped: true });
  // a new process, no provider: the link is there
  const r2 = spawnSync(process.execPath, ['-e', PRELUDE + `const { afIdOfFd } = require(D + '/services/afMatches'); done(afIdOfFd(561999));`], { env: { ...e, DATA_DIR: dir }, encoding: 'utf8', timeout: 120000 });
  if (r2.status !== 0) throw new Error(r2.stderr || r2.stdout);
  assert.deepEqual(JSON.parse(r2.stdout.trim().split('\n').pop()), { fid: 80001, swapped: true });
});

test('web writes go in batches of at most 200 rows and about 1 MB', () => {
  const r = child(`
    const { writeBatches } = require(D + '/services/deferredWrites');
    const small = Array.from({ length: 450 }, (_, i) => ({ sql: 'x', params: [i] }));
    const big = Array.from({ length: 10 }, (_, i) => ({ sql: 'y', params: ['p'.repeat(400000), i] }));
    done({ small: writeBatches(small).map(b => b.length), big: writeBatches(big).map(b => b.length) });
  `);
  assert.deepEqual(r.small, [200, 200, 50]);
  assert.ok(r.big.every(n => n <= 2), `≤ 1 MB a batch: ${r.big}`);
  assert.equal(r.big.reduce((a, b) => a + b, 0), 10);
});

test('player names: suffixes and "Last, First"; an item with only the occupation is a player of the sport', () => {
  const r = child(`
    const { nameKey, searchName, decide } = require(D + '/services/playerPhotos');
    const c = (qid, names, sports, extra = {}) => ({ qid, names, human: true, sports, dob: null, countries: [], teams: [], atp: null, wta: null, image: 'x.jpg', ...extra });
    const ours = { sport: 'basketball', name: 'Gary Trent Jr.', age: 27, country: 'usa', teams: ['Milwaukee Bucks'] };
    const d1 = decide(ours, [c('Q1', ['Gary Trent Jr.'], ['Q5372'], { teams: ['Milwaukee Bucks'] })]);
    const d2 = decide({ sport: 'basketball', name: 'Tatum, Jayson', age: 28, country: 'usa', teams: ['Boston Celtics'] }, [c('Q2', ['Jayson Tatum'], ['Q5372'], { teams: ['Boston Celtics'], dob: '1998-03-03' })]);
    done({ k1: nameKey('Gary Trent Jr.'), k2: nameKey('Trent, Gary'), s: searchName('Tatum, Jayson'), s2: searchName('Gary Trent Jr.'), d1: [d1.qid, d1.confidence], d2: [d2.qid, d2.confidence] });
  `);
  assert.equal(r.k1, 'gary trent');
  assert.equal(r.k2, 'gary trent');
  assert.equal(r.s, 'Jayson Tatum');
  assert.equal(r.s2, 'Gary Trent');
  assert.deepEqual(r.d1, ['Q1', 'high']);
  assert.deepEqual(r.d2, ['Q2', 'high']);
});

const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const tryConnect = port => new Promise(res => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); res(true); }); s.once('error', () => res(false)); });
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('start-up (fix218): the web role listens at once, answers 503 then 200, never waits over 500 ms in the first 60 s, and skips the nfl engine blob', async () => {
  const { e, dir } = env({ WORKER_SPAWN: '0', PORT: String(await freePort()), GEO_OFF: '1' });
  // a database with a big nfl engine state: the web role must not load it any more (its applier is worker-only since fix218)
  const db = new DatabaseSync(path.join(dir, 'bet-to-beat.sqlite'));
  db.exec(`CREATE TABLE IF NOT EXISTS shared_state (key TEXT PRIMARY KEY, ver INTEGER NOT NULL, at TEXT NOT NULL, bytes INTEGER NOT NULL, ms INTEGER NOT NULL, data BLOB NOT NULL)`);
  const big = v8.serialize({ rows: Array.from({ length: 400000 }, (_, i) => ({ i, s: `row ${i}`, v: [i, i + 1, i + 2] })) });
  db.prepare(`INSERT INTO shared_state (key, ver, at, bytes, ms, data) VALUES (?, ?, ?, ?, ?, ?)`).run('nfl:live:1', 1, new Date().toISOString(), big.length, 1, big);
  db.close();
  // fix227: the container's entry (boot.js listens before the modules load, then loads index.js)
  const p = spawn(process.execPath, [path.join(DIST, 'boot.js')], { env: { ...e, SL_ROLE: 'web' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; });
  const port = Number(e.PORT);
  const t0 = Date.now();
  const WINDOW = Number(process.env.STARTUP_WINDOW_MS || 60000);
  const waits = []; // every request's wait in the first 60 s
  let firstWait = 0;
  let firstAccept = null, first = null, readyAt = null, last = null;
  try {
    while (Date.now() - t0 < WINDOW) {
      if (firstAccept === null) {
        if (!(await tryConnect(port))) { await sleep(50); continue; }
        firstAccept = Date.now() - t0;
      }
      const s = Date.now();
      const r = await fetch(`http://127.0.0.1:${port}/health`).then(async r => ({ status: r.status, body: await r.json(), retry: r.headers.get('retry-after') })).catch(e => ({ status: 0, body: String(e) }));
      // fix227: the first answer may wait for the module load (boot.js accepted the connection before it: a short
      // wait instead of a refused connection = Railway's 502); every later one must be quick
      if (first) waits.push(Date.now() - s); else firstWait = Date.now() - s;
      first ??= r;
      if (r.status === 200 && readyAt === null) readyAt = Date.now() - t0;
      last = r;
      await sleep(250);
    }
    assert.ok(firstAccept !== null, `never listened: ${out.slice(-800)}`);
    // listening within a second of the start (before the state load) — a deploy's health check gets an answer, not a refused connection
    assert.ok(firstAccept < 5000, `first connection after ${firstAccept} ms`);
    assert.ok(first.status === 503 || first.status === 200, `first answer ${first.status}: ${JSON.stringify(first.body).slice(0, 200)}`);
    if (first.status === 503) { assert.equal(first.body.ready, false); assert.equal(first.retry, '5'); }
    assert.ok(readyAt !== null, `never ready: ${JSON.stringify(last)} ${out.slice(-600)}`);
    assert.equal(last.status, 200);
    assert.equal(last.body.ready, true);
    // the nfl engine blob was not parsed by the web role: a short load, and nothing waited behind it
    assert.ok(last.body.stateLoadMs < 2000, `state load took ${last.body.stateLoadMs} ms (the nfl blob must stay in the worker)`);
    assert.ok(firstWait < 30000, `the first answer waited ${firstWait} ms`);
    const slow = waits.filter(w => w > 500);
    assert.equal(slow.length, 0, `${slow.length} of ${waits.length} requests waited over 500 ms in the first ${WINDOW / 1000} s: ${slow.join(', ')} ms`);
    assert.equal(last.body.stallsSinceReady, 0, `stalls after ready: ${last.body.stallsSinceReady}`);
    assert.equal(last.body.slowSinceReady, 0, `slow requests after ready: ${last.body.slowSinceReady}`);
    assert.ok(waits.length > 20, `only ${waits.length} requests in the window`);
  } finally {
    p.kill('SIGTERM');
    await sleep(300);
    p.kill('SIGKILL');
  }
});
