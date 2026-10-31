// fix289: text and naming slips (31 Oct full check). (1) a team takes a plural verb in every English sentence the site
// writes about it ("Utah Jazz win instead", never "wins"); (2) one name style per game page — the hero, the prediction
// bar and Your picks show the same short name of both sides ("Jazz" with "Blazers", never "Utah Jazz" with "Blazers");
// (3) the referee card: "1 game", and the line under it says how many games the numbers need and how many he has, in
// all 13 languages; (4) Hebrew names: the AI spellings the review found wrong (Goztepe "גזטפה", West Virginia "וסט")
// are blocked and asked again with the press list as examples, both names are on the press list.
// (dist build) Run: npm run test:fix289
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix289-'));
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'warn';
process.env.NAMES_GAP_MS = '0';
delete process.env.ANTHROPIC_API_KEY;
const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const FRONT = path.join(here, '../../frontend/src');
const BACK = path.join(here, '../src');
const read = p => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const { db } = require('../dist/db/index.js');
const NS = require('../dist/utils/nameScript.js');
const GX = require('../dist/utils/gameExtras.js');
const names = require('../dist/services/names.js');
const ai = require('../dist/services/namesAi.js');
const { bbPageNames, fbPageNames, pairPageNames } = await import('../../frontend/src/lib/gameNames.ts');

