/**
 * Your picks (Oct 2026): every signed-in account (Free included) can pick for any game we predict, and builds a
 * personal record.
 *
 * Football: winner (home / draw / away), over / under 2.5 goals, both teams to score (yes / no).
 * Basketball: winner (home / away), over / under total points. NFL + college football (fix144): winner only (no spread).
 * Basketball: over / under total points. The total line is not our model's number (that one
 * is for paying members): it is the average total of both teams' last 10 games, rounded to .5, and each pick keeps the
 * line it was made at.
 *
 * Picks can be changed or removed until kick-off / tip-off; after that they are locked. They never unlock or reveal
 * our own prediction. Results are worked out when read, from the same final scores as our record:
 *   football  → the `results` table (cancelled / abandoned games are void),
 *   basketball → `bb_games` FT / AOT (a score under review is still pending; cancelled / postponed is void).
 */
import { db } from '../db';
import { bbPublic } from './bbSite';
import { nflPublic } from './nflSite';

db.exec(`
  CREATE TABLE IF NOT EXISTS user_picks (
    user_id INTEGER NOT NULL, sport TEXT NOT NULL, game_id INTEGER NOT NULL, market TEXT NOT NULL, pick TEXT NOT NULL,
    line REAL, kickoff TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, sport, game_id, market)
  );
  CREATE INDEX IF NOT EXISTS idx_user_picks_user ON user_picks(user_id, kickoff);
`);

export class PickError extends Error { constructor(public status: number, msg: string) { super(msg); } }

export type Sport = 'fb' | 'bb' | 'nfl';
const MARKETS: Record<Sport, Record<string, string[]>> = {
  fb: { result: ['H', 'D', 'A'], ou25: ['O', 'U'], btts: ['Y', 'N'] },
  bb: { win: ['H', 'A'], total: ['O', 'U'] },
  nfl: { win: ['H', 'A'] }
};
const NFL_VOID = ['CANC', 'PST'];
const BB_DONE = ['FT', 'AOT'];
const BB_VOID = ['CANC', 'POST', 'ABD', 'AWD'];

interface GameInfo { kickoff: string; home: string; away: string; league: string; line?: number | null; finished: boolean }

function fbGame(id: number): GameInfo | null {
  const r = db.prepare(`SELECT utc_date, home_team, away_team, competition_name FROM predictions WHERE match_id = ? ORDER BY updated_at DESC LIMIT 1`).get(id) as any;
  if (!r) return null;
  const res = db.prepare('SELECT 1 FROM results WHERE match_id = ?').get(id);
  return { kickoff: r.utc_date, home: r.home_team, away: r.away_team, league: r.competition_name || '', finished: !!res };
}

/** Average total points of a team's last 10 finished games before `before`. */
function teamAvgTotal(teamId: number, before: string): number | null {
  const rows = db.prepare(`SELECT hs + as_ AS t FROM bb_games WHERE (home_id = ? OR away_id = ?) AND status IN ('FT','AOT') AND hs IS NOT NULL AND kickoff < ? ORDER BY kickoff DESC LIMIT 10`)
    .all(teamId, teamId, before) as any[];
  if (rows.length < 3) return null;
  return rows.reduce((a, r) => a + r.t, 0) / rows.length;
}

function bbGame(id: number): GameInfo | null {
  const g = db.prepare(`SELECT g.kickoff, g.status, g.home_id, g.away_id, g.home_name, g.away_name, g.code, l.name AS league FROM bb_games g LEFT JOIN bb_leagues l ON l.code = g.code WHERE g.game_id = ?`).get(id) as any;
  if (!g) return null;
  const a = teamAvgTotal(g.home_id, g.kickoff), b = teamAvgTotal(g.away_id, g.kickoff);
  const line = a !== null && b !== null ? Math.floor((a + b) / 2) + 0.5 : null;
  return { kickoff: g.kickoff, home: g.home_name, away: g.away_name, league: g.league || g.code, line, finished: BB_DONE.includes(g.status) };
}

