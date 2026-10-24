/**
 * fix209 — "Scorers shown": every live or finished game of the last 48 h whose score has goals / points must show who
 * scored, in every sport, and fix itself when it doesn't.
 *  - football: the score's goals per side = the goals with a player's name (own goals count for the side that got them).
 *    The names come from what the match page served (scorer_seen, written by the web process) or API-Football's events
 *    (20 games per call; Football-Data.org matches through their API-Football twin). API-Football's list is kept in
 *    match_goal_events and laid over a match page that names fewer goals (goalEventsOverlay, on every response);
 *  - basketball: each team's top scorer is there once a box score exists;
 *  - American football: a side with points has a scoring play.
 * A mismatch is normal for a minute or two (the provider has the score before the scorer); one older than 10 minutes is
 * listed in data health (target 0) and fetched again: football events every run until they match (and the stored match
 * page dropped so it is rebuilt), basketball box score queued again, NFL scoring plays fetched again (once per 30 min).
 * Runs in the worker every 5 minutes (jobs.ts); data health reads the table.
 */
import { db } from '../db';
import { yieldEvery } from './perf';
import logger from '../utils/logger';
import { footballGap, betterGoals, bbTopGap, nflPlaysGap } from '../utils/scorers';
import { AF_OFFSET, isAfMatchId, afLive, afFixturesFull, afTwinOfFd, eventsOnFd } from './afMatches';
import { afConfigured, afRemaining } from './apiFootball';
import { liveBookIds } from './liveScores';
import { nflRefetchEvents } from './nfl';

const MIN = 60 * 1000;
export const MISMATCH_GRACE_MS = 10 * MIN;
const WINDOW_MS = 48 * 3600 * 1000;

db.exec(`
  CREATE TABLE IF NOT EXISTS match_goal_events (match_id INTEGER PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS scorer_seen (match_id INTEGER PRIMARY KEY, score TEXT NOT NULL, named TEXT NOT NULL, at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS scorer_checks (
    sport TEXT NOT NULL, game_id INTEGER NOT NULL, name TEXT, kickoff TEXT, score TEXT, named TEXT, ok INTEGER NOT NULL,
    mismatch_since INTEGER, checked_at INTEGER NOT NULL, refetched_at INTEGER, PRIMARY KEY (sport, game_id)
  );
`);

/* ---------- web process: what the page served, and the better goal list on every response ---------- */

const getEvents = db.prepare(`SELECT json FROM match_goal_events WHERE match_id = ?`);
const putSeen = db.prepare(`INSERT OR REPLACE INTO scorer_seen (match_id, score, named, at) VALUES (?, ?, ?, ?)`);

/** A football match with API-Football's goals when they name more of the score than its own (and VAR / missed pens). */
export function goalEventsOverlay<T extends { id: number; homeTeam: any; awayTeam: any; score?: any; goals?: any[]; bookings?: any[]; varEvents?: any[]; missedPens?: any[] }>(m: T): T {
  if (!m?.id || !m.score?.fullTime) return m;
  let row: any;
  try { row = getEvents.get(m.id); } catch { return m; }
  if (!row) return m;
  let ev: any;
  try { ev = JSON.parse(row.json); } catch { return m; }
  const goals = betterGoals(m as any, ev.goals);
  const out: any = { ...m };
  if (goals !== (m.goals || [])) { out.goals = goals; if ((ev.bookings || []).length > (m.bookings || []).length) out.bookings = ev.bookings; }
  if (!m.varEvents?.length && ev.varEvents?.length) out.varEvents = ev.varEvents;
  if (!m.missedPens?.length && ev.missedPens?.length) out.missedPens = ev.missedPens;
  return out;
}

/** The match page was built: remember how many goals it names (the check uses it for games no one else names). */
export function noteServedScorers(m: any) {
  if (!m?.id || !m.score?.fullTime || !['IN_PLAY', 'PAUSED', 'FINISHED', 'AWARDED'].includes(String(m.status))) return;
  const g = footballGap(m);
  try { putSeen.run(m.id, `${g.score.home}-${g.score.away}`, `${g.named.home}-${g.named.away}`, Date.now()); } catch { /* read-only connection */ }
}

/** Whether a built match page names every goal of its score (a page that doesn't is never stored for good). */
export const scorersComplete = (m: any) => !m?.score?.fullTime || footballGap(m).ok;

/* ---------- worker: the check ---------- */

