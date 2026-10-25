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
/**
 * fix230: a split season whose split is played (a team past `after` games): each team's split group from the table
 * after the first `after` games of everyone (points, goal difference, goals), and the halving (Belgium up, Austria
 * down) applied to those points, with `rounded` set where a half point was rounded. `played` in kick-off order. The
 * provider's table only shows the halved points, our table from results would not. Mutates and returns `teams`.
 */
export function applySplit(teams: SimTeam[], played: (SimPlayed & { kickoff?: string })[], rules: LeagueRules): SimTeam[] {
  const sp = rules.split;
  if (!sp || rules.groupBy || !teams.some(t => t.played > sp.after)) return teams;
  const cnt = new Map<string, number>(), pre = new Map<string, { pts: number; gd: number; gf: number }>();
  for (const t of teams) { cnt.set(t.id, 0); pre.set(t.id, { pts: 0, gd: 0, gf: 0 }); }
  const pt = rules.points || { win: 3, draw: 1, loss: 0 };
  for (const g of played) {
    const h = cnt.get(g.home), a = cnt.get(g.away);
    if (h === undefined || a === undefined || h >= sp.after || a >= sp.after) continue;
    cnt.set(g.home, h + 1); cnt.set(g.away, a + 1);
    const H = pre.get(g.home)!, A = pre.get(g.away)!;
    H.gd += g.hg - g.ag; A.gd += g.ag - g.hg; H.gf += g.hg; A.gf += g.ag;
    H.pts += g.hg > g.ag ? pt.win : g.hg === g.ag ? pt.draw : pt.loss; A.pts += g.ag > g.hg ? pt.win : g.hg === g.ag ? pt.draw : pt.loss;
  }
  const order = teams.slice().sort((x, y) => { const X = pre.get(x.id)!, Y = pre.get(y.id)!; return Y.pts - X.pts || Y.gd - X.gd || Y.gf - X.gf; });
  sp.groups.forEach((grp, k) => { for (const t of order.slice(grp.from - 1, grp.to)) t.splitGroup = k; });
  if (sp.halve) for (const t of teams) {
    const before = pre.get(t.id)!.pts, half = sp.halve === 'up' ? Math.ceil(before / 2) : Math.floor(before / 2);
    t.pts += half - before; t.rounded = before % 2 ? 1 : 0;
  }
  return teams;
}

/**
 * fix230: table groups from the schedule — teams of a group play each other, so an edge whose two teams share few
 * opponents (Argentina's one interzonal game a team) is not a group edge; the rest fall apart into the groups. Null
 * when that gives fewer than two groups or a group under three teams.
 */
export function inferGroups(ids: string[], games: { home: string; away: string }[]): Map<string, string> | null {
  const nb = new Map(ids.map(i => [i, new Set<string>()] as [string, Set<string>]));
  for (const g of games) { if (g.home === g.away || !nb.has(g.home) || !nb.has(g.away)) continue; nb.get(g.home)!.add(g.away); nb.get(g.away)!.add(g.home); }
  const parent = new Map(ids.map(i => [i, i] as [string, string]));
  const find = (x: string): string => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x)!)!); x = parent.get(x)!; } return x; };
  for (const [a, A] of nb) for (const b of A) {
    if (a >= b) continue;
    const B = nb.get(b)!;
    let common = 0; for (const c of A) if (B.has(c)) common++;
    if (common >= 0.5 * Math.min(A.size, B.size) - 1) parent.set(find(a), find(b));
  }
  const comp = new Map<string, string[]>();
  for (const i of ids) { if (!nb.get(i)!.size) continue; const r = find(i); (comp.get(r) || comp.set(r, []).get(r)!).push(i); }
  const list = [...comp.values()].sort((x, y) => y.length - x.length || x.slice().sort()[0].localeCompare(y.slice().sort()[0]));
  if (list.length < 2 || list.some(c => c.length < 3)) return null;
  const out = new Map<string, string>();
  list.forEach((c, k) => c.forEach(i => out.set(i, `Group ${String.fromCharCode(65 + k)}`)));
  return out;
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

