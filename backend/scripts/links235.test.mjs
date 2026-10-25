// fix235: links without "#…", every page under its sport. Run: npm run test:fix235 (after tsc)
//  - tabs are sub-paths in every sport (/<sport>/match/<slug>/<tab>): the page answers, an unknown tab moves to the page,
//    a renamed slug keeps its tab, the crawler page of a tab is the match page (canonical without the tab)
//  - every old page address (/matches, /predictions/today, /accuracy … /basketball/games, /basketball/predictions/today,
//    /american-football/games, /predictions/<hub>) answers 301 in one hop, every language, allowed query kept
//  - crawler HTML / JSON-LD / emails / sitemaps get the new addresses (pubPath, pubLinks); a sport page is built
//  - the app has no "#…" in its links and no old page address (frontend links-check, part of npm run parity)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix235-links-'));
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'error';
const require = createRequire(import.meta.url);
const { db } = require('../dist/db/index.js');
const rules = require('../dist/utils/slugRules.js');
const slugs = require('../dist/services/slugs.js');

const SPORTS = ['football', 'basketball', 'american-football', 'tennis'];
const LANGS = ['', '/es', '/pt', '/de', '/fr', '/it', '/tr'];
// one match per sport (+ a renamed football match: old slug kept as an alias)
const at = new Date().toISOString();
const add = (sport, kind, slug, id, primary = 1) => db.prepare(`INSERT OR REPLACE INTO slugs (sport, kind, slug, id, is_primary, base, at) VALUES (?, ?, ?, ?, ?, NULL, ?)`).run(sport, kind, slug, id, primary, at);
const MATCH = { football: 'barcelona-vs-real-madrid-2026-10-25', basketball: 'lakers-vs-celtics-2026-10-26', 'american-football': 'chiefs-vs-bills-2026-10-26', tennis: 'carlos-alcaraz-vs-jannik-sinner-2026-10-27' };
SPORTS.forEach((s, i) => { add(s, 'match', MATCH[s], String(100 + i)); add(s, 'league', `${s}-league`, String(200 + i)); });
add('football', 'match', 'barca-vs-madrid-2026-10-25', '100', 0);
// the tabs each sport's match page has (frontend: MatchDetail TAB_IDS, BbGame / NflGame / TennisMatch TABS)
const TABS = {
  football: ['stats', 'lineups', 'rest', 'h2h', 'table', 'highlights'],
  basketball: ['lineups', 'box', 'stats', 'players', 'quarters', 'rest', 'h2h', 'table', 'highlights'],
  'american-football': ['stats', 'players', 'table', 'rest', 'h2h', 'plays', 'highlights'],
  tennis: ['stats', 'form', 'rest', 'h2h', 'draw', 'highlights']
};

test('tabs are sub-paths in every sport and language', () => {
  for (const s of SPORTS) for (const l of LANGS) {
    for (const tab of TABS[s]) {
      const a = slugs.linkAnswer(`${l}/${s}/match/${MATCH[s]}/${tab}`);
      assert.ok(a && 'page' in a, `${l}/${s}/match/…/${tab} is the match page`);
      assert.equal(a.page.id, String(100 + SPORTS.indexOf(s)));
    }
    assert.deepEqual(slugs.linkAnswer(`${l}/${s}/match/${MATCH[s]}/nonsense`), { to: `${l}/${s}/match/${MATCH[s]}` }, 'an unknown tab → the page');
    assert.deepEqual(slugs.linkAnswer(`${l}/${s}/match/${MATCH[s]}/prediction`), { to: `${l}/${s}/match/${MATCH[s]}` }, 'the prediction is the page itself');
    assert.ok('page' in slugs.linkAnswer(`${l}/${s}/league/${s}-league/forecast`), 'league forecast tab');
  }
  // a renamed slug keeps its tab, one hop
  assert.deepEqual(slugs.linkAnswer('/es/football/match/barca-vs-madrid-2026-10-25/lineups'), { to: '/es/football/match/barcelona-vs-real-madrid-2026-10-25/lineups' });
  // every tab of every page is in the shared list (server and app)
  for (const s of SPORTS) for (const tab of TABS[s]) assert.ok(rules.MATCH_TABS.includes(tab), `${tab} in MATCH_TABS`);
});

