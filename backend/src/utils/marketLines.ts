/**
 * fix278: close to the market on every market (Yarin, 29 Oct: "there is no chance we give a basketball game 215+ while
 * the market gives 225+"). The pure parts, kept free of the database so they can be tested:
 *  - the consensus line of a market from several bookmakers (API-Sports /odds: the main line = each book's line closest
 *    to 50 / 50, the consensus = the median over books, its chances = the median of each book's margin-free chances);
 *  - the market anchor: shown = (1 − w)·model + w·market, w picked walk-forward (each game's w only from the games
 *    before it), kept only when it beats both the model alone and the market alone on those unseen games;
 *  - the early-season scoring level (basketball / NFL): the season's own points per game against what we predicted for
 *    those games, shrunk by games played;
 *  - the gap statistics and the public gate's market limits (more_pred_gate).
 * Market prices are admin-only: nothing here reaches a public route (stripMarket, utils/marketKeys.ts).
 */

export type MarketSport = 'basketball' | 'nfl' | 'football' | 'tennis';

/** one outcome of one book: the bet's value ("Over 225.5", "Home -5.5", "Home/Draw", "1:0") and its decimal price */
export interface RawValue { value: string; odd: string | number }
export interface RawBet { id?: number; name?: string; values?: RawValue[] }
export interface RawBook { id?: number; name?: string; bets?: RawBet[] }

/** a market's consensus: line (null for markets without one), median prices and margin-free chances per outcome */
export interface Consensus { market: string; line: number | null; prices: Record<string, number>; p: Record<string, number>; books: number }

export const median = (xs: number[]): number | null => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const r2 = (x: number) => Math.round(x * 100) / 100;
const price = (x: unknown) => { const v = Number(x); return Number.isFinite(v) && v > 1 ? v : null; };
/** margin-free chances of a set of prices (each 1 / price, scaled to 100%) */
export function devig(prices: number[]): number[] {
  const inv = prices.map(p => 1 / p), s = inv.reduce((a, b) => a + b, 0);
  return inv.map(x => x / s);
}

/**
 * which market a bet is (API-Sports bet names; the same names on API-Basketball, API-American-Football and API-Football
 * where they exist). null = a bet we do not keep.
 */
export function marketOf(sport: MarketSport, name: string): string | null {
  const n = String(name || '').toLowerCase().trim();
  if (sport === 'football') {
    if (n === 'match winner' || n === '1x2') return 'ml';
    if (n === 'goals over/under' || n === 'over/under') return 'ou';
    if (n === 'both teams score' || n === 'both teams to score') return 'btts';
    if (n === 'asian handicap') return 'ah';
    if (n === 'double chance') return 'dc';
    if (n === 'home/away' || n === 'draw no bet') return 'dnb';
    if (n === 'first half winner' || n === 'halftime result') return 'ht';
    if (n === 'ht/ft double' || n === 'halftime/fulltime') return 'htft';
    if (n === 'exact score' || n === 'correct score') return 'cs';
    if (/^corners over\s*\/?\s*under$/.test(n) || n === 'total corners') return 'corners';
    if (/^cards over\s*\/?\s*under$/.test(n) || n === 'total cards') return 'cards';
    if (n === 'anytime goal scorer' || n === 'anytime goalscorer') return 'scorer';
    return null;
  }
  // basketball / American football
  if (n === 'home/away' || n === 'money line' || n === 'moneyline') return 'ml';
  if (n === 'asian handicap' || n === 'point spread' || n === 'handicap') return 'spread';
  if (n === 'over/under' || n === 'total points' || n === 'over/under (incl. ot)' || n === 'over/under (incl ot)') return 'total';
  if (/^(total - home|home team total|home total|home team total points)$/.test(n)) return 'team_home';
  if (/^(total - away|away team total|away total|away team total points)$/.test(n)) return 'team_away';
  if (/^(asian handicap first half|asian handicap 1st half|handicap 1st half|point spread 1st half)$/.test(n)) return 'h1_spread';
  if (/^(over\/under 1st half|over\/under first half|total points 1st half)$/.test(n)) return 'h1_total';
  if (/^(home\/away \(1st half\)|home\/away 1st half|1st half winner|first half winner)$/.test(n)) return 'h1_ml';
  return null;
}

