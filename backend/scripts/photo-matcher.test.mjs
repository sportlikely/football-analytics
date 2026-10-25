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

test('stale roster age: up to 5 years under the real age fits, more than 1.6 over does not', () => {
  assert.equal(ph.decide({ sport: 'basketball', name: 'Doncic Luka', age: 25, country: 'Slovenia' }, [b()], NOW).confidence, 'high', '"25" at 27');
  assert.equal(ph.decide({ sport: 'basketball', name: 'Doncic Luka', age: 23, country: 'Slovenia' }, [b()], NOW).confidence, 'high', '"23" at 27');
  assert.equal(ph.decide({ sport: 'basketball', name: 'Doncic Luka', age: 21, country: 'Slovenia' }, [b()], NOW).qid, null, '6+ years off');
  assert.equal(ph.decide({ sport: 'basketball', name: 'Doncic Luka', age: 30, country: 'Slovenia' }, [b()], NOW).qid, null, 'older than he is');
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
