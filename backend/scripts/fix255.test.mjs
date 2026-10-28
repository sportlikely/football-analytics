// fix255 / fix255b: leagues under 52% — the layers (home ratio, draw toward the group rate, close games), the fit, the
// 30-day block test (a block never sees its own games), the verdict (first and last 30 days + 90% of resamples), the
// draw picks the layer makes, and the whole nightly run on a made-up record: a group whose saved numbers over-rate the
// home side and under-rate draws gets a setting that reaches its 25-game league too, a calibrated group gets nothing, a
// live setting that got worse is rolled back, the live layer keeps the model's own numbers. (dist build)
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
const close = (a, b, e = 1e-9) => a.every((x, i) => Math.abs(x - b[i]) < e);

/** made-up games: true chances around `truth`; saved numbers = truth with home × hb and draw × db (renormalised) */
function games(comp, group, n, truth, hb, db, seed, from, days, src = 'record', season) {
  const r = mulberry32(seed);
  return Array.from({ length: n }, (_, i) => {
    const wob = (r() - 0.5) * 0.3;
    const t = L.norm([Math.max(0.05, truth[0] + wob), truth[1], Math.max(0.05, truth[2] - wob)]);
    const u = r(), y = u < t[0] ? 0 : u < t[0] + t[1] ? 1 : 2;
    return { id: (src === 'record' ? 1 : -1) * (seed * 100000 + i + 1), comp, name: comp, group, t: from + Math.floor((i * DAY * days) / n) + 15 * 3600000, p: L.norm([t[0] * hb, t[1] * db, t[2]]), mkt: null, y, src, season };
  });
}

/* ---------- the layers ---------- */

test('home layer: the home / away ratio × e^h, the draw keeps its share of the rest', () => {
  const q = L.homeAdj([0.5, 0.25, 0.25], Math.log(0.5));
  assert.ok(Math.abs(q[0] / q[2] - 1) < 1e-12, `ratio ${q[0] / q[2]}`);
  assert.ok(Math.abs(q[0] + q[1] + q[2] - 1) < 1e-12);
  assert.deepEqual(L.homeAdj([0.5, 0.25, 0.25], 0), [0.5, 0.25, 0.25]);
});

test('draw layer: P(draw) moved toward the group rate by w, home / away keep their ratio', () => {
  const q = L.drawAdj([0.5, 0.2, 0.3], 0.5, 0.3);
  assert.ok(Math.abs(q[1] - 0.25) < 1e-12);
  assert.ok(Math.abs(q[0] / q[2] - 0.5 / 0.3) < 1e-12);
  assert.ok(Math.abs(q[0] + q[1] + q[2] - 1) < 1e-12);
  assert.ok(close(L.drawAdj([0.5, 0.2, 0.3], 1, 0.3), [0.5 * 0.7 / 0.8, 0.3, 0.3 * 0.7 / 0.8]));
});

test('close-game layer: only when |H − A| < y, toward the base rates by s', () => {
  const base = [0.4, 0.3, 0.3];
  assert.ok(close(L.closeAdj([0.38, 0.27, 0.35], 0.05, 0.5, base), [0.39, 0.285, 0.325]));
  assert.deepEqual(L.closeAdj([0.5, 0.27, 0.23], 0.05, 0.5, base), [0.5, 0.27, 0.23]);
});

test('the draw a layer raises becomes the pick (the most likely result)', () => {
  const p = [0.36, 0.3, 0.34];
  assert.equal(L.argmax(p), 0);
  assert.equal(L.argmax(L.applyCand(p, 'draw', { ...L.NO_PARAMS, w: 0.6, dr: 0.42 })), 1);
});

/* ---------- the fit ---------- */

