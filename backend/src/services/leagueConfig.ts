/**
 * Extra football leagues added from the admin panel (Oct 2026) — no code change per league.
 *
 * Each league is its own model group and division, both coded `AF<league id>`. Its history (3 seasons of results)
 * comes from API-Football fixtures instead of the football-data.co.uk CSVs, and it gets everything the other
 * API-Football leagues get: fixtures window, live scores, standings, lineups, injuries, match stats, player pages.
 *
 * The other modules register a handler with onExtraLeague(): it runs once for every saved league when the module
 * loads, and again for a league added later (so no restart is needed to add one; removing one takes a restart).
 */
import { db } from '../db';

export interface ExtraLeague {
  id: number;
  name: string;
  country: string;
  calendar: boolean; // season played within a calendar year (spring–autumn)
  trial: boolean; // "in testing": an admin label only (fix203: counted in every public number)
}

db.exec(`
  CREATE TABLE IF NOT EXISTS af_extra_leagues (
    league_id INTEGER PRIMARY KEY,
    name      TEXT NOT NULL,
    country   TEXT NOT NULL,
    calendar  INTEGER NOT NULL DEFAULT 0,
    trial     INTEGER NOT NULL DEFAULT 1,
    enabled   INTEGER NOT NULL DEFAULT 1,
    added_at  TEXT NOT NULL,
    removed_at TEXT
  );
`);

const toLeague = (r: any): ExtraLeague => ({ id: r.league_id, name: r.name, country: r.country, calendar: !!r.calendar, trial: !!r.trial });

/** Leagues switched on now (removals count only after a restart: see `pendingRemoval`). */
const atBoot: ExtraLeague[] = (db.prepare(`SELECT * FROM af_extra_leagues WHERE enabled = 1 ORDER BY league_id`).all() as any[]).map(toLeague);
const active = new Map<number, ExtraLeague>(atBoot.map(l => [l.id, l]));

type Handler = (l: ExtraLeague) => void;
const handlers: Handler[] = [];
const trialHandlers: ((code: string, trial: boolean) => void)[] = [];

export const extraCode = (id: number) => `AF${id}`;
export const isExtraLeague = (id: number) => active.has(id);
export const extraLeagueList = () => [...active.values()];

/** Register a module's handler: called now for every active league, later for each league added. */
export function onExtraLeague(fn: Handler) {
  handlers.push(fn);
  for (const l of active.values()) fn(l);
}
export function onExtraTrial(fn: (code: string, trial: boolean) => void) {
  trialHandlers.push(fn);
}

export function addExtraLeague(l: ExtraLeague) {
  const existing: any = db.prepare(`SELECT enabled FROM af_extra_leagues WHERE league_id = ?`).get(l.id);
  db.prepare(`
    INSERT INTO af_extra_leagues (league_id, name, country, calendar, trial, enabled, added_at, removed_at) VALUES (?, ?, ?, ?, ?, 1, ?, NULL)
    ON CONFLICT(league_id) DO UPDATE SET name = excluded.name, country = excluded.country, calendar = excluded.calendar, enabled = 1, removed_at = NULL
  `).run(l.id, l.name, l.country, l.calendar ? 1 : 0, l.trial ? 1 : 0, new Date().toISOString());
  if (active.has(l.id)) return { added: false, already: true };
  active.set(l.id, l);
  for (const fn of handlers) fn(l);
  return { added: true, already: false, reEnabled: !!existing };
}

/** Switch a league off (it stays on the site until the next restart / deploy). */
export function removeExtraLeague(id: number) {
  db.prepare(`UPDATE af_extra_leagues SET enabled = 0, removed_at = ? WHERE league_id = ?`).run(new Date().toISOString(), id);
  return { ok: true, note: 'Removed from the list. It leaves the site after the next deploy or restart.' };
}

export function setExtraTrial(id: number, trial: boolean) {
  db.prepare(`UPDATE af_extra_leagues SET trial = ? WHERE league_id = ?`).run(trial ? 1 : 0, id);
  const l = active.get(id);
  if (l) l.trial = trial;
  for (const fn of trialHandlers) fn(extraCode(id), trial);
  return { ok: true };
}

/** Every saved row (on, off, waiting for a restart) for the admin panel. */
export function extraLeagueRows() {
  return (db.prepare(`SELECT * FROM af_extra_leagues ORDER BY country, name`).all() as any[]).map(r => ({
    id: r.league_id, name: r.name, country: r.country, calendar: !!r.calendar, trial: !!r.trial, enabled: !!r.enabled,
    addedAt: r.added_at, removedAt: r.removed_at, live: active.has(r.league_id)
  }));
}
