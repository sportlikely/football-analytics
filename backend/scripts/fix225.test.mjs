// fix225: key players count more — the box-score value (BPM-style) sums to the team's net rating, the formula is fitted
// on game margins (and never on 2025-26 / 2026-27), the on/off shrink scaled by minutes, the star factor's bounds, the
// impact variants of the stored rows, the replay on a scratch league (the star on top), the fit + gate end to end, the
// key players card. (dist build) Run: npm run test:fix225
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix225-'));
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'warn';
process.env.THREAD_JOBS = '0';
const require = createRequire(import.meta.url);
const B = require('../dist/utils/boxValue.js');
const M = require('../dist/utils/bbGridMath.js');
const I = require('../dist/utils/nbaImpact.js');
const K = require('../dist/utils/keyPlayers.js');
const { db } = require('../dist/db/index.js');
require('../dist/services/basketball.js');
require('../dist/services/nbaV4.js');
const G = require('../dist/services/bbGrid.js');
const T = require('../dist/services/bbTuner.js');

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const gauss = r => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
const tot = (min, pts, fga, fta, tpm, reb, ast) => ({ min, pts, fga, fta, tpm, reb, ast });

test('box-score value: a team\'s players sum to its net rating per game; traded players; carry-over; draft prior', () => {
  const L = 48, G0 = 40;
  // two teams, 8 players each, 40 games (9,600 minutes): a star, starters, bench
  const team = (t, star) => [
    { id: t * 100 + 1, team: t, tot: star ? tot(1440, 1150, 720, 330, 60, 500, 380) : tot(1400, 760, 640, 160, 70, 220, 160) },
    { id: t * 100 + 2, team: t, tot: tot(1360, 640, 520, 120, 90, 260, 120) },
    { id: t * 100 + 3, team: t, tot: tot(1300, 520, 450, 90, 80, 300, 90) },
    { id: t * 100 + 4, team: t, tot: tot(1280, 480, 420, 100, 40, 420, 70) },
    { id: t * 100 + 5, team: t, tot: tot(1200, 400, 360, 80, 60, 180, 200) },
    { id: t * 100 + 6, team: t, tot: tot(1100, 330, 320, 60, 50, 150, 80) },
    { id: t * 100 + 7, team: t, tot: tot(1000, 260, 260, 50, 30, 200, 60) },
    { id: t * 100 + 8, team: t, tot: tot(920, 200, 220, 40, 20, 120, 50) }
  ];
  const stints = [...team(1, true), ...team(2, false)];
  const pace = new Map([[1, 1.02], [2, 0.98]]), net = new Map([[1, 5.5], [2, -3.25]]), games = new Map([[1, G0], [2, G0]]);
  const lg = B.leagueRates(stints.map(s => ({ tot: s.tot, paceAdj: pace.get(s.team) })), L);
  const v = B.stintValues(stints, B.BOX_DEFAULT.c, L, lg, pace, net, games);
  for (const t of [1, 2]) {
    const sum = stints.filter(s => s.team === t).reduce((a, s) => a + (v.get(s.id).v * s.tot.min) / (G0 * L), 0);
    assert.ok(Math.abs(sum - net.get(t)) < 1e-9, `team ${t}: players sum ${sum}, net ${net.get(t)}`);
  }
  // the star (Jokić-like: points on few shots, rebounds, assists) is the best player and worth a lot
  const best = [...v].sort((a, b) => b[1].v - a[1].v)[0];
  assert.equal(best[0], 101);
  assert.ok(best[1].v > 6, `star ${best[1].v} points per 48`);
  // a traded player: the minutes-weighted mean of his two stints (each with its own team's adjustment)
  const traded = [...stints, { id: 999, team: 1, tot: tot(300, 120, 100, 20, 10, 60, 30) }, { id: 999, team: 2, tot: tot(600, 260, 200, 40, 20, 100, 50) }];
  const v2 = B.stintValues(traded, B.BOX_DEFAULT.c, L, lg, pace, net, games);
  // each stint = its raw value + its own team's adjustment (computed over that team's stints, the trade included)
  const stintV = t => {
    const list = traded.filter(x => x.team === t).map(x => ({ id: x.id, min: x.tot.min, raw: B.rawValue(B.BOX_DEFAULT.c, B.ratesOf(x.tot, L, pace.get(t)), lg) }));
    const adj = B.teamAdjust(list, net.get(t), G0, L);
    return list.find(x => x.id === 999).raw + adj;
  };
  assert.ok(Math.abs(v2.get(999).v - (stintV(1) * 300 + stintV(2) * 600) / 900) < 1e-9);
  // and each team still sums to its net rating with him in it
  for (const t of [1, 2]) {
    const sum = traded.filter(x => x.team === t).reduce((acc, x) => acc + ((x.id === 999 ? stintV(t) : v2.get(x.id).v) * x.tot.min) / (G0 * L), 0);
    assert.ok(Math.abs(sum - net.get(t)) < 1e-9);
  }
  assert.equal(v2.get(999).min, 900);
  // carry-over: last season's value until this season's minutes take over (full at 800; FIBA 667)
  assert.equal(B.fullMinutes(48), 800);
  assert.equal(B.fullMinutes(40), 667);
  assert.equal(B.carry(undefined, 4, 800), 4);
  assert.equal(B.carry({ v: 8, min: 400 }, 4, 800), 6);
  assert.equal(B.carry({ v: 8, min: 2400 }, 4, 800), 8);
  // rookies: draft slot (no draft info = −1, 2nd round / undrafted −2)
  assert.equal(B.draftPrior(1, 1), 0);
  assert.equal(B.draftPrior(30, 1), -1.93);
  assert.equal(B.draftPrior(45, 2), -2);
  assert.equal(B.draftPrior(null, null), -2);
  assert.equal(B.draftPrior(undefined, undefined), -1);
  assert.ok(B.draftPrior(3, 1) > B.draftPrior(20, 1));
});

