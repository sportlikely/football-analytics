// fix211: player photos (Wikidata / Commons) on a scratch database (dist build) with a fake Wikimedia: the licence
// filter (only CC0 / public domain / CC BY / CC BY-SA), the matching rules (same name twice → no photo, birth date /
// country / team, contradictions), the whole path (search → item → Commons → 256 px WebP on disk → photoUrl / credit),
// low confidence kept for review, removal + block list, and the "Player photos" data-health check. Run: npm run test:fix211
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix211-photos-'));
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'warn';
process.env.PHOTO_GAP_MS = '200';
const require = createRequire(import.meta.url);
const { db } = require('../dist/db/index.js');
const ph = require('../dist/services/playerPhotos.js');
const sharp = require('sharp');

/* ---------- pure rules ---------- */

test('licence filter: free licences in, everything else out', () => {
  for (const ok of ['CC0', 'CC-zero', 'Public domain', 'PD-US', 'CC BY 2.0', 'CC BY-SA 4.0', 'CC BY-SA 3.0 de', 'CC BY 3.0 us', 'CC BY-SA 2.5,2.0,1.0', 'GFDL, CC BY-SA 3.0'])
    assert.equal(ph.licenceOk(ok), true, ok);
  for (const bad of ['CC BY-NC 2.0', 'CC BY-NC-SA 4.0', 'CC BY-ND 4.0', 'CC BY-NC-ND 3.0', 'GFDL', 'Fair use', 'Attribution', 'Copyrighted free use', 'All rights reserved', '', null])
    assert.equal(ph.licenceOk(bad), false, String(bad));
  assert.equal(ph.licenceOk('CC BY-SA 4.0', 'true'), false, 'NonFree flag wins');
});

const cand = (o = {}) => ({ qid: 'Q1', names: ['Carlos Alcaraz'], human: true, sports: ['Q847'], dob: '2003-05-05', countries: ['esp', 'es', 'spain'], teams: [], atp: null, wta: null, image: 'Alcaraz.jpg', ...o });

test('matching: same name twice gives no photo', () => {
  const d = ph.decide({ sport: 'tennis', name: 'Carlos Alcaraz', dob: null, country: 'ESP' }, [cand(), cand({ qid: 'Q2', dob: '1990-01-01' })]);
  assert.equal(d.qid, null);
  assert.match(d.reason, /same name: 2 candidates/);
  // a birth date that rules one out leaves the other
  const e = ph.decide({ sport: 'tennis', name: 'Carlos Alcaraz', dob: '2003-05-05', country: 'ESP' }, [cand(), cand({ qid: 'Q2', dob: '1990-01-01' })]);
  assert.equal(e.qid, 'Q1');
  assert.equal(e.confidence, 'high');
});

test('matching: tennis needs name + birth date / id (high) or country (low); name only = none', () => {
  assert.equal(ph.decide({ sport: 'tennis', name: 'Alcaraz Carlos', dob: '2003-05-05' }, [cand()]).confidence, 'high', 'order of names does not matter');
  const low = ph.decide({ sport: 'tennis', name: 'Carlos Alcaraz', country: 'ESP' }, [cand({ dob: null })]);
  assert.equal(low.confidence, 'low');
  const none = ph.decide({ sport: 'tennis', name: 'Carlos Alcaraz' }, [cand({ dob: null, countries: [] })]);
  assert.equal(none.confidence, null);
  assert.equal(ph.decide({ sport: 'tennis', name: 'Carlos Alcaraz', dob: '2001-01-01' }, [cand()]).qid, null, 'birth date contradicts');
  assert.equal(ph.decide({ sport: 'tennis', name: 'C. Alcaraz', dob: '2003-05-05' }, [cand()]).qid, null, 'abbreviated names are never matched');
  assert.equal(ph.decide({ sport: 'tennis', name: 'Carlos Alcaraz', dob: '2003-05-05' }, [cand({ sports: ['Q2736'] })]).qid, null, 'another sport');
  assert.equal(ph.decide({ sport: 'tennis', name: 'Carlos Alcaraz', dob: '2003-05-05' }, [cand({ human: false })]).qid, null, 'not a human');
});

