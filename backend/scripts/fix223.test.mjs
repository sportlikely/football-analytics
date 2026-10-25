// fix223: per-league settings — shrinkage (fewer games = closer to the shared settings), the gate (own settings kept only
// when they beat the shared model on the test season; a league without a real difference stays shared), small leagues by
// group, no 2025-26 / 2026-27 game in any fit, the probability-level version (American football levels, tennis), the
// stored settings follow their shared base, data health "League settings fresh". (dist build)
// Run: npm run test:fix223
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix223-'));
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'warn';
process.env.THREAD_JOBS = '0';
const require = createRequire(import.meta.url);
const M = require('../dist/utils/bbGridMath.js');
const L = require('../dist/utils/leagueSettings.js');

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const gauss = r => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
const W = M.GRID_ROWS.map((_, i) => [0.4, 0, 0.9, 1, 0, 1, 0.5, 0, 0, 0, 0, 0, 0][i]);
const SHARED = { ...M.GRID_START, w: W, version: 'test', fittedAt: 'x' };

/** grid games of one league: the result drawn with an extra home edge `home` (points) */
function games(code, n, seed, home = 0, years = [2022, 2023, 2024, 2025, 2026]) {
  const r = rng(seed), out = [];
  for (let k = 0; k < n; k++) {
    const hv = [], av = [];
    for (let i = 0; i < M.N_ROWS; i++) { const s = i === M.VOL ? 0 : i === 5 ? 0.5 : 4; hv.push(gauss(r) * s); av.push(gauss(r) * s); }
    hv[6] = 2; av[6] = 0; // a home court (not neutral)
    const year = years[k % years.length];
    const it = { id: k + 1, code, season: `${year}-${year + 1}`, year, gp: 30, sig: 12, hv, av, oracle: null, v3: 0.5 };
    const e = M.gridEval(SHARED, code, it);
    const mg = e.margin + home + gauss(r) * 12;
    out.push({ ...it, y: mg > 0 ? 1 : 0, mg, league: code });
  }
  return out;
}
async function select(items) {
  const spreads = new Map();
  const all = years => { const k = years.join(); if (!spreads.has(k)) spreads.set(k, M.spreadOf(SHARED, items.filter(x => years.includes(x.year)))); return spreads.get(k); };
  const seen = [];
  const res = await L.tuneLeagueSettings(items, {
    groupOf: c => (c.startsWith('S') ? 'Asia' : null),
    fit: (l, years) => { seen.push(...l.map(x => x.year)); return M.fitLeagueSet(l, SHARED, all(years), 'own', null); },
    ll: (l, s) => M.logLoss(s ? { ...SHARED, league: Object.fromEntries([...new Set(l.map(x => x.code))].map(c => [c, s])) } : SHARED, l)
  });
  return { res, seen };
}

test('gate: a league with a real extra home edge gets its own settings, a league without one stays shared', async () => {
  const items = [...games('HOME', 6000, 1, 4), ...games('SAME', 6000, 2, 0)];
  const { res, seen } = await select(items);
  const home = res.leagues.find(x => x.league === 'HOME'), same = res.leagues.find(x => x.league === 'SAME');
  assert.equal(home.used, 'own', home.why);
  assert.ok(home.settings.home > 2 && home.settings.home < 6, `home edge ${home.settings.home} (true 4)`);
  assert.ok(home.test.gain > L.LS_MIN_GAIN);
  assert.ok(home.check.used < home.check.shared, 'the untouched check agrees');
  assert.equal(same.used, 'shared', same.why);
  // no fit ever saw the untouched check or the live period
  assert.ok(seen.length > 0 && seen.every(y => y <= 2024), `fit years ${[...new Set(seen)]}`);
});

test('never tuned on 2025-26 (check) or 2026-27+ (live)', () => {
  assert.throws(() => L.assertLsYears([2026]));
  assert.throws(() => L.assertLsYears([2024, 2025]));
  assert.throws(() => L.assertLsYears([]));
  assert.doesNotThrow(() => L.assertLsYears(L.LS_REFIT));
  assert.ok(L.LS_FIT.every(y => y < L.LS_TEST) && L.LS_REFIT.every(y => y < L.LS_CHECK && y < L.LS_LIVE_FROM));
  // the tennis periods: fit 2024, test 2025 H1, check 2025 H2, live 2026
  const T = { fit: [2024, 2024.5], test: 2025, refit: [2024, 2024.5, 2025], check: 2025.5, liveFrom: 2026 };
  assert.throws(() => L.assertLsYears([2025.5], T));
  assert.doesNotThrow(() => L.assertLsYears(T.refit, T));
});