test('fit: the home over-rating and the missing draws are found (log loss), a calibrated set is left alone', () => {
  const now = Date.parse('2026-10-28T00:00:00Z');
  const biased = games('X', 'second', 6000, [0.38, 0.32, 0.30], 2.0, 0.7, 4, now - 300 * DAY, 300);
  const P = L.fitCand(biased, 'home+draw');
  assert.ok(P.h <= -0.4, `h ${P.h} (saved home × 2 → about −0.69)`);
  assert.ok(P.w > 0.2, `w ${P.w}`);
  assert.ok(Math.abs(P.dr - 0.32) < 0.02, `draw rate ${P.dr}`);
  const fair = games('Y', 'second', 6000, [0.45, 0.27, 0.28], 1, 1, 5, now - 300 * DAY, 300);
  const F = L.fitCand(fair, 'home+draw');
  // a calibrated set: whatever the grid picks on sample noise, the numbers barely move
  const moved = Math.max(...fair.map(g => Math.max(...L.applyCand(g.p, 'home+draw', F).map((x, i) => Math.abs(x - g.p[i])))));
  assert.ok(Math.abs(F.h) <= 0.1 && moved < 0.03, `${JSON.stringify(F)} moved ${moved}`);
});

/* ---------- the block test ---------- */

test('blocks: a block\'s numbers never use its own games (fit on the other 60 days)', () => {
  const now = Date.parse('2026-10-28T00:00:00Z'), from = now - 90 * DAY;
  const g = games('X', 'second', 900, [0.38, 0.32, 0.30], 1.6, 0.8, 6, from - 60 * DAY, 150);
  const a = L.crossTest(g, 'home+draw', 'record', from, now + 2 * DAY);
  const last = g.filter(x => x.t >= from + 60 * DAY);
  const flipped = g.map(x => (x.t >= from + 60 * DAY ? { ...x, y: (x.y + 1) % 3 } : x));
  const b = L.crossTest(flipped, 'home+draw', 'record', from, now + 2 * DAY);
  for (const x of last) assert.deepEqual(a.probs.get(x.id), b.probs.get(x.id));
  // the other blocks did see those games
  const first = g.find(x => x.t >= from && x.t < from + 30 * DAY);
  assert.notDeepEqual(a.probs.get(first.id), b.probs.get(first.id));
  assert.deepEqual(a.blocks.map(x => x.from), L.blocksOf(from, now + 2 * DAY).map(x => new Date(x.from).toISOString().slice(0, 10)));
});

test('verdict: a biased group passes (first and last 30 days + 90%), a calibrated one does not, a small one is refused', () => {
  const now = Date.parse('2026-10-28T00:00:00Z'), from = now - 90 * DAY;
  const bad = games('X', 'second', 1200, [0.36, 0.33, 0.31], 1.7, 0.75, 7, from - 60 * DAY, 150);
  const j = L.judgeUnit(bad, from, now + 2 * DAY);
  const hd = j.results.find(x => x.cand === 'home+draw');
  assert.equal(hd.pass, true, hd.why);
  assert.ok(hd.blocks[0].diff < 0 && hd.blocks[2].diff < 0 && hd.boot.pBetter >= 0.9);
  assert.ok(j.best);
  const fair = games('Y', 'second', 1200, [0.45, 0.27, 0.28], 1, 1, 8, from - 60 * DAY, 150);
  assert.equal(L.judgeUnit(fair, from, now + 2 * DAY).best, null);
  const small = games('Z', 'second', 50, [0.36, 0.33, 0.31], 1.7, 0.75, 9, from, 90);
  assert.match(L.crossTest(small, 'home', 'record', from, now + 2 * DAY).why, /< 60/);
});

test('extended: the 2 past seasons only feed the fit ("extended"), are never scored, and get a past-seasons check', () => {
  const now = Date.parse('2026-10-28T00:00:00Z'), from = now - 90 * DAY;
  const rec = games('X', 'second', 300, [0.36, 0.33, 0.31], 1.7, 0.75, 10, from, 90);
  const bt = [...games('X', 'second', 800, [0.36, 0.33, 0.31], 1.7, 0.75, 11, now - 800 * DAY, 300, 'backtest', '2425'),
    ...games('X', 'second', 800, [0.36, 0.33, 0.31], 1.7, 0.75, 12, now - 430 * DAY, 300, 'backtest', '2526')];
  const r = L.crossTest([...rec, ...bt], 'home+draw', 'extended', from, now + 2 * DAY);
  assert.equal(r.n, 300);
  assert.ok(r.past && r.past.n === 800 && r.past.diff < 0, JSON.stringify(r.past));
  assert.equal([...r.probs.keys()].filter(k => k < 0).length, 0);
});