test('the formula fitted on game margins finds the true coefficients; FIBA scaled; never on 2025-26 or 2026-27', async () => {
  const r = rng(5), truth = [0.8, -0.75, 0.35, 0.3, 0.6];
  const games = [];
  for (let k = 0; k < 4000; k++) {
    const L = k % 3 ? 48 : 40;
    const side = () => Array.from({ length: 9 }, () => [L * (0.2 + 0.6 * r()) * (5 / 9) * 2 * 0.5, [gauss(r) * 6, gauss(r) * 5, gauss(r) * 1.5, gauss(r) * 3, gauss(r) * 2.5]]);
    const h = side(), a = side();
    const val = s => s.reduce((acc, [min, z]) => acc + (min / L) * z.reduce((q, x, i) => q + truth[i] * x, 0), 0);
    games.push({ home: h, away: a, L, margin: 2.5 + val(h) - val(a) + gauss(r) * 11 });
  }
  const f = B.fitBoxCoef(games, 0.001);
  f.c.forEach((c, i) => assert.ok(Math.abs(c - truth[i]) < 0.12, `coefficient ${i}: ${c} (true ${truth[i]})`));
  assert.ok(Math.abs(f.home - 2.5) < 0.6, `home ${f.home}`);
  assert.throws(() => B.assertBoxTrain([2024, 2025]));
  assert.throws(() => B.assertBoxTrain([2026]));
  assert.doesNotThrow(() => B.assertBoxTrain([2022, 2023, 2024]));
  await assert.rejects(() => G.fitBoxFormula([2026]));
  await assert.rejects(() => G.fitBoxFormula([2025]));
  await assert.rejects(() => T.runImpactFit({ train: [2026], test: 2025 }));
  await assert.rejects(() => T.runImpactFit({ train: [2024, 2025], test: 2025 }));
});