test('shrinkage: the same true difference moves a small league less than a big one', async () => {
  const fit = async n => {
    const l = games('X', n, 7, 4, [2022, 2023]);
    return M.fitLeagueSet(l, SHARED, M.spreadOf(SHARED, l), 'own', null);
  };
  const small = await fit(150), big = await fit(8000);
  assert.ok(Math.abs(small.home) < Math.abs(big.home), `small ${small.home} vs big ${big.home}`);
  // with a stronger pull the fit stays nearer the shared settings
  const l = games('X', 400, 9, 4, [2022, 2023]);
  const weak = await M.fitLeagueSet(l, SHARED, M.spreadOf(SHARED, l), 'own', null, { shrink: 0.2 });
  const strong = await M.fitLeagueSet(l, SHARED, M.spreadOf(SHARED, l), 'own', null, { shrink: 20 });
  assert.ok(Math.abs(strong.home) < Math.abs(weak.home), `pull 20: ${strong.home} vs pull 0.2: ${weak.home}`);
  assert.equal(L.shrinkPenalty([{ get: () => 1, at: 0, tau: 1 }], 100) * 2, L.shrinkPenalty([{ get: () => 1, at: 0, tau: 1 }], 50));
});

test('groups: small leagues are fitted together and use the group when it passes', async () => {
  const items = [...games('S1', 250, 11, 5), ...games('S2', 250, 12, 5), ...games('S3', 250, 13, 5), ...games('BIG', 3000, 14, 0)];
  const { res } = await select(items);
  const g = res.groups.find(x => x.group === 'Asia');
  assert.deepEqual(g.members, ['S1', 'S2', 'S3']);
  assert.ok(g.pass, g.why);
  for (const c of ['S1', 'S2', 'S3']) { const r = res.leagues.find(x => x.league === c); assert.equal(r.used, 'group'); assert.equal(r.settings, g.settings); }
  assert.ok(M.regionGroup('Japan') === 'Asia' && M.regionGroup('Brazil') === 'Americas' && M.regionGroup('Australia') === 'Oceania');
  assert.equal(M.regionGroup('Israel'), 'Europe second tier');
  assert.equal(M.regionGroup('Lithuania'), 'Europe second tier');
});

test('grid: the settings change the margin, the sigma and the split (home edge on #7, none on a neutral court)', () => {
  const it = games('A', 1, 5)[0];
  const set = { src: 'own', group: null, home: 3, str: 1.1, sig: 0.9, off: M.GRID_ROWS.map((_, i) => (i === 2 ? 0.1 : 0)), n: 1000 };
  const p = { ...SHARED, league: { A: set } };
  const a = M.gridEval(SHARED, 'A', it), b = M.gridEval(p, 'A', it);
  assert.ok(Math.abs(b.margin - (a.margin + 3 + 0.1 * M.diff(it, 2))) < 1e-9);
  assert.ok(Math.abs(b.sigma - a.sigma * 0.9) < 1e-9);
  const neutral = { ...it, hv: it.hv.map((v, i) => (i === 6 ? 0 : v)), av: it.av.map((v, i) => (i === 6 ? 0 : v)) };
  assert.ok(Math.abs(M.gridEval(p, 'A', neutral).margin - M.gridEval({ ...SHARED, league: { A: { ...set, home: 0 } } }, 'A', neutral).margin) < 1e-9);
  const v = M.split1000(p, 'A', it, M.GRID_ROWS.map(() => 4));
  assert.equal(v.rows.reduce((s, r) => s + r.edge, 0), v.points.home - 500);
  assert.ok(v.rows.some(r => r.id === '#7'));
});

