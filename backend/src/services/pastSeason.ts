/**
 * fix243: past seasons are admin-only (CLAUDE.md). A match page of a past season — any sport, any language prefix —
 * is not public: signed-out visitors, members and crawlers get 410 (noindex), it is left out of the sitemaps and the
 * search-engine HTML, and the app draws no link to it (frontend lib/links.ts, from seasonStarts below). Admins see it.
 * Current-season finished games stay public (they are the record).
 *
 * "Past season" = older than the latest season of the game's own competition:
 *  - football: API-Football fixtures by league season (af_fixtures.season < the league's latest); Football-Data.org
 *    matches by the European season (before 1 July of the season running now), calendar-year and tournament
 *    competitions (Copa Libertadores, Brasileirão, World Cup, Euros) by their latest year
 *  - basketball: bb_games.season < the league's latest season (BSN 2026 stays current until its 2027 season starts)
 *  - American football: nfl_games.season < the league's current season (nflCurrentSeason)
 *  - tennis: a calendar year before the latest one
 * Worker / one process only (it reads the tables); the web process reads the flags the slug job publishes.
 */
import { db } from '../db';
import type { LinkSport } from '../utils/slugRules';

const AF = 1_000_000_000;
const FD_BY_YEAR = new Set(['CLI', 'BSA', 'WC', 'EC']);
const TTL = 30 * 60 * 1000;

type Latest = { at: number; m: Map<string, string | number> };
const latest: Partial<Record<string, Latest>> = {};
function latestOf(name: string, sql: string): Map<string, string | number> {
  const c = latest[name];
  if (c && Date.now() - c.at < TTL) return c.m;
  const m = new Map<string, string | number>();
  try { for (const r of db.prepare(sql).all() as any[]) if (r.k != null && r.s != null) m.set(String(r.k), r.s); } catch { /* table not there (tests) */ }
  latest[name] = { at: Date.now(), m };
  return m;
}
/** tests: forget the cached latest seasons */
export const _forgetSeasons = () => { for (const k of Object.keys(latest)) delete latest[k]; };

/** the European season running on `now`: from 1 July */
export const fdSeasonStart = (now = new Date()) => `${now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1}-07-01`;

const one = (sql: string, ...a: any[]) => { try { return db.prepare(sql).get(...a) as any; } catch { return undefined; } };

/** true = this match is from a past season (its page is admin-only); unknown matches are not */
export function isPastSeasonMatch(sport: LinkSport, id: string | number, now = new Date()): boolean {
  const n = Number(id);
  if (!Number.isFinite(n)) return false;
  if (sport === 'football') {
    if (n >= AF) {
      const r = one(`SELECT league_id, season FROM af_fixtures WHERE fixture_id = ?`, n - AF);
      if (!r) return false;
      const top = latestOf('af', `SELECT league_id AS k, MAX(season) AS s FROM af_fixtures GROUP BY league_id`).get(String(r.league_id));
      return top != null && Number(r.season) < Number(top);
    }
    const r = one(`SELECT utc_date, competition_code FROM predictions WHERE match_id = ? LIMIT 1`, n);
    if (!r?.utc_date) return false;
    if (FD_BY_YEAR.has(r.competition_code)) {
      const top = latestOf('fd', `SELECT competition_code AS k, MAX(substr(utc_date, 1, 4)) AS s FROM predictions WHERE competition_code IN ('CLI','BSA','WC','EC') GROUP BY competition_code`).get(r.competition_code);
      return top != null && String(r.utc_date).slice(0, 4) < String(top);
    }
    return String(r.utc_date).slice(0, 10) < fdSeasonStart(now);
  }
  if (sport === 'basketball') {
    const r = one(`SELECT code, season FROM bb_games WHERE game_id = ?`, n);
    if (!r) return false;
    const top = latestOf('bb', `SELECT code AS k, MAX(season) AS s FROM bb_games GROUP BY code`).get(r.code);
    return top != null && String(r.season) < String(top);
  }
  if (sport === 'american-football') {
    const r = one(`SELECT league, season FROM nfl_games WHERE game_id = ?`, n);
    if (!r) return false;
    const top = latestOf('nfl', `SELECT league AS k, MAX(season) AS s FROM nfl_games GROUP BY league`).get(String(r.league));
    const cur = one(`SELECT detail FROM nfl_sync WHERE key = ?`, Number(r.league) === 1 ? 'current' : `current|${r.league}`)?.detail;
    const season = Number.isFinite(Number(cur)) && cur != null ? Number(cur) : Number(top);
    return Number.isFinite(season) && Number(r.season) < season;
  }
  const r = one(`SELECT scheduled_at FROM tennis_matches WHERE id = ?`, n);
  if (!r?.scheduled_at) return false;
  const top = latestOf('tn', `SELECT 'all' AS k, MAX(substr(scheduled_at, 1, 4)) AS s FROM tennis_matches WHERE scheduled_at <= '${new Date(Date.now() + 365 * 86400000).toISOString()}'`).get('all');
  return top != null && String(r.scheduled_at).slice(0, 4) < String(top);
}

