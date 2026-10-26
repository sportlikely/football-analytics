/**
 * Upset alerts (Pro) — research step (Oct 2026).
 *
 * Idea (same as draw alerts): the bookmakers make a team the clear outsider, but our model gives it a much better
 * chance. Bookmaker prices are only used here, behind the scenes, to choose alerts and to measure them; they are
 * never shown on the public site and never feed the model.
 *
 *   our win chance = market chance + K × (v3 chance − market chance)
 *   alert when the team is the outsider (market chance ≤ CUT), v3 ≥ market + MIN_GAP, and
 *   our chance × early price − 1 is between MIN_EDGE and MAX_EDGE
 *
 * backtestUpsets(): walk-forward v3 backtests (latest run per season × group), priced at the early price, with the
 * share of alerts where the price then shortened (moved our way) by the close.
 */
import { db } from '../db';
import { doubleChance } from '../utils/doubleChance';
import { footballSignals, footballStature, footballTier, historySignals, historyStature, watchReport, type Candidate, type Past, type Side } from '../utils/upsetWatch';

export interface UpsetRule { K: number; cut: number; minGap: number; minEdge: number; maxEdge: number }
export const UPSET_RULE: UpsetRule = { K: 0.75, cut: 0.33, minGap: 0.04, minEdge: 0.03, maxEdge: 0.3 };

function fair(o: (number | null)[]): number[] | null {
  if (o.some(x => !x || x <= 1)) return null;
  const inv = o.map(x => 1 / (x as number));
  const s = inv.reduce((a, b) => a + b, 0);
  return inv.map(x => x / s);
}

interface Row { season: string; grp: string; division: string; ph: number; pa: number; out: string; eh: number | null; ed: number | null; ea: number | null; ch: number | null; cd: number | null; ca: number | null }

function rows(): Row[] {
  const runs = db.prepare(`
    SELECT r.id, r.season, r.grp FROM backtest_runs r
    WHERE r.model = 'grid-v3' AND r.finished_at IS NOT NULL
      AND r.id = (SELECT MAX(id) FROM backtest_runs x WHERE x.model = r.model AND x.season = r.season AND x.grp = r.grp AND x.finished_at IS NOT NULL)
  `).all() as any[];
  const q = db.prepare(`
    SELECT division, p_home ph, p_away pa, outcome out, early_h eh, early_d ed, early_a ea, odds_home ch, odds_draw cd, odds_away ca
    FROM backtest_predictions WHERE run_id = ?
  `);
  const out: Row[] = [];
  for (const r of runs) for (const x of q.all(r.id) as any[]) out.push({ ...x, season: r.season, grp: r.grp });
  return out;
}

/** The alert for one side of one match, or null. v3 in %, prices decimal. */
export function upsetOf(v3: number, side: 0 | 2, early: (number | null)[], rule: UpsetRule = UPSET_RULE) {
  const f = fair(early);
  if (!f) return null;
  const mkt = f[side], price = early[side] as number;
  const p = v3 / 100;
  if (mkt > rule.cut || p < mkt + rule.minGap) return null;
  const ours = mkt + rule.K * (p - mkt);
  const edge = ours * price - 1;
  if (edge < rule.minEdge || edge > rule.maxEdge) return null;
  return { mkt, ours, price, edge };
}

function evalRule(list: Row[], rule: UpsetRule) {
  let n = 0, wins = 0, profit = 0, moved = 0, movedN = 0, sumMkt = 0, sumOurs = 0;
  const games = new Set<Row>();
  for (const r of list) {
    const early = [r.eh, r.ed, r.ea];
    for (const side of [0, 2] as const) {
      const a = upsetOf(side === 0 ? r.ph : r.pa, side, early, rule);
      if (!a) continue;
      n++; games.add(r);
      const won = r.out === (side === 0 ? 'H' : 'A');
      if (won) wins++;
      profit += won ? a.price - 1 : -1;
      sumMkt += a.mkt; sumOurs += a.ours;
      const close = side === 0 ? r.ch : r.ca;
      if (close && close > 1 && close !== a.price) { movedN++; if (close < a.price) moved++; }
    }
  }
  const p1 = (x: number) => Math.round(x * 10) / 10;
  return {
    alerts: n, games: games.size, winRate: n ? p1((100 * wins) / n) : null,
    expectedByMarket: n ? p1((100 * sumMkt) / n) : null, expectedByUs: n ? p1((100 * sumOurs) / n) : null,
    roi: n ? p1((100 * profit) / n) : null, movedOurWay: movedN ? p1((100 * moved) / movedN) : null
  };
}

