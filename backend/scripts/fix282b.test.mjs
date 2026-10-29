// fix282b: "Why we think so" never says how many factors we use (Yarin, 29 Oct: "We checked 11 things for this game …").
// (dist + frontend/dist build) Run: npm run test:fix282b
//  1. the panel of a football, basketball, NFL and tennis game in every language (admin, so ar / he too): the heading names
//     the favourite ("<Team> are the favourite. Here is what tips it …" / "Too close to call …") and no number stands next to
//     "things" / "factors" or their translations
//  2. no locale value, no crawler / How it works text carries a count of factors
//  3. the old wrong link from fix280 (/football/match/barcelona-vs-deportivo-alaves-2026-10-31) 301s in one hop to the
//     match's slug and is kept as an alias
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSite, playwright, findChromium, siteLanguages } from './site-server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FRONT = path.join(here, '../../frontend/src');

/** "things" / "factors" in every language (a count would stand next to one of these) */
const WORDS = 'things|thing|factors|factor|cosas|factores|coisas|fatores|Dinge|Faktoren|éléments|choses|facteurs|cose|fattori|şey|faktör|hal(?![a-z])|faktor|चीज़|चीज़ें|फ़ैक्टर|कारक|rzecz|rzeczy|czynnik|czynników|πράγματα|παράγοντ|παράγοντες|вещ|вещей|фактор|факторов|عوامل|عاملاً|أشياء|דברים|גורמים|דבר';
const COUNT_BEFORE = new RegExp(`(?<![\\p{L}\\d.])\\d+\\s*(?:different\\s+|verschiedene\\s+)?(?:${WORDS})`, 'iu');
const COUNT_AFTER = new RegExp(`(?:${WORDS})[^\\s:,.;]*\\s+(?:ال|الـ)?\\d+(?!\\s*%)`, 'iu'); // "عواملنا الـ13"; not "factors: 1,000 points"
const EN_WORDS = /\b(one|two|three|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen)\s+(things|factors)\b/i;
const countIn = text => { const line = text.replace(/\{\d+\}/g, 'X'); return COUNT_BEFORE.test(line) || COUNT_AFTER.test(line) || EN_WORDS.test(line); }; // a {0} placeholder is not a count

test('the count check itself: catches the old headings in any order, lets shares and "Four factors" through', () => {
  for (const bad of ['We checked 11 things for this game.', 'Revisamos 11 cosas para este partido.', '13 faktörümüz: 1000 puanlık dağılım', 'عواملنا الـ13: توزيع', 'Наши 13 факторов', 'We checked eleven things'])
    assert.ok(countIn(bad), bad);
  for (const ok of ['Four factors', 'Home advantage', '48%', 'Our factors: 1,000 points split', 'عواملنا: توزيع 1,000 نقطة', 'Cleveland Cavaliers are the favourite. Here is what tips it, from the biggest push to the smallest.'])
    assert.ok(!countIn(ok), ok);
});

test('no locale value and no server page text carries a count of factors', () => {
  const files = fs.readdirSync(path.join(FRONT, 'locales')).filter(f => f.endsWith('.json'));
  for (const f of files) {
    const d = JSON.parse(fs.readFileSync(path.join(FRONT, 'locales', f), 'utf8'));
    for (const [k, v] of Object.entries(d)) {
      assert.ok(!countIn(k), `${f}: key "${k}"`);
      assert.ok(!countIn(String(v)), `${f}: "${v}"`);
    }
  }
  const panel = fs.readFileSync(path.join(FRONT, 'components/sport/game/WhyPanel.tsx'), 'utf8');
  assert.ok(!/v\.n\b/.test(panel.replace(/if \(!v\.n\) return null/, '')), 'the panel never prints the number of factors');
  assert.match(panel, /'\{0\} are the favourite\. Here is what tips it, from the biggest push to the smallest\.'/);
  assert.match(panel, /'Too close to call\. Here is what pushes each way\.'/);
  for (const f of ['howItWorks.ts', 'seo.ts', 'seoTennis.ts']) {
    const p = path.join(here, '../src/services', f);
    if (fs.existsSync(p)) assert.ok(!countIn(fs.readFileSync(p, 'utf8')), `${f} names a count of factors`);
  }
});

/* ---------- the panel in every sport and language (injected model numbers: the seed has none) ---------- */

