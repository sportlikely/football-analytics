/**
 * fix229: clean links — every public page is /<lang?>/<sport>/<kind>/<slug> (docs/notes/links.md).
 *
 * - Table `slugs` (sport, kind, slug, id, is_primary): one primary slug per team / player / league / match, aliases
 *   (renames, other names) kept forever. `slug_ids` maps other ids of the same item (a Football-Data.org team id → the
 *   API-Football team, an API-Football fixture → its Football-Data.org twin, a merged player / tennis match) to it.
 * - The worker assigns slugs (job "slugs": new items every 15 minutes, renames every 6 hours; utils/slugAssign.ts) and
 *   publishes one state per sport (`slugs:<sport>`): slug → id and id → slug for every team and league, this and last
 *   season's players and the matches of -60 … +30 days, plus the app's small exception list (`/api/slugs/:sport`).
 * - The web process answers from that state only (no database read per request); anything outside it is asked of the
 *   worker (`/api/slug-route`), which reads the table.
 * - The pages keep their ids inside: an old address (/team/86?c=PD&n=…, /match/560614, /basketball/game/1 …) answers
 *   301 with the new one in one hop; a new address is turned back into the page's id (`internalPath`).
 */
import { db } from '../db';
import logger from '../utils/logger';
import { isWeb, runsJobs } from './role';
import { onState, applyState } from './shared';
import { yieldEvery } from './perf';
import { assignSlugs, assignMatchSlugs, baseOf, type SlugEntity, type SlugRow, type MatchEntity } from '../utils/slugAssign';
import { teamSlug, slugify, playerSlug, matchSlug, parseMatchSlug, isSlug, splitTab, movedPage, LINK_SPORTS, ALLOWED_QUERY, type LinkSport, type LinkKind } from '../utils/slugRules';