/** "Over 225.5" → ['over', 225.5]; "Home -5.5" → ['home', -5.5]; "-5.5" → [null, -5.5] */
export function sideLine(v: string): [string | null, number | null] {
  const m = /^\s*(home|away|over|under)?\s*([+-]?\d+(?:\.\d+)?)?\s*$/i.exec(String(v || ''));
  if (!m) return [null, null];
  return [m[1] ? m[1].toLowerCase() : null, m[2] != null ? Number(m[2]) : null];
}

/** a market with a line: the type and its two sides */
const LINE_KIND: Record<string, 'ou' | 'hcp'> = {
  total: 'ou', team_home: 'ou', team_away: 'ou', h1_total: 'ou', ou: 'ou', corners: 'ou', cards: 'ou',
  spread: 'hcp', h1_spread: 'hcp', ah: 'hcp'
};
export const lineKind = (market: string): 'ou' | 'hcp' | null => LINE_KIND[market] || null;

/**
 * one book's two-sided lines of a market: line → [price of over / home, price of under / away].
 * Handicaps are keyed by the HOME side's handicap (−5.5 = home gives 5.5; the market's home margin = −line, read once by
 * marketMargin / marketNumber). fix278b: books write the away side two ways — "Away +5.5" (its own handicap) or
 * "Away -5.5" (the home side's number, both sides) — so both pairings are built and the one whose pairs look like real
 * two-way prices (more complete pairs, then 1/a + 1/b nearest a normal 105% book) is kept. (29 Oct: the wrong pairing
 * stored home favourites as +6.5: basketball spread mean gap +11 against ours.)
 */
export function bookLines(kind: 'ou' | 'hcp', values: RawValue[]): Map<number, [number | null, number | null]> {
  const build = (awayOwn: boolean) => {
    const out = new Map<number, [number | null, number | null]>();
    for (const v of values || []) {
      const [side, line] = sideLine(v.value), p = price(v.odd);
      if (line == null || p == null || !side) continue;
      const a = kind === 'ou' ? side === 'over' : side === 'home';
      const b = kind === 'ou' ? side === 'under' : side === 'away';
      if (!a && !b) continue;
      const key = kind === 'hcp' && b && awayOwn ? -line : line;
      const cur = out.get(key) || [null, null];
      if (a) cur[0] = p; else cur[1] = p;
      out.set(key, cur);
    }
    return out;
  };
  if (kind === 'ou') return build(false);
  const own = build(true), home = build(false);
  const score = (m: Map<number, [number | null, number | null]>) => {
    const pairs = [...m.values()].filter(([a, b]) => a != null && b != null) as [number, number][];
    const off = pairs.length ? pairs.reduce((s, [a, b]) => s + Math.abs(1 / a + 1 / b - 1.05), 0) / pairs.length : Infinity;
    return { n: pairs.length, off };
  };
  const so = score(own), sh = score(home);
  if (sh.n > so.n) return home;
  if (sh.n === so.n && sh.off < so.off - 1e-9) return home;
  return own;
}

/** a book's main line: the two-sided line whose margin-free chance is closest to 50 / 50 (ties: the lower line) */
export function mainLine(lines: Map<number, [number | null, number | null]>): { line: number; a: number; b: number } | null {
  let best: { line: number; a: number; b: number; d: number } | null = null;
  for (const [line, [a, b]] of lines) {
    if (a == null || b == null) continue;
    const d = Math.abs(devig([a, b])[0] - 0.5);
    if (!best || d < best.d - 1e-9 || (Math.abs(d - best.d) <= 1e-9 && line < best.line)) best = { line, a, b, d };
  }
  return best ? { line: best.line, a: best.a, b: best.b } : null;
}

