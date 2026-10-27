/**
 * Upset watch for the sports where the pick is the winner (fix144: basketball, NFL + college football; fix193: tennis).
 * fix242: the same rule and report as football's (utils/upsetWatch.ts): the favourite 50%+, the underdog 25%+ and a
 * clear reason — from the teams' own finished games (form, rest, the favourite's away record, the season table or
 * ranking, head-to-head) and the injury reports (NBA, NFL) — 10 per week shown, the last 30 days' record. Saved
 * predictions only (made before tip-off / kick-off). Model only: no bookmakers. No draws in these sports.
 */
import { db } from '../db';
import { isPreseason } from './bbModel';
import { BB_LEAGUES } from './basketball';
import { injuryLossDetail } from './bbInjuries';
import { nflKeyPlayers } from './nflGameExtras';
import { MATCH_COLS, MATCH_PUBLIC, shapeMatch, tierLabel } from './tennisSite';
import { historySignals, historyStature, watchReport, type Candidate, type HistoryInput, type Past, type Side } from '../utils/upsetWatch';

export type WinnerSport = 'basketball' | 'american-football' | 'tennis';
const DAY = 86400000;

interface Row {
  id: number; league: string; code?: string; tier: number; date: string; home: string; away: string; homeId: number | null; awayId: number | null
  homeLogo: string | null; awayLogo: string | null; pHome: number; hs: number | null; as_: number | null
  ranks?: { H: number | null; A: number | null }; season?: number
}

/* ---------- each sport's games ---------- */

const BB_TOP = new Set(['NBA', 'EL']);
/** basketball tier: NBA / EuroLeague, then the leagues we started with, then those added from Admin */
const bbTier = (code: string) => (BB_TOP.has(code) ? 1 : BB_LEAGUES.slice(0, 18).some(l => l.code === code) ? 2 : 3);

function bbRows(upcoming: boolean, now: number): Row[] {
  const nowIso = new Date(now).toISOString(), soon = new Date(now + 7 * DAY).toISOString(), since = new Date(now - 31 * DAY).toISOString();
  const COLS = `p.game_id, p.code, p.kickoff, p.p_home, g.home_id, g.away_id, g.home_name, g.away_name, g.home_logo, g.away_logo, g.hs, g.as_, g.status, l.name AS league`;
  const FROM = `FROM bb_predictions p JOIN bb_games g ON g.game_id = p.game_id LEFT JOIN bb_leagues l ON l.code = p.code`;
  const rows = (upcoming
    ? db.prepare(`SELECT ${COLS} ${FROM} WHERE p.kickoff > ? AND p.kickoff < ? AND (g.status IS NULL OR g.status = 'NS')`).all(nowIso, soon)
    : db.prepare(`SELECT ${COLS} ${FROM}
        WHERE g.status IN ('FT','AOT') AND g.hs IS NOT NULL AND p.made_at <= p.kickoff AND p.kickoff > ? AND p.kickoff <= ?
          AND p.game_id NOT IN (SELECT game_id FROM bb_result_check WHERE resolved_at IS NULL OR voided = 1)`).all(since, nowIso)) as any[];
  // pre-season games stay out (as in the basketball record)
  return rows.filter(r => !isPreseason({ code: r.code, kickoff: r.kickoff })).map(r => ({
    id: r.game_id, league: r.league || r.code, code: r.code, tier: bbTier(r.code), date: r.kickoff, home: r.home_name, away: r.away_name, homeId: r.home_id, awayId: r.away_id,
    homeLogo: r.home_logo || null, awayLogo: r.away_logo || null, pHome: r.p_home, hs: r.hs, as_: r.as_
  }));
}

