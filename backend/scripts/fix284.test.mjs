// fix284: the game page's three columns on PC (Yarin, 29 Oct: "the space left and right of the centre column is empty").
//  - the preview writers (football, basketball, NFL) never write "UTC" or "… brings A to H"; dates / times are marks the
//    page fills in the visitor's zone; crawler / hub copies (plainPreview) have no mark and no "UTC";
//  - on a football, basketball, NFL and tennis game (the seeded test site, English, signed out): at 1440 px the preview
//    is left of the centre column and "Your picks" right of it (on the prediction tab and on a second tab); at 1100 px
//    both in one right column, the preview above; at 375 px one column, no horizontal scroll; no "UTC" in any preview;
//  - "What this game means": the API answers null to visitors, the page has no such block; admins keep it (Admin label).
//
//   npm run test:fix284 (builds backend + frontend first)
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
const API_SPORT = { football: 'football', basketball: 'basketball', 'american-football': 'nfl' };

/* ---------- the text ---------- */

test('preview writers: no "UTC", no "brings", day / time as marks', () => {
  for (const f of ['matchPreview.ts', 'bbPreview.ts', 'nflGameExtras.ts', 'tennisSite.ts']) {
    const src = fs.readFileSync(path.join(here, '../src/services', f), 'utf8');
    const writer = f === 'nflGameExtras.ts' ? src.slice(src.indexOf('export function nflPreviewText'), src.indexOf('export function nflPreview(')) : f === 'tennisSite.ts' ? src.slice(src.indexOf('export function tennisWriteup')) : src;
    assert.ok(!/\} UTC\.|timeZone: 'UTC' \}\)\} UTC/.test(writer), `${f}: a preview sentence ends in "UTC"`);
    assert.ok(!/\bbr(ings|ought) \$\{A\}/.test(writer), `${f}: "… brings A to H" is back`);
  }
  const { plainPreview, dayMark, timeMark, dayWords } = require('../dist/utils/previewWhen.js');
  const iso = '2026-10-30T23:30:00.000Z';
  const text = `Philadelphia 76ers host New York Knicks on ${dayMark(iso)} in the NBA. Tip-off is at ${timeMark(iso)}. See SportLikely's prediction for this game.`;
  const plain = plainPreview(text);
  assert.equal(plain, `Philadelphia 76ers host New York Knicks on ${dayWords(iso, 'UTC')} in the NBA. See SportLikely's prediction for this game.`);
  assert.match(dayWords(iso, 'UTC'), /^Friday, 30 October( 2026)?$/);
  assert.equal(dayWords(iso, 'America/New_York').startsWith('Friday, 30 October'), true);
  assert.equal(dayWords(iso, 'Asia/Jerusalem').startsWith('Saturday, 31 October'), true);
  assert.ok(!/UTC|⟦/.test(plain));
});

/* ---------- the pages ---------- */

let site = null, browser = null, games = {};
/** a season forecast for the basketball test game's league (the seed has none): the admin's "What this game means" */
function seedForecast(dir, slug) {
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(path.join(dir, 'bet-to-beat.sqlite'));
  d.exec('PRAGMA busy_timeout = 5000');
  const id = d.prepare(`SELECT id FROM slugs WHERE sport = 'basketball' AND kind = 'match' AND slug = ?`).get(slug)?.id;
  const g = id && d.prepare(`SELECT game_id, code, home_id, away_id, home_name, away_name FROM bb_games WHERE game_id = ?`).get(id);
  if (g) {
    const row = (tid, name, title) => ({ id: String(tid), name, group: null, logo: null, now: { rank: 1, pts: 0, played: 5, w: 3, d: 0, l: 2, diff: 10 }, avgPts: 0, avgPos: 2, zones: { title }, pos: [] });
    d.prepare(`INSERT OR REPLACE INTO season_forecast (sport, code, name, season, run_at, runs, known, zones, groups_, teams) VALUES ('basketball', ?, 'Test league', '2026', ?, 1000, 1, '["title"]', '[]', ?)`)
      .run(g.code, new Date().toISOString(), JSON.stringify([row(g.home_id, g.home_name, 0.3), row(g.away_id, g.away_name, 0.2)]));
    d.prepare(`INSERT OR REPLACE INTO season_forecast_games (sport, game_id, code, json) VALUES ('basketball', ?, ?, ?)`)
      .run(String(g.game_id), g.code, JSON.stringify({ home: String(g.home_id), away: String(g.away_id), homeZones: { title: [0.36, 0.22] }, awayZones: { title: [0.14, 0.27] }, results: ['H', 'A'], share: [0.55, 0.45] }));
  }
  d.close();
}
before(async () => {
  site = await startSite({ log: () => undefined });
  const sample = samplePages(site.dataDir);
  for (const s of SPORTS) games[s] = sample[s].matchNext;
  seedForecast(site.dataDir, games.basketball);
  const exe = findChromium();
  if (!exe) throw new Error('no Chromium for playwright-core (PLAYWRIGHT_CHROMIUM)');
  browser = await playwright().chromium.launch({ executablePath: exe });
}, { timeout: 600_000 });
after(async () => { await browser?.close().catch(() => undefined); await site?.stop(); });

