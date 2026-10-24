/**
 * fix212 — Football-Data.org froze at 10:20 UTC on 24 Oct and the site kept its stale status for hours: every
 * match in the window still carried lastUpdated 10:20, FD kept answering 200, so the window was marked fresh and 16
 * games past kick-off stayed "TIMED". Two guards, both in the worker before the window is published:
 *
 *  1. One status per match, the freshest source wins. Every Football-Data.org match is linked to its API-Football
 *     fixture (afMatches.ts, the fix115 / fix209 mapping, now stored in fd_af_links) and, when FD's reading cannot
 *     be right — past kick-off + 15 min but still SCHEDULED / TIMED, or lastUpdated over 15 min old while the game
 *     should be live or just finished — API-Football's status, minute and score are reported to the live book
 *     (liveScores.ts). The window itself is served through withLiveScore, so the lists, the match page and header,
 *     the calendar, favourites, Draws, the SEO pages and the socket all show the same freshest reading.
 *  2. The freeze detector: a game should be live or just finished and the newest lastUpdated of the whole window is
 *     over 20 min old → "FD frozen": every FD match past kick-off takes its status from API-Football until FD moves
 *     again; the "fixtures" feed is marked failed ("Football-Data frozen since HH:MM (Israel time)") instead of
 *     fresh; the admin gets one email when it starts and one when it recovers.
 */
import { db } from '../db';
import logger from '../utils/logger';
import { reportLive, bestLive } from './liveScores';
import { afTwinOfFd, afLiveReading, afFixturesFull } from './afMatches';
import { afConfigured, afRemaining } from './apiFootball';
import { emailEnabled, sendEmail } from './email';
import { onState, publishState } from './shared';
import { yieldLoop } from './perf';

export const DUE_MS = 15 * 60 * 1000; // kick-off + 15 min and still not started = FD is behind
export const STALE_MS = 15 * 60 * 1000; // a live / just-finished game whose FD reading is older than this
export const FREEZE_MS = 20 * 60 * 1000; // the whole window's newest lastUpdated older than this = frozen
export const SHOULD_BE_LIVE_MS = 3 * 60 * 60 * 1000; // kick-off up to 3 h ago: live or just finished
const FINAL = new Set(['FINISHED', 'AWARDED', 'CANCELLED', 'POSTPONED', 'SUSPENDED']);
const NOT_STARTED = new Set(['SCHEDULED', 'TIMED']);
const LIVE = new Set(['IN_PLAY', 'PAUSED']);

const ms = (iso: unknown) => { const t = Date.parse(String(iso || '')); return Number.isFinite(t) ? t : null; };

/** FD's reading of this match cannot be trusted right now: API-Football's is wanted. */
export function needsAf(m: any, now = Date.now()): boolean {
  const ko = ms(m?.utcDate);
  if (ko === null || FINAL.has(String(m?.status))) return false;
  const lu = ms(m?.lastUpdated);
  if (NOT_STARTED.has(String(m?.status)) && now >= ko + DUE_MS) return true;
  if (LIVE.has(String(m?.status)) && (lu === null || now - lu > STALE_MS)) return true;
  // scheduled to be on (or just over) and FD has not touched it for 15 min
  if (ko <= now && now - ko <= SHOULD_BE_LIVE_MS && lu !== null && now - lu > STALE_MS) return true;
  return false;
}

/** the newest lastUpdated of a window (0 when none carry one) */
export const fdNewest = (window: any[]) => window.reduce((a, m) => Math.max(a, ms(m?.lastUpdated) ?? 0), 0);
/** a game of the window should be live or just finished now */
export const anyDue = (window: any[], now = Date.now()) => window.some(m => { const ko = ms(m?.utcDate); return ko !== null && ko <= now && now - ko <= SHOULD_BE_LIVE_MS; });

export interface FreezeCheck { newest: number; idsKey: string; changed: boolean; frozen: boolean; due: boolean }
/**
 * Has FD's data moved since the last refresh, and is it frozen? Frozen = a game should be live or just finished and
 * the newest lastUpdated across the window is over 20 min old. "Changed" = the newest lastUpdated moved or the set of
 * matches did (a quiet night changes nothing and is not a freeze).
 */
export function freezeCheck(window: any[], now = Date.now(), prev: { newest: number; idsKey: string } | null = null): FreezeCheck {
  const newest = fdNewest(window);
  const idsKey = window.map(m => m?.id).filter(Boolean).sort((a, b) => a - b).join(',');
  const changed = !prev || prev.newest !== newest || prev.idsKey !== idsKey;
  const due = anyDue(window, now);
  return { newest, idsKey, changed, frozen: due && newest > 0 && now - newest > FREEZE_MS, due };
}

