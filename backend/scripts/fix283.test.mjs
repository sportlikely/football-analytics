// fix283: Hebrew / Arabic names that are right (Yarin, 29 Oct: "many mistakes"). Yarin's 8 examples come out right or
// stay Latin; surname-first provider names are turned first-last before any spelling; the checks block a final letter
// inside a word, a triple letter, a dictionary / place word, lost initials, Latin letters left; letter rules are never
// shown; an admin's spelling wins forever; nothing calls the AI without ANTHROPIC_API_KEY (and the daily cap holds);
// Wikidata by provider ids, the Hebrew Wikipedia title when there is no label; a player found by name only is refused.
// (dist build) Run: npm run test:fix283
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix283-'));
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

// the basketball tables the collector reads (only the columns it uses)
db.exec(`CREATE TABLE IF NOT EXISTS bb_games (game_id INTEGER PRIMARY KEY, kickoff TEXT, home_id INTEGER, home_name TEXT, away_id INTEGER, away_name TEXT, code TEXT);
  CREATE TABLE IF NOT EXISTS bb_player_stats (game_id INTEGER NOT NULL, team_id INTEGER NOT NULL, player_id INTEGER NOT NULL, name TEXT, PRIMARY KEY (game_id, player_id));`);

const now = new Date().toISOString();
const item = (sport, kind, latin, id, extra = {}) => db.prepare(`INSERT OR REPLACE INTO name_items (sport, kind, latin, id, country, weight, views, viewed_at, seen_at, display, dob, team, ext)
  VALUES (?, ?, ?, ?, ?, 5, ?, ?, ?, ?, ?, ?, ?)`).run(sport, kind, latin, String(id), extra.country ?? null, extra.views ?? 0, extra.views ? now : null, now, extra.display ?? null, extra.dob ?? null, extra.team ?? null, extra.ext ? JSON.stringify(extra.ext) : null);
const row = (latin, lang = 'he') => db.prepare(`SELECT name, source, flags, conf, approved FROM names WHERE latin = ? AND lang = ?`).get(latin, lang);
const map = lang => JSON.parse(names.namesJson(lang) || '{"names":{}}').names;
// a fake Wikidata: nothing found unless a test says so
let wd = () => null;
const wdCalls = [];
names.setNamesFetcher(async url => {
  wdCalls.push(url);
  const ok = body => ({ ok: true, status: 200, json: async () => body });
  return ok(wd(url) || (/sparql/.test(url) ? { results: { bindings: [] } } : /wbsearchentities/.test(url) ? { search: [] } : { entities: {} }));
});
// a fake AI that counts its calls
const aiCalls = [];
let aiAnswer = () => '';
ai.setNamesAiFetcher(async (url, init) => {
  aiCalls.push({ url, body: JSON.parse(init.body), headers: init.headers });
  return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: aiAnswer(JSON.parse(init.body)) }], usage: { input_tokens: 3000, output_tokens: 6000 }, stop_reason: 'end_turn' }) };
});

test('surname-first provider names are turned first-last before any spelling', () => {
  assert.equal(NS.personOrder('Lillard Damian', { sport: 'basketball', kind: 'player' }), 'Damian Lillard');
  assert.equal(NS.personOrder('Knight Brandon', { sport: 'basketball', kind: 'player' }), 'Brandon Knight');
  assert.equal(NS.personOrder('Jackson Jr. Jaren', { sport: 'basketball', kind: 'player' }), 'Jaren Jackson Jr.');
  assert.equal(NS.personOrder('D. Harper', { sport: 'basketball', kind: 'player' }), 'D. Harper', 'already first-last');
  assert.equal(NS.personOrder('Washington, Jordan', { sport: 'nfl', kind: 'player' }), 'Jordan Washington');
  assert.equal(NS.personOrder('Sinner J.', { sport: 'tennis', kind: 'player', first: 'Jannik', last: 'Sinner' }), 'Jannik Sinner', "the provider's own first / last fields");
  assert.equal(NS.personOrder('Jauan Jennings', { sport: 'nfl', kind: 'player' }), 'Jauan Jennings');
  assert.equal(NS.personOrder('Real Madrid', { sport: 'football', kind: 'team' }), 'Real Madrid', 'only persons');
  assert.equal(NS.fallbackName(NS.personOrder('Lillard Damian', { sport: 'basketball', kind: 'player' }), 'he', 'player').name, 'דמיאן לילארד');
});

