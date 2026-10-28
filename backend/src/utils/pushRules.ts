/**
 * fix226: the push alert rules, pure (no database): what changed in a game between two readings (start, score, final,
 * upset), quiet hours in the person's own time zone, and the words of a notification. services/pushAlerts.ts reads
 * the games (every sport through one snapshot shape) and the people; scripts/push-alerts.test.mjs tests these.
 *
 * Events, one key per game (the dedupe key — an event is stored once, and a person gets it at most once):
 *   start          15 min before kick-off / tip-off / first serve
 *   score:<h>-<a>  football: a goal (the total went up; a disallowed goal sends nothing)
 *   end:<q>        basketball / American football: a quarter ended (5 = overtime); the last one is the final
 *   lead:<h>-<a>   basketball / American football: the lead changed hands in the last 3 minutes
 *   set:<h>-<a>    tennis: a set was won (the last one is the final)
 *   final          the game finished (+ our pick right / wrong)
 *   upset          Pro: our outsider (20–45% before the game, the upset-watch rule) is ahead late
 */
import { doubleChance, dcHit, type DC } from './doubleChance';
import { watchOf } from '../services/upsetAlerts'; // fix188: one upset-watch rule in every sport

export const PUSH_SPORTS = ['football', 'basketball', 'american-football', 'tennis'] as const;
export type PSport = (typeof PUSH_SPORTS)[number];
export const PUSH_KINDS = ['start', 'score', 'final', 'upset'] as const;
export type PKind = (typeof PUSH_KINDS)[number];

export type Pick = { k: DC } | { side: 'H' | 'A' };
export interface Snap {
  sport: PSport; id: number; rid: number
  state: 'pre' | 'live' | 'done' | 'off'
  start: string; league: string; home: string; away: string; teamIds: number[]; path: string
  hs: number | null; as: number | null
  /** basketball / American football: the quarter being played or just played (5 = overtime) */
  period: number | null
  /** between quarters / half-time */
  brk: boolean
  /** football minute, or minutes left in the quarter (basketball / American football) */
  minute: number | null
  /** the last 3 minutes of a basketball / American football game, football 70'+, tennis one set from the end */
  late: boolean
  /** tennis: sets won and the games of the last set */
  sets: [number, number] | null; lastSet: [number, number] | null
  /** pre-game chances in % (football home / draw / away; the winner sports draw 0) */
  pre: { ph: number; pd: number; pa: number } | null
  /** who won (done) */
  winner: 'H' | 'D' | 'A' | null
  /** the side that led last (carried over between readings, for lead changes) */
  lastLead: 'H' | 'A' | null
}

export interface PEvent { sport: PSport; gameId: number; kind: PKind; key: string; snap: Snap; /** tennis: who won the set */ side?: 'H' | 'A' }

const MIN = 60000;
const leader = (s: Snap): 'H' | 'A' | null => (s.hs == null || s.as == null || s.hs === s.as ? null : s.hs > s.as ? 'H' : 'A');
const setLeader = (s: Snap): 'H' | 'A' | null => (!s.sets || s.sets[0] === s.sets[1] ? null : s.sets[0] > s.sets[1] ? 'H' : 'A');

/** Our pick from the pre-game chances: football the double chance, the other sports the winner. */
export function pickOf(s: Snap): { pick: Pick; pct: number } | null {
  if (!s.pre) return null;
  if (s.sport === 'football') {
    const dc = doubleChance(s.pre.ph, s.pre.pd, s.pre.pa);
    return dc ? { pick: { k: dc.k }, pct: Math.round(dc.p) } : null;
  }
  return { pick: { side: s.pre.ph >= s.pre.pa ? 'H' : 'A' }, pct: Math.round(Math.max(s.pre.ph, s.pre.pa)) };
}
/** Was our pick right? null = no pick or no result. */
export function pickRight(s: Snap): boolean | null {
  const p = pickOf(s);
  if (!p || !s.winner) return null;
  if ('k' in p.pick) return dcHit(p.pick.k, s.winner);
  return s.winner === p.pick.side;
}
/** The outsider, when the game makes the upset-watch cut (20–45%, 10+ points behind). */
export function outsiderOf(s: Snap): 'H' | 'A' | null {
  if (!s.pre) return null;
  return watchOf(s.pre.ph, s.pre.pd, s.pre.pa)?.underdog ?? null;
}

