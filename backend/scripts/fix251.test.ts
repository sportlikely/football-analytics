// fix251: football self-learning — the bootstrap bar, the verdict and the candidate list. Run: npm run test:fix251
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DAILY_RULES, pairedBootstrap, pairedBootstrapAsync, judge, paired, candidateList, chooseAnchor, anchorP, mixP, groupOfDiv, mulberry32, closeness,
  type P3, type Spec
} from '../src/utils/dailyRules.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const noise = (n: number, mean: number, sd: number, seed = 7) => {
  const r = mulberry32(seed);
  return Array.from({ length: n }, () => { const u = Math.max(1e-12, r()), v = r(); return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); });
};
const win = (d: number[], hitC = 50, hitB = 50) => ({ s: { n: d.length, diff: d.reduce((a, b) => a + b, 0) / (d.length || 1), hitC, hitB }, d });

/* ---------- bootstrap ---------- */

test('bootstrap: all games better → 100% of resamples, all worse → 0%', () => {
  assert.equal(pairedBootstrap(Array(500).fill(-0.01)).pBetter, 1);
  assert.equal(pairedBootstrap(Array(500).fill(0.01)).pBetter, 0);
});

test('bootstrap: mean, 90% interval around it, 2,000 resamples, seeded (same answer twice)', () => {
  const d = noise(3000, -0.002, 0.08);
  const a = pairedBootstrap(d), b = pairedBootstrap(d);
  assert.deepEqual(a, b);
  assert.equal(a.n, 3000);
  assert.ok(Math.abs(a.mean - d.reduce((x, y) => x + y, 0) / d.length) < 1e-6);
  assert.ok(a.lo < a.mean && a.mean < a.hi, `${a.lo} < ${a.mean} < ${a.hi}`);
  // the interval width ≈ 2 × 1.645 × sd / √n
  const want = 2 * 1.645 * 0.08 / Math.sqrt(3000);
  assert.ok(Math.abs(a.hi - a.lo - want) < want * 0.25, `width ${a.hi - a.lo} vs ${want}`);
  assert.equal(DAILY_RULES.resamples, 2000);
});

test('bootstrap: no difference → about half the resamples better', () => {
  const d = noise(4000, 0, 0.08, 11);
  const m = d.reduce((a, b) => a + b, 0) / d.length;
  const centred = d.map(x => x - m + 1e-9);
  const p = pairedBootstrap(centred).pBetter;
  assert.ok(p > 0.3 && p < 0.7, `p ${p}`);
});

test('bootstrap: the async version gives the identical answer', async () => {
  const d = noise(800, -0.003, 0.1, 3);
  let pauses = 0;
  const b = await pairedBootstrapAsync(d, async () => { pauses++; });
  assert.deepEqual(b, pairedBootstrap(d));
  assert.ok(pauses >= 19, `gave the thread back ${pauses} times`);
});

test('bootstrap: the 26 Oct sizes — −0.0024 / −0.0030 on 3,450 games per window is significant, the same gain on 300 games is not', () => {
  const big = judge(win(noise(3450, -0.0024, 0.08, 1)), win(noise(3450, -0.003, 0.08, 2)));
  assert.equal(big.pass, true, big.why);
  assert.ok(big.boot!.pBetter >= 0.9);
  const small = judge(win(noise(300, -0.0024, 0.08, 1)), win(noise(300, -0.003, 0.08, 2)));
  assert.equal(small.pass, false);
  assert.match(small.why, /not sure enough|not better/);
});

/* ---------- the verdict ---------- */

test('verdict: too few games, worse in one window, hit rate down → no promotion; gap says how far', () => {
  const good = noise(1000, -0.01, 0.05, 5);
  assert.match(judge(win(good.slice(0, 200)), win(good)).why, /200 games in the last 60 days/);
  assert.match(judge(win(good), win(good.slice(0, 100))).why, /previous 60 days/);
  const worseBefore = judge(win(good), win(noise(1000, 0.004, 0.05, 6)));
  assert.equal(worseBefore.pass, false);
  assert.match(worseBefore.why, /not better in the previous 60 days/);
  assert.match(worseBefore.gap!, /needs below 0/);
  const hitDown = judge(win(good, 49.0, 50.0), win(good));
  assert.equal(hitDown.pass, false);
  assert.match(hitDown.why, /hit rate/);
  const ok = judge(win(good, 49.6, 50.0), win(good));
  assert.equal(ok.pass, true, ok.why);
  assert.equal(ok.gap, null);
});

