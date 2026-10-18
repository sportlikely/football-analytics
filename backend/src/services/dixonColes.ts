import { slicer } from './perf';
/**
 * Dixon-Coles model fitted by maximum likelihood with time decay.
 *
 *   λ (home goals) = exp(c + γ + a_home − d_away)
 *   μ (away goals) = exp(c     + a_away − d_home)
 *   P(x, y) = τ(x, y) · Pois(x; λ) · Pois(y; μ)      τ = low-score correction (ρ)
 *
 * Each match is weighted w = exp(−ξ · daysAgo) so recent form matters more.
 * Attack/defence are regularised toward 0 so teams with little data sit near
 * league average instead of taking extreme values.
 *
 * Fitting: Newton-like coordinate updates for a, d, c, γ on the Poisson
 * likelihood (very fast, converges in a few dozen sweeps), then ρ by 1-D search
 * on the full Dixon-Coles likelihood.
 */

export interface FitMatch {
  date: string; // YYYY-MM-DD
  home: string;
  away: string;
  hg: number;
  ag: number;
}

export interface DCParams {
  attack: Record<string, number>;
  defence: Record<string, number>;
  homeAdv: number; // γ
  intercept: number; // c
  rho: number;
  fittedAt: string; // reference date used for decay
  teams: string[];
  weightSum: Record<string, number>; // evidence per team (sum of match weights)
}

export interface DCOptions {
  halfLifeDays?: number; // decay half-life (default 180)
  ridge?: number; // regularisation toward 0 for a, d (default 1.0)
  sweeps?: number; // coordinate sweeps (default 40)
  maxDays?: number; // ignore matches older than this (default 1200)
  warm?: DCParams | null;
}

const DAY = 24 * 3600 * 1000;

function daysBetween(a: string, b: string) {
  return (new Date(a).getTime() - new Date(b).getTime()) / DAY;
}

export function fitDixonColes(matches: FitMatch[], asOf: string, opts: DCOptions = {}): DCParams {
  const g = fitSteps(matches, asOf, opts);
  let r = g.next();
  while (!r.done) r = g.next();
  return r.value;
}
/** fix169: the same fit giving way to visitors every ~30 ms (between sweeps). */
export async function fitDixonColesAsync(matches: FitMatch[], asOf: string, opts: DCOptions = {}): Promise<DCParams> {
  const g = fitSteps(matches, asOf, opts);
  const slice = slicer();
  let r = g.next();
  while (!r.done) { await slice(); r = g.next(); }
  return r.value;
}

