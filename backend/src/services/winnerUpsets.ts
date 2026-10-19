/**
 * Upset watch for the sports where the pick is the winner (fix144: basketball, NFL + college football). The same rule
 * and report shape as football's (services/upsetAlerts.ts → upsetWatchReport): games of the coming 7 days where our
 * model gives the underdog 20–45% (fix188) and the favourite leads by 10+ points, and how those calls went — saved predictions
 * only (made before tip-off / kick-off). Model only: no bookmakers. No draws in these sports (draw fields are null).
 */
import { db } from '../db';
import { WATCH, watchOf, watchBands, bandOf } from './upsetAlerts';
import { BB_TRIAL, isPreseason } from './bbModel';

export type WinnerSport = 'basketball' | 'american-football';
const r1 = (x: number) => Math.round(x * 10) / 10;

interface Row { id: number; league: string; date: string; home: string; away: string; homeLogo: string | null; awayLogo: string | null; pHome: number; hs: number | null; as_: number | null; done: boolean }

function bbRows(upcoming: boolean): Row[] {
  const now = new Date().toISOString(), soon = new Date(Date.now() + 7 * 86400000).toISOString();
  const rows = (upcoming
    ? db.prepare(`SELECT p.game_id, p.code, p.kickoff, p.p_home, g.home_name, g.away_name, g.home_logo, g.away_logo, g.hs, g.as_, g.status, l.name AS league
        FROM bb_predictions p JOIN bb_games g ON g.game_id = p.game_id LEFT JOIN bb_leagues l ON l.code = p.code
        WHERE p.kickoff > ? AND p.kickoff < ? AND (g.status IS NULL OR g.status = 'NS')`).all(now, soon)
    : db.prepare(`SELECT p.game_id, p.code, p.kickoff, p.p_home, g.home_name, g.away_name, g.home_logo, g.away_logo, g.hs, g.as_, g.status, l.name AS league
        FROM bb_predictions p JOIN bb_games g ON g.game_id = p.game_id LEFT JOIN bb_leagues l ON l.code = p.code
        WHERE g.status IN ('FT','AOT') AND g.hs IS NOT NULL AND p.made_at <= p.kickoff
          AND p.game_id NOT IN (SELECT game_id FROM bb_result_check WHERE resolved_at IS NULL)`).all()) as any[];
  // leagues in testing and pre-season games stay out (as in the basketball record)
  return rows.filter(r => !BB_TRIAL.has(r.code) && !isPreseason({ code: r.code, kickoff: r.kickoff })).map(r => ({
    id: r.game_id, league: r.league || r.code, date: r.kickoff, home: r.home_name, away: r.away_name, homeLogo: r.home_logo || null, awayLogo: r.away_logo || null,
    pHome: r.p_home, hs: r.hs, as_: r.as_, done: r.status === 'FT' || r.status === 'AOT'
  }));
}

function nflRows(upcoming: boolean): Row[] {
  const now = new Date().toISOString(), soon = new Date(Date.now() + 7 * 86400000).toISOString();
  const rows = (upcoming
    ? db.prepare(`SELECT p.game_id, p.kickoff, p.p_home, g.league, g.week, g.stage, g.home_name, g.away_name, g.home_logo, g.away_logo, g.home_pts, g.away_pts, g.status
        FROM nfl_predictions p JOIN nfl_games g ON g.game_id = p.game_id WHERE p.kickoff > ? AND p.kickoff < ? AND (g.status IS NULL OR g.status = 'NS')`).all(now, soon)
    : db.prepare(`SELECT p.game_id, p.kickoff, p.p_home, g.league, g.week, g.stage, g.home_name, g.away_name, g.home_logo, g.away_logo, g.home_pts, g.away_pts, g.status
        FROM nfl_predictions p JOIN nfl_games g ON g.game_id = p.game_id
        WHERE g.status IN ('FT','AOT') AND g.home_pts IS NOT NULL AND g.home_pts != g.away_pts AND p.made_at <= p.kickoff`).all()) as any[];
  return rows.map(r => ({
    id: r.game_id, league: `${r.league === 2 ? 'College football' : 'NFL'}${r.week ? ` · ${/post/i.test(r.stage || '') ? (r.league === 2 ? 'Bowls' : 'Playoffs') : String(r.week).replace(/^(\d+)$/, 'Week $1')}` : ''}`,
    date: r.kickoff, home: r.home_name || 'TBD', away: r.away_name || 'TBD', homeLogo: r.home_logo || null, awayLogo: r.away_logo || null,
    pHome: r.p_home, hs: r.home_pts, as_: r.away_pts, done: r.status === 'FT' || r.status === 'AOT'
  }));
}

export function winnerUpsetReport(sport: WinnerSport) {
  const get = sport === 'basketball' ? bbRows : nflRows;
  const cut = (r: Row) => watchOf(100 * r.pHome, 0, 100 * (1 - r.pHome));
  const upcoming = get(true).map(r => {
    const w = cut(r);
    if (!w) return null;
    return {
      matchId: r.id, league: r.league, date: r.date, home: r.home, away: r.away, homeCrest: r.homeLogo, awayCrest: r.awayLogo,
      home_p: r1(100 * r.pHome), draw_p: 0, away_p: r1(100 * (1 - r.pHome)), ...w, draw: 0, dc: null
    };
  }).filter((x): x is NonNullable<typeof x> => !!x).sort((a, b) => b.upsetChance - a.upsetChance || a.date.localeCompare(b.date));

  let n = 0, upsets = 0, said = 0;
  const bands = watchBands();
  const recent: any[] = [];
  for (const r of get(false)) {
    const w = cut(r);
    if (!w || r.hs === null || r.as_ === null) continue;
    n++; said += w.upsetChance;
    const upset = (r.hs > r.as_ ? 'H' : 'A') === w.underdog;
    if (upset) upsets++;
    const b = bandOf(bands, w.upsetChance);
    b.n++; b.said += w.upsetChance; if (upset) b.upsets++;
    recent.push({ matchId: r.id, league: r.league, date: r.date, home: r.home, away: r.away, score: `${r.hs}-${r.as_}`, underdog: w.underdog, upsetChance: r1(w.upsetChance), result: upset ? 'upset' : 'favourite' });
  }
  recent.sort((a, b) => b.date.localeCompare(a.date));
  return {
    sport, rule: WATCH, upcoming,
    record: {
      n, upsets, draws: 0,
      upsetRate: n ? r1((100 * upsets) / n) : null, said: n ? r1(said / n) : null, drawRate: null, saidDraw: null,
      bands: bands.map(b => ({ range: b.range, n: b.n, said: b.n ? r1(b.said / b.n) : null, happened: b.n ? r1((100 * b.upsets) / b.n) : null })),
      since: recent.length ? recent[recent.length - 1].date : null,
      recent: recent.slice(0, 12)
    }
  };
}
