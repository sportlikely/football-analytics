/**
 * fix242: the upset watch rule, one file for every sport (pure: no database).
 *
 * 26 Oct 2026: /football/upset-watch listed 304 cards (every underdog at 20–45%) and, whenever the away team was the
 * favourite, said "Norwich is the favourite, but our model gives Watford about a 1 in 5 chance" (Watford 58%). From now:
 *  - favourite / underdog are taken from the higher win %, never from the home / away order (sidesOf), and the names
 *    travel with their % ({ side, name, p }) so the page never has to work them out again;
 *  - a game is on the watch only when the favourite is 50%+ to win, the underdog 25%+, AND there is a clear reason
 *    (a key player out for the favourite, the underdog's form or rest edge, the favourite's away record, a table gap
 *    bigger than our ratings, the underdog's head-to-head);
 *  - ranked by competition (top competitions first), then by how surprising it is: the underdog's chance against how
 *    big the favourite is (table / rating / ranking); 10 per week per sport are shown, the rest behind "Show all".
 */

/** minGap (fix188, kept): a 51–49 game is a coin flip, not an upset — the favourite must lead by 10+ points */
export const UPSET = { minFav: 50, minDog: 25, minGap: 10, perWeek: 10, recordDays: 30 };

export type Side = 'H' | 'A';
export interface TeamSide { side: Side; name: string; p: number }
export type ReasonKey = 'keyOut' | 'form' | 'rest' | 'awayRecord' | 'closerThanTable' | 'h2h';
/** One reason, worded on the page from its key and numbers (translated there). a / b / n: see each key's builder. */
export interface Reason { key: ReasonKey; /** from football's grid rows (form in points, rest in games played) */ grid?: boolean; player?: string; a?: number; b?: number; c?: number; d?: number; n?: number }
/** A reason candidate: the side it helps and how strong it is (0–1). */
export interface Signal extends Reason { helps: Side; strength: number }

const other = (s: Side): Side => (s === 'H' ? 'A' : 'H');
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const r1 = (x: number) => Math.round(x * 10) / 10;
const DAY = 86400000;

/** Favourite and underdog from the win %, never from the home / away order (ties: no favourite → null). */
export function sidesOf(home: string, away: string, pHome: number, pAway: number): { favourite: TeamSide; underdog: TeamSide } | null {
  if (!Number.isFinite(pHome) || !Number.isFinite(pAway) || pHome === pAway) return null;
  const homeFav = pHome > pAway;
  const H: TeamSide = { side: 'H', name: home, p: r1(pHome) }, A: TeamSide = { side: 'A', name: away, p: r1(pAway) };
  return homeFav ? { favourite: H, underdog: A } : { favourite: A, underdog: H };
}

/** The numbers part of the rule: favourite 50%+ to win, underdog 25%+, and the favourite 10+ points ahead. */
export const passesCut = (favP: number, dogP: number) => favP >= UPSET.minFav && dogP >= UPSET.minDog && favP - dogP >= UPSET.minGap;

/** The strongest signal that helps the underdog, or null (no clear reason → not on the watch). */
export function pickReason(signals: Signal[], dog: Side): Reason | null {
  const best = signals.filter(s => s.helps === dog && s.strength >= 0.2).sort((a, b) => b.strength - a.strength)[0];
  if (!best) return null;
  const { helps: _h, strength: _s, ...reason } = best;
  return reason;
}

/** How surprising: the underdog's chance, more so against a big favourite (stature 0–1: table, rating or ranking). */
export const surpriseOf = (dogP: number, stature: number) => r1(dogP * (1 + clamp01(stature)));

export interface Ranked { tier: number; surprise: number; date: string }
/** Top competitions first (tier 1, 2, 3), then the most surprising, then the earliest; the first 10 are "top". */
export function rankWeek<T extends Ranked>(items: T[], perWeek = UPSET.perWeek): (T & { top: boolean })[] {
  return [...items]
    .sort((a, b) => a.tier - b.tier || b.surprise - a.surprise || a.date.localeCompare(b.date))
    .map((x, i) => ({ ...x, top: i < perWeek }));
}

/** fix242 data health: the names shown as favourite / underdog are the sides with the higher / lower win %. */
export function textMatchesNumbers(x: { home: string; away: string; pHome: number; pAway: number; favourite: TeamSide; underdog: TeamSide }): boolean {
  const s = sidesOf(x.home, x.away, x.pHome, x.pAway);
  if (!s) return false;
  return s.favourite.name === x.favourite.name && s.favourite.side === x.favourite.side && s.underdog.name === x.underdog.name
    && x.favourite.p > x.underdog.p && Math.abs(x.favourite.p - s.favourite.p) < 0.11 && Math.abs(x.underdog.p - s.underdog.p) < 0.11;
}