test('the checks block a final letter inside a word, a triple letter, a dictionary word, lost initials, Latin left', () => {
  const f = (latin, local, kind = 'player', lang = 'he') => NS.spellingFlags(latin, local, lang, kind);
  assert.ok(f('Jordan Washington', 'ירדן וושינגטון').includes('dictionary'), 'ירדן is the country / river, not the person');
  assert.deepEqual(f('Jordan', 'ירדן', 'country'), [], 'the country itself is fine');
  assert.ok(f('Bowling Green', 'בווולינג גרין', 'team').includes('triple'));
  assert.ok(f('Martin Odegaard', 'םרטין אודגור').includes('final-inside'), 'a final letter at the start of a word');
  assert.ok(f('N. Touliatos', 'ן. טוליאטוס').includes('initials-lost'), 'the initial written as a Hebrew final letter');
  assert.ok(f('D.J. Reed', "ג' ריד").includes('initials-lost'));
  assert.deepEqual(f('D.J. Reed', 'D.J. ריד'), [], 'Latin initials + Hebrew surname');
  assert.deepEqual(f('N. Touliatos', 'N. טוליאטוס'), []);
  assert.ok(f('Jauan Jennings', "ג'ואן Jennings").includes('latin-left'));
  assert.deepEqual(f('Maccabi Tel Aviv', 'מכבי תל אביב', 'team'), [], 'a place word the Latin name means');
  assert.ok(f('Mazen Amman', 'מאזן עמאן', 'player').includes('dictionary'));
  assert.ok(NS.spellingFlags('Jordan Smith', 'الأردن سميث', 'ar', 'player').includes('dictionary'), 'Arabic too');
  assert.deepEqual(NS.spellingFlags('Real Madrid', 'ريال مدريد', 'ar', 'team'), []);
  // the letter rules themselves: initials stay Latin, two vavs at most
  assert.equal(NS.translit('N. Touliatos', 'he').split(' ')[0], 'N.');
  assert.equal(NS.translit('D.J. Reed', 'he').split(' ')[0], 'D.J.');
  assert.doesNotMatch(NS.translit('Bowling Green', 'he'), /ווו/);
  // every press spelling passes its own checks
  const bad = [];
  for (const lang of ['he', 'ar']) for (const [k, v] of NS.PRESS[lang]) { const fl = NS.spellingFlags(k, v, lang, 'team'); if (fl.length) bad.push(`${lang} ${k} → ${v}: ${fl}`); }
  assert.deepEqual(bad, []);
});

test("Yarin's 8 examples come out right or Latin; letter rules are never shown; the re-run fixes old rows", async () => {
  // old rows from before fix283 (letter rules on the surname-first name): the one-time re-run replaces them
  item('basketball', 'player', 'Lillard Damian', 1, { views: 90 });
  db.prepare(`INSERT INTO names (sport, kind, latin, lang, name, source, at) VALUES ('basketball', 'player', 'Lillard Damian', 'he', 'לילרד דמיאן', 'translit', ?)`).run(now);
  db.prepare(`INSERT INTO bb_games (game_id, kickoff, home_id, home_name, away_id, away_name, code) VALUES (1, ?, 10, 'Portland Trail Blazers', 11, 'Boston Celtics', 'NBA')`).run(now);
  db.prepare(`INSERT INTO bb_player_stats (game_id, team_id, player_id, name) VALUES (1, 10, 1, 'Lillard Damian'), (1, 11, 2, 'Knight Brandon'), (1, 11, 3, 'Washington Jordan')`).run();
  item('nfl', 'player', 'Jauan Jennings', 4, { views: 80 });
  item('nfl', 'team', 'Bowling Green', 5, { views: 70 });
  item('basketball', 'player', 'N. Touliatos', 6, { views: 60 });
  item('nfl', 'player', 'D.J. Reed', 7, { views: 50 });
  item('football', 'team', 'Levante', 8, { views: 40, country: 'Spain' });
  await names.namesTick({ collect: true, wd: 0 });
  const he = map('he'), ar = map('ar');
  assert.equal(he['Lillard Damian'], 'דמיאן לילארד', 'surname first fixed: the press spelling of Damian Lillard');
  assert.equal(he['Damian Lillard'], 'דמיאן לילארד', 'the first-last name is a key too');
  assert.equal(ar['Lillard Damian'], 'داميان ليلارد');
  assert.equal(row('Lillard Damian').source, 'press', 'the old letter-rule row was replaced');
  assert.equal(he['Levante'], 'לבאנטה');
  for (const latin of ['Washington Jordan', 'Knight Brandon', 'Jauan Jennings', 'Bowling Green', 'N. Touliatos', 'D.J. Reed']) {
    assert.equal(he[latin], undefined, `${latin}: Latin on the page (got ${he[latin]})`);
    assert.equal(ar[latin], undefined, `${latin}: Latin on the Arabic page`);
    const r = row(latin);
    assert.ok(!r || r.source === 'translit', `${latin}: only a letter-rule row for review (${r?.source})`);
  }
  assert.equal(db.prepare(`SELECT display FROM name_items WHERE latin = 'Knight Brandon'`).get().display, 'Brandon Knight');
  assert.doesNotMatch(row('Knight Brandon').name, /^קניגט/, 'built from the first-last name');
  assert.equal(names.nameIn('he', 'Jauan Jennings'), 'Jauan Jennings', "the server's own texts too");
  // nothing a letter rule wrote is in the map
  const translit = db.prepare(`SELECT latin, name FROM names WHERE lang = 'he' AND source = 'translit'`).all();
  assert.ok(translit.length >= 5);
  for (const t of translit) assert.notEqual(he[t.latin], t.name, `${t.latin}: a letter-rule spelling on the page`);
  // the one-time re-run is recorded and does not run again
  assert.ok(db.prepare(`SELECT value FROM names_meta WHERE key = 'fix283'`).get());
});

