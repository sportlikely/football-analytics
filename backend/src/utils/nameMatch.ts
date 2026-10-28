/**
 * fix264 — name matching shared by the twin finder (Football-Data.org ↔ API-Football teams) and the top-scorer check
 * (Football-Data.org's scorer list ↔ API-Football players). Pure: no database, no network.
 */

/** letters NFD does not split (ø, æ, ß, ł, đ, ı …) → plain ASCII, so "Bodø" = "Bodo" */
const FOLD: Record<string, string> = { 'ø': 'o', 'æ': 'ae', 'œ': 'oe', 'ß': 'ss', 'ł': 'l', 'đ': 'd', 'ð': 'd', 'þ': 'th', 'ı': 'i', 'ħ': 'h' };
export const fold = (s: string) => String(s || '').toLowerCase().replace(/[øæœßłđðþıħ]/g, c => FOLD[c]).normalize('NFD').replace(/[̀-ͯ]/g, '');

const CLUB_WORDS = ['fc', 'cf', 'afc', 'sc', 'ac', 'as', 'ssc', 'sv', 'club', 'de', 'cp', 'fk'];
/** a team name as a key: lower case, no accents, no club words ("FK Bodø/Glimt" → "bodo glimt") */
export function teamKey(s: string) {
  return fold(s).replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w && !CLUB_WORDS.includes(w)).join(' ');
}

const bigrams = (s: string) => { const t = s.replace(/ /g, ''); const out: string[] = []; for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2)); return out; };
/** how alike two team names are, 0–1: the better of letter pairs (Dice) and shared words */
export function teamSimilarity(a: string, b: string) {
  const x = teamKey(a), y = teamKey(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const bx = bigrams(x), by = bigrams(y);
  const pool = new Map<string, number>();
  for (const g of by) pool.set(g, (pool.get(g) || 0) + 1);
  let common = 0;
  for (const g of bx) { const n = pool.get(g) || 0; if (n) { common++; pool.set(g, n - 1); } }
  const dice = bx.length + by.length ? (2 * common) / (bx.length + by.length) : 0;
  const wx = x.split(' ').filter(w => w.length >= 3), wy = new Set(y.split(' ').filter(w => w.length >= 3));
  const shared = wx.filter(w => wy.has(w)).length;
  const words = wx.length && wy.size ? shared / Math.min(wx.length, wy.size) : 0;
  return Math.max(dice, words * 0.9);
}

export interface TwinCand { id: number; home: string; away: string; kickoff: string; sameHome?: boolean; sameAway?: boolean }
export interface TwinProposal { id: number; home: string; away: string; score: number; homeScore: number; awayScore: number; minutes: number }
export const ALIAS_RULES = { minScore: 0.6, minSide: 0.4, margin: 0.2, maxMinutes: 15 };
/**
 * fix264: the other provider's game for a game without a twin — fuzzy on both names + kick-off. `sameHome` / `sameAway`
 * = the name already matches by key or alias (counts 1). `apply` only when the score is unambiguous: the best ≥ 0.6,
 * each side ≥ 0.4, kick-off within 15 min and 0.2 ahead of the next candidate; else it is only listed.
 */
export function proposeTwin(game: { home: string; away: string; kickoff: string }, cands: TwinCand[]): { best: TwinProposal | null; second: TwinProposal | null; apply: boolean } {
  const ko = Date.parse(game.kickoff);
  const scored = cands.map(c => {
    const homeScore = c.sameHome ? 1 : teamSimilarity(game.home, c.home), awayScore = c.sameAway ? 1 : teamSimilarity(game.away, c.away);
    const minutes = Math.round(Math.abs(Date.parse(c.kickoff) - ko) / 60000);
    return { id: c.id, home: c.home, away: c.away, homeScore, awayScore, minutes, score: (homeScore + awayScore) / 2 - Math.min(minutes, 180) / 1800 };
  }).sort((a, b) => b.score - a.score);
  const [best = null, second = null] = scored;
  const R = ALIAS_RULES;
  const apply = !!best && best.score >= R.minScore && Math.min(best.homeScore, best.awayScore) >= R.minSide && best.minutes <= R.maxMinutes
    && (!second || best.score - second.score >= R.margin);
  return { best, second, apply };
}

/* ---------- players ---------- */

/** a player name as words: no accents, hyphens split ("Marcus Thuram-Ulien" → "marcus thuram ulien") */
export const plainName = (s: string) => fold(s).replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Two spellings of one player's name. `loose` (only inside one club or league, fix264): the same first name and every
 * word of the shorter name in the longer one — "Marcus Thuram" = "Marcus Thuram-Ulien", "Pau Víctor" = "Pau Victor Delgado".
 */
export function samePlayerName(a: string, b: string, loose = false) {
  const pa = plainName(a), pb = plainName(b);
  if (!pa || !pb) return false;
  if (pa === pb) return true;
  const x = pa.split(' '), y = pb.split(' ');
  const lx = x[x.length - 1], ly = y[y.length - 1];
  // one name only ("Zabiri", "Pedri"): the other's surname or first name
  if (x.length === 1 || y.length === 1) {
    const one = x.length === 1 ? x[0] : y[0], other = x.length === 1 ? y : x;
    return one.length >= 4 && (other[other.length - 1] === one || other[0] === one);
  }
  // "E. Haaland" vs "Erling Haaland"; "Vinícius Júnior" vs "Vinicius Junior"
  if (lx === ly && x[0][0] === y[0][0]) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  // a middle name used as the first name: "Yassir Zabiri" vs "Mohamed Yassir Zabiri"
  if (lx === ly) return short.slice(0, -1).every(w => w.length >= 3 && long.includes(w));
  // fix264: a second surname or a hyphenated one left out
  if (loose && x[0] === y[0] && x[0].length >= 3 && short.every(w => long.includes(w))) return true;
  return false;
}

/** fix264: the words to search the provider by — the last word, and for "Thuram-Ulien" / "Victor Delgado" the one before */
export function nameSearchTerms(name: string): string[] {
  const w = plainName(name).split(' ').filter(Boolean);
  if (w.length < 2) return w.filter(x => x.length >= 4);
  return [...new Set([w[w.length - 1], w[w.length - 2]])].filter(x => x.length >= 4 && x !== w[0]).slice(0, 2);
}
