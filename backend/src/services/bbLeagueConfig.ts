/**
 * Extra basketball leagues added from the admin panel (Oct 2026) — same idea as the football leagueConfig.ts.
 * Each league gets the code `BB<API-Basketball league id>` and everything the hand-picked 18 get: 5 seasons of games,
 * box scores (team + players), live scores, the model, game/league/team/player pages. It starts "in testing" (an admin label only since fix203; it counts in every number).
 *
 * Modules register with onBbExtraLeague(): called now for every saved league and later for each new one.
 */
import { db } from '../db';

export interface BbExtraLeague { id: number; code: string; name: string; country: string; flag: string | null; trial: boolean }

db.exec(`
  CREATE TABLE IF NOT EXISTS bb_extra_leagues (
    league_id INTEGER PRIMARY KEY,
    name      TEXT NOT NULL,
    country   TEXT NOT NULL,
    flag      TEXT,
    trial     INTEGER NOT NULL DEFAULT 1,
    enabled   INTEGER NOT NULL DEFAULT 1,
    added_at  TEXT NOT NULL,
    removed_at TEXT
  );
`);

export const bbExtraCode = (id: number) => `BB${id}`;
const toLeague = (r: any): BbExtraLeague => ({ id: r.league_id, code: bbExtraCode(r.league_id), name: r.name, country: r.country, flag: r.flag || null, trial: !!r.trial });

const active = new Map<number, BbExtraLeague>(
  (db.prepare(`SELECT * FROM bb_extra_leagues WHERE enabled = 1 ORDER BY league_id`).all() as any[]).map(r => [r.league_id, toLeague(r)])
);
const handlers: ((l: BbExtraLeague) => void)[] = [];
const trialHandlers: ((code: string, trial: boolean) => void)[] = [];

export function onBbExtraLeague(fn: (l: BbExtraLeague) => void) {
  handlers.push(fn);
  for (const l of active.values()) fn(l);
}
export function onBbExtraTrial(fn: (code: string, trial: boolean) => void) { trialHandlers.push(fn); }
export const bbExtraLeagueList = () => [...active.values()];
/** Flag code (ISO, lower case) of an added league, for the countries menu. */
export const bbExtraFlag = (code: string) => [...active.values()].find(l => l.code === code)?.flag || null;

export function addBbExtraLeague(l: Omit<BbExtraLeague, 'code'>) {
  db.prepare(`
    INSERT INTO bb_extra_leagues (league_id, name, country, flag, trial, enabled, added_at, removed_at) VALUES (?, ?, ?, ?, ?, 1, ?, NULL)
    ON CONFLICT(league_id) DO UPDATE SET name = excluded.name, country = excluded.country, flag = excluded.flag, enabled = 1, removed_at = NULL
  `).run(l.id, l.name, l.country, l.flag, l.trial ? 1 : 0, new Date().toISOString());
  if (active.has(l.id)) return { added: false, already: true };
  const full = { ...l, code: bbExtraCode(l.id) };
  active.set(l.id, full);
  for (const fn of handlers) fn(full);
  return { added: true, already: false };
}

export function removeBbExtraLeague(id: number) {
  db.prepare(`UPDATE bb_extra_leagues SET enabled = 0, removed_at = ? WHERE league_id = ?`).run(new Date().toISOString(), id);
  return { ok: true, note: 'Removed from the list. It leaves the site after the next deploy or restart.' };
}

export function setBbExtraTrial(id: number, trial: boolean) {
  db.prepare(`UPDATE bb_extra_leagues SET trial = ? WHERE league_id = ?`).run(trial ? 1 : 0, id);
  const l = active.get(id);
  if (l) l.trial = trial;
  for (const fn of trialHandlers) fn(bbExtraCode(id), trial);
  return { ok: true };
}

export function bbExtraLeagueRows() {
  return (db.prepare(`SELECT * FROM bb_extra_leagues ORDER BY country, name`).all() as any[]).map(r => ({
    id: r.league_id, code: bbExtraCode(r.league_id), name: r.name, country: r.country, trial: !!r.trial, enabled: !!r.enabled,
    addedAt: r.added_at, removedAt: r.removed_at, live: active.has(r.league_id)
  }));
}
