/**
 * fix205: calendar subscription (.ics). Every signed-in user gets one private link (/cal/<32 chars>.ics) that Google /
 * Apple / Outlook calendar subscribe to: the games of their favourite teams (football, basketball, American football)
 * and favourite tennis players, the last 7 days and the next 30, with our pick under the same locking rules as the site
 * (paid plans / unlocked picks see the numbers, everyone else a link to the game page; finished games: score + ✓ / ✗).
 *
 * The token is stored as a SHA-256 hash (the lookup) and sealed with the two-step key (so the owner can see the link
 * again on the account page); a reset replaces both, the old link stops at once. Logs only ever show 6 characters.
 * Times are UTC in the file (calendar apps show local time); the words follow the language the link was made in.
 * No odds, no betting words.
 */
import crypto from 'crypto';
import { pubPath } from './slugs';
import { db } from '../db';
import { runsJobs } from './role';
import { listFavorites, type Favorite } from './favorites';
import { roleByKey, ALL_PERMS } from './roles';
import { userById, accessOf, canSeeFull, isPaid, type User, type Access } from './auth';
import { unlockedIds } from './billing';
import { MIX_MODEL, FEAT_MODEL, mixLive, mixLiveSince } from './featureModel';
import { sealText, openText } from './twoFactor';
import { doubleChance, dcHit, type DC, type Outcome } from '../utils/doubleChance';
import { slModel, type ModelSport } from '../utils/modelNames';
import { every } from './perf';
import { nameIn } from './names';

db.exec(`
  CREATE TABLE IF NOT EXISTS calendar_tokens (
    user_id      INTEGER PRIMARY KEY,
    token_hash   TEXT NOT NULL UNIQUE,
    token_sealed TEXT,
    lang         TEXT NOT NULL DEFAULT 'en',
    created_at   TEXT NOT NULL,
    last_used_at TEXT
  );
  -- one row per game ever put in a calendar: SEQUENCE / LAST-MODIFIED move when its time or status changes
  CREATE TABLE IF NOT EXISTS calendar_event_state (uid TEXT PRIMARY KEY, sig TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0, modified_at TEXT NOT NULL);
`);

const DAY = 86400000;
const PAST_DAYS = 7, NEXT_DAYS = 30;
const CACHE_MS = 15 * 60000;
const AF_OFFSET = 1_000_000_000; // = afMatches.AF_OFFSET (API-Football fixture → our match id)
export const CAL_LANGS = ['en', 'de', 'es', 'fr', 'it', 'pt', 'tr', 'id', 'hi', 'pl', 'el', 'ru', 'ar', 'he'] as const;
export type CalLang = (typeof CAL_LANGS)[number];
export const asCalLang = (x: unknown): CalLang => (CAL_LANGS as readonly string[]).includes(String(x)) ? (x as CalLang) : 'en';

/* ---------- words (English is the key, like the site) ---------- */