async function open(url, width, { admin = false, tz = 'America/New_York' } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, timezoneId: tz, locale: 'en-US' });
  if (admin) await ctx.addCookies([{ name: 'b2b_session', value: TEST_USERS.admin.tokens.unlocked, url: site.base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(site.base + url, { waitUntil: 'load', timeout: 45_000 });
  // the game, the preview and Your picks (both load after the page)
  for (let t0 = Date.now(); Date.now() - t0 < 20_000; await sleep(200))
    if (await page.evaluate(() => !!document.querySelector('[data-game-layout]') && !!document.querySelector('[data-your-picks]') && !!document.querySelector('[data-game-preview]')).catch(() => false)) break;
  await sleep(800);
  return { page, ctx, errors };
}
/** where the preview, Your picks and the centre column are */
const boxes = page => page.evaluate(() => {
  const r = el => { if (!el) return null; const b = el.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }; };
  const pv = document.querySelector('[data-game-preview]'), yp = document.querySelector('[data-your-picks]');
  return {
    layout: document.querySelector('[data-game-layout]')?.getAttribute('data-game-layout') || null,
    main: r(document.querySelector('[data-game-main]')),
    preview: r(pv), picks: r(yp),
    previewSide: pv?.closest('[data-game-side]')?.getAttribute('data-game-side') || null,
    picksSide: yp?.closest('[data-game-side]')?.getAttribute('data-game-side') || null,
    previewText: pv?.textContent || '',
    scroll: document.documentElement.scrollWidth - window.innerWidth,
    sticky: getComputedStyle(pv?.closest('[data-game-side]') || document.body).position
  };
});

for (const sport of SPORTS) {
  test(`${sport}: three columns at 1440, two at 1100, one at 375`, { timeout: 180_000 }, async () => {
    const slug = games[sport];
    assert.ok(slug, `${sport}: no coming game in the seeded site`);
    const url = `/${sport}/match/${slug}`;
    // 1440: preview left, Your picks right, on the prediction tab and on another tab
    for (const u of [url, `${url}/h2h`]) {
      const { page, ctx, errors } = await open(u, 1440);
      const b = await boxes(page);
      assert.equal(b.layout, '3', `${u} at 1440: layout ${b.layout}`);
      assert.equal(b.previewSide, 'left', `${u}: preview not in the left column`);
      assert.equal(b.picksSide, 'right', `${u}: Your picks not in the right column`);
      assert.ok(b.preview.right <= b.main.left + 1, `${u}: preview overlaps the centre`);
      assert.ok(b.picks.left >= b.main.right - 1, `${u}: Your picks overlaps the centre`);
      assert.equal(b.sticky, 'sticky', `${u}: side columns not sticky`);
      assert.ok(b.previewText.length > 40 && !/UTC|⟦/.test(b.previewText), `${u}: preview text "${b.previewText.slice(0, 120)}"`);
      assert.deepEqual(errors, [], `${u}: page errors`);
      await ctx.close();
    }
    // 1100: one right column, preview above Your picks
    {
      const { page, ctx } = await open(url, 1100);
      const b = await boxes(page);
      assert.equal(b.layout, '2', `${url} at 1100: layout ${b.layout}`);
      assert.equal(b.previewSide, 'right'); assert.equal(b.picksSide, 'right');
      assert.ok(b.preview.bottom <= b.picks.top + 1, 'preview not above Your picks');
      assert.ok(b.preview.left >= b.main.right - 1, 'right column overlaps the centre');
      await ctx.close();
    }
    // 375: one column (preview, the prediction, Your picks), no horizontal scroll
    {
      const { page, ctx } = await open(url, 375);
      const b = await boxes(page);
      assert.equal(b.layout, '1', `${url} at 375: layout ${b.layout}`);
      assert.equal(b.previewSide, null); assert.equal(b.picksSide, null);
      assert.ok(b.scroll <= 0, `${url} at 375: ${b.scroll} px horizontal scroll`);
      assert.ok(b.preview.top < b.picks.top, 'preview not above Your picks');
      assert.ok(!/UTC|⟦/.test(b.previewText), 'UTC in the phone preview');
      await ctx.close();
    }
  });
}

test('What this game means: gone for visitors, kept for admins', { timeout: 180_000 }, async () => {
  let adminSeen = 0;
  for (const sport of ['football', 'basketball', 'american-football']) {
    const slug = games[sport];
    const id = (await (await fetch(`${site.base}/api/slug/${sport}/match/${slug}`)).json())?.data?.id;
    assert.ok(id, `${sport}: no id for ${slug}`);
    const api = `${site.base}/api/season-forecast/${API_SPORT[sport]}/game/${id}`;
    const anon = await (await fetch(api)).json();
    assert.equal(anon.data, null, `${sport}: visitors still get the season odds`);
    const free = await (await fetch(api, { headers: { cookie: `b2b_session=${TEST_USERS.free.token}` } })).json();
    assert.equal(free.data, null, `${sport}: free users still get the season odds`);
    const adm = await (await fetch(api, { headers: { cookie: `b2b_session=${TEST_USERS.admin.tokens.unlocked}` } })).json();

    const { page, ctx } = await open(`/${sport}/match/${slug}`, 1440);
    assert.ok(!(await page.evaluate(() => document.body.innerText.includes('What this game means'))), `${sport}: the block is on the visitor's page`);
    await ctx.close();
    if (adm.data) {
      const a = await open(`/${sport}/match/${slug}`, 1440, { admin: true });
      for (let t0 = Date.now(); Date.now() - t0 < 10_000; await sleep(200)) if (await a.page.evaluate(() => !!document.querySelector('#game-meaning'))) break;
      const txt = await a.page.evaluate(() => document.querySelector('#game-meaning')?.innerText || '');
      assert.ok(txt.includes('What this game means') && txt.includes('Admin'), `${sport}: admin page has no labelled block ("${txt.slice(0, 80)}")`);
      adminSeen++;
      await a.ctx.close();
    }
  }
  assert.ok(adminSeen > 0, 'no seeded game had season odds for the admin to see');
});