export interface ReplayLeague { sport: FcSport; code: string; name: string; season: string; rules: LeagueRules; teams: { id: string; name: string; group?: string; div?: string }[]; games: { home: string; away: string; hg: number; ag: number; kickoff: string }[]; preds: { home: string; away: string; m: number; at: string }[]; base: SimParams
  /** fix218: replay only these matchweeks (week index from the first game; default: every week), fewer runs */
  opts?: { weeks?: number[]; runs?: number } }
export interface ReplayOut { steps: number; n: number; sim: Record<string, number>; base: Record<string, number>; simAll: number; baseAll: number
  /** fix218: how the extreme forecasts came out — ≥ 99 % said (hi) and ≤ 1 % said (lo): n forecasts, how many happened */
  extremes: { hi: { n: number; hits: number }; lo: { n: number; hits: number } } }
/** fix218: the (noise, walk) pairs tried by the fit, as multiples of the sport's base noise */
export const NOISE_GRID = { noise: [0.5, 1, 1.5, 2, 3], walk: [0, 0.5, 1, 2] };
/**
 * fix218: fit the season uncertainty on last season: every (noise, walk) pair of the grid replayed at matchweeks 5,
 * 10 and 20 (600 runs); the pair with the best mean Brier on title / first zone / relegation wins. Pure (thread job).
 */
export function fitNoiseHere(L: ReplayLeague): { noise: number; walk: number; brier: number; tried: { noise: number; walk: number; brier: number }[] } {
  const tried: { noise: number; walk: number; brier: number }[] = [];
  const base = L.base.noise || 0.1;
  for (const nm of NOISE_GRID.noise) for (const wm of NOISE_GRID.walk) {
    const noise = r4(base * nm), walk = r4(base * wm);
    const r = replayHere({ ...L, base: { ...L.base, noise, walk }, opts: { weeks: [5, 10, 20], runs: 600 } });
    if (r.n) tried.push({ noise, walk, brier: r.simAll });
  }
  const best = tried.slice().sort((a, b) => a.brier - b.brier)[0] || { noise: base, walk: 0, brier: NaN };
  return { ...best, tried };
}

/**
 * the zones scored in the replay: title, the first "good" zone, relegation. fix230: a title won in a post-season is
 * not in the regular-season data (the "what happened" run would draw it), so leagues with a post-season are scored on
 * the places (play-offs, top of the table); a zone over the annual table is not decided by one tournament.
 */
export function scoredZones(rules: LeagueRules): ZoneKey[] {
  const keys: ZoneKey[] = [];
  if (!rules.post && !rules.noTitle) keys.push('title');
  const own = rules.zones.filter(z => z.over !== 'annual');
  const good = own.find(z => ['cl', 'promotion'].includes(z.key))?.key
    || (rules.post?.kind === 'bracket' || rules.post?.kind === 'nfl' || rules.post?.kind === 'cross' || own.some(z => z.key === 'playoffs') ? 'playoffs' : own.find(z => z.key === 'top_group')?.key);
  if (good) keys.push(good);
  if (own.some(z => z.key === 'shield')) keys.push('shield');
  if (own.some(z => z.key === 'relegation')) keys.push('relegation');
  return keys;
}

