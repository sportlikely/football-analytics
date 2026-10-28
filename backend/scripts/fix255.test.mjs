// fix255: leagues under 52% — the draw rule, the home-advantage / draw-rate refit, the walk-forward (a game never sees
// its own result), the verdict (both halves + 90% of resamples), and the whole nightly run on a made-up record: a league
// whose saved numbers over-rate the home side gets its own setting, a calibrated league gets nothing, a setting that
// makes a league worse is rolled back, the live layer moves the numbers and keeps the original ones. (dist build)
// Run: npm run test:fix255
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix255-'));
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'error';
const require = createRequire(import.meta.url);
const L = require('../dist/utils/leagueFix.js');
const { mulberry32 } = require('../dist/utils/dailyRules.js');
const DAY = 86400000;

/* ---------- the draw rule and the double-chance side ---------- */

test('draw rule: the draw when P(draw) ≥ max(home, away) − x, else the most likely', () => {
  assert.equal(L.drawRulePick([0.4, 0.33, 0.27], 0), 0);
  assert.equal(L.drawRulePick([0.4, 0.33, 0.27], 0.06), 0);      // 0.33 < 0.40 − 0.06
  assert.equal(L.drawRulePick([0.4, 0.33, 0.27], 0.07), 1);      // 0.33 ≥ 0.40 − 0.07
  assert.equal(L.drawRulePick([0.3, 0.36, 0.34], 0), 1);         // the draw leads: picked with x = 0 too
  assert.equal(L.drawRulePick([0.27, 0.3, 0.43], 0.1), 2);
  assert.equal(L.drawRulePick([0.3, 0.34, 0.36], 0.02), 1);
});

test('double-chance side: home or away, never the draw', () => {
  assert.equal(L.dcSidePick([0.3, 0.4, 0.3]), 0);
  assert.equal(L.dcSidePick([0.28, 0.4, 0.32]), 2);
  assert.equal(L.dcSidePick([0.5, 0.3, 0.2]), 0);
});

/* ---------- the home-advantage / draw refit ---------- */

test('refit: the shift that moves a game to the target is found exactly, and the average moves toward the base rates', () => {
  const T = [0.38, 0.32, 0.30], M = [0.52, 0.22, 0.26];
  const s = L.fitShift(T, M);
  const q = L.shift(M, s.h, s.d);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(q[i] - T[i]) < 1e-9, `${q} vs ${T}`);
  assert.ok(s.h < 0, 'home over-rated → negative home shift');
  assert.ok(s.d > 0, 'draws under-rated → positive draw shift');
  // a spread of games: the mean after the shift is much closer to the target than before
  const r = mulberry32(3);
  const games = Array.from({ length: 400 }, () => { const h = 0.3 + 0.4 * r(), d = 0.18 + 0.1 * r(); return L.norm([h, d, Math.max(0.05, 1 - h - d)]); });
  const mean = ps => [0, 1, 2].map(i => ps.reduce((a, p) => a + p[i], 0) / ps.length);
  const M2 = mean(games), s2 = L.fitShift(T, M2), A = mean(games.map(p => L.shift(p, s2.h, s2.d)));
  const err = x => Math.abs(x[0] - T[0]) + Math.abs(x[1] - T[1]) + Math.abs(x[2] - T[2]);
  assert.ok(err(A) < err(M2) / 4, `${err(A)} vs ${err(M2)}`);
  // no difference → no shift
  const z = L.fitShift(T, T);
  assert.ok(Math.abs(z.h) < 1e-12 && Math.abs(z.d) < 1e-12);
});

test('refit: a league\'s own value is shrunk toward its group (k = 60 games)', () => {
  assert.equal(L.shrink(0.4, 0.1, 0), 0.1);
  assert.ok(Math.abs(L.shrink(0.4, 0.1, 60) - 0.25) < 1e-12);
  assert.ok(L.shrink(0.4, 0.1, 600) > 0.37);
});