/**
 * the consensus of a two-sided market over several books: the median of the books' main lines, snapped to the
 * offered line nearest it; prices = the median price of each side at that line, p = the median of each book's
 * margin-free chance there. `fixed` = a given line (football over / under 1.5 / 2.5 / 3.5) instead of the main one.
 */
export function lineConsensus(market: string, kind: 'ou' | 'hcp', books: RawValue[][], fixed?: number): Consensus | null {
  const perBook = books.map(vs => bookLines(kind, vs)).filter(m => m.size);
  if (!perBook.length) return null;
  let line: number | null = fixed ?? null;
  if (line == null) {
    const mains = perBook.map(mainLine).filter(Boolean).map(m => m!.line);
    const med = median(mains);
    if (med == null) return null;
    const offered = [...new Set(perBook.flatMap(m => [...m.keys()]))];
    line = offered.sort((x, y) => Math.abs(x - med) - Math.abs(y - med) || x - y)[0];
  }
  const at = perBook.map(m => m.get(line!)).filter(x => x && x[0] != null && x[1] != null) as [number, number][];
  if (!at.length) return null;
  const names = kind === 'ou' ? ['over', 'under'] : ['home', 'away'];
  const pa = median(at.map(([a, b]) => devig([a, b])[0]))!;
  return {
    market: fixed != null ? `${market}${fixed}` : market, line,
    prices: { [names[0]]: r2(median(at.map(x => x[0]))!), [names[1]]: r2(median(at.map(x => x[1]))!) },
    p: { [names[0]]: r3(pa), [names[1]]: r3(1 - pa) }, books: at.length
  };
}

/**
 * the consensus of a market without a line (money line, both teams score, double chance, HT/FT, correct score,
 * goalscorer): the median price of each outcome over the books that price it; p = 1 / price scaled to 100% for markets
 * whose outcomes add up to one (not double chance or goalscorer: each is its own yes). At most `top` outcomes kept (the
 * shortest prices) for the long lists.
 */
export function outcomeConsensus(market: string, books: RawValue[][], opts: { normalise?: boolean; top?: number } = {}): Consensus | null {
  const by = new Map<string, number[]>();
  for (const vs of books) for (const v of vs || []) {
    const p = price(v.odd), k = String(v.value || '').trim();
    if (p == null || !k) continue;
    const l = by.get(k) || []; l.push(p); by.set(k, l);
  }
  if (!by.size) return null;
  let rows = [...by].map(([k, ps]) => ({ k, price: median(ps)!, n: ps.length })).sort((a, b) => a.price - b.price);
  if (opts.top) rows = rows.slice(0, opts.top);
  const prices: Record<string, number> = {}, p: Record<string, number> = {};
  const inv = rows.map(r => 1 / r.price), s = inv.reduce((a, b) => a + b, 0);
  rows.forEach((r, i) => { prices[r.k] = r2(r.price); p[r.k] = r3(opts.normalise === false ? inv[i] : inv[i] / s); });
  return { market, line: null, prices, p, books: Math.max(...rows.map(r => r.n)) };
}

/** which football over / under lines are kept as their own market (the user's 1.5 / 2.5 / 3.5) */
export const FOOTBALL_OU_LINES = [1.5, 2.5, 3.5];
const NO_NORMALISE = new Set(['dc', 'scorer']);
const TOP: Record<string, number> = { cs: 30, scorer: 40 };

