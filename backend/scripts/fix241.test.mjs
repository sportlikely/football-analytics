// fix241: official player photos only (Yarin, 26 Oct 2026) on a scratch database (dist build): the allow-list (API-Football
// in; Wikimedia, our old /media/players/ files, any other host out), the Wikimedia matcher off even with PLAYER_PHOTOS=1,
// nothing from it shown / served / credited, the purge (files, rows, favourites), "Photo sources: official only" red →
// green, favourites and emails never keep a non-official player picture, football photos untouched, /credits → home.
// Run: npm run test:fix241
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix241-photos-'));
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'warn';
process.env.PLAYER_PHOTOS = '1'; // asked for, but Wikimedia is not an official source: stays off
const require = createRequire(import.meta.url);
const { db } = require('../dist/db/index.js');
const ph = require('../dist/services/playerPhotos.js');
const { officialPhoto, photoSourceOf } = require('../dist/utils/photoSources.js');
const { cleanFavorite } = require('../dist/services/favorites.js');
const { movedPage } = require('../dist/utils/slugRules.js');

const FB = 'https://media.api-sports.io/football/players/276.png';

test('allow-list: API-Football photos in, everything else out', () => {
  assert.equal(photoSourceOf(FB), 'api-football');
  assert.equal(officialPhoto(FB), FB);
  for (const bad of ['/media/players/tennis/501-0123456789.webp', 'https://sportlikely.com/media/players/basketball/9-abcdef0123.webp',
    'https://upload.wikimedia.org/wikipedia/commons/a/a1/X.jpg', 'http://media.api-sports.io/football/players/1.png',
    'https://media.api-sports.io.evil.example/x.png', 'https://cdn.nba.com/headshots/nba/latest/1040x760/2544.png', '', null, undefined])
    assert.equal(officialPhoto(bad), null, String(bad));
});

test('the Wikimedia matcher is off, nothing from it is shown, served or credited', async () => {
  assert.equal(ph.PHOTO_SOURCE, 'wikimedia');
  assert.equal(ph.photosOn(), false, 'PLAYER_PHOTOS=1 must not switch on a non-official source');
  // an approved fix211 photo with its file and credit, as on the live database
  fs.mkdirSync(path.join(ph.PHOTO_DIR, 'tennis'), { recursive: true });
  fs.writeFileSync(path.join(ph.PHOTO_DIR, 'tennis', '501-0123456789.webp'), 'x');
  db.prepare(`INSERT INTO player_photos (sport, player_id, name, status, wikidata, file, author, licence, licence_url, source_url, path, mime, checked_at)
    VALUES ('tennis', 501, 'Carlos Alcaraz', 'ok', 'Q1', 'Alcaraz.jpg', 'Jane Doe', 'CC BY-SA 4.0', null, 'https://commons.wikimedia.org/wiki/File:Alcaraz.jpg', '501-0123456789.webp', 'image/webp', ?),
    ('basketball', 9, 'Nikola Jokic', 'review', 'Q2', 'J.jpg', 'John Roe', 'CC BY 2.0', null, 'https://commons.wikimedia.org/wiki/File:J.jpg', '9-abcdef0123.webp', 'image/webp', ?)`).run(new Date().toISOString(), new Date().toISOString());
  assert.equal(ph.photoUrl('tennis', 501), null);
  assert.equal(ph.photoCredit('tennis', 501), null);
  assert.equal(ph.photoFile('tennis', '501-0123456789.webp'), null, 'the old file is not served');
  assert.deepEqual(ph.photoCredits(), []);
  await ph.photosTick(); // returns at once: no Wikimedia call (no fetcher set — a call would throw)
  await ph.photosBbPass();
});

test('"Photo sources: official only" is red while a non-official photo is stored, the purge makes it green', () => {
  db.exec(`CREATE TABLE IF NOT EXISTS user_favorites (user_id INTEGER NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (user_id, kind, ref))`);
  const fav = (kind, ref, img) => db.prepare(`INSERT INTO user_favorites VALUES (1, ?, ?, ?, ?)`).run(kind, ref, JSON.stringify({ kind, ref, name: ref, img }), new Date().toISOString());
  fav('bb-player', '9', 'https://sportlikely.com/media/players/basketball/9-abcdef0123.webp');
  fav('player', '276', FB);
  fav('bb-team', '1', 'https://media.api-sports.io/basketball/teams/1.png');
  const before = ph.photoSourceHealth();
  assert.equal(before.id, 'photo-sources');
  assert.equal(before.label, 'Photo sources: official only');
  assert.equal(before.level, 'fail');
  assert.ok(before.items.some(i => /stored photo rows/.test(i)) && before.items.some(i => /photo files/.test(i)) && before.items.some(i => /favourites/.test(i)), before.items.join(' | '));

  const r = ph.purgeUnofficialPhotos();
  assert.deepEqual(r, { rows: 2, files: 1, favorites: 1 });
  assert.equal(fs.existsSync(ph.PHOTO_DIR), false, 'the stored files are gone');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM player_photos`).get().n, 0, 'author / licence / source rows are gone');
  const favs = Object.fromEntries(db.prepare(`SELECT ref, data FROM user_favorites`).all().map(x => [x.ref, JSON.parse(x.data).img]));
  assert.equal(favs['9'], null, 'the basketball favourite lost its Wikimedia picture');
  assert.equal(favs['276'], FB, 'the football photo stays');
  assert.equal(favs['1'], 'https://media.api-sports.io/basketball/teams/1.png', 'team crests untouched');

  const after = ph.photoSourceHealth();
  assert.equal(after.level, 'warn', 'only the PLAYER_PHOTOS=1 note left'); // PLAYER_PHOTOS=1 asked for a non-official source
  process.env.PLAYER_PHOTOS = '';
  assert.equal(ph.photoSourceHealth().level, 'ok');
  assert.deepEqual(ph.purgeUnofficialPhotos(), { rows: 0, files: 0, favorites: 0 }, 'a no-op once clean');
});

test('favourites never keep a non-official player picture; football and team pictures stay', () => {
  assert.equal(cleanFavorite({ kind: 'tennis-player', ref: '5', name: 'X', img: 'https://upload.wikimedia.org/x.jpg' }).img, null);
  assert.equal(cleanFavorite({ kind: 'bb-player', ref: '5', name: 'X', img: 'https://sportlikely.com/media/players/basketball/5-0123456789.webp' }).img, null);
  assert.equal(cleanFavorite({ kind: 'player', ref: '276', name: 'X', img: FB }).img, FB);
  assert.equal(cleanFavorite({ kind: 'team', ref: '50', name: 'X', img: 'https://media.api-sports.io/football/teams/50.png' }).img, 'https://media.api-sports.io/football/teams/50.png');
});

test('emails: a /media/players/ picture is never used', () => {
  const { imgUrl } = require('../dist/services/pickEmails.js');
  assert.equal(imgUrl('https://sportlikely.com/media/players/basketball/9-abcdef0123.webp'), null);
  assert.equal(imgUrl('/media/players/tennis/501-0123456789.webp'), null);
});

test('/credits (photo credits) moves to the home page', () => {
  assert.equal(movedPage('/credits'), '/');
});