test('paired(): only games where both have a number, candidate − champion', () => {
  const p = paired([
    { c: [0.6, 0.2, 0.2], b: [0.5, 0.3, 0.2], y: 0 },
    { c: null, b: [0.5, 0.3, 0.2], y: 0 },
    { c: [0.2, 0.3, 0.5], b: [0.5, 0.3, 0.2], y: 0 }
  ]);
  assert.equal(p.s.n, 2);
  assert.ok(Math.abs(p.d[0] - (Math.log(0.5) - Math.log(0.6))) < 1e-12);
  assert.equal(p.s.hitC, 50);
  assert.equal(p.s.hitB, 100);
});

test('closeness: a candidate better in both windows ranks before one better in one window only', () => {
  const both = { W: { n: 3000, diff: -0.001, hitC: 0, hitB: 0 }, Wp: { n: 3000, diff: -0.0005, hitC: 0, hitB: 0 }, boot: { n: 6000, mean: -0.0008, lo: 0, hi: 0, pBetter: 0.8 } };
  const one = { W: { n: 3000, diff: -0.004, hitC: 0, hitB: 0 }, Wp: { n: 3000, diff: 0.001, hitC: 0, hitB: 0 }, boot: null };
  assert.ok(closeness(both) < closeness(one));
});

/* ---------- the candidate list ---------- */

const champ: Spec = { w: 0.5, groupW: null, fit: 'current', v3: 'champion', anchor: 0 };

test('candidates: (a) fresher feature fit is always there, every weight 0.4 … 1.0 with both fits, the refitted v3, no copy of the champion', () => {
  const l = candidateList({ champion: champ, v3Refit: true });
  const ids = l.map(c => c.id);
  assert.equal(ids[0], 'champion');
  assert.ok(ids.includes('feature-refit'));
  const a = l.find(c => c.id === 'feature-refit')!;
  assert.equal(a.fit, 'fresh');
  assert.equal(a.w, 0.5);
  for (const w of [0.6, 0.7, 0.8, 0.9, 1]) for (const fit of ['fresh', 'current']) assert.ok(ids.includes(`mix-${w}-${fit}`), `mix-${w}-${fit}`);
  assert.match(l.find(c => c.id === 'mix-1-current')!.label, /feature model alone/);
  assert.ok(ids.includes('v3-weights'));
  assert.ok(!ids.includes('mix-0.5-current'), 'the champion itself is not a challenger');
  assert.ok(!ids.includes('mix-0.5-fresh'), 'same setting as feature-refit');
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(l.length, 1 + 1 + 6 + 6 + 1);
  // without a v3 refit there is no v3 candidate
  assert.ok(!candidateList({ champion: champ, v3Refit: false }).some(c => c.v3 === 'refit'));
});

test('candidates, stage 2: v3 refit + best mix, per-group weights, market anchor on the champion and on the best mix', () => {
  const l = candidateList({ champion: champ, v3Refit: true, best: { w: 0.8, fit: 'fresh' }, group: { big: 0.6, rest: 0.9, fit: 'fresh' }, anchor: true });
  const by = (id: string) => l.find(c => c.id === id)!;
  assert.deepEqual([by('v3-weights+best-mix').v3, by('v3-weights+best-mix').w, by('v3-weights+best-mix').fit], ['refit', 0.8, 'fresh']);
  assert.deepEqual(by('mix-by-group').groupW, { big: 0.6, rest: 0.9 });
  assert.equal(by('anchor-champion').anchor, 'wf');
  assert.equal(by('anchor-champion').w, 0.5);
  assert.equal(by('anchor-best-mix').w, 0.8);
  assert.equal(l.length, 15 + 4);
  // no anchor without prices, no group candidate unless both groups had enough games (the job passes null)
  const l2 = candidateList({ champion: champ, v3Refit: true, best: { w: 0.8, fit: 'fresh' }, group: null, anchor: false });
  assert.ok(!l2.some(c => c.kind === 'anchor' || c.kind === 'group'));
});

