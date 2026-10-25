// fix214: the basketball photo matcher against a recorded Wikidata answer (scripts/fixtures/wikidata-nba-20.json,
// recorded live on 25 Oct 2026 with scripts/photo-diag.mjs). 20 known NBA players as API-Basketball stores them
// ("Last First", roster ages ~3 years behind): at least 17 must match with high confidence — fix212b matched 0 of
// 740 NBA players because the stale age threw the right item out. Run: npm run test:fix214
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix214-photos-'));
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'warn';
process.env.PHOTO_GAP_MS = '200';
const require = createRequire(import.meta.url);
const ph = require('../dist/services/playerPhotos.js');
const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/wikidata-nba-20.json', import.meta.url), 'utf8'));
const NOW = Date.parse('2026-10-25T00:00:00Z');

test('recorded Wikidata: 20 known NBA players, ≥ 17 matched high (the right item)', async () => {
  const missing = [];
  ph.__test.setFetcher(async url => {
    const j = fx.responses[url];
    if (!j) missing.push(url);
    return { ok: !!j, status: j ? 200 : 404, json: async () => j, arrayBuffer: async () => new ArrayBuffer(0) };
  });
  const want = { 'James LeBron': 'Q36159', 'Curry Stephen': 'Q352159', 'Jokic Nikola': 'Q17281073', 'Doncic Luka': 'Q19844712', 'Antetokounmpo Giannis': 'Q8991894', 'Wembanyama Victor': 'Q72941595' };
  let high = 0;
  const log = [];
  for (const p of fx.players) {
    const d = ph.decide({ sport: 'basketball', ...p }, await ph.__test.candidatesFor('basketball', p.name), NOW);
    log.push(`${d.confidence || '-'} ${p.name} ${d.qid || ''} ${d.reason}`);
    if (d.confidence === 'high') high++;
    if (want[p.name]) assert.equal(d.qid, want[p.name], `${p.name}: ${d.reason}`);
  }
  assert.deepEqual(missing, [], 'every call the matcher makes is in the recording (re-record with photo-diag.mjs if the query changed)');
  assert.ok(high >= 17, `high ${high} of 20:\n${log.join('\n')}`);
});

const b = (o = {}) => ({ qid: 'Q19844712', names: ['Luka Dončić'], human: true, sports: ['Q5372'], dob: '1999-02-28', countries: ['slovenia', 'si', 'svn', 'slo'], teams: ['Los Angeles Lakers', 'Dallas Mavericks', 'Real Madrid Baloncesto'], atp: null, wta: null, image: 'Luka.jpg', ...o });

// fix221: an age that does not fit no longer drops the item (only a birth date does, ±1 day); it just is not evidence
test('stale roster age: up to 5 years under the real age fits; an age that does not fit is no evidence, never a veto', () => {
  assert.equal(ph.decide({ sport: 'basketball', name: 'Doncic Luka', age: 25, country: 'Slovenia' }, [b()], NOW).confidence, 'high', '"25" at 27');
  assert.equal(ph.decide({ sport: 'basketball', name: 'Doncic Luka', age: 23, country: 'Slovenia' }, [b()], NOW).confidence, 'high', '"23" at 27');
  assert.equal(ph.decide({ sport: 'basketball', name: 'Doncic Luka', age: 21, country: 'Slovenia' }, [b()], NOW).confidence, 'low', '6+ years off: country only → review');
  assert.equal(ph.decide({ sport: 'basketball', name: 'Doncic Luka', age: 30, country: 'Slovenia' }, [b()], NOW).confidence, 'low', 'older than he is: country only → review');
  assert.equal(ph.decide({ sport: 'basketball', name: 'Doncic Luka', age: 30, teams: ['Los Angeles Lakers'] }, [b()], NOW).confidence, 'high', 'his team agrees');
});

test('same name: the one who played for our team is him; a namesake elsewhere or two on our team → none', () => {
  const stub = b({ qid: 'Q2', dob: null, teams: ['Oklahoma Sooners'], image: null });
  const d = ph.decide({ sport: 'basketball', name: 'Doncic Luka', teams: ['Los Angeles Lakers'] }, [b(), stub], NOW);
  assert.equal(d.qid, 'Q19844712');
  assert.equal(d.confidence, 'high');
  assert.equal(ph.decide({ sport: 'basketball', name: 'Doncic Luka', teams: ['Boston Celtics'] }, [b(), stub], NOW).qid, null);
  assert.equal(ph.decide({ sport: 'basketball', name: 'Doncic Luka', teams: ['Los Angeles Lakers'] }, [b(), b({ qid: 'Q3' })], NOW).qid, null);
});

test('names: HTML-escaped and suffixes in the middle', () => {
  assert.equal(ph.nameKey('Melton De&apos;Anthony'), ph.nameKey("De'Anthony Melton"));
  assert.equal(ph.searchName('Pippen Jr Scotty'), 'Pippen Scotty');
  assert.equal(ph.searchName('Jaquez Jr. Jaime'), 'Jaquez Jaime');
  assert.equal(ph.searchName('Melton De&apos;Anthony'), "Melton De'Anthony");
});

