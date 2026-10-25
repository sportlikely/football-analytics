/**
 * fix215 — the season forecast's pure parts (no database): what a league run needs, ratings fitted to our game
 * means, a table from results, the batch run and last season's replay. The worker thread ('season sim') loads only
 * this file and utils/seasonSim.ts; services/seasonForecast.ts builds the inputs and stores the answers.
 */
import { simulateSeason, type LeagueRules, type SimGame, type SimPlayed, type SimTeam, type SimParams, type SimOut, type ZoneKey, type SimSport } from './seasonSim';

type FcSport = SimSport;
const DAY = 86400000;
export const r4 = (x: number) => Math.round(x * 10000) / 10000;
export const median = (a: number[]) => { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

export interface LeagueInput {
  sport: FcSport; code: string; name: string; season: string;
  rules: LeagueRules; teams: SimTeam[]; played: SimPlayed[]; games: SimGame[]; params: SimParams;
  /** extra per team for the pages: logo, the table now */
  meta: Record<string, { logo?: string | null; rank: number }>;
  lastFinal: string | null;
}

/** least squares: game mean = rating(home) − rating(away) + home edge, ridge toward 0 (λ games' worth) */
export function fitRatings(ids: string[], obs: { h: string; a: string; m: number; w: number; neutral?: boolean }[], home0: number, lambda = 2): { r: Map<string, number>; home: number } {
  const r = new Map(ids.map(i => [i, 0] as [string, number]));
  let home = home0;
  const by = new Map<string, typeof obs>();
  for (const o of obs) { if (!r.has(o.h) || !r.has(o.a)) continue; for (const t of [o.h, o.a]) (by.get(t) || by.set(t, []).get(t)!).push(o); }
  for (let it = 0; it < 60; it++) {
    for (const t of ids) {
      let num = 0, den = lambda;
      for (const o of by.get(t) || []) {
        const H = o.neutral ? 0 : home;
        if (o.h === t) { num += o.w * (o.m - H + r.get(o.a)!); den += o.w; } else { num += o.w * (r.get(o.h)! + H - o.m); den += o.w; }
      }
      r.set(t, num / den);
    }
    let hn = 0, hd = 0;
    for (const o of obs) if (!o.neutral && r.has(o.h) && r.has(o.a)) { hn += o.w * (o.m - r.get(o.h)! + r.get(o.a)!); hd += o.w; }
    if (hd > 5) home = hn / hd;
    const mean = ids.reduce((s, i) => s + r.get(i)!, 0) / (ids.length || 1);
    for (const i of ids) r.set(i, r.get(i)! - mean);
  }
  return { r, home };
}


/** a table from finished games (+ a points adjustment per team) */
export function tableOf(ids: string[], played: SimPlayed[], sport: FcSport, adj: Map<string, number> = new Map()): Map<string, SimTeam> {
  const t = new Map<string, SimTeam>(ids.map(id => [id, { id, name: id, pts: adj.get(id) || 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, played: 0, rating: 0 }]));
  for (const g of played) {
    const H = t.get(g.home), A = t.get(g.away);
    if (!H || !A) continue;
    H.played++; A.played++; H.gf += g.hg; H.ga += g.ag; A.gf += g.ag; A.ga += g.hg;
    if (g.hg > g.ag) { H.w++; A.l++; H.pts += sport === 'football' ? 3 : 1; }
    else if (g.hg < g.ag) { A.w++; H.l++; A.pts += sport === 'football' ? 3 : 1; }
    else { H.d++; A.d++; if (sport === 'football') { H.pts++; A.pts++; } }
  }
  return t;
}
export function rankNow(teams: SimTeam[], sport: FcSport): Map<string, number> {
  const key = (x: SimTeam) => sport === 'football' ? x.pts : (x.w + 0.5 * x.d) / Math.max(1, x.w + x.d + x.l);
  const out = new Map<string, number>();
  const byGroup = new Map<string, SimTeam[]>();
  for (const x of teams) (byGroup.get(x.group || '') || byGroup.set(x.group || '', []).get(x.group || '')!).push(x);
  for (const list of byGroup.values()) list.slice().sort((a, b) => key(b) - key(a) || (b.gf - b.ga) - (a.gf - a.ga) || b.gf - a.gf).forEach((x, k) => out.set(x.id, k + 1));
  return out;
}

/** thread job body: the simulations of a batch of leagues (pure, no database) */
export function simulateHere(inputs: LeagueInput[]): { out: SimOut; ms: number }[] {
  return inputs.map(x => { const t0 = Date.now(); const out = simulateSeason(x.rules, x.teams, x.played, x.games, x.params); return { out, ms: Date.now() - t0 }; });
}

export interface ReplayLeague { sport: FcSport; code: string; name: string; season: string; rules: LeagueRules; teams: { id: string; name: string; group?: string; div?: string }[]; games: { home: string; away: string; hg: number; ag: number; kickoff: string }[]; preds: { home: string; away: string; m: number; at: string }[]; base: SimParams }

/** the zones scored in the replay: title, the first "good" zone, relegation */
export function scoredZones(rules: LeagueRules): ZoneKey[] {
  const keys: ZoneKey[] = ['title'];
  const good = rules.zones.find(z => ['cl', 'promotion'].includes(z.key))?.key || (rules.post?.kind === 'bracket' || rules.post?.kind === 'nfl' ? 'playoffs' : undefined);
  if (good) keys.push(good);
  if (rules.zones.some(z => z.key === 'relegation')) keys.push('relegation');
  return keys;
}

/** thread job body: one league's replay (pure) */
export function replayHere(L: ReplayLeague): { steps: number; n: number; sim: Record<string, number>; base: Record<string, number>; simAll: number; baseAll: number } {
  const ids = L.teams.map(t => t.id), meta = new Map(L.teams.map(t => [t.id, t]));
  const sport = L.sport, keys = scoredZones(L.rules);
  // what happened: one run over the whole season with no games left (post-season by the same rules, the playoffs
  // themselves aren't in our regular-season data, so play-off zones are scored on the places)
  const finalTab = tableOf(ids, L.games, sport);
  const finalTeams = ids.map(id => ({ ...finalTab.get(id)!, name: meta.get(id)!.name, group: meta.get(id)!.group, div: meta.get(id)!.div }));
  const actual = simulateSeason(L.rules, finalTeams, L.games, [], { ...L.base, runs: 1, noise: 0 });
  const truth = new Map(actual.teams.map(t => [t.id, t.zones]));
  const first = Date.parse(L.games[0].kickoff), last = Date.parse(L.games[L.games.length - 1].kickoff);
  const sim: Record<string, number> = {}, base: Record<string, number> = {}, cnt: Record<string, number> = {};
  let steps = 0;
  for (let t = first + 21 * DAY; t < last - 7 * DAY; t += 7 * DAY) {
    const known = L.games.filter(g => Date.parse(g.kickoff) < t), rest = L.games.filter(g => Date.parse(g.kickoff) >= t);
    if (!rest.length) break;
    // ratings from what was known: the results' margins (football: on the latent scale, ×0.3 a goal)
    const obs = known.map(g => ({ h: g.home, a: g.away, m: sport === 'football' ? 0.3 * Math.max(-3, Math.min(3, g.hg - g.ag)) : Math.max(-30, Math.min(30, g.hg - g.ag)), w: Math.exp(-(t - Date.parse(g.kickoff)) / (90 * DAY)) }));
    const fit = fitRatings(ids, obs, L.base.home, sport === 'football' ? 4 : 3);
    const tab = tableOf(ids, known, sport);
    const teams = ids.map(id => ({ ...tab.get(id)!, name: meta.get(id)!.name, rating: fit.r.get(id) || 0, group: meta.get(id)!.group, div: meta.get(id)!.div }));
    const out = simulateSeason(L.rules, teams, known, rest.map((g, k) => ({ id: String(k), home: g.home, away: g.away })), { ...L.base, home: fit.home, seed: L.base.seed + steps });
    // baseline: the table as it stands, run with no games left
    const now = simulateSeason(L.rules, teams, known, [], { ...L.base, runs: 1, noise: 0 });
    const nowZ = new Map(now.teams.map(x => [x.id, x.zones]));
    for (const x of out.teams) for (const k of keys) {
      const y = truth.get(x.id)?.[k] ?? 0, p = x.zones[k] ?? 0, b = nowZ.get(x.id)?.[k] ?? 0;
      sim[k] = (sim[k] || 0) + (p - y) ** 2; base[k] = (base[k] || 0) + (b - y) ** 2; cnt[k] = (cnt[k] || 0) + 1;
    }
    steps++;
  }
  const n = Object.values(cnt).reduce((a, b) => a + b, 0);
  const simAll = Object.values(sim).reduce((a, b) => a + b, 0) / (n || 1), baseAll = Object.values(base).reduce((a, b) => a + b, 0) / (n || 1);
  for (const k of Object.keys(cnt)) { sim[k] = r4(sim[k] / cnt[k]); base[k] = r4(base[k] / cnt[k]); }
  return { steps, n, sim, base, simAll: r4(simAll), baseAll: r4(baseAll) };
}
