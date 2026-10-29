/**
 * fix254 — when does the daily top-scorer check email? Only when a league stays under 90% (matching top scorers,
 * lag left out) for 7 days: every run since the league's last run at 90%+ (or since it was first checked) is under,
 * and the first of those runs is 7+ days old. A league is emailed at most once in 7 days. Pure (no database).
 */
export const STREAK_SHARE = 0.9;
export const STREAK_DAYS = 7;
const DAY = 86400000;

export type AuditRun = { at: string; byLeague: Record<string, { checked: number; matched: number; lag?: number; known?: number }> };
// fix275: known provider / league differences are left out like lag
const shareOf = (t: { checked: number; matched: number; lag?: number; known?: number }) => { const n = t.checked - (t.lag || 0) - (t.known || 0); return n > 0 ? t.matched / n : null; };

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

/**
 * fix275 — a known lasting difference is not a fault. His page shows MORE goals than the official list (the provider
 * credits a goal the league gave to someone else, or an own goal: Eredivisie · Nacho Ferri 6 vs 5) and the gap has been
 * the same on KNOWN_CHECKS checks in a row (this one included) → "Provider and league disagree (known)": shown grey,
 * left out of the league's match % and the "under 90% for 7 days" email. The official list ahead (provider a game
 * behind) is never known: it keeps counting.
 */
export const KNOWN_CHECKS = 3;
export type PastIssue = { kind: string; league?: string; player?: string; playerId?: number; detail: string };
/** "Goals: official list 5, his page 6" → +1 (page − official); null for any other difference */
export function goalGap(detail: string): number | null {
  const m = /Goals: official list (\d+), his page (\d+)/.exec(detail || '');
  return m ? Number(m[2]) - Number(m[1]) : null;
}
/** `prev` = earlier runs, newest first, each with its issues and the leagues it checked */
export function isKnownGap(prev: { leagues: string[]; issues: PastIssue[] }[], league: string, player: { name?: string; id?: number | null }, gap: number, need = KNOWN_CHECKS): boolean {
  if (!(gap > 0)) return false;
  let n = 1;
  for (const run of prev) {
    if (!run.leagues.includes(league)) continue; // league not checked that day: the streak goes on
    const same = run.issues.find(i => i.league === league && (i.kind === 'mismatch' || i.kind === 'known')
      && ((player.id != null && i.playerId === player.id) || (!!player.name && i.player === player.name)));
    if (!same || goalGap(same.detail) !== gap) return false;
    if (++n >= need) return true;
  }
  return false;
}