test('matching: basketball by team (high), age + country (high), age only (low), age contradiction', () => {
  const b = (o = {}) => cand({ names: ['Luka Dončić'], sports: ['Q5372'], dob: '1999-02-28', countries: ['svn', 'si', 'slovenia'], teams: ['Real Madrid Baloncesto', 'Dallas Mavericks', 'Los Angeles Lakers'], ...o });
  const now = Date.parse('2026-10-24');
  assert.equal(ph.decide({ sport: 'basketball', name: 'Doncic Luka', teams: ['Los Angeles Lakers'] }, [b()], now).confidence, 'high');
  assert.equal(ph.decide({ sport: 'basketball', name: 'Luka Doncic', teams: ['Real Madrid'] }, [b()], now).confidence, 'high', 'Real Madrid ~ Real Madrid Baloncesto');
  assert.equal(ph.decide({ sport: 'basketball', name: 'Luka Doncic', age: 27, country: 'Slovenia' }, [b()], now).confidence, 'high');
  assert.equal(ph.decide({ sport: 'basketball', name: 'Luka Doncic', age: 27 }, [b()], now).confidence, 'low');
  assert.equal(ph.decide({ sport: 'basketball', name: 'Luka Doncic', age: 35, teams: ['Los Angeles Lakers'] }, [b()], now).qid, null, 'age far off');
  assert.equal(ph.sameTeam('Lakers', 'Los Angeles Lakers'), false, 'one word is not enough');
});

/* ---------- the whole path with a fake Wikimedia ---------- */

