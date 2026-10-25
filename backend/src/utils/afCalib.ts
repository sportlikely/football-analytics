/**
 * fix220 — honest percentages: the calibration layer of American football and the said-vs-happened check every sport
 * runs in data health. Pure functions (no database); services/afCalibration.ts runs them on our data.
 *
 *  - Platt scaling on the logit: p' = σ(a · logit(p) + b), with a ≥ 0.05 so the layer is monotone (a bigger chance
 *    stays bigger). College is fitted per segment (FBS vs FCS, conference game, other games), each segment's (a, b)
 *    shrunk toward the league's own fit (ridge, LAMBDA games' worth); the NFL has one fit.
 *  - Walk-forward: season S is calibrated with a fit on the seasons before it only (2021 → S − 1). The live layer is
 *    fitted on 2021–2025. 2026 is never in a fit (assertCalibSeasons throws): it is the test.
 *  - strongLine: the lowest chance from which the calibrated picks were right at least 75% of the time (50+ games).
 *  - calibCheck: said vs happened per band of the picked side's chance; fail when a band of 50+ games is more than
 *    5 points off, with 100+ games in all.
 */

export const CALIB_FIRST = 2021;
export const CALIB_LAST = 2025;
/** Ridge pull of a segment's fit toward the league fit, in games. */
export const LAMBDA = 150;
export const MIN_A = 0.05;

export type Seg = 'mismatch' | 'conf' | 'other';
export interface CalRow { p: number; y: number; season: number; seg?: Seg }
export interface Platt { a: number; b: number; n: number }
export interface Calib { global: Platt; segs: Partial<Record<Seg, Platt>>; seasons: number[] }

/** A college game's segment: FBS vs FCS, conference game (same conference, not independents), or other. */
export function segOfTeams(h?: { conf: string | null; level: string | null } | null, a?: { conf: string | null; level: string | null } | null): Seg {
  if (!h || !a) return 'other';
  if ((h.level === 'FBS' && a.level === 'FCS') || (a.level === 'FBS' && h.level === 'FCS')) return 'mismatch';
  if (h.conf && h.conf === a.conf && !/independ/i.test(h.conf)) return 'conf';
  return 'other';
}

const clip = (p: number) => Math.min(0.995, Math.max(0.005, p));
export const logit = (p: number) => Math.log(clip(p) / (1 - clip(p)));
const sig = (x: number) => 1 / (1 + Math.exp(-x));
export const IDENTITY: Platt = { a: 1, b: 0, n: 0 };

/** Throws when a season after 2025 (or before 2021) would be in a calibration fit. */
export function assertCalibSeasons(seasons: number[]) {
  for (const s of seasons) if (s > CALIB_LAST || s < CALIB_FIRST) throw new Error(`calibration fit on ${s} is not allowed (fit seasons: ${CALIB_FIRST}–${CALIB_LAST})`);
}

/** Platt fit by Newton steps; `prior` + `lam` = ridge toward another fit (segments toward the league). */
export function fitPlatt(rows: { p: number; y: number }[], prior: Platt = IDENTITY, lam = 0): Platt {
  const xs = rows.map(r => logit(r.p)), ys = rows.map(r => r.y);
  if (!rows.length) return { ...prior, n: 0 };
  let a = prior.a, b = prior.b;
  for (let it = 0; it < 30; it++) {
    let ga = -lam * (a - prior.a), gb = -lam * (b - prior.b), haa = lam, hab = 0, hbb = lam;
    for (let i = 0; i < xs.length; i++) {
      const q = sig(a * xs[i] + b), e = ys[i] - q, w = Math.max(1e-9, q * (1 - q));
      ga += e * xs[i]; gb += e; haa += w * xs[i] * xs[i]; hab += w * xs[i]; hbb += w;
    }
    hbb += 1e-9;
    const det = haa * hbb - hab * hab;
    if (!(Math.abs(det) > 1e-12)) break;
    const da = (hbb * ga - hab * gb) / det, db = (haa * gb - hab * ga) / det;
    a += da; b += db;
    if (Math.abs(da) + Math.abs(db) < 1e-8) break;
  }
  if (!Number.isFinite(a) || !Number.isFinite(b)) return { ...prior, n: rows.length };
  return { a: Math.max(MIN_A, a), b, n: rows.length };
}

/** The layer on the fitting rows (seasons checked): league fit + segments shrunk toward it. */
export function fitCalib(rows: CalRow[], segments = true): Calib {
  const seasons = [...new Set(rows.map(r => r.season))].sort((x, y) => x - y);
  assertCalibSeasons(seasons);
  const global = rows.length >= 100 ? fitPlatt(rows) : { ...IDENTITY, n: rows.length };
  const segs: Partial<Record<Seg, Platt>> = {};
  if (segments) for (const s of ['mismatch', 'conf', 'other'] as Seg[]) {
    const sel = rows.filter(r => r.seg === s);
    if (sel.length >= 30) segs[s] = fitPlatt(sel, global, LAMBDA);
  }
  return { global, segs, seasons };
}