db.exec(`CREATE TABLE IF NOT EXISTS slugs (sport TEXT NOT NULL, kind TEXT NOT NULL, slug TEXT NOT NULL, id TEXT NOT NULL, is_primary INTEGER NOT NULL DEFAULT 1, base TEXT, at TEXT NOT NULL, PRIMARY KEY (sport, kind, slug))`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_slugs_id ON slugs(sport, kind, id, is_primary)`);
db.exec(`CREATE TABLE IF NOT EXISTS slug_ids (sport TEXT NOT NULL, kind TEXT NOT NULL, old_id TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (sport, kind, old_id))`);

const AF = 1_000_000_000;
const LANG_RE = '(?:\\/(es|pt|de|fr|it|tr))?';

/* ---------- the old (id) addresses of every sport: the pages still read these ids ---------- */

type Internal = { sport: LinkSport; kind: LinkKind; id: string };
/** old address → item (any language prefix); first match wins */
const OLD: { re: RegExp; sport: LinkSport; kind: LinkKind; id?: string }[] = [
  { re: /^\/team\/(\d+)$/, sport: 'football', kind: 'team' },
  { re: /^\/match\/(\d+)$/, sport: 'football', kind: 'match' },
  { re: /^\/player\/(\d+)$/, sport: 'football', kind: 'player' },
  { re: /^\/league\/([A-Za-z0-9]+)$/, sport: 'football', kind: 'league' },
  { re: /^\/basketball\/team\/(\d+)$/, sport: 'basketball', kind: 'team' },
  { re: /^\/basketball\/game\/(\d+)$/, sport: 'basketball', kind: 'match' },
  { re: /^\/basketball\/match\/(\d+)$/, sport: 'basketball', kind: 'match' },
  { re: /^\/basketball\/player\/(\d+)$/, sport: 'basketball', kind: 'player' },
  { re: /^\/basketball\/league\/([A-Za-z0-9]*[A-Z][A-Za-z0-9]*)$/, sport: 'basketball', kind: 'league' }, // codes are upper case (NBA, BB123); slugs lower
  { re: /^\/american-football\/team\/(\d+)$/, sport: 'american-football', kind: 'team' },
  { re: /^\/american-football\/game\/(\d+)$/, sport: 'american-football', kind: 'match' },
  { re: /^\/american-football\/match\/(\d+)$/, sport: 'american-football', kind: 'match' },
  { re: /^\/american-football\/player\/(\d+)$/, sport: 'american-football', kind: 'player' },
  { re: /^\/american-football\/league$/, sport: 'american-football', kind: 'league', id: '1' },
  { re: /^\/american-football\/college\/league$/, sport: 'american-football', kind: 'league', id: '2' },
  { re: /^\/tennis\/match\/(-?\d+)$/, sport: 'tennis', kind: 'match' },
  { re: /^\/tennis\/player\/(\d+)$/, sport: 'tennis', kind: 'player' },
  { re: /^\/tennis\/(?:tournament|predictions)\/([a-z0-9-]+)$/, sport: 'tennis', kind: 'league' },
  // a number where a slug belongs (typed by hand): the item's slug
  { re: /^\/football\/team\/(\d+)$/, sport: 'football', kind: 'team' },
  { re: /^\/football\/match\/(\d+)$/, sport: 'football', kind: 'match' },
  { re: /^\/football\/player\/(\d+)$/, sport: 'football', kind: 'player' },
  { re: /^\/basketball\/league\/(\d+)$/, sport: 'basketball', kind: 'league' }
];
/** the page address the app's pages and the crawler pages read (id inside) */
export function internalPath(sport: LinkSport, kind: LinkKind, id: string): string {
  if (sport === 'football') return kind === 'match' ? `/match/${id}` : `/${kind}/${id}`;
  if (sport === 'basketball') return kind === 'match' ? `/basketball/game/${id}` : `/basketball/${kind}/${id}`;
  if (sport === 'american-football') return kind === 'match' ? `/american-football/game/${id}` : kind === 'league' ? (id === '2' ? '/american-football/college/league' : '/american-football/league') : `/american-football/${kind}/${id}`;
  return kind === 'league' ? `/tennis/tournament/${id}` : `/tennis/${kind}/${id}`;
}
/** an old address (no language prefix, no query) → its item, else null */
export function parseOld(path: string): Internal | null {
  const p = path.replace(/\/+$/, '') || '/';
  for (const o of OLD) {
    const m = o.re.exec(p);
    if (!m) continue;
    return { sport: o.sport, kind: o.kind, id: o.id ?? m[1] };
  }
  return null;
}
/** a new address (no language prefix) → its parts, else null */
export function parseNew(path: string): { sport: LinkSport; kind: LinkKind; slug: string } | null {
  const m = /^\/([a-z-]+)\/(team|player|league|match)\/([^/]+)\/?$/.exec(path);
  if (!m || !(LINK_SPORTS as readonly string[]).includes(m[1]) || !isSlug(m[3])) return null;
  if (m[1] === 'tennis' && m[2] === 'team') return null;
  return { sport: m[1] as LinkSport, kind: m[2] as LinkKind, slug: m[3] };
}

/* ---------- the published state (web: the only source; worker: its own copy, then the table) ---------- */

export interface SlugState { sport: LinkSport; builtAt: number; map: Map<string, string>; client: string; clientPlayers: string }
// map keys: `s:<kind>/<slug>` → `<id>` (primary) or `<id> <canonical slug>` (alias); `i:<kind>/<id>` → primary slug
const states = new Map<LinkSport, SlugState>();
onState('slugs:', (_key, v: SlugState) => { if (v?.sport) states.set(v.sport, v); });
export const slugState = (sport: LinkSport) => states.get(sport) || null;

const q = (sql: string) => { let st: any = null; return () => (st ||= db.prepare(sql)); };
const qSlug = q(`SELECT id, is_primary FROM slugs WHERE sport = ? AND kind = ? AND slug = ?`);
const qPrimary = q(`SELECT slug FROM slugs WHERE sport = ? AND kind = ? AND id = ? AND is_primary = 1`);
const qOldId = q(`SELECT id FROM slug_ids WHERE sport = ? AND kind = ? AND old_id = ?`);

/** the canonical id of an item (an old / twin id → the item's) — memory, then (not on the web) the table */
function canonicalId(sport: LinkSport, kind: LinkKind, id: string): string {
  if (isWeb || !runsJobs) return id;
  try { return (qOldId().get(sport, kind, id) as any)?.id ?? id; } catch { return id; }
}
/*
 * fix238: every match and player id of a sport (all seasons, old / twin ids too) → its primary slug, prebuilt by the
 * worker beside the state above (`slugs-ids:<sport>`). Old crawler links (/basketball/game/318721, /de/…) were asked of
 * the worker (3–4.7 s web stalls, 25 Oct); now the web answers them from memory. Chunks of sorted ids (binary search,
 * microseconds): ids = Float64Array (sorted), off = Uint32Array (slug i = text.slice(off[i], off[i + 1])).
 */
export type IdChunk = { kind: LinkKind; ids: Float64Array; off: Uint32Array; text: string };
export interface IdIndex { sport: LinkSport; builtAt: number; entries: number; chunks: IdChunk[] }
const idIndexes = new Map<LinkSport, IdIndex>();
onState('slugs-ids:', (_key, v: IdIndex) => { if (v?.sport) idIndexes.set(v.sport, v); });
const ID_CHUNK = 4096;
/** sorted (id, slug) pairs of one kind → chunks */
export function idChunks(kind: LinkKind, pairs: [number, string][]): IdChunk[] {
  pairs.sort((a, b) => a[0] - b[0]);
  const out: IdChunk[] = [];
  for (let i = 0; i < pairs.length; i += ID_CHUNK) {
    const part = pairs.slice(i, i + ID_CHUNK);
    const ids = new Float64Array(part.length), off = new Uint32Array(part.length + 1);
    let text = '';
    part.forEach(([id, s], k) => { ids[k] = id; off[k] = text.length; text += s; });
    off[part.length] = text.length;
    out.push({ kind, ids, off, text });
  }
  return out;
}
/** an id's slug in the index (null = not there) */
export function indexedSlug(ix: IdIndex | null | undefined, kind: LinkKind, id: string): string | null {
  if (!ix || !/^-?\d+$/.test(id)) return null;
  const n = Number(id);
  for (const c of ix.chunks) {
    if (c.kind !== kind || !c.ids.length || n < c.ids[0] || n > c.ids[c.ids.length - 1]) continue;
    let lo = 0, hi = c.ids.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1, v = c.ids[mid];
      if (v === n) return c.text.slice(c.off[mid], c.off[mid + 1]);
      if (v < n) lo = mid + 1; else hi = mid - 1;
    }
    return null;
  }
  return null;
}
export const idIndexOf = (sport: LinkSport) => idIndexes.get(sport) || null;

/** id → the item's slug (null = no slug yet). The web process reads its state only. */
export function slugOf(sport: LinkSport, kind: LinkKind, id: string | number | null | undefined): string | null {
  if (id == null || id === '') return null;
  const key = String(id);
  const st = states.get(sport);
  const hit = st?.map.get(`i:${kind}/${key}`) ?? ((kind === 'match' || kind === 'player') ? indexedSlug(idIndexes.get(sport), kind, key) : null);
  if (hit) return hit;
  if (isWeb) return null;
  try {
    const cid = canonicalId(sport, kind, key);
    return ((qPrimary().get(sport, kind, cid) as any)?.slug as string) || null;
  } catch { return null; }
}
/** slug → { id, canonical } (canonical = the primary slug when `slug` is an alias); null = unknown here */
export function idOfSlug(sport: LinkSport, kind: LinkKind, slug: string): { id: string; canonical: string } | null {
  const st = states.get(sport);
  const hit = st?.map.get(`s:${kind}/${slug}`);
  if (hit) { const sp = hit.indexOf(' '); return sp < 0 ? { id: hit, canonical: slug } : { id: hit.slice(0, sp), canonical: hit.slice(sp + 1) }; }
  if (isWeb) return null;
  try {
    const r: any = qSlug().get(sport, kind, slug);
    if (!r) return null;
    if (r.is_primary) return { id: String(r.id), canonical: slug };
    const p: any = qPrimary().get(sport, kind, r.id);
    return { id: String(r.id), canonical: p?.slug || slug };
  } catch { return null; }
}

/** the new address of an item, null when it has no slug (yet) */
export function publicPathOf(sport: LinkSport, kind: LinkKind, id: string | number | null | undefined): string | null {
  const s = slugOf(sport, kind, id);
  return s ? `/${sport}/${kind}/${s}` : null;
}
/**
 * any address of ours → the address links should use: an old one (id) becomes its slug address (language prefix
 * kept, the old query dropped except ALLOWED_QUERY); anything else, or an item without a slug, comes back unchanged.
 */
export function pubPath(href: string): string {
  const m = /^(https:\/\/sportlikely\.com)?(\/(?:es|pt|de|fr|it|tr))?(\/[^?#]*)(\?[^#]*)?(#.*)?$/.exec(href);
  if (!m) return href;
  const old = parseOld(m[3]);
  if (!old) {
    // fix235: an old sport page (/matches, /predictions/today, /basketball/games …) → /<sport>/<page>
    const mv = movedPage(m[3]);
    return mv ? `${m[1] || ''}${m[2] || ''}${mv}${keptQuery(m[4] || '')}` : href;
  }
  const to = publicPathOf(old.sport, old.kind, old.id);
  if (!to) return href;
  return `${m[1] || ''}${m[2] || ''}${to}${keptQuery(m[4] || '')}${m[5] || ''}`;
}
/** href="…" / href='…' / "url":"…" of old addresses inside HTML or JSON-LD text → new ones */
export function pubLinks(html: string): string {
  return html.replace(/(href=["']|"url":"|"@id":")((?:https:\/\/sportlikely\.com)?(?:\/(?:es|pt|de|fr|it|tr))?\/(?:(?:team|match|player|league|basketball|american-football|tennis|predictions)\/[^"'#\s]*|(?:matches|favorites|my-picks|upset-watch|draw-alerts|accuracy|past)(?=[?"'#\s])[^"'#\s]*))/g,
    (_a, pre: string, url: string) => pre + pubPath(url.replace(/&amp;/g, '&')).replace(/&(?!amp;)/g, '&amp;'));
}
function keptQuery(qs: string): string {
  if (!qs || qs === '?') return '';
  const p = new URLSearchParams(qs.slice(1)), out = new URLSearchParams();
  for (const [k, v] of p) if ((ALLOWED_QUERY as readonly string[]).includes(k)) out.append(k, v);
  const s = out.toString();
  return s ? `?${s}` : '';
}

/* ---------- what an address request gets (the catch-all page route in app.ts) ---------- */

export type LinkAnswer =
  | { to: string } // 301 to the new address
  | { search: string } // unknown slug: the search page with its words
  | { page: { sport: LinkSport; kind: LinkKind; id: string; slug: string } } // a new address: this item
  | { ask: true } // not in the web state: the worker knows (or not)
  | null; // not an item address

/**
 * `path` = the request path (language prefix allowed), `query` = the raw query (old football team links carry
 * ?c=<league>&n=<name>, used to find the team when its id is not known yet).
 */
export function linkAnswer(path: string, query = ''): LinkAnswer {
  const lm = new RegExp(`^${LANG_RE}(\\/.*)$`).exec(path);
  const lang = lm?.[1] ? `/${lm[1]}` : '';
  let rest = (lm?.[2] || path).replace(/\/+$/, '') || '/';
  const kept = keptQuery(query);
  // fix235: a tab is a sub-path (/football/match/<slug>/stats); a sub-path that is not a tab of the page → the page
  const tb = splitTab(rest);
  if (tb && parseNew(tb.base)) {
    if (!tb.tab) return { to: `${lang}${tb.base}${kept}` };
    rest = tb.base;
  }
  const sub = tb?.tab ? `/${tb.tab}` : '';
  const nw = parseNew(rest);
  if (nw) {
    // NFL standings: /american-football/league/nfl … are not ids; an upper-case basketball code is an old address
    const hit = idOfSlug(nw.sport, nw.kind, nw.slug);
    if (hit) {
      if (hit.canonical !== nw.slug) return { to: `${lang}/${nw.sport}/${nw.kind}/${hit.canonical}${sub}${kept}` };
      return { page: { sport: nw.sport, kind: nw.kind, id: hit.id, slug: nw.slug } };
    }
    if (isWeb) return { ask: true };
    const m = nw.kind === 'match' ? matchBySlugParts(nw.sport, nw.slug) : null;
    if (m) return { to: `${lang}/${nw.sport}/match/${m}${sub}${kept}` };
    return { search: `${lang}/search?q=${encodeURIComponent(nw.slug.replace(/-vs-/, ' ').replace(/-\d{4}-\d{2}-\d{2}(-\d)?$/, '').replace(/-/g, ' '))}` };
  }
  const old = parseOld(rest);
  if (!old) {
    const mv = movedPage(rest); // fix235: /matches → /football/matches, /basketball/games → /basketball/matches …
    return mv ? { to: `${lang}${mv}${kept}` } : null;
  }
  let id = old.id;
  if (old.sport === 'football' && old.kind === 'league') id = MERGED_FB_LEAGUES[id.toUpperCase()] || id.toUpperCase();
  let s = slugOf(old.sport, old.kind, id);
  if (!s && !isWeb && old.sport === 'football' && old.kind === 'team') s = fdTeamSlug(Number(id), new URLSearchParams(query.replace(/^\?/, '')));
  if (s) return { to: `${lang}/${old.sport}/${old.kind}/${s}${kept}` };
  // fix238: the web holds every id once the sport's state + id index are loaded: an id not there has no slug (yet) —
  // no worker round trip (old football team links with a Football-Data.org id still ask: the worker matches the name)
  if (isWeb && states.has(old.sport) && (old.kind === 'team' || old.kind === 'league' || idIndexes.has(old.sport)) && !(old.sport === 'football' && old.kind === 'team')) return null;
  return isWeb ? { ask: true } : null;
}
/** fix238: an old (id) address of any sport, any language — the page route never builds one before answering */
export function isOldAddress(path: string): boolean {
  const lm = new RegExp(`^${LANG_RE}(\\/.*)$`).exec(path);
  return !!parseOld((lm?.[2] || path).replace(/\/+$/, '') || '/');
}
/** Football-Data.org codes that live under another code (fix176) */
const MERGED_FB_LEAGUES: Record<string, string> = { BSA: 'AF71' };
/** an old football team link with a Football-Data.org id: the team page's own lookup (league + name) */
function fdTeamSlug(fdId: number, sp: URLSearchParams): string | null {
  if (!Number.isFinite(fdId) || fdId <= 0 || fdId >= AF) return null;
  try {
    const { resolveAfTeamId } = require('./teamPage') as typeof import('./teamPage');
    const af = resolveAfTeamId(fdId, sp.get('c') || undefined, sp.get('n') || undefined);
    if (!af) return null;
    const s = slugOf('football', 'team', AF + af);
    if (s) try { db.prepare(`INSERT OR REPLACE INTO slug_ids (sport, kind, old_id, id) VALUES ('football', 'team', ?, ?)`).run(String(fdId), String(AF + af)); } catch { /* read-only copy */ }
    return s;
  } catch { return null; }
}
/**
 * worker: a match slug we never gave (a link drawn from short names: "chiefs-vs-bills-2026-10-26", sides swapped):
 * the day's matches whose two sides contain those words, either order; the best fit when there is exactly one
 */
function matchBySlugParts(sport: LinkSport, slug: string): string | null {
  const p = parseMatchSlug(slug);
  if (!p?.day) return null;
  let rows: any[] = [];
  try { rows = db.prepare(`SELECT slug FROM slugs WHERE sport = ? AND kind = 'match' AND is_primary = 1 AND slug LIKE ?`).all(sport, `%-vs-%-${p.day}%`) as any[]; } catch { return null; }
  const words = (x: string) => x.split('-').filter(w => w.length > 1 && w !== 'fc');
  const fits = (side: string, want: string) => { const w = words(want); return w.length > 0 && w.every(x => side.split('-').includes(x)); };
  const hits = rows.map(r => ({ slug: r.slug as string, m: parseMatchSlug(r.slug) })).filter(x => x.m && x.m.day === p.day && x.m.n === p.n)
    .filter(x => (fits(x.m!.home, p.home) && fits(x.m!.away, p.away)) || (fits(x.m!.home, p.away) && fits(x.m!.away, p.home)));
  return hits.length === 1 ? hits[0].slug : null;
}

/* ---------- building (worker) ---------- */

type Loaded = { rows: SlugRow[]; matchSlugs: Set<string>; matchIds: Set<string> };
function loadRows(sport: LinkSport, kind: LinkKind): SlugRow[] {
  return (db.prepare(`SELECT slug, id, is_primary, base FROM slugs WHERE sport = ? AND kind = ?`).all(sport, kind) as any[])
    .map(r => ({ slug: r.slug, id: String(r.id), primary: !!r.is_primary, base: r.base }));
}
function write(sport: LinkSport, kind: LinkKind, add: SlugRow[], demote: string[] = [], promote: SlugRow[] = []) {
  if (!add.length && !demote.length && !promote.length) return;
  const at = new Date().toISOString();
  const ins = db.prepare(`INSERT OR IGNORE INTO slugs (sport, kind, slug, id, is_primary, base, at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const dem = db.prepare(`UPDATE slugs SET is_primary = 0 WHERE sport = ? AND kind = ? AND slug = ?`);
  const pro = db.prepare(`UPDATE slugs SET is_primary = 1, base = ? WHERE sport = ? AND kind = ? AND slug = ?`);
  db.exec('BEGIN');
  try {
    for (const s of demote) dem.run(sport, kind, s);
    for (const r of promote) pro.run(r.base, sport, kind, r.slug);
    for (const r of add) ins.run(sport, kind, r.slug, r.id, r.primary ? 1 : 0, r.base, at);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
function writeIds(sport: LinkSport, kind: LinkKind, pairs: [string, string][]) {
  if (!pairs.length) return;
  const ins = db.prepare(`INSERT OR REPLACE INTO slug_ids (sport, kind, old_id, id) VALUES (?, ?, ?, ?)`);
  db.exec('BEGIN');
  try { for (const [o, i] of pairs) if (o !== i) ins.run(sport, kind, o, i); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
}
const all = (sql: string, ...args: any[]): any[] => { try { return db.prepare(sql).all(...args) as any[]; } catch { return []; } };
const daysAgo = (d: number) => new Date(Date.now() - d * 86400000).toISOString();

/** fixed league slugs (the names people know; the rest come from the league's name) */
const FB_LEAGUE_FIXED: Record<string, string> = {
  PL: 'premier-league', ELC: 'championship', PD: 'la-liga', SA: 'serie-a', BL1: 'bundesliga', FL1: 'ligue-1', DED: 'eredivisie',
  PPL: 'primeira-liga', CL: 'champions-league', EC: 'european-championship', WC: 'world-cup', CLI: 'copa-libertadores'
};
const FB_LEAGUE_COUNTRY: Record<string, string> = { PL: 'England', ELC: 'England', PD: 'Spain', SA: 'Italy', BL1: 'Germany', FL1: 'France', DED: 'Netherlands', PPL: 'Portugal', BSA: 'Brazil' };
/** the API-Football code of a Football-Data.org league (frontend League.tsx FD_OF) */
const FB_LEAGUE_TWINS: Record<string, string> = { AF39: 'PL', AF40: 'ELC', AF140: 'PD', AF135: 'SA', AF78: 'BL1', AF61: 'FL1', AF88: 'DED', AF94: 'PPL', AF2: 'CL', BSA: 'AF71' };

type Built = { teams: Map<string, string>; names: Map<string, string[]>; aliasIds: Map<string, string> };

/** football: leagues, teams (API-Football ids; Football-Data.org ids → their club), players, matches */
async function buildFootball(step: () => Promise<void>, full: boolean) {
  const sport: LinkSport = 'football';
  // leagues
  const lg = new Map<string, SlugEntity>();
  let comps: any[] = [];
  try { comps = (require('./afMatches') as typeof import('./afMatches')).afCompetitions(); } catch { /* not loaded */ }
  const countryOfLeague = new Map<number, string>();
  for (const c of comps) {
    const id = Number(String(c.code).slice(2));
    if (c.area?.name) countryOfLeague.set(id, c.area.name);
    if (!FB_LEAGUE_TWINS[c.code]) lg.set(c.code, { id: c.code, name: c.name, weight: 10, country: c.area?.name || null });
  }
  for (const r of all(`SELECT competition_code AS code, MAX(competition_name) AS name, COUNT(*) AS n FROM predictions WHERE competition_code IS NOT NULL GROUP BY competition_code`)) {
    const code = String(r.code).toUpperCase();
    if (FB_LEAGUE_TWINS[code] || !r.name) continue;
    const e = lg.get(code);
    if (e) { e.weight += r.n; continue; }
    lg.set(code, { id: code, name: r.name, weight: r.n + (FB_LEAGUE_FIXED[code] ? 1e9 : 0), country: FB_LEAGUE_COUNTRY[code] || null, fixed: FB_LEAGUE_FIXED[code] || null });
  }
  for (const [code, slug] of Object.entries(FB_LEAGUE_FIXED)) { const e = lg.get(code); if (e) { e.fixed = slug; e.weight += 1e9; } }
  const lr = assignSlugs('league', loadRows(sport, 'league'), [...lg.values()]);
  write(sport, 'league', lr.add, lr.demote, lr.promote);
  writeIds(sport, 'league', Object.entries(FB_LEAGUE_TWINS));
  await step();

  // teams: every club / national team with a game in the last 3 years (the team page's own index)
  const teams = new Map<string, SlugEntity & { leagues: Map<number, number> }>();
  const since = daysAgo(3 * 365).slice(0, 10);
  for (const [table, national] of [['af_fixtures', false], ['eur_matches', false], ['nat_matches', true]] as const) {
    const rows = all(`SELECT home_id AS id, home_name AS name, league_id AS lg FROM ${table} WHERE date >= ? UNION ALL SELECT away_id, away_name, league_id FROM ${table} WHERE date >= ?1`, since);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r.id || !r.name) continue;
      const id = String(AF + r.id);
      let t = teams.get(id);
      if (!t) { t = { id, name: r.name, names: [], weight: 0, country: national ? null : null, leagues: new Map() }; teams.set(id, t); }
      t.weight++;
      if (t.name !== r.name && !t.names!.includes(r.name)) t.names!.push(r.name);
      if (!national && r.lg) t.leagues.set(r.lg, (t.leagues.get(r.lg) || 0) + 1);
      if (i % 2000 === 1999) await step();
    }
  }
  for (const t of teams.values()) {
    const top = [...t.leagues.entries()].sort((a, b) => b[1] - a[1]).find(([l]) => countryOfLeague.has(l) && !['World', 'Europe'].includes(countryOfLeague.get(l)!));
    t.country = top ? countryOfLeague.get(top[0])! : null;
  }
  // Football-Data.org ids: the team page's stored resolution (team_resolve) → the club; their names are aliases
  const fdPairs: [string, string][] = [];
  const fdNames = new Map<string, string[]>();
  for (const r of all(`SELECT fd_id, af_id FROM team_resolve`)) fdPairs.push([String(r.fd_id), String(AF + r.af_id)]);
  for (const r of all(`SELECT home_team_id AS id, home_team AS n FROM predictions WHERE home_team_id < ${AF} GROUP BY home_team_id, home_team UNION SELECT away_team_id, away_team FROM predictions WHERE away_team_id < ${AF} GROUP BY away_team_id, away_team`)) {
    if (!r.id || !r.n) continue;
    const k = String(r.id);
    fdNames.set(k, [...(fdNames.get(k) || []), r.n]);
  }
  // the Football-Data.org teams of the last two years the team page never opened: found the way the page finds them
  const done = new Set(fdPairs.map(p => p[0]));
  try {
    const { resolveAfTeamId } = require('./teamPage') as typeof import('./teamPage');
    for (const r of all(`SELECT home_team_id AS id, MAX(home_team) AS n, MAX(competition_code) AS c FROM predictions WHERE home_team_id < ${AF} AND utc_date >= ? GROUP BY home_team_id`, daysAgo(730))) {
      if (!r.id || done.has(String(r.id))) continue;
      const af = resolveAfTeamId(Number(r.id), r.c || undefined, r.n || undefined);
      if (af) { fdPairs.push([String(r.id), String(AF + af)]); done.add(String(r.id)); }
      await step();
    }
  } catch { /* team index not loaded yet: next run */ }
  const fdTo = new Map(fdPairs);
  for (const [fd, af] of fdPairs) { const t = teams.get(af); if (t) { t.weight += 500; for (const n of fdNames.get(fd) || []) if (!t.names!.includes(n)) t.names!.push(n); } }
  // a Football-Data.org team the team page never opened: its own item until it does (rare: top leagues are resolved)
  for (const [fd, ns] of fdNames) if (!fdTo.has(fd) && !teams.has(fd)) teams.set(fd, { id: fd, name: ns[0], names: ns.slice(1), weight: 1, country: null, leagues: new Map() });
  const tr = assignSlugs('team', loadRows(sport, 'team'), [...teams.values()]);
  write(sport, 'team', tr.add, tr.demote, tr.promote);
  writeIds(sport, 'team', fdPairs);
  await step();

  // players (API-Football ids): the latest season's club; the full name when the player page was built
  const players = new Map<string, SlugEntity>();
  const span: any = (all(`SELECT MIN(player_id) AS lo, MAX(player_id) AS hi, MAX(season) AS s FROM af_player_season`)[0]) || {};
  if (span.hi != null) {
    const stmt = db.prepare(`SELECT player_id, name, team_id, season, SUM(COALESCE(minutes, 0)) AS m, SUM(COALESCE(apps, 0)) AS a, MAX(age) AS age FROM af_player_season WHERE season >= ? AND player_id >= ? AND player_id < ? GROUP BY player_id, team_id, season`);
    for (let lo = span.lo; lo <= span.hi; lo += 2000) {
      for (const r of stmt.all(span.s - 2, lo, lo + 2000) as any[]) {
        if (!r.name) continue;
        const id = String(r.player_id), p = players.get(id) as any;
        if (!p || r.season > p._s || (r.season === p._s && r.m > p._m)) players.set(id, { id, name: r.name, names: [], weight: (p?.weight || 0) + (r.a || 0), team: String(AF + r.team_id), year: r.age ? r.season - r.age : null, _s: r.season, _m: r.m } as any);
        else p.weight += r.a || 0;
      }
      await step();
    }
    for (let after = 0; ;) {
      const rows = all(`SELECT rowid AS rid, player_id, json_extract(json, '$.player.name') AS short, json_extract(json, '$.player.firstname') AS f, json_extract(json, '$.player.lastname') AS l FROM player_page_store WHERE rowid > ? ORDER BY rowid LIMIT 500`, after);
      if (!rows.length) break;
      for (const r of rows) {
        const p = players.get(String(r.player_id));
        if (!p) continue;
        // the page's display name: "Erling Haaland" (first first name + last name) for an initial like "E. Haaland"
        const display = /^[A-Z]\.\s/.test(r.short || '') && r.f && r.l ? `${String(r.f).split(' ')[0]} ${r.l}` : (r.short || p.name);
        if (display !== p.name) { p.names!.push(p.name); p.name = display; }
      }
      after = rows[rows.length - 1].rid;
      await step();
    }
  }
  const teamSlugs = slugMap(sport, 'team');
  for (const p of players.values()) p.team = p.team ? teamSlugs.get(p.team) || null : null;
  const pr = assignSlugs('player', loadRows(sport, 'player'), [...players.values()]);
  write(sport, 'player', pr.add, pr.demote, pr.promote);
  writeIds(sport, 'player', all(`SELECT dup_id, main_id FROM player_twins`).map(r => [String(r.dup_id), String(r.main_id)] as [string, string]));
  await step();

  // matches: every match we predicted (Football-Data.org / API-Football twin ids) + every API-Football fixture
  const twinPairs = all(`SELECT fd_id, af_id FROM fd_af_links`).map(r => [String(AF + r.af_id), String(r.fd_id)] as [string, string]);
  writeIds(sport, 'match', twinPairs);
  const twinOf = new Set(twinPairs.map(p => p[0]));
  const fdTeam = (id: number | null, name: string) => {
    if (id == null) return teamSlug(name);
    const k = String(id);
    return teamSlugs.get(fdTo.get(k) || k) || teamSlug(name);
  };
  await buildMatches(sport, step, full, async (from, to) => {
    const out: MatchEntity[] = [];
    for (const r of all(`SELECT match_id, MAX(utc_date) AS d, MAX(home_team_id) AS hid, MAX(home_team) AS h, MAX(away_team_id) AS aid, MAX(away_team) AS a FROM predictions WHERE utc_date >= ? AND utc_date < ? GROUP BY match_id`, from, to))
      if (r.h && r.a) out.push({ id: String(r.match_id), home: fdTeam(r.hid, r.h), away: fdTeam(r.aid, r.a), date: r.d });
    for (const r of all(`SELECT fixture_id, kickoff, home_id, home_name, away_id, away_name FROM af_fixtures WHERE kickoff >= ? AND kickoff < ?`, from, to)) {
      const id = String(AF + r.fixture_id);
      if (twinOf.has(id)) continue;
      out.push({ id, home: teamSlugs.get(String(AF + r.home_id)) || teamSlug(r.home_name), away: teamSlugs.get(String(AF + r.away_id)) || teamSlug(r.away_name), date: r.kickoff });
    }
    return out;
  });
}

/** basketball: leagues (BB_LEAGUES + leagues added from admin), teams, players, games */
async function buildBasketball(step: () => Promise<void>, full: boolean) {
  const sport: LinkSport = 'basketball';
  let leagues: { code: string; name: string; country: string }[] = [];
  try { leagues = (require('./basketball') as typeof import('./basketball')).BB_LEAGUES; } catch { /* not loaded */ }
  const country = new Map(leagues.map(l => [l.code, l.country]));
  const lr = assignSlugs('league', loadRows(sport, 'league'), leagues.map((l, i) => ({ id: l.code, name: l.name, weight: 1000 - i, country: l.country })));
  write(sport, 'league', lr.add, lr.demote, lr.promote);
  const teams = new Map<string, SlugEntity & { by: Map<string, number> }>();
  for (const r of all(`SELECT home_id AS id, home_name AS name, code FROM bb_games WHERE kickoff >= ? UNION ALL SELECT away_id, away_name, code FROM bb_games WHERE kickoff >= ?1`, daysAgo(3 * 365))) {
    if (!r.id || !r.name) continue;
    const id = String(r.id);
    let t = teams.get(id);
    if (!t) { t = { id, name: r.name, names: [], weight: 0, by: new Map() }; teams.set(id, t); }
    t.weight++;
    t.by.set(r.code, (t.by.get(r.code) || 0) + 1);
    if (t.name !== r.name && !t.names!.includes(r.name)) t.names!.push(r.name);
  }
  for (const t of teams.values()) {
    const c = [...t.by.entries()].sort((a, b) => b[1] - a[1]).map(([code]) => country.get(code)).find(x => x && x !== 'Europe' && x !== 'World');
    t.country = c || null;
  }
  await step();
  const tr = assignSlugs('team', loadRows(sport, 'team'), [...teams.values()]);
  write(sport, 'team', tr.add, tr.demote, tr.promote);
  const teamSlugs = slugMap(sport, 'team');
  const players = new Map<string, SlugEntity>();
  for (const r of all(`SELECT ps.player_id AS id, MAX(ps.name) AS name, COUNT(*) AS n, MAX(g.kickoff) AS d, ps.team_id AS team FROM bb_player_stats ps JOIN bb_games g ON g.game_id = ps.game_id WHERE g.kickoff >= ? GROUP BY ps.player_id, ps.team_id`, daysAgo(2 * 365))) {
    if (!r.name) continue;
    const id = String(r.id), p = players.get(id) as any;
    if (!p || r.d > p._d) players.set(id, { id, name: r.name, weight: (p?.weight || 0) + r.n, team: teamSlugs.get(String(r.team)) || null, _d: r.d } as any);
    else p.weight += r.n;
  }
  await step();
  const pr = assignSlugs('player', loadRows(sport, 'player'), [...players.values()]);
  write(sport, 'player', pr.add, pr.demote, pr.promote);
  await buildMatches(sport, step, full, async (from, to) =>
    all(`SELECT game_id, kickoff, home_id, home_name, away_id, away_name FROM bb_games WHERE kickoff >= ? AND kickoff < ?`, from, to)
      .map(r => ({ id: String(r.game_id), home: teamSlugs.get(String(r.home_id)) || teamSlug(r.home_name), away: teamSlugs.get(String(r.away_id)) || teamSlug(r.away_name), date: r.kickoff })));
}

/** American football: NFL + college (leagues nfl / college-football), teams, players, games */
async function buildNfl(step: () => Promise<void>, full: boolean) {
  const sport: LinkSport = 'american-football';
  const lr = assignSlugs('league', loadRows(sport, 'league'), [
    { id: '1', name: 'NFL', weight: 2, fixed: 'nfl' }, { id: '2', name: 'College football', weight: 1, fixed: 'college-football' }]);
  write(sport, 'league', lr.add, lr.demote, lr.promote);
  const gamesOf = new Map<string, number>();
  for (const r of all(`SELECT id, COUNT(*) AS n FROM (SELECT home_id AS id FROM nfl_games UNION ALL SELECT away_id FROM nfl_games) GROUP BY id`)) gamesOf.set(String(r.id), r.n);
  const teams: SlugEntity[] = all(`SELECT team_id, name, league, level FROM nfl_teams`).filter(r => r.name)
    .map(r => ({ id: String(r.team_id), name: r.name, weight: (gamesOf.get(String(r.team_id)) || 0) + (r.league === 1 ? 10000 : r.level === 'FBS' ? 1000 : 0), country: r.league === 1 ? 'nfl' : String(r.level || 'college').toLowerCase() }));
  const tr = assignSlugs('team', loadRows(sport, 'team'), teams);
  write(sport, 'team', tr.add, tr.demote, tr.promote);
  const teamSlugs = slugMap(sport, 'team');
  await step();
  const players: SlugEntity[] = all(`SELECT player_id, name, team_id, age, season FROM nfl_players`).filter(r => r.name)
    .map(r => ({ id: String(r.player_id), name: r.name, weight: r.season || 0, team: teamSlugs.get(String(r.team_id)) || null, year: r.age && r.season ? r.season - r.age : null }));
  const pr = assignSlugs('player', loadRows(sport, 'player'), players);
  write(sport, 'player', pr.add, pr.demote, pr.promote);
  await buildMatches(sport, step, full, async (from, to) =>
    all(`SELECT game_id, kickoff, home_id, home_name, away_id, away_name FROM nfl_games WHERE kickoff >= ? AND kickoff < ?`, from, to)
      .filter(r => r.home_name && r.away_name)
      .map(r => ({ id: String(r.game_id), home: teamSlugs.get(String(r.home_id)) || teamSlug(r.home_name), away: teamSlugs.get(String(r.away_id)) || teamSlug(r.away_name), date: r.kickoff })));
}

/** tennis: tournaments (their keys are slugs already), players, matches */
async function buildTennis(step: () => Promise<void>, full: boolean) {
  const sport: LinkSport = 'tennis';
  let slugOfT: ((tour: string | null, tier: string | null, name: string | null, source?: string) => string) | null = null;
  try { slugOfT = (require('./tennisSite') as typeof import('./tennisSite')).slugOf; } catch { /* not loaded */ }
  if (slugOfT) {
    const keys = new Map<string, SlugEntity>();
    for (const r of all(`SELECT tour, tier, tournament, MAX(source) AS source, COUNT(*) AS n FROM tennis_matches WHERE scheduled_at >= ? AND tournament IS NOT NULL GROUP BY tour, tier, tournament`, daysAgo(3 * 365))) {
      const k = slugOfT(r.tour, r.tier, r.tournament, r.source || 'live');
      const e = keys.get(k);
      if (e) e.weight += r.n; else keys.set(k, { id: k, name: r.tournament, weight: r.n, fixed: k });
    }
    const lr = assignSlugs('league', loadRows(sport, 'league'), [...keys.values()]);
    write(sport, 'league', lr.add, lr.demote, lr.promote);
  }
  await step();
  const players: SlugEntity[] = all(`SELECT id, name, country, dob, ranking FROM tennis_players`).filter(r => r.name)
    .map(r => ({ id: String(r.id), name: r.name, weight: r.ranking ? 100000 - r.ranking : 0, country: r.country || null, year: r.dob ? String(r.dob).slice(0, 4) : null }));
  const pr = assignSlugs('player', loadRows(sport, 'player'), players);
  write(sport, 'player', pr.add, pr.demote, pr.promote);
  writeIds(sport, 'match', all(`SELECT old_id, new_id FROM tennis_id_moves`).map(r => [String(r.old_id), String(r.new_id)] as [string, string]));
  const ps = slugMap(sport, 'player');
  await buildMatches(sport, step, full, async (from, to) =>
    all(`SELECT id, scheduled_at, p1_id, p1_name, p2_id, p2_name FROM tennis_matches WHERE scheduled_at >= ? AND scheduled_at < ?`, from, to)
      .filter(r => r.p1_name && r.p2_name)
      .map(r => ({ id: String(r.id), home: ps.get(String(r.p1_id)) || playerSlug(r.p1_name), away: ps.get(String(r.p2_id)) || playerSlug(r.p2_name), date: r.scheduled_at })));
}

/** id → primary slug of a kind (the build's own lookups) */
function slugMap(sport: LinkSport, kind: LinkKind): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of all(`SELECT id, slug FROM slugs WHERE sport = ? AND kind = ? AND is_primary = 1`, sport, kind)) m.set(String(r.id), r.slug);
  for (const r of all(`SELECT old_id, id FROM slug_ids WHERE sport = ? AND kind = ?`, sport, kind)) { const s = m.get(String(r.id)); if (s && !m.has(String(r.old_id))) m.set(String(r.old_id), s); }
  return m;
}

