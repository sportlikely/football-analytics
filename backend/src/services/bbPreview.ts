/**
 * Basketball game previews (fix124, Oct 2026), like the football ones (matchPreview.ts, fix121): 100–180 words of
 * plain English per game, written from our own tables only (bb_games, NBA injury reports). Several templates per
 * sentence, picked by game id. NEVER the pick or any percentage — the same text for visitors and crawlers.
 * Kept in memory for 30 minutes per game.
 */
import { BB_LEAGUES } from './basketball';
import { dayMark, timeMark } from '../utils/previewWhen';
import { nbaInjuries } from './bbInjuries';
import { bbGameById, bbLast, bbH2h, bbRecord, bbWl, BbGameRow } from './seoFacts';

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
const pick = <T>(id: number, slot: string, list: T[]): T => list[hash(`bb:${id}:${slot}`) % list.length];
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const num = (n: number) => (n >= 0 && n <= 10 ? ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'][n] : String(n));
const leagueName = (code: string) => BB_LEAGUES.find(l => l.code === code)?.name || code;
const FINAL = "See SportLikely's prediction for this game.";

function formOf(games: BbGameRow[], teamId: number) {
  const seq = games.map(g => bbWl(g, teamId));
  const pf = games.reduce((s, g) => s + (g.homeId === teamId ? g.hs! : g.as_!), 0), pa = games.reduce((s, g) => s + (g.homeId === teamId ? g.as_! : g.hs!), 0);
  return { n: games.length, w: seq.filter(x => x === 'W').length, seq: seq.join('-'), ppg: games.length ? Math.round((pf / games.length) * 10) / 10 : 0, oppg: games.length ? Math.round((pa / games.length) * 10) / 10 : 0 };
}

export function bbPreviewText(g: BbGameRow): string {
  const id = g.id, H = g.home, A = g.away, lg = leagueName(g.code), when = dayMark(g.date); // fix284: the visitor's own day (utils/previewWhen.ts)
  const past = g.status === 'FT' || g.status === 'AOT';
  const parts: { prio: number; text: string }[] = [];
  const add = (prio: number, text: string | null) => { if (text) parts.push({ prio, text }); };

  add(0, past
    ? pick(id, 'intro', [`${H} hosted ${A} on ${when} in the ${lg}.`, `On ${when}, ${A} visited ${H} in the ${lg}.`])
    : pick(id, 'intro', [`${H} host ${A} on ${when} in the ${lg}.`, `On ${when}, ${A} visit ${H} in the ${lg}.`]));
  if (past && g.hs != null && g.as_ != null) add(0, `Final score: ${H} ${g.hs}–${g.as_} ${A}.`);

  // season records
  const rh = bbRecord(g.homeId, g.code, g.season, g.date), ra = bbRecord(g.awayId, g.code, g.season, g.date);
  if (rh.n >= 3 && ra.n >= 3) add(1, pick(id, 'rec', [
    `${H} ${past ? 'were' : 'are'} ${rh.w}-${rh.l} this season and ${A} ${ra.w}-${ra.l}.`,
    `Season records: ${H} ${rh.w}-${rh.l}, ${A} ${ra.w}-${ra.l}.`
  ]));

  // last five
  for (const [T, tid] of [[H, g.homeId], [A, g.awayId]] as const) {
    const f = formOf(bbLast(tid, 5, g.date), tid);
    if (f.n < 3) continue;
    add(1, pick(id, `form-${tid}`, [
      `${T} ${past ? 'had' : 'have'} won ${num(f.w)} of their last ${num(f.n)} (${f.seq}, newest first), scoring ${f.ppg} and allowing ${f.oppg} points a game.`,
      `Over their last ${num(f.n)} games ${T} went ${f.w}-${f.n - f.w}, averaging ${f.ppg} points for and ${f.oppg} against.`
    ]));
  }

  // head-to-head
  const h2h = bbH2h(g.homeId, g.awayId, g.date, 5);
  if (h2h.length) {
    const hw = h2h.filter(x => bbWl(x, g.homeId) === 'W').length;
    const last = h2h[0];
    add(2, pick(id, 'h2h', [
      `In their last ${num(h2h.length)} meetings ${H} won ${num(hw)} and ${A} ${num(h2h.length - hw)}; the most recent ended ${last.home} ${last.hs}–${last.as_} ${last.away}.`,
      `Head-to-head: ${hw}-${h2h.length - hw} for ${H} over the last ${num(h2h.length)} games, most recently ${last.home} ${last.hs}–${last.as_} ${last.away}.`
    ]));
  } else add(3, `This is the first meeting between the two teams in our records.`);

  // rest
  const lastH = bbLast(g.homeId, 1, g.date)[0], lastA = bbLast(g.awayId, 1, g.date)[0];
  const rest = (x?: BbGameRow) => (x ? Math.floor((new Date(g.date).getTime() - new Date(x.date).getTime()) / 86400000) : null);
  const dh = rest(lastH), da = rest(lastA);
  if (dh !== null && da !== null && dh <= 30 && da <= 30) {
    const b2b = [dh <= 1 ? H : null, da <= 1 ? A : null].filter(Boolean) as string[];
    add(2, b2b.length ? `${b2b.join(' and ')} ${b2b.length > 1 ? (past ? 'were both' : 'are both') : past ? 'were' : 'are'} on the second night of a back-to-back.` : `${H} ${past ? 'had' : 'have had'} ${dh} days of rest and ${A} ${da}.`);
  }

  // NBA injury report (names only)
  if (g.code === 'NBA' && !past) {
    const out = (tid: number, name: string) => nbaInjuries(tid, name, g.date).filter(x => /out/i.test(x.status) && (x.minutes || 0) >= 15).slice(0, 3).map(x => x.name);
    const oh = out(g.homeId, H), oa = out(g.awayId, A);
    if (oh.length || oa.length) add(2, [oh.length ? `${H} are without ${oh.join(', ')}` : '', oa.length ? `${A} are missing ${oa.join(', ')}` : ''].filter(Boolean).join(', while ') + '.');
  }

  const fillers = [
    `Tip-off ${past ? 'was' : 'is'} at ${timeMark(g.date)}.`,
    `The game page also covers the point spread, total points, the predicted score, rest days and key players.`,
    `Every SportLikely prediction is saved before tip-off and checked against the result afterwards.`,
    `The numbers in this preview come from our own records of the games we cover.`
  ];
  let i = 0;
  const all = () => [...parts.map(p => p.text), FINAL].join(' ');
  while (words(all()) < 100 && i < fillers.length) parts.push({ prio: 5, text: fillers[i++] });
  while (words(all()) > 180) {
    const drop = parts.filter(p => p.prio > 0).sort((a, b) => b.prio - a.prio)[0];
    if (!drop) break;
    parts.splice(parts.indexOf(drop), 1);
  }
  return all();
}

const cache = new Map<number, { at: number; text: string; ttl?: number }>();
/** Preview of a basketball game by id (cached 30 min), or null when the game is unknown. */
export function bbPreview(id: number): string | null {
  const c = cache.get(id);
  if (c && Date.now() - c.at < (c.ttl ?? 30 * 60 * 1000)) return c.text;
  const g = bbGameById(id);
  if (!g) return null;
  const text = bbPreviewText(g);
  // fix196: a game finished more than 2 days ago never changes: 24 h (search engines read old games again and again)
  const old = (g.status === 'FT' || g.status === 'AOT') && Date.parse(g.date) < Date.now() - 2 * 86400000;
  cache.set(id, { at: Date.now(), text, ttl: old ? 24 * 3600 * 1000 : 30 * 60 * 1000 });
  if (cache.size > 3000) for (const [k, v] of cache) if (Date.now() - v.at > (v.ttl ?? 30 * 60 * 1000)) cache.delete(k);
  if (cache.size > 6000) cache.delete(cache.keys().next().value as number);
  return text;
}