test('an admin spelling wins forever; approve shows a flagged one; the admin list has sources and flags', async () => {
  assert.deepEqual(names.setAdminName('basketball', 'player', 'Washington Jordan', 'he', "ג'ורדן וושינגטון"), { ok: true });
  await names.namesTick({ wd: 0 });
  await names.buildMaps();
  assert.equal(map('he')['Washington Jordan'], "ג'ורדן וושינגטון");
  assert.equal(map('he')['Jordan Washington'], "ג'ורדן וושינגטון");
  // a Wikidata label (dictionary word) does not overwrite it
  names.writeAiNames([{ it: { sport: 'basketball', kind: 'player', latin: 'Washington Jordan' }, lang: 'he', name: 'ירדן וושינגטון', conf: 0.99 }]);
  assert.equal(row('Washington Jordan').source, 'admin');
  // approve: a letter-rule row the admin checked is shown
  const before = row('Jauan Jennings');
  assert.equal(names.approveName('nfl', 'player', 'Jauan Jennings', 'he').ok, true);
  await names.buildMaps();
  assert.equal(map('he')['Jauan Jennings'], before.name);
  const a = names.namesAdmin({ limit: 300 });
  assert.ok(a.rows.length >= 8 && a.rows.length <= 300);
  const wj = a.rows.find(r => r.latin === 'Washington Jordan');
  assert.equal(wj.names.he.shown, 'admin');
  assert.equal(a.rows.find(r => r.latin === 'Bowling Green').names.he.shown, 'latin');
  assert.ok(a.top.he.latin >= 4 && a.top.he.press >= 2, JSON.stringify(a.top));
  assert.equal(a.ai.configured, false);
  assert.match(names.namesForClaude(), /AI: off/);
});

