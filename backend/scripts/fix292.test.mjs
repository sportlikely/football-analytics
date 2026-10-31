// fix292: college football (FBS) — the college layer refit on 2025 + 2026 out of fold (separate FBS layer only when it
// beats one shared college layer on unseen games), the lab (walk-forward 2023–2026, nothing fitted on 2026, rows from
// earlier games only, every candidate in the table, the promotion rule) and the whole pipeline on a scratch database
// (lab → layer → refit → shown chance uses the refit → saved predictions). (dist build)
// Run: npm run test:fix292   (SHOW=1 prints the lab table)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix292-'));
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'warn';
process.env.THREAD_JOBS = '0';
const require = createRequire(import.meta.url);
const L = require('../dist/utils/collegeLab.js');

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const gauss = r => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
const sig = x => 1 / (1 + Math.exp(-x));
const logit = p => Math.log(p / (1 - p));
const DAY = 86400000;

/* ---------- the refit ---------- */

function refitRows({ fbsK = 1.8, otherK = 1.8, n = 1600, seed = 7 } = {}) {
  const r = rng(seed), rows = [];
  for (let i = 0; i < n; i++) {
    const season = i < n / 2 ? 2025 : 2026, level = ['fbs', 'fbs', 'mismatch', 'fcs'][i % 4];
    const pt = sig(gauss(r) * 0.9 + 0.15), k = level === 'fbs' ? fbsK : otherK, p = sig(k * logit(pt));
    rows.push({ id: i, p, y: r() < pt ? 1 : 0, season, t: Date.parse(`${season}-09-01T00:00:00Z`) + Math.floor(i / 40) * 7 * DAY / 4, level, cur: p });
  }
  return rows;
}

test('refit: FBS over-confident, the rest honest → a separate FBS layer; the same everywhere → one shared layer', () => {
  const a = L.refitCollege(refitRows({ fbsK: 1.9, otherK: 1.0 }));
  assert.equal(a.refit.mode, 'fbs', a.why);
  assert.ok(a.refit.fbs && a.refit.fbs.a < 0.75, `the FBS slope shrinks the chances (${a.refit.fbs?.a})`);
  assert.ok(a.scores.split.fbs.logLoss < a.scores.raw.fbs.logLoss, 'out of fold better than raw on FBS');
  const b = L.refitCollege(refitRows({ fbsK: 1.6, otherK: 1.6, seed: 9 }));
  assert.equal(b.refit.mode, 'shared', b.why);
  assert.equal(b.refit.fbs, null);
  // applied: the FBS layer only on FBS games; shared elsewhere; 'kept' = the old layer
  const pF = L.applyRefit(a.refit, 0.85, true), pO = L.applyRefit(a.refit, 0.85, false);
  assert.ok(pF < 0.85 && pF < pO, `${pF} ${pO}`);
  assert.equal(L.applyRefit({ ...a.refit, mode: 'kept' }, 0.85, true), null);
  assert.equal(L.applyRefit(null, 0.85, true), null);
  // the refit must not be worse than the current layer on 2026: an already good current layer stays
  const good = refitRows({ fbsK: 1.9, otherK: 1.0, seed: 11 }).map(x => ({ ...x, cur: sig(logit(x.p) / (x.level === 'fbs' ? 1.9 : 1)) }));
  const c = L.refitCollege(good);
  assert.ok(['fbs', 'kept'].includes(c.refit.mode), c.why);
  assert.equal(L.refitCollege(refitRows({ n: 60 })).refit.mode, 'kept');
});

/* ---------- the promotion rule ---------- */

const S = (ll, n = 500) => ({ games: n, logLoss: ll, brier: 0.2, hit: 60 });
const row = (id, ll, fbs, ll26) => ({ id, label: id, seasons: {}, total: { all: S(ll), fbs: S(fbs) }, s2026: ll26 === undefined ? null : { all: S(ll26, 300), fbs: S(ll26, 150) }, bands: [], bandsFbs: [], vsMarket: null });