const FOOTBALL_GRID = {
  matchType: 'standard', points: { home: 600, draw: 200, away: 200 }, totals: { home: 0, away: 0 }, drawPot: { base: 240, factors: 0, volatility: 0, total: 200 }, reasons: [], homeEdge: 30,
  rows: [
    { id: '#1', name: 'Squad value', rel: 4, home: 9.8, away: 7.1, edge: 10.8 }, { id: '#1e', name: 'Overall strength', rel: 5, home: 9.1, away: 7.4, edge: 8.5 },
    { id: '#12', name: 'Confirmed lineups', rel: 2, home: 5.5, away: 5.5, edge: 0, note: 'XI not published yet' },
    { id: '#7', name: 'Head-to-head', rel: 2, home: 5, away: 5, edge: 0, note: 'only 2 meetings in the data — not enough to count' },
    { id: '#21', name: 'Form, last 6', rel: 3, home: 5.1, away: 8.9, edge: -11.4 }, { id: '#19', name: 'Attack', rel: 3, home: 8.8, away: 7, edge: 5.4 },
    { id: '#14', name: 'Defence', rel: 3, home: 7.2, away: 7.6, edge: -1.2 }, { id: '#13', name: 'Missing players', rel: 2, home: 5.5, away: 5.5, edge: 0, note: 'out: none | none' },
    { id: '#10', name: 'Rest and fixture load', rel: 1, home: 6, away: 6, edge: 0 }, { id: '#23', name: 'Home and away record', rel: 2, home: 7, away: 6, edge: 2 },
    { id: '#1p', name: 'Player quality', rel: 1, home: 7, away: 6, edge: 1 }
  ]
};
const FACTORS = {
  basketball: [{ k: 'bb.team', pts: 90 }, { k: 'bb.impact', pts: 25 }, { k: 'bb.home', pts: 30 }, { k: 'bb.missing', pts: -15 }, { k: 'bb.fourFactors', pts: 8 }, { k: 'bb.h2h', pts: 0, idle: 'meetings' }, { k: 'bb.rest', pts: 0, idle: 'rest' }, { k: 'market', pts: 12 }],
  'american-football': [{ k: 'nfl.rating', pts: 60 }, { k: 'nfl.home', pts: 48 }, { k: 'nfl.rest', pts: -25 }, { k: 'nfl.qb', pts: 0, idle: 'missing' }],
  tennis: [{ k: 'tn.rating', pts: 0.62 }, { k: 'tn.serve', pts: 0.21 }, { k: 'tn.fatigue', pts: -0.08 }, { k: 'tn.rank', pts: 0.04 }, { k: 'tn.home', pts: 0, idle: 'level' }]
};
function inject(sport, x, depth = 0) {
  if (!x || typeof x !== 'object' || depth > 8) return x;
  if (sport === 'football' && typeof x.expectedGoals === 'object' && typeof x.home === 'number' && !x.locked) Object.assign(x, { grid: FOOTBALL_GRID, home: 60, draw: 20, away: 20, locked: false });
  if (sport === 'basketball' && x.game && Array.isArray(x.why)) x.factors = FACTORS.basketball;
  if (sport !== 'football' && sport !== 'basketball' && typeof x.pHome === 'number' && !x.locked) Object.assign(x, { factors: FACTORS[sport], pHome: 70, pAway: 30 });
  for (const v of Object.values(x)) inject(sport, v, depth + 1);
  return x;
}