/** fix169: the fit as a generator that pauses after every sweep (sync and async wrappers below). */
function* fitSteps(matches: FitMatch[], asOf: string, opts: DCOptions = {}): Generator<void, DCParams> {
  const halfLife = opts.halfLifeDays ?? 180;
  const xi = Math.log(2) / halfLife;
  const ridge = opts.ridge ?? 1.0;
  const sweeps = opts.sweeps ?? 40;
  const maxDays = opts.maxDays ?? 1200;

  // Weighted match list
  const ms = matches
    .map(m => ({ ...m, w: Math.exp(-xi * daysBetween(asOf, m.date)), age: daysBetween(asOf, m.date) }))
    .filter(m => m.age >= 0 && m.age <= maxDays && m.w > 1e-4);

  const teams = Array.from(new Set(ms.flatMap(m => [m.home, m.away]))).sort();
  const idx = new Map(teams.map((t, i) => [t, i]));
  const n = teams.length;
  const a = new Float64Array(n);
  const d = new Float64Array(n);
  let c = 0;
  let gamma = 0.25;
  if (opts.warm) {
    teams.forEach((t, i) => {
      a[i] = opts.warm!.attack[t] ?? 0;
      d[i] = opts.warm!.defence[t] ?? 0;
    });
    c = opts.warm.intercept;
    gamma = opts.warm.homeAdv;
  }

  // Precompute per-team weight sums (evidence) for step sizes
  const wSum = new Float64Array(n);
  let wTotal = 0;
  for (const m of ms) {
    wSum[idx.get(m.home)!] += m.w;
    wSum[idx.get(m.away)!] += m.w;
    wTotal += m.w;
  }
  if (!ms.length) {
    return { attack: {}, defence: {}, homeAdv: 0.25, intercept: Math.log(1.3), rho: -0.1, fittedAt: asOf, teams: [], weightSum: {} };
  }
  if (!opts.warm) {
    const avg = ms.reduce((s, m) => s + m.w * (m.hg + m.ag), 0) / (2 * wTotal);
    c = Math.log(Math.max(0.2, avg));
  }

  const hi = new Int32Array(ms.length);
  const ai = new Int32Array(ms.length);
  ms.forEach((m, k) => {
    hi[k] = idx.get(m.home)!;
    ai[k] = idx.get(m.away)!;
  });

  // Sequential Newton-style sweeps on the Poisson likelihood:
  // (1) attack/defence given constants, (2) intercept, (3) home advantage.
  const lamMu = (k: number) => {
    const h = hi[k];
    const v = ai[k];
    return [Math.exp(c + gamma + a[h] - d[v]), Math.exp(c + a[v] - d[h])];
  };
  for (let s = 0; s < sweeps; s++) {
    const gA = new Float64Array(n);
    const gD = new Float64Array(n);
    const hA = new Float64Array(n);
    const hD = new Float64Array(n);
    for (let k = 0; k < ms.length; k++) {
      const m = ms[k];
      const h = hi[k];
      const v = ai[k];
      const [lam, mu] = lamMu(k);
      const rh = m.w * (m.hg - lam);
      const ra = m.w * (m.ag - mu);
      gA[h] += rh;
      hA[h] += m.w * lam;
      gD[v] -= rh;
      hD[v] += m.w * lam;
      gA[v] += ra;
      hA[v] += m.w * mu;
      gD[h] -= ra;
      hD[h] += m.w * mu;
    }
    // damped so that the simultaneous attack/defence moves don't overshoot
    for (let i = 0; i < n; i++) {
      a[i] += 0.5 * ((gA[i] - 2 * ridge * a[i]) / (hA[i] + 2 * ridge));
      d[i] += 0.5 * ((gD[i] - 2 * ridge * d[i]) / (hD[i] + 2 * ridge));
    }
    // centre attack and defence (identifiability), absorb the shift into c
    let ma = 0;
    let md = 0;
    for (let i = 0; i < n; i++) {
      ma += a[i];
      md += d[i];
    }
    ma /= n;
    md /= n;
    for (let i = 0; i < n; i++) {
      a[i] -= ma;
      d[i] -= md;
    }
    c += ma - md;

    // intercept
    let gC = 0;
    let hC = 0;
    for (let k = 0; k < ms.length; k++) {
      const [lam, mu] = lamMu(k);
      gC += ms[k].w * (ms[k].hg - lam + ms[k].ag - mu);
      hC += ms[k].w * (lam + mu);
    }
    c += gC / hC;

    // home advantage
    let gG = 0;
    let hG = 0;
    for (let k = 0; k < ms.length; k++) {
      const [lam] = lamMu(k);
      gG += ms[k].w * (ms[k].hg - lam);
      hG += ms[k].w * lam;
    }
    gamma += gG / hG;
    yield;
  }

  // ρ by 1-D search on the DC likelihood (λ, μ fixed)
  const lamArr = new Float64Array(ms.length);
  const muArr = new Float64Array(ms.length);
  for (let k = 0; k < ms.length; k++) {
    lamArr[k] = Math.exp(c + gamma + a[hi[k]] - d[ai[k]]);
    muArr[k] = Math.exp(c + a[ai[k]] - d[hi[k]]);
  }
  const llRho = (rho: number) => {
    let ll = 0;
    for (let k = 0; k < ms.length; k++) {
      const m = ms[k];
      const t = tau(m.hg, m.ag, lamArr[k], muArr[k], rho);
      if (t <= 0) return -Infinity;
      ll += m.w * Math.log(t);
    }
    return ll;
  };
  let bestRho = 0;
  let bestLL = -Infinity;
  for (let r = -0.3; r <= 0.3; r += 0.01) {
    const ll = llRho(r);
    if (ll > bestLL) {
      bestLL = ll;
      bestRho = r;
    }
  }

  const attack: Record<string, number> = {};
  const defence: Record<string, number> = {};
  const weightSum: Record<string, number> = {};
  teams.forEach((t, i) => {
    attack[t] = a[i];
    defence[t] = d[i];
    weightSum[t] = wSum[i];
  });
  return { attack, defence, homeAdv: gamma, intercept: c, rho: Math.round(bestRho * 1000) / 1000, fittedAt: asOf, teams, weightSum };
}

