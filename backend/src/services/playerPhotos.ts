/**
 * fix211: player photos — tennis players and basketball players without one, from Wikidata + Wikimedia Commons only
 * (free licences that allow commercial use, always credited). No other source, never hotlinked.
 *
 * Matching (worker job "player photos", every 20 min, a small batch each time: new players first, everyone else again
 * after 7 days; one Wikimedia call at a time, PHOTO_GAP_MS apart, User-Agent with support@sportlikely.com):
 * - a Wikidata search for humans of the sport (P31 Q5, P641 Q847 tennis / Q5372 basketball) by the player's name;
 *   a candidate's label or alias must be the same name (accents, order and punctuation aside);
 * - a candidate whose birth date (or, basketball, age) contradicts ours is dropped; two candidates left with the same
 *   name → no photo ("same name");
 * - the one left needs at least one more thing that agrees: tennis birth date / ATP id (P536) / WTA id (P597) = high,
 *   country only = low; basketball a team he played for = high, age + country = high, age or country only = low;
 *   name only → no photo. Low = kept for review (Admin → Player photos), not shown until approved.
 * Image: the item's P18 → Commons imageinfo; only CC0, public domain, CC BY, CC BY-SA (any version), with the author
 * named; anything else → no photo. One thumbnail is downloaded, cropped to a centre-top square (the face), 256 px WebP
 * in DATA_DIR/player-photos/<sport>/, served from our domain (/media/players/…, a year's cache, the file name changes
 * with the photo). Author, licence and the Commons file are kept per photo (credit under the photo, /credits page).
 * Removal: Admin "remove photo" deletes the file and blocks the player and that file for good (never fetched again).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, DB_READ_ONLY } from '../db';
import logger from '../utils/logger';
import { yieldLoop, yieldEvery } from './perf';
import { threadJobsOn, inThread } from './threadJob';

export type PhotoSport = 'tennis' | 'basketball';
export const PHOTO_SPORTS: PhotoSport[] = ['tennis', 'basketball'];
const SPORT_Q: Record<PhotoSport, string> = { tennis: 'Q847', basketball: 'Q5372' };
/** fix212b: the occupation items (P106) that mean the same sport — most basketball items carry "basketball player"
 *  (Q3665646) and no P641 "sport", so the P641-only search and filter found 1 of 5,061 */
const OCCUPATION_Q: Record<PhotoSport, string> = { tennis: 'Q10833314', basketball: 'Q3665646' };
const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
export const PHOTO_DIR = path.join(DATA_DIR, 'player-photos');
const UA = 'SportLikelyBot/1.0 (https://sportlikely.com; support@sportlikely.com) player photos';
const DAY = 86400000;
const RECHECK_MS = 7 * DAY;
const SIZE = 256;

if (!DB_READ_ONLY) db.exec(`
  CREATE TABLE IF NOT EXISTS player_photos (
    sport TEXT NOT NULL, player_id INTEGER NOT NULL, name TEXT,
    status TEXT NOT NULL, -- ok | review | none | rejected | blocked
    wikidata TEXT, reason TEXT, confidence TEXT,
    file TEXT, author TEXT, licence TEXT, licence_url TEXT, source_url TEXT,
    path TEXT, mime TEXT, checked_at TEXT NOT NULL, approved_at TEXT,
    PRIMARY KEY (sport, player_id)
  );
  CREATE INDEX IF NOT EXISTS idx_player_photos_status ON player_photos(status);
  CREATE TABLE IF NOT EXISTS player_photo_blocks (key TEXT PRIMARY KEY, reason TEXT, at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS photo_wd_cache (qid TEXT PRIMARY KEY, data TEXT NOT NULL, at TEXT NOT NULL);
`);

/* ---------------- pure rules (scripts/player-photos.test.mjs) ---------------- */