type Words = { draw: string; orDraw: string; noDraw: string; pick: string; see: string; soon: string; final: string; off: string; empty: string; calName: string; calDesc: string; footer: string };
const WORDS: Record<CalLang, Words> = {
  en: { draw: 'draw', orDraw: '{0} or draw', noDraw: 'No draw', pick: 'Our pick: {0}', see: 'See our prediction: {0}', soon: 'Our prediction comes closer to the game: {0}', final: 'Final score: {0}', off: 'Postponed or cancelled', empty: 'Add favourite teams on SportLikely to see their games here', calName: 'SportLikely · my games', calDesc: 'Games of your favourite teams and players, with our pick. Probabilities, not promises. 18+.', footer: 'SportLikely · probabilities, not promises · 18+' },
  de: { draw: 'Unentschieden', orDraw: '{0} oder Unentschieden', noDraw: 'Kein Remis', pick: 'Unser Tipp: {0}', see: 'Unsere Prognose: {0}', soon: 'Unsere Prognose kommt kurz vor dem Spiel: {0}', final: 'Endstand: {0}', off: 'Verschoben oder abgesagt', empty: 'Füge auf SportLikely Lieblingsteams hinzu, um ihre Spiele hier zu sehen', calName: 'SportLikely · meine Spiele', calDesc: 'Spiele deiner Lieblingsteams und -spieler, mit unserem Tipp. Wahrscheinlichkeiten, keine Versprechen. 18+.', footer: 'SportLikely · Wahrscheinlichkeiten, keine Versprechen · 18+' },
  es: { draw: 'empate', orDraw: '{0} o empate', noDraw: 'Sin empate', pick: 'Nuestro pronóstico: {0}', see: 'Mira nuestro pronóstico: {0}', soon: 'Nuestro pronóstico llega más cerca del partido: {0}', final: 'Resultado final: {0}', off: 'Aplazado o cancelado', empty: 'Añade equipos favoritos en SportLikely para ver aquí sus partidos', calName: 'SportLikely · mis partidos', calDesc: 'Partidos de tus equipos y jugadores favoritos, con nuestro pronóstico. Probabilidades, no promesas. 18+.', footer: 'SportLikely · probabilidades, no promesas · 18+' },
  fr: { draw: 'nul', orDraw: '{0} ou match nul', noDraw: 'Pas de nul', pick: 'Notre pronostic : {0}', see: 'Voir notre pronostic : {0}', soon: 'Notre pronostic arrive plus près du match : {0}', final: 'Score final : {0}', off: 'Reporté ou annulé', empty: 'Ajoutez des équipes favorites sur SportLikely pour voir leurs matchs ici', calName: 'SportLikely · mes matchs', calDesc: 'Les matchs de vos équipes et joueurs favoris, avec notre pronostic. Des probabilités, pas des promesses. 18+.', footer: 'SportLikely · des probabilités, pas des promesses · 18+' },
  it: { draw: 'pareggio', orDraw: '{0} o pareggio', noDraw: 'Niente pareggio', pick: 'Il nostro pronostico: {0}', see: 'Vedi il nostro pronostico: {0}', soon: 'Il nostro pronostico arriva più vicino alla partita: {0}', final: 'Risultato finale: {0}', off: 'Rinviata o annullata', empty: 'Aggiungi squadre preferite su SportLikely per vedere qui le loro partite', calName: 'SportLikely · le mie partite', calDesc: 'Le partite delle tue squadre e dei tuoi giocatori preferiti, con il nostro pronostico. Probabilità, non promesse. 18+.', footer: 'SportLikely · probabilità, non promesse · 18+' },
  pt: { draw: 'empate', orDraw: '{0} ou empate', noDraw: 'Sem empate', pick: 'Nosso palpite: {0}', see: 'Veja nosso palpite: {0}', soon: 'Nosso palpite chega mais perto do jogo: {0}', final: 'Placar final: {0}', off: 'Adiado ou cancelado', empty: 'Adicione times favoritos no SportLikely para ver os jogos deles aqui', calName: 'SportLikely · meus jogos', calDesc: 'Jogos dos seus times e jogadores favoritos, com nosso palpite. Probabilidades, não promessas. 18+.', footer: 'SportLikely · probabilidades, não promessas · 18+' },
  tr: { draw: 'beraberlik', orDraw: '{0} veya beraberlik', noDraw: 'Beraberlik yok', pick: 'Tahminimiz: {0}', see: 'Tahminimizi gör: {0}', soon: 'Tahminimiz maça yakın gelir: {0}', final: 'Maç sonucu: {0}', off: 'Ertelendi veya iptal edildi', empty: 'Maçlarını burada görmek için SportLikely’de favori takımlar ekle', calName: 'SportLikely · maçlarım', calDesc: 'Favori takımlarının ve oyuncularının maçları, tahminimizle. Olasılıklar, söz değil. 18+.', footer: 'SportLikely · olasılıklar, söz değil · 18+' },
  id: { draw: 'seri', orDraw: '{0} atau seri', noDraw: 'Tanpa seri', pick: 'Pilihan kami: {0}', see: 'Lihat prediksi kami: {0}', soon: 'Prediksi kami muncul menjelang pertandingan: {0}', final: 'Skor akhir: {0}', off: 'Ditunda atau dibatalkan', empty: 'Tambahkan tim favorit di SportLikely untuk melihat pertandingannya di sini', calName: 'SportLikely · pertandingan saya', calDesc: 'Pertandingan tim dan pemain favorit Anda, dengan pilihan kami. Probabilitas, bukan janji. 18+.', footer: 'SportLikely · probabilitas, bukan janji · 18+' },
  hi: { draw: 'ड्रॉ', orDraw: '{0} या ड्रॉ', noDraw: 'ड्रॉ नहीं', pick: 'हमारा पिक: {0}', see: 'हमारी भविष्यवाणी देखें: {0}', soon: 'हमारी भविष्यवाणी मैच के करीब आएगी: {0}', final: 'अंतिम स्कोर: {0}', off: 'स्थगित या रद्द', empty: 'अपने मैच यहाँ देखने के लिए SportLikely पर पसंदीदा टीमें जोड़ें', calName: 'SportLikely · मेरे मैच', calDesc: 'आपकी पसंदीदा टीमों और खिलाड़ियों के मैच, हमारे पिक के साथ। संभावनाएँ, वादे नहीं। 18+.', footer: 'SportLikely · संभावनाएँ, वादे नहीं · 18+' },
  pl: { draw: 'remis', orDraw: '{0} lub remis', noDraw: 'Bez remisu', pick: 'Nasz typ: {0}', see: 'Zobacz naszą prognozę: {0}', soon: 'Nasza prognoza pojawi się bliżej meczu: {0}', final: 'Wynik końcowy: {0}', off: 'Przełożony lub odwołany', empty: 'Dodaj ulubione drużyny w SportLikely, aby widzieć tu ich mecze', calName: 'SportLikely · moje mecze', calDesc: 'Mecze twoich ulubionych drużyn i zawodników, z naszym typem. Prawdopodobieństwa, nie obietnice. 18+.', footer: 'SportLikely · prawdopodobieństwa, nie obietnice · 18+' },
  el: { draw: 'ισοπαλία', orDraw: '{0} ή ισοπαλία', noDraw: 'Όχι ισοπαλία', pick: 'Η επιλογή μας: {0}', see: 'Δες την πρόβλεψή μας: {0}', soon: 'Η πρόβλεψή μας έρχεται πιο κοντά στον αγώνα: {0}', final: 'Τελικό σκορ: {0}', off: 'Αναβλήθηκε ή ακυρώθηκε', empty: 'Πρόσθεσε αγαπημένες ομάδες στο SportLikely για να βλέπεις εδώ τους αγώνες τους', calName: 'SportLikely · οι αγώνες μου', calDesc: 'Αγώνες των αγαπημένων σου ομάδων και παικτών, με την επιλογή μας. Πιθανότητες, όχι υποσχέσεις. 18+.', footer: 'SportLikely · πιθανότητες, όχι υποσχέσεις · 18+' },
  ru: { draw: 'ничья', orDraw: '{0} или ничья', noDraw: 'Без ничьей', pick: 'Наш выбор: {0}', see: 'Смотрите наш прогноз: {0}', soon: 'Наш прогноз появится ближе к матчу: {0}', final: 'Итоговый счёт: {0}', off: 'Перенесён или отменён', empty: 'Добавьте любимые команды на SportLikely, чтобы видеть здесь их матчи', calName: 'SportLikely · мои матчи', calDesc: 'Матчи ваших любимых команд и игроков, с нашим выбором. Вероятности, а не обещания. 18+.', footer: 'SportLikely · вероятности, а не обещания · 18+' },
  ar: { draw: 'تعادل', orDraw: '{0} أو تعادل', noDraw: 'لا تعادل', pick: 'اختيارنا: {0}', see: 'شاهد توقعنا: {0}', soon: 'يصدر توقعنا قرب موعد المباراة: {0}', final: 'النتيجة النهائية: {0}', off: 'تأجلت أو أُلغيت', empty: 'أضف فرقك المفضلة على SportLikely لترى مبارياتها هنا', calName: 'SportLikely · مبارياتي', calDesc: 'مباريات فرقك ولاعبيك المفضلين مع اختيارنا. احتمالات، لا وعود. 18+.', footer: 'SportLikely · احتمالات، لا وعود · 18+' },
  he: { draw: 'תיקו', orDraw: '{0} או תיקו', noDraw: 'בלי תיקו', pick: 'הבחירה שלנו: {0}', see: 'לתחזית שלנו: {0}', soon: 'התחזית שלנו תעלה קרוב יותר למשחק: {0}', final: 'תוצאת סיום: {0}', off: 'נדחה או בוטל', empty: 'הוסיפו קבוצות מועדפות ב-SportLikely כדי לראות כאן את המשחקים שלהן', calName: 'SportLikely · המשחקים שלי', calDesc: 'המשחקים של הקבוצות והשחקנים המועדפים עליכם, עם הבחירה שלנו. הסתברויות, לא הבטחות. 18+.', footer: 'SportLikely · הסתברויות, לא הבטחות · 18+' }
};
const fill = (s: string, ...a: string[]) => a.reduce((x, v, i) => x.replace(`{${i}}`, v), s);