/** The side that led last, carried from the previous reading. */
export const withLead = (cur: Snap, prev: Snap | null): Snap => ({ ...cur, lastLead: (cur.sport === 'tennis' ? setLeader(cur) : leader(cur)) ?? prev?.lastLead ?? null });

/**
 * The events between two readings of a game. `prev` null = first reading (nothing but "starting" is sent: a game seen
 * for the first time mid-way — a restart, a new window — never sends its old goals or a late final).
 */
export function eventsOf(prev: Snap | null, curIn: Snap, now: number): PEvent[] {
  const cur = withLead(curIn, prev);
  const out: PEvent[] = [];
  const ev = (kind: PKind, key: string, side?: 'H' | 'A') => out.push({ sport: cur.sport, gameId: cur.id, kind, key, snap: cur, ...(side ? { side } : {}) });
  const t0 = Date.parse(cur.start);
  if (cur.state === 'pre' && now >= t0 - 15 * MIN && now < t0 + 2 * MIN) ev('start', 'start');
  if (!prev || prev.state === 'off') return out;
  if (cur.state === 'live' && (prev.state === 'live' || prev.state === 'pre')) {
    if (cur.sport === 'football') {
      const before = prev.state === 'pre' ? 0 : (prev.hs ?? 0) + (prev.as ?? 0);
      if ((cur.hs ?? 0) + (cur.as ?? 0) > before) ev('score', `score:${cur.hs ?? 0}-${cur.as ?? 0}`);
    } else if (cur.sport === 'tennis') {
      const was = prev.state === 'pre' || !prev.sets ? [0, 0] : prev.sets;
      if (cur.sets && cur.sets[0] + cur.sets[1] > was[0] + was[1]) ev('score', `set:${cur.sets[0]}-${cur.sets[1]}`, cur.sets[0] > was[0] ? 'H' : 'A');
    } else {
      if (prev.state === 'live' && prev.period != null && !prev.brk && (cur.brk || (cur.period ?? 0) > prev.period)) ev('score', `end:${prev.period}`);
      const l = leader(cur);
      if (cur.late && prev.state === 'live' && l && prev.lastLead && l !== prev.lastLead) ev('score', `lead:${cur.hs}-${cur.as}`);
    }
    const o = outsiderOf(cur);
    if (o && cur.late && (cur.sport === 'tennis' ? setLeader(cur) : leader(cur)) === o) ev('upset', 'upset');
  }
  if (cur.state === 'done' && prev.state !== 'done' && now - t0 < 10 * 3600 * 1000) ev('final', 'final');
  return out;
}

/* ---------- time zones and quiet hours ---------- */

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function partsIn(tz: string, t: number) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    if (fmtCache.size > 500) fmtCache.clear();
    fmtCache.set(tz, f);
  }
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(t))) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, hour: +p.hour % 24, minute: +p.minute };
}
export const validTz = (tz: unknown): tz is string => {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return true; } catch { return false; }
};
/** The local hour (0–23) of an instant. */
export const localHour = (tz: string, t: number) => partsIn(tz, t).hour;
/** Quiet hours from → to (local hours; from = to = no quiet hours). 00 → 07 = midnight to 7 in the morning. */
export function inQuiet(q: { from: number; to: number; tz: string }, t: number): boolean {
  if (q.from === q.to) return false;
  const h = localHour(q.tz, t);
  return q.from < q.to ? h >= q.from && h < q.to : h >= q.from || h < q.to;
}
/** When the quiet hours around `t` end (the next local `to`:00, DST-safe); `t` itself when not quiet. */
export function quietEnd(q: { from: number; to: number; tz: string }, t: number): number {
  if (!inQuiet(q, t)) return t;
  // walk forward to the first instant outside (at most a day), then back to the hour
  let x = t;
  for (let i = 0; i < 26 && inQuiet(q, x); i++) x += 3600 * 1000;
  const p = partsIn(q.tz, x);
  return x - p.minute * MIN - (x % MIN);
}

