/**
 * fix217 — NBA model v4 (bb-v4): bb-v3 plus player impact ratings, and the injury report / line-ups priced in before
 * tip-off. The maths is in utils/nbaImpact.ts; this file runs it on our data:
 *
 *  - buildNbaV4 (bb model thread, after the NBA league is built): the walk-forward replay of every NBA game (ridge refit
 *    at each season's start and every 14 days), the gate, and the state the predictions read ('bb:v4': ratings,
 *    projected minutes, rosters of the last 3 games, games played) — published like the league models.
 *  - nbaV4Adjust (every process that predicts): an upcoming NBA game's v4 chance from bb-v3's, the two rotations and the
 *    same-day information (injury report: Out 0 min, Doubtful 25%, Questionable 60%; confirmed line-ups).
 *  - nbaRepriceTick (worker, every minute): each NBA game is re-priced 90, 30 and 10 min before tip-off with a fresh
 *    injury report and the line-ups when balldontlie has them; what moved is logged (bb_v4_log, admin "NBA model check").
 *    The prediction saved last before tip-off is the one recorded (recordBbPredictions stops at tip-off).
 *  - Gate (fix217 brief): on 2025-26 (test) v4 must be no worse than bb-v3 on log loss over the whole season and better
 *    on games 1–25, and better on this season's finished games (20+). Pass → 'full'; fail → 'reprice' (bb-v3 stays the
 *    base, only the same-day part of v4 moves it). NBA_V4=full|reprice|off overrides.
 */
import logger from '../utils/logger';
import { db } from '../db';
import { yieldLoop } from './perf';
import { onState, publishState } from './shared';
import { nbaKey, playerKey, bdlGet, refreshNbaInjuries, nbaInjuryStatus } from './bbInjuries';
import { nbaRestKeep } from './keyPlayers';
import {
  replayV4, rotation, strength, projMinutes, statusKeep, v4Margin, repriceOnly, scoreP, rowP, tuneV4, probit,
  V4_TUNED, V4_TEST_SEASON, TEAM_SCALE, type RBase, type RGame, type RLine, type RRow, type V4Params, type RotPlayer
} from '../utils/nbaImpact';

export const NBA_V4_MODEL = 'bb-v4';
export type V4Mode = 'full' | 'reprice' | 'off' | 'grid';
/** Re-pricing checkpoints (minutes before tip-off). */
export const CHECKPOINTS = [90, 30, 10];

db.exec(`
  CREATE TABLE IF NOT EXISTS bb_v4_log (
    game_id INTEGER NOT NULL, checkpoint TEXT NOT NULL, at TEXT NOT NULL, mode TEXT NOT NULL,
    p_v3 REAL, p_v4 REAL NOT NULL, margin_before REAL, margin_after REAL NOT NULL, same_day REAL NOT NULL,
    removed TEXT, lineups INTEGER NOT NULL DEFAULT 0, injuries_at TEXT,
    PRIMARY KEY (game_id, checkpoint)
  );
  CREATE TABLE IF NOT EXISTS bb_v4_shadow (
    game_id INTEGER PRIMARY KEY, kickoff TEXT NOT NULL, mode TEXT NOT NULL, p_v3 REAL NOT NULL, p_v4 REAL NOT NULL, made_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS bb_v4_lineups (
    game_id INTEGER NOT NULL, team_id INTEGER NOT NULL, players TEXT NOT NULL, at TEXT NOT NULL,
    PRIMARY KEY (game_id, team_id)
  );
`);

type Gate = {
  at: string; pass: boolean; reason: string;
  test: { season: string; whole: { v3: any; v4: any }; first25: { v3: any; v4: any }; withLineups: any; passWhole: boolean; passFirst25: boolean };
  live: { games: number; v3: any; v4: any; pass: boolean; note: string };
};
type State = {
  ratings: Map<number, number>; proj: Map<number, number>; names: Map<number, string>; rosters: Map<number, number[]>;
  gp: Map<string, number>; fitAt: number | null; fitPlayers: number; fitGames: number; params: V4Params; gate: Gate | null;
  suggested: V4Params | null; builtAt: string;
};
let st: State | null = null;
let ver = 0;
onState('bb:v4', (_k, v: any) => { st = v as State; ver++; });
/** bumps when a new v4 build arrives (part of the cached predictions' key) */
export const nbaV4Ver = () => ver;