function nflRows(upcoming: boolean, now: number): Row[] {
  const nowIso = new Date(now).toISOString(), soon = new Date(now + 7 * DAY).toISOString(), since = new Date(now - 31 * DAY).toISOString();
  const COLS = `p.game_id, p.kickoff, p.p_home, g.league, g.season, g.week, g.stage, g.home_id, g.away_id, g.home_name, g.away_name, g.home_logo, g.away_logo, g.home_pts, g.away_pts, g.status`;
  const rows = (upcoming
    ? db.prepare(`SELECT ${COLS} FROM nfl_predictions p JOIN nfl_games g ON g.game_id = p.game_id WHERE p.kickoff > ? AND p.kickoff < ? AND (g.status IS NULL OR g.status = 'NS')`).all(nowIso, soon)
    : db.prepare(`SELECT ${COLS} FROM nfl_predictions p JOIN nfl_games g ON g.game_id = p.game_id
        WHERE g.status IN ('FT','AOT') AND g.home_pts IS NOT NULL AND g.home_pts != g.away_pts AND p.made_at <= p.kickoff AND p.kickoff > ? AND p.kickoff <= ?`).all(since, nowIso)) as any[];
  return rows.map(r => ({
    id: r.game_id, league: `${r.league === 2 ? 'College football' : 'NFL'}${r.week ? ` · ${/post/i.test(r.stage || '') ? (r.league === 2 ? 'Bowls' : 'Playoffs') : String(r.week).replace(/^(\d+)$/, 'Week $1')}` : ''}`,
    tier: r.league === 2 ? 2 : 1, date: r.kickoff, home: r.home_name || 'TBD', away: r.away_name || 'TBD', homeId: r.home_id, awayId: r.away_id,
    homeLogo: r.home_logo || null, awayLogo: r.away_logo || null, pHome: r.p_home, hs: r.home_pts, as_: r.away_pts, season: r.season
  }));
}

/** fix193: tennis — player 1 = "home"; ITF and walkovers / unfinished matches left out; the record from saved predictions */
function tennisRows(upcoming: boolean, now: number): Row[] {
  const nowIso = new Date(now).toISOString(), soon = new Date(now + 7 * DAY).toISOString(), since = new Date(now - 31 * DAY).toISOString();
  const FROM = `FROM tennis_predictions p JOIN tennis_matches m ON m.id = p.match_id
        LEFT JOIN tennis_players p1 ON p1.id = m.p1_id LEFT JOIN tennis_players p2 ON p2.id = m.p2_id LEFT JOIN tennis_tournaments t ON t.id = m.tournament_id`;
  const rows = (upcoming
    ? db.prepare(`SELECT p.p1, p.made_at, p.scheduled_at AS pat, ${MATCH_COLS} ${FROM}
        WHERE p.scheduled_at > ? AND p.scheduled_at < ? AND m.status = 'upcoming' AND ${MATCH_PUBLIC}`).all(nowIso, soon)
    : db.prepare(`SELECT p.p1, p.made_at, p.scheduled_at AS pat, ${MATCH_COLS} ${FROM}
        WHERE m.status = 'completed' AND m.winner IN (1, 2) AND p.made_at <= p.scheduled_at AND p.scheduled_at > ? AND p.scheduled_at <= ? AND ${MATCH_PUBLIC}`).all(since, nowIso)) as any[];
  const out: Row[] = [];
  for (const r of rows) {
    const m = shapeMatch(r);
    if (!m || m.tour === 'itf' || (!upcoming && m.state !== 'done')) continue;
    out.push({
      id: m.id, league: `${m.tournament.name} · ${tierLabel(m.tournament.tier, m.tour)}`, tier: m.cat === 'slam' ? 1 : m.cat === 'challenger' ? 3 : 2,
      date: m.start, home: m.home.name, away: m.away.name, homeId: m.home.id, awayId: m.away.id, homeLogo: null, awayLogo: null,
      pHome: r.p1, hs: upcoming ? null : m.winner === 1 ? 1 : 0, as_: upcoming ? null : m.winner === 2 ? 1 : 0,
      ranks: { H: m.home.rank ?? null, A: m.away.rank ?? null }
    });
  }
  return out;
}

/* ---------- each sport's past games (for the reasons) ---------- */