/** every market of one game from the bookmakers of an API-Sports /odds answer */
export function gameConsensus(sport: MarketSport, books: RawBook[]): Consensus[] {
  const byMarket = new Map<string, RawValue[][]>();
  for (const b of books || []) {
    const seen = new Set<string>();
    for (const bet of b.bets || []) {
      const m = marketOf(sport, bet.name || '');
      if (!m || seen.has(m)) continue; // one entry of each market per book
      seen.add(m);
      const l = byMarket.get(m) || []; l.push(bet.values || []); byMarket.set(m, l);
    }
  }
  const out: Consensus[] = [];
  for (const [m, vs] of byMarket) {
    const kind = lineKind(m);
    if (m === 'ou' && sport === 'football') {
      for (const line of FOOTBALL_OU_LINES) { const c = lineConsensus('ou', 'ou', vs, line); if (c) out.push(c); }
      continue;
    }
    const c = kind ? lineConsensus(m, kind, vs) : outcomeConsensus(m, vs, { normalise: !NO_NORMALISE.has(m), top: TOP[m] });
    if (c) out.push(c);
  }
  // fix278b guard: the main handicap must agree with the money line's favourite (home 60%+ → the home side gives points)
  const ml = out.find(c => c.market === 'ml'), pH = ml ? (ml.p.Home ?? ml.p.home ?? ml.p['1']) : undefined;
  if (pH != null) for (const c of out) {
    if (lineKind(c.market) !== 'hcp' || c.market.startsWith('h1') || c.line == null || Math.abs(c.line) < 1) continue;
    if ((pH >= 0.6 && c.line > 0) || (pH <= 0.4 && c.line < 0)) Object.assign(c, { line: -c.line, prices: { home: c.prices.away, away: c.prices.home }, p: { home: c.p.away, away: c.p.home } });
  }
  return out.sort((a, b) => a.market.localeCompare(b.market));
}

/* ---------- the market's own numbers in our terms ---------- */

/** the market's expected home margin from its main spread (home handicap −5.5 → home by 5.5) */
export const marketMargin = (c: Pick<Consensus, 'line'> | null | undefined) => (c && c.line != null ? -c.line : null);
/** the market's expected total from its main total line */
export const marketTotal = (c: Pick<Consensus, 'line'> | null | undefined) => (c && c.line != null ? c.line : null);

/* ---------- the anchor ---------- */

/** shown line = (1 − w)·model + w·market; no market line → the model */
export const blendLine = (model: number, market: number | null | undefined, w: number) =>
  market == null || !Number.isFinite(market) || !w ? model : (1 - w) * model + w * market;
const logit = (p: number) => Math.log(p / (1 - p));
const clampP = (p: number) => Math.min(0.999, Math.max(0.001, p));
/** shown chance = the blend in log-odds (like fix251's 1X2 anchor in spirit); no market chance → the model */
export function blendChance(model: number, market: number | null | undefined, w: number): number {
  if (market == null || !Number.isFinite(market) || !w) return model;
  const z = (1 - w) * logit(clampP(model)) + w * logit(clampP(market));
  return 1 / (1 + Math.exp(-z));
}