/* ---------- RFC 5545 ---------- */

/** TEXT value: backslash, semicolon, comma and new lines escaped. */
export const icsEscape = (s: string) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
/** Fold a content line at 75 octets (continuation lines start with one space), never inside a UTF-8 character. */
export function foldLine(line: string): string {
  const buf = Buffer.from(line, 'utf8');
  if (buf.length <= 75) return line;
  const parts: string[] = [];
  let start = 0, limit = 75;
  while (start < buf.length) {
    let end = Math.min(start + limit, buf.length);
    while (end < buf.length && end > start && (buf[end] & 0xc0) === 0x80) end--; // back off a continuation byte
    parts.push(buf.subarray(start, end).toString('utf8'));
    start = end;
    limit = 74; // the leading space counts
  }
  return parts.join('\r\n ');
}
/** 2026-10-24T14:00:00.000Z → 20261024T140000Z */
export const icsTime = (iso: string | number) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsDay = (t: number) => new Date(t).toISOString().slice(0, 10).replace(/-/g, '');

export interface CalEvent {
  uid: string; start: string; end: string; allDay?: boolean
  summary: string; description: string; location?: string | null; url?: string | null
  cancelled?: boolean; sequence?: number; lastModified?: string
}
export function buildIcs(cal: { name: string; description: string; events: CalEvent[]; now?: number }): string {
  const stamp = icsTime(cal.now ?? Date.now());
  const L: string[] = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//SportLikely//Calendar 1.0//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(cal.name)}`, `NAME:${icsEscape(cal.name)}`, `X-WR-CALDESC:${icsEscape(cal.description)}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H', 'X-PUBLISHED-TTL:PT6H'];
  for (const e of cal.events) {
    L.push('BEGIN:VEVENT', `UID:${e.uid}`, `DTSTAMP:${stamp}`);
    if (e.allDay) L.push(`DTSTART;VALUE=DATE:${icsDay(Date.parse(e.start))}`, `DTEND;VALUE=DATE:${icsDay(Date.parse(e.end))}`);
    else L.push(`DTSTART:${icsTime(e.start)}`, `DTEND:${icsTime(e.end)}`);
    L.push(`SUMMARY:${icsEscape(e.summary)}`);
    if (e.location) L.push(`LOCATION:${icsEscape(e.location)}`);
    if (e.url) L.push(`URL:${e.url}`);
    L.push(`DESCRIPTION:${icsEscape(e.description)}`, `STATUS:${e.cancelled ? 'CANCELLED' : 'CONFIRMED'}`, `SEQUENCE:${e.sequence ?? 0}`);
    if (e.lastModified) L.push(`LAST-MODIFIED:${icsTime(e.lastModified)}`);
    L.push('TRANSP:TRANSPARENT', 'END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return L.map(foldLine).join('\r\n') + '\r\n';
}

/* ---------- tokens ---------- */

const hashOf = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
/** first 6 characters only: what logs may show of a calendar link */
export const tokenHint = (token: string) => `${String(token).slice(0, 6)}…`;
export const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
// fix205b: in memory only, so every deploy starts empty; CAL_BUILD also drops anything an older build left behind
const CAL_BUILD = 'fix205b';
const cache = new Map<string, { at: number; body: string; build: string }>();

function newToken(userId: number, lang: CalLang): string {
  const token = crypto.randomBytes(24).toString('base64url'); // 32 characters
  const old = db.prepare(`SELECT token_hash FROM calendar_tokens WHERE user_id = ?`).get(userId) as any;
  if (old) cache.delete(old.token_hash);
  db.prepare(`INSERT INTO calendar_tokens (user_id, token_hash, token_sealed, lang, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, NULL)
    ON CONFLICT (user_id) DO UPDATE SET token_hash = excluded.token_hash, token_sealed = excluded.token_sealed, lang = excluded.lang, created_at = excluded.created_at, last_used_at = NULL`)
    .run(userId, hashOf(token), sealText(token), lang, new Date().toISOString());
  return token;
}

/** The user's link (made the first time). `created` = a new link was made (security log). */
export function calendarToken(userId: number, lang?: CalLang): { token: string; created: boolean; createdAt: string; lastUsedAt: string | null } {
  const row = db.prepare(`SELECT * FROM calendar_tokens WHERE user_id = ?`).get(userId) as any;
  let token: string | null = null;
  if (row?.token_sealed) { try { token = openText(row.token_sealed); } catch { token = null; } } // key changed: a new link
  if (token && hashOf(token) === row.token_hash) {
    if (lang && lang !== row.lang) { db.prepare(`UPDATE calendar_tokens SET lang = ? WHERE user_id = ?`).run(lang, userId); cache.delete(row.token_hash); }
    return { token, created: false, createdAt: row.created_at, lastUsedAt: row.last_used_at || null };
  }
  const t = newToken(userId, lang || asCalLang(row?.lang));
  return { token: t, created: true, createdAt: new Date().toISOString(), lastUsedAt: null };
}
/** "Reset link": a new token; the old link stops working at once. */
export function resetCalendarToken(userId: number, lang?: CalLang): string {
  const row = db.prepare(`SELECT lang FROM calendar_tokens WHERE user_id = ?`).get(userId) as any;
  return newToken(userId, lang || asCalLang(row?.lang));
}
/** Account deletion: the link goes with the account. */
export function deleteCalendarFor(userId: number) {
  const row = db.prepare(`SELECT token_hash FROM calendar_tokens WHERE user_id = ?`).get(userId) as any;
  if (row) cache.delete(row.token_hash);
  db.prepare(`DELETE FROM calendar_tokens WHERE user_id = ?`).run(userId);
}

/** The .ics file for a link, or null (unknown / revoked token, deleted account). Cached 15 min per link. */
export function calendarIcs(token: string, site: string, now = Date.now()): string | null {
  if (!TOKEN_RE.test(token)) return null;
  const h = hashOf(token);
  const row = db.prepare(`SELECT user_id, lang, last_used_at FROM calendar_tokens WHERE token_hash = ?`).get(h) as any;
  if (!row) { cache.delete(h); return null; }
  if (!row.last_used_at || Date.parse(row.last_used_at) < now - 10 * 60000) db.prepare(`UPDATE calendar_tokens SET last_used_at = ? WHERE token_hash = ?`).run(new Date(now).toISOString(), h);
  const hit = cache.get(h);
  if (hit && hit.build === CAL_BUILD && hit.at > now - CACHE_MS) return hit.body;
  const user = userById(row.user_id);
  if (!user) return null;
  const body = calendarFor(user, asCalLang(row.lang), site, now);
  if (cache.size > 5000) cache.delete(cache.keys().next().value as string);
  cache.set(h, { at: now, body, build: CAL_BUILD });
  return body;
}
export const clearCalendarCache = () => cache.clear();

/* ---------- games ---------- */

type State = 'sched' | 'done' | 'off';
interface Game {
  sport: ModelSport; key: 'fb' | 'bb' | 'nfl' | 'tennis'; id: number; start: string; hours: number
  home: string; away: string; comp: string; venue: string | null; path: string; state: State
  score: [number, number] | null; winner: 1 | 2 | null
  /** percentages (football with the draw) */
  pred: { h: number; d: number | null; a: number } | null; full: boolean
}

/**
 * fix205b: every id a favourite football club has in our data — never its name (a "Barcelona" favourite listed Barcelona
 * SC's games). API-Football ids carry AF_OFFSET, Football-Data.org ids don't; the two are linked by team_resolve (the
 * team page's own resolver) and by the league groups (team_map FD id ↔ fd_name ↔ af_teams AF id, same group only).
 */
export function footballTeamIds(favIds: number[]): Set<number> {
  const af = new Set<number>(), fd = new Set<number>();
  for (const id of favIds) if (Number.isInteger(id) && id > 0) (id >= AF_OFFSET ? af.add(id - AF_OFFSET) : fd.add(id));
  const resolve = tableExists('team_resolve'), groups = tableExists('team_map') && tableExists('af_teams');
  for (const id of [...fd]) {
    if (resolve) for (const r of db.prepare(`SELECT af_id FROM team_resolve WHERE fd_id = ?`).all(id) as any[]) af.add(r.af_id);
    if (groups) for (const r of db.prepare(`SELECT a.team_id FROM team_map m JOIN af_teams a ON a.grp = m.grp AND a.fd_name = m.fd_name WHERE m.team_id = ?`).all(id) as any[]) af.add(r.team_id);
  }
  for (const id of [...af]) {
    if (resolve) for (const r of db.prepare(`SELECT fd_id FROM team_resolve WHERE af_id = ?`).all(id) as any[]) fd.add(r.fd_id);
    if (groups) for (const r of db.prepare(`SELECT m.team_id FROM af_teams a JOIN team_map m ON m.grp = a.grp AND m.fd_name = a.fd_name WHERE a.team_id = ?`).all(id) as any[]) fd.add(r.team_id);
  }
  return new Set([...fd, ...[...af].map(a => AF_OFFSET + a)]);
}
/** A football favourite saved without ids: found once with the team page's lookup and the ids stored; null = skipped. */
const triedAt = new Map<string, number>();
function resolveFavIds(userId: number, f: Favorite): number[] | null {
  const k = `${userId}|${f.ref}`;
  if ((triedAt.get(k) || 0) > Date.now() - 6 * 3600000) return null;
  triedAt.set(k, Date.now());
  let af: number | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const tp: typeof import('./teamPage') = require('./teamPage');
    af = tp.resolveAfTeamId(0, f.code || undefined, f.name);
  } catch { af = null; }
  if (!af) return null;
  const ids = [AF_OFFSET + af];
  const { addedAt: _drop, ...data } = f;
  db.prepare(`UPDATE user_favorites SET data = ? WHERE user_id = ? AND kind = ? AND ref = ?`).run(JSON.stringify({ ...data, ids }), userId, f.kind, f.ref);
  return ids;
}
/** The model a public page shows for a match (lower = preferred, 99 = a shadow model): as tracking.ts MAIN_PRIORITY. */
const MAIN_PRIORITY = ['grid-v3', 'elo-intl', 'elo-euro', 'dc-history-v2', 'poisson-dc-v1'];
export function mainModelRank(m: string, date?: string) {
  if (m === MIX_MODEL) { const since = mixLive() ? mixLiveSince() : ''; return since && date && date >= since ? -1 : 99; }
  if (m === FEAT_MODEL) return 99;
  const i = MAIN_PRIORITY.indexOf(m); return i < 0 ? 99 : i;
}
const pct = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? null : v <= 1 ? v * 100 : v);
const tableExists = (t: string) => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t);
const inList = (n: number) => Array(n).fill('?').join(',');

