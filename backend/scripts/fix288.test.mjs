// fix288: (1) bb-v4 rows — the training range measured on the games where a row is in play (the zeros of #8 after game
// 25, of #4 with nobody missing, of #13 without meetings made the spread 2–3× too small), every row held at ± 3 sd of it
// before it enters the points unless that clip made the training games worse (clipGate), the clip on the data-health card;
// #8 of an unchanged roster early in a season and #13 of 5 old meetings inside their range (seeded replay); /api/bb/check30.
// (2) the sitemaps: a stored 'xml' view made by the worker (ETag + gzip), the web process only sends it (never the page's
// body: a synchronous read + JSON.parse stalled the web 1,377 ms), rebuilt after every slugs run.
// (dist build) Run: npm run test:fix288
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix288-'));
process.env.DATA_DIR = DIR;
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'error';
process.env.THREAD_JOBS = '0';
process.env.BB_GRID = 'on';
const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const read = f => fs.readFileSync(path.join(here, '..', f), 'utf8').replace(/\r\n/g, '\n');
const M = require('../dist/utils/bbGridMath.js');
const { db } = require('../dist/db/index.js');
require('../dist/services/basketball.js');
require('../dist/services/nbaV4.js');
const G = require('../dist/services/bbGrid.js');
const T = require('../dist/services/bbTuner.js');

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const gauss = r => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
const row = (i, d, n = M.N_ROWS) => { const hv = new Array(n).fill(0), av = new Array(n).fill(0); hv[i] = d; return { hv, av }; };

/* ---------- (1) the clip ---------- */

test('fix288: a row value over 3 sd of its in-play range is clipped before it enters the points; flags never', () => {
  // #9 in play on every game (sd 1), #8 in play on 1 game in 4 (the rest 0): the in-play spread, not the diluted one
  const items = [];
  for (let k = 0; k < 400; k++) { const it = row(8, k % 2 ? 1 : -1); it.hv[7] = k % 4 === 0 ? (k % 8 ? 3 : -3) : 0; it.hv[5] = k % 3 ? 0 : -1; items.push(it); }
  const all = M.rowStats(items), range = M.rangeStats(items);
  assert.ok(Math.abs(range.sd[7] - 3) < 1e-6 && all.sd[7] < 1.6, `#8 in-play sd ${range.sd[7]} vs all games ${all.sd[7]}`);
  assert.equal(range.n[7], 100);
  assert.equal(range.sd[5], 0, '#6 rest is a flag: no range');
  const clip = M.clipOf(range);
  assert.equal(clip.hi[8], 3); assert.equal(clip.lo[8], -3);
  assert.equal(clip.lo[5], null, 'flags are never clipped'); assert.equal(clip.lo[10], null);
  assert.equal(M.clipTo(10, clip, 8), 3); assert.equal(M.clipTo(-10, clip, 8), -3); assert.equal(M.clipTo(2.5, clip, 8), 2.5);
  assert.equal(M.clipTo(0, clip, 7), 0, 'a row that is off stays off');
  // the points: #9 at 10 counts as 3
  const p = { ...M.GRID_START, w: M.GRID_ROWS.map((_, i) => (i === 8 ? 1 : 0)) };
  const far = { ...row(8, 10), sig: 12 };
  assert.equal(M.gridEval(p, 'NBA', far).margin, 10);
  assert.equal(M.gridEval({ ...p, clip }, 'NBA', far).margin, 3);
  assert.deepEqual(M.clippedLabels(far, clip), ['#9 Matchups (style against style) 10 → 3']);
  assert.deepEqual(M.clippedLabels({ ...row(8, 2.9) }, clip), []);
  // a back-to-back of −1 on a team is never touched
  assert.equal(M.gridEval({ ...p, w: M.GRID_ROWS.map((_, i) => (i === 5 ? 1 : 0)), clip }, 'NBA', { ...row(5, -40), sig: 12 }).margin, -40);
});

