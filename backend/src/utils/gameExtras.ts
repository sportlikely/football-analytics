/**
 * fix231: game-page extras — the pure parts (no database): weather rules, indoor venues, referee shrinkage, fixture
 * difficulty bands and the trend sentences. services/gameExtras.ts feeds them; scripts/game-extras.test.mjs tests them.
 */

export type ExtrasSport = 'football' | 'basketball' | 'nfl' | 'tennis';

/* ---------- weather ---------- */

export interface Weather { tempC: number | null; rainPct: number | null; rainMm: number | null; windKmh: number | null }
export type WeatherNote = 'wind' | 'rain' | 'heat';
/** when the weather matters enough for a reasons line: wind ≥ 30 km/h, heavy rain, 30 °C or more */
export const WIND_KMH = 30, HEAT_C = 30, HEAVY_RAIN_MM = 4, RAIN_MM = 2.5, RAIN_PCT = 60;
export function weatherNotes(w: Weather | null | undefined): WeatherNote[] {
  if (!w) return [];
  const out: WeatherNote[] = [];
  if (w.windKmh != null && w.windKmh >= WIND_KMH) out.push('wind');
  // heavy rain: 4 mm+ in the hour, or 2.5 mm+ with a 60%+ chance
  if (w.rainMm != null && (w.rainMm >= HEAVY_RAIN_MM || (w.rainMm >= RAIN_MM && (w.rainPct ?? 0) >= RAIN_PCT))) out.push('rain');
  if (w.tempC != null && w.tempC >= HEAT_C) out.push('heat');
  return out;
}

/** Domed / roofed American-football stadiums (retractable roofs count: closed when the weather is bad). */
const DOMES = /\bdome\b|superdome|skydome|fargodome|dakotadome|alamodome|at&t stadium|mercedes-benz stadium|ford field|lucas oil stadium|u\.?s\.? bank stadium|allegiant stadium|sofi stadium|state farm stadium|nrg stadium|tropicana field|caesars superdome|jma wireless|carrier dome|kibbie|holt arena|superior dome/i;
/** No weather card indoors: every basketball game, domed NFL / college stadiums, indoor tennis. */
export function isIndoor(sport: ExtrasSport, venue: string | null | undefined, tennisIndoor?: boolean | null): boolean {
  if (sport === 'basketball') return true;
  if (sport === 'nfl') return DOMES.test(String(venue || ''));
  if (sport === 'tennis') return tennisIndoor === true;
  return false;
}

/** the hour of a forecast (Open-Meteo hourly, GMT) closest to the start; null when the start is outside it */
export function hourAt(times: string[], startIso: string): number | null {
  const t = Date.parse(startIso);
  if (!Number.isFinite(t) || !times.length) return null;
  let best = -1, gap = Infinity;
  for (let i = 0; i < times.length; i++) {
    const d = Math.abs(Date.parse(times[i].endsWith('Z') ? times[i] : `${times[i]}Z`) - t);
    if (d < gap) { gap = d; best = i; }
  }
  return gap <= 90 * 60 * 1000 ? best : null;
}

/* ---------- referee ---------- */

export interface RefGame { homeWin: boolean; cards: number | null; pens: number | null }
export interface RefLeague { homeWin: number; cards: number | null; pens: number | null }
/** shrinkage: a referee's rate = (his total + K × league average) / (his games + K); rates shown from MIN_REF_GAMES */
export const REF_K = 10, MIN_REF_GAMES = 10;
export function shrink(sum: number, n: number, avg: number, k = REF_K): number {
  return (sum + k * avg) / (n + k);
}
export function refereeStats(games: RefGame[], league: RefLeague) {
  const n = games.length;
  const hw = games.filter(g => g.homeWin).length;
  const withCards = games.filter(g => g.cards != null), withPens = games.filter(g => g.pens != null);
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const show = n >= MIN_REF_GAMES;
  return {
    games: n,
    // fix289: the games his numbers need (the card says "from 10 games … 1 game so far", never "1 games")
    min: MIN_REF_GAMES,
    show,
    homeWinRaw: n ? hw / n : null,
    homeWin: show ? r2(shrink(hw, n, league.homeWin)) : null,
    leagueHomeWin: r2(league.homeWin),
    cards: show && league.cards != null && withCards.length >= MIN_REF_GAMES ? r2(shrink(withCards.reduce((a, g) => a + (g.cards || 0), 0), withCards.length, league.cards)) : null,
    leagueCards: league.cards == null ? null : r2(league.cards),
    pens: show && league.pens != null && withPens.length >= MIN_REF_GAMES ? r2(shrink(withPens.reduce((a, g) => a + (g.pens || 0), 0), withPens.length, league.pens)) : null,
    leaguePens: league.pens == null ? null : r2(league.pens)
  };
}
/** "Michael Oliver, England" → "Michael Oliver" (API-Football adds the country) */
export const refName = (s: string | null | undefined) => {
  const n = String(s || '').split(',')[0].replace(/\s+/g, ' ').trim();
  return n.length >= 3 ? n : null;
};