const FB_OFF = new Set(['PST', 'CANC', 'ABD', 'SUSP', 'INT', 'WO', 'POSTPONED', 'CANCELLED', 'SUSPENDED', 'VOID']);
const FB_DONE = new Set(['FT', 'AET', 'PEN', 'FINISHED', 'AWARDED']);

function footballGames(ids: Set<number>, from: string, to: string, full: (id: number) => boolean): Game[] {
  if (!ids.size) return [];
  const list = [...ids], q = inList(list.length);
  const rows = db.prepare(`SELECT p.match_id, p.model, p.competition_name, p.utc_date, p.home_team_id, p.home_team, p.away_team_id, p.away_team,
      p.p_home, p.p_draw, p.p_away, r.status AS rstatus, r.home_goals, r.away_goals, r.outcome
    FROM predictions p LEFT JOIN results r ON r.match_id = p.match_id WHERE p.utc_date >= ? AND p.utc_date < ?
      AND (p.home_team_id IN (${q}) OR p.away_team_id IN (${q}))`).all(from, to, ...list, ...list) as any[];
  const best = new Map<number, any>();
  for (const r of rows) {
    const rank = mainModelRank(r.model, r.utc_date);
    if (rank >= 99) continue; // shadow models never shown
    const cur = best.get(r.match_id);
    if (!cur || rank < cur.rank) best.set(r.match_id, { ...r, rank });
  }
  const hasAf = tableExists('af_fixtures');
  const afRow = hasAf ? db.prepare(`SELECT kickoff, status, hg, ag FROM af_fixtures WHERE fixture_id = ?`) : null;
  const out: Game[] = [];
  for (const r of best.values()) {
    const af: any = r.match_id >= AF_OFFSET && afRow ? afRow.get(r.match_id - AF_OFFSET) : null;
    const status = String(af?.status || r.rstatus || '').toUpperCase();
    const state: State = r.outcome === 'VOID' || FB_OFF.has(status) ? 'off' : r.outcome && 'HDA'.includes(r.outcome) || FB_DONE.has(status) ? 'done' : 'sched';
    const hg = r.home_goals ?? af?.hg, ag = r.away_goals ?? af?.ag;
    out.push({
      sport: 'football', key: 'fb', id: r.match_id, start: af?.kickoff || r.utc_date, hours: 2, home: r.home_team, away: r.away_team,
      comp: r.competition_name || '', venue: null, path: pubPath(`/match/${r.match_id}`), state,
      score: state === 'done' && hg != null && ag != null ? [hg, ag] : null, winner: null,
      pred: { h: pct(r.p_home)!, d: pct(r.p_draw), a: pct(r.p_away)! }, full: full(r.match_id)
    });
  }
  // fixtures of the leagues added from Admin (AF<id>) not predicted yet: by the API-Football team id
  const afIds = list.filter(i => i >= AF_OFFSET).map(i => i - AF_OFFSET);
  if (hasAf && afIds.length) {
    const seen = new Set(out.map(g => g.id));
    const names = tableExists('af_extra_leagues') ? new Map((db.prepare(`SELECT league_id, name FROM af_extra_leagues`).all() as any[]).map(l => [l.league_id, l.name])) : new Map();
    const qa = inList(afIds.length);
    const fx = db.prepare(`SELECT fixture_id, league_id, kickoff, home_name, away_name, status, hg, ag FROM af_fixtures WHERE kickoff >= ? AND kickoff < ? AND grp LIKE 'AF%'
      AND (home_id IN (${qa}) OR away_id IN (${qa}))`).all(from, to, ...afIds, ...afIds) as any[];
    for (const f of fx) {
      const id = AF_OFFSET + f.fixture_id;
      if (seen.has(id)) continue;
      const status = String(f.status || '').toUpperCase();
      const state: State = FB_OFF.has(status) ? 'off' : FB_DONE.has(status) ? 'done' : 'sched';
      out.push({ sport: 'football', key: 'fb', id, start: f.kickoff, hours: 2, home: f.home_name, away: f.away_name, comp: names.get(f.league_id) || '', venue: null,
        path: pubPath(`/match/${id}`), state, score: state === 'done' && f.hg != null && f.ag != null ? [f.hg, f.ag] : null, winner: null, pred: null, full: full(id) });
    }
  }
  return out;
}