/** one settled game for the anchor's fit: the model's number, the market's closing number, what happened */
export interface AnchorRow { t: number; model: number; market: number; actual: number; group?: string }
export type AnchorKind = 'line' | 'chance';
export const ANCHOR_WEIGHTS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
/** a game's loss: absolute error for lines (totals, margins), log loss for yes / no chances (actual 0 / 1) */
export function lossOf(kind: AnchorKind, x: number, actual: number): number {
  if (kind === 'line') return Math.abs(x - actual);
  const p = clampP(x);
  return -(actual ? Math.log(p) : Math.log(1 - p));
}
const blendOf = (kind: AnchorKind, r: AnchorRow, w: number) => (kind === 'line' ? blendLine(r.model, r.market, w) : blendChance(r.model, r.market, w));
function bestWeight(kind: AnchorKind, rows: AnchorRow[]): number {
  let best = 0, bestLoss = Infinity;
  for (const w of ANCHOR_WEIGHTS) {
    let s = 0;
    for (const r of rows) s += lossOf(kind, blendOf(kind, r, w), r.actual);
    if (s < bestLoss - 1e-12) { bestLoss = s; best = w; }
  }
  return best;
}
export interface AnchorFit {
  n: number; tested: number; w: number; kept: boolean; why: string
  /** mean loss on the games the blend never saw: model alone, market alone, the walk-forward blend */
  oos: { model: number; market: number; blend: number } | null
}
/** the weight each test game (from the 101st, time order) is scored with: the best on the games before it only */
export function walkWeights(kind: AnchorKind, rows: AnchorRow[], step = 25): number[] {
  const out: number[] = [];
  let w = 0;
  for (let i = ANCHOR_MIN_TRAIN; i < rows.length; i++) {
    if ((i - ANCHOR_MIN_TRAIN) % step === 0) w = bestWeight(kind, rows.slice(0, i));
    out.push(w);
  }
  return out;
}
/** the games before a test game that pick its weight (first test game after this many) */
export const ANCHOR_MIN_TRAIN = 100;
/** games with a closing line needed for a fit (and for a league group of its own) */
export const ANCHOR_MIN_GAMES = 300;
/**
 * the anchor weight, walk-forward: games in time order, each game from the 101st on gets the weight that was best on
 * every game before it (the test re-picks every `step` games), and is scored with it. Kept only when that walk-forward
 * blend is better on those unseen games than both the model alone and the market alone; the live weight = the best on
 * every game. Under 300 games: model only.
 */
export function fitAnchor(kind: AnchorKind, input: AnchorRow[], step = 25): AnchorFit {
  const rows = input.filter(r => Number.isFinite(r.model) && Number.isFinite(r.market) && Number.isFinite(r.actual)).sort((a, b) => a.t - b.t);
  if (rows.length < ANCHOR_MIN_GAMES) return { n: rows.length, tested: 0, w: 0, kept: false, why: `${rows.length} of ${ANCHOR_MIN_GAMES} games with a closing line: model only`, oos: null };
  let sm = 0, sk = 0, sb = 0, n = 0;
  const ws = walkWeights(kind, rows, step);
  for (let i = ANCHOR_MIN_TRAIN; i < rows.length; i++) {
    const r = rows[i], w = ws[i - ANCHOR_MIN_TRAIN];
    sm += lossOf(kind, r.model, r.actual); sk += lossOf(kind, r.market, r.actual); sb += lossOf(kind, blendOf(kind, r, w), r.actual); n++;
  }
  const oos = { model: Math.round((sm / n) * 10000) / 10000, market: Math.round((sk / n) * 10000) / 10000, blend: Math.round((sb / n) * 10000) / 10000 };
  const live = bestWeight(kind, rows);
  const beats = sb < sm - 1e-9 && sb < sk - 1e-9;
  const unit = kind === 'line' ? 'mean error' : 'log loss';
  return {
    n: rows.length, tested: n, w: beats ? live : 0, kept: beats && live > 0,
    why: beats ? (live > 0 ? `blend ${oos.blend} better than the model ${oos.model} and the market ${oos.market} (${unit}, ${n} unseen games)` : 'the best weight on every game is 0: model only')
      : `blend ${oos.blend} not better than both the model ${oos.model} and the market ${oos.market} (${unit}, ${n} unseen games): model only`,
    oos
  };
}
/** per league group when the group has 300+ games, else the sport's fit (the group key 'all') */
export function fitAnchorGroups(kind: AnchorKind, rows: AnchorRow[]): Record<string, AnchorFit> {
  const out: Record<string, AnchorFit> = { all: fitAnchor(kind, rows) };
  const by = new Map<string, AnchorRow[]>();
  for (const r of rows) if (r.group) { const l = by.get(r.group) || []; l.push(r); by.set(r.group, l); }
  for (const [g, rs] of by) if (rs.length >= ANCHOR_MIN_GAMES) out[g] = fitAnchor(kind, rs);
  return out;
}
export const anchorWeightOf = (fits: Record<string, AnchorFit> | null | undefined, group: string | null | undefined): number => {
  if (!fits) return 0;
  const f = (group && fits[group]) || fits.all;
  return f && f.kept ? f.w : 0;
};