const MOVES = {
  '/matches': '/football/matches', '/predictions/today': '/football/today', '/accuracy': '/football/accuracy',
  '/upset-watch': '/football/upset-watch', '/draw-alerts': '/football/draw-alerts', '/favorites': '/football/favorites',
  '/my-picks': '/football/my-picks', '/past': '/football/past',
  '/predictions/premier-league': '/football/predictions/premier-league', '/predictions/nba': '/basketball/predictions/nba',
  '/predictions/euroleague': '/basketball/predictions/euroleague', '/predictions/nfl': '/american-football/predictions/nfl',
  '/predictions/college-football': '/american-football/predictions/college-football',
  '/football/predictions/nba': '/basketball/predictions/nba', '/basketball/predictions/premier-league': '/football/predictions/premier-league',
  '/basketball/games': '/basketball/matches', '/basketball/predictions/today': '/basketball/today',
  '/american-football/games': '/american-football/matches'
};
test('old page addresses 301 in one hop, every language, allowed query kept', () => {
  for (const [from, to] of Object.entries(MOVES)) for (const l of LANGS) {
    assert.deepEqual(slugs.linkAnswer(`${l}${from}`, '?league=PL&x=1'), { to: `${l}${to}?league=PL` }, `${l}${from}`);
    assert.equal(slugs.linkAnswer(`${l}${to}`), null, `${l}${to} is a page (no second hop)`);
    assert.equal(rules.movedPage(to), null);
  }
  // site-wide pages stay at the root; the sport homes and every sport's own pages are not moved
  for (const p of ['/', '/search', '/account', '/premium', '/guides/double-chance', '/changelog', '/how-it-works', '/privacy', '/terms', '/contact',
    '/football', '/basketball', '/tennis/matches', '/tennis/today', '/american-football/today', '/basketball/accuracy', '/tennis/predictions/atp-paris-masters'])
    assert.equal(rules.movedPage(p), null, p);
});

test('crawler links, emails, sitemaps: the new addresses', () => {
  for (const [from, to] of Object.entries(MOVES)) {
    assert.equal(slugs.pubPath(from), to);
    assert.equal(slugs.pubPath(`https://sportlikely.com/de${from}?utm_source=email`), `https://sportlikely.com/de${to}?utm_source=email`);
    // a crawler page is built from the old address and named by the new one
    if (!/^\/(football|basketball)\/predictions\/(nba|premier-league)$/.test(from)) assert.equal(slugs.pubPath(rules.internalPage(to) ?? to), to, `${to} round trip`);
  }
  const html = slugs.pubLinks(`<a href="/matches">x</a><a href='/es/predictions/today'>y</a><a href="/basketball/games?league=NBA">z</a>{"url":"https://sportlikely.com/accuracy"}<a href="/matchesx">keep</a>`);
  assert.equal(html, `<a href="/football/matches">x</a><a href='/es/football/today'>y</a><a href="/basketball/matches?league=NBA">z</a>{"url":"https://sportlikely.com/football/accuracy"}<a href="/matchesx">keep</a>`);
  const seo = require('../dist/services/seo.js');
  const pg = seo.seoPage('/fr/football/matches');
  assert.equal(pg.path, '/football/matches');
  assert.ok(!/href="(\/[a-z]{2})?\/(matches|predictions\/today)"/.test(pg.body), 'no old address in the crawler page');
  assert.equal(seo.seoPage('/football/favorites').noindex, true, 'private pages stay noindex under their sport');
});

test('the app: no "#…" in links, no old page address, tab routes in every sport (links-check)', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const out = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', path.resolve(here, '../../frontend/scripts/links-check.ts')], { encoding: 'utf8' });
  assert.match(out, /every item link is a slug link/);
});
