// fix286: Hebrew / Arabic names via AI — spend only where people look, and one more check (30 Oct: first batch $0.119
// for 100 names = ~$100 for all 85k; "Brayden" came back "ברייдן" with a Cyrillic letter). An unviewed lower-league
// player is not sent, a viewed one is (top divisions / leaders always); the compact "i|he|conf|ar|conf" answer parses;
// a spelling with letters of another alphabet is blocked, asked again once, then Latin; the daily cap still stops the
// run; the card has the names left to do and their estimated cost.
// (dist build) Run: npm run test:fix286
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix286-'));
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'warn';
process.env.NAMES_GAP_MS = '0';
delete process.env.ANTHROPIC_API_KEY;
const require = createRequire(import.meta.url);
const { db } = require('../dist/db/index.js');
require('../dist/services/apiFootball.js'); // af_fixtures
require('../dist/services/playerData.js'); // af_player_season
const NS = require('../dist/utils/nameScript.js');
const names = require('../dist/services/names.js');
const ai = require('../dist/services/namesAi.js');

names.setNamesFetcher(async url => ({ ok: true, status: 200, json: async () => (/sparql/.test(url) ? { results: { bindings: [] } } : /wbsearchentities/.test(url) ? { search: [] } : { entities: {} }) }));
const calls = [];
let answer = () => '';
ai.setNamesAiFetcher(async (url, init) => {
  const body = JSON.parse(init.body);
  calls.push(body);
  return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: answer(body, calls.length) }], usage: { input_tokens: 2000, output_tokens: 2500 }, stop_reason: 'end_turn' }) };
});
/** the names a call asked for */
const sent = body => body.messages[0].content.split('\n').filter(l => /^\d+\t/.test(l)).map(l => l.split('\t')[3]);
const row = (latin, lang = 'he') => db.prepare(`SELECT name, source, flags, conf FROM names WHERE latin = ? AND lang = ?`).get(latin, lang);
const map = lang => JSON.parse(names.namesJson(lang) || '{"names":{}}').names;