test('history base rates: only games of the days before', () => {
  const t0 = Date.parse('2026-09-01T00:00:00Z');
  const h = L.makeHist([{ t: t0 + 3 * DAY, y: 2 }, { t: t0, y: 0 }, { t: t0 + DAY, y: 1 }]);
  assert.deepEqual(L.histBefore(h, t0), [0, 0, 0]);
  assert.deepEqual(L.histBefore(h, t0 + 1), [1, 0, 0]);
  assert.deepEqual(L.histBefore(h, t0 + 2 * DAY), [1, 1, 0]);
  assert.deepEqual(L.histBefore(h, t0 + 9 * DAY), [1, 1, 1]);
  assert.equal(L.histBefore(undefined, t0), null);
});

/* ---------- walk-forward ---------- */

/** made-up games: true chances `truth`, saved numbers = truth with the home side scaled by `homeBias` */
function league(comp, name, group, n, truth, homeBias, seed, from) {
  const r = mulberry32(seed);
  return Array.from({ length: n }, (_, i) => {
    const wobble = (r() - 0.5) * 0.2;
    const t = L.norm([truth[0] + wobble, truth[1], truth[2] - wobble]);
    const u = r(), y = u < t[0] ? 0 : u < t[0] + t[1] ? 1 : 2;
    const p = L.norm([t[0] * homeBias, t[1], t[2]]);
    const mkt = L.norm([t[0] * 1.05, t[1], t[2]]);
    return { id: seed * 10000 + i, comp, name, group, t: from + Math.floor((i * DAY * 240) / n) + 15 * 3600000, p, mkt, y };
  });
}

test('walk-forward: a game\'s numbers never depend on its own result (or any later one)', () => {
  const now = Date.parse('2026-10-28T00:00:00Z'), from = now - 90 * DAY;
  const rows = league('X', 'X', 'second', 300, [0.4, 0.3, 0.3], 1.4, 5, now - 240 * DAY);
  const a = L.walkForward(rows, new Map(), new Set(['X']), from, Infinity);
  const k = 250;
  const flipped = rows.map((r, i) => (i >= k ? { ...r, y: (r.y + 1) % 3 } : r));
  const b = L.walkForward(flipped, new Map(), new Set(['X']), from, Infinity);
  const ia = a.findIndex(w => w.id === rows[k].id);
  for (const c of ['base', ...L.CANDS]) assert.deepEqual(a[ia].probs[c], b[ia].probs[c], c);
  assert.equal(a[ia].pickDraw, b[ia].pickDraw);
  // an earlier result does move it (the fits learn)
  const early = rows.map((r, i) => (i < 200 ? { ...r, y: 1 } : r));
  const c = L.walkForward(early, new Map(), new Set(['X']), from, Infinity);
  assert.notDeepEqual(c[ia].probs.draw, a[ia].probs.draw);
});

test('walk-forward: a league with < 60 games uses its group\'s shift, not its own', () => {
  const now = Date.parse('2026-10-28T00:00:00Z'), from = now - 90 * DAY;
  const big = league('B', 'B', 'asia', 300, [0.45, 0.27, 0.28], 1.0, 7, now - 240 * DAY);
  const small = league('S', 'S', 'asia', 60, [0.3, 0.4, 0.3], 1.6, 8, now - 240 * DAY);
  const w = L.walkForward([...big, ...small], new Map(), new Set(['B']), from, Infinity);
  const s = w.filter(x => x.comp === 'S').at(-1), b = w.filter(x => x.comp === 'B').at(-1);
  assert.equal(s.own, false);
  assert.ok(Math.abs(s.h - b.h) < 0.05, `small league h ${s.h} ≈ the group's, not its own (big ${b.h})`);
});

/* ---------- the verdict ---------- */