/** The calibrated home win chance (no layer = as it is). */
export function applyCalib(c: Calib | null | undefined, p: number, seg?: Seg | null): number {
  if (!c || !Number.isFinite(p)) return p;
  const f = (seg && c.segs[seg]) || c.global;
  return sig(f.a * logit(p) + f.b);
}

export interface Score { games: number; logLoss: number | null; brier: number | null; hit: number | null }
export function scoreRows(rows: { p: number; y: number }[]): Score {
  const n = rows.length;
  if (!n) return { games: 0, logLoss: null, brier: null, hit: null };
  let ll = 0, br = 0, hit = 0, hitN = 0;
  for (const r of rows) {
    const p = clip(r.p);
    ll += -(r.y * Math.log(p) + (1 - r.y) * Math.log(1 - p));
    br += (p - r.y) ** 2;
    if (r.y !== 0.5) { hitN++; if ((p >= 0.5 ? 1 : 0) === r.y) hit++; }
  }
  return { games: n, logLoss: Math.round((ll / n) * 10000) / 10000, brier: Math.round((br / n) * 10000) / 10000, hit: hitN ? Math.round((1000 * hit) / hitN) / 10 : null };
}

export const BAND_EDGES = [50, 60, 70, 80, 90] as const;
export interface Band { lo: number; hi: number; n: number; said: number | null; happened: number | null; gap: number | null }
/** Said vs happened per band of the picked side's chance (ties left out). */
export function pickBands(rows: { p: number; y: number }[]): Band[] {
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return BAND_EDGES.map((lo, i) => {
    const hi = BAND_EDGES[i + 1] ?? 101;
    let n = 0, said = 0, hits = 0;
    for (const r of rows) {
      if (r.y === 0.5) continue;
      const top = 100 * Math.max(r.p, 1 - r.p);
      if (top < lo || top >= hi) continue;
      n++; said += top; if ((r.p >= 0.5 ? 1 : 0) === r.y) hits++;
    }
    const s = n ? r1(said / n) : null, h = n ? r1((100 * hits) / n) : null;
    return { lo, hi: Math.min(hi, 100), n, said: s, happened: h, gap: s !== null && h !== null ? r1(s - h) : null };
  });
}

/**
 * Walk-forward test of the layer: every season in `tests` calibrated with a fit on the seasons before it only
 * (from 2021, never past 2025). Rows of a test season after 2025 use the fit on every season 2021–2025.
 */
export function walkForwardCalib(rows: CalRow[], tests: number[], segments = true) {
  const out: { season: number; raw: Score; cal: Score; rawBands: Band[]; calBands: Band[]; fitOn: number[] }[] = [];
  const allCal: CalRow[] = [], allRaw: CalRow[] = [];
  for (const S of tests) {
    const train = rows.filter(r => r.season >= CALIB_FIRST && r.season < S && r.season <= CALIB_LAST);
    const c = train.length >= 100 ? fitCalib(train, segments) : null;
    const test = rows.filter(r => r.season === S);
    const cal = test.map(r => ({ ...r, p: applyCalib(c, r.p, r.seg) }));
    allCal.push(...cal); allRaw.push(...test);
    out.push({ season: S, raw: scoreRows(test), cal: scoreRows(cal), rawBands: pickBands(test), calBands: pickBands(cal), fitOn: c ? c.seasons : [] });
  }
  return { seasons: out, total: { raw: scoreRows(allRaw), cal: scoreRows(allCal), rawBands: pickBands(allRaw), calBands: pickBands(allCal) }, rows: allCal };
}

/** The lowest chance (60%–90%, 1-point steps) from which the picks were right ≥ target with ≥ minN games; null = none. */
export function strongLine(rows: { p: number; y: number }[], target = 0.75, minN = 50): number | null {
  const picks = rows.filter(r => r.y !== 0.5).map(r => ({ top: Math.max(r.p, 1 - r.p), hit: (r.p >= 0.5 ? 1 : 0) === r.y }));
  for (let t = 60; t <= 90; t++) {
    const sel = picks.filter(x => x.top * 100 >= t);
    if (sel.length < minN) return null;
    if (sel.filter(x => x.hit).length / sel.length >= target) return t / 100;
  }
  return null;
}

/** The data-health verdict on a record's "picks by how sure we were" rows ({ n, said, hitRate } per band). */
export function calibCheck(rows: { n: number; said: number | null; hitRate: number | null; label?: string; id?: string }[], minTotal = 100, minBand = 50, maxGap = 5) {
  const total = rows.reduce((s, r) => s + (r.n || 0), 0);
  const bands = rows.filter(r => r.n >= minBand && r.said !== null && r.hitRate !== null).map(r => ({ ...r, gap: Math.round((r.said! - r.hitRate!) * 10) / 10 }));
  const worst = [...bands].sort((x, y) => Math.abs(y.gap) - Math.abs(x.gap))[0] || null;
  const fail = total >= minTotal && !!worst && Math.abs(worst.gap) > maxGap;
  return { total, fail, enough: total >= minTotal, worst, bands };
}
