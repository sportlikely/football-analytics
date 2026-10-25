/**
 * fix220 — "Calibration (<sport>)" in data health, every sport: the picks of the last 30 days (saved before the start,
 * finished) by how sure we were, said vs happened. Error when a band of 50+ games is more than 5 points off, with
 * 100+ games in all (utils/afCalib.ts calibCheck). American football counts only predictions made with its
 * calibration layer (p_raw saved, fix220), so the check measures the layer, not the weeks before it.
 * Cached 30 minutes (the records are read from the tables).
 */
import { db } from '../db';
import { calibCheck } from '../utils/afCalib';
import { winnerByConfidence } from '../utils/winnerBands';
import { publicRecord } from './tracking';
import { bbRecord } from './bbModel';
import { tennisAccuracy } from './tennisSite';

export const CALIB_SPORTS = ['football', 'basketball', 'nfl', 'tennis'] as const;
type Sport = (typeof CALIB_SPORTS)[number];
const NAME: Record<Sport, string> = { football: 'Football', basketball: 'Basketball', nfl: 'American football', tennis: 'Tennis' };
interface Line { id: string; label: string; level: 'ok' | 'warn' | 'fail'; detail: string; items: string[] }

function byConfidence(sport: Sport): { rows: { n: number; said: number | null; hitRate: number | null; label?: string }[]; note: string } {
  if (sport === 'football') return { rows: publicRecord(30).byConfidence, note: 'result picks (home / draw / away)' };
  if (sport === 'basketball') return { rows: bbRecord(30).byConfidence, note: 'winner picks' };
  if (sport === 'tennis') return { rows: tennisAccuracy(30).byConfidence, note: 'winner picks' };
  const rows = db.prepare(`SELECT p.p_home, g.home_pts AS hs, g.away_pts AS as_ FROM nfl_predictions p JOIN nfl_games g ON g.game_id = p.game_id
    WHERE p.kickoff >= ? AND p.made_at <= p.kickoff AND p.p_raw IS NOT NULL AND g.status IN ('FT','AOT') AND g.home_pts IS NOT NULL AND g.home_pts != g.away_pts`)
    .all(new Date(Date.now() - 30 * 86400000).toISOString()) as any[];
  return { rows: winnerByConfidence(rows.map(r => ({ p: Math.max(r.p_home, 1 - r.p_home), hit: (r.p_home >= 0.5) === (r.hs > r.as_) }))), note: 'winner picks made with the calibration layer (fix220)' };
}

export function calibrationLine(sport: Sport): Line {
  const id = `calibration-${sport}`, label = `Calibration (${NAME[sport]})`;
  try {
    const { rows, note } = byConfidence(sport);
    const c = calibCheck(rows);
    const items = rows.filter(r => r.n).map(r => `${r.label ?? ''}: said ${r.said ?? '–'}%, happened ${r.hitRate ?? '–'}% (${r.n} games)`);
    const detail = !c.enough ? `collecting: ${c.total} of 100 games in the last 30 days (${note})`
      : c.fail ? `${c.worst!.label ?? ''} said ${c.worst!.said}%, happened ${c.worst!.hitRate}% over ${c.worst!.n} games (${c.worst!.gap > 0 ? '+' : ''}${c.worst!.gap} points; 5 allowed) · ${note}`
        : `every band of 50+ games within 5 points (${c.total} games, ${note})`;
    return { id, label, level: c.fail ? 'fail' : 'ok', detail, items };
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
