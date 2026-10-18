/**
 * Basketball line-ups (fix174), football's line-ups in basketball's own way:
 *  - probable starting five per team: the starters of the team's last game with a box score (the provider's "starters"
 *    flag) who play 12+ minutes a game, minus the players on the injury report as out, filled up from the bench by minutes; bench = the next
 *    players by minutes over the last 10 games; the players out listed apart;
 *  - before vs after (NBA): the prediction without the injury report against the one with it, with each injured
 *    regular's points (bbInjuries.injuryLoss prices them).
 * Injury reports exist for the NBA only (ESPN via bbInjuries); other leagues show the starting five without them.
 */
import { db } from '../db';
import { nbaInjuries, injuryLossDetail, STATUS_WEIGHT } from './bbInjuries';
import { leagueModelInfo, normCdf, normInv } from './bbModel';

export interface LPlayer { id: number; name: string; min: number | null; pts: number | null; status?: string | null }
const OUT = (s: string | null | undefined) => !!s && STATUS_WEIGHT(s) >= 1;
const key = (s: string) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '');

export function bbProbableLineup(teamId: number, teamName: string, code: string, before: string) {
  const games = db.prepare(`SELECT game_id, kickoff FROM bb_games WHERE (home_id = ? OR away_id = ?) AND status IN ('FT','AOT') AND kickoff < ? AND stats = 1 ORDER BY kickoff DESC LIMIT 10`)
    .all(teamId, teamId, before) as any[];
  if (!games.length) return null;
  const ids = games.map(g => g.game_id);
  const rows = db.prepare(`SELECT game_id, player_id, name, starter, minutes, pts FROM bb_player_stats WHERE team_id = ? AND game_id IN (${ids.map(() => '?').join(',')})`).all(teamId, ...ids) as any[];
  const avg = new Map<number, { id: number; name: string; min: number; pts: number; n: number }>();
  for (const r of rows) {
    const x = avg.get(r.player_id) || { id: r.player_id, name: r.name, min: 0, pts: 0, n: 0 };
    x.min += r.minutes || 0; x.pts += r.pts || 0; x.n++;
    avg.set(r.player_id, x);
  }
  const per = (id: number): LPlayer => { const x = avg.get(id)!; return { id, name: x.name, min: Math.round((x.min / games.length) * 10) / 10, pts: Math.round((x.pts / games.length) * 10) / 10 }; };
  const last = rows.filter(r => r.game_id === ids[0]);
  const injured = code === 'NBA' ? nbaInjuries(teamId, teamName, before) : [];
  const status = new Map(injured.map(i => [key(i.name), i.status as string]));
  const isOut = (name: string) => OUT(status.get(key(name)))
  // a last-game starter counts when he is a regular (12+ minutes a game over the last 10): a pre-season or rest-day
  // line-up does not make a 2-minute player a starter
  let starters = last.filter(r => r.starter).map(r => per(r.player_id)).filter(p => !isOut(p.name) && (p.min ?? 0) >= 12);
  const byMin = [...avg.values()].sort((a, b) => b.min - a.min).map(x => per(x.id));
  for (const p of byMin) { if (starters.length >= 5) break; if (!starters.some(s => s.id === p.id) && !isOut(p.name)) starters.push(p); }
  starters = starters.slice(0, 5).map(p => ({ ...p, status: status.get(key(p.name)) || null }));
  const bench = byMin.filter(p => !starters.some(s => s.id === p.id) && !isOut(p.name)).slice(0, 7).map(p => ({ ...p, status: status.get(key(p.name)) || null }));
  const out = injured.filter(i => OUT(i.status)).map(i => ({ id: i.playerId ?? null, name: i.name, status: i.status, min: i.minutes ?? null }));
  return { from: games[0].kickoff, starters, bench, out };
}

/** NBA: the prediction before the injury report vs now (only when it moved the win chance by 3+ points). */
export function bbBeforeAfter(g: { code: string; home_id: number; away_id: number; home_name: string; away_name: string; kickoff: string }, pHomeNow: number | null) {
  if (g.code !== 'NBA' || pHomeNow === null) return null;
  const h = injuryLossDetail(g.home_id, g.home_name, g.kickoff), a = injuryLossDetail(g.away_id, g.away_name, g.kickoff);
  if (!h.points && !a.points) return null;
  const info = leagueModelInfo(g.code);
  if (!info || !(info.sigma > 0)) return null;
  const shift = h.points - a.points;
  const before = Math.round(normCdf(normInv(Math.min(0.995, Math.max(0.005, pHomeNow / 100))) + shift / info.sigma) * 1000) / 10;
  if (Math.abs(before - pHomeNow) < 3) return null;
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return {
    before: { pHome: before, pAway: r1(100 - before) }, after: { pHome: pHomeNow, pAway: r1(100 - pHomeNow) },
    players: [...h.players.map(p => ({ ...p, side: 'H' as const })), ...a.players.map(p => ({ ...p, side: 'A' as const }))].sort((x, y) => y.points - x.points)
  };
}