test('on/off shrink scaled by minutes: lambda × 1,000 / minutes, capped; the high-minute star is barely shrunk', () => {
  assert.equal(B.shrinkLambda(30, 1000), 30);
  assert.equal(B.shrinkLambda(30, 2000), 15);
  assert.equal(B.shrinkLambda(30, 100000), 3, 'floor 0.1 × lambda');
  assert.equal(B.shrinkLambda(30, 100), 90, 'cap 3 × lambda');
  assert.equal(B.shrinkLambda(30, 0), 90);
  // 10 teams × 8 players; the star (true +9 per 48) plays 36 minutes a game
  const r = rng(9), truth = new Map();
  for (let t = 0; t < 10; t++) for (let j = 0; j < 8; j++) truth.set(t * 10 + j, t === 0 && j === 0 ? 9 : gauss(r) * 1.5);
  const mins = [36, 34, 32, 30, 28, 30, 26, 24];
  const games = [];
  for (let k = 0; k < 900; k++) {
    const h = Math.floor(r() * 10); let a = Math.floor(r() * 10); if (a === h) a = (a + 1) % 10;
    const side = t => mins.map((m, j) => [t * 10 + j, m + (r() - 0.5) * 6]);
    const hs = side(h), as = side(a);
    const s = l => l.reduce((acc, [p, m]) => acc + truth.get(p) * m / 48, 0);
    games.push({ home: hs, away: as, margin: 2 + s(hs) - s(as) + gauss(r) * 12, w: 1 });
  }
  const flat = I.ridgeFit(games, 30), scaled = I.ridgeFit(games, 30, 48, B.shrinkLambda);
  const star = x => x.ratings.get(0);
  assert.ok(Math.abs(star(scaled) - 9) < Math.abs(star(flat) - 9), `star: one lambda ${star(flat).toFixed(2)}, scaled ${star(scaled).toFixed(2)} (true 9)`);
  assert.ok(star(scaled) > star(flat));
});

test('star factor: bounds 1.0–1.6, only the NBA\'s #4, the top-3 part; the oracle fit finds it inside the bounds', async () => {
  assert.equal(B.clampTop(0.4), 1);
  assert.equal(B.clampTop(2.5), 1.6);
  assert.equal(B.clampTop(1.3), 1.3);
  assert.equal(B.topLoss(-5, -4, 1.5), -7);
  assert.equal(B.topLoss(-5, -4, 9), -5 + 0.6 * -4, 'capped at 1.6');
  assert.equal(B.topLoss(-5, -4, 0), -5, 'floored at 1.0');
  const ids = B.topIds([{ id: 1, box: 8, min: 34 }, { id: 2, box: -1, min: 36 }, { id: 3, box: 3, min: 30 }, { id: 4, box: 2, min: 20 }, { id: 5, box: 6, min: 0 }]);
  assert.deepEqual([...ids].sort(), [1, 3, 4]);
  const p = { ...M.GRID_START, w: [0, 0, 1, 2, 0, 0, 0.5, 0, 0, 0, 0, 0, 0], miss: { w: 2, star: 0.3, top: 1.5, proxy: 0.5, fittedAt: 'x', train: [2022], test: 2025 } };
  const it = { hv: [0, 0, 1, -3, 0, 0, 0, 0, 0, 0, 0, 0, 0], av: [0, 0, -1, -1, 0, 0, 0, 0, 0, 0, 0, 0, 0], sig: 12, t4: -1.5 };
  // NBA: 2 × (−2 + 0.5 × −1.5) = −5.5 (the star form is off when the factor is set); EL: proxy 0.5 × −2, no factor
  assert.equal(Math.round(M.gridEval(p, 'NBA', it).parts[3] * 1e6) / 1e6, -5.5);
  assert.equal(Math.round(M.gridEval(p, 'EL', it).parts[3] * 1e6) / 1e6, -1);
  // games whose result follows a top-3 loss counted 1.4 times
  const r = rng(77), items = [];
  for (let k = 0; k < 7000; k++) {
    const hv = new Array(13).fill(0), av = new Array(13).fill(0);
    hv[2] = gauss(r) * 3; av[2] = -hv[2]; hv[6] = 2;
    const lost = () => { const top = r() < 0.2 ? -Math.abs(gauss(r)) * 4 : 0, rest = r() < 0.3 ? -Math.abs(gauss(r)) * 1.5 : 0; return [top + rest, top]; };
    const [lh, th] = lost(), [la, ta] = lost();
    const year = [2022, 2023, 2024, 2025][k % 4];
    const mg = hv[2] - av[2] + 1 + 1.1 * ((lh + 0.4 * th) - (la + 0.4 * ta)) + gauss(r) * 11;
    items.push({ id: k + 1, code: 'NBA', season: `${year}-${year + 1}`, year, gp: 30, sig: 12, hv, av, oracle: lh - la, ot: th - ta, v3: 0.5, y: mg > 0 ? 1 : 0 });
  }
  const tr = M.missSplit(M.missInputs(items, 'oracle'), [2022, 2023, 2024], 2025);
  const om = await M.fitMiss(tr.train, { ...M.GRID_START, w: [0, 0, 1, 0.5, 0, 0, 0.5, 0, 0, 0, 0, 0, 0] }, { rounds: 40, form: 'top' });
  assert.ok(om.top >= 1 && om.top <= 1.6, `factor ${om.top}`);
  assert.ok(om.top > 1.15, `factor ${om.top} (true 1.4)`);
  assert.equal(om.star, 0);
  assert.ok(om.w > 0.8 && om.w < 1.5, `weight ${om.w} (true 1.1)`);
});