function nflGame(id: number): GameInfo | null {
  const g = db.prepare(`SELECT kickoff, status, home_name, away_name, league, week FROM nfl_games WHERE game_id = ?`).get(id) as any;
  if (!g) return null;
  return { kickoff: g.kickoff, home: g.home_name || 'TBD', away: g.away_name || 'TBD', league: g.league === 2 ? 'College football' : 'NFL', finished: BB_DONE.includes(g.status) };
}

const gameInfo = (sport: Sport, id: number) => (sport === 'fb' ? fbGame(id) : sport === 'nfl' ? nflGame(id) : bbGame(id));
const started = (kickoff: string) => new Date(kickoff).getTime() <= Date.now();

/** 'hit' | 'miss' | 'void' | 'pending' for one pick. */
function outcomeOf(sport: Sport, gameId: number, market: string, pick: string, line: number | null): 'hit' | 'miss' | 'void' | 'pending' {
  if (sport === 'fb') {
    const r = db.prepare('SELECT outcome, home_goals AS h, away_goals AS a FROM results WHERE match_id = ?').get(gameId) as any;
    if (!r) return 'pending';
    if (r.outcome === 'VOID' || r.h === null || r.a === null) return 'void';
    if (market === 'result') return pick === r.outcome ? 'hit' : 'miss';
    if (market === 'ou25') return (r.h + r.a > 2.5) === (pick === 'O') ? 'hit' : 'miss';
    if (market === 'btts') return (r.h > 0 && r.a > 0) === (pick === 'Y') ? 'hit' : 'miss';
    return 'void';
  }
  if (sport === 'nfl') {
    const n = db.prepare('SELECT status, home_pts AS hs, away_pts AS as_ FROM nfl_games WHERE game_id = ?').get(gameId) as any;
    if (!n || NFL_VOID.includes(n.status)) return 'void';
    if (!BB_DONE.includes(n.status) || n.hs === null) return 'pending';
    if (n.hs === n.as_) return 'void'; // a tie: nobody won
    return (n.hs > n.as_ ? 'H' : 'A') === pick ? 'hit' : 'miss';
  }
  const g = db.prepare('SELECT status, hs, as_ FROM bb_games WHERE game_id = ?').get(gameId) as any;
  if (!g) return 'void';
  if (BB_VOID.includes(g.status)) return 'void';
  if (!BB_DONE.includes(g.status) || g.hs === null) return 'pending';
  try { if (db.prepare('SELECT 1 FROM bb_result_check WHERE game_id = ? AND resolved_at IS NULL').get(gameId)) return 'pending'; } catch { /* table missing */ }
  if (market === 'win') return (g.hs > g.as_ ? 'H' : 'A') === pick ? 'hit' : 'miss';
  if (market === 'total') { if (line === null) return 'void'; return (g.hs + g.as_ > line) === (pick === 'O') ? 'hit' : 'miss'; }
  return 'void';
}

function checkSport(sport: string, access: string): Sport {
  if (sport !== 'fb' && sport !== 'bb' && sport !== 'nfl') throw new PickError(400, 'Unknown sport.');
  if (sport === 'bb' && !bbPublic() && access !== 'admin') throw new PickError(404, 'Not found.');
  if (sport === 'nfl' && !nflPublic() && access !== 'admin') throw new PickError(404, 'Not found.');
  return sport;
}

/** The pick card for one game: markets, the user's picks (if signed in), lock state and results. */
export function gamePicks(userId: number | null, sportIn: string, gameId: number, access: string) {
  const sport = checkSport(sportIn, access);
  const g = gameInfo(sport, gameId);
  if (!g) return { available: false };
  const locked = started(g.kickoff);
  const rows = userId ? (db.prepare('SELECT market, pick, line FROM user_picks WHERE user_id = ? AND sport = ? AND game_id = ?').all(userId, sport, gameId) as any[]) : [];
  const picks: Record<string, { pick: string; line: number | null; result: string }> = {};
  for (const r of rows) picks[r.market] = { pick: r.pick, line: r.line, result: outcomeOf(sport, gameId, r.market, r.pick, r.line) };
  const markets = Object.keys(MARKETS[sport]).filter(m => !(sport === 'bb' && m === 'total' && g.line == null && !picks.total));
  return { available: true, sport, kickoff: g.kickoff, locked, line: sport === 'bb' ? g.line ?? null : null, markets, picks };
}