test('fix288: the clip gate keeps a row whose big values carry the result, clips one whose outliers are noise', () => {
  const r = rng(11), items = [];
  for (let k = 0; k < 3000; k++) {
    const it = row(2, gauss(r) * 6);
    it.hv[8] = gauss(r) * 0.5;
    if (k % 50 === 0) it.hv[2] = (k % 100 ? 1 : -1) * 40; // #3: a true mismatch (the result follows it)
    if (k % 37 === 0) it.hv[8] = (r() < 0.5 ? 1 : -1) * 12; // #9: a wild value with nothing behind it
    const m = it.hv[2] + it.hv[8] * 0.5 * (Math.abs(it.hv[8]) < 3 ? 1 : 0);
    const y = 1 / (1 + Math.exp(-m / 5)) > r() ? 1 : 0;
    items.push({ ...it, id: k, code: 'NBA', season: '2023-2024', year: 2023, gp: 30, y, v3: 0.5, sig: 12, oracle: null });
  }
  const p = { ...M.GRID_START, w: M.GRID_ROWS.map((_, i) => (i === 2 ? 1 : i === 8 ? 0.5 : 0)) };
  const range = M.rangeStats(items), g = M.clipGate(p, items, items.slice(0, 500), range);
  const by = Object.fromEntries(g.rows.map(x => [x.id, x]));
  assert.equal(by['#3'].on, false, `#3's clip costs the training games: ${JSON.stringify(by['#3'])}`);
  assert.ok(by['#3'].train > M.CLIP_TOL);
  assert.equal(by['#9'].on, true, `#9's clip helps: ${JSON.stringify(by['#9'])}`);
  assert.ok(by['#9'].train < 0);
  assert.equal(g.clip.lo[2], null); assert.ok(g.clip.hi[8] > 0 && g.clip.hi[8] < 12);
});

/* ---------- (1) the seeded replay: #8 early in a season, #13 of 5 old meetings ---------- */