/** The mode in use: the gate's answer, unless NBA_V4 says otherwise. */
export function nbaV4Mode(): V4Mode {
  const env = String(process.env.NBA_V4 || '').toLowerCase();
  if (env === 'full' || env === 'reprice' || env === 'off') return env;
  if (!st) return 'off';
  return st.gate?.pass ? 'full' : 'reprice';
}

const isPre = (iso: string) => { const d = new Date(iso); return d.getUTCMonth() === 9 && d.getUTCDate() < 19; };

/** NBA games + box-score minutes, the replay's input. */
function loadNba(): { games: RGame[]; lines: RLine[]; names: Map<number, string> } {
  const games = (db.prepare(`SELECT game_id, season, kickoff, status, home_id, away_id, hs, as_, stage FROM bb_games WHERE code = 'NBA' ORDER BY kickoff, game_id`).all() as any[])
    .map(g => {
      const pre = isPre(g.kickoff);
      return { id: g.game_id, season: g.season, ms: Date.parse(g.kickoff), home: g.home_id, away: g.away_id, hs: g.hs, as_: g.as_, finished: ['FT', 'AOT'].includes(g.status) && g.hs !== null && g.as_ !== null, pre, rs: !pre && !g.stage };
    });
  const names = new Map<number, string>();
  const lines: RLine[] = [];
  for (const r of db.prepare(`SELECT ps.game_id, ps.team_id, ps.player_id, ps.minutes, ps.name FROM bb_player_stats ps JOIN bb_games g ON g.game_id = ps.game_id WHERE g.code = 'NBA' AND ps.minutes > 0 ORDER BY g.kickoff`).all() as any[]) {
    lines.push([r.game_id, r.team_id, r.player_id, r.minutes]);
    if (r.name) names.set(r.player_id, r.name);
  }
  return { games, lines, names };
}

/** The current model's saved home win chance for finished games of this season (shadow first, then the record). */
function currentModelP(ids: number[]): Map<number, number> {
  const out = new Map<number, number>();
  if (!ids.length) return out;
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500), q = part.map(() => '?').join(',');
    for (const r of db.prepare(`SELECT game_id, p_home FROM bb_predictions WHERE game_id IN (${q}) AND model = 'bb-v3'`).all(...part) as any[]) out.set(r.game_id, r.p_home);
    for (const r of db.prepare(`SELECT game_id, p_v3 FROM bb_v4_shadow WHERE game_id IN (${q})`).all(...part) as any[]) out.set(r.game_id, r.p_v3);
  }
  return out;
}

/** The gate on the replay rows (2025-26 test season + this season's finished games against the saved bb-v3 chances). */
export function v4Gate(rows: RRow[], p: V4Params, live: Map<number, number>, liveSeasons: string[]): Gate {
  const test = rows.filter(r => r.season === V4_TEST_SEASON), first = test.filter(r => r.gp < 25);
  const sc = (rr: RRow[], f: (r: RRow) => number) => scoreP(rr.map(f), rr.map(r => r.y));
  const whole = { v3: sc(test, r => r.v3), v4: sc(test, r => rowP(p, r)) }, f25 = { v3: sc(first, r => r.v3), v4: sc(first, r => rowP(p, r)) };
  const lr = rows.filter(r => liveSeasons.includes(r.season) && r.rs && live.has(r.id));
  const lv = { v3: sc(lr, r => live.get(r.id)!), v4: sc(lr, r => rowP(p, r)) };
  const passWhole = test.length >= 500 && whole.v4.logLoss <= whole.v3.logLoss, passFirst25 = first.length >= 100 && f25.v4.logLoss < f25.v3.logLoss;
  const livePass = lr.length >= 20 && lv.v4.logLoss < lv.v3.logLoss;
  const pass = passWhole && passFirst25 && livePass;
  const why = [!passWhole && `2025-26 whole season ${whole.v4.logLoss} vs ${whole.v3.logLoss}`, !passFirst25 && `games 1–25 ${f25.v4.logLoss} vs ${f25.v3.logLoss}`,
    !livePass && (lr.length < 20 ? `only ${lr.length} finished games this season (20 needed)` : `this season ${lv.v4.logLoss} vs ${lv.v3.logLoss}`)].filter(Boolean);
  const known = test.filter(r => r.known !== null);
  return {
    at: new Date().toISOString(), pass, reason: pass ? 'v4 passes every test' : `re-pricing only: ${why.join('; ')}`,
    test: { season: V4_TEST_SEASON, whole, first25: f25, withLineups: { v3: sc(known, r => r.v3), v4: sc(known, r => rowP(p, r, true)) }, passWhole, passFirst25 },
    live: { games: lr.length, ...lv, pass: livePass, note: lr.length < 20 ? 'needs 20 finished games' : 'saved bb-v3 chances (with its injury list) against v4 without same-day information' }
  };
}