test('impact variants of the stored rows: the blend is linear, the top-3 parts, stored rows untouched', () => {
  const hv = [1, 0, 0, -1, 0, 0, 0, 0.5, 0, 0, 0, 0, 0], av = [2, 0, 0, -2, 0, 0, 0, 0.2, 0, 0, 0, 0, 0];
  // A: imp 3 / 1, miss −1 / 0, top −0.5 / 0, stay 0.6 / 0.1, oracle −2, otop −1; B: imp 7 / 1, miss −3 / 0, top −3 / 0, stay 1 / 0.3, oracle −4, otop −3
  const alt = [3, 1, -1, 0, -0.5, 0, 0.6, 0.1, -2, -1, 7, 1, -3, 0, -3, 0, 1, 0.3, -4, -3];
  const item = { id: 1, code: 'NBA', season: '2025-2026', year: 2025, gp: 3, y: 1, v3: 0.5, sig: 12, hv, av, oracle: -1, alt };
  const [x] = M.impactInputs([item], { wb: 0.75 });
  assert.equal(x.hv[0], 0.75 * 7 + 0.25 * 3);
  assert.equal(x.av[0], 1);
  assert.equal(x.hv[3], 0.75 * -3 + 0.25 * -1);
  assert.equal(x.hv[7], 0.75 * 1 + 0.25 * 0.6);
  assert.equal(x.oracle, 0.75 * -4 + 0.25 * -2);
  assert.equal(x.ot, 0.75 * -3 + 0.25 * -1);
  assert.equal(x.t4, 0.75 * -3 + 0.25 * -0.5);
  assert.deepEqual(item.hv, hv, 'the stored row is never written');
  assert.equal(M.impactInputs([item], null)[0], item, 'no setting: the fix219 rows');
  assert.equal(M.impactInputs([{ ...item, alt: null }], { wb: 0.75 })[0].hv[0], 1, 'a row from before fix225 stays');
  // then the NBA's #4 as live has it: who played + its top-3 part; blind: nothing
  const [o] = M.missInputs([x], 'oracle'), [bl] = M.missInputs([x], 'blind');
  assert.equal(o.hv[3], x.oracle); assert.equal(o.t4, x.ot);
  assert.equal(bl.hv[3], 0); assert.equal(bl.t4, 0);
  assert.equal(M.altShare([item, { ...item, alt: null }]), 0.5);
});