test('promotion: only out of sample, by the margin, not worse on FBS and on 2026 so far', async () => {
  assert.equal(L.pickWinner([row('ncaa-v2', 0.60, 0.64, 0.62), row('trees', 0.595, 0.63, 0.61)], 'ncaa-v2').promote, true);
  assert.equal(L.pickWinner([row('ncaa-v2', 0.60, 0.64, 0.62), row('trees', 0.599, 0.63, 0.61)], 'ncaa-v2').promote, false, 'under the margin');
  assert.equal(L.pickWinner([row('ncaa-v2', 0.60, 0.64, 0.62), row('trees', 0.59, 0.65, 0.61)], 'ncaa-v2').promote, false, 'worse on FBS');
  assert.equal(L.pickWinner([row('ncaa-v2', 0.60, 0.64, 0.62), row('trees', 0.59, 0.63, 0.63)], 'ncaa-v2').promote, false, 'worse on 2026');
  const w = L.pickWinner([row('ncaa-v1', 0.62, 0.66), row('elo', 0.61, 0.65), row('rows', 0.605, 0.64)], 'ncaa-v1');
  assert.equal(w.winner, 'rows');
  assert.match(w.reason, /promoted \(ncaa-v3\)/);
  assert.throws(() => L.assertLabFit([2024, 2026]), /2026/);
  await assert.rejects(() => L.fitCand('rows', [{ r: { season: 2026, y: 1, elo: 0, talent: 0, talE: 0, ret: 0, home: 0, conf: 0, g5p4: 0, mis: 0 }, base: 0.6 }]), /2026/);
});

/* ---------- a synthetic college league with rosters, home crowds and closing lines ---------- */

