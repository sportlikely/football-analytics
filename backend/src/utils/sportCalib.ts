/**
 * fix222 — the calibration layer of basketball and tennis (fix220's afCalib, per league). Pure functions (no database):
 * services/sportCalibration.ts (basketball) and services/tennisModel.ts (tennis) run them on our data.
 *
 *  - Platt scaling on the logit, p' = σ(a · logit(p) + b), a ≥ 0.05 (monotone). Tennis is symmetric (b = 0: who is
 *    listed first means nothing). One sport fit, and a fit per league shrunk toward it (ridge, LAMBDA games' worth).
 *  - Seasons: the layer is fitted on past seasons only, never on the live one (assertSeasons throws). The test: the
 *    last past season, calibrated with a fit on the seasons before it. A league keeps its layer only when it beats the
 *    raw chances there (100+ test games; fewer = the sport's verdict); the sport keeps a layer only when it beats raw.
 *  - Strong line per league: the lowest chance from which the calibrated picks were right ≥ 75% (afCalib.strongLine).
 */
import { fitPlatt, logit, scoreRows, pickBands, strongLine, MIN_A, IDENTITY, type Platt, type Score, type Band } from './afCalib';

export const LAMBDA = 150;
export interface LRow { p: number; y: number; season: number; league: string }
export interface LeagueLayer {
  /** the sport fit (null = no layer for the sport) and the leagues' own (only those kept) */
  sport: Platt | null; leagues: Record<string, Platt | null>;
  /** seasons the live layer was fitted on */
  seasons: number[]; symmetric: boolean;
  /** strong-pick line per league (calibrated picks right ≥ 75%), and the sport's */
  strong: Record<string, number>; strongSport: number | null;
}

const sig = (x: number) => 1 / (1 + Math.exp(-x));
/** a symmetric Platt (b = 0): Newton steps on a, with an optional ridge toward `prior` */
function fitSym(rows: { p: number; y: number }[], prior: Platt = IDENTITY, lam = 0): Platt {
  if (!rows.length) return { ...prior, b: 0, n: 0 };
  const xs = rows.map(r => logit(r.p));
  let a = prior.a;
  for (let it = 0; it < 30; it++) {
    let g = -lam * (a - prior.a), h = lam;
    for (let i = 0; i < xs.length; i++) { const q = sig(a * xs[i]); g += (rows[i].y - q) * xs[i]; h += Math.max(1e-9, q * (1 - q)) * xs[i] * xs[i]; }
    if (!(h > 1e-12)) break;
    const d = g / h;
    a += d;
    if (Math.abs(d) < 1e-8) break;
  }
  return Number.isFinite(a) ? { a: Math.max(MIN_A, a), b: 0, n: rows.length } : { ...prior, b: 0, n: rows.length };
}
const fit = (rows: { p: number; y: number }[], symmetric: boolean, prior?: Platt, lam = 0) => (symmetric ? fitSym(rows, prior, lam) : fitPlatt(rows, prior, lam));

export function assertSeasons(seasons: number[], first: number, last: number) {
  for (const s of seasons) if (s < first || s > last) throw new Error(`calibration fit on ${s} is not allowed (fit seasons: ${first}–${last})`);
}

/** sport fit + per-league fits shrunk toward it, on `rows` (seasons checked against [first, last]) */
export function fitLayer(rows: LRow[], first: number, last: number, symmetric: boolean): { sport: Platt | null; leagues: Record<string, Platt> } {
  assertSeasons([...new Set(rows.map(r => r.season))], first, last);
  const sport = rows.length >= 100 ? fit(rows, symmetric) : null;
  const leagues: Record<string, Platt> = {};
  if (sport) for (const lg of [...new Set(rows.map(r => r.league))]) {
    const sel = rows.filter(r => r.league === lg);
    if (sel.length >= 30) leagues[lg] = fit(sel, symmetric, sport, LAMBDA);
  }
  return { sport, leagues };
}

const applyP = (f: Platt | null | undefined, p: number) => (f && Number.isFinite(p) ? sig(f.a * logit(p) + f.b) : p);
/** the calibrated chance of `league` (no layer = as it is) */
export function applyLayer(L: LeagueLayer | null | undefined, league: string, p: number): number {
  if (!L) return p;
  const own = L.leagues[league];
  return own === null ? p : applyP(own ?? L.sport, p);
}

export interface LeagueReport { league: string; games: number; raw: Score; cal: Score; kept: boolean; why: string; rawBands: Band[]; calBands: Band[] }
/**
 * The whole build: walk-forward test on `test` (fit on first … test − 1), the decision per league, the live layer on
 * first … last (test ≤ last < the live season), the strong lines, and the live season(s) reported raw vs calibrated.
 */