test('the replay on a scratch league: three rating sets per game, the star on top with the box-score values', async () => {
  const ins = db.prepare(`INSERT INTO bb_games (game_id, code, league_id, season, stage, kickoff, status, home_id, home_name, away_id, away_name, hs, as_, updated_at, stats) VALUES (?, 'NBA', 12, ?, NULL, ?, 'FT', ?, ?, ?, ?, ?, ?, ?, 1)`);
  const insP = db.prepare(`INSERT INTO bb_player_stats (game_id, team_id, player_id, name, starter, minutes, pts, fgm, fga, tpm, tpa, ftm, fta, reb, ast) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insT = db.prepare(`INSERT INTO bb_team_stats (game_id, team_id, fgm, fga, tpm, tpa, ftm, fta, reb, oreb, dreb, ast, stl, blk, tov, pf) VALUES (?, ?, 38, 85, 12, 34, 16, 21, 44, 10, 34, 25, 7, 5, 13, 19)`);
  const r = rng(3);
  // 6 teams × 9 players; team 1's player 101 is the star: big box score and +9 per 48 on the court; team 2's 201
  // plays big minutes with an average box score (an on/off "passenger" next to good teammates)
  const quality = id => (id === 101 ? 9 : id === 201 ? 0 : ((id * 7919) % 11) / 5 - 1);
  const mins = [36, 34, 32, 30, 28, 24, 20, 18, 18];
  const line = (id, m) => {
    const star = id === 101;
    const q = quality(id);
    const pts = Math.max(0, Math.round((star ? 30 : 11 + q) * m / 34 + gauss(r) * 3));
    return { pts, fga: Math.max(1, Math.round((star ? 19 : 10) * m / 34)), fta: Math.round((star ? 7 : 3) * m / 34), tpm: Math.round(1.5 * m / 34), reb: Math.round((star ? 13 : 5) * m / 34), ast: Math.round((star ? 10 : 3) * m / 34) };
  };
  const base = new Map();
  let id = 1;
  const names = ['A', 'B', 'C', 'D', 'E', 'F'];
  for (const [season, y] of [['2023-2024', 2023], ['2024-2025', 2024]]) {
    for (let d = 0; d < 70; d++) {
      const day = Date.UTC(y, 10, 1) + d * 2 * 86400000;
      for (let k = 0; k < 3; k++) {
        const h = 1 + ((d + k) % 6), a = 1 + ((d + k + 1 + (d % 4)) % 6);
        if (h === a) continue;
        const side = t => mins.map((m, j) => [t * 100 + j + 1, Math.max(4, m + gauss(r) * 2)]);
        const hs = side(h), as = side(a);
        const s = l => l.reduce((acc, [p, m]) => acc + quality(p) * m / 48, 0);
        const margin = Math.round(2 + s(hs) - s(as) + gauss(r) * 10) || 1;
        const hp = 105 + Math.max(0, margin), ap = 105 + Math.max(0, -margin);
        ins.run(id, season, new Date(day + k * 3600000).toISOString(), h, `Team ${names[h - 1]}`, a, `Team ${names[a - 1]}`, hp, ap, new Date().toISOString());
        for (const [t, list] of [[h, hs], [a, as]]) { insT.run(id, t); for (const [p, m] of list) { const b = line(p, m); insP.run(id, t, p, `Player ${p}`, Math.round(m * 10) / 10, b.pts, Math.round(b.fga * 0.47), b.fga, b.tpm, b.tpm * 3, Math.round(b.fta * 0.75), b.fta, b.reb, b.ast); } }
        base.set(id, { p: 0.5 + margin / 100, m1: 0, netH: 0, netA: 0, hca: 2, haH: 0, haA: 0, b2bH: false, b2bA: false, sig: 12 });
        id++;
      }
    }
  }
  const box = G.storedBox();
  assert.equal(box.version, 'default');
  const res = await G.replayLeague('NBA', base, box);
  assert.ok(res.items.length > 200, `${res.items.length} rows`);
  const withAlt = res.items.filter(x => x.alt && x.alt.length === M.ALT.len);
  assert.equal(withAlt.length, res.items.length, 'every row has the A / B values');
  // the oracle under every set exists when both teams had 5+ players
  assert.ok(withAlt.some(x => x.alt[M.ALT.A + M.ALT.oracle] !== null && x.alt[M.ALT.B + M.ALT.oracle] !== null));
  // the live snapshot: the star is team 1's top-3 and the league's best box-score value; three ratings per player
  const t1 = res.snap.teams.get(1);
  const star = t1.pl.find(p => p[0] === 101);
  assert.ok(star && star.length === 7, 'the snapshot keeps [id, on/off, minutes, since, A, B, top]');
  assert.equal(star[6], 1);
  const allPl = [...res.snap.teams.values()].flatMap(t => t.pl);
  const byBox = [...allPl].sort((a, b) => b[5] - a[5]);
  assert.equal(byBox[0][0], 101, 'the star has the best box-score value');
  assert.ok(star[5] > 4, `star box value ${star[5]}`);
  const passenger = allPl.find(p => p[0] === 201);
  assert.ok(star[5] - passenger[5] > 3, `the passenger's box value ${passenger[5]} is far below the star's ${star[5]}`);
  assert.equal(t1.nv.length, 8);
  // storing and loading keep the A / B values
  G.storeRows('NBA', res.items);
  const back = G.loadRows(['NBA']);
  assert.deepEqual(back[0].alt, res.items[0].alt);
  // the live rows read the setting: blended #1 and the top-3 part of #4
  G.publishSnap(res.snap);
  const g = { code: 'NBA', game_id: 1, home_id: 1, away_id: 2, kickoff: new Date(Date.now() + 86400000).toISOString(), season: '2024-2025', week: null };
  const b0 = { p: 0.6, sig: 12, hca: 2, haH: 0, haA: 0, b2bH: false, b2bA: false };
  const plain = G.liveRows(g, b0), blended = G.liveRows(g, b0, { home: -4, away: 0, homeTop: -4, awayTop: 0 }, { wb: 1 });
  assert.equal(plain.hv[0], Math.round(t1.imp * 1000) / 1000);
  assert.equal(blended.hv[0], Math.round(t1.nv[4] * 1000) / 1000);
  assert.equal(blended.t4, -4);
  // the key players list from the snapshot: the star first, his absence costs the most (and more with the factor)
  const tp = G.teamPlayers('NBA', 1, { wb: 1 });
  const kl = K.keyList(tp.map(p => ({ id: p.id, rating: p.rating, proj: p.proj })), new Map(), 48, 1, 5, { ids: new Set(tp.filter(p => p.top).map(p => p.id)), factor: 1.4 });
  assert.equal(kl[0].id, 101);
  const plainKl = K.keyList(tp.map(p => ({ id: p.id, rating: p.rating, proj: p.proj })), new Map(), 48, 1, 5);
  assert.ok(Math.abs(kl[0].without - plainKl[0].without * 1.4) < 0.11, `${kl[0].without} vs ${plainKl[0].without} × 1.4`);
  assert.ok(kl[0].without < kl[4].without, 'a star out costs more than a role player');
});

/**
 * Rows whose results follow the box-score impact (B) and the real lost impact with a top-3 part; the fix219 on/off (C)
 * and the minutes-scaled on/off (A) see them only through noise.
 */
function rows(code, n, seed, id0 = 0) {
  const r = rng(seed), out = [];
  for (let k = 0; k < n; k++) {
    const hv = new Array(13).fill(0), av = new Array(13).fill(0);
    hv[2] = gauss(r) * 2; av[2] = -hv[2]; hv[6] = 2;
    const tH = gauss(r) * 2.5, tA = gauss(r) * 2.5;
    hv[0] = Math.round((0.4 * tH + gauss(r) * 2) * 1000) / 1000; av[0] = Math.round((0.4 * tA + gauss(r) * 2) * 1000) / 1000;
    const lost = () => { const top = r() < 0.2 ? -Math.abs(gauss(r)) * 4 : 0, rest = r() < 0.3 ? -Math.abs(gauss(r)) * 1.5 : 0; return [top + rest, top]; };
    const [lh, th] = lost(), [la, ta] = lost();
    hv[3] = Math.round((0.3 * lh + gauss(r) * 0.6) * 1000) / 1000; av[3] = Math.round((0.3 * la + gauss(r) * 0.6) * 1000) / 1000;
    const year = [2022, 2023, 2024, 2025, 2026][k % 5];
    const mg = hv[2] - av[2] + 1 + (tH - tA) + 1.1 * ((lh + 0.4 * th) - (la + 0.4 * ta)) + gauss(r) * 11;
    const A = [0.5 * tH + gauss(r) * 1.5, 0.5 * tA + gauss(r) * 1.5, hv[3], av[3], 0.3 * th, 0.3 * ta, 0, 0, 0.6 * (lh - la) + gauss(r) * 0.5, 0.6 * (th - ta)];
    const Bv = [tH + gauss(r) * 0.3, tA + gauss(r) * 0.3, hv[3], av[3], 0.3 * th, 0.3 * ta, 0, 0, lh - la, th - ta];
    out.push({ id: id0 + k + 1, code, season: `${year}-${year + 1}`, year, gp: k % 40, sig: 12, hv, av, oracle: Math.round((0.6 * (lh - la) + gauss(r) * 0.5) * 1000) / 1000, v3: 0.5, y: mg > 0 ? 1 : 0, mg, alt: [...A, ...Bv].map(x => Math.round(x * 1000) / 1000) });
  }
  return out;
}

test('end to end: the impact fit through its gate, stored, and kept by the monthly re-tune', async () => {
  db.exec(`DELETE FROM bb_grid_rows; DELETE FROM bb_tuned;`);
  const all = [...rows('NBA', 5000, 41), ...rows('EL', 3000, 42, 20000)];
  const up = db.prepare(`INSERT OR REPLACE INTO bb_grid_rows (game_id, code, season, ms, gp, y, v3, sig, hv, av, oracle, alt) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const it of all) up.run(it.id, it.code, it.season, it.gp, it.y, it.v3, it.sig, JSON.stringify(it.hv), JSON.stringify(it.av), it.oracle, JSON.stringify(it.alt));
  const START = { ...M.GRID_START, w: [0.3, 0, 1, 0.5, 0, 0, 0.5, 0, 0, 0, 0, 0, 0], version: 'test', fittedAt: 'x', miss: { w: 0.5, star: 0.02, proxy: 0.3, fittedAt: 'x', train: [2022, 2023, 2024], test: 2025 } };
  db.prepare(`INSERT OR REPLACE INTO bb_tuned (id, params, report, at) VALUES ('live', ?, NULL, ?)`).run(JSON.stringify(START), new Date().toISOString());
  assert.equal(T.impactRowsReady(), true);
  assert.equal(T.impactFitDue(), 'first fit of the box-score impact');
  const rep = await T.runImpactFit({ apply: 'gate', rounds: 12, auto: 'test' });
  assert.equal(rep.gate.pass, true, rep.gate.reason);
  assert.equal(rep.applied, true);
  assert.ok(rep.wb >= 0.6, `box share ${rep.wb}`);
  assert.ok(rep.tried.length >= 3);
  assert.ok(rep.miss.top >= 1 && rep.miss.top <= 1.6, `star factor ${rep.miss.top}`);
  assert.equal(rep.miss.star, 0);
  assert.ok(rep.gate.checks.some(c => c.name === 'NBA who played known' && c.better));
  assert.ok(rep.gate.checks.some(c => c.name.startsWith('Europe')));
  assert.equal(rep.split.nba.after.reduce((a, b) => a + b, 0), 1000);
  assert.equal(T.impactFitDue(), null);
  const live = T.sharedParams();
  assert.equal(live.impact.wb, rep.wb);
  assert.deepEqual(live.miss, rep.miss);
  // the tunes read the blended rows; the monthly re-tune keeps the impact setting and the frozen #4
  const t = await T.runTune({ apply: true, rounds: 6 });
  assert.equal(t.params.impact.wb, rep.wb);
  assert.deepEqual(t.params.miss, rep.miss);
  assert.equal(T.sharedParams().impact.wb, rep.wb);
  const items = T.inputsFor(G.loadRows(), T.sharedParams(), 'oracle');
  const nba = items.find(x => x.code === 'NBA' && x.alt);
  assert.ok(Math.abs(nba.hv[0] - (rep.wb * nba.alt[10] + (1 - rep.wb) * nba.alt[0])) < 1e-12);
  // a second run is not due; the admin card and the morning line
  const info = T.impactInfo();
  assert.equal(info.report.wb, rep.wb);
  assert.match(T.impactFitLine(), /star factor ×/);
  // a worse setting fails: the gate keeps today's values
  const bad = M.impactGate(T.inputsFor(G.loadRows(), START, 'oracle'), T.inputsFor(G.loadRows(), { ...live, impact: { ...live.impact, wb: 0 } }, 'oracle'), START, { ...live, impact: { ...live.impact, wb: 0 }, w: live.w.map((w, i) => (i === 0 ? -0.5 : w)) }, 2025);
  assert.equal(bad.pass, false);
  assert.match(bad.reason, /today's values stay/);
});