/* ---------- one report shape for every sport ---------- */

/** A game the sport offers (signals / stature are only worked out for games that pass the numbers cut). */
export interface Candidate {
  matchId: number; league: string; tier: number; date: string; home: string; away: string
  homeCrest?: string | null; awayCrest?: string | null
  /** win % (0–100); pDraw null in sports without draws */
  pHome: number; pDraw: number | null; pAway: number
  signals: (fav: Side) => Signal[]; stature: (fav: Side) => number
}
export interface WatchItem {
  matchId: number; league: string; tier: number; date: string; home: string; away: string
  homeCrest: string | null; awayCrest: string | null; pHome: number; pDraw: number | null; pAway: number
  favourite: TeamSide; underdog: TeamSide; reason: Reason; surprise: number
}
/** The game on the watch, or null (numbers below the cut, or no clear reason). */
export function judge(c: Candidate): WatchItem | null {
  const s = sidesOf(c.home, c.away, c.pHome, c.pAway);
  if (!s || !passesCut(s.favourite.p, s.underdog.p)) return null;
  const reason = pickReason(c.signals(s.favourite.side), s.underdog.side);
  if (!reason) return null;
  return {
    matchId: c.matchId, league: c.league, tier: c.tier, date: c.date, home: c.home, away: c.away,
    homeCrest: c.homeCrest ?? null, awayCrest: c.awayCrest ?? null, pHome: r1(c.pHome), pDraw: c.pDraw === null ? null : r1(c.pDraw), pAway: r1(c.pAway),
    favourite: s.favourite, underdog: s.underdog, reason, surprise: surpriseOf(s.underdog.p, c.stature(s.favourite.side))
  };
}

export interface PastItem { matchId: number; league: string; date: string; home: string; away: string; score: string; favourite: TeamSide; underdog: TeamSide; result: 'upset' | 'draw' | 'favourite' }
/**
 * The page: this week's games (ranked, the first 10 "top") and the record of the last 30 days — every game that was on
 * the watch (same rule, prediction saved before the start): how often the underdog won against the chance we gave.
 */
export function watchReport(upcoming: Candidate[], done: (Candidate & { outcome: 'H' | 'D' | 'A'; score: string })[], now = Date.now()) {
  const list = rankWeek(upcoming.map(judge).filter((x): x is WatchItem => !!x));
  const since = now - UPSET.recordDays * DAY;
  const past: PastItem[] = [];
  let said = 0, upsets = 0;
  for (const d of done) {
    if (new Date(d.date).getTime() < since) continue;
    const w = judge(d);
    if (!w) continue;
    const upset = d.outcome === w.underdog.side;
    said += w.underdog.p; if (upset) upsets++;
    past.push({ matchId: w.matchId, league: w.league, date: w.date, home: w.home, away: w.away, score: d.score, favourite: w.favourite, underdog: w.underdog, result: upset ? 'upset' : d.outcome === 'D' ? 'draw' : 'favourite' });
  }
  past.sort((a, b) => b.date.localeCompare(a.date));
  const n = past.length;
  return {
    rule: UPSET, upcoming: list, total: list.length,
    record: { days: UPSET.recordDays, n, upsets, upsetRate: n ? r1((100 * upsets) / n) : null, said: n ? r1(said / n) : null, recent: past.slice(0, 100) }
  };
}

/* ---------- football: reasons from the grid-v3 rows saved with the prediction ---------- */

interface GridRow { id: string; edge?: number; home?: number; away?: number; note?: string }
/** "usual starters out: A, B | C" / "out: A | none" → the names of one side (H = before the bar). */
const outNames = (note: string | undefined, side: Side): string[] => {
  if (!note || !/out:/i.test(note)) return [];
  const parts = note.slice(note.indexOf(':') + 1).split('|');
  const list = (parts[side === 'H' ? 0 : 1] || '').split(',').map(s => s.trim()).filter(s => s && !/^none$/i.test(s));
  return list;
};

/**
 * Signals from the grid rows (edge > 0 helps the home side): #12 / #13 the favourite's missing starters, #21 form
 * (last 6, points), #10 freshness (games in the last 8 days), #23 the favourite's away record, #7 head-to-head.
 */