const US_OFF = ['POST', 'PST', 'CANC', 'ABD', 'SUSP'];
const US_DONE = ['FT', 'AOT', 'AWD'];
function usState(status: string | null, hs: number | null, as: number | null): State {
  const s = String(status || 'NS').toUpperCase();
  if (US_OFF.includes(s)) return 'off';
  return US_DONE.includes(s) && hs != null && as != null ? 'done' : s === 'AWD' ? 'off' : 'sched';
}

function basketballGames(ids: number[], from: string, to: string, full: (rid: number) => boolean): Game[] {
  if (!ids.length || !tableExists('bb_games')) return [];
  const names = tableExists('bb_leagues') ? new Map((db.prepare(`SELECT code, name FROM bb_leagues`).all() as any[]).map(l => [l.code, l.name])) : new Map();
  const pred = tableExists('bb_predictions');
  const rows = db.prepare(`SELECT g.game_id, g.code, g.kickoff, g.status, g.home_name, g.away_name, g.hs, g.as_${pred ? ', p.p_home' : ''} FROM bb_games g
    ${pred ? 'LEFT JOIN bb_predictions p ON p.game_id = g.game_id' : ''}
    WHERE g.kickoff >= ? AND g.kickoff < ? AND (g.home_id IN (${inList(ids.length)}) OR g.away_id IN (${inList(ids.length)}))`).all(from, to, ...ids, ...ids) as any[];
  return rows.map(r => {
    const state = usState(r.status, r.hs, r.as_);
    const p = pct(r.p_home);
    return { sport: 'basketball', key: 'bb', id: r.game_id, start: r.kickoff, hours: 2.5, home: r.home_name, away: r.away_name, comp: names.get(r.code) || r.code,
      venue: null, path: pubPath(`/basketball/game/${r.game_id}`), state, score: state === 'done' ? [r.hs, r.as_] : null, winner: null,
      pred: p == null ? null : { h: p, d: null, a: 100 - p }, full: full(-r.game_id) } as Game;
  });
}