const CONF = ['SEC', 'Mountain West', 'Big Sky'];
function league(seed = 21) {
  const r = rng(seed);
  let pid = 1;
  const teams = Array.from({ length: 40 }, (_, i) => ({
    id: 700 + i, name: `Lab U${i}`, conf: i < 12 ? CONF[0] : i < 24 ? CONF[1] : CONF[2], level: i < 24 ? 'FBS' : 'FCS', city: 'Town, AL',
    s: (i < 12 ? 8 : i < 24 ? 2 : -9) + gauss(r) * 5, crowd: i % 4 === 0 ? 7 : 1.5, players: Array.from({ length: 12 }, () => pid++)
  }));
  const games = [], lines = [];
  let id = 120000;
  for (let season = 2019; season <= 2026; season++) {
    for (const t of teams) {
      // returning production: a share of last season's players stay; the strength keeps that share, the rest is new
      const keep = 0.3 + 0.6 * r();
      const mean = t.level === 'FBS' ? (t.conf === 'SEC' ? 8 : 2) : -9;
      t.s = keep * t.s + (1 - keep) * (mean + gauss(r) * 6);
      t.players = t.players.map(p => (r() < keep ? p : pid++));
    }
    const first = Date.parse(`${season}-08-31T18:00:00Z`);
    for (let w = 0; w < 12; w++) {
      const ko = new Date(first + w * 7 * DAY).toISOString();
      const shuffle = list => { const a = [...list]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
      const pairs = [];
      if (w < 3) {
        const fbs = shuffle(teams.filter(t => t.level === 'FBS')), fcs = shuffle(teams.filter(t => t.level === 'FCS'));
        fcs.forEach((t, i) => pairs.push([fbs[i], t]));
        for (let i = fcs.length; i + 1 < fbs.length; i += 2) pairs.push([fbs[i], fbs[i + 1]]);
      } else for (const c of CONF) { const l = shuffle(teams.filter(t => t.conf === c)); for (let i = 0; i + 1 < l.length; i += 2) pairs.push([l[i], l[i + 1]]); }
      for (const [h, a] of pairs) {
        const future = Date.parse(ko) > Date.parse('2026-10-20T00:00:00Z');
        const mu = h.s - a.s + h.crowd;
        let m = Math.round(mu + gauss(r) * 13);
        if (m === 0) m = 3;
        let hs = Math.max(0, Math.round(27 + m / 2)), as_ = hs - m;
        if (as_ < 0) { hs -= as_; as_ = 0; }
        const g = { id: id++, season, ko, h, a, hs: future ? null : hs, as: future ? null : as_, status: future ? 'NS' : 'FT' };
        games.push(g);
        if (season === 2026 && !future) lines.push({ id: g.id, p: sig(logit(Math.min(0.99, Math.max(0.01, 0.5 + 0.5 * Math.tanh(mu / 16)))) + gauss(r) * 0.2), ko });
      }
    }
  }
  return { teams, games, lines };
}
/** a team's box score in the provider's shape: every player a few rushing yards and tackles */
const boxJson = (t, r) => JSON.stringify([
  { name: 'Rushing', players: t.players.slice(0, 6).map(p => ({ player: { id: p, name: `P${p}` }, statistics: [{ name: 'yards', value: String(Math.round(20 + 30 * r())) }] })) },
  { name: 'Defensive', players: t.players.slice(6).map(p => ({ player: { id: p, name: `P${p}` }, statistics: [{ name: 'total tackles', value: String(Math.round(1 + 6 * r())) }] })) }
]);

test('lab rows use only earlier games (changing later results changes no earlier row)', async () => {
  const { teams, games } = league();
  const T = new Map(teams.map(t => [t.id, { conf: t.conf, level: t.level, power: t.conf === 'SEC' }]));
  const G = gs => gs.map(g => ({ id: g.id, season: g.season, t: Date.parse(g.ko), h: g.h.id, a: g.a.id, hs: g.hs, as: g.as, done: g.status === 'FT', neutral: false }));
  const a = await L.labPass(G(games), T, new Map(), L.ELO0);
  const cut = Date.parse('2024-10-01T00:00:00Z');
  const b = await L.labPass(G(games.map(g => (Date.parse(g.ko) >= cut && g.hs !== null ? { ...g, hs: g.as, as: g.hs } : g))), T, new Map(), L.ELO0);
  const before = new Set(games.filter(g => Date.parse(g.ko) < cut).map(g => g.id));
  let n = 0;
  for (let i = 0; i < a.length; i++) if (before.has(a[i].id)) { n++; assert.deepEqual(b[i], a[i]); }
  assert.ok(n > 1000);
  assert.ok(a.some((x, i) => !before.has(x.id) && x.done && x.elo !== b[i].elo), 'later rows move');
});

test('team seasons: returning production and talent (transfers count, level-weighted)', () => {
  const T = new Map([[1, { conf: 'SEC', level: 'FBS', power: true }], [2, { conf: 'Big Sky', level: 'FCS', power: false }]]);
  const prod = new Map([['2024|1|10', 50], ['2024|1|11', 50], ['2025|1|10', 40], ['2024|2|20', 80], ['2025|1|20', 30]]);
  const ts = L.teamSeasons(prod, T);
  assert.equal(ts.get('2025|1').ret, 0.5); // player 10 of 10 + 11 stayed
  assert.ok(ts.get('2025|1').talent !== undefined);
});

test('the lab + refit on a scratch database: table, nothing fitted on 2026, shown chance from the refit', { timeout: 900000 }, async () => {
  const { db } = require('../dist/db/index.js');
  require('../dist/services/nfl.js');
  require('../dist/services/marketAnchor.js');
  const NM = require('../dist/services/nflModel.js');
  const AC = require('../dist/services/afCalibration.js');
  const AS = require('../dist/services/afCalibState.js');
  const { teams, games, lines } = league();
  const now = new Date().toISOString();
  const insT = db.prepare(`INSERT INTO nfl_teams (team_id, name, city, conference, level, league, updated_at) VALUES (?, ?, ?, ?, ?, 2, ?)`);
  for (const t of teams) insT.run(t.id, t.name, t.city, t.conf, t.level, now);
  const soon = new Date(Date.now() + 2 * DAY).toISOString();
  const firstFuture = games.find(g => g.status === 'NS').ko;
  const insG = db.prepare(`INSERT INTO nfl_games (game_id, season, week, stage, kickoff, home_id, home_name, away_id, away_name, status, home_pts, away_pts, venue, league, updated_at) VALUES (?, ?, ?, 'Regular Season', ?, ?, ?, ?, ?, ?, ?, ?, NULL, 2, ?)`);
  const insP = db.prepare(`INSERT INTO nfl_player_stats (game_id, team_id, json) VALUES (?, ?, ?)`);
  const r = rng(5);
  db.exec('BEGIN');
  for (const g of games) {
    insG.run(g.id, g.season, 'Week', g.status === 'NS' && g.ko === firstFuture ? soon : g.ko, g.h.id, g.h.name, g.a.id, g.a.name, g.status, g.hs, g.as, now);
    if (g.status === 'FT') { insP.run(g.id, g.h.id, boxJson(g.h, r)); insP.run(g.id, g.a.id, boxJson(g.a, r)); }
  }
  const insL = db.prepare(`INSERT INTO market_lines (sport, game_id, market, closing, line, prices, books, at, kickoff, league) VALUES ('nfl', ?, 'ml', 1, NULL, ?, 5, ?, ?, '2')`);
  for (const l of lines) insL.run(l.id, JSON.stringify({ prices: {}, p: { Home: l.p, Away: 1 - l.p } }), l.ko, l.ko);
  db.exec('COMMIT');
  await NM.retrain(2);
  const report = await AC.buildAfCalibration();
  assert.ok(report?.lab, 'the lab ran');
  const lab = report.lab;
  if (process.env.SHOW) {
    const f = s => (s && s.games ? `${s.hit}% ${s.logLoss}` : '–');
    for (const t of lab.table) console.log([t.id.padEnd(8), ...[2023, 2024, 2025, 2026].map(s => f(t.seasons[s]?.all).padEnd(13)), 'FBS 23–25', f(t.total.fbs), 'vs line', t.vsMarket ? `${t.vsMarket.ll} / ${t.vsMarket.market} (${t.vsMarket.games})` : '–'].join(' '));
    console.log(lab.reason, JSON.stringify(lab.market.anchor.anchor), JSON.stringify(report.college2026?.why));
  }
  const ids = lab.table.map(t => t.id);
  for (const id of ['ncaa-v1', 'elo', 'talent', 'home', 'conf', 'rows', 'trees']) assert.ok(ids.includes(id), `${id} in the table`);
  for (const t of lab.table) for (const s of Object.keys(t.seasons)) assert.ok([2023, 2024, 2025, 2026].includes(Number(s)));
  for (const [S, on] of Object.entries(lab.fitOn)) assert.ok(Math.max(...on) < Number(S) && Math.max(...on) <= 2025, `Elo of ${S} tuned on ${on}`);
  assert.ok(lab.table.find(t => t.id === 'elo').seasons[2026], '2026 so far is scored');
  assert.ok(lab.table.find(t => t.id === 'rows').vsMarket?.games > 50, 'scored against the closing line');
  assert.ok(lab.market.closingLines >= lines.length);
  assert.equal(typeof lab.promoted, 'boolean');
  assert.ok(lab.roster.withRet > 100, 'returning production found');
  // the college layer refit (fix292 part 1)
  assert.ok(report.college2026, 'refit report');
  const st = AS.afCalibState();
  assert.ok(st.leagues[2].refit, 'refit stored');
  assert.ok(['fbs', 'shared', 'kept'].includes(st.leagues[2].refit.mode));
  assert.deepEqual(st.leagues[2].refit.seasons.filter(s => s < 2025), []);
  if (st.leagues[2].refit.mode !== 'kept') {
    const [h, a] = [teams[0].id, teams[1].id];
    const want = L.applyRefit(st.leagues[2].refit, 0.8, true);
    assert.ok(Math.abs(AS.calibrated(2, 0.8, 'conf', { h, a, neutral: true }) - want) < 1e-9, 'shown chance = the refit on an FBS game');
  }
  assert.equal(st.lab, lab.promoted);
  // predictions saved with the live model (ncaa-v3 when promoted)
  await AC.refreshNcaaV2();
  await AC.refreshCollegeLab();
  assert.ok(await NM.saveNflPredictions() > 0);
  const models = db.prepare(`SELECT DISTINCT model FROM nfl_predictions`).all().map(x => x.model);
  if (lab.promoted) assert.ok(models.includes('ncaa-v3'), models.join());
  else assert.ok(!models.includes('ncaa-v3'));
  // the daily refit runs on its own
  const out = await AC.refitCollegeLayer();
  assert.ok(out && out.refit.games > 300, `refit on ${out?.refit.games} games`);
});
