/**
 * fix208: live box scores (basketball, American football) — the rules, kept free of the database so they can be tested.
 *  - which live games are due for a box-score fetch: a game someone has open (a page view or a socket in its room in the
 *    last 5 minutes) every 60 s; the big leagues (NBA, EuroLeague, NFL) every 3 minutes; any other game only while
 *    someone watches it;
 *  - whether the day's provider quota allows it (a reserve is always kept for the live scores themselves);
 *  - the order of a team's players on the page (starters first, then by points; players with no minutes yet apart).
 */

export const VIEW_WINDOW_MS = 5 * 60 * 1000;
export const WATCHED_EVERY_MS = 60 * 1000;
export const MAJOR_EVERY_MS = 3 * 60 * 1000;
/** the job runs every 60 s; a game a few seconds early still counts as due (timers drift) */
const SLACK_MS = 5 * 1000;
/** data health: a tracked live game without a box-score update for this long is late */
export const LATE_MS = 5 * 60 * 1000;

export type LiveBoxGame = { id: number; major: boolean; lastAt: number | null };

/** how often this game is fetched now: 60 s watched, 3 min major league, null = not at all */
export function boxEvery(g: { id: number; major: boolean }, views: Map<number, number>, now: number): number | null {
  const seen = views.get(g.id);
  if (seen != null && now - seen <= VIEW_WINDOW_MS) return WATCHED_EVERY_MS;
  return g.major ? MAJOR_EVERY_MS : null;
}

/** the ids due for a fetch on this tick, watched games first */
export function dueGames(games: LiveBoxGame[], views: Map<number, number>, now: number): number[] {
  const due: { id: number; every: number }[] = [];
  for (const g of games) {
    const every = boxEvery(g, views, now);
    if (every == null) continue;
    if (g.lastAt == null || now - g.lastAt >= every - SLACK_MS) due.push({ id: g.id, every });
  }
  return due.sort((a, b) => a.every - b.every).map(x => x.id);
}

/**
 * May we spend `need` calls on live box scores? Unknown quota (no call made yet today) = yes. Otherwise a reserve of
 * 10% of the daily limit (at least 300 calls) stays for the live scores, the schedule and the final box scores.
 */
export function budgetAllows(remaining: number | null, limit: number | null, need: number): boolean {
  if (remaining == null) return true;
  const reserve = Math.max(300, Math.round((limit || 0) * 0.1));
  return remaining - need >= reserve;
}

export const chunks = <T>(list: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
};

/** a team's players for the box score: starters first, then by points (then minutes); `bench` = no minutes yet */
export function boxOrder<P extends { starter: boolean; minutes: number | null; points: number | null }>(players: P[]): { played: P[]; bench: P[] } {
  const played = players.filter(p => p.starter || (p.minutes ?? 0) > 0);
  const bench = players.filter(p => !p.starter && !((p.minutes ?? 0) > 0));
  played.sort((a, b) => Number(b.starter) - Number(a.starter) || (b.points ?? 0) - (a.points ?? 0) || (b.minutes ?? 0) - (a.minutes ?? 0));
  return { played, bench };
}

/** the top scorer of a team ("Haliburton 18 pts" under the score); null before anyone scored */
export function topScorer<P extends { name: string; points: number | null }>(players: P[]): P | null {
  let best: P | null = null;
  for (const p of players) if ((p.points ?? 0) > 0 && (!best || (p.points ?? 0) > (best.points ?? 0))) best = p;
  return best;
}

/**
 * The surname for the line under the score: initials dropped ("C. Wilson" → "Wilson", "Wilson C." → "Wilson"); a name
 * of two full words keeps both (the provider writes some surname first, so the last word is not always the surname).
 */
export function shortName(name: string): string {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  const full = words.filter(w => !/^[A-Za-zÀ-ž]\.?$/.test(w) && !/^([A-Za-zÀ-ž]\.)+$/.test(w));
  return full.length === 1 ? full[0] : full.length ? full.join(' ') : String(name || '');
}