test('verdict: a clear improvement passes (both halves, ≥ 90% of resamples); no change and noise do not', () => {
  const now = Date.parse('2026-10-28T00:00:00Z'), from = now - 90 * DAY, mid = now - 45 * DAY;
  const bad = league('X', 'X', 'second', 900, [0.38, 0.32, 0.30], 1.6, 11, now - 240 * DAY);
  const w = L.walkForward(bad, new Map(), new Set(['X']), from, Infinity);
  const j = L.judgeUnit(w, mid);
  const calib = j.results.find(x => x.cand === 'calib');
  assert.equal(calib.pass, true, calib.why);
  assert.ok(calib.d1 < 0 && calib.d2 < 0 && calib.boot.pBetter >= 0.9);
  assert.ok(['home', 'draw', 'calib', 'calib+anchor', 'anchor', 'close'].includes(j.best));
  // a well-calibrated league: the shifts are tiny and do not pass
  const good = league('G', 'G', 'second', 900, [0.45, 0.27, 0.28], 1.0, 12, now - 240 * DAY);
  const wg = L.walkForward(good, new Map(), new Set(['G']), from, Infinity);
  const jg = L.judgeUnit(wg, mid);
  for (const c of ['home', 'draw', 'calib']) assert.equal(jg.results.find(x => x.cand === c).pass, false, c);
  // one half better, the other worse → fails before the bootstrap
  const fake = w.map(x => ({ ...x, probs: { ...x.probs, home: x.t < mid ? x.probs.calib : L.shift(x.probs.base, 0.5, 0) } }));
  const r = L.judgeCand(fake, 'home', mid);
  assert.equal(r.pass, false); assert.equal(r.boot, null); assert.match(r.why, /both halves/);
});

test('report numbers: home bias, draw gap and the causes', () => {
  const rows = [
    ...Array.from({ length: 30 }, (_, i) => ({ comp: 'X', name: 'X', group: 'second', p: [0.5, 0.25, 0.25], mkt: [0.35, 0.33, 0.32], y: i % 3 === 0 ? 0 : 1 }))
  ];
  const s = L.leagueStats(rows);
  assert.equal(s.n, 30); assert.deepEqual(s.picks, [30, 0, 0]); assert.deepEqual(s.outcomes, [10, 20, 0]);
  assert.equal(s.homeBias, 3); assert.ok(Math.abs(s.drawGap - 0.667) < 0.001);
  assert.deepEqual(s.causes, ['draws', 'home bias', 'market better']);
});

test('data health rule: under 50% on every one of the last 30 days (60+ games)', () => {
  const now = Date.parse('2026-10-28T00:00:00Z');
  const mk = (comp, hitEvery) => Array.from({ length: 200 }, (_, i) => ({ comp, name: comp, t: now - 120 * DAY + i * 0.6 * DAY, p: [0.5, 0.25, 0.25], y: i % hitEvery === 0 ? 0 : 2 }));
  const out = L.leaguesUnder([...mk('BAD', 3), ...mk('OK', 1)], now);
  assert.deepEqual(out.map(x => x.comp), ['BAD']);
  assert.ok(out[0].hit < 50 && out[0].n >= 60);
});

test('groups: big 5, second tiers, cups / national teams, Americas, Asia, Nordic, other', () => {
  assert.equal(L.groupOf('PL'), 'big5');
  assert.equal(L.groupOf('ELC'), 'second');
  assert.equal(L.groupOf('AF136', 'Serie B'), 'second');
  assert.equal(L.groupOf('AF5', 'UEFA Nations League'), 'cups');
  assert.equal(L.groupOf('AF262', 'Liga MX'), 'americas');
  assert.equal(L.groupOf('AF169', 'Super League', 'China'), 'asia');
  assert.equal(L.groupOf('AF305', 'Stars League', 'Qatar'), 'asia');
  assert.equal(L.groupOf('AF345', 'Czech Liga', 'Czech-Republic'), 'europe');
  assert.equal(L.groupOf('AF103', 'Eliteserien'), 'nordic');
  assert.equal(L.groupOf('AF383', 'Ligat Ha\'al', 'Israel'), 'europe');
});