type Row = { sport: 'football' | 'basketball' | 'nfl'; id: number; name: string; kickoff: string; score: string; named: string; ok: boolean };
const getCheck = db.prepare(`SELECT * FROM scorer_checks WHERE sport = ? AND game_id = ?`);
const putCheck = db.prepare(`INSERT OR REPLACE INTO scorer_checks (sport, game_id, name, kickoff, score, named, ok, mismatch_since, checked_at, refetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

function record(r: Row, now: number, refetched = false) {
  const prev: any = getCheck.get(r.sport, r.id);
  // the clock starts at the first mismatch for this score (a new goal starts it again)
  const since = r.ok ? null : prev && !prev.ok && prev.score === r.score && prev.mismatch_since ? prev.mismatch_since : now;
  putCheck.run(r.sport, r.id, r.name, r.kickoff, r.score, r.named, r.ok ? 1 : 0, since, now, refetched ? now : prev?.refetched_at ?? null);
  return { since, prevRefetch: prev?.refetched_at ?? null };
}
const late = (sport: string, id: number, now: number) => {
  const r: any = getCheck.get(sport, id);
  return !!r && !r.ok && r.mismatch_since && now - r.mismatch_since > MISMATCH_GRACE_MS;
};

/** Football games to check: finished in the last 48 h with goals (our record) + live now with goals. */
function footballGames(now: number) {
  const since = new Date(now - WINDOW_MS).toISOString();
  const done = db.prepare(`SELECT p.match_id AS id, MIN(p.utc_date) AS kickoff, MAX(p.competition_code) AS code, MAX(p.home_team) AS home, MAX(p.away_team) AS away,
      MAX(p.home_team_id) AS homeId, MAX(p.away_team_id) AS awayId, r.home_goals AS hs, r.away_goals AS as_
    FROM results r JOIN predictions p ON p.match_id = r.match_id
    WHERE p.utc_date > ? AND r.home_goals IS NOT NULL AND r.home_goals + r.away_goals > 0 GROUP BY p.match_id`).all(since) as any[];
  const byId = new Map<number, any>(done.map(r => [r.id, { ...r, live: false }]));
  const nameOf = db.prepare(`SELECT utc_date AS kickoff, competition_code AS code, home_team AS home, away_team AS away, home_team_id AS homeId, away_team_id AS awayId FROM predictions WHERE match_id = ? LIMIT 1`);
  for (const l of [...liveBookIds(), ...afLive().map((m: any) => ({ id: m.id, home: m.score?.fullTime?.home ?? 0, away: m.score?.fullTime?.away ?? 0, status: m.status }))]) {
    if (byId.has(l.id) || !['IN_PLAY', 'PAUSED', 'FINISHED'].includes(l.status) || (l.home || 0) + (l.away || 0) === 0) continue;
    const p: any = nameOf.get(l.id);
    if (p) byId.set(l.id, { id: l.id, ...p, hs: l.home, as_: l.away, live: l.status !== 'FINISHED' });
  }
  return [...byId.values()];
}

async function checkFootball(now: number) {
  const games = footballGames(now);
  const seen = db.prepare(`SELECT score, named FROM scorer_seen WHERE match_id = ?`);
  const need: any[] = [];
  let ok = 0;
  const step = yieldEvery(50, 100, { live: true }); // fix210b: a yield every 50 games / 100 ms (the job blocked 3.75 s)
  for (const g of games) {
    await step();
    const score = `${g.hs}-${g.as_}`;
    const prev: any = getCheck.get('football', g.id);
    if (prev?.ok && prev.score === score) { ok++; continue; } // checked and fine at this score
    const s: any = seen.get(g.id);
    const fromPage = s && s.score === score ? s.named : null;
    const [nh, na] = String(fromPage || '0-0').split('-').map(Number);
    if (fromPage && nh >= g.hs && na >= g.as_) { record({ sport: 'football', id: g.id, name: `${g.home} – ${g.away}`, kickoff: g.kickoff, score, named: fromPage, ok: true }, now); ok++; continue; }
    need.push({ ...g, score, fromPage });
  }
  need.sort((a, b) => Number(b.live) - Number(a.live) || ((getCheck.get('football', a.id) as any)?.checked_at ?? 0) - ((getCheck.get('football', b.id) as any)?.checked_at ?? 0));
  if (!need.length || !afConfigured()) {
    for (const g of need) record({ sport: 'football', id: g.id, name: `${g.home} – ${g.away}`, kickoff: g.kickoff, score: g.score, named: g.fromPage || '0-0', ok: false }, now);
    return { games: games.length, ok, fetched: 0 };
  }
  // API-Football's events for the rest: 20 fixtures per call, at most 3 calls a run, never into the last 500 calls
  const budget = Math.min(60, Math.max(0, (afRemaining() - 500) * 20));
  const twins = new Map<number, { fid: number; swapped: boolean } | null>();
  for (const g of need.slice(0, budget)) {
    if (isAfMatchId(g.id)) twins.set(g.id, { fid: g.id - AF_OFFSET, swapped: false });
    else {
      try {
        twins.set(g.id, await afTwinOfFd({ id: g.id, utcDate: g.kickoff, competition: { code: g.code }, homeTeam: { id: g.homeId, name: g.home }, awayTeam: { id: g.awayId, name: g.away } }));
      } catch { twins.set(g.id, null); }
    }
  }
  const fids = [...new Set([...twins.values()].filter(Boolean).map(t => t!.fid))];
  let full = new Map<number, any>();
  try { full = fids.length ? await afFixturesFull(fids) : full; } catch (e: any) { logger.warn(`scorers check: ${e.message}`); }
  const putEv = db.prepare(`INSERT OR REPLACE INTO match_goal_events (match_id, json, updated_at) VALUES (?, ?, ?)`);
  for (const g of need) {
    await step();
    const t = twins.get(g.id);
    const af = t ? full.get(t.fid) : null;
    const base = { id: g.id, homeTeam: { id: g.homeId, name: g.home }, awayTeam: { id: g.awayId, name: g.away }, score: { fullTime: { home: g.hs, away: g.as_ } } };
    let named = g.fromPage || '0-0', good = false;
    if (af) {
      const ev = isAfMatchId(g.id) ? { goals: af.goals, bookings: af.bookings, substitutions: af.substitutions, varEvents: af.varEvents, missedPens: af.missedPens } : eventsOnFd(af, base, t!.swapped);
      const gap = footballGap({ ...base, goals: ev.goals });
      const [ph, pa] = String(g.fromPage || '0-0').split('-').map(Number);
      named = `${Math.max(gap.named.home, ph)}-${Math.max(gap.named.away, pa)}`;
      good = Math.max(gap.named.home, ph) >= g.hs && Math.max(gap.named.away, pa) >= g.as_;
      if (gap.named.home + gap.named.away > 0) putEv.run(g.id, JSON.stringify(ev), now);
    }
    const wasLate = late('football', g.id, now);
    record({ sport: 'football', id: g.id, name: `${g.home} – ${g.away}`, kickoff: g.kickoff, score: g.score, named, ok: good }, now, wasLate);
    if (good) ok++;
    else if (wasLate) {
      // a stored match page with the old events is rebuilt on its next open (the overlay already fixes the response)
      try { db.prepare(`DELETE FROM match_details_store WHERE match_id = ?`).run(g.id); } catch { /* none */ }
    }
  }
  return { games: games.length, ok, fetched: fids.length };
}

async function checkBasketball(now: number) {
  const since = new Date(now - WINDOW_MS).toISOString();
  const games = db.prepare(`SELECT game_id AS id, code, kickoff, home_id, away_id, home_name, away_name, hs, as_, status FROM bb_games
    WHERE kickoff > ? AND kickoff < ? AND status IN ('Q1','Q2','Q3','Q4','OT','BT','HT','FT','AOT') AND COALESCE(hs, 0) + COALESCE(as_, 0) > 0`).all(since, new Date(now).toISOString()) as any[];
  const fin = db.prepare(`SELECT team_id, name, pts FROM bb_player_stats WHERE game_id = ?`);
  const liv = db.prepare(`SELECT team_id, name, pts FROM bb_player_stats_live WHERE game_id = ?`);
  let ok = 0, checked = 0;
  const step = yieldEvery(50, 100, { live: true }); // fix210b: a yield every 50 games / 100 ms (the job blocked 3.75 s)
  for (const g of games) {
    await step();
    let rows = fin.all(g.id) as any[];
    if (!rows.length) rows = liv.all(g.id) as any[];
    if (!rows.length) continue; // no box score yet: nothing to show (the live-box line watches the feed)
    checked++;
    const miss = bbTopGap(rows, g.home_id, g.away_id);
    const wasLate = !!miss.length && late('basketball', g.id, now);
    const r = record({ sport: 'basketball', id: g.id, name: `${g.code} ${g.home_name} – ${g.away_name}`, kickoff: g.kickoff, score: `${g.hs ?? 0}-${g.as_ ?? 0}`, named: miss.length ? `missing: ${miss.join(', ')}` : 'both', ok: !miss.length }, now, wasLate);
    if (!miss.length) ok++;
    // the final box score is fetched again by the box-score job (once per 30 min)
    else if (wasLate && ['FT', 'AOT'].includes(g.status) && (!r.prevRefetch || now - r.prevRefetch > 30 * MIN)) db.prepare(`UPDATE bb_games SET stats = 0 WHERE game_id = ?`).run(g.id);
  }
  return { games: checked, ok };
}

async function checkNfl(now: number) {
  const since = new Date(now - WINDOW_MS).toISOString();
  const games = db.prepare(`SELECT game_id AS id, league, kickoff, home_id, away_id, home_name, away_name, home_pts, away_pts, status FROM nfl_games
    WHERE kickoff > ? AND kickoff < ? AND status IN ('Q1','Q2','Q3','Q4','OT','HT','FT','AOT') AND COALESCE(home_pts, 0) + COALESCE(away_pts, 0) > 0`).all(since, new Date(now).toISOString()) as any[];
  const ev = db.prepare(`SELECT json FROM nfl_events WHERE game_id = ?`);
  let ok = 0;
  const step = yieldEvery(50, 100, { live: true }); // fix210b: a yield every 50 games / 100 ms (the job blocked 3.75 s)
  for (const g of games) {
    await step();
    let plays: any[] | null = null;
    try { const r: any = ev.get(g.id); plays = r ? JSON.parse(r.json) : null; } catch { plays = null; }
    const miss = nflPlaysGap(plays, { home: g.home_pts, away: g.away_pts }, g.home_id, g.away_id);
    const wasLate = !!miss.length && late('nfl', g.id, now);
    const prev: any = getCheck.get('nfl', g.id);
    const refetch = wasLate && (!prev?.refetched_at || now - prev.refetched_at > 30 * MIN);
    record({ sport: 'nfl', id: g.id, name: `${g.league === 2 ? 'College' : 'NFL'} ${g.home_name} – ${g.away_name}`, kickoff: g.kickoff, score: `${g.home_pts ?? 0}-${g.away_pts ?? 0}`, named: miss.length ? `missing: ${miss.join(', ')}` : 'both', ok: !miss.length }, now, refetch);
    if (!miss.length) ok++;
    else if (refetch) { try { await nflRefetchEvents(g.id); } catch (e: any) { logger.warn(`scorers check NFL ${g.id}: ${e.message}`); } }
  }
  return { games: games.length, ok };
}

let busy = false;
let last: { at: number; football: any; basketball: any; nfl: any } | null = null;
/** One run (worker, every 5 minutes). */
export async function scorersCheckTick(now = Date.now()) {
  if (busy) return last;
  busy = true;
  try {
    const football = await checkFootball(now).catch((e: any) => { logger.warn(`scorers check football: ${e.message}`); return null; });
    const basketball = await checkBasketball(now).catch((e: any) => { logger.warn(`scorers check basketball: ${e.message}`); return null; });
    const nfl = await checkNfl(now).catch((e: any) => { logger.warn(`scorers check NFL: ${e.message}`); return null; });
    db.prepare(`DELETE FROM scorer_checks WHERE checked_at < ?`).run(now - 3 * 86400000);
    db.prepare(`DELETE FROM scorer_seen WHERE at < ?`).run(now - 3 * 86400000);
    db.prepare(`DELETE FROM match_goal_events WHERE updated_at < ?`).run(now - 7 * 86400000);
    last = { at: now, football, basketball, nfl };
    return last;
  } finally { busy = false; }
}

/** Data health: the games of the last 48 h still without their scorers 10+ minutes after the goal (target 0). */
export function scorersHealth(now = Date.now()): { checked: number; late: string[]; lastRun: number | null } {
  const rows = db.prepare(`SELECT * FROM scorer_checks WHERE checked_at > ? AND kickoff > ?`).all(now - 30 * MIN, new Date(now - WINDOW_MS).toISOString()) as any[];
  const lateRows = rows.filter(r => !r.ok && r.mismatch_since && now - r.mismatch_since > MISMATCH_GRACE_MS);
  const label: Record<string, string> = { football: 'Football', basketball: 'Basketball', nfl: 'American football' };
  return {
    checked: rows.length,
    lastRun: last?.at ?? null,
    late: lateRows.map(r => `${label[r.sport] || r.sport} ${r.name} (${r.game_id}) · score ${r.score} · ${r.sport === 'football' ? `named ${r.named}` : r.named} · ${Math.round((now - r.mismatch_since) / MIN)} min${r.refetched_at ? ' · fetched again' : ''}`)
  };
}
