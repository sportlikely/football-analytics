// fix281: the new prediction display, every sport — (1) the new public outputs from what we already compute (football over /
// under 1.5 / 2.5 / 3.5, both teams score, each team scores; basketball / NFL total over / under the line and the second
// half; tennis "wins a set"), saved and checked like the other extras, only public through the gate; (2) one band rule
// (lib/confidence: 80 / 60 edges); (3) on the site: every sport's list row shows the split bar and one "Our pick" line in
// its band's colour, free / signed-out rows the grey bar with the lock, the prediction tab its bar, "Most sure first"
// (descending, grouped), the topics as sub-paths with their cards, an output not public never shown to a visitor, 375 px
// without a horizontal scroll. Run: npm run test:fix281 (builds the site first, like test:site)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix281-'));
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'warn';
const require = createRequire(import.meta.url);
const M = require('../dist/utils/moreMath.js');
const mp = require('../dist/services/morePredictions.js');
const { MATCH_TABS, splitTab } = require('../dist/utils/slugRules.js');
const { MARKET_LIMITS } = require('../dist/utils/marketLines.js');
const FRONT = path.resolve(here, '../../frontend/src');
const close = (a, b, eps = 1e-9, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} ${a} vs ${b}`);

/* ---------- 1. the new outputs ---------- */

test('fix281: football — over 1.5 / 2.5 / 3.5, both teams score and each team scores come from the same grid as the goals', () => {
  const x = M.footballExtras(1.7, 1.1, 0.45, M.DEFAULT_GOAL_SHRINK, { rho: -0.08, sizeH: null, sizeA: null });
  const g = x.sets.goals.p;
  for (const k of ['over15', 'over25', 'over35', 'btts', 'scoreHome', 'scoreAway']) {
    assert.deepEqual(x.sets[k].labels, ['yes', 'no'], k);
    close(x.sets[k].p[0] + x.sets[k].p[1], 1, 1e-9, k);
  }
  close(x.sets.over15.p[0], g[2] + g[3] + g[4], 1e-6, 'over 1.5 = 2+ goals');
  close(x.sets.over25.p[0], g[3] + g[4], 1e-6, 'over 2.5 = 3+ goals');
  close(x.sets.over35.p[0], g[4], 1e-6, 'over 3.5 = 4+ goals');
  assert.ok(x.sets.over15.p[0] > x.sets.over25.p[0] && x.sets.over25.p[0] > x.sets.over35.p[0], 'the lines in order');
  close(x.sets.scoreHome.p[0], x.sets.cleanAway.p[1], 1e-9, 'home scores = away does not keep a clean sheet');
  close(x.sets.scoreAway.p[0], x.sets.cleanHome.p[1], 1e-9, 'away scores = home does not keep a clean sheet');
  assert.ok(x.sets.btts.p[0] < Math.min(x.sets.scoreHome.p[0], x.sets.scoreAway.p[0]), 'both score is rarer than either');
  const a = mp.footballActual(2, 0, [1, 0]);
  assert.deepEqual([a.over15, a.over25, a.over35, a.btts, a.scoreHome, a.scoreAway], ['yes', 'no', 'no', 'no', 'yes', 'no']);
  const c = mp.checkExtras(x, mp.footballActual(2, 1, [0, 0])).checks;
  assert.equal(c.over25.i, 0, '3 goals: over 2.5 happened');
  assert.equal(c.btts.i, 0, '2–1: both scored');
});

test('fix281: basketball / NFL — the total over / under the line and the second half, checked against the final score', () => {
  const fit = { share: 0.5, kHalf: 1, kOt: 1, meanTotal: 224.3, sigma: 12, sigmaT: 17, games: 500 };
  const x = M.normalExtras({ sport: 'basketball', pHome: 0.64, margin: 4, total: 230, homePts: 117, awayPts: 113, fit });
  assert.equal(x.info.line, 224.5, 'the league line on a half point');
  const tl = x.sets.totalLine;
  assert.deepEqual(tl.labels, ['under', 'over']);
  assert.deepEqual(tl.cuts, [225]);
  assert.ok(tl.p[1] > 0.6, 'a 230-point game is over 224.5 more often than not');
  close(x.sets.half2.p.reduce((s, v) => s + v, 0), 1, 1e-9, 'second half sums to 1');
  assert.ok(x.sets.half2.p[0] > x.sets.half2.p[2], 'the favourite wins the second half more often');
  const q = { h: [28, 27, 20, 24], a: [26, 25, 30, 25] };
  const act = mp.pointsActual(x, 99, 101, q, false);
  assert.equal(act.half2, 'A', 'quarters 3 + 4: 44 vs 55');
  assert.equal(act.totalLine, 200);
  assert.equal(mp.checkExtras(x, act).checks.totalLine.i, 0, '200 points: under');
  assert.equal(mp.checkExtras(x, mp.pointsActual(x, 120, 110, q, false)).checks.totalLine.i, 1, '230 points: over');
  assert.equal(mp.pointsActual(x, 99, 101, { h: [28, 27, null, null], a: [26, 25, null, null] }, false).half2, null, 'no quarter scores: not checked');
});

test('fix281: tennis — each player wins at least one set, from the chain\'s set scores', () => {
  const x = M.tennisExtras({ sets: { '2-0': 0.4, '2-1': 0.25, '1-2': 0.15, '0-2': 0.2 }, first: 0.6, games: [], noTb: 0.7 }, 3);
  close(x.sets.set1.p[0], 0.8, 1e-9, 'player 1 wins a set unless 0–2');
  close(x.sets.set2.p[0], 0.6, 1e-9, 'player 2 wins a set in 2–1 / 1–2 / 0–2');
  const a = mp.tennisActual([[6, 3, 6], [4, 6, 2]], 0);
  assert.equal(a.set1, 'yes'); assert.equal(a.set2, 'yes');
  assert.equal(mp.tennisActual([[6, 6], [4, 2]], 0).set2, 'no');
});

test('fix281: the new outputs are in every sport\'s output list, follow their market in the gate and the topics are match sub-paths', () => {
  for (const k of ['over15', 'over25', 'over35', 'btts', 'scoreHome', 'scoreAway']) assert.ok(mp.MORE_KEYS.football.includes(k), k);
  for (const s of ['basketball', 'nfl']) for (const k of ['totalLine', 'half2']) { assert.ok(mp.MORE_KEYS[s].includes(k), `${s} ${k}`); assert.equal(MARKET_LIMITS[s][k].market, 'total'); }
  for (const k of ['set1', 'set2']) assert.ok(mp.MORE_KEYS.tennis.includes(k), k);
  assert.equal(MARKET_LIMITS.football.over15.market, 'ou1.5');
  assert.equal(MARKET_LIMITS.football.btts.market, 'btts');
  assert.equal(mp.MORE_CALC, '281', 'upcoming games are saved again with the new outputs');
  for (const t of ['goals', 'score', 'half-time', 'points', 'halves', 'sets', 'games']) {
    assert.ok(MATCH_TABS.includes(t), t);
    assert.equal(splitTab(`/football/match/arsenal-vs-chelsea-2026-10-30/${t}`).tab, t);
  }
  assert.equal(fs.readFileSync(path.join(FRONT, 'lib/slugRules.ts'), 'utf8'), fs.readFileSync(path.join(here, '../src/utils/slugRules.ts'), 'utf8'), 'the two copies of the slug rules');
});

test('fix281: a visitor gets only the public outputs; an admin gets every one, the others marked admin only', () => {
  const { db } = require('../dist/db/index.js');
  const x = M.footballExtras(1.5, 1.2);
  db.prepare(`INSERT OR REPLACE INTO prediction_extras (sport, game_id, model, kickoff, made_at, json, settled, calc) VALUES ('football', 281001, 'grid-v3', ?, ?, ?, 0, '281')`)
    .run(new Date(Date.now() - 864e5).toISOString(), new Date(Date.now() - 2 * 864e5).toISOString(), JSON.stringify(x));
  const at = new Date().toISOString();
  for (const [k, pub] of [['over25', 1], ['btts', 0], ['score', 1], ['scoreHome', 0]])
    db.prepare(`INSERT OR REPLACE INTO more_pred_gate (sport, output, public, games, worst, why, at) VALUES ('football', ?, ?, 500, 1, ?, ?)`).run(k, pub, pub ? null : 'calibration', at);
  const vis = mp.moreForGame('football', 281001, { full: true, admin: false });
  assert.deepEqual(vis.keys.sort(), ['over25', 'score']);
  assert.ok(!vis.prediction.sets.btts && !vis.prediction.sets.scoreHome, 'not public: not sent');
  const adm = mp.moreForGame('football', 281001, { full: true, admin: true });
  assert.ok(adm.prediction.sets.btts && adm.prediction.adminOnly.includes('btts') && !adm.prediction.adminOnly.includes('over25'));
});

/* ---------- 2. the band rule ---------- */

test('fix281: one band rule — 80%+ Very likely, 60–79% Likely, under 60% Close call (rounded first: the number on screen decides)', () => {
  const src = fs.readFileSync(path.join(FRONT, 'lib/confidence.ts'), 'utf8');
  const VERY = Number(/export const VERY_AT = (\d+)/.exec(src)[1]), LIKELY = Number(/export const LIKELY_AT = (\d+)/.exec(src)[1]);
  assert.equal(VERY, 80); assert.equal(LIKELY, 60);
  const body = /export function bandOf\(pct: number\): Band \{([\s\S]*?)\n\}/.exec(src)[1];
  const bandOf = new Function('VERY_AT', 'LIKELY_AT', `return pct => {${body}}`)(VERY, LIKELY);
  assert.deepEqual([80, 79.5, 79.4, 60, 59.5, 59.4, 100, 0].map(bandOf), ['very', 'very', 'likely', 'likely', 'likely', 'close', 'very', 'close']);
  // the old 85% "Strong" rule is gone from the front end
  const pred = fs.readFileSync(path.join(FRONT, 'lib/predict.ts'), 'utf8');
  assert.ok(!/DC_STRONG/.test(pred), 'DC_STRONG removed');
  for (const f of ['components/sport/GameRow.tsx', 'components/DcPick.tsx', 'components/SportHome/parts.tsx', 'components/sport/game/WinnerPrediction.tsx'])
    assert.ok(!/t+\(["']Strong( pick)?["']\)/.test(fs.readFileSync(path.join(FRONT, f), 'utf8')), `no "Strong" badge in ${f}`);
  const md = fs.readFileSync(path.join(here, '../../CLAUDE.md'), 'utf8');
  assert.ok(/fix281/.test(md.split('**List rows:**')[1]?.slice(0, 600) || ''), 'CLAUDE.md "List rows" names the fix281 rule');
});

/* ---------- 3. the site ---------- */

let site = null, siteP = null;
const startOnce = () => (siteP ||= (async () => {
  if (process.env.FIX281_NO_SITE === '1') return null;
  const S = await import('./site-server.mjs');
  const exe = S.findChromium();
  if (!exe) return null;
  const s = await S.startSite({ log: () => undefined });
  const { chromium } = S.playwright();
  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--disable-features=LocalNetworkAccessChecks'] });
  site = { ...s, browser, sample: S.samplePages(s.dataDir) };
  return site;
})());
after(async () => { if (site) { await site.browser.close(); await site.stop(); } });
const { TEST_USERS } = await import('./site-seed.mjs');
/** a site test: the site started on first use; no browser → skipped */
const siteTest = (name, fn) => test(name, { timeout: 900_000 }, async t => { if (!(await startOnce())) return t.skip('no browser / site'); await fn(); });
let ipN = 0;
async function open(url, { role = 'out', width = 375, cover = true } = {}) {
  const ctx = await site.browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block', extraHTTPHeaders: { 'X-Forwarded-For': `2001:db8:281::${(++ipN).toString(16)}` } });
  const token = role === 'admin' ? TEST_USERS.admin.tokens.unlocked : role === 'free' ? TEST_USERS.free.token : null;
  if (token) await ctx.addCookies([{ name: 'b2b_session', value: token, url: site.base }]);
  // "guess first" off: the prediction opens without its cover (the cover itself is fix160's, tested there)
  if (role !== 'out' || cover === false) await ctx.addInitScript(() => { try { localStorage.setItem('b2b_guess_first', '0') } catch { /* fine */ } });
  const page = await ctx.newPage();
  await page.goto(site.base + url, { waitUntil: 'networkidle', timeout: 60_000 });
  return { page, ctx };
}
const ROWS = {
  football: '/football/matches', basketball: '/basketball/matches', 'american-football': '/american-football/matches', tennis: '/tennis/matches'
};
const BAND = p => (p >= 80 ? 'very' : p >= 60 ? 'likely' : 'close');

siteTest('fix281: every sport\'s list row shows the split bar and one "Our pick" line in its band\'s colour (admin), no horizontal scroll at 375 px', async () => {
  let withRows = 0;
  for (const [sport, url] of Object.entries(ROWS)) {
    const { page, ctx } = await open(url, { role: 'admin' });
    // the seeded data has no Football-Data list (football: rows only on a database copy)
    if (!(await page.waitForSelector('[data-testid="pick-line"]', { timeout: 20_000 }).catch(() => null))) { await ctx.close(); continue; }
    withRows++;
    const r = await page.evaluate(() => ({
      rows: [...document.querySelectorAll('[data-testid="row-body"]')].map(el => ({
        bars: el.querySelectorAll('[data-testid="split-bar"]').length, lines: el.querySelectorAll('[data-testid="pick-line"]').length,
        band: el.querySelector('[data-testid="pick-line"]')?.getAttribute('data-band') || null,
        pct: (() => { const t = el.querySelector('[data-testid="pick-line"]')?.textContent || ''; const m = /(\d+)%/.exec(t); return m ? Number(m[1]) : null; })(),
        segs: el.querySelectorAll('[data-seg]').length, draw: el.querySelectorAll('[data-seg="D"]').length,
        accent: [...el.querySelectorAll('[data-pick-colour]')].length,
        cells: el.querySelectorAll('.w-9.h-7').length
      })),
      scroll: document.documentElement.scrollWidth - window.innerWidth
    }));
    const withPick = r.rows.filter(x => x.lines === 1);
    assert.ok(withPick.length > 0, `${sport}: rows with a pick line`);
    for (const x of withPick) {
      assert.equal(x.bars, 1, `${sport}: one bar per row`);
      assert.equal(x.cells, 0, `${sport}: no 1 · X · 2 boxes`);
      if (x.pct !== null) assert.equal(x.band, BAND(x.pct), `${sport}: ${x.pct}% coloured ${x.band}`);
      assert.equal(x.draw, sport === 'football' ? 1 : 0, `${sport}: a draw segment only where draws exist`);
    }
    assert.ok(r.scroll <= 0, `${sport}: no horizontal scroll at 375 px (${r.scroll})`);
    await ctx.close();
  }
  assert.ok(withRows >= 3, `rows with a pick in ${withRows} sports`);
});

siteTest('fix281: the seeded picks in their bands — basketball 58% "Close call", 63% / 68% "Likely", each band its own colour', async () => {
  const b = await open('/basketball/matches', { role: 'admin', width: 1280 });
  await b.page.waitForSelector('[data-testid="pick-line"]', { timeout: 30_000 });
  const bb = await b.page.$$eval('[data-testid="pick-line"]', els => els.map(e => { const n = [...e.querySelectorAll('.num')].pop(); return [Number(/(\d+)%/.exec(e.textContent || '')?.[1]), e.getAttribute('data-band'), n ? getComputedStyle(n).color : ''] }));
  const at = p => bb.find(x => x[0] === p);
  assert.ok(at(58) && at(58)[1] === 'close', `58% → close call (${JSON.stringify(bb.slice(0, 6))})`);
  assert.ok(at(63) && at(63)[1] === 'likely', '63% → likely');
  assert.notEqual(at(58)[2], at(63)[2], 'grey vs yellow');
  const words = await b.page.$$eval('[data-testid="pick-line"]', els => els.map(e => e.textContent));
  assert.ok(words.some(w => /Close call/.test(w)) && words.some(w => /Likely/.test(w)), 'the band words');
  await b.ctx.close();
});

siteTest('fix281: signed out and free users keep the lock — the grey bar, no numbers', async () => {
  for (const role of ['out', 'free']) {
    const { page, ctx } = await open('/basketball/matches', { role });
    await page.waitForSelector('[data-testid="row-body"]', { timeout: 30_000 });
    const r = await page.evaluate(() => ({
      locked: document.querySelectorAll('[data-testid="split-bar"][data-locked="1"]').length,
      open: [...document.querySelectorAll('[data-testid="split-bar"]:not([data-locked])')].length
    }));
    assert.ok(r.locked > 0, `${role}: locked rows draw the grey bar`);
    assert.equal(r.open, 0, `${role}: no open numbers in the list`);
    await ctx.close();
  }
});

const SPORT_TOPICS = { football: ['goals', 'score', 'half-time'], basketball: ['points', 'halves'], 'american-football': ['points', 'halves'], tennis: ['sets', 'games'] };
siteTest('fix281: the prediction tab — big bar, "Most sure first" sorted high → low and grouped, the topics as sub-paths with their cards (every sport, admin)', async () => {
  for (const sport of Object.keys(SPORT_TOPICS)) {
    const slug = site.sample[sport]?.matchNext || site.sample[sport]?.matchDone;
    if (!slug) continue;
    const { page, ctx } = await open(`/${sport}/match/${slug}`, { role: 'admin' });
    await page.waitForSelector('[data-testid="prediction-panel"]', { timeout: 40_000 });
    await page.waitForSelector('[data-testid="sure-row"]', { timeout: 20_000 });
    await page.waitForTimeout(2500); // the extras arrive after the main prediction
    const r = await page.evaluate(() => ({
      big: !!document.querySelector('[data-testid="prediction-panel"] [data-testid="split-bar"]'),
      pick: document.querySelector('[data-testid="prediction-panel"] [data-testid="pick-line"]')?.getAttribute('data-band'),
      pcts: [...document.querySelectorAll('[data-testid="sure-row"]')].map(e => Number(e.getAttribute('data-pct'))),
      rest: [...document.querySelectorAll('[data-testid="sure-row"]:not([data-main])')].map(e => Number(e.getAttribute('data-pct'))),
      groups: [...document.querySelectorAll('[data-testid="sure-group"]')].map(e => e.getAttribute('data-band')),
      bandsOk: [...document.querySelectorAll('[data-testid="sure-row"]')].every(e => { const p = Number(e.getAttribute('data-pct')); return e.getAttribute('data-band') === (p >= 80 ? 'very' : p >= 60 ? 'likely' : 'close'); }),
      topics: [...document.querySelectorAll('[data-testid="topic-tab"]')].map(e => e.getAttribute('data-topic')),
      cards: document.querySelectorAll('[data-testid="q-card"]').length,
      old: document.body.innerText.includes('Most likely result') || !!document.querySelector('#more'),
      scroll: document.documentElement.scrollWidth - window.innerWidth
    }));
    assert.ok(r.big && r.pick, `${sport}: the big bar with "Our pick"`);
    // fix284b: one line per question (a winner game with no public extras: just the side we call)
    assert.ok(r.pcts.length >= 1 && r.pcts.length <= 8, `${sport}: 1–8 sure rows shown (${r.pcts.length})`);
    // fix284b: highest first, but our main pick leads its band (asserted in test:fix284b)
    assert.deepEqual(r.rest, [...r.rest].sort((a, b) => b - a), `${sport}: highest first`);
    const order = ['very', 'likely', 'close'];
    assert.deepEqual(r.groups, [...r.groups].sort((a, b) => order.indexOf(a) - order.indexOf(b)), `${sport}: groups Very likely → Likely → Possible`);
    assert.ok(r.bandsOk, `${sport}: each row in its band`);
    assert.equal(r.topics[0], 'result');
    assert.ok(r.cards >= 1, `${sport}: the Result topic's cards`);
    assert.ok(!r.old, `${sport}: the old blocks are gone`);
    assert.ok(r.scroll <= 0, `${sport}: no horizontal scroll at 375 px`);
    // every topic shown is a sub-path with its cards
    for (const tp of r.topics.slice(1)) {
      await page.click(`[data-testid="topic-tab"][data-topic="${tp}"]`);
      await page.waitForFunction(t => location.pathname.endsWith(`/${t}`), tp, { timeout: 5000 });
      const n = await page.$$eval('[data-testid="q-card"]', els => els.length);
      assert.ok(n >= 1, `${sport} ${tp}: cards`);
      assert.ok(SPORT_TOPICS[sport].includes(tp), `${sport}: ${tp} is one of the sport's topics`);
    }
    await ctx.close();
    // opened straight on a topic's address
    for (const tp of SPORT_TOPICS[sport]) {
      const o = await open(`/${sport}/match/${slug}/${tp}`, { role: 'admin' });
      await o.page.waitForSelector('[data-testid="prediction-panel"]', { timeout: 40_000 });
      assert.ok(o.page.url().endsWith(`/${tp}`), `${sport}: /${tp} stays (a match tab)`);
      await o.ctx.close();
    }
  }
});