/** bb model thread: the v4 replay, gate and live state (after buildLeague('NBA')). */
export async function buildNbaV4(base: Map<number, RBase>): Promise<{ gate: Gate | null; rows: number } | null> {
  if (!base.size) return null;
  const t0 = Date.now();
  const { games, lines, names } = loadNba();
  await yieldLoop();
  const p = V4_TUNED;
  const { rows, state } = await replayV4(games, lines, base, p, yieldLoop);
  await yieldLoop();
  const now = Date.now();
  const seasons = [...new Set(games.filter(g => g.ms <= now).map(g => g.season))].sort();
  const liveSeasons = seasons.filter(s => s > V4_TEST_SEASON);
  const live = currentModelP(rows.filter(r => liveSeasons.includes(r.season)).map(r => r.id));
  const gate = rows.length ? v4Gate(rows, p, live, liveSeasons) : null;
  // what the tuner would choose on this database (shown on the admin page, never applied by itself)
  let suggested: V4Params | null = null;
  try { suggested = tuneV4(rows, p); } catch (e: any) { logger.warn(`bb-v4 tuner: ${e.message}`); }
  const proj = new Map<number, number>();
  for (const [id] of names) { const m = projMinutes(state.rs.get(id), state.preSeason ? state.pre.get(id) : undefined); if (m !== null) proj.set(id, Math.round(m * 10) / 10); }
  // names only for the players the live predictions can meet (rosters) and the rated ones
  const keepNames = new Map<number, string>();
  for (const ids of state.rosters.values()) for (const id of ids) if (names.has(id)) keepNames.set(id, names.get(id)!);
  const s: State = {
    ratings: state.ratings, proj, names: keepNames, rosters: state.rosters, gp: state.gp, fitAt: state.fitAt, fitPlayers: state.fitPlayers,
    fitGames: state.fitGames, params: p, gate, suggested, builtAt: new Date().toISOString()
  };
  st = s; ver++; // (one process / THREAD_JOBS=0: publishState doesn't apply here)
  publishState('bb:v4', s);
  logger.info(`bb-v4: ${rows.length} replay games, fit ${state.fitPlayers} players / ${state.fitGames} games, gate ${gate?.pass ? 'pass' : 'fail'} (${gate?.reason}), ${Date.now() - t0} ms`);
  return { gate, rows: rows.length };
}

/* ---------- same-day information ---------- */

/** keep share per player from the injury report (matched by name to our box-score names) */
function injuryKeep(teamName: string, roster: number[], names: Map<number, string>): Map<number, { keep: number; status: string }> {
  const out = new Map<number, { keep: number; status: string }>();
  const inj = db.prepare(`SELECT player, status FROM bb_injuries WHERE team = ?`).all(nbaKey(teamName)) as any[];
  if (!inj.length) return out;
  const byKey = new Map<string, number>();
  for (const id of roster) { const n = names.get(id); if (n) byKey.set(playerKey(n), id); }
  for (const x of inj) {
    const id = byKey.get(playerKey(x.player));
    if (id === undefined) continue;
    const k = statusKeep(x.status);
    if (k < 1) out.set(id, { keep: k, status: String(x.status) });
  }
  return out;
}