/** matches month by month (new ones only: a match keeps its slug), from the first game we hold to 60 days ahead */
async function buildMatches(sport: LinkSport, step: () => Promise<void>, full: boolean, rowsOf: (from: string, to: string) => Promise<MatchEntity[]>) {
  const have = new Set<string>(), slugs = new Set<string>();
  for (const r of all(`SELECT slug, id FROM slugs WHERE sport = ? AND kind = 'match'`, sport)) { have.add(String(r.id)); slugs.add(r.slug); }
  const end = new Date(Date.now() + 60 * 86400000);
  // the full pass from 2015 (the first one, then every 6 hours: late-added old games); else the last 90 days on
  const back = new Date(Date.now() - 90 * 86400000);
  let cur = full || !have.size ? new Date(Date.UTC(2015, 0, 1)) : new Date(Date.UTC(back.getUTCFullYear(), back.getUTCMonth(), 1));
  while (cur < end) {
    const next = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
    const rows = (await rowsOf(cur.toISOString(), next.toISOString())).filter(r => !have.has(r.id));
    if (rows.length) write(sport, 'match', assignMatchSlugs(slugs, rows));
    for (const r of rows) have.add(r.id);
    cur = next;
    await step();
  }
}

/* ---------- the state each sport publishes (web lookups + the app's exception list) ---------- */