/** a name as a set of words: accents, case, punctuation and order aside ("Alcaraz, Carlos" = "carlos alcaraz") */
export function nameKey(raw: string | null | undefined): string {
  // fix212b: "Jr.", "Sr.", "II", "III", "IV" are not part of the name (rosters write "Gary Trent Jr.", Wikidata "Gary Trent Jr." or not)
  return unescapeName(raw).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ø/gi, 'o').replace(/ł/gi, 'l').replace(/ß/g, 'ss')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(w => w && !SUFFIX.has(w)).sort().join(' ');
}
/** fix214: API-Basketball sends some names HTML-escaped ("De&apos;Anthony Melton") */
export const unescapeName = (raw: string | null | undefined) => String(raw || '').replace(/&apos;|&#0?39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const SUFFIX = new Set(['jr', 'sr', 'ii', 'iii', 'iv']);
/** fix212b: "Tatum, Jayson" (some rosters) → "Jayson Tatum"; a name as the search box wants it */
export const searchName = (raw: string) => { const m = /^([^,]+),\s*(.+)$/.exec(unescapeName(raw).trim()); return (m ? `${m[2]} ${m[1]}` : unescapeName(raw)).replace(/(^|\s)(jr|sr|ii|iii|iv)\.?(?=\s|$)/gi, ' ').replace(/\s+/g, ' ').trim(); };
/** "C. Alcaraz", "Alcaraz C." — an initial instead of a first name: never matched */
export const abbreviated = (raw: string | null | undefined) => !raw || String(raw).trim().split(/\s+/).length < 2 || /(^|\s)\p{L}\.?(\s|$)/u.test(String(raw).trim());

/**
 * Commons licence short names that allow commercial use with credit: CC0, public domain, CC BY, CC BY-SA (any version
 * or port). Non-commercial / no-derivatives / fair use / GFDL-only / anything unknown → false.
 */
export function licenceOk(short: string | null | undefined, nonFree?: string | boolean | null): boolean {
  if (nonFree === true || String(nonFree || '').toLowerCase() === 'true') return false;
  const s = String(short || '').toLowerCase().trim();
  if (!s) return false;
  if (/\bnc\b|\bnd\b|non-?commercial|no-?deriv|fair use|all rights reserved|copyrighted/.test(s)) return false;
  return s.split(/\s*(?:,|;|\bor\b)\s*/).some(part =>
    /^(cc0|cc-zero|cc zero)(\b|$)/.test(part) || /^(public domain|pd)(\b|-|$)/.test(part) || /^cc[- ]by(-sa)?(\s|-)?\d(\.\d)?(\b|$)/.test(part) || /^cc[- ]by(-sa)?$/.test(part));
}

/** a Commons "Artist" field (HTML) → plain text */
export function plainAuthor(html: string | null | undefined): string {
  return String(html || '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim().slice(0, 160);
}

export interface Ours { sport: PhotoSport; name: string; dob?: string | null; age?: number | null; country?: string | null; teams?: string[]; atpId?: string | null; wtaId?: string | null }
export interface Candidate {
  qid: string; names: string[]; human: boolean; sports: string[]
  /** YYYY-MM-DD (day precision) or YYYY (year precision) */
  dob: string | null
  /** every code and name of each citizenship (IOC, ISO 2 / 3, English name), lower case */
  countries: string[]
  /** labels of the teams he played for (P54) */
  teams: string[]
  atp: string | null; wta: string | null; image: string | null
}
export interface Decision { qid: string | null; confidence: 'high' | 'low' | null; reason: string; image: string | null }

const GENERIC = new Set(['bc', 'bk', 'kk', 'cb', 'basket', 'basketball', 'baloncesto', 'pallacanestro', 'club', 'sc', 'fc', 'the', 'de', 'team', 'cf', 'sk', 'ks', 'bc.', 'b.c.']);
const teamWords = (s: string) => nameKey(s).split(' ').filter(w => w && !GENERIC.has(w));
/** "Real Madrid" ~ "Real Madrid Baloncesto", "Los Angeles Lakers" ~ "Lakers"? no: every word of the shorter one in the longer */
export function sameTeam(a: string, b: string): boolean {
  const x = teamWords(a), y = teamWords(b);
  if (!x.length || !y.length) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.every(w => long.includes(w)) && (short.length >= 2 || long.length === 1);
}
const ageAt = (dob: string, now: number) => {
  const d = Date.parse(dob.length === 4 ? `${dob}-07-01` : dob);
  return Number.isFinite(d) ? (now - d) / (365.2425 * DAY) : null;
};
/**
 * fix214: API-Basketball's roster age is the age when the player was first stored, 2–4 years behind (Dončić "25" at
 * 27, Reaves "25" at 28): the old ±1.6 window dropped the right item for nearly every player (basketball 1 of 4,899).
 * The real age may be up to AGE_STALE years above ours, never more than 1.6 below.
 */
export const AGE_STALE = 5;
export const ageFits = (real: number, ours: number) => real - ours >= -1.6 && real - ours <= AGE_STALE;

/** pick one Wikidata item for our player — or none, with the reason */
export function decide(ours: Ours, cands: Candidate[], now = Date.now()): Decision {
  const key = nameKey(ours.name);
  if (abbreviated(ours.name) || !key.includes(' ')) return { qid: null, confidence: null, reason: 'name too short or abbreviated', image: null };
  const named = cands.filter(c => c.human && c.sports.includes(SPORT_Q[ours.sport]) && c.names.some(n => nameKey(n) === key));
  // contradictions drop a candidate (a different person with the same name)
  const dobOurs = ours.dob ? String(ours.dob).slice(0, 10) : null;
  const alive = named.filter(c => {
    if (dobOurs && c.dob && (c.dob.length === 4 ? c.dob !== dobOurs.slice(0, 4) : c.dob !== dobOurs)) return false;
    if (ours.age != null && c.dob) { const a = ageAt(c.dob, now); if (a != null && !ageFits(a, ours.age)) return false; }
    return true;
  });
  if (!alive.length) return { qid: null, confidence: null, reason: named.length ? `${named.length} same-name item(s), birth date / age disagrees` : 'no Wikidata match', image: null };
  // fix214: several same-name items (a stub without a birth date, a namesake in another league): the one who played for
  // one of our teams is him; none or two of them → no photo
  const onTeam = alive.length > 1 ? alive.filter(c => (ours.teams || []).some(t => c.teams.some(x => sameTeam(t, x)))) : [];
  if (alive.length > 1 && onTeam.length !== 1) return { qid: null, confidence: null, reason: `same name: ${alive.length} candidates (${alive.map(c => c.qid).join(', ')})`, image: null };
  const c = onTeam.length === 1 ? onTeam[0] : alive[0];
  const country = ours.country ? String(ours.country).trim().toLowerCase() : null;
  const sig = {
    dob: !!(dobOurs && c.dob && c.dob.length === 10 && c.dob === dobOurs),
    atp: !!(ours.atpId && c.atp && ours.atpId.toLowerCase() === c.atp.toLowerCase()),
    wta: !!(ours.wtaId && c.wta && ours.wtaId === c.wta),
    country: !!(country && c.countries.includes(country)),
    team: (ours.teams || []).some(t => c.teams.some(x => sameTeam(t, x))),
    age: ours.age != null && !!c.dob
  };
  const said = [sig.dob && `birth date ${dobOurs}`, sig.atp && 'ATP id', sig.wta && 'WTA id', sig.team && 'team', sig.age && 'age', sig.country && `country ${country!.toUpperCase()}`].filter(Boolean).join(' + ');
  let confidence: Decision['confidence'] = null;
  if (ours.sport === 'tennis') confidence = sig.dob || sig.atp || sig.wta ? 'high' : sig.country ? 'low' : null;
  else confidence = sig.team || sig.dob || (sig.age && sig.country) ? 'high' : sig.age || sig.country ? 'low' : null;
  if (!confidence) return { qid: c.qid, confidence: null, reason: 'name only (nothing else agrees)', image: null };
  return { qid: c.qid, confidence, reason: `name + ${said}`, image: c.image };
}

/* ---------------- Wikimedia calls ---------------- */

type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<any>; arrayBuffer(): Promise<ArrayBuffer> }>;
let fetcher: Fetcher = (url: string) => fetch(url, { headers: { 'User-Agent': UA, 'Api-User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) }) as any;
const GAP_MS = () => Math.max(200, Number(process.env.PHOTO_GAP_MS) || 1000);
let lastCall = 0, calls = 0;
async function get(url: string): Promise<any> {
  const wait = lastCall + GAP_MS() - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCall = Date.now(); calls++;
  const r = await fetcher(url);
  if (r.status === 429) throw new Error('Wikimedia 429 (too many requests)');
  if (!r.ok) throw new Error(`Wikimedia HTTP ${r.status}`);
  return r;
}
const WD = 'https://www.wikidata.org/w/api.php?format=json&formatversion=2&';
const COMMONS = 'https://commons.wikimedia.org/w/api.php?format=json&formatversion=2&';

const claimIds = (e: any, p: string): string[] => (e?.claims?.[p] || []).map((c: any) => c?.mainsnak?.datavalue?.value?.id).filter(Boolean);
const claimStr = (e: any, p: string): string | null => (e?.claims?.[p] || []).map((c: any) => c?.mainsnak?.datavalue?.value).find((v: any) => typeof v === 'string') || null;
function claimDate(e: any): string | null {
  const v = (e?.claims?.P569 || []).map((c: any) => c?.mainsnak?.datavalue?.value).find((x: any) => x?.time);
  if (!v) return null;
  const m = /^[+-](\d{4})-(\d{2})-(\d{2})/.exec(v.time);
  if (!m) return null;
  return v.precision >= 11 ? `${m[1]}-${m[2]}-${m[3]}` : v.precision >= 9 ? m[1] : null;
}
const namesOf = (e: any): string[] => [
  ...Object.values(e?.labels || {}).map((l: any) => l?.value),
  ...Object.values(e?.aliases || {}).flat().map((l: any) => l?.value)
].filter(Boolean);

/** labels (+ country codes) of a few items, cached in photo_wd_cache for 30 days */
async function refInfo(ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>(), miss: string[] = [];
  const fresh = new Date(Date.now() - 30 * DAY).toISOString();
  for (const id of [...new Set(ids)]) {
    const row = db.prepare(`SELECT data FROM photo_wd_cache WHERE qid = ? AND at >= ?`).get(id, fresh) as any;
    if (row) out.set(id, JSON.parse(row.data)); else miss.push(id);
  }
  for (let i = 0; i < miss.length; i += 40) {
    const part = miss.slice(i, i + 40);
    const j = await (await get(`${WD}action=wbgetentities&props=labels|claims&languages=en&ids=${part.join('|')}`)).json();
    for (const id of part) {
      const e = j?.entities?.[id];
      // a country: English name, ISO 3166 alpha-2 / alpha-3, IOC code; a team: its English name
      const vals = [e?.labels?.en?.value, claimStr(e, 'P297'), claimStr(e, 'P298'), claimStr(e, 'P984')].filter(Boolean).map((x: string) => x.toLowerCase());
      out.set(id, vals);
      db.prepare(`INSERT OR REPLACE INTO photo_wd_cache (qid, data, at) VALUES (?, ?, ?)`).run(id, JSON.stringify(vals), new Date().toISOString());
    }
  }
  return out;
}

/** Wikidata items of the sport with this name (search, then each item's facts) */
async function candidatesFor(sport: PhotoSport, name: string): Promise<Candidate[]> {
  // fix212b: an item of the sport = P641 "sport" OR P106 "<sport> player" (a basketball item usually has only the latter)
  const q = `haswbstatement:P31=Q5 haswbstatement:P641=${SPORT_Q[sport]}|P106=${OCCUPATION_Q[sport]} ${searchName(name).replace(/["\\]/g, ' ')}`;
  const s = await (await get(`${WD}action=query&list=search&srnamespace=0&srlimit=10&srsearch=${encodeURIComponent(q)}`)).json();
  const ids: string[] = (s?.query?.search || []).map((x: any) => x.title).filter((x: string) => /^Q\d+$/.test(x));
  if (!ids.length) return [];
  const j = await (await get(`${WD}action=wbgetentities&props=labels|aliases|claims&languages=en|mul|es|fr|de|it|pt|hr|sr|cs|pl|ru&ids=${ids.join('|')}`)).json();
  const ents = ids.map(id => j?.entities?.[id]).filter(Boolean);
  // only items whose name matches go on to the team / country look-ups
  const key = nameKey(name);
  const named = ents.filter(e => namesOf(e).some(n => nameKey(n) === key));
  const refs = await refInfo(named.flatMap(e => [...claimIds(e, 'P27'), ...(sport === 'basketball' ? claimIds(e, 'P54') : [])]));
  return ents.map(e => ({
    qid: e.id, names: namesOf(e), human: claimIds(e, 'P31').includes('Q5'),
    sports: [...claimIds(e, 'P641'), ...(claimIds(e, 'P106').includes(OCCUPATION_Q[sport]) ? [SPORT_Q[sport]] : [])], dob: claimDate(e),
    countries: claimIds(e, 'P27').flatMap(id => refs.get(id) || []),
    teams: claimIds(e, 'P54').map(id => (refs.get(id) || [])[0]).filter(Boolean),
    atp: claimStr(e, 'P536'), wta: claimStr(e, 'P597'), image: claimStr(e, 'P18')
  }));
}

export interface PhotoInfo { file: string; author: string; licence: string; licenceUrl: string | null; sourceUrl: string; thumb: string; mime: string }
/** a Commons file's licence and author; null + reason when it may not be used */
async function commonsInfo(file: string): Promise<{ info: PhotoInfo | null; reason: string }> {
  const title = `File:${file}`;
  const head = await (await get(`${COMMONS}action=query&prop=imageinfo&iiprop=size|mime|extmetadata|url&iiextmetadatafilter=Artist|LicenseShortName|LicenseUrl|NonFree&titles=${encodeURIComponent(title)}`)).json();
  const ii = head?.query?.pages?.[0]?.imageinfo?.[0];
  if (!ii) return { info: null, reason: 'Commons file not found' };
  const meta = ii.extmetadata || {};
  const licence = String(meta.LicenseShortName?.value || '').trim();
  if (!licenceOk(licence, meta.NonFree?.value)) return { info: null, reason: `licence not allowed: ${licence || 'none'}` };
  const author = plainAuthor(meta.Artist?.value);
  if (!author) return { info: null, reason: 'no author on the Commons file' };
  if (!/^image\/(jpeg|png|webp|tiff)$/.test(ii.mime || '')) return { info: null, reason: `not a photo (${ii.mime})` };
  const w = Number(ii.width) || 0, h = Number(ii.height) || 0;
  if (Math.min(w, h) < 128) return { info: null, reason: 'image too small' };
  // the smallest standard thumbnail width whose short side is still >= 256 px
  const need = w > h ? Math.ceil((SIZE * w) / h) : SIZE;
  const width = [330, 500, 960, 1280].find(x => x >= need) || 1280;
  const t = await (await get(`${COMMONS}action=query&prop=imageinfo&iiprop=url&iiurlwidth=${Math.min(width, w)}&titles=${encodeURIComponent(title)}`)).json();
  const thumb = t?.query?.pages?.[0]?.imageinfo?.[0]?.thumburl || ii.url;
  return {
    info: { file, author, licence, licenceUrl: String(meta.LicenseUrl?.value || '') || null, sourceUrl: ii.descriptionurl || `https://commons.wikimedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`, thumb, mime: ii.mime },
    reason: 'ok'
  };
}

let sharpMod: any | undefined;
function sharpLib(): any | null {
  if (sharpMod !== undefined) return sharpMod;
  try { sharpMod = require('sharp'); } catch (e: any) { sharpMod = null; logger.warn(`player photos: sharp not available (${e?.message || e}) — thumbnails kept as Commons made them`); }
  return sharpMod;
}
/** centre-top square, 256 px, WebP (the face is usually in the upper part of a portrait) */
export async function faceSquare(buf: Buffer): Promise<{ data: Buffer; mime: string; ext: string } | null> {
  const sharp = sharpLib();
  if (!sharp) return null;
  const upright: Buffer = await sharp(buf).rotate().toBuffer();
  const m = await sharp(upright).metadata();
  const w = m.width || 0, h = m.height || 0;
  if (!w || !h) return null;
  const side = Math.min(w, h);
  const left = Math.round((w - side) / 2), top = h > w ? Math.round((h - side) * 0.08) : 0;
  const data: Buffer = await sharp(upright).extract({ left, top, width: side, height: side }).resize(SIZE, SIZE).webp({ quality: 80 }).toBuffer();
  return { data, mime: 'image/webp', ext: 'webp' };
}

/* ---------------- store ---------------- */

const blocked = (k: string) => !!db.prepare(`SELECT 1 FROM player_photo_blocks WHERE key = ?`).get(k);
const block = (k: string, reason: string) => db.prepare(`INSERT OR REPLACE INTO player_photo_blocks (key, reason, at) VALUES (?, ?, ?)`).run(k, reason, new Date().toISOString());
const pkey = (sport: string, id: number) => `${sport}:${id}`;
const fileOf = (sport: string, p: string | null) => (p ? path.join(PHOTO_DIR, sport, path.basename(p)) : null);
function dropFile(sport: string, p: string | null) {
  const f = fileOf(sport, p);
  if (f) try { fs.unlinkSync(f); } catch { /* gone already */ }
}
function save(sport: PhotoSport, id: number, name: string, f: Partial<{ status: string; wikidata: string | null; reason: string; confidence: string | null; file: string | null; author: string | null; licence: string | null; licence_url: string | null; source_url: string | null; path: string | null; mime: string | null }>) {
  const old = db.prepare(`SELECT * FROM player_photos WHERE sport = ? AND player_id = ?`).get(sport, id) as any;
  const r = { status: 'none', wikidata: null, reason: '', confidence: null, file: null, author: null, licence: null, licence_url: null, source_url: null, path: null, mime: null, ...f };
  if (old?.path && old.path !== r.path) dropFile(sport, old.path);
  db.prepare(`INSERT OR REPLACE INTO player_photos (sport, player_id, name, status, wikidata, reason, confidence, file, author, licence, licence_url, source_url, path, mime, checked_at, approved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(sport, id, name, r.status, r.wikidata, r.reason, r.confidence, r.file, r.author, r.licence, r.licence_url, r.source_url, r.path, r.mime,
    new Date().toISOString(), r.status === 'ok' && old?.approved_at && old?.wikidata === r.wikidata ? old.approved_at : null);
  loadedAt = 0;
}

/** one player: match, licence, thumbnail → a player_photos row */
export async function photoFor(ours: Ours & { id: number }): Promise<{ status: string; reason: string }> {
  const { sport, id } = ours;
  if (blocked(pkey(sport, id))) return { status: 'blocked', reason: 'blocked' };
  const cands = await candidatesFor(sport, ours.name);
  const d = decide(ours, cands);
  const base = { wikidata: d.qid, confidence: d.confidence, reason: d.reason };
  if (!d.qid || !d.confidence) { save(sport, id, ours.name, { ...base, status: 'none' }); return { status: 'none', reason: d.reason }; }
  if (blocked(`wd:${d.qid}`)) { save(sport, id, ours.name, { ...base, status: 'none', reason: `${d.reason}; Wikidata item blocked` }); return { status: 'none', reason: 'item blocked' }; }
  if (!d.image) { save(sport, id, ours.name, { ...base, status: 'none', reason: `${d.reason}; no image on Wikidata` }); return { status: 'none', reason: 'no image' }; }
  if (blocked(`file:${d.image}`)) { save(sport, id, ours.name, { ...base, status: 'none', reason: `${d.reason}; image blocked` }); return { status: 'none', reason: 'image blocked' }; }
  const old = db.prepare(`SELECT * FROM player_photos WHERE sport = ? AND player_id = ?`).get(sport, id) as any;
  const { info, reason } = await commonsInfo(d.image);
  if (!info) { save(sport, id, ours.name, { ...base, status: 'none', reason: `${d.reason}; ${reason}` }); return { status: 'none', reason }; }
  const status = d.confidence === 'high' || (old?.approved_at && old.wikidata === d.qid) ? 'ok' : 'review';
  const meta = { ...base, file: info.file, author: info.author, licence: info.licence, licence_url: info.licenceUrl, source_url: info.sourceUrl };
  // the same Commons file already stored: keep it (no download)
  if (old?.file === info.file && old?.path && fs.existsSync(fileOf(sport, old.path)!)) {
    save(sport, id, ours.name, { ...meta, status, path: old.path, mime: old.mime });
    return { status, reason: d.reason };
  }
  const img = await get(info.thumb);
  const buf = Buffer.from(await img.arrayBuffer());
  if (buf.length > 8e6) { save(sport, id, ours.name, { ...base, status: 'none', reason: `${d.reason}; image too large` }); return { status: 'none', reason: 'too large' }; }
  // fix212: the crop (sharp: decode, face box, resize, WebP) runs in a job thread — the worker's loop stays free
  const sq = await (threadJobsOn() ? inThread<{ data: Buffer; mime: string; ext: string } | null>('photo crop', [buf]).then(r => (r && (r as any).data ? { ...r, data: Buffer.from((r as any).data) } : r)) : faceSquare(buf))
    .catch(e => { logger.warn(`player photos: crop ${sport} ${id}: ${e?.message || e}`); return null; });
  const out = sq || { data: buf, mime: info.mime, ext: info.mime === 'image/png' ? 'png' : 'jpg' };
  const name = `${id}-${crypto.createHash('sha1').update(info.file).digest('hex').slice(0, 10)}.${out.ext}`;
  fs.mkdirSync(path.join(PHOTO_DIR, sport), { recursive: true });
  fs.writeFileSync(path.join(PHOTO_DIR, sport, name), out.data);
  save(sport, id, ours.name, { ...meta, status, path: name, mime: out.mime });
  return { status, reason: d.reason };
}

/* ---------------- who to look at ---------------- */

const tennisNameSql = `TRIM(COALESCE(NULLIF(TRIM(COALESCE(p.first_name, '') || ' ' || COALESCE(p.last_name, '')), ''), p.name))`;
/** tennis: ATP / WTA top 1000 + players of the next 7 days' matches (no ITF), best ranked first */
function tennisQueue(): (Ours & { id: number; prio: number })[] {
  const out: (Ours & { id: number; prio: number })[] = [];
  try {
    const rows = db.prepare(`
      WITH latest AS (SELECT tour, MAX(date) AS d FROM tennis_rankings WHERE tour IN ('atp','wta') GROUP BY tour),
      ranked AS (SELECT r.player_id AS id, MIN(r.rank) AS rank FROM tennis_rankings r JOIN latest l ON l.tour = r.tour AND l.d = r.date WHERE r.rank <= 1000 AND r.player_id IS NOT NULL GROUP BY r.player_id),
      soon AS (SELECT p1_id AS id FROM tennis_matches WHERE scheduled_at BETWEEN ? AND ? AND COALESCE(tour, '') <> 'itf' UNION SELECT p2_id FROM tennis_matches WHERE scheduled_at BETWEEN ? AND ? AND COALESCE(tour, '') <> 'itf')
      SELECT p.id, ${tennisNameSql} AS name, p.dob, p.country, COALESCE(k.rank, 5000) AS rank FROM tennis_players p
      LEFT JOIN ranked k ON k.id = p.id
      WHERE (k.id IS NOT NULL OR p.id IN (SELECT id FROM soon)) AND COALESCE(p.gone, 0) = 0 AND p.name IS NOT NULL`)
      .all(new Date(Date.now() - DAY).toISOString(), new Date(Date.now() + 7 * DAY).toISOString(), new Date(Date.now() - DAY).toISOString(), new Date(Date.now() + 7 * DAY).toISOString()) as any[];
    for (const r of rows) out.push({ sport: 'tennis', id: r.id, name: r.name, dob: r.dob || null, country: r.country || null, prio: r.rank });
  } catch (e: any) { logger.warn(`player photos: tennis list: ${e?.message || e}`); }
  return out;
}
/** basketball: current squads + everyone who played in the last 60 days, most minutes first */
function basketballQueue(): (Ours & { id: number; prio: number })[] {
  const by = new Map<number, Ours & { id: number; prio: number }>();
  try {
    const since = new Date(Date.now() - 60 * DAY).toISOString();
    const teamName = new Map<number, string>();
    const year = new Date(Date.now() - 400 * DAY).toISOString();
    for (const g of db.prepare(`SELECT home_id AS id, MAX(home_name) AS name FROM bb_games WHERE kickoff >= ? GROUP BY home_id
        UNION SELECT away_id, MAX(away_name) FROM bb_games WHERE kickoff >= ? GROUP BY away_id`).all(year, year) as any[])
      if (g.id && g.name) teamName.set(g.id, g.name);
    const played = db.prepare(`SELECT ps.player_id AS id, MAX(ps.name) AS name, SUM(COALESCE(ps.minutes, 0)) AS mins, GROUP_CONCAT(DISTINCT ps.team_id) AS teams
      FROM bb_games g JOIN bb_player_stats ps ON ps.game_id = g.game_id WHERE g.kickoff >= ? GROUP BY ps.player_id`).all(since) as any[];
    for (const r of played) by.set(r.id, { sport: 'basketball', id: r.id, name: r.name, teams: String(r.teams || '').split(',').map(Number).map(t => teamName.get(t)).filter(Boolean) as string[], prio: -r.mins });
    for (const r of db.prepare(`SELECT player_id AS id, name, country, age, team_id FROM bb_roster WHERE updated_at >= ?`).all(new Date(Date.now() - 180 * DAY).toISOString()) as any[]) {
      const x: Ours & { id: number; prio: number } = by.get(r.id) || { sport: 'basketball', id: r.id, name: r.name, teams: [], prio: 0 };
      x.country = r.country || x.country || null;
      x.age = r.age ?? x.age ?? null;
      const tn = teamName.get(r.team_id);
      if (tn && !x.teams!.includes(tn)) x.teams!.push(tn);
      if (abbreviated(x.name) && !abbreviated(r.name)) x.name = r.name;
      by.set(r.id, x);
    }
    // fix214: the leagues with targets first (NBA ≥ 85 %, EuroLeague ≥ 50 %), most minutes first inside them
    const leagueOf = new Map<number, string>();
    for (const g of db.prepare(`SELECT home_id AS id, code FROM bb_games WHERE kickoff >= ? AND code IN ('NBA','EL') UNION SELECT away_id, code FROM bb_games WHERE kickoff >= ? AND code IN ('NBA','EL')`).all(year, year) as any[])
      leagueOf.set(g.id, g.code);
    const rosterTeams = new Map<number, number[]>();
    for (const r of db.prepare(`SELECT player_id AS id, team_id FROM bb_roster WHERE updated_at >= ?`).all(new Date(Date.now() - 180 * DAY).toISOString()) as any[])
      rosterTeams.set(r.id, [...(rosterTeams.get(r.id) || []), r.team_id]);
    for (const x of by.values()) {
      const codes = (rosterTeams.get(x.id) || []).map(t => leagueOf.get(t));
      if (codes.includes('NBA')) { x.prio -= 2e6; nbaFullName(x); } else if (codes.includes('EL')) x.prio -= 1e6;
    }
  } catch (e: any) { logger.warn(`player photos: basketball list: ${e?.message || e}`); }
  return [...by.values()];
}
/**
 * fix214: an NBA player API-Basketball only knows as "T. Johnson" (40 % of NBA roster rows: rookies, two-way players):
 * balldontlie's active player with that initial and last name on the same team gives the full name (and country).
 * Exactly one such player, or nothing changes.
 */
function nbaFullName(x: Ours & { id: number }) {
  if (!abbreviated(x.name)) return;
  const m = /^(\p{L})\.?\s+(.+)$/u.exec(x.name.trim()) || ((y) => (y ? [y[0], y[2], y[1]] : null))(/^(.+?)\s+(\p{L})\.?$/u.exec(x.name.trim()));
  if (!m) return;
  const [, initial, last] = m;
  try {
    const rows = (db.prepare(`SELECT p.first, p.last, p.country, t.full_name AS team FROM bdl_players p LEFT JOIN bdl_teams t ON t.id = p.team_id
        WHERE p.active = 1 AND LOWER(p.last) = LOWER(?) AND SUBSTR(LOWER(p.first), 1, 1) = LOWER(?)`).all(last.trim(), initial) as any[])
      .filter(r => r.team && (x.teams || []).some(t => sameTeam(t, r.team)));
    if (rows.length !== 1) return;
    x.name = `${rows[0].first} ${rows[0].last}`;
    x.country = x.country || rows[0].country || null;
  } catch { /* no balldontlie tables */ }
}

/** players to look at now: never looked at first (best first), then the oldest look over 7 days ago (no review / block) */
function queue(limit: number) {
  const seen = new Map((db.prepare(`SELECT sport, player_id, status, checked_at, path FROM player_photos`).all() as any[]).map(r => [pkey(r.sport, r.player_id), r]));
  const stale = new Date(Date.now() - RECHECK_MS).toISOString();
  const pick = (list: (Ours & { id: number; prio: number })[]) => {
    const fresh = list.filter(x => !seen.has(pkey(x.sport, x.id)) && !abbreviated(x.name)).sort((a, b) => a.prio - b.prio);
    const again = list.filter(x => {
      const r = seen.get(pkey(x.sport, x.id));
      if (!r) return false;
      // an approved photo whose file vanished (a restored database) is fetched again at once
      if (r.status === 'ok' && r.path && !fs.existsSync(fileOf(x.sport, r.path)!)) return true;
      return (r.status === 'ok' || r.status === 'none') && r.checked_at < stale;
    }).sort((a, b) => String(seen.get(pkey(a.sport, a.id))!.checked_at).localeCompare(String(seen.get(pkey(b.sport, b.id))!.checked_at)));
    return [...fresh, ...again];
  };
  const t = pick(tennisQueue()), b = pick(basketballQueue());
  const out: (Ours & { id: number })[] = [];
  for (let i = 0; out.length < limit && (i < t.length || i < b.length); i++) {
    if (i < t.length) out.push(t[i]);
    if (i < b.length && out.length < limit) out.push(b[i]);
  }
  return out;
}

/* ---------------- job ---------------- */

const run = { at: null as string | null, done: 0, ok: 0, review: 0, none: 0, errors: 0, lastError: null as string | null, running: false };
/**
 * a batch of players (PHOTO_BATCH, default 60 since fix214: ~5 min of 1-a-second calls); stops on the first 429. fix212: the batch goes in slices of at most 20
 * players, the loop yields after every player (and whenever 50 ms have passed), the image work is in a thread: the
 * run was one 12-second turn ("player photos + web writes" stall).
 */
export const PHOTO_SLICE = 20;
/** fix214: basketball players turned down by the old rules (stale age) are looked at again now, not in 7 days */
const MATCHER = 'fix214';
function requeueOnce() {
  const done = db.prepare(`SELECT data FROM photo_wd_cache WHERE qid = '_matcher'`).get() as any;
  if (done?.data === JSON.stringify(MATCHER)) return;
  const n = db.prepare(`UPDATE player_photos SET checked_at = '2000-01-01T00:00:00.000Z' WHERE sport = 'basketball' AND status = 'none'`).run().changes;
  db.prepare(`INSERT OR REPLACE INTO photo_wd_cache (qid, data, at) VALUES ('_matcher', ?, ?)`).run(JSON.stringify(MATCHER), new Date().toISOString());
  logger.info(`player photos: ${n} basketball players queued again (${MATCHER} matcher)`);
}
export async function photosTick(limit = Number(process.env.PHOTO_BATCH) || 60) {
  if (run.running || process.env.PLAYER_PHOTOS === '0') return;
  run.running = true;
  try {
    requeueOnce();
    const list = queue(limit);
    const step = yieldEvery(1, 50);
    let stop = false;
    for (let i = 0; i < list.length && !stop; i += PHOTO_SLICE) {
      for (const p of list.slice(i, i + PHOTO_SLICE)) {
        try {
          const r = await photoFor(p);
          run.done++;
          if (r.status === 'ok') run.ok++; else if (r.status === 'review') run.review++; else run.none++;
        } catch (e: any) {
          run.errors++; run.lastError = `${p.sport} ${p.id} ${p.name}: ${e?.message || e}`;
          if (/429/.test(String(e?.message))) { logger.warn(`player photos: ${run.lastError} — paused until the next run`); stop = true; break; }
        }
        await step();
      }
      await yieldLoop();
    }
    run.at = new Date().toISOString();
    db.prepare(`INSERT OR REPLACE INTO photo_wd_cache (qid, data, at) VALUES ('_lastRun', ?, ?)`).run(JSON.stringify({ n: list.length }), run.at);
  } finally { run.running = false; }
}

/* ---------------- read side (pages) ---------------- */

export interface Shown { url: string; author: string; licence: string; licenceUrl: string | null; source: string }
let shown = new Map<string, Shown>();
let loadedAt = 0;
function load() {
  if (Date.now() - loadedAt < 5 * 60 * 1000) return;
  loadedAt = Date.now();
  const m = new Map<string, Shown>();
  try {
    for (const r of db.prepare(`SELECT sport, player_id, path, author, licence, licence_url, source_url FROM player_photos WHERE status = 'ok' AND path IS NOT NULL AND author IS NOT NULL AND licence IS NOT NULL`).all() as any[])
      m.set(pkey(r.sport, r.player_id), { url: `/media/players/${r.sport}/${r.path}`, author: r.author, licence: r.licence, licenceUrl: r.licence_url || null, source: r.source_url });
  } catch { /* table not ready */ }
  shown = m;
}
/** the photo's address on our domain, or null (the page shows initials + flag) */
export function photoUrl(sport: PhotoSport, id: number | null | undefined): string | null {
  if (id == null) return null;
  load();
  return shown.get(pkey(sport, id))?.url ?? null;
}
/** author, licence and the Commons file of a shown photo (the credit under it) */
export function photoCredit(sport: PhotoSport, id: number | null | undefined): Omit<Shown, 'url'> | null {
  if (id == null) return null;
  load();
  const s = shown.get(pkey(sport, id));
  return s ? { author: s.author, licence: s.licence, licenceUrl: s.licenceUrl, source: s.source } : null;
}
/** a stored file (served by app.ts) — null when it isn't a shown photo */
export function photoFile(sport: string, file: string): string | null {
  if (!PHOTO_SPORTS.includes(sport as PhotoSport) || !/^\d+-[0-9a-f]{10}\.(webp|jpg|png)$/.test(file)) return null;
  const f = path.join(PHOTO_DIR, sport, file);
  return fs.existsSync(f) ? f : null;
}

let creditsCache: { at: number; rows: any[] } | null = null;
/** every shown photo with its credit (the /credits page) */
export function photoCredits() {
  if (creditsCache && Date.now() - creditsCache.at < 10 * 60 * 1000) return creditsCache.rows;
  const rows = (db.prepare(`SELECT sport, player_id, name, author, licence, licence_url, source_url, file FROM player_photos
      WHERE status = 'ok' AND path IS NOT NULL AND author IS NOT NULL AND licence IS NOT NULL ORDER BY sport, name LIMIT 20000`).all() as any[])
    .map(r => ({ sport: r.sport, id: r.player_id, name: r.name, author: r.author, licence: r.licence, licenceUrl: r.licence_url || null, source: r.source_url, file: r.file }));
  creditsCache = { at: Date.now(), rows };
  return rows;
}

/* ---------------- admin ---------------- */

export function photosAdmin() {
  const counts = db.prepare(`SELECT sport, status, COUNT(*) AS n FROM player_photos GROUP BY sport, status`).all() as any[];
  const list = (where: string, n = 200) => db.prepare(`SELECT sport, player_id AS id, name, status, wikidata, reason, confidence, file, author, licence, source_url AS source, path, checked_at AS checkedAt
    FROM player_photos WHERE ${where} ORDER BY checked_at DESC LIMIT ${n}`).all() as any[];
  const withUrl = (r: any) => ({ ...r, url: r.path ? `/api/admin/player-photos/file/${r.sport}/${r.path}` : null });
  return {
    run: { ...run, calls }, counts,
    review: list(`status = 'review'`).map(withUrl),
    recent: list(`status = 'ok'`, 60).map(withUrl),
    notMatched: list(`status = 'none' AND wikidata IS NOT NULL`, 60),
    blocked: db.prepare(`SELECT key, reason, at FROM player_photo_blocks ORDER BY at DESC LIMIT 200`).all()
  };
}
/** a review / stored file for the admin page (also before approval) */
export function adminPhotoFile(sport: string, file: string): string | null {
  if (!PHOTO_SPORTS.includes(sport as PhotoSport) || !/^\d+-[0-9a-f]{10}\.(webp|jpg|png)$/.test(file)) return null;
  const f = path.join(PHOTO_DIR, sport, file);
  return fs.existsSync(f) ? f : null;
}
const rowOf = (sport: string, id: number) => db.prepare(`SELECT * FROM player_photos WHERE sport = ? AND player_id = ?`).get(sport, id) as any;
export function approvePhoto(sport: PhotoSport, id: number) {
  const r = rowOf(sport, id);
  if (!r || r.status !== 'review' || !r.path || !r.author || !r.licence) return false;
  db.prepare(`UPDATE player_photos SET status = 'ok', approved_at = ? WHERE sport = ? AND player_id = ?`).run(new Date().toISOString(), sport, id);
  loadedAt = 0; creditsCache = null;
  return true;
}
/** wrong person: the photo goes, this player is not matched to that Wikidata item again */
export function rejectPhoto(sport: PhotoSport, id: number) {
  const r = rowOf(sport, id);
  if (!r) return false;
  dropFile(sport, r.path);
  block(pkey(sport, id), `rejected match ${r.wikidata || ''}`.trim());
  db.prepare(`UPDATE player_photos SET status = 'rejected', path = NULL, checked_at = ? WHERE sport = ? AND player_id = ?`).run(new Date().toISOString(), sport, id);
  loadedAt = 0; creditsCache = null;
  return true;
}
/** remove (takedown, or any doubt): file deleted, the player and that Commons file blocked for good */
export function removePhoto(sport: PhotoSport, id: number, reason = 'removed by admin') {
  const r = rowOf(sport, id);
  block(pkey(sport, id), reason);
  if (r?.file) block(`file:${r.file}`, `${reason} (${sport} ${id})`);
  if (r) {
    dropFile(sport, r.path);
    db.prepare(`UPDATE player_photos SET status = 'blocked', path = NULL, checked_at = ? WHERE sport = ? AND player_id = ?`).run(new Date().toISOString(), sport, id);
  } else db.prepare(`INSERT OR REPLACE INTO player_photos (sport, player_id, status, reason, checked_at) VALUES (?, ?, 'blocked', ?, ?)`).run(sport, id, reason, new Date().toISOString());
  loadedAt = 0; creditsCache = null;
  return true;
}
/** undo a block (the player is looked at again on the next run) */
export function unblockPhoto(key: string) {
  db.prepare(`DELETE FROM player_photo_blocks WHERE key = ?`).run(key);
  const m = /^(tennis|basketball):(\d+)$/.exec(key);
  if (m) db.prepare(`DELETE FROM player_photos WHERE sport = ? AND player_id = ? AND status IN ('blocked','rejected')`).run(m[1], Number(m[2]));
  return true;
}

/* ---------------- data health ---------------- */

export function photoHealth(): { id: string; label: string; level: 'ok' | 'warn' | 'fail'; detail: string; items: string[] } {
  load();
  const has = (sport: PhotoSport, id: number) => shown.has(pkey(sport, id));
  const pct = (a: number, b: number) => (b ? `${Math.round((1000 * a) / b) / 10}%` : '–');
  let top100 = 0, n100 = 0, top500 = 0, n500 = 0;
  try {
    const rows = db.prepare(`SELECT r.player_id AS id, r.rank FROM tennis_rankings r JOIN (SELECT tour, MAX(date) AS d FROM tennis_rankings WHERE tour IN ('atp','wta') GROUP BY tour) l
      ON l.tour = r.tour AND l.d = r.date WHERE r.rank <= 500 AND r.player_id IS NOT NULL`).all() as any[];
    for (const r of rows) { n500++; if (has('tennis', r.id)) top500++; if (r.rank <= 100) { n100++; if (has('tennis', r.id)) top100++; } }
  } catch { /* no tennis tables */ }
  let bbN = 0, bbHas = 0;
  // fix212b: coverage per league (NBA ≥ 85 % and EuroLeague ≥ 50 % are the targets), and why the rest have none
  const leagues: { code: string; n: number; has: number }[] = [];
  try {
    const since = new Date(Date.now() - 180 * DAY).toISOString();
    const rows = db.prepare(`SELECT DISTINCT r.player_id AS id, g.code FROM bb_roster r JOIN (SELECT home_id AS team_id, code FROM bb_games WHERE kickoff >= ? UNION SELECT away_id, code FROM bb_games WHERE kickoff >= ?) g ON g.team_id = r.team_id WHERE r.updated_at >= ?`).all(since, since, since) as any[];
    const ids = new Set<number>();
    const by = new Map<string, { code: string; n: number; has: number }>();
    for (const r of rows) {
      ids.add(r.id);
      const l = by.get(r.code) || { code: r.code, n: 0, has: 0 };
      l.n++; if (has('basketball', r.id)) l.has++;
      by.set(r.code, l);
    }
    bbN = ids.size; bbHas = [...ids].filter(id => has('basketball', id)).length;
    leagues.push(...[...by.values()].sort((a, b) => b.n - a.n));
  } catch { /* no basketball tables */ }
  const reasons = (sport: PhotoSport) => { try { return db.prepare(`SELECT COALESCE(reason, status) AS reason, COUNT(*) AS n FROM player_photos WHERE sport = ? AND status <> 'ok' GROUP BY 1 ORDER BY n DESC LIMIT 6`).all(sport) as { reason: string; n: number }[]; } catch { return []; } };
  // a shown photo must have its author and licence stored (credit), and a file
  const bad = db.prepare(`SELECT sport, player_id, name FROM player_photos WHERE status = 'ok' AND (author IS NULL OR author = '' OR licence IS NULL OR licence = '' OR source_url IS NULL)`).all() as any[];
  const missing = (db.prepare(`SELECT sport, player_id, name, path FROM player_photos WHERE status = 'ok'`).all() as any[]).filter(r => !r.path || !fs.existsSync(fileOf(r.sport, r.path)!));
  const review = (db.prepare(`SELECT COUNT(*) AS n FROM player_photos WHERE status = 'review'`).get() as any).n;
  const lastRun = (db.prepare(`SELECT at FROM photo_wd_cache WHERE qid = '_lastRun'`).get() as any)?.at || null;
  const nba = leagues.find(l => l.code === 'NBA'), el = leagues.find(l => l.code === 'EL');
  const items = [
    ...leagues.slice(0, 12).map(l => `basketball ${l.code}: ${pct(l.has, l.n)} (${l.has} of ${l.n})`),
    ...reasons('basketball').map(r => `basketball, no photo — ${r.reason}: ${r.n}`),
    ...reasons('tennis').map(r => `tennis, no photo — ${r.reason}: ${r.n}`),
    ...bad.map(r => `${r.sport} ${r.player_id} ${r.name || ''}: shown without author / licence`),
    ...missing.slice(0, 10).map(r => `${r.sport} ${r.player_id} ${r.name || ''}: file missing (fetched again on the next run)`)
  ];
  const stale = process.env.PLAYER_PHOTOS !== '0' && (!lastRun || Date.parse(lastRun) < Date.now() - 2 * DAY);
  return {
    id: 'player-photos', label: 'Player photos', level: bad.length ? 'fail' : stale || missing.length || (nba && nba.n >= 50 && nba.has / nba.n < 0.85) || (el && el.n >= 50 && el.has / el.n < 0.5) ? 'warn' : 'ok',
    detail: `tennis top 100 ${pct(top100, n100)} · top 500 ${pct(top500, n500)} · basketball ${pct(bbHas, bbN)} (${bbHas} of ${bbN}) · ${review} to review · last run ${lastRun ? lastRun.slice(0, 16).replace('T', ' ') : 'never'}`,
    items
  };
}

/** for tests: swap the network */
export const __test = { setFetcher: (f: Fetcher) => { fetcher = f; lastCall = 0; }, candidatesFor, commonsInfo, queue };
