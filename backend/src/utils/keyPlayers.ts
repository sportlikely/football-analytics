/**
 * fix224 — key players, the pure part (no database): who matters most in a team (player impact × expected minutes),
 * what the team loses without him, star-rest patterns (NBA back-to-backs / 3-in-4s, EuroLeague double weeks) and the
 * news parser that turns "X is out for three weeks (knee)" into a "reported out" status. Used by services/keyPlayers.ts
 * and the tests (scripts/key-players.test.mjs).
 */
import { rotation, strength, type RotPlayer } from './nbaImpact';

const DAY = 86400000;

/* ---------- key players ---------- */

/** One rotation player of a team: rating = points of margin per L minutes against an average player, proj = minutes. */
export type KpIn = { id: number; rating: number; proj: number };
export type KpOut = { id: number; rating: number; proj: number; perGame: number; without: number; cost: number; keep: number };

/**
 * The team's top players by impact × expected minutes (rating × proj), at most `n`. For each: his impact in points per
 * game (rating × proj / L), what the team's strength loses without him (`without`: the rotation is re-filled, scaled
 * by `scale` = the model's points per strength point) and what his status costs in this game (`cost`: the strength
 * with everyone's statuses but his against all of them).
 */
export function keyList(players: KpIn[], keep: Map<number, number>, L: number, scale: number, n = 5): KpOut[] {
  const pl: RotPlayer[] = players.filter(p => p.proj > 0).map(p => ({ id: p.id, min: p.proj, rating: p.rating }));
  const S = (k?: Map<number, number>) => strength(rotation(pl, k, L), L);
  const full = S(), now = S(keep);
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return [...players].filter(p => p.proj > 0).sort((a, b) => b.rating * b.proj - a.rating * a.proj || a.id - b.id).slice(0, n).map(p => {
    const without = full - S(new Map([[p.id, 0]]));
    const k = keep.has(p.id) ? keep.get(p.id)! : 1;
    let cost = 0;
    if (k < 1) { const others = new Map(keep); others.delete(p.id); cost = S(others) - now; }
    return { id: p.id, rating: r1(p.rating), proj: r1(p.proj), perGame: r1((p.rating * p.proj) / L), without: r1(-scale * without) || 0, cost: r1(-scale * cost) || 0, keep: k };
  });
}

/** Strength lost to missing players (row #4): strength with `keep` minus strength with everyone. */
export function missOf(players: KpIn[], keep: Map<number, number>, L: number): number {
  const pl: RotPlayer[] = players.filter(p => p.proj > 0).map(p => ({ id: p.id, min: p.proj, rating: p.rating }));
  return strength(rotation(pl, keep, L), L) - strength(rotation(pl, undefined, L), L);
}

/* ---------- star rest patterns ---------- */

export type RestKind = 'b2b' | '3in4' | 'el-double';
/** One team game: kick-off (ms), competition code, minutes per player (only players who played). */
export type TeamGame = { id: number; ms: number; code: string; min: Map<number, number> };
export type RestCount = { sat: number; chances: number };
/** A rate is used only with this many resolved chances and at least this share. */
export const REST_MIN_CHANCES: Record<RestKind, number> = { b2b: 4, '3in4': 4, 'el-double': 3 };
/**
 * Walk-forward check (10 Oct snapshot, each chance priced from earlier games only; settings chosen on 2024-25, confirmed
 * on 2025-26+): Brier of "he plays" NBA 0.0679 → 0.0658, EuroLeague clubs 0.1312 → 0.1233; flagged players sat 22–23%
 * against 23% predicted (all chances: 6.8% / 13.1%). +1 instead of +3 and a 20% floor: 0.0659 / 0.1263, over-predicted (28%).
 */
export const REST_MIN_RATE = 0.15;
export const REST_SHRINK = 3;
/** A rotation player: this many minutes a game over his last 10 games played … */
const ROT_MIN: Record<RestKind, number> = { b2b: 20, '3in4': 20, 'el-double': 15 };

/** The kind of schedule spot a team's game is in (NBA): second night of a back-to-back, else third game in 4 days. */
export function nbaSpot(ms: number, prev: number[]): RestKind | null {
  const p = [...prev].filter(x => x < ms - 3 * 3600 * 1000).sort((a, b) => b - a);
  if (p[0] !== undefined && ms - p[0] < 1.4 * DAY) return 'b2b';
  if (p[1] !== undefined && ms - p[1] <= 3.5 * DAY) return '3in4';
  return null;
}

/**
 * NBA: per player, how often he sat the second night of a back-to-back / the third game in 4 days. A chance counts only
 * when it is resolved: he played the night before and either played this game (not rested) or sat it and played the
 * team's next game (rested — sitting the next one too looks like an injury, not rest).
 */