siteTest('fix281: an output that is not public is never shown to a visitor (a free user who opened the game with a free pick)', async () => {
  const slug = site.sample.football?.matchNext;
  if (!slug) return;
  const id = (await (await fetch(`${site.base}/api/slug/football/match/${slug}`)).json())?.data?.id;
  assert.ok(id, 'the match id');
  // its extras (saved before kick-off) and the gates: over 2.5 public, the other goal outputs not
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(site.dataDir, 'bet-to-beat.sqlite'));
  const x = M.footballExtras(1.6, 1.1);
  const ko = new Date(Date.now() + 864e5).toISOString();
  db.exec('PRAGMA busy_timeout = 10000');
  db.prepare(`INSERT OR REPLACE INTO prediction_extras (sport, game_id, model, kickoff, made_at, json, settled, calc) VALUES ('football', ?, 'grid-v3', ?, ?, ?, 0, '281')`).run(id, ko, new Date().toISOString(), JSON.stringify(x));
  const at = new Date().toISOString();
  for (const [k, pub] of [['over25', 1], ['btts', 0], ['scoreHome', 0], ['scoreAway', 0], ['over15', 0], ['over35', 0], ['goals', 0], ['cleanHome', 0], ['cleanAway', 0], ['homeGoals', 0], ['awayGoals', 0], ['ht', 0], ['htft', 0], ['score', 0], ['win2Home', 0], ['win2Away', 0]])
    db.prepare(`INSERT OR REPLACE INTO more_pred_gate (sport, output, public, games, worst, why, at) VALUES ('football', ?, ?, 500, 1, ?, ?)`).run(k, pub, pub ? null : 'calibration', at);
  db.close();
  // the free user opens the game with a free pick
  const { page, ctx } = await open(`/football/match/${slug}`, { role: 'free' });
  const st = await page.evaluate(async id => (await fetch(`/api/unlocks/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'TIMED' }) })).status, id);
  assert.ok(st < 300, `free pick used (${st})`);
  // the gate list is read again within a minute
  let keys = [];
  for (let i = 0; i < 45; i++) {
    keys = await page.evaluate(async id => (await (await fetch(`/api/more/football/${id}`)).json())?.data?.keys || [], id);
    if (keys.includes('over25') && !keys.includes('btts')) break;
    await new Promise(r => setTimeout(r, 2000));
  }
  assert.ok(keys.includes('over25') && !keys.includes('btts'), `visitor keys: ${keys.join(', ')}`);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="prediction-panel"]', { timeout: 40_000 });
  await page.waitForTimeout(2500);
  const text = await page.$eval('[data-testid="prediction-panel"]', e => e.innerText);
  assert.ok(/3 or more goals|2 goals or fewer/.test(text), 'over 2.5 (public) is in the list');
  assert.ok(!/Both teams score|At least one team fails to score|Exact score/.test(text), 'the outputs that are not public are not shown');
  const topics = await page.$$eval('[data-testid="topic-tab"]', els => els.map(e => e.getAttribute('data-topic')));
  assert.deepEqual(topics, ['result', 'goals'], 'only topics with a public output');
  await page.click('[data-testid="topic-tab"][data-topic="goals"]');
  await page.waitForFunction(() => location.pathname.endsWith('/goals'), null, { timeout: 5000 });
  const cards = await page.$$eval('[data-testid="q-card"]', els => els.map(e => e.getAttribute('data-card')));
  assert.deepEqual(cards, ['over25'], 'the Goals topic shows the public card only');
  assert.ok(!(await page.$('text=admin only')), 'no admin badge for a visitor');
  await ctx.close();
});
