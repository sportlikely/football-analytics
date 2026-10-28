// fix206: the how-it-works pages and the changelog. Run: npm run test:fix206 (dist build, scratch database)
//  - every locale has every string (the page text, the model inputs, the new UI strings, every changelog entry)
//  - the input lists match the models' code (football: the rows the model uses; every sport: the names it lists)
//  - the changelog is sorted, renders for crawlers and filters by sport; the accuracy table keeps 20+ games only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '../src/services');
const FRONT = path.resolve(here, '../../frontend/src');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix206-how-'));
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'warn';
process.env.PUBLIC_LANGS = 'en,es,pt,de,fr,it,tr,ar,he'; // fix257: ar / he are admin-only by default; the crawler pages are tested as public
const require = createRequire(import.meta.url);
const { db } = require('../dist/db/index.js');
const hiw = require('../dist/services/howItWorks.js');
const { renderIndex, seoPage, sitemapXml, SITEMAPS } = require('../dist/services/seo.js');

const LANGS = ['de', 'es', 'fr', 'it', 'pt', 'tr', 'id', 'hi', 'pl', 'el', 'ru', 'ar', 'he'];
/** fix257: changelog entries carry their own text in these; ar / he show the English until an entry has its own */
const CHANGELOG_LANGS = ['de', 'es', 'fr', 'it', 'pt', 'tr', 'id', 'hi', 'pl', 'el', 'ru'];
const INPUT_FILES = { football: 'gridModel', basketball: 'bbModel', 'american-football': 'nflModel', tennis: 'tennisModel' };
const inputs = {};
for (const [s, f] of Object.entries(INPUT_FILES)) inputs[s] = (await import(pathToFileURL(path.join(SRC, `${f}.inputs.ts`)).href)).MODEL_INPUTS;
const text = await import(pathToFileURL(path.join(SRC, 'howItWorks.text.ts')).href);
const changelog = JSON.parse(fs.readFileSync(path.resolve(here, '../../docs/changelog.json'), 'utf8')).entries;

