/**
 * fix202: stored pages (stale-while-revalidate) and live state, shared by the web process and the worker.
 *
 * The worker (worker.ts → index.ts in the worker role) builds every page below by asking its own routes on the
 * internal port, once per "persona" (anon / free / premium / pro: what the route can show differently), and stores the
 * body in page_cache. The web process (web.ts) answers a visitor from the stored copy at once and never builds a page:
 * a copy older than its ttl is rebuilt by the worker (the web process reports which pages were asked for). A page never
 * stored yet is passed to the worker once (and stored from then on).
 *
 * live_state: one row per live game (football), written by the worker's live poll; the web process re-reads the rows a
 * message names and pushes them on the socket.
 *
 * Light on purpose (db only): the web process imports it.
 */
import { db } from '../db';

export type Persona = 'anon' | 'free' | 'premium' | 'pro';
export const PERSONAS: Persona[] = ['anon', 'free', 'premium', 'pro'];
/** what a signed-in user with unlocked games needs: 'tease' = the full copy trimmed per user (football lists),
 *  'proxy' = asked of the worker (basketball / NFL / tennis lists decide per game inside the route), 'none' = same copy */
type Unlocks = 'tease' | 'proxy' | 'none';

export interface PageRule {
  re: RegExp;
  ttlMs: number;
  /** the copy a plan gets (routes show some plans the same thing: one copy for those) */
  persona: (access: Persona) => Persona;
  unlocks: Unlocks;
  html?: boolean;
}

const SAME = (): Persona => 'anon';
/** football lists: the auth middleware trims every prediction unless the plan sees everything (canSeeFull) */
const FULL = (a: Persona): Persona => (a === 'pro' ? 'pro' : 'anon');
/** isPaid(): every paid plan sees the numbers (basketball / NFL / tennis lists, finished football results) */
const PAID = (a: Persona): Persona => (a === 'premium' || a === 'pro' ? 'premium' : 'anon');
/** draw alerts: Pro only (signed out 401, free and Premium 402) */
const PRO = (a: Persona): Persona => (a === 'pro' ? 'pro' : a === 'anon' ? 'anon' : 'free');

const S = 1000, M = 60 * S;
export const PAGE_RULES: PageRule[] = [
  { re: /^\/api\/matches\/upcoming$/, ttlMs: 30 * S, persona: FULL, unlocks: 'tease' },
  { re: /^\/api\/matches\/live$/, ttlMs: 15 * S, persona: FULL, unlocks: 'tease' },
  { re: /^\/api\/public\/summary$/, ttlMs: 5 * M, persona: SAME, unlocks: 'none' },
  { re: /^\/api\/public\/results$/, ttlMs: 2 * M, persona: PAID, unlocks: 'none' },
  { re: /^\/api\/draw-alerts$/, ttlMs: 5 * M, persona: PRO, unlocks: 'none' },
  { re: /^\/api\/news$/, ttlMs: 5 * M, persona: SAME, unlocks: 'none' },
  { re: /^\/api\/hub(\/[a-z0-9-]{2,60})?$/, ttlMs: 15 * M, persona: SAME, unlocks: 'none' },
  { re: /^\/api\/basketball\/games$/, ttlMs: 30 * S, persona: PAID, unlocks: 'proxy' },
  { re: /^\/api\/basketball\/record$/, ttlMs: 10 * M, persona: SAME, unlocks: 'none' },
  { re: /^\/api\/basketball\/standings\/[A-Za-z0-9]{2,8}$/, ttlMs: 10 * M, persona: SAME, unlocks: 'none' },
  { re: /^\/api\/nfl\/home$/, ttlMs: 60 * S, persona: PAID, unlocks: 'proxy' },
  { re: /^\/api\/nfl\/record$/, ttlMs: 10 * M, persona: SAME, unlocks: 'none' },
  { re: /^\/api\/tennis\/home$/, ttlMs: 60 * S, persona: PAID, unlocks: 'proxy' },
  { re: /^\/api\/tennis\/record$/, ttlMs: 10 * M, persona: SAME, unlocks: 'none' },
  // search-engine HTML of the home pages and the weekly hubs, every language (the same for every visitor)
  { re: /^(\/(es|pt|de|fr|it|tr))?(\/|\/basketball|\/american-football|\/tennis|\/predictions\/[a-z0-9-]{2,60}|\/(basketball|tennis)\/predictions\/[a-z0-9-]{2,60})?$/, ttlMs: 10 * M, persona: SAME, unlocks: 'none', html: true }
];

const LANGS = ['', '/es', '/pt', '/de', '/fr', '/it', '/tr'];
/** Built as soon as the worker starts (what the home pages and the lists ask for), then kept fresh. */
export const PREBUILD: string[] = [
  '/api/matches/upcoming?days=14', '/api/matches/upcoming?days=30', '/api/matches/live',
  '/api/public/summary', '/api/public/results?days=30&limit=50', '/api/public/results?days=30&limit=40',
  '/api/draw-alerts', '/api/news?limit=10', '/api/news?limit=10&sport=basketball', '/api/news?limit=10&sport=tennis',
  '/api/news?limit=10&sport=american-football',
  '/api/basketball/games?days=7', '/api/basketball/games?days=30', '/api/basketball/games?days=30&results=1',
  '/api/basketball/games?days=7&results=1', '/api/basketball/record?days=30',
  ...['NBA', 'EL', 'ACB', 'LBA', 'BSL', 'LNB', 'BBL', 'GBL', 'EC', 'BCL'].map(c => `/api/basketball/standings/${c}`),
  '/api/nfl/home', '/api/nfl/record?days=30', '/api/tennis/home?tour=all', '/api/tennis/record?days=30&tour=all',
  '/api/hub', ...['premier-league', 'la-liga', 'serie-a', 'bundesliga'].map(s => `/api/hub/${s}`),
  ...LANGS.flatMap(l => [l || '/', `${l}/basketball`, `${l}/american-football`, `${l}/tennis`])
];