/* ---------- fixture difficulty ---------- */

export type Band = 'easy' | 'medium' | 'hard' | 'unknown';
/**
 * The team's win chance in our model → easy / medium / hard. Football's win chance has a draw beside it (three
 * results), so its lines are lower: easy from 50%, hard under 30%; two-result sports: easy from 60%, hard under 40%.
 */
export function difficultyBand(p: number | null | undefined, threeWay: boolean): Band {
  if (p == null || !Number.isFinite(p)) return 'unknown';
  const [easy, hard] = threeWay ? [0.5, 0.3] : [0.6, 0.4];
  return p >= easy ? 'easy' : p < hard ? 'hard' : 'medium';
}

/* ---------- trends ---------- */

/** one finished game from a team's side; `tag` = the surface in tennis */
export interface TeamGame { date: string; home: boolean | null; gf: number; ga: number; tag?: string | null }
export type Split = 'all' | 'home' | 'away' | 'surface';
export type Pattern = 'win' | 'loss' | 'unbeaten' | 'winless' | 'over' | 'under' | 'btts' | 'cleanSheet' | 'noGoal';
/** patterns per sport; `line` = the total for over / under (2.5 goals; basketball / NFL: the league's median total) */
const PATTERNS: Record<ExtrasSport, Pattern[]> = {
  football: ['win', 'loss', 'unbeaten', 'winless', 'over', 'under', 'btts', 'cleanSheet', 'noGoal'],
  basketball: ['win', 'loss', 'over', 'under'],
  nfl: ['win', 'loss', 'over', 'under'],
  tennis: ['win', 'loss']
};
/** two patterns of a group say nearly the same thing: one per team per group */
const GROUP: Record<Pattern, string> = { win: 'good', unbeaten: 'good', loss: 'bad', winless: 'bad', over: 'total', under: 'total', btts: 'btts', cleanSheet: 'defence', noGoal: 'attack' };
export function holds(p: Pattern, g: TeamGame, line: number): boolean {
  switch (p) {
    case 'win': return g.gf > g.ga;
    case 'loss': return g.gf < g.ga;
    case 'unbeaten': return g.gf >= g.ga;
    case 'winless': return g.gf <= g.ga;
    case 'over': return g.gf + g.ga > line;
    case 'under': return g.gf + g.ga < line;
    case 'btts': return g.gf > 0 && g.ga > 0;
    case 'cleanSheet': return g.ga === 0;
    case 'noGoal': return g.gf === 0;
  }
}
const inSplit = (s: Split, g: TeamGame, surface: string | null) =>
  s === 'all' ? true : s === 'home' ? g.home === true : s === 'away' ? g.home === false : !!surface && g.tag === surface;

/** P(X ≥ k) for X ~ Binomial(n, p): how unusual "k of the last n" is at the league's rate */
export function binomTail(k: number, n: number, p: number): number {
  if (k <= 0) return 1;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let s = 0, c = 1;
  for (let i = 0; i <= n; i++) {
    if (i > 0) c = (c * (n - i + 1)) / i;
    if (i >= k) s += c * Math.pow(p, i) * Math.pow(1 - p, n - i);
  }
  return Math.min(1, s);
}

/** the league's rate of each pattern per split, from both sides of every league game */
export type Rates = Map<string, number>;
export function leagueRates(sport: ExtrasSport, rows: TeamGame[], line: number): Rates {
  const out: Rates = new Map();
  for (const p of PATTERNS[sport]) for (const s of ['all', 'home', 'away'] as Split[]) {
    const list = rows.filter(g => inSplit(s, g, null));
    if (list.length < 30) continue;
    out.set(`${p}|${s}`, list.filter(g => holds(p, g, line)).length / list.length);
  }
  return out;
}

export const MIN_TREND_GAMES = 6, MAX_TREND_GAMES = 10, MAX_TRENDS = 4;
export interface Trend {
  side: 'home' | 'away'; team: string; pattern: Pattern; split: Split; k: number; n: number; line: number | null
  /** how unusual next to the league (binomial tail, smaller = rarer) */
  p: number; base: number
}
/**
 * One team's trends before a game: for each pattern and split, the window of its last 6–10 games in that split where
 * "k of the last n" is least likely at the league's rate. Kept when k ≥ 70% of n and that chance ≤ 10%.
 * `games` = the team's finished games before the start, newest first.
 */