/** confirmed line-up of a team for a game (bb_v4_lineups: [{ name, starter }]) → our player ids */
function lineupOf(gameId: number, teamId: number, roster: number[], names: Map<number, string>): { ids: Set<number>; starters: Set<number>; size: number } | null {
  const r = db.prepare(`SELECT players FROM bb_v4_lineups WHERE game_id = ? AND team_id = ?`).get(gameId, teamId) as any;
  if (!r) return null;
  let list: { name: string; starter: boolean }[] = [];
  try { list = JSON.parse(r.players); } catch { return null; }
  const byKey = new Map<string, number>();
  for (const id of roster) { const n = names.get(id); if (n) byKey.set(playerKey(n), id); }
  const ids = new Set<number>(), starters = new Set<number>();
  for (const p of list) { const id = byKey.get(playerKey(p.name)); if (id === undefined) continue; ids.add(id); if (p.starter) starters.add(id); }
  return { ids, starters, size: list.length };
}

export type V4Side = { strength: number; sameDay: number; removed: { id: number; name: string; status: string; min: number; keep: number }[]; lineup: boolean };
function sideOf(s: State, gameId: number, teamId: number, teamName: string): V4Side {
  const roster = s.rosters.get(teamId) || [];
  const players: RotPlayer[] = [];
  for (const id of roster) { const m = s.proj.get(id); if (m) players.push({ id, min: m, rating: s.ratings.get(id) ?? s.params.rookie }); }
  const base = strength(rotation(players));
  const keep = new Map<number, number>(), why = new Map<number, string>();
  for (const [id, x] of injuryKeep(teamName, roster, s.names)) { keep.set(id, x.keep); why.set(id, x.status); }
  // fix224: star-rest pattern (2nd night of a back-to-back / 3-in-4) for players not on the report, until it confirms
  const listed = new Set((db.prepare(`SELECT player FROM bb_injuries WHERE team = ?`).all(nbaKey(teamName)) as any[]).map(x => playerKey(x.player)));
  const ko = (db.prepare(`SELECT kickoff FROM bb_games WHERE game_id = ?`).get(gameId) as any)?.kickoff ?? null;
  for (const [id, r] of nbaRestKeep(gameId, teamId, ko)) {
    const n = s.names.get(id);
    if (keep.has(id) || (n && listed.has(playerKey(n))) || !roster.includes(id)) continue;
    keep.set(id, r.keep); why.set(id, `rest pattern (${r.kind})`);
  }
  const lu = lineupOf(gameId, teamId, roster, s.names);
  let lineup = false;
  if (lu && lu.starters.size >= 5) {
    lineup = true;
    for (const id of lu.starters) { keep.set(id, 1); why.delete(id); } // a confirmed starter plays
    // a full list (starters + bench): a roster player who isn't on it doesn't play
    if (lu.size >= 10) for (const p of players) if (!lu.ids.has(p.id) && !keep.has(p.id)) { keep.set(p.id, 0); why.set(p.id, 'not in the line-up'); }
  }
  const after = strength(rotation(players, keep));
  const removed = players.filter(p => keep.has(p.id) && keep.get(p.id)! < 1)
    .map(p => ({ id: p.id, name: s.names.get(p.id) || String(p.id), status: why.get(p.id) || '', min: Math.round(p.min * 10) / 10, keep: keep.get(p.id)! }))
    .sort((a, b) => b.min - a.min);
  return { strength: base, sameDay: after - base, removed, lineup };
}

/** points: what the same-day information costs each side, in margin points (the game page's injury numbers) */
export type V4Result = { model: string; mode: V4Mode; pHome: number; margin: number; impact: number; sameDay: number; home: V4Side; away: V4Side; points: { home: number; away: number } };
/**
 * v4 for an upcoming NBA game from bb-v3's chance (without bb-v3's own injury points: v4 prices the injury report itself).
 * null = v4 off or not built yet (bb-v3 and its injury handling stay).
 */