const WINDOW_BACK = 60, WINDOW_AHEAD = 30;
async function publishSport(sport: LinkSport, step: () => Promise<void>) {
  const map = new Map<string, string>();
  const put = (kind: LinkKind, rows: any[]) => {
    const prim = new Map<string, string>();
    for (const r of rows) if (r.is_primary) prim.set(String(r.id), r.slug);
    for (const r of rows) {
      const id = String(r.id);
      map.set(`s:${kind}/${r.slug}`, r.is_primary ? id : `${id} ${prim.get(id) || r.slug}`);
      if (r.is_primary) map.set(`i:${kind}/${id}`, r.slug);
    }
    return prim;
  };
  const client: Record<string, Record<string, string>> = { l: {}, t: {}, m: {} };
  const clientP: Record<string, string> = {};
  // leagues + teams: all
  const lp = put('league', all(`SELECT slug, id, is_primary FROM slugs WHERE sport = ? AND kind = 'league'`, sport));
  for (const [id, s] of lp) client.l[id] = s;
  const tp = put('team', all(`SELECT slug, id, is_primary FROM slugs WHERE sport = ? AND kind = 'team'`, sport));
  await step();
  // players: the ones of this and last season (others are asked of the worker)
  const recent = recentPlayers(sport);
  const pRows = all(`SELECT slug, id, is_primary FROM slugs WHERE sport = ? AND kind = 'player'`, sport).filter(r => !recent || recent.has(String(r.id)));
  const pp = put('player', pRows);
  await step();
  // matches of the window
  const mIds = matchIdsInWindow(sport);
  const mRows = mIds.size ? all(`SELECT slug, id, is_primary FROM slugs WHERE sport = ? AND kind = 'match'`, sport).filter(r => mIds.has(String(r.id))) : [];
  const mp = put('match', mRows);
  await step();
  // other ids of the same item (old / twin ids): they 301 too
  for (const r of all(`SELECT kind, old_id, id FROM slug_ids WHERE sport = ?`, sport)) {
    const prim = r.kind === 'team' ? tp : r.kind === 'player' ? pp : r.kind === 'match' ? mp : lp;
    const s = prim.get(String(r.id));
    if (s) map.set(`i:${r.kind}/${r.old_id}`, s);
    if (s && r.kind === 'league') client.l[String(r.old_id)] = s;
  }
  // the app's exceptions: an item whose slug is not what the rules make of the name the app shows
  const names = nameRows(sport);
  for (const [id, ns] of names.team) { const s = map.get(`i:team/${id}`); if (s && ns.some(n => teamSlug(n) !== s)) client.t[id] = s; }
  for (const [id, ns] of names.player) { const s = map.get(`i:player/${id}`); if (s && ns.some(n => playerSlug(n) !== s)) clientP[id] = s; }
  const side = (id: string | null, n: string) => (id && client.t[id]) || (sport === 'tennis' ? (id && clientP[id]) || playerSlug(n) : teamSlug(n));
  for (const r of names.match) { const s = map.get(`i:match/${r.id}`); if (s && s !== matchSlug(side(r.hid, r.h), side(r.aid, r.a), r.d)) client.m[r.id] = s; }
  await step();
  const st: SlugState = { sport, builtAt: Date.now(), map, client: JSON.stringify({ v: 1, ...client }), clientPlayers: JSON.stringify({ v: 1, p: clientP }) };
  states.set(sport, st);
  applyState(`slugs:${sport}`, st);
  await step();
  // fix238: every match and player (all seasons) + their old / twin ids → the id index the web answers old links from
  const chunks: IdChunk[] = [];
  let entries = 0;
  for (const kind of ['match', 'player'] as const) {
    const prim = new Map<string, string>();
    for (const r of all(`SELECT id, slug FROM slugs WHERE sport = ? AND kind = ? AND is_primary = 1`, sport, kind)) prim.set(String(r.id), r.slug);
    await step();
    for (const r of all(`SELECT old_id, id FROM slug_ids WHERE sport = ? AND kind = ?`, sport, kind)) { const s = prim.get(String(r.id)); if (s && !prim.has(String(r.old_id))) prim.set(String(r.old_id), s); }
    const pairs: [number, string][] = [];
    for (const [id, s] of prim) if (/^-?\d+$/.test(id)) pairs.push([Number(id), s]);
    entries += pairs.length;
    chunks.push(...idChunks(kind, pairs));
    await step();
  }
  const ix: IdIndex = { sport, builtAt: Date.now(), entries, chunks };
  idIndexes.set(sport, ix);
  applyState(`slugs-ids:${sport}`, ix);
}
function recentPlayers(sport: LinkSport): Set<string> | null {
  if (sport === 'football') { const s = all(`SELECT MAX(season) AS s FROM af_player_season`)[0]?.s; return s ? new Set(all(`SELECT DISTINCT player_id AS id FROM af_player_season WHERE season >= ?`, s - 1).map(r => String(r.id))) : new Set(); }
  if (sport === 'basketball') return new Set(all(`SELECT DISTINCT ps.player_id AS id FROM bb_player_stats ps JOIN bb_games g ON g.game_id = ps.game_id WHERE g.kickoff >= ?`, daysAgo(400)).map(r => String(r.id)));
  return null; // NFL rosters and tennis players: all (a few thousand)
}
const MATCH_SQL: Record<LinkSport, string> = {
  football: `SELECT DISTINCT match_id AS id FROM predictions WHERE utc_date >= ? AND utc_date < ? UNION SELECT ${AF} + fixture_id FROM af_fixtures WHERE kickoff >= ?1 AND kickoff < ?2`,
  basketball: `SELECT game_id AS id FROM bb_games WHERE kickoff >= ? AND kickoff < ?`,
  'american-football': `SELECT game_id AS id FROM nfl_games WHERE kickoff >= ? AND kickoff < ?`,
  tennis: `SELECT id FROM tennis_matches WHERE scheduled_at >= ? AND scheduled_at < ?`
};
function matchIdsInWindow(sport: LinkSport): Set<string> {
  return new Set(all(MATCH_SQL[sport], daysAgo(WINDOW_BACK), daysAgo(-WINDOW_AHEAD)).map(r => String(r.id)));
}
/** the names the app shows for teams / players / the window's matches (each id with every name it had) */
function nameRows(sport: LinkSport) {
  const team = new Map<string, string[]>(), player = new Map<string, string[]>();
  const add = (m: Map<string, string[]>, id: unknown, n: unknown) => { if (id == null || !n) return; const k = String(id), a = m.get(k) || []; if (!a.includes(String(n))) a.push(String(n)); m.set(k, a); };
  const match: { id: string; hid: string | null; h: string; aid: string | null; a: string; d: string }[] = [];
  const from = daysAgo(WINDOW_BACK), to = daysAgo(-WINDOW_AHEAD);
  if (sport === 'football') {
    for (const r of all(`SELECT match_id AS id, MAX(utc_date) AS d, MAX(home_team_id) AS hid, MAX(home_team) AS h, MAX(away_team_id) AS aid, MAX(away_team) AS a FROM predictions WHERE utc_date >= ? AND utc_date < ? GROUP BY match_id`, from, to)) {
      add(team, r.hid, r.h); add(team, r.aid, r.a); if (r.h && r.a) match.push({ id: String(r.id), hid: r.hid != null ? String(r.hid) : null, h: r.h, aid: r.aid != null ? String(r.aid) : null, a: r.a, d: r.d });
    }
    for (const r of all(`SELECT fixture_id, kickoff, home_id, home_name, away_id, away_name FROM af_fixtures WHERE kickoff >= ? AND kickoff < ?`, from, to)) {
      add(team, AF + r.home_id, r.home_name); add(team, AF + r.away_id, r.away_name);
      match.push({ id: String(AF + r.fixture_id), hid: String(AF + r.home_id), h: r.home_name, aid: String(AF + r.away_id), a: r.away_name, d: r.kickoff });
    }
    for (const r of all(`SELECT home_id AS id, home_name AS n FROM af_fixtures WHERE date >= ? GROUP BY home_id, home_name`, daysAgo(400).slice(0, 10))) add(team, AF + r.id, r.n);
    for (const r of all(`SELECT player_id AS id, name FROM af_player_season WHERE season >= (SELECT MAX(season) - 1 FROM af_player_season) GROUP BY player_id, name`)) add(player, r.id, r.name);
  } else if (sport === 'basketball') {
    for (const r of all(`SELECT game_id, kickoff, home_id, home_name, away_id, away_name FROM bb_games WHERE kickoff >= ?`, daysAgo(400))) {
      add(team, r.home_id, r.home_name); add(team, r.away_id, r.away_name);
      if (r.kickoff >= from && r.kickoff < to) match.push({ id: String(r.game_id), hid: String(r.home_id), h: r.home_name, aid: String(r.away_id), a: r.away_name, d: r.kickoff });
    }
    for (const r of all(`SELECT player_id AS id, name FROM bb_player_stats WHERE game_id IN (SELECT game_id FROM bb_games WHERE kickoff >= ?) GROUP BY player_id, name`, daysAgo(400))) add(player, r.id, r.name);
  } else if (sport === 'american-football') {
    for (const r of all(`SELECT team_id, name FROM nfl_teams`)) add(team, r.team_id, r.name);
    for (const r of all(`SELECT game_id, kickoff, home_id, home_name, away_id, away_name FROM nfl_games WHERE kickoff >= ? AND kickoff < ?`, from, to)) {
      add(team, r.home_id, r.home_name); add(team, r.away_id, r.away_name);
      if (r.home_name && r.away_name) match.push({ id: String(r.game_id), hid: String(r.home_id), h: r.home_name, aid: String(r.away_id), a: r.away_name, d: r.kickoff });
    }
    for (const r of all(`SELECT player_id, name FROM nfl_players`)) add(player, r.player_id, r.name);
  } else {
    for (const r of all(`SELECT id, name FROM tennis_players`)) add(player, r.id, r.name);
    for (const r of all(`SELECT id, scheduled_at, p1_id, p1_name, p2_id, p2_name FROM tennis_matches WHERE scheduled_at >= ? AND scheduled_at < ?`, from, to)) {
      add(player, r.p1_id, r.p1_name); add(player, r.p2_id, r.p2_name);
      if (r.p1_name && r.p2_name) match.push({ id: String(r.id), hid: r.p1_id != null ? String(r.p1_id) : null, h: r.p1_name, aid: r.p2_id != null ? String(r.p2_id) : null, a: r.p2_name, d: r.scheduled_at });
    }
  }
  return { team, player, match };
}