/**
 * The app's link rule (`/api/slugs/<sport>/seasons`): per team (tennis: per player) the day its current season began
 * (the earliest start of the competitions it plays this season), grouped by day, and `d` = the latest such start of the
 * sport — a game on or after `d` is never from a past season, so the app only needs the list for older games.
 * A game is past when it is before the start of either side (frontend lib/links.ts matchHref).
 */
export function seasonStarts(sport: LinkSport): { v: 1; d: string | null; s: Record<string, string> } {
  const per = new Map<string, string>();
  const add = (id: unknown, day: unknown) => {
    if (id == null || !day) return;
    const k = String(id), d = String(day).slice(0, 10), cur = per.get(k);
    if (!cur || d < cur) per.set(k, d);
  };
  const rows = (sql: string, ...a: any[]) => { try { return db.prepare(sql).all(...a) as any[]; } catch { return []; } };
  if (sport === 'football') {
    // API-Football: each league's latest season and the day it began; FD matches of this European season
    const starts = rows(`SELECT f.league_id, MIN(f.kickoff) AS d FROM af_fixtures f JOIN (SELECT league_id, MAX(season) AS s FROM af_fixtures GROUP BY league_id) l
      ON l.league_id = f.league_id AND l.s = f.season GROUP BY f.league_id`);
    const startOf = new Map(starts.map(r => [String(r.league_id), String(r.d)]));
    for (const r of rows(`SELECT f.league_id, f.home_id, f.away_id FROM af_fixtures f JOIN (SELECT league_id, MAX(season) AS s FROM af_fixtures GROUP BY league_id) l
      ON l.league_id = f.league_id AND l.s = f.season`)) { const d = startOf.get(String(r.league_id)); add(AF + r.home_id, d); add(AF + r.away_id, d); }
    const fd = fdSeasonStart();
    for (const r of rows(`SELECT DISTINCT home_team_id AS h, away_team_id AS a FROM predictions WHERE utc_date >= ? AND match_id < ?`, fd, AF)) { add(r.h, fd); add(r.a, fd); }
  } else if (sport === 'basketball') {
    const starts = rows(`SELECT g.code, MIN(g.kickoff) AS d FROM bb_games g JOIN (SELECT code, MAX(season) AS s FROM bb_games GROUP BY code) l ON l.code = g.code AND l.s = g.season GROUP BY g.code`);
    const startOf = new Map(starts.map(r => [String(r.code), String(r.d)]));
    for (const r of rows(`SELECT DISTINCT g.code, g.home_id, g.away_id FROM bb_games g JOIN (SELECT code, MAX(season) AS s FROM bb_games GROUP BY code) l ON l.code = g.code AND l.s = g.season`)) {
      const d = startOf.get(String(r.code)); add(r.home_id, d); add(r.away_id, d);
    }
  } else if (sport === 'american-football') {
    for (const lg of [1, 2]) {
      const cur = one(`SELECT detail FROM nfl_sync WHERE key = ?`, lg === 1 ? 'current' : `current|${lg}`)?.detail;
      const season = Number.isFinite(Number(cur)) && cur != null ? Number(cur) : one(`SELECT MAX(season) AS s FROM nfl_games WHERE league = ?`, lg)?.s;
      if (season == null) continue;
      const d = one(`SELECT MIN(kickoff) AS d FROM nfl_games WHERE league = ? AND season = ?`, lg, season)?.d;
      for (const r of rows(`SELECT DISTINCT home_id, away_id FROM nfl_games WHERE league = ? AND season = ?`, lg, season)) { add(r.home_id, d); add(r.away_id, d); }
    }
  } else {
    const y = one(`SELECT MAX(substr(scheduled_at, 1, 4)) AS y FROM tennis_matches WHERE scheduled_at <= ?`, new Date(Date.now() + 365 * 86400000).toISOString())?.y;
    if (y) return { v: 1, d: `${y}-01-01`, s: {} };
  }
  const by: Record<string, string[]> = {};
  let d: string | null = null;
  for (const [id, day] of per) { (by[day] ||= []).push(id); if (!d || day > d) d = day; }
  const s: Record<string, string> = {};
  for (const [day, ids] of Object.entries(by)) s[day] = ids.join(',');
  return { v: 1, d, s };
}