export function nbaV4Adjust(g: { game_id: number; season: string; home_id: number; away_id: number; home_name?: string; away_name?: string }, v3p: number, b2bHome: boolean, b2bAway: boolean): V4Result | null {
  const mode = nbaV4Mode();
  if (mode === 'off' || !st || !g.home_name || !g.away_name) return null;
  const s = st;
  const h = sideOf(s, g.game_id, g.home_id, g.home_name), a = sideOf(s, g.game_id, g.away_id, g.away_name);
  const impact = h.strength - a.strength, sameDay = h.sameDay - a.sameDay;
  const gp = Math.min(s.gp.get(`${g.home_id}|${g.season}`) || 0, s.gp.get(`${g.away_id}|${g.season}`) || 0);
  const r = mode === 'full'
    ? v4Margin(s.params, { teamMargin: TEAM_SCALE * probit(v3p), impactMargin: impact, sameDay, b2bHome, b2bAway, gamesPlayed: gp })
    : repriceOnly(s.params, v3p, sameDay);
  const pts = (x: V4Side) => Math.round(Math.max(0, -s.params.wSame * x.sameDay) * 10) / 10;
  return { model: mode === 'full' ? NBA_V4_MODEL : 'bb-v3', mode, pHome: r.pHome, margin: r.margin, impact, sameDay, home: h, away: a, points: { home: pts(h), away: pts(a) } };
}

/** fix219: both teams' same-day sides (injury report + line-ups) for the bb-v4 grid's #4 (null = no v4 state yet) */
export function nbaSameDay(g: { game_id: number; home_id: number; away_id: number; home_name?: string; away_name?: string }): { home: V4Side; away: V4Side } | null {
  if (!st || !g.home_name || !g.away_name || String(process.env.NBA_V4 || '').toLowerCase() === 'off') return null;
  return { home: sideOf(st, g.game_id, g.home_id, g.home_name), away: sideOf(st, g.game_id, g.away_id, g.away_name) };
}

/** recordBbPredictions: both chances of each NBA game until tip-off (daily report "v4 vs current", 2 weeks). */
export function saveShadow(rows: { game_id: number; kickoff: string; mode: string; p_v3: number; p_v4: number }[]) {
  if (!rows.length) return;
  const up = db.prepare(`INSERT OR REPLACE INTO bb_v4_shadow (game_id, kickoff, mode, p_v3, p_v4, made_at) VALUES (?, ?, ?, ?, ?, ?)`);
  const now = new Date().toISOString();
  for (const r of rows) up.run(r.game_id, r.kickoff, r.mode, r.p_v3, r.p_v4, now);
}

/* ---------- re-pricing before tip-off (worker, every minute) ---------- */

/** The checkpoint due for a game now (the latest one passed and not done), or null. */
export function dueCheckpoint(kickoffMs: number, now: number, done: Set<string>): string | null {
  if (now >= kickoffMs) return null;
  let due: string | null = null;
  for (const m of CHECKPOINTS) if (now >= kickoffMs - m * 60000) due = String(m);
  return due && !done.has(due) ? due : null;
}

/** balldontlie line-ups for a game, when it has them (often only after tip-off); stored for sideOf. */
async function fetchLineups(g: any): Promise<boolean> {
  if (!process.env.BALLDONTLIE_KEY) return false;
  const teams = db.prepare(`SELECT id, key FROM bdl_teams`).all() as any[];
  const tid = (name: string) => teams.find(t => t.key === nbaKey(name))?.id;
  const h = tid(g.home_name), a = tid(g.away_name);
  if (!h || !a) return false;
  const day = (d: number) => new Date(Date.parse(g.kickoff) + d * 86400000).toISOString().slice(0, 10);
  const bg = db.prepare(`SELECT id FROM bdl_games WHERE home_id = ? AND away_id = ? AND date BETWEEN ? AND ? ORDER BY date LIMIT 1`).get(h, a, day(-1), day(1)) as any;
  if (!bg) return false;
  const j = await bdlGet('/v1/lineups', { 'game_ids[]': String(bg.id) });
  const rows: any[] = Array.isArray(j?.data) ? j.data : [];
  if (!rows.length) return false;
  const by = new Map<number, { name: string; starter: boolean }[]>();
  for (const x of rows) {
    const team = Number(x.team?.id ?? x.team_id), p = x.player || {};
    const name = `${p.first_name || ''} ${p.last_name || ''}`.trim();
    if (!team || !name) continue;
    let l = by.get(team); if (!l) by.set(team, (l = [])); l.push({ name, starter: !!x.starter });
  }
  const up = db.prepare(`INSERT OR REPLACE INTO bb_v4_lineups (game_id, team_id, players, at) VALUES (?, ?, ?, ?)`);
  const now = new Date().toISOString();
  let n = 0;
  for (const [bdlTeam, ours] of [[h, g.home_id], [a, g.away_id]] as [number, number][]) { const l = by.get(bdlTeam); if (l && l.length >= 5) { up.run(g.game_id, ours, JSON.stringify(l), now); n++; } }
  return n > 0;
}