test('nothing calls the AI without the key; with it: batches, confidence bar, asked once, the daily cap', async () => {
  aiCalls.length = 0;
  await names.namesTick({ wd: 0 });
  assert.equal(aiCalls.length, 0, 'no key, no call');
  assert.equal((await ai.namesAiTick()).skipped, 'no ANTHROPIC_API_KEY');
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.NAMES_AI_DAILY_USD = '0';
  assert.equal((await ai.namesAiTick()).skipped, 'daily cap');
  assert.equal(aiCalls.length, 0, 'the cap stops the call before it is made');
  process.env.NAMES_AI_DAILY_USD = '2';
  aiAnswer = body => {
    const lines = body.messages[0].content.split('\n').slice(1).map(l => l.split('\t'));
    // fix286: the compact answer, one line per name (i|he|conf|ar|conf)
    return lines.map(([i, , , name]) => name === 'Brandon Knight' ? `${i}|ברנדון נייט|0.95|براندون نايت|0.9`
      : name === 'D.J. Reed' ? `${i}|D.J. ריד|0.9|D.J. ريد|0.4`
      : name === 'Bowling Green' ? `${i}|בווולינג גרין|0.9||` : `${i}|||`).join('\n');
  };
  const r = await ai.namesAiTick({ batches: 2 });
  assert.equal(aiCalls.length, 1, `one batch holds every name (${JSON.stringify(r)})`);
  const sent = aiCalls[0];
  assert.equal(sent.headers['x-api-key'], 'test-key');
  assert.match(sent.body.messages[0].content, /Brandon Knight/, 'the first-last name is sent');
  assert.doesNotMatch(sent.body.messages[0].content, /Washington Jordan|Damian/, 'names with a good spelling are not asked');
  await names.buildMaps();
  assert.equal(map('he')['Knight Brandon'], 'ברנדון נייט', 'confident AI spelling shown');
  assert.equal(map('he')['D.J. Reed'], 'D.J. ריד');
  assert.equal(map('ar')['D.J. Reed'], undefined, 'low confidence: Latin');
  assert.equal(row('D.J. Reed', 'ar').source, 'ai');
  assert.equal(map('he')['Bowling Green'], undefined, 'a flagged AI spelling stays Latin');
  assert.match(row('Bowling Green').flags, /triple/);
  // asked once: a second run sends nothing new
  await ai.namesAiTick();
  assert.equal(aiCalls.length, 1, 'never re-asked');
  const st = ai.namesAiStatus();
  assert.equal(st.today.calls, 1);
  assert.ok(st.today.usd > 0 && st.today.usd < 2);
  // the Latin name changes → asked again
  db.prepare(`UPDATE name_items SET display = 'Brandon Knight Jr.' WHERE latin = 'Knight Brandon'`).run();
  await ai.namesAiTick();
  assert.equal(aiCalls.length, 2);
  assert.match(aiCalls[1].body.messages[0].content, /Brandon Knight Jr\./);
  delete process.env.ANTHROPIC_API_KEY;
});

test('Wikidata: by provider ids (SPARQL), the Hebrew Wikipedia title, a name-only player refused', async () => {
  item('football', 'player', 'Pedri', 20, { views: 200, team: 'Barcelona', ext: { P2446: '683840' } });
  item('basketball', 'player', 'Jordan Washington', 21, { views: 190 });
  item('football', 'player', 'Lamine Yamal X', 22, { views: 180, dob: '2007-07-13', ext: { P2446: '937958' } });
  wd = url => {
    if (/sparql/.test(url)) {
      const q = decodeURIComponent(/query=([^&]+)/.exec(url)[1]);
      assert.match(q, /wdt:P2446/);
      return { results: { bindings: [{ item: { value: 'http://www.wikidata.org/entity/Q30' }, v: { value: '683840' } }, { item: { value: 'http://www.wikidata.org/entity/Q31' }, v: { value: '937958' } }] } };
    }
    if (/wbsearchentities/.test(url) && /Jordan%20Washington/.test(url)) return { search: [{ id: 'Q40', label: 'Jordan Washington', match: { text: 'Jordan Washington' }, description: 'American basketball player' }] };
    if (/wbgetentities/.test(url)) return { entities: {
      Q30: { labels: { en: { value: 'Pedri' } }, sitelinks: { hewiki: { title: 'פדרי (כדורגלן)' }, arwiki: { title: 'بيدري' } } },
      Q31: { labels: { en: { value: 'Lamine Yamal' }, he: { value: 'לאמין ימאל' } }, claims: { P569: [{ mainsnak: { datavalue: { value: { time: '+2001-01-01T00:00:00Z' } } } }] } },
      Q40: { labels: { en: { value: 'Jordan Washington' }, he: { value: 'ג\'ורדן וושינגטון' } } }
    } };
    return null;
  };
  await names.namesTick({ wd: 50, ai: false });
  assert.deepEqual({ ...row('Pedri') }, { name: 'פדרי', source: 'wikidata', flags: null, conf: null, approved: 0 }, 'the he Wikipedia title (without "(footballer)")');
  assert.equal(row('Pedri', 'ar').name, 'بيدري');
  assert.equal(db.prepare(`SELECT qid FROM name_items WHERE latin = 'Pedri'`).get().qid, 'Q30');
  assert.equal(db.prepare(`SELECT qid FROM name_items WHERE latin = 'Lamine Yamal X'`).get().qid, null, 'found by id, but the birth date contradicts ours');
  assert.equal(db.prepare(`SELECT qid FROM name_items WHERE latin = 'Jordan Washington'`).get().qid, null, 'a name alone is not enough');
  assert.ok(wdCalls.some(u => /sparql/.test(u)));
  wd = () => null;
});