export function nbaRestCounts(games: TeamGame[]): Map<number, Partial<Record<RestKind, RestCount>>> {
  const out = new Map<number, Partial<Record<RestKind, RestCount>>>();
  const gs = [...games].sort((a, b) => a.ms - b.ms);
  for (let i = 1; i < gs.length; i++) {
    const kind = nbaSpot(gs[i].ms, gs.slice(Math.max(0, i - 2), i).map(g => g.ms));
    if (!kind) continue;
    const next = gs[i + 1];
    for (const [pid, m] of gs[i - 1].min) {
      if (!(m > 0) || !isRotation(gs, i, pid, ROT_MIN[kind])) continue;
      const played = (gs[i].min.get(pid) || 0) > 0;
      if (!played && !(next && (next.min.get(pid) || 0) > 0)) continue; // unresolved or an injury
      const c = bump(out, pid, kind);
      c.chances++; if (!played) c.sat++;
    }
  }
  return out;
}

/** Monday-based week number (epoch day 0 was a Thursday). */
export const weekOf = (ms: number) => Math.floor((Math.floor(ms / DAY) + 3) / 7);

/**
 * EuroLeague clubs: per player, how often he sat a domestic game in a week with two EuroLeague games. A chance = a
 * domestic game in such a week by a player who played 15+ minutes in one of that week's EuroLeague games; resolved as
 * rested only when he played the club's next game (else it looks like an injury).
 */
export function elRestCounts(games: TeamGame[], elCode = 'EL'): Map<number, Partial<Record<RestKind, RestCount>>> {
  const out = new Map<number, Partial<Record<RestKind, RestCount>>>();
  const gs = [...games].sort((a, b) => a.ms - b.ms);
  const elByWeek = new Map<number, TeamGame[]>();
  for (const g of gs) if (g.code === elCode) { const w = weekOf(g.ms); let l = elByWeek.get(w); if (!l) elByWeek.set(w, (l = [])); l.push(g); }
  gs.forEach((g, i) => {
    if (g.code === elCode) return;
    const el = elByWeek.get(weekOf(g.ms));
    if (!el || el.length < 2) return;
    const next = gs[i + 1];
    const rot = new Set<number>();
    for (const e of el) for (const [pid, m] of e.min) if (m >= ROT_MIN['el-double']) rot.add(pid);
    for (const pid of rot) {
      const played = (g.min.get(pid) || 0) > 0;
      if (!played && !(next && (next.min.get(pid) || 0) > 0)) continue;
      const c = bump(out, pid, 'el-double');
      c.chances++; if (!played) c.sat++;
    }
  });
  return out;
}

function isRotation(gs: TeamGame[], i: number, pid: number, minAvg: number): boolean {
  const last = gs.slice(Math.max(0, i - 10), i);
  const mins = last.map(g => g.min.get(pid) || 0).filter(m => m > 0);
  return mins.length >= Math.min(5, last.length) && mins.reduce((a, b) => a + b, 0) / mins.length >= minAvg;
}
function bump(out: Map<number, Partial<Record<RestKind, RestCount>>>, pid: number, kind: RestKind): RestCount {
  let x = out.get(pid); if (!x) out.set(pid, (x = {}));
  return (x[kind] ||= { sat: 0, chances: 0 });
}

/**
 * The share of minutes a player keeps in a game that fits his pattern (1 = no reduction: too few chances or rare).
 * The rate counts three extra games played, so a short record never makes him certain to sit (sat 4 of 4 → 4/7: keeps 43%).
 */
export function restKeep(kind: RestKind, c: RestCount | undefined): number {
  if (!c || c.chances < REST_MIN_CHANCES[kind]) return 1;
  const rate = c.sat / (c.chances + REST_SHRINK);
  return rate >= REST_MIN_RATE ? Math.round((1 - rate) * 100) / 100 : 1;
}

/* ---------- injuries from news ---------- */

export type NewsInjury = { status: 'out' | 'doubtful'; days: number; injury: string | null };

const NUM: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, 'a couple of': 2, 'a few': 3, several: 4 };
const UNIT: Record<string, number> = { day: 1, week: 7, month: 30, game: 3.5 };
const NUM_RE = '(\\d+|a couple of|a few|several|one|two|three|four|five|six|seven|eight|nine|ten|twelve|an?)';
const DUR = new RegExp(`\\b${NUM_RE}(?:\\s*(?:-|to|or)\\s*${NUM_RE})?[\\s-]+(day|week|month|game)s?\\b`, 'g');
const DUR_ANY = new RegExp(`${DUR.source}|\\b(rest of the season|for the season|season-ending|season ending|indefinitely|long-term|long term)\\b`);
/** a sentence saying he is fine, back or that the story is something else */
const NEG = /\b(return(s|ed|ing)?|back (in|to|from|on)|comeback|cleared|recovered|fit again|is fit|fit to play|available (again|for)|no longer|not (be )?(out|injured|sidelined|serious)|avoids?|avoided|escaped|ruled in|rumou?rs?|denie[sd]|deny|will play|expected to play|set to play|to play|probable|false alarm|no serious|signs?|signed|signing|contract|extension|award|mvp|loan|transfer|trade[sd]?|suspended|suspension|banned|fined)\b/;
/** an absence word */
const ABSENT = /\b(ruled out|will miss|to miss|miss(es|ing)?|out (for|with|until|after|indefinitely|again)|is out|are out|remains? out|sidelined|side-lined|unavailable|absent|surgery|operated|doubtful|questionable|in doubt|game-time decision|uncertain)\b/;
/** an injury word (an absence word alone, "misses the trip", is not enough) */
const HURT = /\b(injur(y|ies|ed)|surgery|operated|torn|tear|ruptur(e|ed)|fracture[ds]?|broken|sprain(ed)?|strain(ed)?|knee|ankle|hamstring|achilles|calf|groin|shoulder|foot|hand|wrist|finger|thumb|hip|concussion|illness|ill|thigh|elbow|toe|quad|adductor|muscle|back (injury|problem|spasms|pain)|setback|physical problem|discomfort)\b/;
const DOUBT = /\b(doubtful|questionable|in doubt|game-time decision|uncertain)\b/;
const PART = /\b(knee|ankle|hamstring|achilles|calf|groin|shoulder|foot|hand|wrist|finger|thumb|hip|concussion|illness|thigh|elbow|toe|quad|adductor|back)\b/;