const LOCALES = fs.readdirSync(path.join(FRONT, 'locales')).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5));
const dict = l => JSON.parse(read(path.join(FRONT, 'locales', `${l}.json`)));
/** lib/i18n.ts fill(): the plural branch for n, then the {0} placeholders */
function fill(s, vars, lang) {
  const rules = new Intl.PluralRules(lang);
  const out = s.replace(/\{(\w+\s*,\s*plural\s*,[^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g, (_, body) => {
    const m = body.match(/^\s*(\w+)\s*,\s*plural\s*,\s*([\s\S]*)$/);
    const n = Number(vars[m[1]]);
    const br = {};
    for (const b of m[2].matchAll(/(=\d+|zero|one|two|few|many|other)\s*\{([^{}]*)\}/g)) br[b[1]] = b[2];
    return (br[`=${n}`] ?? br[rules.select(n)] ?? br.other).replace(/#/g, String(n));
  });
  return out.replace(/\{(\w+)\}/g, (all, k) => (k in vars ? String(vars[k]) : all));
}
/** every t("…") / tt("…") / tNodes("…") / g("…") key written in the frontend code */
function codeKeys() {
  const keys = new Map();
  const walk = dir => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) { if (f.name !== 'locales') walk(p); continue; }
      if (!/\.(tsx?|mjs)$/.test(f.name)) continue;
      for (const m of read(p).matchAll(/\b(?:t|tt|g|tNodes)\(\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/g)) keys.set(m[1].slice(1, -1).replace(/\\'/g, "'"), path.relative(FRONT, p));
    }
  };
  walk(FRONT);
  return keys;
}

test('a team takes a plural verb: "{0} win instead", "{0} play again", "have no games", "are more rested", "have the edge"', () => {
  const keys = codeKeys();
  for (const k of ['{0} win instead', '{0} play again {1} later ({2}).', '{0} are more rested: {1} days off vs {2}', '{0} have the edge in the last {1} meetings',
    'New to this league: {0} have no games in it yet, so they start from the league average.',
    'new to this league: {0} have no games in it yet, so they start from the league average']) {
    assert.ok(keys.has(k), `the code says "${k}"`);
    for (const l of LOCALES) assert.ok(k in dict(l), `${l} translates "${k}"`);
  }
  assert.match(read(path.join(FRONT, 'components/sport/prediction/questions.ts')), /t\("\{0\} win instead", \{ 0: lose \}\)/, 'the By how much? card');
  assert.match(read(path.join(BACK, 'services/gridModel.ts')), /\$\{t\.name\} have no games in it yet, so they start from/, 'the football model reason');
  // a sentence with a team subject and a singular verb: none left. The singular ones below have a player / a count /
  // a model as their subject (or are the tennis sentences, about one player).
  const SINGULAR_OK = /^\{0\} (is out|is doubtful|is questionable|is reported out|has missed the last games|is out for \{1\}|is rated|returns after|played a long match|had a medical|is analysing|is our own model|is not live yet|is a \{1\} page|comes from|starts at quarterback|is on the injury report|wins \{1\}|wins the first set|wins at least one set|wins no set|won · \{1\} lost|bets · \{1\} won|wins in a row$)|^\{team\} has (won|lost) \{k\} of their last \{n\} \{games\}$|^(Head-to-head on \w+|Form): \{0\} (leads|won)|^(In good|Poor) form: \{0\} wins/;
  const bad = [...keys].filter(([k, f]) => /\{(\d|team|home|away|name)\} (wins|has|is|plays|keeps|leads|scores|concedes|loses|beats|needs|gets|goes|edges|trails)\b/.test(k) && !SINGULAR_OK.test(k)
    // the reasons saved before fix289 keep their translation (lib/genText.ts, kept on purpose)
    && !(f.endsWith('genText.ts') && k.startsWith('new to this league: {0} has no games')));
  assert.deepEqual(bad.map(([k, f]) => `${f}: ${k}`), [], 'team sentences with a singular verb');
  // the push alert: a team "are ahead", a tennis player "is ahead"; every push language has the new line
  const push = read(path.join(BACK, 'utils/pushRules.ts'));
  assert.match(push, /s\.sport === 'tennis' \? tx\('\{0\} is ahead\. [^']*'[^)]*\) : tx\('\{0\} are ahead\. Before the game we gave them \{1\}%\.'/);
  for (const f of fs.readdirSync(path.join(BACK, 'locales/push'))) assert.ok('{0} are ahead. Before the game we gave them {1}%.' in JSON.parse(read(path.join(BACK, 'locales/push', f))), `push ${f}`);
});

test('one name style per game page: both sides short the same way; the hero, the bar and Your picks share the names', () => {
  // the 31 Oct page: "Utah Jazz" next to "Blazers"
  assert.deepEqual(bbPageNames('Utah Jazz', 'Portland Trail Blazers', 'NBA'), { home: 'Jazz', away: 'Blazers' });
  assert.deepEqual(bbPageNames('Utah Jazz', 'Boston Celtics', 'NBA'), { home: 'Utah Jazz', away: 'Boston Celtics' }, 'both fit: both full');
  assert.deepEqual(bbPageNames('Real Madrid', 'Olympiacos Piraeus', 'EL'), { home: 'Real Madrid', away: 'Olympiacos' }, 'no nickname pattern outside the NBA');
  assert.deepEqual(fbPageNames({ name: 'Manchester United FC', shortName: 'Man United' }, { name: 'Wolverhampton Wanderers FC', shortName: 'Wolverhampton' }), { home: 'Man United', away: 'Wolverhampton' });
  assert.deepEqual(pairPageNames('Kansas City Chiefs', 'Buffalo Bills', n => n.split(' ').pop()), { home: 'Chiefs', away: 'Bills' });
  const pages = {
    'pages/bb/BbGame.tsx': /const nm = bbPageNames\(g\.home\.name, g\.away\.name, g\.league\.code\)/,
    'pages/nfl/NflGame.tsx': /const nm = pairPageNames\(g\.home\.name, g\.away\.name, n => nick\(n, g\.league\)\)/,
    'pages/tennis/TennisMatch.tsx': /const nm = pairPageNames\(m\.home, m\.away, surname\)/
  };
  for (const [f, rx] of Object.entries(pages)) {
    const s = read(path.join(FRONT, f));
    assert.match(s, rx, `${f}: the page's names`);
    assert.match(s, /names=\{nm\}/, `${f}: the prediction bar`);
    assert.match(s, /home=\{side\(\w\.home, nm\.home\)\}\s*away=\{side\(\w\.away, nm\.away\)\}/, `${f}: the hero`);
    assert.match(s, /<YourPicks [^>]*home=\{nm\.home\} away=\{nm\.away\}/, `${f}: Your picks`);
    assert.match(s, /name: shown,/, `${f}: the hero shows the page's name`);
  }
  const fb = read(path.join(FRONT, 'pages/MatchDetail.tsx'));
  assert.doesNotMatch(fb, /shortTeam\(/, 'football: no three-letter names in the bar ("Man United" in the header, "MUN" in the bar)');
  assert.match(fb, /const \{ home: hn, away: an \} = fbPageNames\(home, away\)/);
  assert.match(fb, /name: team\.shortName \|\| team\.name,/, 'the hero: the same rule as fbPageNames');
  const wp = read(path.join(FRONT, 'components/sport/game/WinnerPrediction.tsx'));
  assert.match(wp, /pick: \{ words: pick === 'H' \? hn : an,/, '"Our pick" uses the bar\'s names');
  assert.doesNotMatch(wp, /x\.home\.name : x\.away\.name/);
});

test('referee card: "1 game", the count the numbers come from, singular / plural in all 13 languages', () => {
  const lg = { homeWin: 0.45, cards: 4, pens: 0.3 };
  const one = GX.refereeStats([{ homeWin: true, cards: 3, pens: 0 }], lg);
  assert.equal(one.games, 1);
  assert.equal(one.min, GX.MIN_REF_GAMES, 'the server sends the games the numbers need');
  assert.equal(one.show, false);
  const A = '{n, plural, one {# game} other {# games}} in this league this season';
  const B = 'We show his numbers from {0} games in this league this season ({n, plural, one {# game} other {# games}} so far).';
  assert.equal(fill(A, { n: 1 }, 'en'), '1 game in this league this season');
  assert.equal(fill(A, { n: 12 }, 'en'), '12 games in this league this season');
  assert.equal(fill(B, { 0: 10, n: 1 }, 'en'), 'We show his numbers from 10 games in this league this season (1 game so far).');
  const gx = read(path.join(FRONT, 'components/sport/game/GameExtras.tsx'));
  assert.ok(gx.includes(`t('${A}', { n: r.games ?? 0 })`), 'the card note');
  assert.ok(gx.includes(`t('${B}', { 0: r.min ?? 10, n: r.games ?? 0 })`), 'the line under it');
  assert.doesNotMatch(gx, /\{0\} games this season|His numbers show from 10 games/, 'the old lines are gone');
  for (const l of LOCALES) {
    const d = dict(l);
    for (const k of [A, B]) {
      assert.ok(d[k], `${l}: "${k}"`);
      assert.match(d[k], /plural,[^]*\bone \{[^]*other \{/, `${l}: one and other branches`);
      for (const n of [1, 2, 5, 11, 21]) assert.doesNotMatch(fill(d[k], { 0: 10, n }, l), /[{}#]/, `${l} n=${n} renders`);
    }
    assert.match(d[B], /\{0\}/, `${l}: the games needed`);
  }
  assert.equal(fill(dict('he')[A], { n: 1 }, 'he'), 'משחק אחד בליגה הזו העונה');
  assert.equal(fill(dict('ru')[A], { n: 2 }, 'ru'), '2 матча в этой лиге в этом сезоне');
  assert.equal(fill(dict('ru')[A], { n: 5 }, 'ru'), '5 матчей в этой лиге в этом сезоне');
  assert.equal(fill(dict('pl')[A], { n: 1 }, 'pl'), '1 mecz w tej lidze w tym sezonie');
  assert.equal(fill(dict('de')[A], { n: 1 }, 'de'), '1 Spiel in dieser Liga in dieser Saison');
});

test('Hebrew names: Goztepe and West Virginia from the press list; the review\'s AI spellings are blocked', () => {
  assert.deepEqual(NS.fallbackName('Göztepe', 'he', 'team'), { name: 'גוזטפה', source: 'press' });
  assert.deepEqual(NS.fallbackName('West Virginia', 'he', 'team'), { name: 'ווסט וירג\'יניה', source: 'press' });
  assert.equal(NS.fallbackName('West Virginia Mountaineers', 'he', 'team').name, 'ווסט וירג\'יניה');
  assert.equal(NS.fallbackName('Göztepe', 'ar', 'team').source, 'press');
  assert.ok(NS.spellingFlags('Göztepe', 'גזטפה', 'he', 'team').includes('blocked'));
  assert.ok(NS.spellingFlags('West Virginia', 'וסט וירג\'יניה', 'he', 'team').includes('blocked'));
  assert.ok(NS.spellingFlags('West Bromwich Albion', 'וסט ברומיץ\'', 'he', 'team').includes('blocked'), 'the same wrong word in another name');
  assert.ok(!NS.spellingFlags('West Ham', 'ווסטהאם', 'he', 'team').includes('blocked'));
  assert.ok(!NS.spellingFlags('Göztepe', 'גוזטפה', 'he', 'team').includes('blocked'));
  assert.ok(!NS.visibleName({ source: 'ai', conf: 0.95, flags: 'blocked' }), 'never shown');
  const note = NS.aiRetryNote({ blocked: NS.blockedWords('Göztepe', 'גזטפה', 'he') });
  assert.match(note, /"גזטפה" for "goztepe" \(the press writes "גוזטפה"\)/);
  assert.match(note, /west ham = ווסטהאם/, 'the press list as examples');
  assert.match(note, /goztepe = גוזטפה/);
  assert.doesNotMatch(note, /another alphabet/, 'only what was wrong');
});

test('the two names come back right: stored AI spellings → press; a blocked AI name is asked again with the press examples', async () => {
  const now = new Date().toISOString();
  const item = db.prepare(`INSERT INTO name_items (sport, kind, latin, id, country, weight, seen_at) VALUES (?, 'team', ?, ?, ?, 100, ?)`);
  const nm = db.prepare(`INSERT INTO names (sport, kind, latin, lang, name, source, at, conf) VALUES (?, 'team', ?, 'he', ?, 'ai', ?, 0.9)`);
  item.run('football', 'Göztepe', '994', 'Turkey', now); nm.run('football', 'Göztepe', 'גזטפה', now);
  item.run('american-football', 'West Virginia', '777', 'USA', now); nm.run('american-football', 'West Virginia', 'וסט וירג\'יניה', now);
  item.run('football', 'West Bromwich Albion', '60', 'England', now); nm.run('football', 'West Bromwich Albion', 'וסט ברומיץ\'', now);
  const tried = db.prepare(`INSERT INTO names_ai_tried (sport, kind, latin, basis, at) VALUES (?, 'team', ?, ?, ?)`);
  for (const [s, l] of [['football', 'Göztepe'], ['american-football', 'West Virginia'], ['football', 'West Bromwich Albion']]) tried.run(s, l, l, now);
  names.setNamesFetcher(async url => ({ ok: true, status: 200, json: async () => (/sparql/.test(url) ? { results: { bindings: [] } } : /wbsearchentities/.test(url) ? { search: [] } : { entities: {} }) }));
  await names.namesTick({ wd: 0, ai: false });
  const row = (sport, latin, lang = 'he') => db.prepare(`SELECT name, source, flags FROM names WHERE sport = ? AND latin = ? AND lang = ?`).get(sport, latin, lang);
  assert.deepEqual({ ...row('football', 'Göztepe') }, { name: 'גוזטפה', source: 'press', flags: null });
  assert.deepEqual({ ...row('american-football', 'West Virginia') }, { name: 'ווסט וירג\'יניה', source: 'press', flags: null });
  assert.match(row('football', 'West Bromwich Albion').flags, /blocked/, 'no press spelling: flagged, hidden');
  await names.buildMaps();
  const map = lang => JSON.parse(names.namesJson(lang) || '{"names":{}}').names;
  assert.equal(map('he')['Göztepe'], 'גוזטפה');
  assert.equal(map('he')['West Bromwich Albion'], undefined, 'the page keeps the Latin name meanwhile');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM names_ai_tried WHERE latin = 'West Bromwich Albion'`).get().n, 0, 'to be asked again');

  // the AI: the same wrong word first, then the press spelling once it has the examples
  const calls = [];
  ai.setNamesAiFetcher(async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const lines = body.messages[0].content.split('\n').filter(l => /^\d+\t/.test(l)).map(l => l.split('\t')[3]);
    const text = lines.map((name, i) => name === 'West Bromwich Albion' ? (calls.length === 1 ? `${i}|וסט ברומיץ'|0.9|وست بروميتش|0.9` : `${i}|ווסט ברומיץ'|0.9||`) : `${i}|||`).join('\n');
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text }], usage: { input_tokens: 2000, output_tokens: 2500 }, stop_reason: 'end_turn' }) };
  });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.NAMES_AI_DAILY_USD = '2';
  await ai.namesAiTick({ batches: 1 });
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(calls.length, 2, 'one batch + one retry');
  assert.match(calls[1].messages[0].content, /"וסט" for "west" \(the press writes "ווסט"\)/);
  assert.match(calls[1].messages[0].content, /west ham = ווסטהאם/, 'the retry has the press list as examples');
  assert.deepEqual({ ...row('football', 'West Bromwich Albion') }, { name: 'ווסט ברומיץ\'', source: 'ai', flags: null });
  assert.equal(row('football', 'West Bromwich Albion', 'ar').name, 'وست بروميتش', 'the Arabic of the first answer stays');
  await names.buildMaps();
  assert.equal(map('he')['West Bromwich Albion'], 'ווסט ברומיץ\'');
});
