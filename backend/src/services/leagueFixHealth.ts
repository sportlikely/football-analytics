/**
 * fix255: data health "Leagues under 50%" — read from the nightly league test's last run (league_fix_runs.under50), no
 * import of the job. Warns when a league with ≥ 60 games in 90 days was under 50% on 1X2 on each of the last 30 days.
 */
import { db } from '../db';
import { LF_RULES } from '../utils/leagueFix';
type Level = 'ok' | 'warn' | 'fail';

export function leagueFixHealth(): { id: string; label: string; level: Level; detail: string; items?: string[] }[] {
  let r: any = null;
  try { r = db.prepare(`SELECT date, under50 FROM league_fix_runs ORDER BY date DESC LIMIT 1`).get(); } catch { r = null; }
  const label = 'Leagues under 50%';
  if (!r) return [{ id: 'leagues-under-50', label, level: 'ok', detail: 'the league test has not run yet (first run 25 min after start)' }];
  let list: { name: string; n: number; hit: number; worst: number; best: number }[] = [];
  try { list = JSON.parse(r.under50 || '[]'); } catch { list = []; }
  const rule = `${LF_RULES.minOwn}+ games, under ${LF_RULES.warnUnder}% on each of the last ${LF_RULES.warnDays} days`;
  if (!list.length) return [{ id: 'leagues-under-50', label, level: 'ok', detail: `no league ${rule} (test of ${r.date})` }];
  return [{
    id: 'leagues-under-50', label, level: 'warn',
    detail: `${list.length} league${list.length > 1 ? 's' : ''} ${rule} (test of ${r.date})`,
    items: list.map(l => `${l.name}: ${l.hit}% over ${l.n} games (30-day range ${l.worst}–${l.best}%)`)
  }];
}