let lineupsOffUntil = 0;
let repricing = false;
/**
 * Every minute: NBA games starting in the next 90 minutes whose checkpoint (90 / 30 / 10 min) is due get a fresh
 * injury report (one call for all of them, skipped when the last is under 4 min old) and line-ups, then their
 * prediction is saved again and the move logged. `price` re-saves the given games (recordBbPredictions) and returns
 * each game's v3 / v4 numbers.
 */
export async function nbaRepriceTick(price: (ids: number[]) => Promise<Map<number, { v3: number; v4: V4Result | null }>>, now = Date.now()) {
  if (repricing || nbaV4Mode() === 'off') return { games: 0 };
  repricing = true;
  try {
    const soon = db.prepare(`SELECT game_id, season, kickoff, home_id, away_id, home_name, away_name FROM bb_games WHERE code = 'NBA' AND (status IS NULL OR status = 'NS') AND kickoff > ? AND kickoff <= ? ORDER BY kickoff`)
      .all(new Date(now).toISOString(), new Date(now + (CHECKPOINTS[0] + 1) * 60000).toISOString()) as any[];
    const due: { g: any; cp: string }[] = [];
    for (const g of soon) {
      const done = new Set((db.prepare(`SELECT checkpoint FROM bb_v4_log WHERE game_id = ?`).all(g.game_id) as any[]).map(r => String(r.checkpoint)));
      const cp = dueCheckpoint(Date.parse(g.kickoff), now, done);
      if (cp) due.push({ g, cp });
    }
    if (!due.length) return { games: 0 };
    const inj = nbaInjuryStatus();
    if (!inj.lastFetch || now - Date.parse(inj.lastFetch) > 4 * 60000) await refreshNbaInjuries();
    let lineups = 0;
    if (Date.now() > lineupsOffUntil) {
      for (const { g } of due) {
        try { if (await fetchLineups(g)) lineups++; } catch (e: any) {
          if (/HTTP (401|403|404)/.test(e.message)) { lineupsOffUntil = Date.now() + 6 * 3600 * 1000; logger.info(`bb-v4 line-ups: ${e.message} (next try in 6 h)`); break; }
          logger.warn(`bb-v4 line-ups: ${e.message}`);
        }
      }
    }
    const before = new Map<number, number | null>();
    for (const { g } of due) { const r = db.prepare(`SELECT margin FROM bb_predictions WHERE game_id = ?`).get(g.game_id) as any; before.set(g.game_id, r ? r.margin : null); }
    const res = await price(due.map(d => d.g.game_id));
    const ins = db.prepare(`INSERT OR REPLACE INTO bb_v4_log (game_id, checkpoint, at, mode, p_v3, p_v4, margin_before, margin_after, same_day, removed, lineups, injuries_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const at = new Date().toISOString(), injAt = nbaInjuryStatus().lastFetch;
    for (const { g, cp } of due) {
      const x = res.get(g.game_id);
      if (!x || !x.v4) continue;
      const v = x.v4;
      const removed = { home: v.home.removed, away: v.away.removed, lineupHome: v.home.lineup, lineupAway: v.away.lineup };
      ins.run(g.game_id, cp, at, v.mode, x.v3, v.pHome, before.get(g.game_id) ?? null, v.margin, v.sameDay, JSON.stringify(removed), v.home.lineup || v.away.lineup ? 1 : 0, injAt);
    }
    return { games: due.length, lineups };
  } finally { repricing = false; }
}

/* ---------- admin: NBA model check ---------- */

const r4 = (x: number | null | undefined) => (x === null || x === undefined ? null : Math.round(x * 10000) / 10000);
export function nbaV4Check(days = 14) {
  const s = st;
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const log = (db.prepare(`SELECT l.*, g.kickoff, g.home_name, g.away_name, g.hs, g.as_, g.status FROM bb_v4_log l JOIN bb_games g ON g.game_id = l.game_id WHERE g.kickoff > ? ORDER BY g.kickoff DESC, l.checkpoint DESC LIMIT 600`).all(since) as any[])
    .map(r => ({ gameId: r.game_id, kickoff: r.kickoff, home: r.home_name, away: r.away_name, score: r.hs !== null && ['FT', 'AOT'].includes(r.status) ? `${r.hs}–${r.as_}` : null, checkpoint: r.checkpoint, at: r.at, mode: r.mode, pV3: r4(r.p_v3), pV4: r4(r.p_v4), marginBefore: r.margin_before === null ? null : Math.round(r.margin_before * 10) / 10, marginAfter: Math.round(r.margin_after * 10) / 10, sameDay: Math.round(r.same_day * 10) / 10, removed: (() => { try { return JSON.parse(r.removed || 'null'); } catch { return null; } })(), lineups: !!r.lineups, injuriesAt: r.injuries_at }));
  const top = s ? [...s.ratings.entries()].filter(([id]) => s.names.has(id)).sort((a, b) => b[1] - a[1]) : [];
  return {
    mode: nbaV4Mode(), override: process.env.NBA_V4 || null, built: s?.builtAt || null, params: s?.params || V4_TUNED, suggested: s?.suggested || null,
    fit: s ? { at: s.fitAt ? new Date(s.fitAt).toISOString() : null, players: s.fitPlayers, games: s.fitGames } : null,
    gate: s?.gate || null, side: sideBySide(),
    best: top.slice(0, 15).map(([id, v]) => ({ id, name: s!.names.get(id), rating: Math.round(v * 10) / 10, minutes: s!.proj.get(id) ?? null })),
    log
  };
}

/** v4 against the current model on finished games with both chances saved (shadow table). */
/** (fix219: one league, NBA by default — the shadow table holds every league's bb-v4 games) */
export function sideBySide(sinceIso?: string, code = 'NBA') {
  const rows = db.prepare(`SELECT s.p_v3, s.p_v4, g.hs, g.as_ FROM bb_v4_shadow s JOIN bb_games g ON g.game_id = s.game_id WHERE g.code = ? AND g.status IN ('FT','AOT') AND g.hs IS NOT NULL${sinceIso ? ' AND g.kickoff >= ?' : ''}`).all(code, ...(sinceIso ? [sinceIso] : [])) as any[];
  const ys = rows.map(r => (r.hs > r.as_ ? 1 : 0));
  return { games: rows.length, current: scoreP(rows.map(r => r.p_v3), ys), v4: scoreP(rows.map(r => r.p_v4), ys) };
}

/** Daily model report lines: v4 vs current for 2 weeks after the first shadow row. */
export function nbaV4ReportLines(now = Date.now()): string[] {
  const first = db.prepare(`SELECT MIN(s.made_at) AS t FROM bb_v4_shadow s JOIN bb_games g ON g.game_id = s.game_id WHERE g.code = 'NBA'`).get() as any;
  if (!first?.t || now - Date.parse(first.t) > 15 * 86400000) return [];
  const y = sideBySide(new Date(now - 86400000).toISOString().slice(0, 10)), all = sideBySide();
  const f = (x: any) => (x.games ? `log loss ${x.logLoss.toFixed(3)}, Brier ${x.brier.toFixed(3)}, ${x.hitRate}% right` : 'n/a');
  return [
    `NBA v4 (mode ${nbaV4Mode()}) vs current bb-v3, side by side until ${new Date(Date.parse(first.t) + 14 * 86400000).toISOString().slice(0, 10)}:`,
    `  yesterday ${y.games} games — v4: ${f(y.v4)} · current: ${f(y.current)}`,
    `  since start ${all.games} games — v4: ${f(all.v4)} · current: ${f(all.current)}`
  ];
}