/** thread job body: one league's replay (pure) */
export function replayHere(L: ReplayLeague): ReplayOut {
  const ids = L.teams.map(t => t.id), meta = new Map(L.teams.map(t => [t.id, t]));
  const sport = L.sport, keys = scoredZones(L.rules);
  // what happened: one run over the whole season with no games left (post-season by the same rules, the playoffs
  // themselves aren't in our regular-season data, so play-off zones are scored on the places)
  const finalTab = tableOf(ids, L.games, sport);
  const finalTeams = applySplit(ids.map(id => ({ ...finalTab.get(id)!, name: meta.get(id)!.name, group: meta.get(id)!.group, div: meta.get(id)!.div })), L.games, L.rules);
  const actual = simulateSeason(L.rules, finalTeams, L.games, [], { ...L.base, runs: 1, noise: 0 });
  const truth = new Map(actual.teams.map(t => [t.id, t.zones]));
  const first = Date.parse(L.games[0].kickoff), last = Date.parse(L.games[L.games.length - 1].kickoff);
  const sim: Record<string, number> = {}, base: Record<string, number> = {}, cnt: Record<string, number> = {};
  const extremes = { hi: { n: 0, hits: 0 }, lo: { n: 0, hits: 0 } };
  const runs = L.opts?.runs || L.base.runs;
  const weeks = L.opts?.weeks ? new Set(L.opts.weeks) : null;
  let steps = 0, week = 0;
  for (let t = first + 7 * DAY; t < last - 7 * DAY; t += 7 * DAY) {
    week++;
    if (weeks ? !weeks.has(week) : week < 3) continue;
    const known = L.games.filter(g => Date.parse(g.kickoff) < t), rest = L.games.filter(g => Date.parse(g.kickoff) >= t);
    if (!rest.length) break;
    // ratings from what was known: the results' margins (football: on the latent scale, ×0.3 a goal)
    const obs = known.map(g => ({ h: g.home, a: g.away, m: sport === 'football' ? 0.3 * Math.max(-3, Math.min(3, g.hg - g.ag)) : Math.max(-30, Math.min(30, g.hg - g.ag)), w: Math.exp(-(t - Date.parse(g.kickoff)) / (90 * DAY)) }));
    const fit = fitRatings(ids, obs, L.base.home, sport === 'football' ? 4 : 3);
    const tab = tableOf(ids, known, sport);
    const teams = applySplit(ids.map(id => ({ ...tab.get(id)!, name: meta.get(id)!.name, rating: fit.r.get(id) || 0, group: meta.get(id)!.group, div: meta.get(id)!.div })), known, L.rules);
    // fix230: a split still to come is made by each run (the engine drops the real post-split games); a split already
    // played keeps the groups the table gave (applySplit)
    const out = simulateSeason(L.rules, teams, known, rest.map((g, k) => ({ id: String(k), home: g.home, away: g.away })), { ...L.base, runs, home: fit.home, seed: L.base.seed + steps });
    // baseline: the table as it stands, run with no games left
    const now = simulateSeason(L.rules, teams, known, [], { ...L.base, runs: 1, noise: 0 });
    const nowZ = new Map(now.teams.map(x => [x.id, x.zones]));
    for (const x of out.teams) for (const k of keys) {
      const y = truth.get(x.id)?.[k] ?? 0, p = x.zones[k] ?? 0, b = nowZ.get(x.id)?.[k] ?? 0;
      sim[k] = (sim[k] || 0) + (p - y) ** 2; base[k] = (base[k] || 0) + (b - y) ** 2; cnt[k] = (cnt[k] || 0) + 1;
      if (p >= 0.99) { extremes.hi.n++; if (y) extremes.hi.hits++; }
      if (p <= 0.01) { extremes.lo.n++; if (y) extremes.lo.hits++; }
    }
    steps++;
  }
  const n = Object.values(cnt).reduce((a, b) => a + b, 0);
  const simAll = Object.values(sim).reduce((a, b) => a + b, 0) / (n || 1), baseAll = Object.values(base).reduce((a, b) => a + b, 0) / (n || 1);
  for (const k of Object.keys(cnt)) { sim[k] = r4(sim[k] / cnt[k]); base[k] = r4(base[k] / cnt[k]); }
  return { steps, n, sim, base, simAll: r4(simAll), baseAll: r4(baseAll), extremes };
}