test('candidates: a champion with per-group weights / an anchor keeps them in (a), the plain mixes drop the groups', () => {
  const c0: Spec = { w: 0.7, groupW: { big: 0.6, rest: 0.8 }, fit: 'current', v3: 'champion', anchor: 0.2 };
  const l = candidateList({ champion: c0, v3Refit: false });
  const a = l.find(c => c.id === 'feature-refit')!;
  assert.deepEqual(a.groupW, c0.groupW);
  assert.equal(a.anchor, 0.2);
  assert.ok(l.find(c => c.id === 'mix-0.7-current'), 'plain 0.7 without groups is a different setting');
  assert.equal(l.find(c => c.id === 'mix-0.7-current')!.groupW, null);
});

/* ---------- mixing, groups, anchor ---------- */

test('mix / anchor maths: weights, sums to 1, no prices → unchanged', () => {
  const v: P3 = [0.5, 0.3, 0.2], f: P3 = [0.3, 0.3, 0.4], m: P3 = [0.6, 0.25, 0.15];
  const x = mixP(0.5, v, f);
  assert.ok(Math.abs(x[0] - 0.4) < 1e-12 && Math.abs(x[2] - 0.3) < 1e-12);
  assert.deepEqual(mixP(1, v, f), f);
  const a = anchorP(v, m, 0.2);
  assert.ok(Math.abs(a[0] - (0.8 * 0.5 + 0.2 * 0.6)) < 1e-12);
  assert.ok(Math.abs(a[0] + a[1] + a[2] - 1) < 1e-12);
  assert.deepEqual(anchorP(v, null, 0.4), v);
});

test('the anchor weight is chosen on the window before: a market that is always right → 0.4, a useless one → 0.1', () => {
  const r = mulberry32(9);
  const sharp = Array.from({ length: 400 }, () => { const y = (r() * 3) | 0; const mkt = [0.1, 0.1, 0.1] as P3; mkt[y] = 0.8; return { p: [0.4, 0.3, 0.3] as P3, mkt, y }; });
  assert.equal(chooseAnchor(sharp), 0.4);
  const wrong = sharp.map(x => ({ ...x, mkt: x.mkt.map((_, i) => (i === x.y ? 0.05 : 0.475)) as P3 }));
  assert.equal(chooseAnchor(wrong), 0.1);
  assert.deepEqual(DAILY_RULES.anchorWeights, [0.1, 0.2, 0.3, 0.4]);
  assert.equal(chooseAnchor(sharp.map(x => ({ ...x, mkt: null }))), null);
});

test('league groups: the five big top flights (division or competition code), everything else is rest', () => {
  for (const d of ['E0', 'SP1', 'I1', 'D1', 'F1']) assert.equal(groupOfDiv(d), 'big');
  for (const d of ['E1', 'N1', 'P1', 'BRA', 'SC0']) assert.equal(groupOfDiv(d), 'rest');
  assert.equal(groupOfDiv(null, 'PL'), 'big');
  assert.equal(groupOfDiv(null, 'AF41'), 'rest');
});

/* ---------- wiring (source) ---------- */

test('wiring: the job uses the bootstrap bar (no fixed −0.003), records the live fit; the live mix reads the group weights and anchor; no price in the payload', () => {
  const job = fs.readFileSync(path.join(here, '../src/services/modelDaily.ts'), 'utf8');
  assert.ok(!/minGain/.test(job), 'fixed minimum gain removed');
  assert.match(job, /pairedBootstrapAsync/);
  assert.match(job, /featModelId: act\?\.id/);
  assert.match(job, /candidateList\(/);
  const fm = fs.readFileSync(path.join(here, '../src/services/featureModel.ts'), 'utf8');
  assert.match(fm, /mixWeightFor\(groupOfDiv/);
  assert.match(fm, /marketAnchor\(\)/);
  const payload = fm.slice(fm.indexOf('mix: {', fm.indexOf('export function mixPredictions')), fm.indexOf('return [out, feat]'));
  assert.ok(!/mk\.|odds|market/i.test(payload.replace(/anchored/g, '')), 'no market number in the prediction payload');
  const dh = fs.readFileSync(path.join(here, '../src/services/dataHealth.ts'), 'utf8');
  assert.match(dh, /modelDailyHealth\(now\)/);
});