/**
 * Backtest: the current rule per season, plus a grid fitted on every season but the newest and scored on the newest.
 */
export function backtestUpsets(rule: Partial<UpsetRule> = {}, grid = false) {
  const all = rows().filter(r => r.eh && r.ed && r.ea);
  const seasons = [...new Set(all.map(r => r.season))].sort();
  const R: UpsetRule = { ...UPSET_RULE, ...rule };
  const out: any = {
    rows: all.length, seasons, rule: R,
    bySeason: Object.fromEntries(seasons.map(s => [s, evalRule(all.filter(r => r.season === s), R)])),
    byGroup: Object.fromEntries([...new Set(all.map(r => r.grp))].sort().map(g => [g, evalRule(all.filter(r => r.grp === g), R)]))
  };
  if (grid && seasons.length >= 2) {
    const test = seasons[seasons.length - 1];
    const train = all.filter(r => r.season !== test), hold = all.filter(r => r.season === test);
    const res: any[] = [];
    for (const K of [0.5, 0.75, 1]) for (const cut of [0.25, 0.33, 0.4]) for (const minGap of [0, 0.04, 0.08])
      for (const minEdge of [0.02, 0.05, 0.1]) for (const maxEdge of [0.2, 0.3, 0.5]) {
        const r: UpsetRule = { K, cut, minGap, minEdge, maxEdge };
        const tr = evalRule(train, r);
        if (tr.alerts < 150) continue; // too few to judge
        res.push({ rule: r, train: tr, test: evalRule(hold, r) });
      }
    res.sort((a, b) => (b.train.roi ?? -99) - (a.train.roi ?? -99));
    out.grid = { trainSeasons: seasons.slice(0, -1), testSeason: test, tried: res.length, best: res.slice(0, 12) };
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Upset watch (Pro, Oct 2026): model only, no bookmakers              */
/* ------------------------------------------------------------------ */
// The upset rule vs the market did not hold (claude/upset-alerts-test.md), so the Pro feature is content, not an
// edge: games where OUR model gives the underdog a real chance. Judged by calibration ("when we say 33%, do 33% win?").
// fix188: one rule in every sport: the underdog between 20% and 45% to win; a 45–55% game is a coin flip, not an upset
export const WATCH = { minUnderdog: 20, maxUnderdog: 45, minGap: 10 };
/** The record's bands (the same in every sport). */
export const WATCH_BANDS: [number, number][] = [[20, 30], [30, 40], [40, 45]];
export const watchBands = () => WATCH_BANDS.map(([lo, hi]) => ({ range: `${lo}–${hi}%`, lo, hi, n: 0, upsets: 0, said: 0 }));
export const bandOf = <B extends { lo: number; hi: number }>(bands: B[], p: number) => bands.find((x, i) => p >= x.lo && (p < x.hi || i === bands.length - 1))!;

/** Underdog side and numbers when a prediction makes the cut (probabilities in %), else null. */
export function watchOf(ph: number, pd: number, pa: number) {
  const fav = ph >= pa ? 'H' : 'A';
  const fp = Math.max(ph, pa), up = Math.min(ph, pa);
  if (up < WATCH.minUnderdog || up > WATCH.maxUnderdog || fp - up < WATCH.minGap) return null;
  return { favourite: fav as 'H' | 'A', underdog: (fav === 'H' ? 'A' : 'H') as 'H' | 'A', favChance: fp, upsetChance: up, draw: pd };
}

const crestOf = (id?: number | null) =>
  !id ? null : id >= 1_000_000_000 ? `https://media.api-sports.io/football/teams/${id - 1_000_000_000}.png` : `https://crests.football-data.org/${id}.png`;
const MODELS = ['grid-v3', 'elo-euro', 'elo-intl'];
const rank = (m: string) => MODELS.indexOf(m);
const r1 = (x: number) => Math.round(x * 10) / 10;

function bestPerMatch(rows: any[]) {
  const best = new Map<number, any>();
  for (const r of rows) { const c = best.get(r.match_id); if (!c || rank(r.model) < rank(c.model)) best.set(r.match_id, r); }
  return [...best.values()];
}

/** fix120: our recommended pick (double chance) for alerts: { k: '1X' | 'X2' | '12', p } */
export function dcPick(h: number, d: number, a: number) {
  const x = doubleChance(Number(h), Number(d), Number(a));
  return x ? { k: x.k, p: r1(x.p) } : null;
}

/**
 * fix242: the upset watch (Pro, model only): this week's games where the favourite is 50%+ and the underdog 25%+ with a
 * clear reason (utils/upsetWatch.ts), and the last 30 days' record of the same rule. Reasons: the grid-v3 rows saved
 * with the prediction; UEFA cups / national teams (Elo models, no rows) from the teams' own results.
 */
export function upsetWatchReport(now = Date.now()) {
  const nowIso = new Date(now).toISOString(), soon = new Date(now + 7 * 86400000).toISOString();
  const since = new Date(now - 31 * 86400000).toISOString();
  const up = bestPerMatch(db.prepare(`
    SELECT match_id, model, competition_name, competition_code, utc_date, home_team, away_team, home_team_id, away_team_id, p_home, p_draw, p_away, payload
    FROM predictions WHERE settled = 0 AND utc_date > ? AND utc_date < ? AND model IN ('grid-v3', 'elo-euro', 'elo-intl')
  `).all(nowIso, soon) as any[]);
  // the record: settled games of the last 30 days (the saved prediction from before kick-off)
  const done = bestPerMatch(db.prepare(`
    SELECT p.match_id, p.model, p.competition_name, p.competition_code, p.utc_date, p.home_team, p.away_team, p.home_team_id, p.away_team_id,
           p.p_home, p.p_draw, p.p_away, p.payload, r.home_goals, r.away_goals, r.outcome
    FROM predictions p JOIN results r ON r.match_id = p.match_id
    WHERE p.settled = 1 AND r.outcome IN ('H','D','A') AND p.utc_date > ? AND p.utc_date <= ? AND p.model IN ('grid-v3', 'elo-euro', 'elo-intl')
  `).all(since, nowIso) as any[]);
  // a team's finished games (every competition we cover), for the games without grid rows
  const histQ = db.prepare(`SELECT p.match_id, p.utc_date, p.home_team_id h, p.away_team_id a, r.outcome FROM predictions p JOIN results r ON r.match_id = p.match_id
    WHERE (p.home_team_id = ? OR p.away_team_id = ?) AND p.utc_date > ? AND r.outcome IN ('H','D','A') GROUP BY p.match_id`);
  const hist = new Map<number, Past[]>();
  const historyOf = (id: number | null) => {
    if (!id) return [];
    if (!hist.has(id)) hist.set(id, (histQ.all(id, id, new Date(now - 3 * 365 * 86400000).toISOString()) as any[]).map(g => ({
      date: g.utc_date, home: g.h === id, won: g.outcome === (g.h === id ? 'H' : 'A'), opp: g.h === id ? g.a : g.h
    })));
    return hist.get(id)!;
  };
  const rowsOf = (r: any) => { try { return JSON.parse(r.payload || 'null')?.grid?.rows || null; } catch { return null; } };
  const cand = (r: any): Candidate => {
    const rows = r.model === 'grid-v3' ? rowsOf(r) : null;
    const hx = (fav: Side) => ({ kickoff: r.utc_date, fav, games: { H: historyOf(r.home_team_id), A: historyOf(r.away_team_id) }, ids: { H: r.home_team_id, A: r.away_team_id } });
    return {
      matchId: r.match_id, league: r.competition_name || r.competition_code, tier: footballTier(r.competition_code), date: r.utc_date,
      home: r.home_team, away: r.away_team, homeCrest: crestOf(r.home_team_id), awayCrest: crestOf(r.away_team_id),
      pHome: Number(r.p_home), pDraw: Number(r.p_draw), pAway: Number(r.p_away),
      signals: fav => (rows ? footballSignals(rows, fav) : historySignals(hx(fav))),
      stature: fav => (rows ? footballStature(rows, fav) : historyStature(hx(fav)))
    };
  };
  return { sport: 'football' as const, ...watchReport(up.map(cand), done.map(r => ({ ...cand(r), outcome: r.outcome, score: `${r.home_goals}-${r.away_goals}` })), now) };
}

/** Admin: the same cut on the walk-forward backtests (calibration only; v3 league games). */
export function upsetWatchBacktest() {
  const all = rows();
  const seasons = [...new Set(all.map(r => r.season))].sort();
  const one = (list: Row[]) => {
    let n = 0, up = 0, said = 0;
    for (const r of list) {
      const w = watchOf(r.ph, 100 - r.ph - r.pa, r.pa);
      if (!w) continue;
      n++; said += w.upsetChance; if (r.out === w.underdog) up++;
    }
    return { n, said: n ? r1(said / n) : null, happened: n ? r1((100 * up) / n) : null };
  };
  return { rule: WATCH, bySeason: Object.fromEntries(seasons.map(s => [s, one(all.filter(r => r.season === s))])), all: one(all) };
}
