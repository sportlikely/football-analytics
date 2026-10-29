/**
 * European club Elo ("elo-euro") — predictions for Champions League, Europa League and Conference League.
 *
 * Ratings: domestic results of our 12 API-Football leagues (af_fixtures, 3 seasons) + UEFA cup results
 * (4 seasons) in one timeline. Cup matches connect the leagues. Each club starts from its squad value
 * (so clubs from leagues we do not track, e.g. Ukraine or Denmark, start sensibly), then moves with results.
 * Percentages: ordered logistic on (Elo gap + home advantage + β·ln(squad value ratio)), fitted on cup matches.
 */
import { db } from '../db';
import logger from '../utils/logger';
import { afGet, afConfigured } from './apiFootball';
import { similarity, normalizeName } from './history';
import { Meetings, commonSense, type H2H } from './h2hGuard';
import { Prediction } from './predictionModel';
import { every, after, runSteps, runStepsAsync } from './perf';
import { onState, publishState } from './shared';
import { keepSign } from '../utils/whyFactors';

export const MODEL_EURO = 'elo-euro';
const AF_OFFSET = 1_000_000_000;
export const CUPS: Record<number, string> = { 2: 'Champions League', 3: 'Europa League', 848: 'Conference League' };
const K_DOMESTIC = 18, K_CUP = 32, HA = 60;
/**
 * Clubs with no Transfermarkt value (Oct 2026) are the small ones — Azerbaijani, Armenian, Faroese champions and the
 * like, never a top-league side. They count as a €12m squad instead of "unknown = equal", so a club like Sabah is not
 * made the favourite over Slavia Praha (€94m) because of a few qualifying wins against smaller clubs still.
 */
const MISSING_VALUE = 12e6;
const valueOr = (v: number | null) => v ?? MISSING_VALUE;

db.exec(`
  CREATE TABLE IF NOT EXISTS eur_matches (
    fixture_id INTEGER PRIMARY KEY, league_id INTEGER NOT NULL, season INTEGER NOT NULL, date TEXT NOT NULL,
    home_id INTEGER NOT NULL, away_id INTEGER NOT NULL, home_name TEXT, away_name TEXT, hg INTEGER, ag INTEGER
  );
  CREATE TABLE IF NOT EXISTS eur_sync (key TEXT PRIMARY KEY, done_at TEXT NOT NULL, n INTEGER);
`);

/* ---------- data ---------- */

