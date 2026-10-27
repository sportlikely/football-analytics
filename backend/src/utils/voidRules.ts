/**
 * fix200: what happens to a football game that is past kick-off + 48 h with no final score (pure rules, no database:
 * services/unsettled.ts asks the provider and applies the answer; scripts/void-rules.test.ts tests these).
 *
 *  1. Ask the provider by fixture id; nothing back, or a different date → by the two teams within ±3 days.
 *  2. Found with a final score → settle normally.
 *     Found postponed / cancelled / abandoned / suspended → the new kick-off when the provider gives a later one, else void.
 *     Found as a later date (moved without a status) → the new kick-off.
 *  3. Not found (or found but still not started / not final) → one attempt per UTC day; after 3 attempts on 3
 *     different days → void.
 *
 * fix240 (Slovan Liberec – Baník Ostrava, Morton – Ayr, 24 Oct: still unsettled 50 h later, data health red): the
 * lookups start at kick-off + 24 h (both providers, the other provider's twin too), and a game the providers still have
 * no answer for at 48 h is no longer voided by itself after 3 days: it goes to Admin → Needs you with "Enter result" /
 * "Void" (and keeps being looked up — a final that shows up later settles it and closes the item).
 *
 * fix253 (Yarin: "I want you to do it all"): still no final 7 days after kick-off → void by itself (out of the record), listed
 * in Admin → Done for you with Undo; an undone void is held (`hold`): looked up again, never voided by itself again.
 *
 * Void = the prediction is out of every accuracy number, hidden from results pages and the users' history, shown in
 * admin with the reason. Never a loss.
 */
export const REFETCH_AFTER_MS = 24 * 3600 * 1000;
export const VOID_AFTER_MS = 48 * 3600 * 1000;
/** fix240: kick-off + 48 h with no answer → Needs you */
export const REVIEW_AFTER_MS = VOID_AFTER_MS;
export const VOID_ATTEMPTS = 3;
/** fix253: no final this long after kick-off → void automatically */
export const AUTO_VOID_AFTER_MS = 7 * 24 * 3600 * 1000;
export const TEAM_WINDOW_DAYS = 3;

/** What the provider said about the game (null = nothing found by id or by teams). */
export type Lookup =
  | { kind: 'final'; home: number; away: number; raw: string; via: 'id' | 'teams' | 'twin'; id?: number }
  | { kind: 'off'; raw: string; date: string | null; via: 'id' | 'teams' | 'twin'; id?: number }
  | { kind: 'open'; raw: string; date: string | null; via: 'id' | 'teams' | 'twin'; id?: number }
  | null;

export type Decision =
  | { action: 'settle'; home: number; away: number; raw: string; note: string }
  | { action: 'move'; date: string; note: string }
  | { action: 'void'; reason: string }
  | { action: 'retry'; attempts: number; note: string }
  | { action: 'review'; attempts: number; note: string }
  | { action: 'wait'; note: string };

/** The provider's status of a fixture → the kind used above (API-Football short codes and Football-Data.org names). */
export function kindOfStatus(raw: string): 'final' | 'off' | 'open' {
  const s = String(raw || '').toUpperCase();
  if (['FT', 'AET', 'PEN', 'FINISHED', 'AWARDED', 'AWD', 'WO'].includes(s)) return 'final';
  if (['PST', 'CANC', 'ABD', 'SUSP', 'INT', 'POSTPONED', 'CANCELLED', 'SUSPENDED'].includes(s)) return 'off';
  return 'open';
}

/** Same day (UTC) as our kick-off? A fixture id answer on another date is not trusted on its own (rule 1). */
export const sameDay = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.slice(0, 10) === b.slice(0, 10);

/**
 * The decision for one game.
 * `kickoff` = our stored kick-off; `attempts` / `lastDay` = earlier failed attempts (lastDay = UTC day of the last one);
 * `now` = ms. A game younger than kick-off + 24 h waits (the normal settle job handles it).
 */
export function decide(found: Lookup, o: { kickoff: string; attempts: number; lastDay: string | null; now: number; hold?: boolean }): Decision {
  const ko = Date.parse(o.kickoff);
  if (!(o.now - ko >= REFETCH_AFTER_MS)) return { action: 'wait', note: 'less than 24 h after kick-off' };
  const today = new Date(o.now).toISOString().slice(0, 10);
  if (found && found.kind === 'final') return { action: 'settle', home: found.home, away: found.away, raw: found.raw, note: `final ${found.home}–${found.away} (${found.raw}, by ${found.via})` };
  const later = found && found.date && Date.parse(found.date) > o.now ? found.date : null;
  if (found && found.kind === 'off') {
    if (later) return { action: 'move', date: later, note: `${found.raw}: new kick-off ${later} (by ${found.via})` };
    return { action: 'void', reason: `${found.raw === 'CANC' || found.raw === 'CANCELLED' ? 'cancelled' : found.raw === 'ABD' ? 'abandoned' : 'postponed'} by the provider (${found.raw}), no new date` };
  }
  if (found && found.kind === 'open' && later) return { action: 'move', date: later, note: `moved to ${later} (by ${found.via})` };
  // not found, or still not final on the provider: looked up again every run (attempts = days with a lookup)
  const attempts = o.lastDay === today ? o.attempts : o.attempts + 1;
  const what = found ? `still ${found.raw} on the provider (by ${found.via})` : `not found by fixture id or by the two teams (±${TEAM_WINDOW_DAYS} days)`;
  // fix253: 7 days with no final at either provider → void (unless a person undid that void: hold)
  if (o.now - ko >= AUTO_VOID_AFTER_MS && !o.hold) return { action: 'void', reason: `no final from either provider ${Math.floor((o.now - ko) / 86400000)} days after kick-off (${what})` };
  // fix240: from kick-off + 48 h it is watched (settle_review: Enter result / Void stay possible); fix253: nobody is asked
  if (o.now - ko >= REVIEW_AFTER_MS) return { action: 'review', attempts, note: `${what}, ${Math.floor((o.now - ko) / 3600000)} h after kick-off` };
  return { action: 'retry', attempts, note: what };
}

/** Team names compared loosely ("Al-Hilal" = "Al Hilal Saudi FC"). */
export function sameTeamName(a: string | null | undefined, b: string | null | undefined): boolean {
  const k = (s: string | null | undefined) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\b(fc|sc|cf|afc|club|saudi|de|the)\b/g, ' ').replace(/[^a-z0-9]+/g, '');
  const x = k(a), y = k(b);
  return !!x && !!y && (x === y || (x.length >= 5 && y.includes(x)) || (y.length >= 5 && x.includes(y)));
}