export function footballSignals(rows: GridRow[] | null | undefined, fav: Side): Signal[] {
  if (!Array.isArray(rows)) return [];
  const dog = other(fav), out: Signal[] = [];
  const row = (id: string) => rows.find(r => r.id === id);
  const helpsDog = (edge: number | undefined) => (dog === 'H' ? Number(edge) : -Number(edge));
  // #12 confirmed XI vs usual XI, else #13 injuries / suspensions: the favourite's first missing name
  for (const id of ['#12', '#13']) {
    const r = row(id);
    const e = helpsDog(r?.edge);
    const names = outNames(r?.note, fav);
    if (r && e >= 3 && names.length) { out.push({ key: 'keyOut', grid: true, helps: dog, strength: clamp01(e / 20), player: names[0], n: names.length }); break; }
  }
  // #21 form, last 6: "last 6: 6 vs 11 pts" (home vs away)
  const f = /last (\d+):\s*(\d+)\s*vs\s*(\d+)/i.exec(row('#21')?.note || '');
  if (f) {
    const h = Number(f[2]), a = Number(f[3]);
    const dPts = dog === 'H' ? h : a, fPts = dog === 'H' ? a : h;
    if (dPts - fPts >= 3) out.push({ key: 'form', grid: true, helps: dog, strength: clamp01((dPts - fPts) / 9), a: dPts, b: fPts, n: Number(f[1]) });
  }
  // #10 freshness: "1 vs 0 games in the last 8 days"
  const fr = /(\d+)\s*vs\s*(\d+)\s*games in the last (\d+) days/i.exec(row('#10')?.note || '');
  if (fr) {
    const h = Number(fr[1]), a = Number(fr[2]);
    const fG = fav === 'H' ? h : a, dG = fav === 'H' ? a : h;
    if (fG > dG && helpsDog(row('#10')?.edge) > 0) out.push({ key: 'rest', grid: true, helps: dog, strength: clamp01(0.3 + 0.2 * (fG - dG)), a: fG, b: dG, n: Number(fr[3]) });
  }
  // #23 home record of the home side vs away record of the away side: only when the favourite plays away
  const rec = row('#23');
  if (fav === 'A' && rec && helpsDog(rec.edge) >= 2) out.push({ key: 'awayRecord', grid: true, helps: dog, strength: clamp01(helpsDog(rec.edge) / 10) });
  // #7 head-to-head: "5 meetings, home side share 60%"
  const h2h = /(\d+) meetings, home side share (\d+)%/i.exec(row('#7')?.note || '');
  if (h2h) {
    const n = Number(h2h[1]), share = dog === 'H' ? Number(h2h[2]) : 100 - Number(h2h[2]);
    if (n >= 3 && share >= 55) out.push({ key: 'h2h', grid: true, helps: dog, strength: clamp01((share - 50) / 40), a: Math.round(share), n });
  }
  return out;
}

/** The favourite's stature from its Elo row (#1e, 0–10 scale) — how big it is regardless of this game. */
export function footballStature(rows: GridRow[] | null | undefined, fav: Side): number {
  const e = Array.isArray(rows) ? rows.find(r => r.id === '#1e') : null;
  const v = e ? Number(fav === 'H' ? e.home : e.away) : NaN;
  return Number.isFinite(v) ? clamp01(v / 10) : 0.3;
}

const FB_TIER1 = new Set(['CL', 'PL', 'PD', 'SA', 'BL1', 'FL1', 'WC', 'EC', 'AF2', 'AF39', 'AF140', 'AF135', 'AF78', 'AF61', 'AF1', 'AF4']);
const FB_TIER2 = new Set(['DED', 'PPL', 'ELC', 'BSA', 'AF3', 'AF848', 'AF88', 'AF94', 'AF40', 'AF71', 'AF253', 'AF203', 'AF144', 'AF307']);
/** Football competition tier: 1 = Champions League, the big five, World Cup / Euros; 2 = the next leagues; 3 = the rest. */
export const footballTier = (code: string | null | undefined) => (code && FB_TIER1.has(code) ? 1 : code && FB_TIER2.has(code) ? 2 : 3);

/* ---------- winner sports (basketball, American football, tennis): reasons from past games ---------- */

/** One finished game of a team (from its own point of view). */
export interface Past { date: string; home: boolean; won: boolean; opp: number }
export interface HistoryInput {
  kickoff: string; fav: Side;
  /** each side's finished games before kick-off (any order) */
  games: { H: Past[]; A: Past[] };
  /** ids of both sides (head-to-head) */
  ids: { H: number; A: number };
  /** the favourite's injured key player, when known (NBA injury report, NFL injury report) */
  keyOut?: { player: string; strength: number } | null;
  /** tennis: ranks instead of a season table */
  ranks?: { H: number | null; A: number | null } | null;
  /** days of rest that count as "fresh" against a tired favourite (basketball 1.4 = back-to-back) */
  tiredUnder?: number;
}
/** This season's games (newest first in, newest first out): back to the first break of 45+ days (the off-season). */
function seasonOf(L: Past[], ko: number): Past[] {
  const out: Past[] = [];
  let prev = ko;
  for (const g of L) {
    const t = new Date(g.date).getTime();
    if (prev - t > 45 * DAY) break;
    out.push(g); prev = t;
  }
  return out;
}

