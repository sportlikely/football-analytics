/**
 * fix239: when may a final score be corrected without asking? (pure, no database)
 *
 * A provider sometimes sends a final with home and away swapped (Kedainiai BC – Plunges Olimpas, LKL 24 Oct 2026: score
 * 62-75, the players' points 75-62). The score is swapped automatically only when every signal we have agrees:
 *  - the second count (basketball: players' points per team; American football: the scoring plays per team) is the
 *    score exactly the other way round, and
 *  - the period scores (quarters + overtime), when we have them, add up the same way round as that second count.
 * A signal that says "the other way round" while another is missing or says "as sent" → a person decides ("review").
 * No signal against the score → "ok" (nothing to do).
 * Tennis: the winner field against the games of each set (sets count, retirements left alone).
 */

export type Pair = [number, number];
export interface Periods { home: (number | null)[]; away: (number | null)[] }
export interface SwapInput { score: Pair; box?: Pair | null; periods?: Periods | null }
export interface Verdict { action: 'ok' | 'swap' | 'review'; why: string }

const same = (a: Pair, b: Pair) => a[0] === b[0] && a[1] === b[1];
const rev = (a: Pair): Pair => [a[1], a[0]];

/** Period totals per side, or null when a side has no periods or a gap before its last period. */
export function periodTotals(p: Periods | null | undefined): Pair | null {
  if (!p || !Array.isArray(p.home) || !Array.isArray(p.away)) return null;
  const tot = (a: (number | null)[]) => {
    const last = a.reduce<number>((l, v, i) => (v != null ? i : l), -1);
    if (last < 0 || a.slice(0, last + 1).some(v => v == null)) return null;
    return a.slice(0, last + 1).reduce<number>((s, v) => s + (v as number), 0);
  };
  const h = tot(p.home), a = tot(p.away);
  return h == null || a == null ? null : [h, a];
}

export function swapVerdict(x: SwapInput): Verdict {
  const s = x.score;
  if (s[0] === s[1]) return { action: 'ok', why: 'level score — no side to swap' };
  const box = x.box && Number.isFinite(x.box[0]) && Number.isFinite(x.box[1]) ? x.box : null;
  const per = periodTotals(x.periods);
  const boxRev = !!box && same(box, rev(s)), perRev = !!per && same(per, rev(s));
  if (!boxRev && !perRev) return { action: 'ok', why: 'nothing says the score is the other way round' };
  const fmt = (p: Pair) => `${p[0]}-${p[1]}`;
  if (boxRev && !per) return { action: 'swap', why: `the second count adds up to ${fmt(box!)} (score ${fmt(s)}), no period scores to contradict it` };
  if (boxRev && perRev) return { action: 'swap', why: `the second count and the period scores both add up to ${fmt(box!)} (score ${fmt(s)})` };
  if (boxRev) return { action: 'review', why: `the second count adds up to ${fmt(box!)} but the period scores to ${fmt(per!)} (score ${fmt(s)}) — the signals disagree` };
  // only the periods say "reversed"
  if (!box) return { action: 'review', why: `the period scores add up to ${fmt(per!)} (score ${fmt(s)}), no second count to confirm it` };
  return { action: 'review', why: `the period scores add up to ${fmt(per!)} but the second count to ${fmt(box)} (score ${fmt(s)}) — the signals disagree` };
}

/**
 * American football: points per team from the scoring plays (each play's running score minus the one before it, given to
 * the play's team, by team id — so it does not depend on the provider's home / away order). Null when there are no plays or
 * a play has no team / score, or the running score is not a straight line.
 */
export function nflPlayPoints(plays: { team: number | null; score: (number | null)[] | null }[] | null | undefined, homeId: number, awayId: number): Pair | null {
  if (!Array.isArray(plays) || !plays.length) return null;
  const pts = new Map<number, number>([[homeId, 0], [awayId, 0]]);
  let prev = 0;
  for (const p of plays) {
    if (p?.team == null || !pts.has(p.team) || !Array.isArray(p.score) || p.score[0] == null || p.score[1] == null) return null;
    const tot = (p.score[0] as number) + (p.score[1] as number), d = tot - prev;
    if (d < 0 || d > 8) return null;
    pts.set(p.team, pts.get(p.team)! + d);
    prev = tot;
  }
  return [pts.get(homeId)!, pts.get(awayId)!];
}

/** Tennis: games per set [[p1 …], [p2 …]] → sets won per side (only finished sets: 6+ with a 2-game lead, or 7-6 / a match tiebreak). */
export function setsWon(games: unknown): Pair | null {
  const g = games as any;
  if (!Array.isArray(g) || !Array.isArray(g[0]) || !Array.isArray(g[1]) || !g[0].length || g[0].length !== g[1].length) return null;
  const won: Pair = [0, 0];
  for (let i = 0; i < g[0].length; i++) {
    const a = Number(g[0][i]), b = Number(g[1][i]);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return null;
    const hi = Math.max(a, b), lo = Math.min(a, b);
    const over = (hi >= 6 && hi - lo >= 2) || (hi === 7 && lo === 6) || (hi >= 10 && hi - lo >= 2) || (hi === 1 && lo === 0);
    if (!over) return null;
    won[a > b ? 0 : 1]++;
  }
  return won;
}

/**
 * Tennis: the stored winner against the set scores and the provider's sets count. 'swap' = give the match to the other
 * player (both the games of every set and the sets count say so); 'review' = only one of them says so.
 */
export function tennisVerdict(x: { winner: number | null; games: unknown; sets: unknown; retired: boolean }): Verdict & { winner?: 1 | 2 } {
  if (x.retired) return { action: 'ok', why: 'retirement / walkover — the winner can have fewer sets' };
  if (x.winner !== 1 && x.winner !== 2) return { action: 'ok', why: 'no winner yet' };
  const byGames = setsWon(x.games);
  const s = x.sets as any;
  const setPair: Pair | null = Array.isArray(s) && s.length === 2 && Number.isFinite(Number(s[0])) && Number.isFinite(Number(s[1])) ? [Number(s[0]), Number(s[1])]
    : s && typeof s === 'object' && ('p1' in s || 'player1' in s) ? [Number(s.p1 ?? s.player1), Number(s.p2 ?? s.player2)] : null;
  const lead = (p: Pair | null): 0 | 1 | 2 => (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || p[0] === p[1] ? 0 : p[0] > p[1] ? 1 : 2);
  const g = lead(byGames), c = lead(setPair), other = (x.winner === 1 ? 2 : 1) as 1 | 2;
  const fmt = (p: Pair | null) => (p ? `${p[0]}-${p[1]}` : '?');
  if (g !== other && c !== other) return { action: 'ok', why: 'the sets agree with the winner' };
  if (g === other && c === other) return { action: 'swap', winner: other, why: `the set scores (${fmt(byGames)}) and the sets count (${fmt(setPair)}) both give the match to player ${other}` };
  return { action: 'review', why: `the set scores say ${fmt(byGames)} and the sets count ${fmt(setPair)}, the winner field says player ${x.winner} — the signals disagree or one is missing` };
}