test('every locale has every string of the pages, the model inputs and the new UI', () => {
  const keys = new Set(text.hiwStrings(Object.fromEntries(Object.entries(inputs).map(([s, m]) => [s, m.inputs]))));
  // t('…') literals in the new frontend files
  for (const f of ['components/sport/HowItWorks.tsx', 'pages/Changelog.tsx', 'components/sport/game/ModelName.tsx'])
    for (const m of fs.readFileSync(path.join(FRONT, f), 'utf8').matchAll(/\bt\(\s*(['"])((?:\\.|(?!\1).)*)\1/g)) keys.add(m[2].replace(/\\'/g, "'"));
  assert.ok(keys.size > 80, `only ${keys.size} keys found`);
  for (const l of LANGS) {
    const d = JSON.parse(fs.readFileSync(path.join(FRONT, 'locales', `${l}.json`), 'utf8'));
    const missing = [...keys].filter(k => !(k in d) || !String(d[k]).trim());
    assert.deepEqual(missing, [], `${l}.json is missing ${missing.length} strings`);
    // placeholders survive the translation
    for (const k of keys) for (const p of k.match(/\{\w+\}/g) || []) assert.ok(d[k].includes(p), `${l}: "${k}" lost ${p}`);
  }
  for (const e of changelog) for (const l of ['en', ...CHANGELOG_LANGS]) assert.ok(e.text[l]?.trim(), `changelog ${e.date}: no ${l} text`);
});

test('the input lists match the model configs and the code', () => {
  for (const [sport, m] of Object.entries(inputs)) {
    assert.equal(m.sport, sport);
    const code = m.files.map(f => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');
    const keys = new Set();
    for (const i of m.inputs) {
      assert.ok(!keys.has(i.key), `${sport}: input ${i.key} twice`); keys.add(i.key);
      assert.ok(i.code.length > 0, `${sport}/${i.key}: no code names`);
      for (const c of i.code) assert.ok(code.includes(c), `${sport}/${i.key}: "${c}" is not in ${m.files.join(', ')} any more: update ${INPUT_FILES[sport]}.inputs.ts`);
    }
  }
  // football: the '#…' rows listed = exactly the rows gridModel.ts uses
  const grid = fs.readFileSync(path.join(SRC, 'gridModel.ts'), 'utf8');
  const ids = name => JSON.parse(grid.match(new RegExp(`export const ${name} = (\\[[^\\]]*\\])`))[1].replace(/'/g, '"'));
  const used = new Set([...ids('TEAM_ROW_IDS'), ...ids('DRAW_ROW_IDS')]);
  const listed = new Set(inputs.football.inputs.flatMap(i => i.code.filter(c => c.startsWith('#'))));
  assert.deepEqual([...listed].sort(), [...used].sort());
  // the API serves exactly these lists
  for (const s of hiw.HIW_SPORTS) assert.deepEqual(hiw.INPUTS[s].map(i => i.key), inputs[s].inputs.map(i => i.key));
});

test('the changelog: newest first, valid entries, renders for crawlers in every language, filters by sport', async () => {
  const dates = changelog.map(e => e.date);
  assert.deepEqual(dates, [...dates].sort().reverse(), 'docs/changelog.json must be newest first');
  for (const e of changelog) {
    assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(['all', ...hiw.HIW_SPORTS].includes(e.sport), e.sport);
    assert.ok(['model', 'site'].includes(e.kind), e.kind);
    if (e.sport === 'all') assert.equal(e.version, null);
    assert.doesNotMatch(e.text.en, /\b(bet|bets|betting|wager|odds|bookmakers?)\b/i, `${e.date}: betting words`);
  }
  // sports before launch: admins only
  delete process.env.TENNIS_PUBLIC;
  assert.ok(hiw.changelog(true).some(e => e.sport === 'tennis'));
  assert.ok(!hiw.changelog(false).some(e => e.sport === 'tennis'));
  // crawler copy: every language, hreflang alternates, in the sitemap
  for (const l of ['en', ...LANGS]) {
    const s = seoPage(`${l === 'en' ? '' : `/${l}`}/changelog`);
    assert.ok(!s.noindex);
    assert.ok(s.body.includes('<li>'));
    const html = renderIndex('<html lang="en"><head><title>x</title></head><body><div id="root"></div></body></html>', s);
    assert.ok(html.includes('hreflang="de"') && html.includes('hreflang="x-default"'));
    const first = changelog.find(e => hiw.hiwPublic(e.sport));
    assert.ok(s.body.includes((first.text[l] || first.text.en).replace(/"/g, '&quot;').replace(/'/g, '&#39;')), `${l}: newest entry missing`);
  }
  assert.ok(SITEMAPS['sitemap-football.xml']().includes('/changelog</loc>'));
  assert.ok(sitemapXml().includes('sitemap-football.xml'));
  // the page's filter (frontend/src/lib/howItWorks.ts): a sport's own entries and the ones for every sport
  const { filterEntries } = await import(pathToFileURL(path.join(FRONT, 'lib/howItWorks.ts')).href);
  const bb = filterEntries(changelog, 'basketball');
  assert.ok(bb.length > 0 && bb.every(e => e.sport === 'basketball' || e.sport === 'all'));
  assert.ok(bb.some(e => e.sport === 'basketball'));
  assert.equal(filterEntries(changelog, 'all').length, changelog.length);
});

test('how-it-works: accuracy table (20+ games, Brier), FAQ with the live number, pages in every language', () => {
  const DAY = 86400000, ago = d => new Date(Date.now() - d * DAY).toISOString();
  let id = 1;
  const fb = (code, name, n) => {
    for (let i = 0; i < n; i++, id++) {
      db.prepare(`INSERT INTO predictions (match_id, model, competition_code, competition_name, utc_date, home_team, away_team, p_home, p_draw, p_away, locked, settled, created_at, updated_at)
        VALUES (?, 'grid-v3', ?, ?, ?, 'Home', 'Away', 60, 25, 15, 1, 1, ?, ?)`).run(id, code, name, ago(2 + (i % 50)), ago(3 + (i % 50)), ago(2));
      db.prepare(`INSERT INTO results (match_id, status, home_goals, away_goals, outcome, settled_at) VALUES (?, 'FINISHED', 1, 0, 'H', ?)`).run(id, ago(2));
    }
  };
  fb('PL', 'Premier League', 25);
  fb('AF79', '2. Bundesliga', 5);
  const d = hiw.howItWorks('football');
  assert.deepEqual(d.accuracy.rows.map(r => r.key), ['PL'], 'only competitions with 20+ games');
  assert.equal(d.accuracy.rows[0].n, 25);
  assert.equal(d.accuracy.rows[0].main, 100); // home win is inside the double chance (1X)
  assert.equal(d.accuracy.rows[0].brier, 0.245); // (1 − .6)² + .25² + .15²
  assert.deepEqual(d.inputs.map(i => i.key), inputs.football.inputs.map(i => i.key));
  assert.equal(d.faq.length, 5);
  assert.deepEqual(d.faq[0].vars, { 0: 100, 1: 30 }); // the overall number counts every competition
  for (const l of ['en', ...LANGS]) {
    const s = seoPage(`${l === 'en' ? '' : `/${l}`}/how-it-works`);
    assert.ok(!s.noindex, l);
    assert.ok(s.body.includes('Premier League') && s.body.includes('0.245'), `${l}: accuracy table`);
    const faq = s.jsonld.find(j => j['@type'] === 'FAQPage');
    assert.equal(faq.mainEntity.length, 5);
    assert.match(faq.mainEntity[0].acceptedAnswer.text, /100/);
    assert.doesNotMatch(s.body, /\{\d\}/, `${l}: unfilled placeholder`);
    assert.doesNotMatch(s.body + s.title, /\b(odds|bookmaker|betting)\b/i);
    if (l !== 'en') assert.notEqual(s.title, seoPage('/how-it-works').title, `${l}: title not translated`);
  }
  // a sport before its launch: noindex for crawlers (and a 404 for visitors from the API)
  delete process.env.TENNIS_PUBLIC;
  assert.ok(seoPage('/tennis/how-it-works').noindex);
  process.env.TENNIS_PUBLIC = '1';
  assert.ok(!seoPage('/tennis/how-it-works').noindex);
  delete process.env.TENNIS_PUBLIC;
});
