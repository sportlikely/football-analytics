/**
 * fix254 — when does the daily top-scorer check email? Only when a league stays under 90% (matching top scorers,
 * lag left out) for 7 days: every run since the league's last run at 90%+ (or since it was first checked) is under,
 * and the first of those runs is 7+ days old. A league is emailed at most once in 7 days. Pure (no database).
 */
export const STREAK_SHARE = 0.9;
export const STREAK_DAYS = 7;
const DAY = 86400000;

export type AuditRun = { at: string; byLeague: Record<string, { checked: number; matched: number; lag?: number }> };
const shareOf = (t: { checked: number; matched: number; lag?: number }) => { const n = t.checked - (t.lag || 0); return n > 0 ? t.matched / n : null; };

/** leagues under STREAK_SHARE on every run for STREAK_DAYS+ days: { league, since (first run under), share (latest) } */
export function leaguesUnderFor(runs: AuditRun[], now = Date.now(), share = STREAK_SHARE, days = STREAK_DAYS) {
  const sorted = runs.slice().sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const leagues = new Set(sorted.flatMap(r => Object.keys(r.byLeague || {})));
  const out: { league: string; since: string; share: number }[] = [];
  for (const lg of leagues) {
    let since: string | null = null, last: number | null = null;
    for (const r of sorted) {
      const t = r.byLeague?.[lg];
      const s = t ? shareOf(t) : null;
      if (s == null) continue; // not checked that day: the streak goes on
      if (s >= share) { since = null; last = s; continue; }
      if (!since) since = r.at;
      last = s;
    }
    if (since && last != null && now - Date.parse(since) >= days * DAY) out.push({ league: lg, since, share: Math.round(last * 1000) / 10 });
  }
  return out.sort((a, b) => (a.league < b.league ? -1 : 1));
}

/** of those, the ones not emailed in the last STREAK_DAYS days (`sent` = league → last email time) */
export const dueForEmail = <T extends { league: string }>(under: T[], sent: Record<string, string>, now = Date.now(), days = STREAK_DAYS): T[] =>
  under.filter(u => !sent[u.league] || now - Date.parse(sent[u.league]) >= days * DAY);