export const normText = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’`]/g, "'").toLowerCase();

/** One sentence → an injury status, or null (no injury, or a sentence that says he is back / fine / something else). */
export function parseInjury(sentence: string): NewsInjury | null {
  const s = normText(sentence);
  if (NEG.test(s) || !ABSENT.test(s) || !HURT.test(s)) return null;
  // "surgery" alone (no other absence word, no time out) is often an old operation or a dispute about one
  if (!DUR_ANY.test(s) && !ABSENT.test(s.replace(/\b(surgery|operated)\b/g, ' '))) return null;
  const status: NewsInjury['status'] = DOUBT.test(s) && !/\b(ruled out|will miss|out for|sidelined|surgery)\b/.test(s) ? 'doubtful' : 'out';
  let days = 0;
  for (const m of s.matchAll(DUR)) {
    const n = Math.max(NUM[m[1]] ?? Number(m[1]), m[2] ? NUM[m[2]] ?? Number(m[2]) : 0);
    if (Number.isFinite(n) && n > 0 && n < 400) days = Math.max(days, n * UNIT[m[3]]);
  }
  if (/\b(rest of the season|for the season|season-ending|season ending|out for the year)\b/.test(s)) days = Math.max(days, 150);
  else if (/\b(indefinitely|long-term|long term)\b/.test(s)) days = Math.max(days, 60);
  if (!days) days = status === 'out' ? 7 : 3;
  const part = s.match(PART);
  return { status, days: Math.round(days), injury: part ? part[1] : null };
}

/** Split a story into sentences (title first). */
export function sentencesOf(title: string, summary: string): string[] {
  return [title, ...String(summary || '').split(/(?<=[.!?])\s+(?=[A-ZÀ-ɏ"'])/)].map(x => x.trim()).filter(x => x.length >= 12);
}

const tokens = (name: string) => normText(name).replace(/[^a-z' -]/g, ' ').split(/[\s-]+/).filter(Boolean);
const hasWord = (text: string, w: string) => new RegExp(`(?<![a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z])`).test(text);

/**
 * Roster players named in a sentence: every part of the name (any order: providers write "Surname Firstname"), or a
 * surname-like part (5+ letters, used by no one else on the roster, not part of the club's names) when the story names
 * the club.
 */
export function namedPlayers(sentence: string, roster: { id: number; name: string }[], clubNamed: boolean, clubWords: string[] = []): number[] {
  const s = normText(sentence);
  const club = new Set(clubWords.flatMap(tokens));
  const count = new Map<string, number>();
  for (const p of roster) for (const w of new Set(tokens(p.name))) count.set(w, (count.get(w) || 0) + 1);
  const out: number[] = [];
  for (const p of roster) {
    const ws = tokens(p.name).filter(w => w.length >= 2 && !/^[a-z]\.?$/.test(w));
    if (!ws.length) continue;
    if (ws.length >= 2 && ws.every(w => hasWord(s, w))) { out.push(p.id); continue; }
    if (clubNamed && ws.some(w => w.length >= 5 && count.get(w) === 1 && !club.has(w) && hasWord(s, w))) out.push(p.id);
  }
  return out;
}

/** A story → the roster players it reports injured (one entry per player: the longest absence wins). */
export function scanStory(title: string, summary: string, roster: { id: number; name: string }[], clubNames: string[]): { playerId: number; sentence: string; inj: NewsInjury }[] {
  const all = normText(`${title} . ${summary}`);
  const clubNamed = clubNames.some(n => n.length >= 3 && hasWord(all, normText(n)));
  const by = new Map<number, { playerId: number; sentence: string; inj: NewsInjury }>();
  for (const sen of sentencesOf(title, summary)) {
    const inj = parseInjury(sen);
    if (!inj) continue;
    for (const id of namedPlayers(sen, roster, clubNamed, clubNames)) {
      const cur = by.get(id);
      if (!cur || inj.days > cur.inj.days) by.set(id, { playerId: id, sentence: sen.slice(0, 300), inj });
    }
  }
  return [...by.values()];
}