function nflGames(ids: number[], from: string, to: string, full: (rid: number) => boolean): Game[] {
  if (!ids.length || !tableExists('nfl_games')) return [];
  const pred = tableExists('nfl_predictions');
  const rows = db.prepare(`SELECT g.game_id, g.league, g.kickoff, g.status, g.home_name, g.away_name, g.home_pts, g.away_pts, g.venue${pred ? ', p.p_home' : ''} FROM nfl_games g
    ${pred ? 'LEFT JOIN nfl_predictions p ON p.game_id = g.game_id' : ''}
    WHERE g.kickoff >= ? AND g.kickoff < ? AND (g.home_id IN (${inList(ids.length)}) OR g.away_id IN (${inList(ids.length)}))`).all(from, to, ...ids, ...ids) as any[];
  return rows.map(r => {
    const state = usState(r.status, r.home_pts, r.away_pts);
    const p = pct(r.p_home);
    return { sport: 'american-football', key: 'nfl', id: r.game_id, start: r.kickoff, hours: 3.5, home: r.home_name, away: r.away_name,
      comp: r.league === 2 ? 'College football' : 'NFL', venue: r.venue || null, path: pubPath(`/american-football/game/${r.game_id}`), state,
      score: state === 'done' ? [r.home_pts, r.away_pts] : null, winner: null, pred: p == null ? null : { h: p, d: null, a: 100 - p }, full: full(-(2e9 + r.game_id)) } as Game;
  });
}