export function teamTrends(sport: ExtrasSport, side: 'home' | 'away', team: string, games: TeamGame[], rates: Rates, line: number, surface: string | null = null): Trend[] {
  const splits: Split[] = sport === 'tennis' ? ['all', 'surface'] : ['all', side];
  const best = new Map<string, Trend>();
  for (const p of PATTERNS[sport]) for (const s of splits) {
    const base = rates.get(`${p}|${s === 'surface' ? 'all' : s}`);
    if (base == null) continue;
    const list = games.filter(g => inSplit(s, g, surface));
    let pick: Trend | null = null;
    let k = 0;
    for (let n = 1; n <= Math.min(MAX_TREND_GAMES, list.length); n++) {
      if (holds(p, list[n - 1], line)) k++;
      if (n < MIN_TREND_GAMES || k < Math.ceil(0.7 * n)) continue;
      const tail = binomTail(k, n, base);
      if (tail > 0.1) continue;
      if (!pick || tail < pick.p - 1e-12 || (Math.abs(tail - pick.p) <= 1e-12 && n > pick.n)) {
        pick = { side, team, pattern: p, split: s, k, n, line: p === 'over' || p === 'under' ? line : null, p: tail, base };
      }
    }
    if (!pick) continue;
    const g = GROUP[p], cur = best.get(g);
    if (!cur || pick.p < cur.p) best.set(g, pick);
  }
  return [...best.values()];
}
/** both teams' trends → the game's (at most 4, rarest first; one team never takes all 4 when the other has some) */
export function gameTrends(home: Trend[], away: Trend[], max = MAX_TRENDS): Trend[] {
  const all = [...home, ...away].sort((a, b) => a.p - b.p || b.n - a.n);
  const out: Trend[] = [];
  for (const t of all) {
    if (out.length >= max) break;
    const same = out.filter(x => x.side === t.side).length;
    const other = all.some(x => x.side !== t.side && !out.includes(x));
    if (same >= max - 1 && other) continue;
    out.push(t);
  }
  return out.sort((a, b) => a.p - b.p);
}
/** the median total of a league's games, as a .5 line (basketball / NFL over-under trends) */
export function medianLine(totals: number[]): number {
  if (!totals.length) return 0;
  const s = [...totals].sort((a, b) => a - b);
  return Math.floor(s[Math.floor(s.length / 2)]) + 0.5;
}
/** checks a trend against the games it came from (the test, and a guard before a trend is shown) */
export function trendIsTrue(t: Trend, games: TeamGame[], surface: string | null = null): boolean {
  const list = games.filter(g => inSplit(t.split, g, surface)).slice(0, t.n);
  if (list.length !== t.n || t.n < MIN_TREND_GAMES) return false;
  return list.filter(g => holds(t.pattern, g, t.line ?? 2.5)).length === t.k;
}

/**
 * fix264: where to look a venue up, in order — the venue's own name with its town (OpenStreetMap finds stadiums:
 * "Celtic Park, Glasgow, Scotland"), then the town alone (Open-Meteo, then OpenStreetMap), then the venue name alone.
 * API-Football's venue data has no coordinates, so a free geocoder it is; each venue is looked up once and stored.
 */
export type GeoQuery = { via: 'osm' | 'open-meteo'; q: string; source: string };
export const cleanCity = (c: string | null | undefined) => String(c || '').replace(/\s*\(.*\)\s*$/, '').split(',')[0].trim();
export function geoQueries(r: { sport: string; venue?: string | null; city?: string | null; country?: string | null }): GeoQuery[] {
  const city = cleanCity(r.city), country = String(r.country || '').trim();
  const venue = r.sport === 'tennis' ? '' : String(r.venue || '').trim();
  const out: GeoQuery[] = [];
  const join = (...xs: string[]) => xs.filter(Boolean).join(', ');
  if (venue) out.push({ via: 'osm', q: join(venue, city, country), source: 'venue (OpenStreetMap)' });
  if (city) {
    out.push({ via: 'open-meteo', q: city, source: 'city' });
    out.push({ via: 'osm', q: join(city, country), source: 'city (OpenStreetMap)' });
  }
  if (venue && city) out.push({ via: 'osm', q: join(venue, country), source: 'venue (OpenStreetMap)' });
  if (venue && !city) out.push({ via: 'open-meteo', q: venue, source: 'venue name' });
  const seen = new Set<string>();
  return out.filter(x => { const k = `${x.via}|${x.q.toLowerCase()}`; return !seen.has(k) && !!seen.add(k); });
}