// football players: a top-division one (Premier League 39), a lower-league scorer (league 999, a leader), two lower-league
// players with no goals (one will be viewed)
const season = 2026;
const ps = db.prepare(`INSERT INTO af_player_season (player_id, season, team_id, league_id, name, apps, goals, assists) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
ps.run(101, season, 1, 39, 'Brayden Top', 10, 0, 0);
ps.run(102, season, 2, 999, 'Lower Scorer', 10, 9, 0);
ps.run(103, season, 2, 999, 'Unseen Lowerleague', 10, 0, 0);
ps.run(104, season, 2, 999, 'Viewed Lowerleague', 10, 0, 0);

test('the other-alphabet check: Cyrillic / Greek / Arabic in Hebrew, Hebrew / Cyrillic in Arabic', () => {
  const f = (latin, s, lang = 'he') => NS.spellingFlags(latin, s, lang, 'player');
  assert.ok(f('Brayden', 'ברייдן').includes('other-script'), "the 30 Oct answer");
  assert.ok(f('Alpha Beta', 'אלפα בטא').includes('other-script'), 'Greek');
  assert.ok(f('Sami Ali', 'סאמי علي').includes('other-script'), 'Arabic in Hebrew');
  assert.ok(f('Sami Ali', 'سامي עלי', 'ar').includes('other-script'), 'Hebrew in Arabic');
  assert.ok(f('Ivan Petrov', 'إيفان петров', 'ar').includes('other-script'), 'Cyrillic in Arabic');
  assert.deepEqual(f('D.J. Reed', 'D.J. ריד'), [], 'Latin initials are not another alphabet');
  assert.deepEqual(f('Brandon Knight', 'براندون نايت', 'ar'), []);
  assert.ok(!NS.visibleName({ source: 'ai', conf: 0.95, flags: 'other-script' }), 'never shown');
});

test('the compact answer parses (and nothing else does)', () => {
  const m = NS.parseAi('0|ברנדון נייט|0.95|براندون نايت|0.9\n`1|||براندون|0.6`\n2|Brandon|0.9||\n7|רחוק|0.9||\nhello\n{"i": 3}\n0|כפול|0.9||', 5);
  assert.deepEqual(m.get(0), { he: { name: 'ברנדון נייט', conf: 0.95 }, ar: { name: 'براندون نايت', conf: 0.9 } }, 'the first line of an index wins');
  assert.deepEqual(m.get(1), { ar: { name: 'براندون', conf: 0.6 } }, 'an empty spelling is left out; code marks stripped');
  assert.deepEqual(m.get(2), {}, 'no letters of the language');
  assert.equal(m.has(7), false, 'an index out of range');
  assert.equal(m.size, 3);
  assert.equal(NS.parseAi('[{"i": 0, "he": "א", "he_conf": 1}]', 1).size, 0, 'JSON is not the format any more');
  assert.match(NS.AI_SYSTEM, /index\|hebrew\|confidence\|arabic\|confidence/);
  assert.doesNotMatch(NS.AI_SYSTEM, /JSON only/);
});

test('who is asked: every team / league; players of the top divisions, leaders, or viewed in 60 days', () => {
  const now = Date.now();
  assert.equal(NS.aiWanted({ kind: 'team' }), true);
  assert.equal(NS.aiWanted({ kind: 'player', ai_pick: 'leaders' }), true);
  assert.equal(NS.aiWanted({ kind: 'player', viewed_at: new Date(now - 10 * 86400000).toISOString() }, now), true);
  assert.equal(NS.aiWanted({ kind: 'player', viewed_at: new Date(now - 61 * 86400000).toISOString() }, now), false, 'viewed too long ago');
  assert.equal(NS.aiWanted({ kind: 'player' }), false);
});

test('an unviewed lower-league player is not sent; a viewed one is; a Cyrillic letter is asked again once, then Latin', async () => {
  await names.namesTick({ wd: 0, collect: true });
  const pick = latin => db.prepare(`SELECT ai_pick FROM name_items WHERE kind = 'player' AND latin = ?`).get(latin)?.ai_pick;
  assert.equal(pick('Brayden Top'), 'top division');
  assert.equal(pick('Lower Scorer'), 'leaders');
  assert.equal(pick('Unseen Lowerleague'), null);
  // a view queues the name (the page route's deferred VIEW_SQL)
  db.prepare(names.VIEW_SQL).run('football', 'player', '104');
  assert.ok(db.prepare(`SELECT viewed_at FROM name_items WHERE latin = 'Viewed Lowerleague'`).get().viewed_at);

  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.NAMES_AI_DAILY_USD = '2';
  const before = ai.namesAiStatus();
  assert.ok(before.left.names >= 3 && before.left.waiting >= 1, JSON.stringify(before.left));
  assert.ok(before.left.estUsd > 0 && before.perName.measured === false, 'a first guess before any answer');
  answer = (body, n) => sent(body).map((name, i) => name === 'Brayden Top' ? (n === 1 ? `${i}|ברייдן טופ|0.9|برايدن توب|0.9` : `${i}|ברײדן טופ|0.9||`)
    : name === 'Lower Scorer' ? (n === 1 ? `${i}|לואר סקורר|0.9|لوور سكوررпп|0.9` : `${i}||0|لوور سكورر|0.85`)
    : `${i}|||`).join('\n');
  const r = await ai.namesAiTick({ batches: 1 });
  assert.equal(calls.length, 2, `one batch + one retry (${JSON.stringify(r)})`);
  const first = sent(calls[0]);
  assert.ok(first.includes('Viewed Lowerleague'), 'a viewed lower-league player is sent');
  assert.ok(first.includes('Brayden Top') && first.includes('Lower Scorer'), 'top division and leaders are sent');
  assert.ok(!first.includes('Unseen Lowerleague'), 'an unviewed lower-league player is not sent');
  assert.deepEqual(sent(calls[1]).sort(), ['Brayden Top', 'Lower Scorer'], 'only the names with another alphabet asked again');
  assert.match(calls[1].messages[0].content, /another alphabet/);
  // the retry's answers replace only the spellings with another alphabet
  assert.equal(row('Brayden Top').flags, null);
  assert.equal(row('Lower Scorer', 'ar').name, 'لوور سكورر');
  assert.equal(row('Lower Scorer', 'ar').flags, null);
  assert.equal(row('Brayden Top', 'ar').name, 'برايدن توب');
  await names.buildMaps();
  assert.equal(map('ar')['Lower Scorer'], 'لوور سكورر');
  assert.equal(map('he')['Lower Scorer'], 'לואר סקורר');
  delete process.env.ANTHROPIC_API_KEY;
});

test('still another alphabet after the retry: stored flagged, the page keeps the Latin name', async () => {
  ps.run(105, season, 1, 39, 'Brayden Again', 10, 0, 0);
  await names.namesTick({ wd: 0, collect: true });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  calls.length = 0;
  answer = body => sent(body).map((name, i) => name === 'Brayden Again' ? `${i}|ברייдן אגיין|0.95||` : `${i}|||`).join('\n');
  await ai.namesAiTick({ batches: 1 });
  assert.equal(calls.length, 2, 'asked again once, not more');
  assert.match(row('Brayden Again').flags, /other-script/);
  await names.buildMaps();
  assert.equal(map('he')['Brayden Again'], undefined, 'Latin');
  assert.match(names.namesForClaude(), /left to do \d+ names ≈ \$/);
  delete process.env.ANTHROPIC_API_KEY;
});

test('the daily cap still stops the run; the card has usage per name and the estimate', async () => {
  ps.run(106, season, 1, 39, 'Capped Player', 10, 0, 0);
  await names.namesTick({ wd: 0, collect: true });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.NAMES_AI_DAILY_USD = '0';
  calls.length = 0;
  assert.equal((await ai.namesAiTick()).skipped, 'daily cap');
  assert.equal(calls.length, 0, 'the cap stops the call before it is made');
  const st = ai.namesAiStatus();
  assert.equal(st.perName.measured, true);
  assert.ok(st.perName.inTok > 0 && st.perName.outTok > 0 && st.perName.usd > 0, JSON.stringify(st.perName));
  assert.ok(st.left.names >= 1, 'Capped Player is still to do');
  assert.ok(Math.abs(st.left.estUsd - st.left.names * st.perName.usd) < 0.01, `estimate = names left × cost a name (${JSON.stringify(st.left)})`);
  delete process.env.ANTHROPIC_API_KEY;
  process.env.NAMES_AI_DAILY_USD = '2';
});