test('the panel in football, basketball, NFL and tennis, every language: a favourite, never a count', { timeout: 900_000 }, async () => {
  const site = await startSite({ log: () => {} });
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(site.dataDir, 'bet-to-beat.sqlite'), { readOnly: true });
    const today = new Date().toISOString().slice(0, 10);
    const games = {};
    for (const sport of ['football', 'basketball', 'american-football', 'tennis'])
      games[sport] = db.prepare(`SELECT slug FROM slugs WHERE sport = ? AND kind = 'match' AND is_primary = 1 AND substr(slug, -10) > ? ORDER BY substr(slug, -10) LIMIT 1`).get(sport, today)?.slug;
    db.close();
    const browser = await playwright().chromium.launch({ executablePath: findChromium() });
    const failures = [];
    let seen = 0;
    try {
      for (const lang of siteLanguages().all) {
        const ctx = await browser.newContext({ viewport: { width: 375, height: 900 } });
        await ctx.addCookies([{ name: 'b2b_session', value: 'admin-unlocked-token', url: site.base }]);
        await ctx.addInitScript(() => { try { localStorage.setItem('b2b_guess_first', '0'); } catch { /* fine */ } });
        const page = await ctx.newPage();
        for (const sport of Object.keys(games)) {
          const slug = games[sport];
          if (!slug) { failures.push(`${sport}: no coming game in the seed`); continue; }
          await page.unrouteAll({ behavior: 'ignoreErrors' });
          await page.route('**/api/**', async r => {
            const res = await r.fetch();
            if (!(res.headers()['content-type'] || '').includes('json')) return r.fulfill({ response: res });
            let j; try { j = await res.json(); } catch { return r.fulfill({ response: res }); }
            return r.fulfill({ response: res, json: inject(sport, j) });
          });
          await page.goto(`${site.base}${lang ? `/${lang}` : ''}/${sport}/match/${slug}`, { waitUntil: 'networkidle' });
          const panel = page.locator('[data-why-panel]').first();
          // fix281: "Why we think so" opens from a button under the prediction list
          try { const b = page.locator('[data-testid="why-button"]').first(); await b.waitFor({ timeout: 15000 }); if ((await b.getAttribute('aria-expanded')) !== 'true') await b.click(); } catch { /* an older layout: the panel is open */ }
          try { await panel.waitFor({ timeout: 15000 }); } catch { failures.push(`${lang || 'en'} ${sport}: no panel`); continue; }
          seen++;
          const lines = (await panel.innerText()).split('\n').map(x => x.trim()).filter(Boolean);
          for (const l of lines) if (countIn(l)) failures.push(`${lang || 'en'} ${sport}: "${l}"`);
          if (!lang && !lines.some(l => /are the favourite\. Here is what tips it, from the biggest push to the smallest\./.test(l)))
            failures.push(`en ${sport}: heading is not "<Team> are the favourite …": ${lines.slice(0, 3).join(' | ')}`);
        }
        await ctx.close();
      }
    } finally { await browser.close(); }
    assert.deepEqual(failures, []);
    assert.equal(seen, 4 * siteLanguages().all.length);
  } finally { await site.stop(); }
});

/* ---------- the old Alavés link ---------- */

test('the old wrong link from fix280 answers 301 in one hop to the match, and is kept as an alias', { timeout: 300_000 }, async () => {
  const site = await startSite({ log: () => {} });
  try {
    // the seed's Barça – Alavés game (Football-Data.org: "FC Barcelona" – "Deportivo Alavés", predictions: "Barça" – "Alavés")
    const { DatabaseSync: D0 } = await import('node:sqlite');
    const d0 = new D0(path.join(site.dataDir, 'bet-to-beat.sqlite'), { readOnly: true });
    const day = d0.prepare(`SELECT substr(slug, -10) AS d FROM slugs WHERE sport = 'football' AND kind = 'match' AND is_primary = 1 AND slug LIKE 'barcelona-vs-alaves-%'`).get()?.d;
    d0.close();
    assert.ok(day, 'the seed has Barça – Alavés');
    const OLD = `barcelona-vs-deportivo-alaves-${day}`, NEW = `barcelona-vs-alaves-${day}`;
    for (const [from, to] of [[`/football/match/${OLD}`, `/football/match/${NEW}`], [`/es/football/match/${OLD}`, `/es/football/match/${NEW}`]]) {
      const r = await fetch(site.base + from, { redirect: 'manual' });
      assert.equal(r.status, 301, from);
      const loc = new URL(r.headers.get('location'), site.base).pathname;
      assert.equal(loc, to);
      const r2 = await fetch(site.base + to, { redirect: 'manual' });
      assert.equal(r2.status, 200, `${to}: one hop`);
    }
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(site.dataDir, 'bet-to-beat.sqlite'), { readOnly: true });
    const rows = db.prepare(`SELECT slug, id, is_primary FROM slugs WHERE sport = 'football' AND kind = 'match' AND slug IN (?, ?)`).all(NEW, OLD);
    db.close();
    const prim = rows.find(r => r.is_primary === 1), alias = rows.find(r => r.is_primary === 0);
    assert.ok(prim && alias, JSON.stringify(rows));
    assert.equal(alias.slug, OLD);
    assert.equal(String(alias.id), String(prim.id));
  } finally { await site.stop(); }
});