/** Make, change or clear (pick = null) one pick. Only before kick-off. */
export function setPick(userId: number, sportIn: string, gameId: number, market: string, pick: string | null, access: string) {
  const sport = checkSport(sportIn, access);
  const allowed = MARKETS[sport][market];
  if (!allowed) throw new PickError(400, 'Unknown pick type.');
  if (pick !== null && !allowed.includes(pick)) throw new PickError(400, 'Unknown choice.');
  const g = gameInfo(sport, gameId);
  if (!g) throw new PickError(404, 'Picks are not available for this game.');
  if (started(g.kickoff) || g.finished) throw new PickError(409, 'This game has started: picks are locked.');
  const now = new Date().toISOString();
  if (pick === null) {
    db.prepare('DELETE FROM user_picks WHERE user_id = ? AND sport = ? AND game_id = ? AND market = ?').run(userId, sport, gameId, market);
  } else {
    const line = sport === 'bb' && market === 'total' ? g.line ?? null : null;
    if (sport === 'bb' && market === 'total' && line === null) throw new PickError(400, 'No points line for this game yet.');
    db.prepare(`INSERT INTO user_picks (user_id, sport, game_id, market, pick, line, kickoff, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, sport, game_id, market) DO UPDATE SET pick = excluded.pick, line = excluded.line, kickoff = excluded.kickoff, updated_at = excluded.updated_at`)
      .run(userId, sport, gameId, market, pick, line, g.kickoff, now, now);
  }
  return gamePicks(userId, sport, gameId, access);
}

/** The personal record: hit rate per sport and pick type, plus the latest picks. */
export function personalRecord(userId: number, access: string) {
  const showBb = bbPublic() || access === 'admin';
  const showNfl = nflPublic() || access === 'admin';
  const rows = db.prepare(`SELECT sport, game_id, market, pick, line, kickoff, updated_at FROM user_picks WHERE user_id = ? ORDER BY kickoff DESC LIMIT 2000`).all(userId) as any[];
  const games = new Map<string, GameInfo | null>();
  const stats: Record<string, { picks: number; settled: number; hits: number; pending: number; void: number }> = {};
  const list: any[] = [];
  let streak = 0, streakOpen = true;
  for (const r of rows) {
    if (r.sport === 'bb' && !showBb) continue;
    if (r.sport === 'nfl' && !showNfl) continue;
    const key = `${r.sport}:${r.game_id}`;
    if (!games.has(key)) games.set(key, gameInfo(r.sport, r.game_id));
    const g = games.get(key);
    const result = outcomeOf(r.sport, r.game_id, r.market, r.pick, r.line);
    const s = (stats[`${r.sport}:${r.market}`] ||= { picks: 0, settled: 0, hits: 0, pending: 0, void: 0 });
    s.picks++;
    if (result === 'pending') s.pending++;
    else if (result === 'void') s.void++;
    else { s.settled++; if (result === 'hit') s.hits++; }
    // current streak of correct picks, newest settled first
    if (streakOpen && (result === 'hit' || result === 'miss')) { if (result === 'hit') streak++; else streakOpen = false; }
    // fix200: a void game (cancelled, never played) is left out of the history (never a loss)
    if (list.length < 300 && result !== 'void') list.push({ sport: r.sport, gameId: r.game_id, market: r.market, pick: r.pick, line: r.line, kickoff: r.kickoff, result,
      home: g?.home || null, away: g?.away || null, league: g?.league || null });
  }
  const total = Object.values(stats).reduce((a, s) => ({ picks: a.picks + s.picks, settled: a.settled + s.settled, hits: a.hits + s.hits, pending: a.pending + s.pending }), { picks: 0, settled: 0, hits: 0, pending: 0 });
  // fix144: the record per sport too (My picks has a sport filter)
  const bySport: Record<string, { picks: number; settled: number; hits: number; pending: number }> = {};
  for (const [k, s] of Object.entries(stats)) { const sp = k.split(':')[0]; const b = (bySport[sp] ||= { picks: 0, settled: 0, hits: 0, pending: 0 }); b.picks += s.picks; b.settled += s.settled; b.hits += s.hits; b.pending += s.pending; }
  return { total, streak, stats, bySport, list, basketball: showBb, nfl: showNfl };
}