/* ---------- the early-season scoring level (basketball / NFL) ---------- */

/** one settled game of a league's season: what we predicted before the anchor, what happened */
export interface LevelRow { t: number; league: string; season: string; predicted: number; actual: number }
/** games of the season that count as much as last season's level (basketball 40, NFL 32, college 60) */
export const LEVEL_K: Record<'basketball' | 'nfl', number> = { basketball: 40, nfl: 32 };
/**
 * the shift for a league's next game: the season's points per game so far against what we predicted for those games,
 * shrunk by games played: n / (n + k) · mean(actual − predicted). With no game yet: 0 (last season's level as it is).
 */
export function levelShift(rows: { predicted: number; actual: number }[], k: number): number {
  const n = rows.length;
  if (!n) return 0;
  const resid = rows.reduce((s, r) => s + (r.actual - r.predicted), 0) / n;
  return (n / (n + k)) * resid;
}
export interface LevelTest { n: number; maeModel: number | null; maeShift: number | null; kept: boolean; why: string }
/**
 * walk-forward: each game's shift only from the same league and season's games before it; kept when the shifted
 * totals' mean error on those games is lower than the model's own (100+ games).
 */
export function levelTest(input: LevelRow[], k: number): LevelTest {
  const rows = [...input].filter(r => Number.isFinite(r.predicted) && Number.isFinite(r.actual)).sort((a, b) => a.t - b.t);
  const seen = new Map<string, { predicted: number; actual: number }[]>();
  let sm = 0, ss = 0, n = 0;
  for (const r of rows) {
    const key = `${r.league}|${r.season}`;
    const before = seen.get(key) || [];
    const shift = levelShift(before, k);
    sm += Math.abs(r.predicted - r.actual); ss += Math.abs(r.predicted + shift - r.actual); n++;
    before.push({ predicted: r.predicted, actual: r.actual }); seen.set(key, before);
  }
  if (n < 100) return { n, maeModel: null, maeShift: null, kept: false, why: `${n} of 100 settled games: not applied` };
  const maeModel = Math.round((sm / n) * 100) / 100, maeShift = Math.round((ss / n) * 100) / 100;
  const kept = ss < sm - 1e-9;
  return { n, maeModel, maeShift, kept, why: kept ? `mean error ${maeModel} → ${maeShift} on ${n} games` : `mean error ${maeModel} → ${maeShift} on ${n} games: not better, not applied` };
}

/* ---------- gaps to the market ---------- */

export interface GapStats { n: number; meanGap: number | null; medianAbs: number | null }
/** mean gap (ours − market: below 0 = we are low) and median |gap| */
export function gapStats(pairs: { ours: number; market: number }[]): GapStats {
  const g = pairs.filter(p => Number.isFinite(p.ours) && Number.isFinite(p.market)).map(p => p.ours - p.market);
  if (!g.length) return { n: 0, meanGap: null, medianAbs: null };
  return { n: g.length, meanGap: r2(g.reduce((a, b) => a + b, 0) / g.length), medianAbs: r2(median(g.map(Math.abs))!) };
}
/** who was closer to what happened: mean error (lines) or log loss + Brier (yes / no chances), ours vs the closing line */
export function closerStats(kind: AnchorKind, rows: { ours: number; market: number; actual: number }[]) {
  const ok = rows.filter(r => [r.ours, r.market, r.actual].every(Number.isFinite));
  if (!ok.length) return null;
  const mean = (f: (r: typeof ok[number]) => number) => Math.round((ok.reduce((s, r) => s + f(r), 0) / ok.length) * 10000) / 10000;
  if (kind === 'line') return { n: ok.length, oursMae: mean(r => Math.abs(r.ours - r.actual)), marketMae: mean(r => Math.abs(r.market - r.actual)) };
  return {
    n: ok.length, oursLogLoss: mean(r => lossOf('chance', r.ours, r.actual)), marketLogLoss: mean(r => lossOf('chance', r.market, r.actual)),
    oursBrier: mean(r => (r.ours - r.actual) ** 2), marketBrier: mean(r => (r.market - r.actual) ** 2)
  };
}