// fix221: birth dates (±1 day), the league and college signals, and the coverage on 200 real players
test('birth date: the same within a day (Wikidata midnight UTC vs our local date), else the item is dropped', () => {
  assert.equal(ph.dobFits('1999-02-28', '1999-02-28'), true);
  assert.equal(ph.dobFits('1999-02-27', '1999-02-28'), true);
  assert.equal(ph.dobFits('1999-02-26', '1999-02-28'), false);
  assert.equal(ph.dobFits('1999-06-01', '1999'), true, 'year precision');
  assert.equal(ph.decide({ sport: 'basketball', name: 'Doncic Luka', dob: '1999-02-27', teams: [] }, [b()], NOW).confidence, 'high');
  assert.equal(ph.decide({ sport: 'basketball', name: 'Doncic Luka', dob: '1990-02-28', teams: ['Los Angeles Lakers'] }, [b()], NOW).qid, null, 'another birth date: another person');
});

test('league and college: a rookie whose item lists only his college; namesakes split by college / league / age', () => {
  const rookie = b({ qid: 'Q9', names: ['Bub Carrington'], teams: ['Pittsburgh Panthers men\'s basketball'], schools: ['University of Pittsburgh'], leagues: ['NCAA Division I'], countries: ['usa', 'united states'], dob: '2005-07-21' });
  assert.equal(ph.decide({ sport: 'basketball', name: 'Bub Carrington', country: 'USA', teams: ['Washington Wizards'], leagues: ['NBA'] }, [rookie], NOW).confidence, 'low', 'country only');
  assert.equal(ph.decide({ sport: 'basketball', name: 'Bub Carrington', country: 'USA', teams: ['Washington Wizards'], leagues: ['NBA'], college: 'Pittsburgh' }, [rookie], NOW).confidence, 'high');
  const vet = b({ qid: 'Q8', names: ['Deandre Ayton'], teams: ['Phoenix Suns', 'Portland Trail Blazers'], leagues: ['National Basketball Association'], countries: ['bahamas'] });
  assert.equal(ph.decide({ sport: 'basketball', name: 'Ayton Deandre', teams: ['Washington Wizards'], leagues: ['NBA'] }, [vet], NOW).confidence, 'high', 'a team of his league');
  assert.equal(ph.decide({ sport: 'basketball', name: 'Ayton Deandre', teams: ['Real Madrid'], leagues: ['EL'] }, [vet], NOW).confidence, null, 'not our league: name only');
  // father and son, both NBA: the age picks the son
  const sr = b({ qid: 'Q1', names: ['Jabari Smith'], leagues: ['National Basketball Association'], teams: ['Sacramento Kings'], dob: '1977-11-30', schools: ['University of California, Berkeley'] });
  const jr = b({ qid: 'Q2', names: ['Jabari Smith Jr.'], leagues: ['National Basketball Association'], teams: ['Auburn Tigers men\'s basketball'], dob: '2003-05-13', schools: ['Auburn University'] });
  assert.equal(ph.decide({ sport: 'basketball', name: 'Smith Jr. Jabari', age: 20, teams: ['Houston Rockets'], leagues: ['NBA'] }, [sr, jr], NOW).qid, 'Q2');
  assert.equal(ph.decide({ sport: 'basketball', name: 'Smith Jr. Jabari', teams: ['Houston Rockets'], leagues: ['NBA'], college: 'Auburn' }, [sr, jr], NOW).qid, 'Q2');
  assert.equal(ph.collegeFits('Texas A&M', 'Texas A&M Aggies men\'s basketball'), true);
  assert.equal(ph.collegeFits('Ohio State', 'Ohio University'), false);
});

test('recorded coverage: 100 NBA + 100 EuroLeague players of the 10 Oct copy — NBA ≥ 85 %, EuroLeague ≥ 60 % matched high', async () => {
  require('../dist/db/index.js').db.exec('DELETE FROM photo_wd_cache'); // the recording was made with an empty cache
  const cov = JSON.parse(fs.readFileSync(new URL('./fixtures/wikidata-bb-coverage.json', import.meta.url), 'utf8'));
  let missing = 0;
  ph.__test.setFetcher(async url => {
    const j = cov.responses[url];
    if (!j) missing++;
    return { ok: !!j, status: j ? 200 : 404, json: async () => structuredClone(j), arrayBuffer: async () => new ArrayBuffer(0) };
  });
  const pct = {};
  for (const [lg, list] of Object.entries(cov.players)) {
    let high = 0;
    for (const p of list) {
      const c = await ph.__test.candidatesFor('basketball', p.name).catch(() => []);
      if (ph.decide({ sport: 'basketball', ...p }, c, cov.now).confidence === 'high') high++;
    }
    pct[lg] = (100 * high) / list.length;
  }
  console.log(`recorded coverage: NBA ${pct.NBA}% · EuroLeague ${pct.EL}% high (missing answers ${missing})`);
  assert.ok(missing <= 5, `${missing} calls not in the recording`);
  assert.ok(pct.NBA >= 85, `NBA ${pct.NBA}%`);
  assert.ok(pct.EL >= 60, `EuroLeague ${pct.EL}%`);
});
