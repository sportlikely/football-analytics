// fix284b: game page follow-ups (Yarin, 30 Oct, Barça vs Alavés at PC width).
//  1. a topic tab (Result / Goals / Score …) or a main tab (Statistics / Line-ups / H2H …) keeps the scroll position: the
//     address is the sub-path, the page is not re-mounted, a revealed prediction stays revealed; back / forward too
//     (every sport, 1440 px and 375 px, the seeded test site, the admin with "guess first" on);
//  2. "Most sure first": one line per question, no "no" side of an under-10% event (the main pick excepted), the main
//     pick first in its band;
//  3. no preview text names the model's factors;
//  4. "Hide prediction again" sits under the "Our pick" line, left-aligned with it.
//
//   npm run test:fix284b (builds backend + frontend first)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startSite, samplePages, findChromium, playwright } from './site-server.mjs';
import { TEST_USERS } from './site-seed.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SPORTS = ['football', 'basketball', 'american-football', 'tennis'];

/* ---------- 3. the preview text ---------- */

const FACTOR_WORDS = /\b(our model weighs|factors? that count|biggest factors?|model's .*factors?|squad value|long-term strength|attack against teams)\b/i;
test('previews: no sentence names the model\'s factors (every writer)', () => {
  const { previewText } = require('../dist/services/matchPreview.js');
  const game = (n, gf, ga) => Array.from({ length: n }, (_, i) => ({ date: new Date(Date.now() - (i + 2) * 7 * 864e5).toISOString(), gf, ga }));
  for (let id = 1; id <= 30; id++) {
    const text = previewText({
      id, comp: 'La Liga', matchday: 11, date: new Date(Date.now() + 3 * 864e5).toISOString(), venue: 'Spotify Camp Nou', home: 'Barça', away: 'Alavés',
      lineups: false, score: null, form: { home: game(5, 3, 1), away: game(5, 1, 1) }, table: { home: { pos: 1, pts: 25 }, away: { pos: 14, pts: 11 } },
      h2h: { n: 6, hw: 5, d: 1, aw: 0 }, out: { home: [], away: [] }, why: ['#1', '#19', '#1e', '#21']
    });
    assert.ok(!FACTOR_WORDS.test(text), `football preview ${id} names a factor: ${text}`);
  }
  for (const f of ['matchPreview.ts', 'bbPreview.ts', 'nflGameExtras.ts', 'tennisSite.ts']) {
    const src = fs.readFileSync(path.join(here, '../src/services', f), 'utf8');
    const code = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.ok(!/(our model weighs|count most in our model|biggest factors)/i.test(code), `${f}: a factor sentence is back`);
  }
});

/* ---------- the pages ---------- */

let site = null, browser = null, games = {};
before(async () => {
  site = await startSite({ log: () => undefined });
  const sample = samplePages(site.dataDir);
  for (const s of SPORTS) games[s] = sample[s].matchNext || sample[s].matchDone;
  const exe = findChromium();
  if (!exe) throw new Error('no Chromium for playwright-core (PLAYWRIGHT_CHROMIUM)');
  browser = await playwright().chromium.launch({ executablePath: exe });
}, { timeout: 600_000 });
after(async () => { await browser?.close().catch(() => undefined); await site?.stop(); });

let ipN = 0;
async function open(url, width) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block', extraHTTPHeaders: { 'X-Forwarded-For': `2001:db8:284b::${(++ipN).toString(16)}` } });
  await ctx.addCookies([{ name: 'b2b_session', value: TEST_USERS.admin.tokens.unlocked, url: site.base }]);
  // "guess first" on: the prediction starts covered, so "stays revealed" means something
  await ctx.addInitScript(() => { try { if (!sessionStorage.getItem('t284b')) { localStorage.setItem('b2b_guess_first', '1'); sessionStorage.setItem('t284b', '1') } } catch { /* fine */ } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(site.base + url, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.waitForSelector('[data-testid="game-tabs"]', { timeout: 40_000 });
  // reveal the prediction when it is covered
  const reveal = page.getByRole('button', { name: /Reveal prediction/ }).first();
  if (await reveal.count()) { await reveal.click(); }
  await page.waitForSelector('[data-testid="prediction-panel"]', { timeout: 40_000 });
  await sleep(2500); // the extras (topics) arrive after the main prediction
  return { page, ctx, errors };
}
/** the page's state: scroll, address, the same hero element as when marked, the prediction revealed */
const state = page => page.evaluate(() => ({
  y: Math.round(window.scrollY),
  path: location.pathname,
  same: !!window.__hero && document.contains(window.__hero),
  revealed: !!document.querySelector('[data-testid="prediction-panel"]') || !document.body.innerText.includes('Reveal prediction')
}));
const mark = page => page.evaluate(() => { window.__hero = document.querySelector('[data-game-main] .card'); });
/** a DOM click (no scroll into view): the tab is on screen already */
const click = (page, sel) => page.evaluate(s => { const el = document.querySelector(s); if (!el) return false; el.click(); return true; }, sel);

for (const sport of SPORTS) for (const width of [1440, 375]) {
  test(`${sport} at ${width}: topic and main tabs keep the scroll position, the page and the revealed prediction; back / forward too`, { timeout: 240_000 }, async () => {
    const slug = games[sport];
    assert.ok(slug, `${sport}: no game in the seeded site`);
    const base = `/${sport}/match/${slug}`;
    const { page, ctx, errors } = await open(base, width);
    await mark(page);

    // 1. the topic tabs: the topic bar on screen (200 px from the top), then each topic
    const topics = await page.$$eval('[data-testid="topic-tab"]', els => els.map(e => e.getAttribute('data-topic')));
    assert.ok(topics.length >= 1, `${sport}: topic tabs (${topics})`);
    // the seeded game may have the Result topic only (no public extras): then the main tabs carry the test
    await page.evaluate(() => { const n = document.querySelector('[data-testid="topic-tab"]'); window.scrollTo(0, Math.max(0, n.getBoundingClientRect().top + window.scrollY - 200)); });
    await sleep(300);
    const steps = [];
    for (const tp of topics.length > 1 ? [...topics.slice(1), topics[0]] : []) {
      const before = await state(page);
      assert.ok(await click(page, `[data-testid="topic-tab"][data-topic="${tp}"]`), `${sport}: topic ${tp}`);
      await sleep(700);
      const s = await state(page);
      const want = tp === 'result' ? base : `${base}/${tp}`;
      assert.equal(s.path, want, `${sport} ${width}: topic ${tp} address`);
      assert.ok(Math.abs(s.y - before.y) <= 2, `${sport} ${width}: topic ${tp} moved the page ${before.y} → ${s.y}`);
      assert.ok(s.same, `${sport} ${width}: topic ${tp} re-mounted the page`);
      assert.ok(s.revealed, `${sport} ${width}: topic ${tp} hid the prediction again`);
      steps.push({ path: s.path, y: s.y });
    }

    // 2. the main tabs (the sticky bar is on screen once the page is scrolled)
    await page.evaluate(() => window.scrollTo(0, Math.min(452, document.documentElement.scrollHeight - window.innerHeight)));
    await sleep(300);
    const tabs = await page.$$eval('[data-testid="game-tabs"] button', els => els.length);
    for (let i = 1; i < tabs; i++) {
      const before = await state(page);
      await click(page, `[data-testid="game-tabs"] button:nth-of-type(${i + 1})`);
      await sleep(700);
      const s = await state(page);
      assert.ok(s.path.startsWith(`${base}/`), `${sport} ${width}: tab ${i} address ${s.path}`);
      assert.ok(Math.abs(s.y - before.y) <= 2, `${sport} ${width}: tab ${s.path} moved the page ${before.y} → ${s.y}`);
      assert.ok(s.same, `${sport} ${width}: tab ${s.path} re-mounted the page`);
      steps.push({ path: s.path, y: s.y });
    }
    // back to the prediction: still revealed
    const before = await state(page);
    await click(page, '[data-testid="game-tabs"] button:nth-of-type(1)');
    await sleep(900);
    const p = await state(page);
    assert.equal(p.path, base);
    assert.ok(Math.abs(p.y - before.y) <= 2, `${sport} ${width}: back on Prediction moved the page ${before.y} → ${p.y}`);
    assert.ok(await page.$('[data-testid="prediction-panel"]'), `${sport} ${width}: the prediction is covered again`);

    // 3. back / forward between the sub-paths keep the position
    const yNow = (await state(page)).y;
    await page.goBack(); await sleep(700);
    let s = await state(page);
    assert.notEqual(s.path, base, `${sport} ${width}: back stayed on ${s.path}`);
    assert.ok(s.path.startsWith(base), `${sport} ${width}: back left the game (${s.path})`);
    assert.ok(Math.abs(s.y - yNow) <= 2, `${sport} ${width}: back moved the page ${yNow} → ${s.y}`);
    assert.ok(s.same, `${sport} ${width}: back re-mounted the page`);
    await page.goForward(); await sleep(700);
    s = await state(page);
    assert.equal(s.path, base, `${sport} ${width}: forward`);
    assert.ok(Math.abs(s.y - yNow) <= 2, `${sport} ${width}: forward moved the page ${yNow} → ${s.y}`);
    assert.ok(s.same && s.revealed, `${sport} ${width}: forward re-mounted or covered the page`);
    assert.deepEqual(errors, [], `${sport} ${width}: page errors`);
    await ctx.close();
  });
}

test('another page still opens at the top', { timeout: 120_000 }, async () => {
  const { page, ctx } = await open(`/football/match/${games.football}`, 1440);
  await page.evaluate(() => window.scrollTo(0, 600)); await sleep(300);
  const team = await page.$('a[href^="/football/team/"]');
  assert.ok(team, 'a team link');
  await page.evaluate(el => el.click(), team);
  await page.waitForFunction(() => location.pathname.startsWith('/football/team/'), null, { timeout: 10_000 });
  await sleep(800);
  assert.equal(await page.evaluate(() => Math.round(window.scrollY)), 0, 'the team page did not open at the top');
  await ctx.close();
});

/* ---------- 2. "Most sure first" and 4. the hide link ---------- */

for (const sport of SPORTS) test(`${sport}: Most sure first — one line per question, no near-certain "no" side, main pick first in its band; Hide under Our pick`, { timeout: 120_000 }, async () => {
  const { page, ctx } = await open(`/${sport}/match/${games[sport]}`, 1440);
  await page.click('[data-testid="sure-list"] button', { timeout: 2000 }).catch(() => undefined); // "Show all"
  await sleep(300);
  const r = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-testid="sure-row"]')].map(e => ({ id: e.getAttribute('data-id'), pct: Number(e.getAttribute('data-pct')), band: e.getAttribute('data-band'), main: e.hasAttribute('data-main') }));
    const pick = document.querySelector('[data-testid="prediction-panel"] [data-testid="pick-line"]')?.getBoundingClientRect();
    const hide = document.querySelector('[data-testid="hide-again"]')?.getBoundingClientRect();
    const sure = document.querySelector('[data-testid="sure-list"]')?.getBoundingClientRect();
    return { rows, pick: pick && { left: pick.left, bottom: pick.bottom }, hide: hide && { left: hide.left, top: hide.top, bottom: hide.bottom }, sure: sure && { top: sure.top } };
  });
  assert.ok(r.rows.length >= 1, `${sport}: rows`);
  const q = r.rows.map(x => (/^(res|win)-/.test(x.id) ? x.id.split('-')[0] : x.id));
  assert.equal(new Set(q).size, q.length, `${sport}: a question twice (${r.rows.map(x => x.id)})`);
  for (const x of r.rows) if (!x.main) assert.ok(100 - x.pct >= 10, `${sport}: "${x.id}" ${x.pct}% — its other side is under 10%`);
  const mains = r.rows.filter(x => x.main);
  assert.equal(mains.length, 1, `${sport}: one main pick`);
  const first = r.rows.find(x => x.band === mains[0].band);
  assert.equal(first.id, mains[0].id, `${sport}: the main pick is not first in its band`);
  // the hide link: under "Our pick", left-aligned with it, and above the list
  assert.ok(r.hide, `${sport}: no "Hide prediction again"`);
  assert.ok(Math.abs(r.hide.left - r.pick.left) <= 2, `${sport}: the hide link is not left-aligned with Our pick (${r.hide.left} vs ${r.pick.left})`);
  assert.ok(r.hide.top >= r.pick.bottom - 1 && r.hide.top - r.pick.bottom < 24, `${sport}: the hide link is not right under Our pick`);
  assert.ok(r.hide.bottom < r.sure.top, `${sport}: the hide link is below the list`);
  await ctx.close();
});