/* ---------- the public gate (more_pred_gate) ---------- */

/**
 * the market limit of each output (Yarin, fix278): median |gap| to the closing line on 300+ settled games. unit
 * 'points' = a line, 'chance' = percentage points of a yes / no chance. Outputs built from the same line follow it
 * (each side's points and the first half follow the total).
 */
export interface MarketLimit { market: string; limit: number; unit: 'points' | 'chance'; label: string }
export const MARKET_LIMITS: Record<MarketSport, Record<string, MarketLimit>> = {
  basketball: {
    total: { market: 'total', limit: 3, unit: 'points', label: 'totals' }, homePts: { market: 'total', limit: 3, unit: 'points', label: 'totals' },
    awayPts: { market: 'total', limit: 3, unit: 'points', label: 'totals' }, half: { market: 'total', limit: 3, unit: 'points', label: 'totals' },
    totalLine: { market: 'total', limit: 3, unit: 'points', label: 'totals' }, half2: { market: 'total', limit: 3, unit: 'points', label: 'totals' },
    margin: { market: 'spread', limit: 2, unit: 'points', label: 'the spread' }
  },
  nfl: {
    total: { market: 'total', limit: 2.5, unit: 'points', label: 'totals' }, homePts: { market: 'total', limit: 2.5, unit: 'points', label: 'totals' },
    awayPts: { market: 'total', limit: 2.5, unit: 'points', label: 'totals' }, half: { market: 'total', limit: 2.5, unit: 'points', label: 'totals' },
    totalLine: { market: 'total', limit: 2.5, unit: 'points', label: 'totals' }, half2: { market: 'total', limit: 2.5, unit: 'points', label: 'totals' },
    margin: { market: 'spread', limit: 1.5, unit: 'points', label: 'the spread' }
  },
  tennis: { games: { market: 'total_games', limit: 1.5, unit: 'points', label: 'total games' } },
  football: {
    goals: { market: 'ou2.5', limit: 5, unit: 'chance', label: 'over / under 2.5' },
    cleanHome: { market: 'btts', limit: 5, unit: 'chance', label: 'both teams score' }, cleanAway: { market: 'btts', limit: 5, unit: 'chance', label: 'both teams score' },
    // fix281: the yes / no questions follow their own market (each team scores: both teams score)
    over15: { market: 'ou1.5', limit: 5, unit: 'chance', label: 'over / under 1.5' }, over25: { market: 'ou2.5', limit: 5, unit: 'chance', label: 'over / under 2.5' },
    over35: { market: 'ou3.5', limit: 5, unit: 'chance', label: 'over / under 3.5' }, btts: { market: 'btts', limit: 5, unit: 'chance', label: 'both teams score' },
    scoreHome: { market: 'btts', limit: 5, unit: 'chance', label: 'both teams score' }, scoreAway: { market: 'btts', limit: 5, unit: 'chance', label: 'both teams score' }
  }
};
/** the settled games with a closing line an output needs before its gap counts */
export const GATE_MARKET_GAMES = 300;
export interface MarketGapNow { n: number; medianAbs: number | null; feed: boolean }
/**
 * the market half of the gate: null = passes (or the output has no market, or the feed has no such market at all);
 * a string = admin-only, with the reason ("4.8 points from the market on totals").
 */