/* ---------- the frozen state (worker decides, published to the web process) ---------- */

export interface FreezeState { frozen: boolean; since: number | null; newest: number; checkedAt: number; recoveredAt: number | null }
let state: FreezeState = { frozen: false, since: null, newest: 0, checkedAt: 0, recoveredAt: null };
export const fdFreeze = () => state;
export const fdFrozen = () => state.frozen;
export const israelTime = (t: number) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });
/** the failed-feed text: "Football-Data frozen since 13:20 (Israel time)" */
export const frozenText = (s: FreezeState = state) => `Football-Data frozen since ${israelTime(s.since ?? s.newest)} (Israel time)`;

onState('fd:freeze', (_k, v: FreezeState) => { state = v; });

async function tellAdmin(subject: string, text: string) {
  const to = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!emailEnabled || !to.length) return;
  for (const a of to) await sendEmail(a, subject, `<p>${text.replace(/\n/g, '<br>')}</p>`, text).catch(() => undefined);
}
/** called after every window refresh with the check's answer; one email when a freeze starts, one when it ends */
export function applyFreezeCheck(c: FreezeCheck, now = Date.now()) {
  const was = state.frozen;
  if (c.frozen && !was) {
    state = { frozen: true, since: c.newest, newest: c.newest, checkedAt: now, recoveredAt: null };
    logger.warn(`FD frozen: newest lastUpdated ${new Date(c.newest).toISOString()} (${israelTime(c.newest)} Israel time) while games are on — statuses from API-Football until it moves`);
    void tellAdmin('SportLikely: Football-Data.org feed frozen', `${frozenText()}. The newest lastUpdated across the fixture window is ${new Date(c.newest).toISOString()} while games should be live or just finished.\nStatuses, minutes and scores of Football-Data.org matches now come from API-Football until the feed moves again. Nothing to do; this email comes once per incident, and once more when it recovers.`);
  } else if (!c.frozen && was) {
    const since = state.since;
    state = { frozen: false, since: null, newest: c.newest, checkedAt: now, recoveredAt: now };
    logger.info(`FD moving again: newest lastUpdated ${new Date(c.newest).toISOString()} (frozen since ${since ? israelTime(since) : '?'} Israel time)`);
    void tellAdmin('SportLikely: Football-Data.org feed moving again', `Football-Data.org updated its matches again at ${israelTime(c.newest)} (Israel time); it had been frozen since ${since ? israelTime(since) : '?'}. The match statuses come from Football-Data.org as before (API-Football still fills in when it is behind on a game).`);
  } else state = { ...state, newest: c.newest, checkedAt: now };
  publishState('fd:freeze', state);
}

/* ---------- reconcile: API-Football's reading for the FD matches that need it ---------- */

/** the FD matches of a window whose status must come from API-Football right now (every due one while FD is frozen) */
export function fdMatchesNeedingAf(window: any[], now = Date.now()): any[] {
  return window.filter(m => {
    if (needsAf(m, now)) return true;
    if (!state.frozen || FINAL.has(String(m?.status))) return false;
    const ko = ms(m?.utcDate);
    return ko !== null && ko <= now; // frozen: anything that has kicked off
  });
}

const warned = new Set<number>();
/**
 * Report API-Football's status, minute and score for the FD matches that need it: from the last live=all poll when the
 * fixture is in it (≤ 3 min old), else by fixture id in batches of 20 (/fixtures?ids=). At most 20 matches per turn.
 * Returns how many got an API-Football reading.
 */