export const ruleFor = (path: string): PageRule | null => PAGE_RULES.find(r => r.re.test(path)) || null;

/** One key per page: the path and its query, sorted (a maintenance token never makes a stored page). */
export function pageKey(path: string, query: Record<string, unknown>): string | null {
  const parts: string[] = [];
  for (const k of Object.keys(query).sort()) {
    if (k === 'token') return null;
    const v = query[k];
    if (typeof v !== 'string' || v.length > 80) return null;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  if (parts.length > 6) return null;
  return parts.length ? `${path}?${parts.join('&')}` : path;
}
export function keyOfUrl(url: string): string | null {
  const u = new URL(url, 'http://x');
  return pageKey(u.pathname, Object.fromEntries(u.searchParams));
}
/** the personas a page is built for (one copy per distinct view) */
export const personasOf = (rule: PageRule): Persona[] => [...new Set(PERSONAS.map(p => rule.persona(p)))];

db.exec(`
  CREATE TABLE IF NOT EXISTS page_cache (
    key        TEXT NOT NULL,
    persona    TEXT NOT NULL,
    status     INTEGER NOT NULL,
    headers    TEXT NOT NULL,
    body       TEXT NOT NULL,
    build      TEXT,
    built_at   INTEGER NOT NULL,
    PRIMARY KEY (key, persona)
  );
  CREATE TABLE IF NOT EXISTS live_state (
    sport      TEXT NOT NULL,
    game_id    INTEGER NOT NULL,
    pos        INTEGER NOT NULL,
    json       TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (sport, game_id)
  );
`);

export interface StoredPage { status: number; headers: Record<string, string>; body: string; build: string | null; builtAt: number }

const getStmt = db.prepare('SELECT status, headers, body, build, built_at FROM page_cache WHERE key = ? AND persona = ?');
export function readPage(key: string, persona: Persona): StoredPage | null {
  const r: any = getStmt.get(key, persona);
  return r ? { status: r.status, headers: JSON.parse(r.headers), body: r.body, build: r.build, builtAt: r.built_at } : null;
}
const putStmt = db.prepare(`INSERT INTO page_cache (key, persona, status, headers, body, build, built_at) VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(key, persona) DO UPDATE SET status = excluded.status, headers = excluded.headers, body = excluded.body, build = excluded.build, built_at = excluded.built_at`);
export function writePage(key: string, persona: Persona, p: Omit<StoredPage, 'builtAt'>, at = Date.now()) {
  putStmt.run(key, persona, p.status, JSON.stringify(p.headers), p.body, p.build, at);
}
/** the oldest copy of a page (a page is fresh only when every persona is) */
const ageStmt = db.prepare('SELECT MIN(built_at) AS at, COUNT(*) AS n FROM page_cache WHERE key = ?');
export function pageBuiltAt(key: string): { at: number; n: number } {
  const r: any = ageStmt.get(key);
  return { at: Number(r?.at) || 0, n: Number(r?.n) || 0 };
}
/** pages nobody asked for in a day (query variants of lists) */
export function prunePages(keep: Set<string>, olderThanMs = 24 * 3600 * 1000): number {
  const rows = db.prepare('SELECT DISTINCT key FROM page_cache WHERE built_at < ?').all(Date.now() - olderThanMs) as { key: string }[];
  const del = db.prepare('DELETE FROM page_cache WHERE key = ?');
  let n = 0;
  for (const r of rows) if (!keep.has(r.key)) { del.run(r.key); n++; }
  return n;
}

/* ---------- live state ---------- */

/** Worker: store this tick's live list (rows that changed, rows of games no longer live removed). Returns the ids
 *  whose row changed. `last` keeps the stored JSON per game between ticks (no write when nothing moved). */
export function writeLive(sport: string, games: { id: number }[], last: Map<number, string>): number[] {
  const now = Date.now();
  const changed: number[] = [];
  const ids = new Set(games.map(g => g.id));
  const up = db.prepare(`INSERT INTO live_state (sport, game_id, pos, json, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(sport, game_id) DO UPDATE SET pos = excluded.pos, json = excluded.json, updated_at = excluded.updated_at`);
  const del = db.prepare('DELETE FROM live_state WHERE sport = ? AND game_id = ?');
  db.exec('BEGIN');
  try {
    games.forEach((g, i) => {
      const json = JSON.stringify(g);
      const key = `${i}|${json}`;
      if (last.get(g.id) === key) return;
      up.run(sport, g.id, i, json, now);
      last.set(g.id, key);
      changed.push(g.id);
    });
    for (const id of [...last.keys()]) if (!ids.has(id)) { del.run(sport, id); last.delete(id); }
    // rows left by an earlier worker run (restart) that are not live any more
    const stored = db.prepare('SELECT game_id FROM live_state WHERE sport = ?').all(sport) as { game_id: number }[];
    for (const r of stored) if (!ids.has(r.game_id)) del.run(sport, r.game_id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return changed;
}
/** Web: the rows of some games (or all of a sport), in list order. */
export function readLive(sport: string, ids?: number[]): { id: number; json: string }[] {
  const rows = (ids
    ? ids.length ? db.prepare(`SELECT game_id, json FROM live_state WHERE sport = ? AND game_id IN (${ids.map(() => '?').join(',')}) ORDER BY pos`).all(sport, ...ids) : []
    : db.prepare('SELECT game_id, json FROM live_state WHERE sport = ? ORDER BY pos').all(sport)) as { game_id: number; json: string }[];
  return rows.map(r => ({ id: r.game_id, json: r.json }));
}