/* ---------- report numbers ---------- */

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

test('nightly run: pooled per group, applied to every league of the group, rolled back when worse, live keeps the model\'s numbers', async () => {
  const { db } = require('../dist/db/index.js');
  require('../dist/services/tracking.js'); // payload / layer_raw / p_pre columns
  require('../dist/services/historyModel.js'); // backtest tables
  const { setConfig } = require('../dist/services/featureModel.js');
  const fix = require('../dist/services/leagueFix.js');
  const live = require('../dist/services/leagueFixLive.js');
  const health = require('../dist/services/leagueFixHealth.js');
  const { seasonCodes } = require('../dist/services/history.js');
  const now = Date.now(), from = now - 90 * DAY;
  const ins = db.prepare(`INSERT INTO predictions (match_id, model, competition_code, competition_name, utc_date, home_team, away_team, p_home, p_draw, p_away, locked, settled, created_at, updated_at) VALUES (?, 'grid-v3', ?, ?, ?, 'H', 'A', ?, ?, ?, 1, 1, ?, ?)`);
  const res = db.prepare(`INSERT INTO results (match_id, status, home_goals, away_goals, outcome, settled_at) VALUES (?, 'FINISHED', ?, ?, ?, ?)`);
  const put = rows => { for (const r of rows) { const d = new Date(r.t).toISOString(); ins.run(r.id, r.comp, r.name, d, ...r.p.map(x => Math.round(x * 1000) / 10), d, d); res.run(r.id, r.y === 0 ? 1 : 0, r.y === 2 ? 1 : 0, ['H', 'D', 'A'][r.y], d); } };
  // second tiers: the saved numbers over-rate home and under-rate draws. The Championship has the whole window,
  // Serie B 37 games (since 7 Oct-ish), League Two 25
  const named = (rows, name) => rows.map(r => ({ ...r, name }));
  const elc = named(games('ELC', 'second', 420, [0.37, 0.33, 0.30], 1.7, 0.75, 21, from - 60 * DAY, 150), 'Championship');
  const sb = named(games('AF136', 'second', 37, [0.37, 0.33, 0.30], 1.7, 0.75, 22, now - 21 * DAY, 20), 'Serie B');
  const l2 = named(games('AF42', 'second', 25, [0.37, 0.33, 0.30], 1.7, 0.75, 23, now - 21 * DAY, 20), 'League Two');
  // Asia (J1): calibrated now, but its past seasons' outcomes were far more home-heavy than their numbers
  const j1 = named(games('AF98', 'asia', 400, [0.42, 0.28, 0.30], 1, 1, 24, from - 60 * DAY, 150), 'J1 League');
  // the Eredivisie: calibrated, nothing to fix
  const ned = named(games('DED', 'europe', 400, [0.46, 0.25, 0.29], 1, 1, 25, from - 60 * DAY, 150), 'Eredivisie');
  put([...elc, ...sb, ...l2, ...j1, ...ned]);
  // the grid-v3 backtest: J1 (division JPN) — saved numbers like today's, results home 62%
  const [cur, prev1] = seasonCodes(2);
  const run = db.prepare(`INSERT INTO backtest_runs (season, grp, model, matches, started_at, finished_at) VALUES (?, 'JPN', 'grid-v3', 0, ?, ?)`).run(prev1, new Date().toISOString(), new Date().toISOString());
  const bt = db.prepare(`INSERT INTO backtest_predictions (run_id, division, date, home, away, hg, ag, outcome, p_home, p_draw, p_away) VALUES (?, 'JPN', ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const r = mulberry32(77);
  for (let i = 0; i < 1500; i++) {
    const u = r(), y = u < 0.62 ? 0 : u < 0.8 ? 1 : 2;
    bt.run(Number(run.lastInsertRowid), new Date(now - 500 * DAY + i * 0.2 * DAY).toISOString().slice(0, 10), `h${i}`, `a${i}`, y === 0 ? 1 : 0, y === 2 ? 1 : 0, ['H', 'D', 'A'][y], 0.42, 0.28, 0.30);
  }
  void cur;
  // Asia already carries a home setting fitted with the past seasons
  setConfig('league_fix_live', JSON.stringify({ since: { 'g:asia': '2026-10-01' }, groups: { asia: { cand: 'home', variant: 'extended', P: { ...L.NO_PARAMS, h: 0.5 } } }, leagues: {}, compGroup: {} }));

  const t0 = Date.now();
  const rep = await fix.runLeagueFix(now);
  assert.ok(rep.groups, JSON.stringify(rep));
  const g = k => rep.groups.find(x => x.group === k);
  const lg = c => rep.leagues.find(x => x.comp === c);
  assert.ok(g('second').applied, `second tiers: ${g('second').action} — ${g('second').verdicts.map(v => `${v.cand}/${v.variant}: ${v.why}`).join(' | ')}`);
  assert.ok(g('second').after.logLoss < g('second').before.logLoss);
  assert.ok(g('second').after.drawPicks >= g('second').before.drawPicks);
  assert.equal(lg('AF42').via, 'group', 'League Two (25 games) gets the group setting');
  assert.equal(lg('AF136').via, 'group');
  assert.equal(g('europe').applied, null, g('europe').action);
  assert.equal(g('asia').applied, null, g('asia').action);
  assert.match(g('asia').action, /rolled back/);
  assert.deepEqual(rep.rolledBack.map(x => x.unit), ['g:asia']);
  assert.equal(g('asia').nBacktest, 1500);
  assert.equal(lg('ELC').own?.n, lg('ELC').n, 'a league with 150+ games gets its own test too');
  assert.equal(lg('AF42').own, null);
  assert.ok(rep.totals.after.logLoss < rep.totals.before.logLoss);
  assert.ok(rep.table.every(t => t.before.hit < 52));
  assert.equal(rep.totals.record, [...elc, ...sb, ...l2, ...j1, ...ned].filter(x => x.t >= from && x.t <= now).length);
  console.log(`  run: ${Date.now() - t0} ms on ${rep.totals.record} record + ${rep.totals.backtest} backtest games`);

  // live: second tiers (group) apply to League Two too; the Eredivisie and J1 unchanged
  const preds = [{ model: 'grid-v3', home: 55, draw: 22, away: 23 }, { model: 'feat-v1', home: 55, draw: 22, away: 23 }];
  const out = live.applyLeagueFix({ id: 1, competition: { code: 'AF42', name: 'League Two' } }, preds);
  assert.ok(out[0].home < 55 && out[0].draw > 22, JSON.stringify(out[0]));
  assert.ok(Math.abs(out[0].home + out[0].draw + out[0].away - 100) < 1e-9);
  assert.deepEqual(out[0].league.raw, [55, 22, 23]);
  assert.deepEqual(out[1], preds[1], 'feat-v1 is never moved');
  assert.deepEqual(live.applyLeagueFix({ id: 2, competition: { code: 'DED' } }, preds), preds);
  assert.deepEqual(live.applyLeagueFix({ id: 2, competition: { code: 'AF98' } }, preds), preds);
  assert.deepEqual(live.applyLeagueFix({ id: 3, competition: { code: 'AF42' } }, out), out, 'never moved twice');
  // a league never seen by the test still finds its group by name
  assert.ok(live.applyLeagueFix({ id: 4, competition: { code: 'AF999', name: 'Ligue 2' } }, preds)[0].league);

  // the model's own numbers are read back: layer_raw first, then p_pre (fix254), then the saved split
  db.prepare(`UPDATE predictions SET p_home = 10, p_draw = 10, p_away = 80, layer_raw = '[50,25,25]' WHERE match_id = ?`).run(ned[300].id);
  db.prepare(`UPDATE predictions SET p_home = 10, p_draw = 10, p_away = 80, p_pre = '[40,30,30]' WHERE match_id = ?`).run(ned[301].id);
  const rec = await fix.loadRecord(now + 1);
  const byId = id => rec.find(x => x.id === id).p;
  assert.ok(close(byId(ned[300].id), [0.5, 0.25, 0.25]));
  assert.ok(close(byId(ned[301].id), [0.4, 0.3, 0.3]));

  const h = health.leagueFixHealth();
  assert.equal(h[0].id, 'leagues-under-50');
  assert.ok(fix.lastLeagueFix().builtAt);
});