let portrait;
const commons = {}; // file → { licence, artist, nonFree }
const entities = {}; // qid → entity
const searches = {}; // name → [qid]
const ent = (qid, name, { dob = '+1997-06-01T00:00:00Z', sport = 'Q847', image = null, country = 'Q29' } = {}) => ({
  id: qid, labels: { en: { value: name } }, aliases: {},
  claims: {
    P31: [{ mainsnak: { datavalue: { value: { id: 'Q5' } } } }],
    P641: [{ mainsnak: { datavalue: { value: { id: sport } } } }],
    P569: dob ? [{ mainsnak: { datavalue: { value: { time: dob, precision: 11 } } } }] : [],
    P27: [{ mainsnak: { datavalue: { value: { id: country } } } }],
    ...(image ? { P18: [{ mainsnak: { datavalue: { value: image } } }] } : {})
  }
});
const res = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, arrayBuffer: async () => (Buffer.isBuffer(body) ? body.buffer.slice(body.byteOffset, body.byteOffset + body.length) : new ArrayBuffer(0)) });
const calls = [];
ph.__test.setFetcher(async (url) => {
  calls.push(url);
  const u = new URL(url);
  const q = u.searchParams;
  if (u.hostname === 'upload.wikimedia.org') return res(portrait);
  if (q.get('list') === 'search') {
    const name = q.get('srsearch').replace(/haswbstatement:\S+\s*/g, '').trim();
    return res({ query: { search: (searches[name] || []).map(title => ({ title })) } });
  }
  if (q.get('action') === 'wbgetentities') {
    const out = {};
    for (const id of q.get('ids').split('|')) out[id] = entities[id] || (id === 'Q29' ? { id, labels: { en: { value: 'Spain' } }, claims: { P297: [{ mainsnak: { datavalue: { value: 'ES' } } }], P298: [{ mainsnak: { datavalue: { value: 'ESP' } } }], P984: [{ mainsnak: { datavalue: { value: 'ESP' } } }] } } : { id });
    return res({ entities: out });
  }
  if (u.hostname === 'commons.wikimedia.org') {
    const file = q.get('titles').replace(/^File:/, '');
    const c = commons[file];
    if (!c) return res({ query: { pages: [{ missing: true }] } });
    return res({ query: { pages: [{ imageinfo: [{ width: 400, height: 600, mime: 'image/jpeg', url: `https://upload.wikimedia.org/x/${file}`, thumburl: `https://upload.wikimedia.org/thumb/${file}`, descriptionurl: `https://commons.wikimedia.org/wiki/File:${file}`,
      extmetadata: { LicenseShortName: { value: c.licence }, Artist: { value: c.artist }, LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0' }, NonFree: c.nonFree ? { value: 'true' } : undefined } }] }] } });
  }
  return res({}, 404);
});

test('a free photo: matched, cropped to a 256 px WebP square, served with its credit', async () => {
  portrait = await sharp({ create: { width: 400, height: 600, channels: 3, background: { r: 200, g: 120, b: 60 } } }).jpeg().toBuffer();
  searches['Ana Free'] = ['Q100'];
  entities.Q100 = ent('Q100', 'Ana Free', { image: 'Ana Free.jpg' });
  commons['Ana Free.jpg'] = { licence: 'CC BY-SA 4.0', artist: '<a href="//commons.wikimedia.org/wiki/User:Jo">Jo Photographer</a>' };
  const r = await ph.photoFor({ sport: 'tennis', id: 501, name: 'Ana Free', dob: '1997-06-01', country: 'ESP' });
  assert.equal(r.status, 'ok', r.reason);
  const url = ph.photoUrl('tennis', 501);
  assert.match(url, /^\/media\/players\/tennis\/501-[0-9a-f]{10}\.webp$/);
  const file = ph.photoFile('tennis', path.basename(url));
  assert.ok(file && fs.existsSync(file));
  const meta = await sharp(fs.readFileSync(file)).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ['webp', 256, 256]);
  assert.deepEqual(ph.photoCredit('tennis', 501), { author: 'Jo Photographer', licence: 'CC BY-SA 4.0', licenceUrl: 'https://creativecommons.org/licenses/by-sa/4.0', source: 'https://commons.wikimedia.org/wiki/File:Ana Free.jpg' });
  assert.equal(ph.photoCredits().length, 1);
  assert.ok(calls.every(u => /wikimedia\.org|wikidata\.org/.test(u)), 'only Wikimedia hosts are called');
});

test('a non-free Commons file gives no photo and nothing on disk', async () => {
  searches['Bea Closed'] = ['Q200'];
  entities.Q200 = ent('Q200', 'Bea Closed', { image: 'Bea.jpg' });
  commons['Bea.jpg'] = { licence: 'CC BY-NC-SA 2.0', artist: 'Someone' };
  const r = await ph.photoFor({ sport: 'tennis', id: 502, name: 'Bea Closed', dob: '1997-06-01' });
  assert.equal(r.status, 'none');
  assert.match(r.reason, /licence not allowed/);
  assert.equal(ph.photoUrl('tennis', 502), null);
  assert.equal(fs.readdirSync(path.join(process.env.DATA_DIR, 'player-photos', 'tennis')).filter(f => f.startsWith('502-')).length, 0);
  // no author on the file: no photo either
  searches['Cy Anon'] = ['Q201'];
  entities.Q201 = ent('Q201', 'Cy Anon', { image: 'Cy.jpg' });
  commons['Cy.jpg'] = { licence: 'Public domain', artist: '' };
  assert.equal((await ph.photoFor({ sport: 'tennis', id: 503, name: 'Cy Anon', dob: '1997-06-01' })).status, 'none');
});

test('two tennis players with the same name: no photo', async () => {
  searches['Dan Twin'] = ['Q300', 'Q301'];
  entities.Q300 = ent('Q300', 'Dan Twin', { dob: null, image: 'Dan1.jpg' });
  entities.Q301 = ent('Q301', 'Dan Twin', { dob: null, image: 'Dan2.jpg' });
  commons['Dan1.jpg'] = commons['Dan2.jpg'] = { licence: 'CC0', artist: 'X' };
  const r = await ph.photoFor({ sport: 'tennis', id: 504, name: 'Dan Twin', dob: '1997-06-01', country: 'ESP' });
  assert.equal(r.status, 'none');
  assert.match(r.reason, /same name/);
  assert.equal(ph.photoUrl('tennis', 504), null);
});

test('low confidence waits for review; approve shows it', async () => {
  searches['Eva Maybe'] = ['Q400'];
  entities.Q400 = ent('Q400', 'Eva Maybe', { dob: null, image: 'Eva.jpg' });
  commons['Eva.jpg'] = { licence: 'CC BY 2.0', artist: 'Y' };
  const r = await ph.photoFor({ sport: 'tennis', id: 505, name: 'Eva Maybe', dob: null, country: 'ESP' });
  assert.equal(r.status, 'review');
  assert.equal(ph.photoUrl('tennis', 505), null, 'not shown before approval');
  assert.equal(ph.photosAdmin().review.length, 1);
  assert.equal(ph.approvePhoto('tennis', 505), true);
  assert.match(ph.photoUrl('tennis', 505), /505-/);
});

test('remove: file deleted, player and file blocked, never fetched again', async () => {
  const before = ph.photoFile('tennis', path.basename(ph.photoUrl('tennis', 501)));
  assert.equal(ph.removePhoto('tennis', 501, 'takedown request'), true);
  assert.equal(ph.photoUrl('tennis', 501), null);
  assert.equal(fs.existsSync(before), false);
  const n = calls.length;
  assert.equal((await ph.photoFor({ sport: 'tennis', id: 501, name: 'Ana Free', dob: '1997-06-01' })).status, 'blocked');
  assert.equal(calls.length, n, 'no Wikimedia call for a blocked player');
  // another player pointing at the same Commons file: the file stays blocked
  searches['Ana Free'] = ['Q100'];
  const r = await ph.photoFor({ sport: 'tennis', id: 599, name: 'Ana Free', dob: '1997-06-01' });
  assert.equal(r.status, 'none');
  assert.equal(ph.photoUrl('tennis', 599), null);
});

test('data health: ok normally, fail when a shown photo has no author / licence', () => {
  const h = ph.photoHealth();
  assert.equal(h.id, 'player-photos');
  assert.notEqual(h.level, 'fail');
  db.prepare(`INSERT INTO player_photos (sport, player_id, name, status, path, checked_at) VALUES ('basketball', 9, 'No Credit', 'ok', '9-0123456789.webp', ?)`).run(new Date().toISOString());
  const bad = ph.photoHealth();
  assert.equal(bad.level, 'fail');
  assert.ok(bad.items.some(i => /No Credit: shown without author/.test(i)));
  assert.equal(ph.photoUrl('basketball', 9), null, 'never shown without a credit');
});
