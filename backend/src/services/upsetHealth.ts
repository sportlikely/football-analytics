/**
 * fix242 data health "Upset watch text matches the numbers": on every sport's upset watch the name shown as the
 * favourite is the side with the higher win %, the underdog the lower one (26 Oct: swapped whenever the away team was
 * the favourite), every game has a reason, and at most 10 are shown per week. Built at most every 30 minutes (worker).
 */
import { upsetWatchReport } from './upsetAlerts';
import { winnerUpsetReport } from './winnerUpsets';
import { textMatchesNumbers, UPSET } from '../utils/upsetWatch';

type Level = 'ok' | 'warn' | 'fail';
let last: { at: number; check: { id: string; label: string; level: Level; detail: string; items?: string[] } } | null = null;

export function upsetTextHealth(now = Date.now()) {
  if (last && now - last.at < 30 * 60000) return [last.check];
  const bad: string[] = [], counts: string[] = [];
  const sports = [['Football', () => upsetWatchReport(now)], ['Basketball', () => winnerUpsetReport('basketball', now)],
    ['American football', () => winnerUpsetReport('american-football', now)], ['Tennis', () => winnerUpsetReport('tennis', now)]] as const;
  for (const [name, build] of sports) {
    let rep: ReturnType<typeof upsetWatchReport> | ReturnType<typeof winnerUpsetReport>;
    try { rep = build(); } catch (e: any) { bad.push(`${name}: could not build (${e?.message || e})`); continue; }
    for (const x of rep.upcoming) {
      if (!textMatchesNumbers(x)) bad.push(`${name}: ${x.home} – ${x.away}: shown "${x.favourite.name} favourite (${x.favourite.p}%)", numbers ${x.pHome}% – ${x.pAway}%`);
      if (!x.reason) bad.push(`${name}: ${x.home} – ${x.away} has no reason`);
    }
    for (const x of rep.record.recent) if (x.favourite.p <= x.underdog.p) bad.push(`${name} (past): ${x.home} – ${x.away}: favourite ${x.favourite.p}% ≤ underdog ${x.underdog.p}%`);
    const top = rep.upcoming.filter(x => x.top).length;
    if (top > UPSET.perWeek) bad.push(`${name}: ${top} shown (max ${UPSET.perWeek})`);
    counts.push(`${name} ${top}/${rep.total}`);
  }
  const check = {
    id: 'upset-text', label: 'Upset watch text matches the numbers', level: (bad.length ? 'fail' : 'ok') as Level,
    detail: bad.length ? `${bad.length} problem(s)` : `Favourite = the higher win % on every game; shown / on the watch this week: ${counts.join(' · ')}`,
    ...(bad.length ? { items: bad.slice(0, 15) } : {})
  };
  last = { at: now, check };
  return [check];
}