export async function syncEuropeanCups(force = false) {
  if (!afConfigured()) return { requests: 0, matches: 0 };
  const now = new Date();
  const cur = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  let requests = 0, matches = 0;
  const ins = db.prepare(`INSERT OR REPLACE INTO eur_matches (fixture_id, league_id, season, date, home_id, away_id, home_name, away_name, hg, ag) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const id of Object.keys(CUPS).map(Number))
    for (let s = cur - 3; s <= cur; s++) {
      const key = `${id}|${s}`;
      const row: any = db.prepare(`SELECT done_at FROM eur_sync WHERE key = ?`).get(key);
      if (!force && row && (s < cur || Date.now() - new Date(row.done_at).getTime() < 12 * 3600 * 1000)) continue;
      try {
        const j = await afGet('/fixtures', { league: id, season: s });
        requests++;
        let n = 0;
        db.exec('BEGIN');
        for (const f of j.response || []) {
          if (!['FT', 'AET', 'PEN'].includes(f.fixture?.status?.short)) continue;
          const hg = f.goals?.home ?? f.score?.fulltime?.home;
          const ag = f.goals?.away ?? f.score?.fulltime?.away;
          if (hg === null || hg === undefined || ag === null || ag === undefined) continue;
          ins.run(f.fixture.id, id, s, String(f.fixture.date).slice(0, 10), f.teams.home.id, f.teams.away.id, f.teams.home.name, f.teams.away.name, hg, ag);
          n++;
        }
        db.exec('COMMIT');
        db.prepare(`INSERT OR REPLACE INTO eur_sync (key, done_at, n) VALUES (?, ?, ?)`).run(key, new Date().toISOString(), n);
        matches += n;
      } catch (e: any) {
        try { db.exec('ROLLBACK'); } catch { /* not in a transaction */ }
        logger.warn(`European cups ${key}: ${e.message}`);
      }
    }
  return { requests, matches };
}

/* ---------- club squad values (top 15 by current club, from the Transfermarkt player dump) ---------- */

let clubValues: { name: string; tokens: string[]; value: number }[] = [];
// fix202: built in the worker; the web process takes the finished ratings and settings (UEFA cup predictions)
onState('elo-euro', (_k, v) => {
  ratings.clear(); for (const [id, r] of v.ratings) ratings.set(id, r);
  byNorm.clear(); for (const [n, id] of v.byNorm) byNorm.set(n, id);
  meetings.load(v.meetings);
  fdCache.clear(); valueByName.clear(); tokenIndex = null;
  h2hUsed = v.h2hUsed; guardOpt = v.guardOpt; fit = v.fit; cupW = v.cupW; engine = v.engine; evalStats = v.evalStats; lastBuilt = v.lastBuilt; clubValues = v.clubValues;
  popStats = null;
});
function loadClubValues() {
  const rows = db.prepare(`SELECT club, value_eur FROM squad_players WHERE club IS NOT NULL`).all() as any[];
  const byClub = new Map<string, number[]>();
  for (const r of rows) (byClub.get(r.club) || byClub.set(r.club, []).get(r.club)!).push(r.value_eur);
  clubValues = [...byClub.entries()]
    .filter(([, v]) => v.length >= 11)
    .map(([name, v]) => ({ name, tokens: clubTokens(name), value: v.sort((a, b) => b - a).slice(0, 15).reduce((a, b) => a + b, 0) }))
    .filter(c => c.tokens.length > 0);
}

/*
 * Club-name matching, API-Football name → Transfermarkt club. Transfermarkt often uses full legal names
 * ("Associazione Sportiva Roma", "Football Club Internazionale Milano S.p.A.", "FK Bodø/Glimt"), so both
 * sides are reduced to their meaningful words, words may match by prefix (inter ~ internazionale), and ties
 * go to the more valuable club (European-cup clubs are usually the big ones).
 */
const CLUB_STOP = new Set([
  'fc', 'cf', 'afc', 'sc', 'ac', 'as', 'ss', 'ssc', 'us', 'ud', 'cd', 'sd', 'rcd', 'rc', 'ca', 'bc', 'sv', 'tsg', 'vfb', 'vfl', 'fsv', 'bsc',
  'sad', 'ev', 'fk', 'sk', 'nk', 'hnk', 'gnk', 'bk', 'if', 'ik', 'kv', 'krc', 'rsc', 'kf', 'pfc', 'ofk', 'sa', 'spa', 'ag', 'gmbh', 'plc',
  'club', 'clube', 'calcio', 'futebol', 'football', 'futbol', 'fussball', 'fotbal', 'fotball', 'fodbold', 'voetbal', 'associazione',
  'sportiva', 'sportivo', 'sportif', 'sport', 'sporting', 'de', 'del', 'di', 'da', 'do', 'of', 'the', 'and', 'y', 'e', 'la', 'le', 'il',
  'societa', 'company', 'limited', 'ltd', 'spor', 'kulubu', 'ff', 'gf', 'il', 'aif', 'ifk', 'ksv', 'kaa', 'ogc', 'losc', 'acf', 'sl', 'jk', 'ks',
  'fotballklubb', 'fotballklub', 'idrettslag', 'sportsklubb', 'sportklub', 'idrottsforening', 'ballklub', 'fussballclub', 'athlitikos', 'omilos',
  'spolka', 'akcyjna'
]);
// Written differently on the two sides (after normalising)
const CLUB_ALIASES: Record<string, string> = {
  inter: 'internazionale',
  'inter milan': 'internazionale',
  'bayern munich': 'bayern munchen',
  'crvena zvezda': 'crvena zvezda',
  'red star belgrade': 'crvena zvezda',
  'fc copenhagen': 'kobenhavn',
  copenhagen: 'kobenhavn',
  'slavia praha': 'slavia prag',
  'sparta praha': 'sparta prag',
  'sporting cp': 'sporting clube portugal',
  'sporting lisbon': 'sporting clube portugal',
  // Same name as a different, richer club in the data: no squad value rather than a wrong one
  'cska 1948': '-',
  velez: '-',
  partizani: '-',
  'radnicki 1923': '-', // Kragujevac, not Radnički Niš
  bohemians: '-',
  'olympiakos piraeus': 'olympiakos',
  paok: 'panthessalonikios',
  'aek athens': 'athlitiki enosi',
  'aek athens fc': 'athlitiki enosi',
  rennes: 'rennais',
  'stade rennais': 'rennais',
  'psv eindhoven': 'eindhoven',
  psv: 'eindhoven',
  'rb leipzig': 'leipzig',
  olympiacos: 'olympiakos',
  'dinamo zagreb': 'dinamo zagreb',
  'ferencvarosi tc': 'ferencvaros',
  'salzburg': 'red bull salzburg',
  'red bull salzburg': 'red bull salzburg',
  'young boys': 'young boys',
  'bsc young boys': 'young boys',
  'qarabag': 'qarabag',
  'atletico madrid': 'atletico madrid',
  'athletic club': 'athletic bilbao',
  'ac milan': 'milan',
  'as roma': 'roma',
  'ss lazio': 'lazio',
  'ssc napoli': 'napoli'
};

function clubNorm(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replace(/ø/g, 'o').replace(/æ/g, 'ae').replace(/œ/g, 'oe').replace(/ß/g, 'ss').replace(/ł/g, 'l').replace(/đ/g, 'd').replace(/ı/g, 'i').replace(/þ/g, 'th')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function clubTokens(s: string): string[] {
  const n = clubNorm(s);
  const aliased = CLUB_ALIASES[n] || n;
  const words = aliased.split(' ').map(w => (w === 'utd' ? 'united' : w === 'st' ? 'saint' : w));
  const t = words.filter(w => w && !CLUB_STOP.has(w) && !/^\d+$/.test(w) && w.length > 1);
  // keep something for names made only of stop words ("Sporting", "Club")
  return t.length ? t : words.filter(w => w && !/^\d+$/.test(w));
}
// Same word, or one is a clear abbreviation of the other (prag ~ praha, eindhoven ~ eindhovense)
const tokEq = (a: string, b: string) => {
  if (a === b) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  return s.length >= 4 && s.length / l.length >= 0.6 && l.startsWith(s);
};

function matchScore(a: string[], b: string[]): number {
  const ca = a.filter(x => b.some(y => tokEq(x, y))).length;
  const cb = b.filter(y => a.some(x => tokEq(x, y))).length;
  // Every word of the API-Football name must be found ("Arsenal Tivat" is not "Arsenal", "Inter Turku" is not "Inter")
  if (ca < a.length) return 0;
  const exact = a.filter(x => b.includes(x)).length / Math.max(a.length, b.length);
  return (ca / a.length + cb / b.length) / 2 + 0.1 * exact;
}

const valueByName = new Map<string, { value: number; club: string; score: number } | null>();
export function clubValueMatch(name: string): { value: number; club: string; score: number } | null {
  if (valueByName.has(name)) return valueByName.get(name)!;
  const a = clubTokens(name);
  let best: { value: number; club: string; score: number } | null = null;
  if (a.length) {
    for (const c of clubValues) {
      const s = matchScore(a, c.tokens);
      if (s < 0.6) continue;
      if (!best || s > best.score + 0.02 || (Math.abs(s - best.score) <= 0.02 && c.value > best.value)) best = { value: c.value, club: c.name, score: Math.round(s * 100) / 100 };
    }
  }
  valueByName.set(name, best);
  return best;
}
function clubValueFor(name: string): number | null {
  return clubValueMatch(name)?.value ?? null;
}

/** Admin check: which Transfermarkt club each European-cup club was matched to. */
export function clubValueReport(q?: string) {
  const rows = [...ratings.values()]
    .filter(r => r.cup >= 1)
    .sort((a, b) => b.elo - a.elo)
    .map(r => {
      const m = clubValueMatch(r.name);
      return { club: r.name, elo: Math.round(r.elo), cup: r.cup, matched: m?.club || null, valueM: m ? Math.round(m.value / 1e6) : null, score: m?.score ?? null };
    });
  const needle = q ? clubNorm(q) : '';
  const search = needle
    ? clubValues.filter(c => clubNorm(c.name).includes(needle)).slice(0, 30).map(c => ({ name: c.name, valueM: Math.round(c.value / 1e6), tokens: c.tokens }))
    : undefined;
  return {
    clubs: rows.length,
    matched: rows.filter(r => r.matched).length,
    unmatched: rows.filter(r => !r.matched).map(r => `${r.club} (${r.cup})`),
    rows,
    search
  };
}

/* ---------- ratings ---------- */

type ClubState = { id: number; elo: number; name: string; n: number; cup: number; att: number; def: number; recent: number[]; last: string };
// head-to-head over domestic + cup games (Oct 2026), and the common-sense check (see h2hGuard.ts)
const meetings = new Meetings();
let h2hUsed = true;
let guardOpt = { on: false, formT: 0.3, h2hT: 0.2, margin: 0.02 };
const ratings = new Map<number, ClubState>(); // key = API-Football team id
const byNorm = new Map<string, number>(); // normalised name → team id (for Football-Data.org Champions League matches)
const fdCache = new Map<number, number | null>(); // Football-Data.org team id → API-Football team id
let fit = { c: 60, s: 110, beta: 0 };
let evalStats: any = null;
let lastBuilt: string | null = null;

const sig = (x: number) => 1 / (1 + Math.exp(-x));
function probs(d: number, c = fit.c, s = fit.s) {
  const h = sig((d - c) / s), a = sig((-d - c) / s);
  const dr = Math.max(0.03, 1 - h - a);
  const t = h + a + dr;
  return { h: h / t, d: dr / t, a: a / t };
}
const gdMult = (gd: number) => { const g = Math.abs(gd); return g <= 1 ? 1 : g === 2 ? 1.5 : (11 + g) / 8; };

/* ---------- v3 European-cup grid (same idea as the national-team engine) ---------- */
/*
 * Rows (home − away, all known before kick-off; ratings run over domestic + cup games in one timeline):
 *   strength (Elo gap), squad value (ln ratio, Transfermarkt top 15), goals (online Poisson attack/defence),
 *   form (last 6 vs Elo expectation), rest days (cup games come 3–4 days after league games), home advantage.
 * Ordered logit; draw threshold per competition (CL / EL / ECL) + g × (Poisson draw − 0.27).
 * Fitted on the older 60 % of cup matches starting from the Elo-only fit, judged on the newest 40 %;
 * the live engine is whichever scores better there.
 */
interface CFeat { dElo: number; lv: number; gl: number; form: number; rest: number; pDraw: number; cup: number; lamH: number; lamA: number; h2h: number; h2hInfo: H2H | null }
const CW = ['w_elo', 'w_squad', 'w_goals', 'w_form', 'w_rest', 'w_home', 'c_cl', 'c_el', 'c_ecl', 'g_draw', 'w_h2h'] as const;
type CupW = Record<(typeof CW)[number], number>;
let cupW: CupW = { w_elo: 0.5, w_squad: 0, w_goals: 0, w_form: 0, w_rest: 0, w_home: 0.3, c_cl: 0.5, c_el: 0.5, c_ecl: 0.5, g_draw: 0, w_h2h: 0 };
let engine: 'grid' | 'elo' = 'elo';
const MU = Math.log(1.35), HOME_G = 0.2;
function poissonDraw(lh: number, la: number) {
  let d = 0, ph = Math.exp(-lh), pa = Math.exp(-la);
  for (let k = 0; k <= 10; k++) { d += ph * pa; ph *= lh / (k + 1); pa *= la / (k + 1); }
  return d;
}
const lambdas = (H: ClubState, A: ClubState, home = true) => ({ lamH: Math.exp(MU + H.att - A.def + (home ? HOME_G : 0)), lamA: Math.exp(MU + A.att - H.def) });
function cfeat(H: ClubState, A: ClubState, cup: number, date: string, vh: number | null, va: number | null): CFeat {
  const { lamH, lamA } = lambdas(H, A);
  const nh = lambdas(H, A, false);
  const days = (x: string) => (x ? Math.min(10, (new Date(date).getTime() - new Date(x).getTime()) / 86400000) : 10);
  const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const h = meetings.get(H.id, A.id, date);
  return { dElo: (H.elo - A.elo) / 100, lv: Math.log(valueOr(vh) / valueOr(va)), gl: Math.log(nh.lamH / nh.lamA), form: avg(H.recent) - avg(A.recent), rest: (days(H.last) - days(A.last)) / 10, pDraw: poissonDraw(lamH, lamA), cup, lamH, lamA, h2h: h ? h.x : 0, h2hInfo: h };
}
function cupProbs(f: CFeat, w: CupW = cupW) {
  const z = w.w_elo * f.dElo + w.w_squad * f.lv + w.w_goals * f.gl + w.w_form * f.form + w.w_rest * f.rest + w.w_home + (w.w_h2h || 0) * f.h2h;
  const c = Math.max(0.05, (f.cup === 2 ? w.c_cl : f.cup === 3 ? w.c_el : w.c_ecl) + w.g_draw * (f.pDraw - 0.27));
  const h = sig(z - c), a = sig(-z - c);
  const dr = Math.max(0.03, 1 - h - a);
  const t = h + a + dr;
  return { h: h / t, d: dr / t, a: a / t, z };
}
function cupNll(xs: { f: CFeat; o: 'H' | 'D' | 'A' }[], w: CupW) {
  let ll = 0;
  for (const x of xs) { const p = cupProbs(x.f, w); ll -= Math.log(Math.max(1e-6, x.o === 'H' ? p.h : x.o === 'D' ? p.d : p.a)); }
  return ll / Math.max(1, xs.length);
}
/** The factors' verdict without home advantage (> 0 favours the home side). */
const factorsOf = (f: CFeat, w: CupW) => w.w_elo * f.dElo + w.w_squad * f.lv + w.w_goals * f.gl + w.w_form * f.form + w.w_rest * f.rest + (w.w_h2h || 0) * f.h2h;
/** fix167: the fit as steps (a yield after each weight tried), so the scheduled rebuild gives the thread back. */
function* fitCup(xs: { f: CFeat; o: 'H' | 'D' | 'A' }[], start: CupW, fixed: string[] = []): Generator<unknown, CupW> {
  const w: any = Object.fromEntries(Object.entries(start).map(([k, v]) => [k, keepSign(k, v as number)]));
  let best = cupNll(xs, w), step = 0.2;
  for (let pass = 0; pass < 80 && step > 0.002; pass++) {
    let improved = false;
    for (const k of CW) for (const dir of [1, -1]) {
      if (fixed.includes(k)) continue;
      const old = w[k];
      w[k] = keepSign(k, old + dir * step); // fix282: a "more is better" factor never gets a negative weight
      if (k.startsWith('c_')) w[k] = Math.max(0.05, w[k]);
      if (w[k] === old) continue;
      const v = cupNll(xs, w);
      yield;
      if (v < best - 1e-7) { best = v; improved = true; break; }
      w[k] = old;
    }
    if (!improved) step /= 2;
  }
  return w;
}
const cupFromElo = (e: { c: number; s: number; beta: number }): CupW => ({
  w_elo: 100 / e.s, w_squad: e.beta / e.s, w_goals: 0, w_form: 0, w_rest: 0, w_home: HA / e.s, c_cl: e.c / e.s, c_el: e.c / e.s, c_ecl: e.c / e.s, g_draw: 0, w_h2h: 0
});

/** The whole build at once (admin rebuild). */
export const buildClubElo = () => runSteps(buildSteps());
/**
 * fix167: the scheduled rebuild in slices of 40 ms (2–3 s in one block on a copy of the database: the parameter fits).
 * The ratings are rebuilt in one go as before; the fitted settings are swapped in together at the end.
 */
let building: Promise<unknown> | null = null;
export function buildClubEloAsync() {
  if (!building) building = runStepsAsync(buildSteps()).finally(() => { building = null; });
  return building;
}
function* buildSteps(): Generator<unknown, { matches: number; cupMatches: number; clubs: number; engine: 'grid' | 'elo' }> {
  loadClubValues();
  valueByName.clear();
  const domestic = db.prepare(`
    SELECT fixture_id, date, home_id, away_id, home_name, away_name, hg, ag, 0 AS cup FROM af_fixtures
    WHERE status IN ('FT','AET','PEN') AND hg IS NOT NULL`).all() as any[];
  const cups = db.prepare(`SELECT fixture_id, date, home_id, away_id, home_name, away_name, hg, ag, league_id AS cup FROM eur_matches`).all() as any[];
  const all = [...domestic, ...cups].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.fixture_id - b.fixture_id));
  ratings.clear();
  meetings.clear();
  byNorm.clear();
  fdCache.clear();
  tokenIndex = null;
  const median = 150e6;
  const get = (id: number, name: string) => {
    let r = ratings.get(id);
    if (!r) {
      const v = clubValueFor(name);
      r = { id, elo: 1500 + 120 * Math.log(valueOr(v) / median), name, n: 0, cup: 0, att: 0, def: 0, recent: [], last: '' };
      ratings.set(id, r);
      byNorm.set(normalizeName(name), id);
    }
    return r;
  };
  const pre: { d: number; lv: number; o: 'H' | 'D' | 'A'; date: string; f: CFeat }[] = [];
  for (const m of all) {
    const H = get(m.home_id, m.home_name), A = get(m.away_id, m.away_name);
    const d = H.elo - A.elo + HA;
    const o = m.hg > m.ag ? 'H' : m.hg < m.ag ? 'A' : 'D';
    if (m.cup && H.n >= 8 && A.n >= 8) {
      const vh = clubValueFor(H.name), va = clubValueFor(A.name);
      pre.push({ d, lv: Math.log(valueOr(vh) / valueOr(va)), o, date: m.date, f: cfeat(H, A, m.cup, m.date, vh, va) });
    }
    const we = 1 / (1 + Math.pow(10, -d / 400));
    const w = o === 'H' ? 1 : o === 'D' ? 0.5 : 0;
    const delta = (m.cup ? K_CUP : K_DOMESTIC) * gdMult(m.hg - m.ag) * (w - we);
    H.elo += delta; A.elo -= delta;
    H.recent.push(w - we); A.recent.push(we - w);
    if (H.recent.length > 6) H.recent.shift();
    if (A.recent.length > 6) A.recent.shift();
    const { lamH, lamA } = lambdas(H, A);
    const eta = 0.035;
    const eh = Math.max(-3, Math.min(3, m.hg - lamH)), ea = Math.max(-3, Math.min(3, m.ag - lamA));
    H.att += eta * eh; A.def -= eta * eh;
    A.att += eta * ea; H.def -= eta * ea;
    H.n++; A.n++; H.last = m.date; A.last = m.date;
    if (m.cup) { H.cup++; A.cup++; }
    meetings.add(m.home_id, m.away_id, m.date, w);
  }
  // fit on cup matches; evaluate on the most recent 40 % of them
  const cut = Math.floor(pre.length * 0.6);
  const train = pre.slice(0, cut), test = pre.slice(cut);
  const llOf = (xs: typeof pre, c: number, s: number, b: number) => {
    let ll = 0;
    for (const x of xs) { const p = probs(x.d + b * x.lv, c, s); ll -= Math.log(Math.max(1e-6, x.o === 'H' ? p.h : x.o === 'D' ? p.d : p.a)); }
    return ll;
  };
  function* grid(xs: typeof pre, betas: number[]) {
    let best = { ll: Infinity, c: 60, s: 110, beta: 0 };
    for (const b of betas) for (let c = 0; c <= 300; c += 10) {
      for (let s = 60; s <= 400; s += 10) {
        const ll = llOf(xs, c, s, b);
        if (ll < best.ll) best = { ll, c, s, beta: b };
      }
      yield; // fix167: a safe point every 35 settings
    }
    return best;
  }
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const score = (pf: (x: (typeof pre)[number]) => { h: number; d: number; a: number }) => {
    let brier = 0, ll = 0, hits = 0, pd = 0, rd = 0;
    for (const x of test) {
      const p = pf(x);
      brier += (p.h - (x.o === 'H' ? 1 : 0)) ** 2 + (p.d - (x.o === 'D' ? 1 : 0)) ** 2 + (p.a - (x.o === 'A' ? 1 : 0)) ** 2;
      ll -= Math.log(Math.max(1e-6, x.o === 'H' ? p.h : x.o === 'D' ? p.d : p.a));
      const pick = p.h >= p.d && p.h >= p.a ? 'H' : p.a >= p.d ? 'A' : 'D';
      if (pick === x.o) hits++;
      pd += p.d;
      if (x.o === 'D') rd++;
    }
    const n = Math.max(1, test.length);
    return test.length ? { brier: r3(brier / n), logLoss: r3(ll / n), hitRate: Math.round((hits / n) * 1000) / 10, predDraw: Math.round((pd / n) * 1000) / 10, realDraw: Math.round((rd / n) * 1000) / 10 } : null;
  };
  const BETAS = [0, 25, 50, 75, 100, 125, 150, 200, 250];
  if (train.length >= 100) {
    // fix167: the new settings are kept in locals and swapped in together (the steps may be spread over turns)
    const base = yield* grid(train, [0]);
    const withV = yield* grid(train, BETAS);
    // head-to-head row: fitted with and without, kept only if it does not make the test worse
    const cupNoH2H = yield* fitCup(train, cupFromElo(withV), ['w_h2h']);
    const cupWithH2H = yield* fitCup(train, cupFromElo(withV));
    const tNo = score(x => cupProbs(x.f, cupNoH2H)), tWith = score(x => cupProbs(x.f, cupWithH2H));
    const useH2H = !!(tNo && tWith && tWith.logLoss <= tNo.logLoss + 0.0005 && (cupWithH2H.w_h2h || 0) > 0); // a negative H2H weight is noise, not a pattern
    const cupTrain = useH2H ? cupWithH2H : cupNoH2H;
    const eloTest = score(x => probs(x.d + withV.beta * x.lv, withV.c, withV.s));
    const gridTest = score(x => cupProbs(x.f, cupTrain));
    yield;
    const eng: 'grid' | 'elo' = test.length >= 300 && gridTest && eloTest && gridTest.logLoss < eloTest.logLoss ? 'grid' : 'elo';
    // live parameters from every cup match
    const allV = yield* grid(pre, BETAS);
    const newCupW = eng === 'grid' ? yield* fitCup(pre, cupFromElo(allV), useH2H ? [] : ['w_h2h']) : cupTrain;
    // swapped in together; from here to the end the build runs in one go
    h2hUsed = useH2H; engine = eng; fit = { c: allV.c, s: allV.s, beta: allV.beta }; cupW = newCupW;
    // common-sense check: on when it does not make the test clearly worse
    const baseP = (x: (typeof pre)[number]) => (engine === 'grid' ? cupProbs(x.f, cupTrain) : probs(x.d + withV.beta * x.lv, withV.c, withV.s));
    const facOf = (x: (typeof pre)[number]) => (engine === 'grid' ? factorsOf(x.f, cupTrain) : x.d - HA);
    const guardTest = score(x => commonSense(baseP(x), facOf(x), x.f.form, x.f.h2hInfo, { ...guardOpt, on: true }));
    const plainTest = engine === 'grid' ? gridTest : eloTest;
    guardOpt = { ...guardOpt, on: !!(guardTest && plainTest && guardTest.logLoss <= plainTest.logLoss + 0.003) };
    const h2hGuard = { h2h: { used: h2hUsed, withoutH2H: tNo, withH2H: tWith, weight: Math.round((cupWithH2H.w_h2h || 0) * 1000) / 1000 }, guard: { on: guardOpt.on, without: plainTest, with: guardTest } };
    const rw = (w: CupW) => Object.fromEntries(Object.entries(w).map(([k, v]) => [k, Math.round(v * 1000) / 1000]));
    evalStats = {
      cupMatchesFit: train.length, cupMatchesTest: test.length,
      eloOnly: score(x => probs(x.d, base.c, base.s)), eloPlusSquadValue: eloTest, grid: gridTest, engine, gridWeightsTest: rw(cupTrain),
      note: 'fitted on the older 60% of UEFA cup matches, scored on the newest 40% (out-of-sample)',
      h2hGuard
    };
  }
  lastBuilt = new Date().toISOString();
  publishState('elo-euro', { ratings, byNorm, meetings: meetings.dump(), h2hUsed, guardOpt, fit, cupW, engine, evalStats, lastBuilt, clubValues });
  logger.info(`Club Elo: ${all.length} matches (${cups.length} UEFA cup), ${ratings.size} clubs, engine ${engine}`);
  return { matches: all.length, cupMatches: cups.length, clubs: ratings.size, engine };
}

/* ---------- prediction ---------- */

// Football-Data.org spellings that share no word with API-Football's (after the club-word cleanup)
const FD_ALIASES: Record<string, string> = {
  'pae aek': 'aek athens', 'aek': 'aek athens', 'shaktar': 'shakhtar donetsk', 'atleti': 'atletico madrid', 'man united': 'manchester united',
  'man city': 'manchester city', 'barca': 'barcelona', 'inter': 'inter', 'wolves': 'wolverhampton', 'spurs': 'tottenham', 'psg': 'paris saint germain',
  'sl bratislava': 'slovan bratislava', 'sabah fk': 'sabah', 'sabah fa': 'sabah', 'bodo glimt': 'bodo glimt', 'kobenhavn': 'fc copenhagen', 'fc kobenhavn': 'fc copenhagen'
};
const fdTokens = (s: string) => clubTokens(FD_ALIASES[clubNorm(s)] || s);
let tokenIndex: { id: number; toks: string[]; n: number }[] | null = null;
function teamIndex() {
  if (!tokenIndex) tokenIndex = [...ratings.values()].map(r => ({ id: r.id, toks: clubTokens(r.name), n: r.n }));
  return tokenIndex;
}
/**
 * API-Football team for a Football-Data.org team (Champions League comes from Football-Data.org): exact name, then the
 * club words ("FC Bayern München" = "Bayern München", "PSV" ⊂ "PSV Eindhoven", "ŠK Slovan Bratislava" = "Slovan
 * Bratislava"), then the old fuzzy match. A word match must be unique; ties go to the club with the most games.
 */
/** fix164: the same club matching for team pages (an FD team linked from a cup page); null while the ratings are not built. */
export function afIdForFdTeam(t: { name?: string; shortName?: string; tla?: string }): number | null {
  if (!ratings.size) return null;
  return matchFdTeam(t);
}
function matchFdTeam(t: { name?: string; shortName?: string; tla?: string }): number | null {
  const names = [t.name, t.shortName].filter((x): x is string => !!x);
  for (const n of names) { const id = byNorm.get(normalizeName(n)); if (id) return id; }
  const idx = teamIndex();
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => tokEq(x, b[i]));
  const subset = (small: string[], big: string[]) => small.length > 0 && small.length < big.length && small.every(x => big.some(y => tokEq(x, y))) && small.some(x => x.length >= 4);
  for (const n of names) {
    const toks = fdTokens(n);
    if (!toks.length) continue;
    const exact = idx.filter(c => same(toks, c.toks));
    if (exact.length) return exact.sort((a, b) => b.n - a.n)[0].id;
  }
  for (const n of names) {
    const toks = fdTokens(n);
    const part = idx.filter(c => subset(toks, c.toks) || subset(c.toks, toks));
    if (part.length === 1) return part[0].id;
    if (part.length > 1) { const top = part.sort((a, b) => b.n - a.n); if (top[0].n >= 3 * Math.max(1, top[1].n)) return top[0].id; }
  }
  let best: { id: number; s: number; n: number } | null = null;
  for (const [norm, id] of byNorm) {
    const s = Math.max(similarity(norm, t.name || ''), t.shortName ? similarity(norm, t.shortName) : 0);
    const n = ratings.get(id)?.n || 0;
    if (s >= 0.6 && (!best || s > best.s || (s === best.s && n > best.n))) best = { id, s, n };
  }
  return best ? best.id : null;
}

function findTeam(match: any, side: 'homeTeam' | 'awayTeam') {
  const t = match[side];
  if (!t) return null;
  if (t.id >= AF_OFFSET) { const r = ratings.get(t.id - AF_OFFSET); if (r) return r; }
  // Football-Data.org Champions League: match by name (cached per team id)
  if (fdCache.has(t.id)) { const id = fdCache.get(t.id); return id ? ratings.get(id) || null : null; }
  const found = matchFdTeam(t);
  fdCache.set(t.id, found);
  return found ? ratings.get(found) || null : null;
}
/** fix182: why a cup match has no elo-euro number (data health): the side without a rating or with too few games. */
export function eloEuroMiss(match: any): string {
  if (!ratings.size) return 'club Elo not built yet';
  const out: string[] = [];
  for (const side of ['homeTeam', 'awayTeam'] as const) {
    const r = findTeam(match, side);
    if (!r) out.push(`${match[side]?.name || '?'}: no club Elo rating (not matched)`);
    else if (r.n < 2) out.push(`${match[side]?.name}: only ${r.n} rated game`);
  }
  if (out.length) return out.join('; ');
  try { predictClubEuro(match); } catch (e: any) { return `elo-euro failed: ${e.message}`; }
  return 'elo-euro gave no number';
}

/** Admin check: how every Football-Data.org team of the given matches maps to a rated club. */
export function fdTeamMapping(matches: any[]) {
  const out: { fd: string; af: string | null; games: number; cup: number }[] = [];
  const seen = new Set<number>();
  for (const m of matches) for (const side of ['homeTeam', 'awayTeam'] as const) {
    const t = m[side];
    if (!t || seen.has(t.id)) continue;
    seen.add(t.id);
    const r = findTeam(m, side);
    out.push({ fd: `${t.name} (${t.shortName || ''})`, af: r ? r.name : null, games: r?.n || 0, cup: r?.cup || 0 });
  }
  return out;
}

function poisson(l: number, k: number) { let p = Math.exp(-l); for (let i = 1; i <= k; i++) p *= l / i; return p; }

const CUP_OF_CODE: Record<string, number> = { CL: 2, AF2: 2, AF3: 3, AF848: 848 };
let popStats: { at: number; s: Record<string, { mean: number; sd: number }> } | null = null;
function population() {
  if (popStats && Date.now() - popStats.at < 3600_000) return popStats.s;
  const act = [...ratings.values()].filter(r => r.cup >= 6);
  const ms = (xs: number[]) => {
    const mean = xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    return { mean, sd: Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, xs.length - 1)) || 1 };
  };
  const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const vals = act.map(r => clubValueFor(r.name)).filter((v): v is number => !!v).map(v => Math.log(v));
  const s = { elo: ms(act.map(r => r.elo)), squad: ms(vals), goals: ms(act.map(r => r.att + r.def)), form: ms(act.map(r => avg(r.recent))) };
  popStats = { at: Date.now(), s };
  return s;
}
const scale = (x: number, m: { mean: number; sd: number }) => Math.round(Math.max(1, Math.min(10, 5.5 + 2.25 * ((x - m.mean) / m.sd))) * 10) / 10;

export function predictClubEuro(match: any): Prediction | null {
  const H = findTeam(match, 'homeTeam'), A = findTeam(match, 'awayTeam');
  if (!H || !A || H.n < 2 || A.n < 2) return null; // a club with a handful of games still gets a (low-confidence) number instead of the old v1 model
  const vh = clubValueFor(H.name), va = clubValueFor(A.name);
  const valueTerm = fit.beta * Math.log(valueOr(vh) / valueOr(va));
  const d = H.elo - A.elo + HA + valueTerm;
  const cup = CUP_OF_CODE[match.competition?.code] || 3;
  const f = cfeat(H, A, cup, String(match.utcDate || new Date().toISOString()).slice(0, 10), vh, va);
  const g = engine === 'grid' ? cupProbs(f) : null;
  const p = commonSense(g || probs(d), g ? factorsOf(f, cupW) : d - HA, f.form, f.h2hInfo, guardOpt);
  const lamH = g ? Math.min(4, Math.max(0.2, f.lamH)) : Math.max(0.2, 1.45 * Math.exp(d / 700));
  const lamA = g ? Math.min(4, Math.max(0.2, f.lamA)) : Math.max(0.2, 1.2 * Math.exp(-d / 700));
  let over25 = 0, btts = 0;
  const scores: { home: number; away: number; prob: number }[] = [];
  for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) {
    const q = poisson(lamH, i) * poisson(lamA, j);
    if (i + j > 2.5) over25 += q;
    if (i > 0 && j > 0) btts += q;
    scores.push({ home: i, away: j, prob: q });
  }
  scores.sort((x, y) => y.prob - x.prob);
  const pct = (x: number) => Math.round(x * 1000) / 10;
  const out: Prediction = {
    model: MODEL_EURO,
    home: pct(p.h), draw: pct(p.d), away: pct(p.a),
    expectedGoals: { home: Math.round(lamH * 100) / 100, away: Math.round(lamA * 100) / 100 },
    over25: pct(over25), btts: pct(btts),
    topScores: scores.slice(0, 3).map(s => ({ ...s, prob: pct(s.prob) })),
    confidence: Math.min(H.n, A.n) < 8 ? 'low' : Math.min(H.cup, A.cup) >= 12 ? 'high' : Math.min(H.cup, A.cup) >= 4 ? 'medium' : 'low',
    factors: {
      homeAttack: Math.round(H.elo), homeDefence: 0, awayAttack: Math.round(A.elo), awayDefence: 0,
      homeAdvantage: HA, homeForm: Math.round(valueTerm), awayForm: 1, gamesPlayed: { home: H.n, away: A.n }, leagueAvgGoals: 1.3
    }
  };
  if (g) {
    const ps = population();
    const w = cupW;
    const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
    const edge = (x: number) => Math.round(x * 250) / 10;
    const relOf = (x: number) => (Math.abs(x) < 1e-9 ? 0 : Math.max(1, Math.min(5, Math.round(Math.abs(x) * 5)))); // fix282: weight 0 = not used
    const eur = (x: number | null) => (x ? `€${Math.round(x / 1e6)}m` : 'n/a');
    const rows: NonNullable<Prediction['grid']>['rows'] = [
      { id: '#1e', name: 'Strength (rating)', rel: relOf(w.w_elo), home: scale(H.elo, ps.elo), away: scale(A.elo, ps.elo), edge: edge(w.w_elo * f.dElo), note: `rating ${Math.round(H.elo)} vs ${Math.round(A.elo)}` },
      { id: '#1', name: 'Squad value', rel: relOf(w.w_squad), home: scale(Math.log(valueOr(vh)), ps.squad), away: scale(Math.log(valueOr(va)), ps.squad), edge: edge(w.w_squad * f.lv), note: `top-15 value ${eur(vh)} vs ${eur(va)}${!vh || !va ? ' (no data = small club)' : ''}` },
      { id: '#19', name: 'Goals: attack vs defence', rel: relOf(w.w_goals), home: scale(H.att + H.def, ps.goals), away: scale(A.att + A.def, ps.goals), edge: edge(w.w_goals * f.gl), note: `expected goals ${out.expectedGoals.home} vs ${out.expectedGoals.away}` },
      { id: '#21', name: 'Form, last 6 (vs expectation)', rel: relOf(w.w_form), home: scale(avg(H.recent), ps.form), away: scale(avg(A.recent), ps.form), edge: edge(w.w_form * f.form) },
      { id: '#10', name: 'Rest days', rel: relOf(w.w_rest), home: Math.round((5.5 + f.rest * 4.5) * 10) / 10, away: Math.round((5.5 - f.rest * 4.5) * 10) / 10, edge: edge(w.w_rest * f.rest) },
      { id: '#7', name: 'Head-to-head, last 10', rel: relOf(w.w_h2h || 0), home: f.h2hInfo ? Math.round((1 + 9 * f.h2hInfo.share) * 10) / 10 : 5, away: f.h2hInfo ? Math.round((1 + 9 * (1 - f.h2hInfo.share)) * 10) / 10 : 5, edge: edge((w.w_h2h || 0) * f.h2h), note: f.h2hInfo ? `${f.h2hInfo.n} meetings, ${H.name} share ${Math.round(f.h2hInfo.share * 100)}%` : 'no meetings in the data' },
      { id: '#23', name: 'Home advantage', rel: relOf(w.w_home), home: 7, away: 5.5, edge: edge(w.w_home) }
    ];
    const reasons = rows.filter(r => Math.abs(r.edge) >= 3).sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge)).slice(0, 3)
      .map(r => `${r.name}: ${r.edge > 0 ? H.name : A.name} +${Math.abs(r.edge)}`);
    if (p.fired) reasons.push('common-sense check: the weaker side on form or head-to-head is not made the favourite');
    const ptsH = Math.round(p.h * 1000), ptsA = Math.round(p.a * 1000);
    out.grid = {
      matchType: Math.abs(g.z) > 1.4 ? 'mismatch' : Math.abs(g.z) < 0.35 ? 'even' : 'standard',
      points: { home: ptsH, draw: 1000 - ptsH - ptsA, away: ptsA },
      totals: { home: Math.round(rows.reduce((s, r) => s + Math.max(0, r.edge), 0) * 10) / 10, away: Math.round(rows.reduce((s, r) => s + Math.max(0, -r.edge), 0) * 10) / 10 },
      rows,
      drawPot: { base: Math.round(f.pDraw * 1000), factors: 0, volatility: 0, total: 1000 - ptsH - ptsA },
      reasons,
      scope: 'cups'
    };
  }
  return out;
}

export function clubEloStatus() {
  const top = [...ratings.values()].filter(r => r.cup >= 6).sort((a, b) => b.elo - a.elo).slice(0, 25)
    .map((r, i) => ({ rank: i + 1, club: r.name, elo: Math.round(r.elo), cupMatches: r.cup, squadValueM: Math.round((clubValueFor(r.name) || 0) / 1e6), valueClub: clubValueMatch(r.name)?.club || null }));
  const n: any = db.prepare(`SELECT COUNT(*) AS n, MIN(date) AS first, MAX(date) AS last FROM eur_matches`).get();
  return { model: MODEL_EURO, engine, gridWeights: cupW, lastBuilt, cupMatches: n, clubs: ratings.size, clubValues: clubValues.length, fit, evaluation: evalStats, top };
}

export function startClubEloScheduler() {
  if (!afConfigured()) return;
  // fix167: built in slices (was one synchronous build at start-up and after every sync)
  after('club elo build', () => buildClubEloAsync().catch(() => undefined /* tables may be empty on first boot */), 0);
  const run = () => syncEuropeanCups().then(() => buildClubEloAsync()).catch(() => undefined);
  after('club elo', run, 4 * 60 * 1000);
  every('club elo', run, 12 * 3600 * 1000);
}
