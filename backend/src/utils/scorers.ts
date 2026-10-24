/**
 * fix209 — the scorers under the score (every sport's game page). Kept free of the database so it can be tested.
 * Frontend twin: frontend/src/lib/scorers.ts (goalSides is the same rule; keep both in step).
 *  - goalSides: which side each goal counts for (own goals: whichever provider convention matches the score);
 *  - footballGap: the score's goals per side against the goals with a player's name (the data-health "Scorers shown"
 *    line, and whether a match page may be stored for good);
 *  - better events: Football-Data.org's goal list replaced by API-Football's when that one names more goals.
 */

type Side = 'home' | 'away';
export interface Goal { minute: number; injuryTime?: number | null; type: string; team: { id: number; name?: string }; scorer: { id: number; name: string }; score?: { home: number; away: number } | null }
export interface ScoreMatch { homeTeam: { id: number }; awayTeam: { id: number }; score?: { fullTime?: { home: number | null; away: number | null } }; goals?: Goal[] }

const named = (n: string | null | undefined) => !!n && n.trim() !== '' && n.trim() !== '?';

export function goalSides(goals: Goal[], homeId: number, awayId: number, ft: { home: number | null; away: number | null }): (Side | null)[] {
  const order = goals.map((g, i) => ({ g, i })).sort((a, b) => a.g.minute - b.g.minute || (a.g.injuryTime || 0) - (b.g.injuryTime || 0));
  if (goals.length && goals.every(g => g.score && Number.isFinite(g.score.home) && Number.isFinite(g.score.away))) {
    const out: (Side | null)[] = goals.map(() => null);
    let prev = { home: 0, away: 0 }, ok = true;
    for (const { g, i } of order) {
      const s = g.score!;
      if (s.home === prev.home + 1 && s.away === prev.away) out[i] = 'home';
      else if (s.away === prev.away + 1 && s.home === prev.home) out[i] = 'away';
      else { ok = false; break; }
      prev = { home: s.home, away: s.away };
    }
    if (ok) return out;
  }
  const of = (id: number): Side | null => (id === homeId ? 'home' : id === awayId ? 'away' : null);
  const flip = (s: Side | null): Side | null => (s === 'home' ? 'away' : s === 'away' ? 'home' : null);
  const read = (ownIsPlayersTeam: boolean) => goals.map(g => (g.type === 'OWN' && ownIsPlayersTeam ? flip(of(g.team.id)) : of(g.team.id)));
  const a = read(true), b = read(false);
  if (!goals.some(g => g.type === 'OWN') || ft.home === null || ft.away === null) return a;
  const fits = (r: (Side | null)[], exact: boolean) => {
    const h = r.filter(s => s === 'home').length, w = r.filter(s => s === 'away').length;
    return exact ? h === ft.home && w === ft.away : h <= ft.home! && w <= ft.away!;
  };
  if (fits(a, true)) return a;
  if (fits(b, true)) return b;
  if (fits(a, false)) return a;
  return fits(b, false) ? b : a;
}

/** Goals in the score and goals with a player's name, per side; ok = every goal of the score is named. */
export function footballGap(m: ScoreMatch): { score: { home: number; away: number }; named: { home: number; away: number }; ok: boolean } {
  const ft = { home: m.score?.fullTime?.home ?? null, away: m.score?.fullTime?.away ?? null };
  const goals = m.goals || [];
  const sides = goalSides(goals, m.homeTeam.id, m.awayTeam.id, ft);
  const n = { home: 0, away: 0 };
  goals.forEach((g, i) => { const s = sides[i]; if (s && named(g.scorer?.name)) n[s]++; });
  const score = { home: ft.home ?? 0, away: ft.away ?? 0 };
  return { score, named: n, ok: n.home >= score.home && n.away >= score.away };
}

/** The goal list that names more of the score's goals (ties keep the first). */
export function betterGoals<T extends ScoreMatch>(m: T, other: Goal[] | null | undefined): Goal[] {
  const cur = m.goals || [];
  if (!other?.length) return cur;
  const a = footballGap(m), b = footballGap({ ...m, goals: other });
  const k = (g: ReturnType<typeof footballGap>) => Math.min(g.named.home, g.score.home) + Math.min(g.named.away, g.score.away);
  return k(b) > k(a) ? other : cur;
}

/** Basketball: each team's top scorer is there once a box score exists (a player with a name and points). */
export function bbTopGap(rows: { team_id: number; name: string | null; pts: number | null }[], homeId: number, awayId: number): Side[] {
  const has = (id: number) => rows.some(r => r.team_id === id && named(r.name) && (r.pts ?? 0) > 0);
  if (!rows.length) return [];
  return (['home', 'away'] as const).filter(s => !has(s === 'home' ? homeId : awayId));
}

/** NFL: a side with points has at least one scoring play of its own. */
export function nflPlaysGap(plays: { team: number | null }[] | null, score: { home: number | null; away: number | null }, homeId: number, awayId: number): Side[] {
  const list = plays || [];
  return (['home', 'away'] as const).filter(s => (score[s] ?? 0) > 0 && !list.some(p => p.team === (s === 'home' ? homeId : awayId)));
}