export function marketGateWhy(sport: MarketSport, output: string, g: MarketGapNow | null | undefined): string | null {
  const lim = MARKET_LIMITS[sport]?.[output];
  if (!lim) return null;
  if (!g || !g.feed) return null;
  if (g.n < GATE_MARKET_GAMES || g.medianAbs == null) return `collecting market lines: ${g.n} of ${GATE_MARKET_GAMES} settled games on ${lim.label}`;
  if (g.medianAbs > lim.limit) return lim.unit === 'points'
    ? `${g.medianAbs} points from the market on ${lim.label} (limit ${lim.limit})`
    : `${g.medianAbs} points from the market's chance on ${lim.label} (limit ${lim.limit})`;
  return null;
}

/* ---------- home / away the other way round (a Football-Data twin whose API-Football fixture is swapped) ---------- */

const SWAP_WORD: Record<string, string> = { Home: 'Away', Away: 'Home', home: 'away', away: 'home', '1': '2', '2': '1' };
const swapKey = (market: string, k: string): string => {
  if (market === 'cs') { const m = /^(\d+):(\d+)$/.exec(k); return m ? `${m[2]}:${m[1]}` : k; }
  if (market === 'dc') return ({ 'Home/Draw': 'Draw/Away', 'Draw/Away': 'Home/Draw' } as Record<string, string>)[k] || k;
  if (market === 'htft') return k.split('/').map(x => SWAP_WORD[x] || x).join('/');
  return SWAP_WORD[k] || k;
};
/** the same markets seen from the other side: handicaps negated, home / away outcomes exchanged; totals unchanged */
export function swapConsensus(list: Consensus[]): Consensus[] {
  return list.map(c => {
    if (lineKind(c.market) === 'ou') return c;
    const sw = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [swapKey(c.market, k), v]));
    return { ...c, line: c.line != null && lineKind(c.market) === 'hcp' ? -c.line : c.line, prices: sw(c.prices), p: sw(c.p) };
  });
}

/* ---------- tennis (Live Tennis API /markets): total games and set betting when the feed has them ---------- */

const tnum = (x: any) => (x === null || x === undefined || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));
/**
 * every market of a match beyond the match winner (tennis_prices keeps that one): a market named like total games
 * (a line and two sides) → 'total_games'; set betting / correct score in sets → 'sets'. names = every market name the
 * feed sent (Admin sees which markets exist).
 */
export function tennisMarkets(data: any[]): { list: Consensus[]; names: string[] } {
  const names: string[] = [], list: Consensus[] = [];
  for (const mk of data || []) {
    const name = String(mk?.name ?? mk?.market ?? mk?.type ?? mk?.kind ?? '').trim();
    if (name) names.push(name);
    const prices: any[] = Array.isArray(mk?.prices) ? mk.prices : [];
    const mid = (p: any) => tnum(p?.mid) ?? tnum(p?.price) ?? tnum(p?.odd) ?? tnum(p?.odds);
    if (/total\s*games|games\s*(total|over)|over\s*\/\s*under.*games/i.test(name)) {
      const line = tnum(mk?.line) ?? tnum(mk?.handicap) ?? tnum(mk?.points) ?? tnum(prices[0]?.line) ?? tnum(prices[0]?.handicap);
      const over = prices.find(p => /over/i.test(String(p?.name ?? p?.label ?? p?.outcome ?? '')) || p?.side === 1);
      const under = prices.find(p => /under/i.test(String(p?.name ?? p?.label ?? p?.outcome ?? '')) || p?.side === 2);
      const a = mid(over), b = mid(under);
      if (line != null && a && b && a > 1 && b > 1) {
        const [pa] = devig([a, b]);
        list.push({ market: 'total_games', line, prices: { over: r2(a), under: r2(b) }, p: { over: r3(pa), under: r3(1 - pa) }, books: 1 });
      }
    } else if (/set\s*betting|correct\s*score|set\s*score/i.test(name)) {
      const vals: RawValue[] = prices.map(p => ({ value: String(p?.name ?? p?.label ?? p?.outcome ?? ''), odd: mid(p) ?? 0 }));
      const c = outcomeConsensus('sets', [vals]);
      if (c) list.push(c);
    }
  }
  return { list, names: [...new Set(names)] };
}
