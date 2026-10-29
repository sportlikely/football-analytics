/**
 * fix220 — "Calibration (<sport>)" in data health, every sport: the picks of the last 30 days (saved before the start,
 * finished) by how sure we were, said vs happened. Error when a band of 50+ games is more than 5 points off, with
 * 100+ games in all (utils/afCalib.ts calibCheck). American football, basketball and tennis count only predictions made
 * with their calibration layer (p_raw saved: fix220, fix222), so the check measures the layer, not the weeks before it.
 * fix254: football and tennis with a recent calibration layer live (services/recentCalib.ts): only the predictions made
 * with it; the line names the layer and the last nightly decision.
 * fix270: basketball too; the allowed gap stays 5 points; the detail names the layer in use and its fit date, the items
 * the last run's before → after table.
 * fix276: each band's allowed gap grows with its size: max(5 points, 2 × the standard error of its hit rate)
 * (utils/healthRules.ts calibVerdict) — over 5 but inside it = yellow "too few games to tell", outside = red; every
 * band shows its allowed gap.
 * Cached 30 minutes (the records are read from the tables).
 */
import { db } from '../db';
import { calibVerdict, calibAllowed } from '../utils/healthRules';
import { winnerByConfidence } from '../utils/winnerBands';
import { publicRecord } from './tracking';
import { isPreseason } from './bbModel';
import { recentHealthRows, recentCalibLine, layerInUse } from './recentCalib';

export const CALIB_SPORTS = ['football', 'basketball', 'nfl', 'tennis'] as const;
type Sport = (typeof CALIB_SPORTS)[number];
const NAME: Record<Sport, string> = { football: 'Football', basketball: 'Basketball', nfl: 'American football', tennis: 'Tennis' };
interface Line { id: string; label: string; level: 'ok' | 'warn' | 'fail'; detail: string; items: string[] }

function byConfidence(sport: Sport): { rows: { n: number; said: number | null; hitRate: number | null; label?: string }[]; note: string } {
  // fix254: with a recent calibration layer live, only the predictions made with it count (as fix220 / fix222 did)
  if (sport !== 'nfl') {
    const r = recentHealthRows(sport);
    if (r) return { rows: r, note: sport === 'football' ? 'result picks made with the recent calibration layer' : 'winner picks made with the recent calibration layer' };
  }
  if (sport === 'football') return { rows: publicRecord(30).byConfidence, note: 'result picks (home / draw / away)' };
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const picks = (list: { p: number; won: boolean }[]) => winnerByConfidence(list.map(r => ({ p: Math.max(r.p, 1 - r.p), hit: (r.p >= 0.5) === r.won })));
  if (sport === 'basketball') {
    const list = (db.prepare(`SELECT p.code, p.kickoff, p.p_home, g.hs, g.as_ FROM bb_predictions p JOIN bb_games g ON g.game_id = p.game_id
      WHERE p.kickoff >= ? AND p.made_at <= p.kickoff AND p.p_raw IS NOT NULL AND g.status IN ('FT','AOT') AND g.hs IS NOT NULL AND g.hs != g.as_`).all(since) as any[])
      .filter(r => !isPreseason({ code: r.code, kickoff: r.kickoff }));
    return { rows: picks(list.map(r => ({ p: r.p_home, won: r.hs > r.as_ }))), note: 'winner picks made with the calibration layer (fix222)' };
  }
  if (sport === 'tennis') {
    const list = db.prepare(`SELECT p.p1, m.winner FROM tennis_predictions p JOIN tennis_matches m ON m.id = p.match_id
      WHERE p.scheduled_at >= ? AND p.made_at <= p.scheduled_at AND p.p_raw IS NOT NULL AND COALESCE(p.cat, '') <> 'itf' AND m.status = 'completed' AND m.winner IN (1, 2)
        AND COALESCE(m.outcome, '') NOT IN ('walkover', 'abandoned', 'unresolved')`).all(since) as any[];
    return { rows: picks(list.map(r => ({ p: r.p1, won: r.winner === 1 }))), note: 'winner picks made with the calibration layer (fix222)' };
  }
  const rows = db.prepare(`SELECT p.p_home, g.home_pts AS hs, g.away_pts AS as_ FROM nfl_predictions p JOIN nfl_games g ON g.game_id = p.game_id
    WHERE p.kickoff >= ? AND p.made_at <= p.kickoff AND p.p_raw IS NOT NULL AND g.status IN ('FT','AOT') AND g.home_pts IS NOT NULL AND g.home_pts != g.away_pts`)
    .all(new Date(Date.now() - 30 * 86400000).toISOString()) as any[];
  return { rows: winnerByConfidence(rows.map(r => ({ p: Math.max(r.p_home, 1 - r.p_home), hit: (r.p_home >= 0.5) === (r.hs > r.as_) }))), note: 'winner picks made with the calibration layer (fix220)' };
}

export function calibrationLine(sport: Sport): Line {
  const id = `calibration-${sport}`, label = `Calibration (${NAME[sport]})`;
  try {
    const { rows, note } = byConfidence(sport);
    const c = calibVerdict(rows);
    const sign = (g: number) => `${g > 0 ? '+' : ''}${g}`;
    const items = rows.filter(r => r.n).map(r => `${r.label ?? ''}: said ${r.said ?? '–'}%, happened ${r.hitRate ?? '–'}% (${r.n} games)`
      + (r.said != null && r.hitRate != null ? ` · gap ${sign(Math.round((r.said - r.hitRate) * 10) / 10)}, allowed ±${calibAllowed(r.n, r.hitRate)}${r.n < 50 ? ' (under 50 games: not judged)' : ''}` : ''));
    if (sport !== 'nfl') items.push(recentCalibLine(sport));
    const layer = sport !== 'nfl' ? ` · ${layerInUse(sport)}` : '';
    const w = c.worst;
    const detail = (!c.enough ? `collecting: ${c.total} of 100 games in the last 30 days (${note})`
      : c.level === 'fail' ? `${w!.label ?? ''} said ${w!.said}%, happened ${w!.hitRate}% over ${w!.n} games (${sign(w!.gap)} points; ${w!.allowed} allowed for ${w!.n} games) · ${note}`
        : c.level === 'warn' ? `${w!.label ?? ''} ${sign(w!.gap)} points over ${w!.n} games, inside the ${w!.allowed} allowed: too few games to tell (${w!.n} games) · ${note}`
          : `every band of 50+ games within its allowed gap (${c.total} games, ${note})`) + layer;
    return { id, label, level: c.level, detail, items };
  } catch (e: any) {
    return { id, label, level: 'warn', detail: `Check failed: ${e.message}`, items: [] };
  }
}

let cache: { at: number; lines: Line[] } | null = null;
export function calibrationHealth(now = Date.now()): Line[] {
  if (cache && now - cache.at < 30 * 60 * 1000) return cache.lines;
  const lines = CALIB_SPORTS.map(calibrationLine);
  cache = { at: now, lines };
  return lines;
}