let running = false, lastFull = 0;
export const slugStatus = () => Object.fromEntries(LINK_SPORTS.map(s => {
  const st = states.get(s);
  const ix = idIndexes.get(s);
  return [s, st ? { builtAt: new Date(st.builtAt).toISOString(), entries: st.map.size, clientKb: Math.round(st.client.length / 1024), playersKb: Math.round(st.clientPlayers.length / 1024), idIndex: ix ? { entries: ix.entries, chunks: ix.chunks.length, kb: Math.round(ix.chunks.reduce((a, c) => a + c.ids.byteLength + c.off.byteLength + c.text.length, 0) / 1024) } : null } : null];
}));
/** worker job "slugs": new items every run; renames (every item's name checked again) every 6 hours */
export async function buildSlugs(opts: { full?: boolean; sports?: LinkSport[] } = {}): Promise<void> {
  if (running || !runsJobs) return;
  running = true;
  const full = opts.full || Date.now() - lastFull > 6 * 3600 * 1000;
  const step = yieldEvery(50, 100);
  try {
    for (const sport of opts.sports || LINK_SPORTS) {
      const t0 = Date.now();
      try {
        if (sport === 'football') await buildFootball(step, full);
        else if (sport === 'basketball') await buildBasketball(step, full);
        else if (sport === 'american-football') await buildNfl(step, full);
        else await buildTennis(step, full);
        await publishSport(sport, step);
        logger.info(`slugs ${sport}: ${states.get(sport)?.map.size ?? 0} lookups in ${Date.now() - t0} ms`);
      } catch (e: any) { logger.warn(`slugs ${sport}: ${e?.message || e}`); }
    }
    if (full) lastFull = Date.now();
  } finally { running = false; }
}

/** the app's exception list of a sport (`/api/slugs/:sport`; `players` = the players' list) */
export function clientSlugs(sport: LinkSport, players = false): string | null {
  const st = states.get(sport);
  return st ? (players ? st.clientPlayers : st.client) : null;
}
export { baseOf, slugify };