function tennisGames(ids: number[], from: string, to: string, full: (rid: number) => boolean, admin: boolean): Game[] {
  if (!ids.length || !tableExists('tennis_matches')) return [];
  // loaded here, not at the top: the tennis pages pull in the tennis model, which most calendars never need
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ts: typeof import('./tennisSite') = require('./tennisSite');
  const q = inList(ids.length);
  const rows = db.prepare(`SELECT ${ts.MATCH_COLS} ${ts.MATCH_FROM} WHERE m.id IN (SELECT id FROM tennis_matches WHERE p1_id IN (${q}) AND scheduled_at >= ? AND scheduled_at < ?
      UNION SELECT id FROM tennis_matches WHERE p2_id IN (${q}) AND scheduled_at >= ? AND scheduled_at < ?) AND ${ts.MATCH_PUBLIC}`).all(...ids, from, to, ...ids, from, to) as any[];
  const list = rows.map(ts.shapeMatch).filter((m): m is NonNullable<typeof m> => !!m && (m.tour !== 'itf' || admin));
  return ts.withTennisPredictions(list, full).map(m => {
    const state: State = /cancel|postpon|abandon|walkover/i.test(m.status) ? 'off' : m.state === 'done' ? 'done' : 'sched';
    const p = m.prediction && !m.prediction.locked ? m.prediction : null;
    const saved = !!m.prediction; // a locked prediction is still a prediction
    return { sport: 'tennis', key: 'tennis', id: m.id, start: m.start, hours: m.bestOf === 5 ? 3.5 : 2, home: m.home.name, away: m.away.name,
      comp: [m.tournament.name, m.round].filter(Boolean).join(' · '), venue: [m.tournament.city, m.tournament.country].filter(Boolean).join(', ') || null,
      path: pubPath(`/tennis/match/${m.id}`), state, score: state === 'done' && m.score ? [m.score.won[0], m.score.won[1]] : null, winner: m.winner,
      pred: p ? { h: p.pHome, d: null, a: p.pAway } : saved ? { h: NaN, d: null, a: NaN } : null, full: !!p } as Game;
  });
}

/* ---------- the file ---------- */

const r0 = (x: number) => `${Math.round(x)}%`;
function describe(g: Game, w: Words, url: string): string {
  const lines: string[] = [];
  const known = !!g.pred && Number.isFinite(g.pred.h);
  if (g.state === 'off') lines.push(w.off);
  else if (g.state === 'done') {
    if (g.score) lines.push(fill(w.final, `${g.home} ${g.score[0]}–${g.score[1]} ${g.away}`));
    // fix205b: once the game is over everyone sees the whole pick (the site's rule), with ✓ / ✗
    if (known) {
      const p = g.pred!;
      let hit: boolean | null = null;
      if (g.sport === 'football') {
        const dc = doubleChance(p.h, p.d ?? 0, p.a);
        const o: Outcome | null = g.score ? (g.score[0] > g.score[1] ? 'H' : g.score[0] < g.score[1] ? 'A' : 'D') : null;
        if (dc && o) hit = dcHit(dc.k, o);
      } else {
        const won = g.winner ?? (g.score ? (g.score[0] > g.score[1] ? 1 : g.score[0] < g.score[1] ? 2 : null) : null);
        if (won) hit = (p.h >= p.a) === (won === 1);
      }
      lines.push(...pickLines(g, p, w, hit));
    }
  } else if (!g.pred) lines.push(fill(w.soon, url));
  else if (!g.full || !known) lines.push(fill(w.see, url));
  else lines.push(...pickLines(g, g.pred, w, null));
  if (!lines.some(l => l.includes(url))) lines.push(url);
  lines.push(w.footer);
  return lines.join('\n');
}
/** "SL Football 3.0: Arsenal 61% · draw 22% · Everton 17%" + "Our pick: Arsenal or draw · 83%" (+ ✓ / ✗ when settled) */
function pickLines(g: Game, p: NonNullable<Game['pred']>, w: Words, hit: boolean | null): string[] {
  const parts = [`${g.home} ${r0(p.h)}`, ...(p.d != null ? [`${w.draw} ${r0(p.d)}`] : []), `${g.away} ${r0(p.a)}`];
  const mark = hit === null ? '' : hit ? ' ✓' : ' ✗';
  const dc = g.sport === 'football' ? doubleChance(p.h, p.d ?? 0, p.a) : null;
  const pick = dc ? `${fill(w.pick, dcWords(dc.k, g, w))} · ${r0(dc.p)}` : fill(w.pick, `${p.h >= p.a ? g.home : g.away} · ${r0(Math.max(p.h, p.a))}`);
  return [`${slModel(g.sport)}: ${parts.join(' · ')}`, pick + mark];
}
const dcWords = (k: DC, g: Game, w: Words) => (k === '1X' ? fill(w.orDraw, g.home) : k === 'X2' ? fill(w.orDraw, g.away) : w.noDraw);

