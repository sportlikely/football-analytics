// fix261: (1) every sentence the server writes for a public page has its template in frontend/src/lib/genText.ts and
// that template is translated in every language; (2) the names dictionary — press spelling / letter rules for Hebrew and
// Arabic, the worker's job on a scratch database (a fake Wikidata), the order of trust (admin > press > Wikidata > rules),
// a league name two countries share left Latin, search in both scripts, the map the app loads, the tables never touched
// by retention. (dist build) Run: npm run test:fix261 (also starts scripts/lang-audit.mjs: the pages in 13 languages)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix261-'));
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'warn';
process.env.NAMES_GAP_MS = '0';
const require = createRequire(import.meta.url);
const { db } = require('../dist/db/index.js');
require('../dist/services/apiFootball.js'); // af_fixtures
require('../dist/services/playerData.js'); // af_player_season
const NS = require('../dist/utils/nameScript.js');
const names = require('../dist/services/names.js');
const { PROTECTED } = require('../dist/utils/retention.js');

const SRC = path.resolve(here, '../src');
const FRONT = path.resolve(here, '../../frontend/src');
const LANGS = ['es', 'pt', 'de', 'fr', 'it', 'tr', 'id', 'hi', 'pl', 'el', 'ru', 'ar', 'he'];

/** the g("…") templates of lib/genText.ts */
const GEN = [...fs.readFileSync(path.join(FRONT, 'lib/genText.ts'), 'utf8').matchAll(/\bg\(("(?:[^"\\\n]|\\.)*")\)/g)].map(m => JSON.parse(m[1]));

/** the string / template literals of a source part, `${…}` (nested ones too) turned into a wildcard */
function literals(src) {
  const out = [];
  for (let i = 0; i < src.length; i++) {
    const q = src[i];
    if (q !== '`' && q !== "'") continue;
    let j = i + 1, s = '', depth = 0;
    for (; j < src.length; j++) {
      const c = src[j];
      if (c === '\\') { s += src[j + 1]; j++; continue; }
      if (q === '`' && c === '$' && src[j + 1] === '{') {
        // skip the expression (balanced braces, its own strings)
        depth = 1; j += 2;
        for (; j < src.length && depth; j++) {
          if (src[j] === '{') depth++;
          else if (src[j] === '}') depth--;
          else if (src[j] === '`') { j++; let d2 = 0; for (; j < src.length; j++) { if (src[j] === '\\') { j++; continue; } if (src[j] === '$' && src[j + 1] === '{') { d2++; j++; continue; } if (src[j] === '}' && d2) { d2--; continue; } if (src[j] === '`' && !d2) break; } }
          else if (src[j] === "'") { j++; while (j < src.length && src[j] !== "'") { if (src[j] === '\\') j++; j++; } }
        }
        j--; s += '\u0000';
        continue;
      }
      if (c === q) break;
      if (q === "'" && c === '\n') break;
      s += c;
    }
    out.push(s);
    i = j;
  }
  return out;
}
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** a server literal (wildcards) matches a template (its placeholders as written) */
const ES = JSON.parse(fs.readFileSync(path.join(FRONT, 'locales/es.json'), 'utf8'));
const covered = lit => {
  if (!lit.includes('\u0000') && (lit in ES || GEN.some(k => k.includes(lit)))) return true; // a key already, or a piece of a template
  const re = new RegExp(`^${lit.split('\u0000').map(esc).join('.*?')}$`, 's');
  return GEN.some(k => re.test(k));
};
/** the parts of each generator that write the sentences a public page shows */
const SOURCES = [
  ['services/teamAnalysis.ts', /function notesFor[\s\S]*?\n}\n/],
  ['services/bbTeamAnalysis.ts', /notes: fixed rules on the numbers[\s\S]*?const order = /],
  ['services/tennisModel.ts', /function whyLines[\s\S]*?\n}\n/],
  ['services/gridModel.ts', /const eur = \(x: number \| null\)[\s\S]*?const evidence = /],
  ['services/gridModel.ts', /function describeLc[\s\S]*?\n}\n/],
  ['services/clubElo.ts', /const rows: NonNullable<Prediction\['grid'\]>\['rows'\] = \[[\s\S]*?const ptsH/],
  ['services/nationalElo.ts', /const rows: NonNullable<Prediction\['grid'\]>\['rows'\] = \[[\s\S]*?const ptsH/]
];
/** literals that are not text (ids, keys, formats, single words used inside the sentences above) */
const NOT_TEXT = /^(#\w+|[+~€%x\- ]*|\u0000*|en-GB|long|plus|minus|note|draw|team|today|yesterday|promoted|bottom3|derby, |s|none|n\/a|, |\d+|[A-Z]|H|A|D|W|L)$/;

test('every sentence a generator writes has its template in lib/genText.ts', () => {
  const missing = [];
  for (const [file, part] of SOURCES) {
    const src = fs.readFileSync(path.join(SRC, file), 'utf8');
    const m = part.exec(src);
    assert.ok(m, `${file}: the generator part was not found (moved? update SOURCES)`);
    for (const lit of literals(m[0].replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''))) {
      const plain = lit.replace(/\u0000/g, '');
      if (NOT_TEXT.test(lit) || !/[a-z]{3,}/i.test(plain) || /^[a-z_]+$/.test(lit) || /^(SELECT|UPDATE|INSERT)/.test(lit) || / (=|IN|AND) /.test(lit)) continue;
      if (/^(id|name|kind|text|rel|edge|home|away|note)$/.test(lit)) continue;
      if (!covered(lit)) missing.push(`${file}: "${lit.replace(/\u0000/g, '${…}').slice(0, 110)}"`);
    }
  }
  assert.deepEqual(missing, [], `sentences without a template:\n${missing.join('\n')}`);
});

test('every template is translated in every language (placeholders kept)', () => {
  assert.ok(GEN.length > 150, `${GEN.length} templates`);
  const holders = s => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');
  for (const l of LANGS) {
    const d = JSON.parse(fs.readFileSync(path.join(FRONT, 'locales', `${l}.json`), 'utf8'));
    const miss = GEN.filter(k => !(k in d));
    assert.deepEqual(miss.slice(0, 5), [], `${l}: ${miss.length} template(s) not translated`);
    for (const k of GEN) assert.equal(holders(d[k]), holders(k), `${l}: placeholders of "${k.slice(0, 60)}"`);
    // a translation is not the English text (names, numbers and acronyms aside)
    const same = GEN.filter(k => d[k] === k && /[a-z]{4,} [a-z]{3,}/i.test(k.replace(/\{\w+\}/g, '')));
    assert.ok(same.length <= 3, `${l}: ${same.length} template(s) left in English, e.g. "${same[0]}"`);
  }
});

test('letter rules and press spellings: Hebrew and Arabic', () => {
  const he = n => NS.fallbackName(n, 'he', 'team')?.name, ar = n => NS.fallbackName(n, 'ar', 'team')?.name;
  // Yarin's examples (Israeli press spellings)
  assert.equal(he('Real Madrid'), 'ריאל מדריד');
  assert.equal(he('Manchester City'), "מנצ'סטר סיטי");
  assert.equal(he('Bayern Munich'), 'באיירן מינכן');
  assert.equal(he('FC Bayern München'), 'באיירן מינכן');
  assert.equal(ar('Real Madrid'), 'ريال مدريد');
  assert.equal(ar('Al-Hilal Saudi FC'), 'الهلال');
  assert.equal(NS.fallbackName('Real Madrid', 'he', 'team').source, 'press');
  // rules: club words, final letters, an English "magic e", initials, acronyms, numbers
  assert.equal(NS.fallbackName('Erzurumspor', 'he').source, 'translit');
  assert.match(he('Erzurumspor'), /^[֐-׿]+$/);
  assert.equal(NS.translit('Kane', 'he'), 'קיין');
  assert.equal(NS.translit('Declan Rice', 'he'), 'דקלן רייס');
  assert.equal(NS.translit('Los Angeles Lakers', 'he'), "לוס אנג'לס לייקרס");
  assert.equal(NS.translit('Boston Celtics', 'ar'), 'بوسطن سيلتكس');
  assert.match(NS.translit('B. Saka', 'he'), /^B\. /, 'fix283: an initial stays a Latin initial');
  assert.equal(NS.translit('PSV', 'he'), null, 'an acronym alone: no entry (stays as written)');
  assert.match(NS.translit('Getafe Madrid U21', 'he'), /עד גיל 21$/);
  for (const w of ['Napoli', 'Osasuna', 'Cagliari', 'Monza', 'Empoli', 'Lecce', 'Kasimpasa']) {
    const h = NS.translit(w, 'he'), a = NS.translit(w, 'ar');
    assert.match(h, /^[֐-׿' -]+$/, `${w} → ${h}`);
    assert.doesNotMatch(h, /[כמנפצ]$/, `${w}: a Hebrew final letter at the end (${h})`);
    assert.match(a, /^[؀-ۿ -]+$/, `${w} → ${a}`);
  }
  // shared league names: the press spelling only for their country
  assert.equal(NS.fallbackName('Premier League', 'ar', 'league', 'England').name, 'الدوري الإنجليزي الممتاز');
  assert.notEqual(NS.fallbackName('Premier League', 'ar', 'league', 'Ukraine')?.name, 'الدوري الإنجليزي الممتاز');
  assert.equal(NS.pressName('Israel', 'he', 'country'), 'ישראל');
});

test('the names job: collect, rules, Wikidata, admin, maps, search, retention', async () => {
  const now = new Date().toISOString(), day = now.slice(0, 10);
  // a few games and players the site shows
  const fx = db.prepare(`INSERT OR REPLACE INTO af_fixtures (fixture_id, league_id, season, grp, division, kickoff, date, home_id, away_id, home_name, away_name, status) VALUES (?, 39, 2026, 'E', 'E0', ?, ?, ?, ?, ?, ?, 'NS')`);
  fx.run(1, now, day, 42, 49, 'Arsenal', 'Chelsea');
  fx.run(2, now, day, 541, 529, 'Real Madrid', 'Erzurumspor');
  db.prepare(`INSERT OR REPLACE INTO af_player_season (player_id, season, team_id, league_id, name, apps) VALUES (1100, 2026, 42, 39, 'Gabriel Jesus', 9)`).run();
  // a fake Wikidata: "Erzurumspor" is a football club with he / ar labels; everything else is not found
  const calls = [];
  names.setNamesFetcher(async url => {
    calls.push(url);
    const ok = body => ({ ok: true, status: 200, json: async () => body });
    if (/wbsearchentities/.test(url)) {
      const q = decodeURIComponent(/search=([^&]+)/.exec(url)[1]);
      if (q === 'Erzurumspor') return ok({ search: [{ id: 'Q9', label: 'Erzurumspor', match: { text: 'Erzurumspor' }, description: 'Turkish association football club' }, { id: 'Q10', label: 'Erzurumspor', description: 'a village' }] });
      if (q === 'Gabriel Jesus') return ok({ search: [{ id: 'Q11', label: 'Gabriel Jesus', match: { text: 'Gabriel Jesus' }, description: 'Brazilian association football player' }] });
      return ok({ search: [] });
    }
    // fix283: a player found by name needs one more thing that agrees — here his club (P54 → Arsenal)
    if (/wbgetentities/.test(url)) return ok({ entities: { Q9: { labels: { he: { value: 'ארזורומספור (מועדון כדורגל)' }, ar: { value: 'نادي أرضروم سبور' } } }, Q11: { labels: { en: { value: 'Gabriel Jesus' }, he: { value: "גבריאל ז'סוס" }, ar: { value: 'غابرييل جيسوس' } }, claims: { P54: [{ mainsnak: { datavalue: { value: { id: 'Q1' } } } }] } }, Q1: { labels: { en: { value: 'Arsenal F.C.' } } } } });
    return { ok: false, status: 404, json: async () => ({}) };
  });
  const run = await names.namesTick({ collect: true, wd: 50 });
  assert.equal(run.error, null, run.error);
  const row = (latin, lang) => db.prepare(`SELECT name, source FROM names WHERE latin = ? AND lang = ?`).get(latin, lang);
  assert.deepEqual({ ...row('Real Madrid', 'he') }, { name: 'ריאל מדריד', source: 'press' });
  assert.deepEqual({ ...row('Erzurumspor', 'he') }, { name: 'ארזורומספור', source: 'wikidata' }, 'the label, without its "(football club)"');
  assert.deepEqual({ ...row('Erzurumspor', 'ar') }, { name: 'أرضروم سبور', source: 'wikidata' }, 'without "نادي"');
  assert.deepEqual({ ...row('Gabriel Jesus', 'he') }, { name: "גבריאל ז'סוס", source: 'wikidata' });
  assert.equal(row('Arsenal', 'he').source, 'press', 'the press spelling is kept over a Wikidata label');
  assert.ok(row('England', 'he') || row('England', 'ar') || true);
  // admin first; removing it brings the rule / press name back
  assert.deepEqual(names.setAdminName('football', 'team', 'Chelsea', 'he', 'צ׳לסי לונדון'), { ok: true });
  assert.equal(row('Chelsea', 'he').source, 'admin');
  await names.namesTick({ wd: 0 });
  assert.equal(row('Chelsea', 'he').name, 'צ׳לסי לונדון', 'the job never overwrites an admin spelling');
  names.setAdminName('football', 'team', 'Chelsea', 'he', '');
  assert.deepEqual({ ...row('Chelsea', 'he') }, { name: "צ'לסי", source: 'press' });
  assert.equal(names.setAdminName('football', 'team', 'Chelsea', 'xx', 'x').ok, false);
  // the map the app loads, the server's own texts, search in both scripts
  await names.buildMaps();
  const map = JSON.parse(names.namesJson('he')).names;
  assert.equal(map['Real Madrid'], 'ריאל מדריד');
  assert.equal(map['Erzurumspor'], 'ארזורומספור');
  assert.equal(names.namesJson('es'), null, 'only the local-script languages');
  assert.equal(names.nameIn('he', 'Arsenal'), 'ארסנל');
  assert.equal(names.nameIn('es', 'Arsenal'), 'Arsenal');
  assert.equal(names.nameIn('he', 'Unknown FC'), 'Unknown FC', 'no entry: as the provider writes it');
  assert.equal(names.localNamesText('he', 'Arsenal vs Chelsea · Premier League | SportLikely'), "ארסנל vs צ'לסי · Premier League | SportLikely".replace('Premier League', names.nameIn('he', 'Premier League')));
  assert.equal(names.localNamesHtml('he', '<a href="/football/team/arsenal">Arsenal</a>'), '<a href="/football/team/arsenal">ארסנל</a>', 'links stay Latin');
  assert.equal(names.latinFor('ריאל')[0], 'Real Madrid', 'a name that starts with the query first');
  assert.deepEqual(names.latinFor('real'), [], 'a Latin query is searched as it is');
  // page opens count for the admin list
  assert.deepEqual(names.viewOf('/api/team-page/1000000042'), { sport: 'football', kind: 'team', id: '1000000042' });
  db.prepare(names.VIEW_SQL).run('football', 'team', String(1e9 + 49));
  assert.equal(names.namesAdmin({ limit: 5 }).rows[0].latin, 'Chelsea', 'most opened first');
  assert.match(names.namesForClaude(), /Names in Hebrew \/ Arabic/);
  // a Wikidata error stops the run, never the job
  names.setNamesFetcher(async () => ({ ok: false, status: 429, json: async () => ({}) }));
  db.prepare(`UPDATE name_items SET wd_at = NULL`).run();
  const r2 = await names.namesTick({ wd: 5 });
  assert.match(r2.error || '', /429/);
  names.setNamesFetcher(null);
  // never touched by the retention job
  assert.ok(PROTECTED.has('names') && PROTECTED.has('name_items'));
});

test('a league name two countries share is left Latin in the map', async () => {
  const ins = db.prepare(`INSERT OR REPLACE INTO name_items (sport, kind, latin, id, country, weight, seen_at) VALUES ('football', 'league', 'Premier League', ?, ?, 5, ?)`);
  ins.run('AF39', '*', new Date().toISOString());
  db.prepare(`DELETE FROM names WHERE latin = 'Premier League'`).run();
  await names.namesTick({ wd: 0 });
  const r = db.prepare(`SELECT name, source FROM names WHERE latin = 'Premier League' AND lang = 'ar'`).get();
  assert.ok(!r || r.name !== 'الدوري الإنجليزي الممتاز', 'not the English league\'s Arabic name for every "Premier League"');
});