export async function reconcileFdWindow(window: any[], now = Date.now()): Promise<{ wanted: number; fromAf: number; fetched: number }> {
  if (!afConfigured()) return { wanted: 0, fromAf: 0, fetched: 0 };
  const wanted = fdMatchesNeedingAf(window, now);
  let fromAf = 0;
  const byId = new Map<number, { fid: number; m: any }>();
  let n = 0;
  for (const m of wanted) {
    if (++n % 20 === 0) await yieldLoop();
    try {
      const twin = await afTwinOfFd(m);
      if (!twin || twin.swapped) continue; // a swapped fixture's score would be the wrong way round (fix162)
      const live = afLiveReading(twin.fid);
      if (live && now - live.at <= 3 * 60 * 1000) { reportLive(m.id, 'af', live.match, live.at); fromAf++; continue; }
      // a final API-Football already gave us (a long freeze keeps the game in FD's window for hours): kept, not refetched
      const b = bestLive(m.id);
      if (b && b.source === 'af' && b.status === 'FINISHED') {
        reportLive(m.id, 'af', { status: b.status, minute: b.minute, injuryTime: b.injuryTime, score: { fullTime: { home: b.home, away: b.away }, halfTime: { home: b.htHome, away: b.htAway } } }, now);
        fromAf++; continue;
      }
      byId.set(twin.fid, { fid: twin.fid, m });
    } catch (e: any) {
      if (!warned.has(m.id)) { warned.add(m.id); logger.warn(`FD ${m.id} (${m.homeTeam?.name} – ${m.awayTeam?.name}): API-Football twin: ${e?.message || e}`); }
    }
  }
  let fetched = 0;
  if (byId.size && afRemaining() >= 100) {
    try {
      const got = await afFixturesFull([...byId.keys()]);
      for (const [fid, { m }] of byId) {
        const f = got.get(fid);
        if (!f) continue;
        reportLive(m.id, 'af', f, now);
        fetched++; fromAf++;
      }
    } catch (e: any) {
      logger.warn(`FD reconcile: API-Football fixtures: ${e?.message || e}`);
    }
  } else if (byId.size) logger.warn(`FD reconcile: ${byId.size} match(es) need API-Football but the day's budget is low (${afRemaining()} left)`);
  if (wanted.length) logger.info(`FD reconcile: ${wanted.length} match(es) behind at Football-Data${state.frozen ? ' (FD frozen)' : ''}, ${fromAf} from API-Football (${fetched} fetched by id)`);
  return { wanted: wanted.length, fromAf, fetched };
}

/* ---------- results settled from API-Football, checked against Football-Data when it arrives ---------- */

db.exec(`CREATE TABLE IF NOT EXISTS result_checks (match_id INTEGER PRIMARY KEY, af_home INTEGER, af_away INTEGER, fd_home INTEGER, fd_away INTEGER, status TEXT NOT NULL, at TEXT NOT NULL)`);
/** a Football-Data match settled from API-Football (FD had no final 20 min after the expected end) */
export function noteAfSettled(matchId: number, home: number, away: number) {
  db.prepare(`INSERT OR REPLACE INTO result_checks (match_id, af_home, af_away, fd_home, fd_away, status, at) VALUES (?, ?, ?, ?, ?, 'af-only', ?)`).run(matchId, home, away, null, null, new Date().toISOString());
}
/** the ids still waiting for Football-Data's own final (last 7 days) */
export function afSettledUnchecked(): { match_id: number }[] {
  return db.prepare(`SELECT match_id FROM result_checks WHERE status = 'af-only' AND at >= ?`).all(new Date(Date.now() - 7 * 86400000).toISOString()) as any[];
}
/** Football-Data's final arrived for a match settled from API-Football: confirmed, or a mismatch for the data-health card */
export function checkFdFinal(matchId: number, home: number, away: number): 'confirmed' | 'mismatch' | null {
  const r = db.prepare(`SELECT af_home, af_away, status FROM result_checks WHERE match_id = ?`).get(matchId) as any;
  if (!r || r.status !== 'af-only') return null;
  const status = r.af_home === home && r.af_away === away ? 'confirmed' : 'mismatch';
  db.prepare(`UPDATE result_checks SET fd_home = ?, fd_away = ?, status = ?, at = ? WHERE match_id = ?`).run(home, away, status, new Date().toISOString(), matchId);
  if (status === 'mismatch') logger.warn(`result mismatch for FD ${matchId}: API-Football ${r.af_home}-${r.af_away}, Football-Data ${home}-${away}`);
  return status;
}
/** data health: results where the two providers disagree (30 days), newest first */
export function resultMismatches(): { match_id: number; af: string; fd: string; at: string }[] {
  return (db.prepare(`SELECT match_id, af_home, af_away, fd_home, fd_away, at FROM result_checks WHERE status = 'mismatch' AND at >= ? ORDER BY at DESC LIMIT 20`).all(new Date(Date.now() - 30 * 86400000).toISOString()) as any[])
    .map(r => ({ match_id: r.match_id, af: `${r.af_home}-${r.af_away}`, fd: `${r.fd_home}-${r.fd_away}`, at: r.at }));
}
export const afSettledCount = (days = 7) => (db.prepare(`SELECT COUNT(*) AS n FROM result_checks WHERE at >= ?`).get(new Date(Date.now() - days * 86400000).toISOString()) as any)?.n || 0;