/* ---------- the nightly run on a made-up record ---------- */

test('nightly run: applied only where it passed, rolled back where it got worse, live layer keeps the original numbers', async () => {
  const { db } = require('../dist/db/index.js');
  require('../dist/services/tracking.js'); // payload / layer_raw columns
  const { setConfig } = require('../dist/services/featureModel.js');
  const fix = require('../dist/services/leagueFix.js');
  const live = require('../dist/services/leagueFixLive.js');
  const health = require('../dist/services/leagueFixHealth.js');
  const now = Date.now();
  const ins = db.prepare(`INSERT INTO predictions (match_id, model, competition_code, competition_name, utc_date, home_team, away_team, p_home, p_draw, p_away, odds_home, odds_draw, odds_away, locked, settled, created_at, updated_at) VALUES (?, 'grid-v3', ?, ?, ?, 'H', 'A', ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`);
  const res = db.prepare(`INSERT INTO results (match_id, status, home_goals, away_goals, outcome, settled_at) VALUES (?, 'FINISHED', ?, ?, ?, ?)`);
  const hist = db.prepare(`INSERT OR IGNORE INTO history_matches (division, season, date, home, away, hg, ag) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const put = rows => {
    for (const r of rows) {
      const d = new Date(r.t).toISOString();
      ins.run(r.id, r.comp, r.name, d, ...r.p.map(x => Math.round(x * 1000) / 10), ...r.mkt.map(x => Math.round((1 / x) * 100) / 100), d, d);
      res.run(r.id, r.y === 0 ? 1 : 0, r.y === 2 ? 1 : 0, ['H', 'D', 'A'][r.y], d);
    }
  };
  const { seasonCodes } = require('../dist/services/history.js');
  const season = seasonCodes(1)[0];
  // Serie B (AF136 → history I2): saved numbers over-rate the home side, draws under-rated; history agrees with the truth
  const sb = league('AF136', 'Serie B', 'second', 700, [0.36, 0.33, 0.31], 1.6, 21, now - 239 * DAY);
  // J1 (AF98 → history JPN): calibrated saved numbers, but its history says home 62% — the home refit only hurts it
  const j1 = league('AF98', 'J1 League', 'asia', 700, [0.42, 0.28, 0.30], 1.0, 22, now - 239 * DAY);
  // Eredivisie (DED): calibrated, nothing to fix
  const ned = league('DED', 'Eredivisie', 'europe', 700, [0.46, 0.25, 0.29], 1.0, 23, now - 239 * DAY);
  put([...sb, ...j1, ...ned]);
  const r = mulberry32(99);
  for (let i = 0; i < 700; i++) {
    const date = new Date(now - 400 * DAY + i * 0.5 * DAY).toISOString().slice(0, 10);
    const u = r(), y1 = u < 0.36 ? 0 : u < 0.69 ? 1 : 2, y2 = r() < 0.62 ? 0 : r() < 0.5 ? 1 : 2;
    hist.run('I2', season, date, `h${i}`, `a${i}`, y1 === 0 ? 1 : 0, y1 === 2 ? 1 : 0);
    hist.run('JPN', season, date, `h${i}`, `a${i}`, y2 === 0 ? 1 : 0, y2 === 2 ? 1 : 0);
  }
  // J1 already carries a home setting from an earlier night
  setConfig('league_fix_live', JSON.stringify({ since: { AF98: '2026-10-01' }, settings: { AF98: { cand: 'home', h: 0.5, d: 0, base: [0.62, 0.2, 0.18], close: [0, 0], anchor: 0, unit: 'league', name: 'J1 League' } } }));

  const rep = await fix.runLeagueFix(now);
  assert.ok(rep.leagues, JSON.stringify(rep));
  const by = c => rep.leagues.find(l => l.comp === c);
  assert.ok(by('AF136').applied, `Serie B: ${by('AF136').action} — ${by('AF136').verdicts.map(v => `${v.cand}: ${v.why}`).join(' | ')}`);
  assert.ok(by('AF136').after.logLoss < by('AF136').logLoss);
  assert.equal(by('DED').applied, null, by('DED').action);
  assert.equal(by('AF98').applied, null, by('AF98').action);
  assert.match(by('AF98').action, /rolled back/);
  assert.deepEqual(rep.rolledBack.map(x => x.comp), ['AF98']);
  assert.ok(rep.totals.after.logLoss < rep.totals.before.logLoss);
  assert.equal(rep.leagues.find(l => l.comp === 'AF136').verdicts.length, 6);
  assert.ok(rep.groups.some(g => g.group === 'second'));
  assert.ok(rep.table.every(t => t.before.hit < 52));

  // the live layer: Serie B only; numbers moved toward the draw, the original kept; the saved row keeps both
  const layer = live.liveLayer();
  assert.deepEqual(Object.keys(layer.settings), ['AF136']);
  const preds = [{ model: 'grid-v3', home: 55, draw: 22, away: 23 }, { model: 'feat-v1', home: 55, draw: 22, away: 23 }];
  const out = live.applyLeagueFix({ id: 1, competition: { code: 'AF136' } }, preds);
  assert.ok(out[0].home < 55 && out[0].draw > 22, JSON.stringify(out[0]));
  assert.ok(Math.abs(out[0].home + out[0].draw + out[0].away - 100) < 1e-9);
  assert.deepEqual(out[0].league.raw, [55, 22, 23]);
  assert.deepEqual(out[1], preds[1], 'feat-v1 is never moved');
  assert.deepEqual(live.applyLeagueFix({ id: 2, competition: { code: 'DED' } }, preds), preds);
  assert.deepEqual(live.applyLeagueFix({ id: 3, competition: { code: 'AF136' } }, out), out, 'never moved twice');

  // a moved row is read back from its original numbers: the next night gives the same table
  const { recordPredictions } = require('../dist/services/tracking.js');
  const future = new Date(now + 2 * DAY).toISOString();
  recordPredictions([{ id: 777777, status: 'TIMED', utcDate: future, competition: { code: 'AF136', name: 'Serie B' }, homeTeam: { id: 1, name: 'H' }, awayTeam: { id: 2, name: 'A' },
    predictions: [{ ...out[0], expectedGoals: { home: 1, away: 1 }, over25: 50, btts: 50, confidence: 'high', factors: { gamesPlayed: { home: 9, away: 9 } } }] }]);
  const row = db.prepare(`SELECT p_home, layer_raw FROM predictions WHERE match_id = 777777`).get();
  assert.equal(row.p_home, out[0].home); assert.deepEqual(JSON.parse(row.layer_raw), [55, 22, 23]);

  // data health reads the stored run
  const h = health.leagueFixHealth();
  assert.equal(h[0].id, 'leagues-under-50');
  assert.ok(['ok', 'warn'].includes(h[0].level));
  assert.ok(fix.lastLeagueFix().builtAt);
});

test('verdict: an unchanged candidate (float noise only) never passes', () => {
  const now = Date.parse('2026-10-28T00:00:00Z'), mid = now - 45 * DAY;
  const rows = league('N', 'N', 'europe', 400, [0.46, 0.25, 0.29], 1.0, 31, now - 90 * DAY);
  const w = L.walkForward(rows, new Map(), new Set(['N']), now - 90 * DAY, Infinity)
    .map(x => ({ ...x, probs: { ...x.probs, close: x.probs.base.map((v, i) => v * (1 + (i === 0 ? -1e-12 : 1e-13))) } }));
  assert.equal(L.judgeCand(w, 'close', mid).pass, false);
});