const seeded = (() => {
  let done = null;
  return async () => {
    if (done) return done;
    const ins = db.prepare(`INSERT INTO bb_games (game_id, code, league_id, season, stage, kickoff, status, home_id, home_name, away_id, away_name, hs, as_, updated_at, stats) VALUES (?, 'EL', 120, ?, NULL, ?, 'FT', ?, ?, ?, ?, ?, ?, ?, 1)`);
    const insP = db.prepare(`INSERT INTO bb_player_stats (game_id, team_id, player_id, name, starter, minutes, pts, fgm, fga, tpm, tpa, ftm, fta, reb, ast) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insT = db.prepare(`INSERT INTO bb_team_stats (game_id, team_id, fgm, fga, tpm, tpa, ftm, fta, reb, oreb, dreb, ast, stl, blk, tov, pf) VALUES (?, ?, ?, 80, ?, 30, 16, 21, 40, 9, 31, 20, 7, 4, ?, 19)`);
    const r = rng(5);
    // 8 teams of very different strength, the same 9 players every season (unchanged rosters)
    const strength = t => (t - 4.5) * 2.2;
    const mins = [34, 32, 30, 28, 26, 24, 14, 6, 6];
    const base = new Map();
    let id = 1;
    const play = (season, ms, h, a) => {
      const side = t => mins.map((m, j) => [t * 100 + j + 1, Math.max(3, m + gauss(r))]);
      const hs = side(h), as = side(a);
      const margin = Math.round(3 + strength(h) - strength(a) + gauss(r) * 10) || 1;
      ins.run(id, season, new Date(ms).toISOString(), h, `Team ${h}`, a, `Team ${a}`, 80 + Math.max(0, margin), 80 + Math.max(0, -margin), new Date().toISOString());
      for (const [t, list] of [[h, hs], [a, as]]) {
        const q = strength(t);
        insT.run(id, t, Math.round(30 + q / 2), Math.round(10 + q / 4), Math.round(13 - q / 4));
        for (const [p, m] of list) insP.run(id, t, p, `Player ${p}`, Math.round(m * 10) / 10, Math.max(0, Math.round((10 + q) * m / 30 + gauss(r) * 3)), 4, 9, 1, 3, 2, 3, 4, 3);
      }
      const v1 = 3 + strength(h) - strength(a);
      base.set(id, { p: 1 / (1 + Math.exp(-v1 / 7)), m1: v1, netH: 0, netA: 0, hca: 3, haH: 0, haA: 0, b2bH: false, b2bA: false, sig: 11 });
      id++;
    };
    // teams 1 and 2 never meet in the regular schedule: only 5 times over the two seasons before the test season
    const pairs = [];
    for (let h = 1; h <= 8; h++) for (let a = 1; a <= 8; a++) if (h !== a && !((h === 1 && a === 2) || (h === 2 && a === 1))) pairs.push([h, a]);
    const meet = [];
    // 4 rounds a season (each team 56 games: #8 is 0 from its game 25 on, as in a real season)
    for (const [season, y] of [['2022', 2022], ['2023', 2023], ['2024', 2024]]) {
      const t0 = Date.UTC(y, 9, 1);
      for (let rd = 0; rd < 4; rd++) pairs.forEach(([h, a], k) => play(season, t0 + (rd * pairs.length + k) * 8 * 3600000, h, a));
      if (y >= 2023) for (let k = 0; k < (y === 2023 ? 3 : 2); k++) { const ms = t0 + (90 + 20 * k) * 86400000; play(season, ms, k % 2 ? 2 : 1, k % 2 ? 1 : 2); meet.push(ms); }
    }
    // the test season's first round (teams 1 and 2 not yet)
    const t1 = Date.UTC(2025, 9, 1);
    for (const [k, [h, a]] of [[3, 4], [5, 6], [7, 8]].entries()) play('2025', t1 + k * 3600000, h, a);
    const res = await G.replayLeague('EL', base, G.storedBox());
    done = { res, meet, t1 };
    return done;
  };
})();

test('fix288: #8 of an unchanged roster in the first games of a season stays inside its training range', async () => {
  const { res } = await seeded();
  const train = res.items.filter(x => x.year >= 2022 && x.year <= 2024), early = res.items.filter(x => x.year === 2025);
  assert.ok(train.length > 300 && early.length >= 3, `${train.length} train, ${early.length} early games`);
  const range = M.rangeStats(train), all = M.rowStats(train);
  const in8 = early.filter(x => Math.abs(M.diff(x, 7)) > 0.5);
  assert.ok(in8.length >= 2, `#8 in play on the season's first games (${early.map(x => M.diff(x, 7)).join(', ')})`);
  for (const x of early) assert.ok(!M.rowsOutOfRange(x, range).includes(7), `#8 ${M.diff(x, 7)} vs in-play range ${range.mean[7]} ± ${range.sd[7]}`);
  assert.ok(range.sd[7] > 1.3 * all.sd[7], `the in-play spread ${range.sd[7]} is wider than the all-games one ${all.sd[7]} (the zeros after game 25)`);
  // and the clip never moves it
  const clip = M.clipOf(range);
  for (const x of early) assert.equal(M.clipTo(M.diff(x, 7), clip, 7), M.diff(x, 7));
});

test('fix288: head-to-head of 5 old meetings stays inside its training range (and 0 after 2 years)', async () => {
  const { res, meet, t1 } = await seeded();
  const train = res.items.filter(x => x.year >= 2022 && x.year <= 2024);
  const range = M.rangeStats(train), clip = M.clipOf(range);
  const met = res.snap.h2h.get('1|2') || [];
  assert.equal(met.length, 5, `5 meetings kept (${met.length})`);
  assert.deepEqual(met.map(x => x[0]), meet);
  const t = res.snap.teams, h = t.get(1), a = t.get(2);
  const f = { base: { p: 0.5, sig: 11, hca: 3, haH: 0, haA: 0, b2bH: false, b2bA: false }, home: 1, away: 2, ms: t1 + 86400000, rs: true, neutral: false, three: [false, false], gpH: 1, gpA: 1 };
  const v = G.rowsOf(res.snap, h, a, f);
  const d = v.hv[12] - v.av[12];
  assert.ok(Math.abs(d) > 0, 'the meetings count');
  assert.deepEqual(M.rowsOutOfRange(v, range).filter(i => i === 12), [], `#13 ${d} vs ${range.mean[12]} ± ${range.sd[12]}`);
  assert.equal(M.clipTo(d, clip, 12), d);
  // the same meetings more than 2 years before the game: not counted
  const later = G.rowsOf(res.snap, h, a, { ...f, ms: meet[meet.length - 1] + 731 * 86400000 });
  assert.equal(later.hv[12], 0);
});

test('fix288: the published state clips with the gate, lists it on the data-health card, check30 answers', async () => {
  const { res } = await seeded();
  G.storeRows('EL', res.items);
  G.publishSnap(res.snap);
  const gs = T.publishGridState();
  assert.ok(gs.range && gs.range.sd.length === M.N_ROWS, 'the in-play range is published');
  assert.ok(gs.params.clip && gs.clipRows && gs.clipRows.length, 'the clip and its gate are published');
  for (const c of gs.clipRows) assert.equal(gs.params.clip.lo[M.GRID_ROWS.findIndex(r => r.id === c.id)] !== null, c.on, c.id);
  assert.match(T.clipSummary(), /^Clip at 3 sd of training: /);
  // the live prediction carries what the clip held
  const g = { code: 'EL', game_id: 1, home_id: 1, away_id: 8, kickoff: new Date(Date.now() + 86400000).toISOString(), season: '2025', week: null };
  const x = { p: 0.3, hca: 3, haH: 0, haA: 0, b2bHome: false, b2bAway: false };
  const ok = T.gridPredict(g, x, 11);
  assert.ok(ok, 'bb-v4 answers');
  const on = gs.clipRows.find(c => c.on && [0, 1, 3, 7, 9].includes(M.GRID_ROWS.findIndex(r => r.id === c.id)));
  assert.ok(on, `a clipped row the test can push out: ${JSON.stringify(gs.clipRows)}`);
  if (on) {
    const i = M.GRID_ROWS.findIndex(r => r.id === on.id), t8 = res.snap.teams.get(8);
    const key = ['imp', 'net', null, 'miss', null, null, null, 'stay', null, 'form'][i];
    if (key) {
      res.snap.teams.set(8, { ...t8, [key]: (t8[key] || 0) - 50 * (gs.range.sd[i] || 1), nv: undefined });
      G.publishSnap(res.snap);
      const far = T.gridPredict(g, x, 11);
      assert.ok(far.clipped && far.clipped.some(l => l.startsWith(on.id + ' ')), `clipped: ${far.clipped}`);
      res.snap.teams.set(8, t8); G.publishSnap(res.snap);
    }
  }
  // the 30-day check (finished games of the last 30 days: none on this seeded copy — still a well-formed answer)
  const c = T.check30(30);
  assert.ok(c.nba && c.fec && c.all && 'withMarket' in c.all, JSON.stringify(c).slice(0, 300));
  const c2 = T.check30(3650, Date.UTC(2025, 9, 5));
  assert.ok(c2.all.games >= 3 && c2.all.after && c2.all.after.games === c2.all.games, JSON.stringify(c2.all));
  // the card reads the clip
  const dh = read('src/services/dataHealth.ts');
  assert.match(dh, /clipSummary\(\)/);
  assert.match(dh, /clipped — \$\{x\.p!\.gridClip!\.join/);
  assert.match(read('src/app.ts'), /app\.get\('\/api\/bb\/check30'/);
});

/* ---------- (2) the sitemaps ---------- */

test('fix288: every sitemap is sent from its stored xml view (no body read, no build on the web), rebuilt after slugs', () => {
  const app = read('src/app.ts');
  const block = app.slice(app.indexOf("definePage({ name: 'sitemap'"), app.indexOf('// fix226: the push service worker'));
  assert.ok(block.length > 200, 'the sitemap block');
  assert.match(block, /variants: \{ xml: \(b: any\) => \(typeof b === 'string' \? b : null\) \}/);
  assert.match(block, /getPage\('sitemap', \{ file \}, \{ views: \['xml'\], etags: \['xml'\] \}\)/);
  assert.match(block, /s\?\.view\('xml'\)/);
  assert.doesNotMatch(block, /\.body\b/, 'the web never reads the page body');
  assert.match(block, /warm: SITEMAP_FILES\.map/);
  assert.match(block, /app\.get\('\/sitemap\.xml'/);
  assert.match(block, /for \(const file of Object\.keys\(SITEMAPS\)\) app\.get\(`\/\$\{file\}`/);
  const seo = read('src/services/seo.ts');
  assert.match(seo, /export const SITEMAP_FILES = \['sitemap\.xml', \.\.\.Object\.keys\(SITEMAPS\)\]/);
  for (const f of ['sitemap-football.xml', 'sitemap-basketball.xml', 'sitemap-nfl.xml', 'sitemap-tennis.xml', 'sitemap-teams.xml', 'sitemap-leagues.xml', 'sitemap-players.xml']) assert.ok(seo.includes(`'${f}'`), f);
  const jobs = read('src/jobs.ts');
  assert.match(jobs, /buildSlugs\(\)\.then\(\(\) => \{ for \(const file of SITEMAP_FILES\) rebuildPage\('sitemap', \{ file \}\); \}\)/);
});

test('fix288: a web process answers a sitemap from the stored copy without building it', () => {
  // the worker side (this process, role 'all'): build and store every file's copy with its xml view
  const P = require('../dist/services/pageCache.js');
  const files = ['sitemap.xml', 'sitemap-football.xml', 'sitemap-teams.xml'];
  const xml = f => `<?xml version="1.0" encoding="UTF-8"?>\n<urlset><url><loc>https://sportlikely.com/${f}</loc></url></urlset>\n`;
  P.definePage({ name: 'sitemap', freshMs: 3600 * 1000, variants: { xml: b => (typeof b === 'string' ? b : null) }, build: q => xml(q.file) });
  return (async () => {
    for (const file of files) { const s = await P.getPage('sitemap', { file }); assert.equal(s.view('xml').text, xml(file)); }
    // the web side: a new process, SL_ROLE=web, whose build would throw — every file comes from the stored view
    const js = `
      process.env.LOG_LEVEL = 'error';
      const P = require(${JSON.stringify(path.join(here, '../dist/services/pageCache.js'))});
      let built = 0;
      P.definePage({ name: 'sitemap', freshMs: 3600 * 1000, variants: { xml: b => b }, build: () => { built++; throw new Error('built on the web'); } });
      (async () => {
        const out = {};
        for (const file of ${JSON.stringify(files)}) { const s = await P.getPage('sitemap', { file }, { views: ['xml'], etags: ['xml'], waitMs: 200 }); out[file] = s && s.view('xml') ? s.view('xml').text : null; }
        process.stdout.write(JSON.stringify({ built, out }));
        process.exit(0);
      })().catch(e => { process.stdout.write(JSON.stringify({ error: String(e && e.stack || e) })); process.exit(0); });`;
    const raw = execFileSync(process.execPath, ['--no-warnings', '-e', js], { env: { ...process.env, DATA_DIR: DIR, SL_ROLE: 'web' }, encoding: 'utf8', timeout: 60_000 });
    const r = JSON.parse(raw.trim().split('\n').pop());
    assert.equal(r.error, undefined, r.error);
    assert.equal(r.built, 0, 'nothing built on the web');
    for (const f of files) assert.equal(r.out[f], xml(f), f);
  })();
});