/** Sequence numbers: one global row per game; moves when its start or status changes. */
function stamps(games: Game[], now: number): Map<string, { seq: number; at: string }> {
  const out = new Map<string, { seq: number; at: string }>();
  const get = db.prepare(`SELECT sig, seq, modified_at FROM calendar_event_state WHERE uid = ?`);
  const put = db.prepare(`INSERT OR REPLACE INTO calendar_event_state (uid, sig, seq, modified_at) VALUES (?, ?, ?, ?)`);
  const iso = new Date(now).toISOString();
  db.exec('BEGIN');
  try {
    for (const g of games) {
      const uid = uidOf(g), sig = `${new Date(g.start).toISOString()}|${g.state}`;
      const r = get.get(uid) as any;
      if (!r) { put.run(uid, sig, 0, iso); out.set(uid, { seq: 0, at: iso }); }
      else if (r.sig !== sig) { put.run(uid, sig, r.seq + 1, iso); out.set(uid, { seq: r.seq + 1, at: iso }); }
      else out.set(uid, { seq: r.seq, at: r.modified_at });
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return out;
}
const uidOf = (g: Game) => `sl-${g.key}-${g.id}@sportlikely.com`;

/** The whole calendar of one user right now (exported for the tests; the route goes through calendarIcs). */
export function calendarFor(user: User, lang: CalLang, site: string, now = Date.now()): string {
  const w = WORDS[lang];
  const admin = !!user.isAdmin;
  // fix205b: admins and staff whose role has every permission see the full pick like Pro (the file has no session,
  // so the two-step check of the site is replaced by "two-step login is on")
  const role = roleByKey(user.role);
  const fullStaff = !!role && user.emailVerified && user.twoFactor && ALL_PERMS.every(p => role.perms.includes(p));
  const access: Access = admin || fullStaff ? 'admin' : accessOf(user);
  const unlocked = access === 'pro' || access === 'admin' ? new Set<number>() : unlockedIds(user.id);
  const fbFull = (id: number) => canSeeFull(access) || unlocked.has(id);
  const usFull = (rid: number) => isPaid(access) || unlocked.has(rid);
  const from = new Date(now - PAST_DAYS * DAY).toISOString(), to = new Date(now + NEXT_DAYS * DAY).toISOString();

  const favs = listFavorites(user.id);
  const ids = (k: string) => [...new Set(favs.filter(f => f.kind === k).flatMap(f => (f.ids?.length ? f.ids : [Number(f.ref)]).filter(n => Number.isInteger(n) && n > 0)))];
  const fbTeams = favs.filter(f => f.kind === 'team');
  const bbOn = process.env.BASKETBALL_PUBLIC === '1' || admin, nflOn = process.env.NFL_PUBLIC === '1' || admin, tnOn = process.env.TENNIS_PUBLIC === '1' || admin;
  const bbIds = bbOn ? ids('bb-team') : [], nflIds = nflOn ? ids('nfl-team') : [], tnIds = tnOn ? ids('tennis-player') : [];

  const games: Game[] = [];
  // fix205b: football by ids only; a favourite without ids is resolved once and stored, else skipped
  const fbIds = fbTeams.flatMap(f => (f.ids?.length ? f.ids : resolveFavIds(user.id, f) || []));
  if (fbIds.length) games.push(...footballGames(footballTeamIds(fbIds), from, to, fbFull));
  games.push(...basketballGames(bbIds, from, to, usFull), ...nflGames(nflIds, from, to, usFull), ...tennisGames(tnIds, from, to, usFull, admin));
  games.sort((a, b) => a.start.localeCompare(b.start) || a.id - b.id);
  // fix261: names in the calendar's script (he / ar)
  for (const g of games) { g.home = nameIn(lang, g.home); g.away = nameIn(lang, g.away); if (g.comp) g.comp = nameIn(lang, g.comp); }

  const prefix = lang === 'en' ? '' : `/${lang}`;
  const events: CalEvent[] = [];
  if (!fbTeams.length && !bbIds.length && !nflIds.length && !tnIds.length) {
    const day = new Date(now); day.setUTCHours(0, 0, 0, 0);
    events.push({ uid: `sl-empty-${user.id}@sportlikely.com`, start: day.toISOString(), end: new Date(day.getTime() + DAY).toISOString(), allDay: true,
      summary: w.empty, description: `${site}${prefix}/football/favorites\n${w.footer}`, url: `${site}${prefix}/football/favorites` });
  } else {
    const st = stamps(games, now);
    for (const g of games) {
      const url = `${site}${prefix}${g.path}`;
      const s = st.get(uidOf(g))!;
      const t0 = Date.parse(g.start);
      events.push({
        uid: uidOf(g), start: new Date(t0).toISOString(), end: new Date(t0 + g.hours * 3600000).toISOString(),
        summary: `${g.home} – ${g.away}${g.comp ? ` · ${g.comp}` : ''}`, location: g.venue, url, description: describe(g, w, url),
        cancelled: g.state === 'off', sequence: s.seq, lastModified: s.at
      });
    }
  }
  return buildIcs({ name: w.calName, description: w.calDesc, events, now });
}

every('calendar cleanup', () => {
  if (runsJobs) try { db.prepare(`DELETE FROM calendar_event_state WHERE modified_at < ?`).run(new Date(Date.now() - 90 * DAY).toISOString()); } catch { /* ignore */ } // fix210b: not in the web process
  const old = Date.now() - CACHE_MS;
  for (const [k, v] of cache) if (v.at < old) cache.delete(k);
}, 6 * 3600000).unref();