/* ---------- words ---------- */

export type Tx = (key: string, ...a: (string | number)[]) => string;
const LOCALES: Record<string, string> = { en: 'en-GB', de: 'de-DE', es: 'es-ES', fr: 'fr-FR', it: 'it-IT', pt: 'pt-BR', tr: 'tr-TR', id: 'id-ID', hi: 'hi-IN', pl: 'pl-PL', el: 'el-GR', ru: 'ru-RU' };
export function timeIn(lang: string, tz: string, iso: string): string {
  try { return new Intl.DateTimeFormat(LOCALES[lang] || 'en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(new Date(iso)); } catch { return iso.slice(11, 16); }
}
export function pickWords(tx: Tx, s: Snap, p: Pick): string {
  if ('k' in p) return p.k === '1X' ? tx('{0} or draw', s.home) : p.k === 'X2' ? tx('{0} or draw', s.away) : tx('{0} or {1}', s.home, s.away);
  return tx('{0} to win', p.side === 'H' ? s.home : s.away);
}
const score = (s: Snap) => `${s.home} ${s.hs ?? 0}–${s.as ?? 0} ${s.away}`;
const sets = (s: Snap) => `${s.home} ${s.sets?.[0] ?? 0}–${s.sets?.[1] ?? 0} ${s.away}`;

export interface Note { title: string; body: string }
/**
 * The notification for one person. `showPick`: the pick may be shown before the game (Pro / admins, or a game they
 * unlocked); the final always shows it with right / wrong (finished games are open to everyone); the upset alert is
 * only made for Pro.
 */
export function noteOf(e: PEvent, o: { tx: Tx; lang: string; tz: string; showPick: boolean }): Note {
  const { tx } = o, s = e.snap;
  const p = pickOf(s);
  if (e.kind === 'start') {
    const title = tx('{0} – {1} starts at {2}', s.home, s.away, timeIn(o.lang, o.tz, s.start));
    const body = p && o.showPick ? tx('{0} · Our pick: {1} · {2}%', s.league, pickWords(tx, s, p.pick), p.pct) : p ? tx('{0} · Unlock the game to see our pick', s.league) : s.league;
    return { title, body };
  }
  if (e.kind === 'score') {
    if (e.key.startsWith('score:')) return { title: tx('Goal! {0}', score(s)), body: s.minute != null ? `${s.minute}' · ${s.league}` : s.league };
    if (e.key.startsWith('set:')) {
      const by = e.side === 'A' ? s.away : s.home;
      return { title: tx('Set won by {0}', by), body: tx('Sets: {0}', sets(s)) + (s.lastSet ? ` · ${s.lastSet[0]}–${s.lastSet[1]}` : '') + ` · ${s.league}` };
    }
    if (e.key.startsWith('end:')) {
      const q = Number(e.key.split(':')[1]);
      return { title: q >= 5 ? tx('End of overtime: {0}', score(s)) : tx('End of Q{0}: {1}', q, score(s)), body: s.league };
    }
    const by = leader(s) === 'H' ? s.home : s.away;
    const left = s.minute != null ? tx('{0} min left', s.minute) : '';
    return { title: tx('Lead change: {0}', score(s)), body: [tx('{0} ahead', by), left, s.league].filter(Boolean).join(' · ') };
  }
  if (e.kind === 'final') {
    const right = pickRight(s);
    const line = s.sport === 'tennis' ? sets(s) : score(s);
    const body = p && right !== null ? (right ? tx('Our pick ({0}) was right ✓', pickWords(tx, s, p.pick)) : tx('Our pick ({0}) was wrong', pickWords(tx, s, p.pick))) : s.league;
    return { title: tx('Final: {0}', line), body };
  }
  // upset
  const side = outsiderOf(s);
  const name = side === 'A' ? s.away : s.home;
  const chance = s.pre ? Math.round(side === 'A' ? s.pre.pa : s.pre.ph) : 0;
  return { title: tx('Upset watch: {0}', s.sport === 'tennis' ? sets(s) : score(s)), body: tx('{0} is ahead. Before the game we gave them {1}%.', name, chance) };
}