/** a team's (player's) finished games of the 3 years before a date, cached per team and day */
function historyQuery(sport: WinnerSport): (id: number, before: string) => Past[] {
  const q = sport === 'basketball'
    ? db.prepare(`SELECT kickoff d, home_id h, away_id a, hs x, as_ y FROM bb_games WHERE (home_id = ? OR away_id = ?) AND status IN ('FT','AOT') AND hs IS NOT NULL AND kickoff > ? AND kickoff < ?`)
    : sport === 'american-football'
      ? db.prepare(`SELECT kickoff d, home_id h, away_id a, home_pts x, away_pts y FROM nfl_games WHERE (home_id = ? OR away_id = ?) AND status IN ('FT','AOT') AND home_pts IS NOT NULL AND kickoff > ? AND kickoff < ?`)
      : db.prepare(`SELECT scheduled_at d, p1_id h, p2_id a, CASE WHEN winner = 1 THEN 1 ELSE 0 END x, CASE WHEN winner = 2 THEN 1 ELSE 0 END y FROM tennis_matches
          WHERE (p1_id = ? OR p2_id = ?) AND status = 'completed' AND winner IN (1, 2) AND scheduled_at > ? AND scheduled_at < ?`);
  const cache = new Map<string, Past[]>();
  return (id, before) => {
    const k = `${id}|${before}`;
    if (!cache.has(k)) {
      const from = new Date(new Date(before).getTime() - 3 * 365 * DAY).toISOString();
      cache.set(k, (q.all(id, id, from, before) as any[]).map(g => ({ date: g.d, home: g.h === id, won: g.h === id ? g.x > g.y : g.y > g.x, opp: g.h === id ? g.a : g.h })));
    }
    return cache.get(k)!;
  };
}

/** The favourite's injured key player (the injury report: NBA, NFL), only for games still to come. */
function keyOutOf(sport: WinnerSport, r: Row, fav: Side, upcoming: boolean): HistoryInput['keyOut'] {
  const id = fav === 'H' ? r.homeId : r.awayId, name = fav === 'H' ? r.home : r.away;
  if (!upcoming || !id) return null;
  try {
    if (sport === 'basketball' && r.code === 'NBA') {
      const top = [...injuryLossDetail(id, name, r.date).players].sort((a, b) => b.points - a.points)[0];
      return top && top.points >= 1 ? { player: top.name, strength: Math.min(1, top.points / 4) } : null;
    }
    if (sport === 'american-football' && r.season) {
      const k = nflKeyPlayers(id, r.season, null).find(p => p.out);
      return k ? { player: k.name, strength: k.position === 'QB' ? 0.9 : 0.5 } : null;
    }
  } catch { /* no injury data: no reason from it */ }
  return null;
}

export function winnerUpsetReport(sport: WinnerSport, now = Date.now()) {
  const get = sport === 'basketball' ? bbRows : sport === 'tennis' ? tennisRows : nflRows;
  const hist = historyQuery(sport);
  const cand = (r: Row, upcoming: boolean): Candidate => {
    const hx = (fav: Side): HistoryInput => ({
      kickoff: r.date, fav, ids: { H: r.homeId ?? -1, A: r.awayId ?? -1 },
      games: { H: r.homeId ? hist(r.homeId, r.date) : [], A: r.awayId ? hist(r.awayId, r.date) : [] },
      keyOut: keyOutOf(sport, r, fav, upcoming), ranks: r.ranks ?? null, tiredUnder: sport === 'american-football' ? 5 : sport === 'tennis' ? 1 : 1.4
    });
    return {
      matchId: r.id, league: r.league, tier: r.tier, date: r.date, home: r.home, away: r.away, homeCrest: r.homeLogo, awayCrest: r.awayLogo,
      pHome: 100 * r.pHome, pDraw: null, pAway: 100 * (1 - r.pHome),
      signals: fav => historySignals(hx(fav)), stature: fav => historyStature(hx(fav))
    };
  };
  const done = get(false, now).filter(r => r.hs !== null && r.as_ !== null && r.hs !== r.as_)
    .map(r => ({ ...cand(r, false), outcome: (r.hs! > r.as_! ? 'H' : 'A') as 'H' | 'A', score: `${r.hs}-${r.as_}` }));
  return { sport, ...watchReport(get(true, now).map(r => cand(r, true)), done, now) };
}