export function buildLayer(rows: LRow[], o: { first: number; test: number; last: number; symmetric: boolean; strongDefault: number }) {
  const past = rows.filter(r => r.season >= o.first && r.season <= o.last);
  const trainT = past.filter(r => r.season < o.test), testT = past.filter(r => r.season === o.test);
  const fT = fitLayer(trainT, o.first, o.test - 1, o.symmetric);
  const calT = (r: LRow, mode: 'own' | 'sport') => applyP(mode === 'own' ? fT.leagues[r.league] ?? fT.sport : fT.sport, r.p);
  const sc = (list: LRow[], f: (r: LRow) => number) => scoreRows(list.map(r => ({ p: f(r), y: r.y })));
  const rawAll = sc(testT, r => r.p), sportAll = sc(testT, r => calT(r, 'sport')), ownAll = sc(testT, r => calT(r, 'own'));
  const better = (a: Score, b: Score) => a.logLoss !== null && b.logLoss !== null && a.logLoss < b.logLoss - 0.0002;
  const sportKept = !!fT.sport && (better(ownAll, rawAll) || better(sportAll, rawAll));
  const leaguesList = [...new Set(past.map(r => r.league))].sort();
  const decide: Record<string, 'own' | 'sport' | 'none'> = {};
  const perLeague: LeagueReport[] = [];
  for (const lg of leaguesList) {
    const t = testT.filter(r => r.league === lg);
    const raw = sc(t, r => r.p), own = sc(t, r => calT(r, 'own')), sport = sc(t, r => calT(r, 'sport'));
    let d: 'own' | 'sport' | 'none';
    let why: string;
    if (t.length >= 100) {
      d = better(own, raw) && (!better(sport, own)) && fT.leagues[lg] ? 'own' : better(sport, raw) && fT.sport ? 'sport' : 'none';
      why = `${o.test}: raw LL ${raw.logLoss}, own fit ${own.logLoss}, sport fit ${sport.logLoss} (${t.length} games)`;
    } else {
      d = sportKept ? (fT.leagues[lg] ? 'own' : 'sport') : 'none';
      why = `${t.length} test games (100 needed): the sport's verdict`;
    }
    decide[lg] = d;
    const calF = (r: LRow) => (d === 'none' ? r.p : calT(r, d));
    perLeague.push({ league: lg, games: t.length, raw, cal: sc(t, calF), kept: d !== 'none', why: `${why} → ${d === 'none' ? 'no layer' : d === 'own' ? 'its own fit' : 'the sport fit'}`, rawBands: pickBands(t.map(r => ({ p: r.p, y: r.y }))), calBands: pickBands(t.map(r => ({ p: calF(r), y: r.y }))) });
  }
  // the live layer: every past season up to `last`
  const fL = fitLayer(past, o.first, o.last, o.symmetric);
  const layer: LeagueLayer | null = Object.values(decide).some(d => d !== 'none') && fL.sport ? {
    sport: sportKept ? fL.sport : null,
    leagues: Object.fromEntries(leaguesList.map(lg => [lg, decide[lg] === 'none' ? null : decide[lg] === 'own' ? fL.leagues[lg] ?? fL.sport : fL.sport])),
    seasons: [...new Set(past.map(r => r.season))].sort((a, b) => a - b), symmetric: o.symmetric, strong: {}, strongSport: null
  } : null;
  // strong lines on the chances as shown in the walk-forward test (the test season, calibrated by the fit before it)
  const shownT = testT.map(r => ({ ...r, p: decide[r.league] === 'none' ? r.p : calT(r, decide[r.league] as 'own' | 'sport') }));
  const strongSport = strongLine(shownT) ?? o.strongDefault;
  const strong: Record<string, number> = {};
  for (const lg of leaguesList) strong[lg] = strongLine(shownT.filter(r => r.league === lg)) ?? strongSport;
  if (layer) { layer.strong = strong; layer.strongSport = strongSport; }
  // the live season(s): reported, never fitted
  const live = rows.filter(r => r.season > o.last);
  const liveCal = live.map(r => ({ ...r, p: applyLayer(layer, r.league, r.p) }));
  return {
    layer, strong, strongSport,
    test: { season: o.test, fitOn: [...new Set(trainT.map(r => r.season))].sort((a, b) => a - b), raw: rawAll, sportFit: sportAll, ownFit: ownAll, sportKept, rawBands: pickBands(testT), calBands: pickBands(shownT) },
    perLeague,
    live: { games: live.length, raw: scoreRows(live), cal: scoreRows(liveCal), rawBands: pickBands(live), calBands: pickBands(liveCal) }
  };
}