test('probability level: stretch / home edge found, symmetric tennis has no home edge', async () => {
  const r = rng(3), items = [];
  for (let k = 0; k < 20000; k++) {
    const z = gauss(r) * 0.8, year = [2022, 2023, 2024, 2025, 2026][k % 5];
    const pTrue = L.Phi(1.25 * z + 0.15);
    items.push({ league: k % 2 ? 'NFL' : 'FCS', year, p: L.Phi(z), y: r() < pTrue ? 1 : 0, home: true });
  }
  const S = await L.probSettings(items, { groupOf: x => (x === 'NFL' ? null : 'College'), symmetric: false });
  for (const lv of ['NFL', 'FCS']) {
    const s = S.used[lv];
    assert.ok(s && s.src === 'own', lv);
    assert.ok(Math.abs(s.stretch - 1.25) < 0.12 && Math.abs(s.home - 0.15) < 0.06, `${lv}: ${JSON.stringify(s)}`);
  }
  assert.ok(S.total.check.used < S.total.check.shared);
  const sym = await L.fitProbSet(items.slice(0, 4000), true);
  assert.equal(sym.home, 0);
  assert.ok(Math.abs(L.applyProbSet(sym, 0.5) - 0.5) < 1e-9, 'symmetric: a coin flip stays a coin flip');
  assert.ok(Math.abs(L.probitOf(L.Phi(0.7)) - 0.7) < 1e-3);
});

test('American football levels and tennis segments', () => {
  const S = require('../dist/services/afCalibState.js');
  const t = (conf, level) => ({ conf, level });
  assert.equal(S.levelOfTeams(t('SEC', 'FBS'), t('Big Ten', 'FBS')), 'FBS');
  assert.equal(S.levelOfTeams(t('SEC', 'FBS'), t('Mountain West', 'FBS')), 'G5');
  assert.equal(S.levelOfTeams(t('Sun Belt', 'FBS'), t('MAC', 'FBS')), 'G5');
  assert.equal(S.levelOfTeams(t('SEC', 'FBS'), t('Big Sky', 'FCS')), 'FCS');
  const T = require('../dist/services/tennisModel.js');
  assert.equal(T.tennisSegment('atp', 1), 'atp·clay');
  assert.ok(T.TENNIS_LS_YEARS.refit.every(y => y < T.TENNIS_LS_YEARS.check));
});

test('stored league settings are used only on the shared settings they were fitted on; data health line', async () => {
  const { db } = require('../dist/db/index.js');
  require('../dist/services/basketball.js');
  const B = require('../dist/services/bbTuner.js');
  const H = require('../dist/services/leagueSettingsHealth.js');
  assert.equal(B.leagueTuneDue(), 'first league fit on this database');
  const set = { src: 'own', group: null, home: 1, str: 1, sig: 1, off: new Array(13).fill(0), n: 500 };
  const at = new Date().toISOString();
  db.prepare(`INSERT OR REPLACE INTO bb_tuned (id, params, report, at) VALUES ('leagues', ?, ?, ?)`).run(JSON.stringify({ base: B.baseKey(B.sharedParams()), league: { NBA: set } }), JSON.stringify({ leagues: [{ league: 'NBA', used: 'own', test: { gain: 0.001 } }] }), at);
  assert.equal(B.storedParams().league.NBA.home, 1);
  assert.equal(B.leagueTuneDue(), null);
  assert.equal(H.leagueSettingsHealth().find(x => x.id === 'league-settings-basketball').level, 'ok');
  // a new shared tune stored: the league settings are stale (not used) and due again
  db.prepare(`INSERT OR REPLACE INTO bb_tuned (id, params, report, at) VALUES ('live', ?, NULL, ?)`).run(JSON.stringify({ ...B.sharedParams(), version: 'fit later', fittedAt: at }), at);
  assert.equal(B.storedParams().league, undefined);
  assert.match(B.leagueTuneDue(), /shared settings changed/);
  assert.equal(H.leagueSettingsHealth().find(x => x.id === 'league-settings-basketball').level, 'warn');
  // freshness: 35 days allowed
  assert.equal(H.freshLine('nfl', new Date(Date.now() - 40 * 86400000).toISOString(), []).level, 'warn');
  assert.equal(H.freshLine('nfl', new Date(Date.now() - 3 * 86400000).toISOString(), [{ league: 'NFL', used: 'own' }]).level, 'ok');
  assert.equal(H.freshLine('tennis', null, []).level, 'warn');
  // fix223: the shared tune's first store on a database follows the gate (fix222's run that stored nothing is due again)
  db.exec(`DELETE FROM bb_tuned WHERE id IN ('live', 'auto')`);
  db.prepare(`INSERT INTO bb_tuned (id, params, report, at) VALUES ('auto', '{}', ?, ?)`).run(JSON.stringify({ at, applied: false, reason: 'not applied: test log loss 0.5775 vs 0.5774' }), at);
  assert.match(B.autoTuneDue(), /first tune stored/);
});