export function tau(x: number, y: number, lam: number, mu: number, rho: number) {
  if (x === 0 && y === 0) return 1 - lam * mu * rho;
  if (x === 0 && y === 1) return 1 + lam * rho;
  if (x === 1 && y === 0) return 1 + mu * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}

function poisson(lambda: number, k: number) {
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) p *= lambda / i;
  return p;
}

export interface DCPrediction {
  home: number;
  draw: number;
  away: number;
  lambdaHome: number;
  lambdaAway: number;
  over25: number;
  btts: number;
  topScores: { home: number; away: number; prob: number }[];
  evidence: { home: number; away: number }; // weighted games behind each team
  strengths: { homeAttack: number; homeDefence: number; awayAttack: number; awayDefence: number };
}

const MAX_GOALS = 10;

/** Predict a match between two football-data.co.uk team names. */
export function predictDC(p: DCParams, home: string, away: string): DCPrediction | null {
  if (!(home in p.attack) || !(away in p.attack)) return null;
  const lam = Math.exp(p.intercept + p.homeAdv + p.attack[home] - p.defence[away]);
  const mu = Math.exp(p.intercept + p.attack[away] - p.defence[home]);

  let pH = 0;
  let pD = 0;
  let pA = 0;
  let o25 = 0;
  let btts = 0;
  let mass = 0;
  const scores: { home: number; away: number; prob: number }[] = [];
  for (let i = 0; i <= MAX_GOALS; i++) {
    for (let j = 0; j <= MAX_GOALS; j++) {
      const pr = poisson(lam, i) * poisson(mu, j) * tau(i, j, lam, mu, p.rho);
      mass += pr;
      scores.push({ home: i, away: j, prob: pr });
      if (i > j) pH += pr;
      else if (i === j) pD += pr;
      else pA += pr;
      if (i + j > 2.5) o25 += pr;
      if (i > 0 && j > 0) btts += pr;
    }
  }
  const pct = (x: number) => Math.round((x / mass) * 1000) / 10;
  return {
    home: pct(pH),
    draw: pct(pD),
    away: pct(pA),
    lambdaHome: Math.round(lam * 100) / 100,
    lambdaAway: Math.round(mu * 100) / 100,
    over25: pct(o25),
    btts: pct(btts),
    topScores: scores
      .sort((x, y) => y.prob - x.prob)
      .slice(0, 3)
      .map(s => ({ home: s.home, away: s.away, prob: pct(s.prob) })),
    evidence: { home: p.weightSum[home] ?? 0, away: p.weightSum[away] ?? 0 },
    strengths: {
      homeAttack: Math.round(Math.exp(p.attack[home]) * 100) / 100,
      homeDefence: Math.round(Math.exp(-p.defence[home]) * 100) / 100, // goals-conceded multiplier (<1 good)
      awayAttack: Math.round(Math.exp(p.attack[away]) * 100) / 100,
      awayDefence: Math.round(Math.exp(-p.defence[away]) * 100) / 100
    }
  };
}