/** Signals from the teams' own games: form (last 5), rest, the favourite's away record, season table, head-to-head. */
export function historySignals(x: HistoryInput): Signal[] {
  const fav = x.fav, dog = other(fav), ko = new Date(x.kickoff).getTime(), out: Signal[] = [];
  const before = (s: Side) => x.games[s].filter(g => new Date(g.date).getTime() < ko - 3 * 3600000).sort((a, b) => b.date.localeCompare(a.date));
  const F = before(fav), D = before(dog);
  if (x.keyOut?.player) out.push({ key: 'keyOut', helps: dog, strength: clamp01(x.keyOut.strength), player: x.keyOut.player });
  // form: wins in the last 5
  if (F.length >= 5 && D.length >= 5) {
    const fw = F.slice(0, 5).filter(g => g.won).length, dw = D.slice(0, 5).filter(g => g.won).length;
    if (dw - fw >= 2) out.push({ key: 'form', helps: dog, strength: clamp01((dw - fw) / 4), a: dw, b: fw, n: 5 });
  }
  // rest: days since each side's last game (tired favourite, fresh underdog)
  if (F[0] && D[0]) {
    const fr = (ko - new Date(F[0].date).getTime()) / DAY, dr = (ko - new Date(D[0].date).getTime()) / DAY;
    const tired = x.tiredUnder ?? 1.4;
    if (fr < tired && dr >= 2 && dr - fr >= 1.5 && dr < 30) out.push({ key: 'rest', helps: dog, strength: 0.6, a: Math.max(0, Math.round(fr)), b: Math.round(dr) });
    else if (dr - fr >= 3 && fr < 4 && dr < 30) out.push({ key: 'rest', helps: dog, strength: clamp01(0.2 + (dr - fr) / 10), a: Math.max(0, Math.round(fr)), b: Math.round(dr) });
  }
  // the favourite's away record (last 10 away games), when it plays away
  if (fav === 'A' && !x.ranks) {
    const away = F.filter(g => !g.home).slice(0, 10);
    const w = away.filter(g => g.won).length;
    if (away.length >= 4 && w / away.length <= 0.4) out.push({ key: 'awayRecord', helps: dog, strength: clamp01((0.5 - w / away.length) * 2.5), a: w, b: away.length });
  }
  // the table says the gap is big, our numbers say it is smaller (tennis: the ranking)
  if (x.ranks) {
    const fr = x.ranks[fav], dr = x.ranks[dog];
    if (fr && dr && dr - fr >= 20 && dr / fr >= 3) out.push({ key: 'closerThanTable', helps: dog, strength: clamp01(Math.log10(dr / fr) / 1.5), a: fr, b: dr });
  } else {
    const fs = seasonOf(F, ko), ds = seasonOf(D, ko);
    if (fs.length >= 5 && ds.length >= 5) {
      const fw = fs.filter(g => g.won).length, dw = ds.filter(g => g.won).length;
      const gap = fw / fs.length - dw / ds.length;
      if (gap >= 0.3) out.push({ key: 'closerThanTable', helps: dog, strength: clamp01(gap), a: fw, b: fs.length - fw, c: dw, d: ds.length - dw });
    }
  }
  // head-to-head: the last 5 meetings in 3 years
  const met = D.filter(g => g.opp === x.ids[fav] && ko - new Date(g.date).getTime() < 3 * 365 * DAY).slice(0, 5);
  const mw = met.filter(g => g.won).length;
  if (met.length >= 2 && mw / met.length > 0.5) out.push({ key: 'h2h', helps: dog, strength: clamp01((mw / met.length - 0.5) * 2 + 0.1), a: mw, n: met.length });
  return out;
}

/** The favourite's stature from its season (win share; tennis: the ranking). */
export function historyStature(x: HistoryInput): number {
  if (x.ranks) { const r = x.ranks[x.fav]; return r ? clamp01(1 - Math.log10(r) / 3) : 0.3; }
  const ko = new Date(x.kickoff).getTime();
  const fs = seasonOf(x.games[x.fav].filter(g => new Date(g.date).getTime() < ko).sort((a, b) => b.date.localeCompare(a.date)), ko);
  return fs.length >= 3 ? clamp01(fs.filter(g => g.won).length / fs.length) : 0.3;
}
