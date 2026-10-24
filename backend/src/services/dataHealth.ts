/**
 * Data health: is everything on the site current and consistent? fix200: a background job runs it every 5 minutes (in
 * slices, in the heavy() queue) and stores the report; /api/data-health, the admin card and the daily email read the
 * stored copy with its "at" time (it is never computed on a request). Two kinds of checks:
 *
 *  1. Freshness — every background feed must have updated within its promised time:
 *       live scores 3 min (only while games are on) · fixtures 15 min · extra competitions 75 min · tables 60 min
 *       · results (settling) 30 min · odds 30 min · injuries / lineups 30 min · model 8 h
 *  2. Validity — the data itself:
 *       games still "live" or "not started" long after kick-off · finished games without a score
 *       · predictions past kick-off + 4 h that were never settled (fail only past 48 h and not void: services/unsettled.ts) · upcoming games (48 h) without a prediction
 *       · probabilities that don't add up to 100% · the same game listed twice · league tables that don't add up
 *       (played = W+D+L, goal difference = GF−GA) · stored results whose outcome doesn't match the score
 *       · model history (results feed) missing games that were played
 *
 * A problem that stays for 6 runs in a row (30 minutes) is emailed to ADMIN_EMAILS, at most once every 6 hours.
 */
import { db } from '../db';
import logger from '../utils/logger';
import footballDataAPI from './footballDataAPI';
import { afUpcoming, afWithPredictions, afOverdue, fallbackReason } from './afMatches';
import { afConfigured } from './apiFootball';
import { feedState, bootedAt } from './freshness';
import { emailEnabled, sendEmail, layout, section, esc, C, SITE } from './email';
import { lastDataAudit } from './dataAudit';
import { everyHeavy, afterHeavy, heavySlicer, inBatches } from './perf';
import { missingPredictions } from './missingPredictions';
import { tennisDataCheck } from './tennis';
import { bbStandingsCheck } from './bbSite';
import { voidedThisMonth } from './unsettled';
import { moreHealth } from './morePredictions';
import { createHealthStore, NOT_YET } from '../utils/healthStore';
import { LATE_MS } from '../utils/liveBox';
import { BB_MAJOR } from './basketball';
import { scorersHealth } from './scorersCheck';
import { perfChecks } from './perfChecks';
import { photoHealth } from './playerPhotos';

type Level = 'ok' | 'warn' | 'fail';

/** fix208: the live games the box-score job must keep fresh (big leagues), and the ones late by more than 5 minutes */
export function liveBoxCheck(now = Date.now()): { tracked: number; late: string[] } {
  const started = new Date(now - 8 * MIN).toISOString(), since = new Date(now - 6 * 60 * MIN).toISOString(), lateAt = now - LATE_MS;
  const bb = db.prepare(`SELECT g.game_id AS id, g.code AS league, g.home_name AS home, g.away_name AS away,
      (SELECT MAX(updated_at) FROM bb_player_stats_live p WHERE p.game_id = g.game_id) AS at
    FROM bb_games g WHERE g.status IN ('Q1','Q2','Q3','Q4','OT','BT','HT') AND g.code IN (${[...BB_MAJOR].map(() => '?').join(',')}) AND g.kickoff BETWEEN ? AND ?`).all(...BB_MAJOR, since, started) as any[];
  const nfl = db.prepare(`SELECT g.game_id AS id, 'NFL' AS league, g.home_name AS home, g.away_name AS away,
      (SELECT MAX(updated_at) FROM nfl_player_stats_live p WHERE p.game_id = g.game_id) AS at
    FROM nfl_games g WHERE g.status IN ('Q1','Q2','Q3','Q4','OT','HT') AND g.league = 1 AND g.kickoff BETWEEN ? AND ?`).all(since, started) as any[];
  const all = [...bb, ...nfl];
  const late = all.filter(r => !r.at || r.at < lateAt).map(r => `${r.league} ${r.home} – ${r.away} (${r.id}): ${r.at ? `last update ${Math.round((now - r.at) / MIN)} min ago` : 'no box score yet'}`);
  return { tracked: all.length, late };
}
export interface Check { id: string; label: string; level: Level; detail: string; items?: string[] }

const MIN = 60 * 1000;
const FEEDS: { id: string; label: string; maxAge: number; when?: () => boolean }[] = [
  { id: 'live', label: 'Live scores', maxAge: 3 * MIN },
  { id: 'fixtures', label: 'Fixtures and scores (main leagues)', maxAge: 15 * MIN },
  { id: 'extra-fixtures', label: 'Fixtures and scores (other competitions)', maxAge: 75 * MIN, when: afConfigured },
  { id: 'standings', label: 'League tables', maxAge: 60 * MIN },
  { id: 'results', label: 'Results and prediction settling', maxAge: 30 * MIN },
  { id: 'odds', label: 'Bookmaker odds', maxAge: 30 * MIN, when: () => !!process.env.ODDS_API_KEY },
  { id: 'injuries-lineups', label: 'Injuries, lineups and match stats', maxAge: 30 * MIN, when: afConfigured },
  { id: 'model', label: 'Model ratings', maxAge: 8 * 60 * MIN }
];
const LIVE = ['IN_PLAY', 'PAUSED'];
const FINAL = ['FINISHED', 'AWARDED', 'CANCELLED', 'POSTPONED', 'SUSPENDED'];
const ago = (ms: number) => (ms < 90 * 1000 ? `${Math.round(ms / 1000)} s` : ms < 90 * MIN ? `${Math.round(ms / MIN)} min` : `${(ms / 3600000).toFixed(1)} h`);
const gameName = (m: any) => `${m.homeTeam?.name ?? m.home_team ?? '?'} – ${m.awayTeam?.name ?? m.away_team ?? '?'} (${m.competition?.name ?? m.competition_name ?? ''}, ${String(m.utcDate ?? m.utc_date ?? '').slice(0, 16).replace('T', ' ')} UTC)`;

async function allMatches(): Promise<any[]> {
  // fix169: predictions in batches with yields (the hourly check blocked 0.5–0.9 s)
  // fix196: batches of 5 (25 right after the prediction cache was cleared took up to ~1 s), waiting for live ticks
  const fd = await inBatches(await footballDataAPI.getUpcomingMatches(30), 5, b => footballDataAPI.withPredictions(b), { live: true });
  return [...fd, ...(await inBatches(afUpcoming(30), 5, b => afWithPredictions(b), { live: true }))];
}

const loggedFallback = new Set<string>();
export async function dataHealth(): Promise<{ level: Level; at: string; checks: Check[] }> {
  const now = Date.now();
  const checks: Check[] = [];
  const slice = heavySlicer(); // fix169: a yield between checks once ~30 ms have passed (fix196: and after a live tick)
  const starting = now - bootedAt() < 10 * MIN;
  let matches: any[] = [];
  try { matches = await allMatches(); } catch (e: any) { checks.push({ id: 'matches', label: 'Match list', level: 'fail', detail: `Could not load: ${e.message}` }); }
  const liveNow = matches.some(m => LIVE.includes(m.status));

  await slice();
  // ---------- 1. freshness ----------
  for (const f of FEEDS) {
    if (f.when && !f.when()) continue;
    if (f.id === 'live' && !liveNow) { checks.push({ id: `feed:${f.id}`, label: f.label, level: 'ok', detail: 'No games on right now' }); continue; }
    const st = feedState(f.id);
    if (!st || st.at === null) {
      checks.push({ id: `feed:${f.id}`, label: f.label, level: starting ? 'ok' : 'fail', detail: starting ? 'Starting up' : `No successful update since the server started ${ago(now - bootedAt())} ago${st?.lastError ? ` (last error: ${st.lastError})` : ''}` });
      continue;
    }
    const age = now - st.at;
    const level: Level = age <= f.maxAge ? 'ok' : age <= 2 * f.maxAge ? 'warn' : 'fail';
    checks.push({
      id: `feed:${f.id}`, label: f.label, level,
      detail: `Updated ${ago(age)} ago (every ${ago(f.maxAge)} at most)${st.note ? ` · ${st.note}` : ''}${st.failures ? ` · ${st.failures} failed attempt(s) since, last: ${st.lastError}` : ''}`
    });
  }

  await slice();
  // ---------- 2. validity ----------
  // games stuck as live, or never started, long after kick-off
  const stuck = matches.filter(m => {
    const t = new Date(m.utcDate).getTime();
    if (FINAL.includes(m.status)) return false;
    if (LIVE.includes(m.status)) return t < now - 3 * 3600 * 1000;
    return t < now - 150 * MIN && t > now - 3 * 86400000;
  });
  await slice();
  checks.push({
    id: 'stuck', label: 'Games with an up-to-date status', level: stuck.length ? 'warn' : 'ok',
    detail: stuck.length ? `${stuck.length} game(s) still shown as live or not started long after kick-off (re-checked automatically)` : 'Every game past kick-off has a live or final status',
    items: stuck.slice(0, 15).map(m => `${gameName(m)} · ${m.status}${m.minute ? ` ${m.minute}'` : ''}`)
  });
  const overdueAf = afOverdue();
  if (overdueAf.length) {
    const c = checks[checks.length - 1];
    c.items = [...(c.items || []), ...overdueAf.filter(o => !stuck.some(s => s.id === o.id)).slice(0, 10).map(o => `${o.home} – ${o.away} (${o.competition}) · ${o.status}`)];
  }

  // finished without a score
  const noScore = matches.filter(m => m.status === 'FINISHED' && (m.score?.fullTime?.home === null || m.score?.fullTime?.home === undefined));
  await slice();
  checks.push({ id: 'no-score', label: 'Finished games have a score', level: noScore.length ? 'fail' : 'ok', detail: noScore.length ? `${noScore.length} finished game(s) without a score` : 'All finished games have a score', items: noScore.slice(0, 15).map(gameName) });

  // the same game twice (main feed + other-competitions feed)
  const seen = new Map<string, any>();
  const dup: string[] = [];
  for (const m of matches) {
    const k = `${String(m.utcDate).slice(0, 10)}|${String(m.homeTeam?.name).toLowerCase()}|${String(m.awayTeam?.name).toLowerCase()}`;
    if (seen.has(k)) dup.push(gameName(m)); else seen.set(k, m);
  }
  await slice();
  checks.push({ id: 'duplicates', label: 'No game listed twice', level: dup.length ? 'warn' : 'ok', detail: dup.length ? `${dup.length} game(s) listed twice` : 'No duplicates', items: dup.slice(0, 15) });

  // predictions: upcoming 48 h covered, probabilities valid
  const soon = matches.filter(m => !FINAL.includes(m.status) && !LIVE.includes(m.status) && new Date(m.utcDate).getTime() > now && new Date(m.utcDate).getTime() < now + 48 * 3600 * 1000);
  const noPred = soon.filter(m => !m.prediction);
  await slice();
  checks.push({
    id: 'missing-predictions', label: 'Upcoming games have a prediction', level: noPred.length > Math.max(3, soon.length * 0.1) ? 'warn' : 'ok',
    detail: `${soon.length - noPred.length} of ${soon.length} games in the next 48 h have a prediction`,
    items: noPred.slice(0, 15).map(gameName)
  });
  // fix192: every sport, next 7 days: games without a prediction, with the reason (target: zero; logged once a day)
  try {
    const mp = await missingPredictions(matches, now);
    const dayKey = new Date(now).toISOString().slice(0, 10);
    for (const line of mp.items) { const k = `np|${dayKey}|${line}`; if (!loggedFallback.has(k)) { loggedFallback.add(k); logger.warn(`no prediction: ${line}`); } }
    checks.push({
      id: 'no-prediction-7d', label: 'Every game of the next 7 days has a prediction (all sports)', level: mp.items.length ? 'warn' : 'ok',
      detail: mp.items.length
        ? `${mp.items.length} of ${mp.checked} upcoming game(s) have no prediction${mp.off.length ? ` · ${mp.off.length} cancelled / postponed (not counted)` : ''}`
        : `All ${mp.checked} upcoming games have a prediction${mp.off.length ? ` · ${mp.off.length} cancelled / postponed (not counted)` : ''}`,
      items: [...mp.items.slice(0, 40), ...mp.off.slice(0, 10).map(x => `(not counted) ${x}`)]
    });
  } catch (e: any) {
    checks.push({ id: 'no-prediction-7d', label: 'Every game of the next 7 days has a prediction (all sports)', level: 'warn', detail: `Check failed: ${e.message}` });
  }
  await slice();
  // fix195: tennis — the same match twice, fixture ids, ATP / WTA / Challenger matches of the next 48 h without a
  // prediction, matches still upcoming / live 6 h after the start (target zero); odd names listed, not counted
  try {
    const tc = await tennisDataCheck(); // fix196: in slices
    checks.push({
      id: 'tennis-data', label: 'Tennis: each match once, predicted, up to date', level: tc.total ? 'warn' : 'ok',
      detail: tc.total
        ? `${tc.duplicates.length} duplicate(s) · ${tc.fixtureIds.length} fixture id(s) · ${tc.noPrediction.length} without a prediction (48 h) · ${tc.stale.length} stale · ${tc.genderMismatch.length} gender mismatch · ${tc.missingRound.length} missing round${tc.names.length ? ` · ${tc.names.length} name(s) to check` : ''}`
        : `No duplicates, every ATP / WTA / Challenger match of the next 48 h predicted, nothing stale, every match in an event of its players' gender and with a round${tc.names.length ? ` · ${tc.names.length} name(s) to check` : ''}`,
      items: [...tc.duplicates.map(x => `duplicate: ${x}`), ...tc.fixtureIds.map(x => `fixture id: ${x}`), ...tc.noPrediction.map(x => `no prediction: ${x}`),
        ...tc.stale.map(x => `stale: ${x}`), ...tc.genderMismatch.map(x => `gender mismatch: ${x}`), ...tc.missingRound.map(x => `missing round: ${x}`),
        ...tc.names.map(x => `name: ${x}`)].slice(0, 60)
    });
  } catch (e: any) {
    checks.push({ id: 'tennis-data', label: 'Tennis: each match once, predicted, up to date', level: 'warn', detail: `Check failed: ${e.message}` });
  }
  await slice();
  // fix204: More predictions — one line per sport: games of the next 48 h with a prediction but no extras, finished games
  // without a check after 24 h (target zero)
  try {
    const NAME: Record<string, string> = { football: 'Football', basketball: 'Basketball', nfl: 'American football', tennis: 'Tennis' };
    for (const m of moreHealth()) {
      // fix204b: the real counts (games with a prediction, saved, missing) and what the last save did
      const ls = m.lastSave;
      const bad = m.missing + m.unchecked + m.flagged + (ls?.errors || 0);
      const last = ls ? `last save ${ls.at.slice(11, 16)} UTC: ${ls.saved} saved, ${ls.unchanged} unchanged, ${ls.errors} error(s)${ls.lastError ? ` (${ls.lastError})` : ''}` : 'no save since the start';
      checks.push({
        id: `more-predictions-${m.sport}`, label: `${NAME[m.sport]}: More predictions saved and settled`, level: bad ? 'warn' : 'ok',
        detail: `${m.predicted} game(s) of the next 48 h with a prediction · ${m.saved} with more predictions · ${m.missing} without · ${m.unchecked} finished not checked after 24 h`
          + `${m.flagged ? ` · ${m.flagged} admin-only (one band over 85%)` : ''} · ${last}`,
        items: [...m.missingIds.map(id => `not saved: ${id}`), ...m.uncheckedIds.map(id => `not checked: ${id}`), ...m.flaggedIds.map(id => `band check failed: ${id}`)]
      });
    }
  } catch (e: any) {
    checks.push({ id: 'more-predictions', label: 'More predictions saved and settled', level: 'warn', detail: `Check failed: ${e.message}` });
  }
  await slice();
  // fix201: basketball tables — one line per league; a table whose rows are not unique teams, or a team in two tables
  // of the same level (e.g. two conferences), is a warn (target zero)
  try {
    const bs = await bbStandingsCheck();
    const bad = bs.filter(x => x.issues.length);
    checks.push({
      id: 'bb-standings', label: 'Basketball tables: each team once per table level', level: bad.length ? 'warn' : 'ok',
      detail: bad.length ? `${bad.length} of ${bs.length} league table(s) with problems` : `${bs.length} league table(s) checked`,
      items: bs.map(x => `${x.code}: ${x.groups} table(s)${x.issues.length ? ` · ${x.issues.slice(0, 5).join(' · ')}` : ' · ok'}`)
    });
  } catch (e: any) {
    checks.push({ id: 'bb-standings', label: 'Basketball tables: each team once per table level', level: 'warn', detail: `Check failed: ${e.message}` });
  }
  await slice();
  // fix208: live box scores — every NBA / EuroLeague / NFL game on for 8+ minutes has a box-score update in the last 5
  // minutes (target 0 during NBA hours); other leagues are fetched only while someone has the page open, so not counted
  try {
    const lb = liveBoxCheck();
    checks.push({
      id: 'live-box', label: 'Live box scores', level: lb.late.length ? 'warn' : 'ok',
      detail: lb.tracked ? (lb.late.length ? `${lb.late.length} of ${lb.tracked} live game(s) without a box-score update in the last 5 min` : `${lb.tracked} live game(s), all updated in the last 5 min`) : 'No NBA / EuroLeague / NFL game on right now',
      items: lb.late.slice(0, 15)
    });
  } catch (e: any) {
    checks.push({ id: 'live-box', label: 'Live box scores', level: 'warn', detail: `Check failed: ${e.message}` });
  }
  // fix209: every live / finished game of the last 48 h shows its scorers (football goals with a name, basketball top
  // scorer once a box score exists, NFL scoring plays when a side has points); a gap older than 10 min is listed
  try {
    const sc = scorersHealth();
    checks.push({
      id: 'scorers', label: 'Scorers shown', level: sc.late.length ? 'warn' : 'ok',
      detail: sc.lastRun === null && !sc.checked ? 'Starting up (first check a few minutes after start)' : sc.late.length ? `${sc.late.length} of ${sc.checked} game(s) with goals / points but no scorer for 10+ min (fetched again automatically)` : `${sc.checked} game(s) checked, every scorer shown`,
      items: sc.late.slice(0, 20)
    });
  } catch (e: any) {
    checks.push({ id: 'scorers', label: 'Scorers shown', level: 'warn', detail: `Check failed: ${e.message}` });
  }
  // fix182: games of a league / cup we predict that fell back to the old table model (v1 / v2), with the reason
  const OLD = new Set(['poisson-dc-v1', 'dc-history-v2']);
  const fallback = matches.filter(m => !FINAL.includes(m.status) && m.prediction && OLD.has(m.prediction.model) && new Date(m.utcDate).getTime() < now + 30 * 86400000);
  const fbItems = fallback.map(m => { let why = ''; try { why = fallbackReason(m); } catch (e: any) { why = e.message; } return `${gameName(m)} · ${m.competition?.name || m.competition?.code} · ${m.prediction.model} · ${why}`; });
  // logged once a day per game
  const day = new Date(now).toISOString().slice(0, 10);
  for (const line of fbItems) { const k = `${day}|${line}`; if (!loggedFallback.has(k)) { loggedFallback.add(k); logger.warn(`v1 fallback: ${line}`); } }
  if (loggedFallback.size > 5000) loggedFallback.clear();
  checks.push({
    id: 'v1-fallback', label: 'Games on v3 / club Elo / national Elo (no old-model fallback)', level: fallback.length ? 'warn' : 'ok',
    detail: fallback.length ? `${fallback.length} game(s) in the next 30 days fell back to the old table model` : 'Every predicted game uses v3, elo-euro or elo-intl',
    items: fbItems.slice(0, 40)
  });
  const badProb = matches.filter(m => {
    const p = m.prediction;
    if (!p || p.locked) return false;
    const vals = [p.home, p.draw, p.away];
    if (vals.some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100)) return true;
    const sum = vals.reduce((a: number, b: number) => a + b, 0);
    return Math.abs(sum - 100) > 1.5;
  });
  await slice();
  checks.push({ id: 'probabilities', label: 'Probabilities add up to 100%', level: badProb.length ? 'fail' : 'ok', detail: badProb.length ? `${badProb.length} prediction(s) with invalid percentages` : 'All predictions add up', items: badProb.slice(0, 15).map(m => `${gameName(m)} · ${m.prediction.home}/${m.prediction.draw}/${m.prediction.away}`) });

  await slice();
  // predictions never settled
  // fix200: past kick-off + 48 h the game is looked up and settled, moved or voided (services/unsettled.ts); "fail" only
  // for games unsettled > 48 h that are not void yet, a voided game is a note ("6 voided this month"), never a fail
  try {
    const cutoff = new Date(now - 4 * 3600 * 1000).toISOString();
    const rows = db.prepare(`SELECT match_id, MAX(home_team) AS home_team, MAX(away_team) AS away_team, MAX(competition_name) AS competition_name, MAX(utc_date) AS utc_date
      FROM predictions WHERE settled = 0 AND utc_date < ? GROUP BY match_id ORDER BY utc_date`).all(cutoff) as any[];
    const old = rows.filter(r => new Date(r.utc_date).getTime() < now - 48 * 3600 * 1000);
    let voided = 0;
    try { voided = voidedThisMonth(now); } catch { /* table missing */ }
    const tries = new Map<number, string>();
    try { for (const t of db.prepare(`SELECT match_id, note FROM settle_lookups`).all() as any[]) tries.set(t.match_id, t.note); } catch { /* none yet */ }
    const note = voided ? ` · ${voided} voided this month` : '';
    checks.push({
      id: 'unsettled', label: 'Finished games are scored in our record', level: old.length ? 'fail' : rows.length ? 'warn' : 'ok',
      detail: rows.length ? `${rows.length} game(s) past kick-off + 4 h not settled yet (${old.length} older than 48 h)${note}` : `Every finished game is settled${note}`,
      items: rows.slice(0, 15).map(r => `${gameName(r)}${tries.has(r.match_id) ? ` · ${tries.get(r.match_id)}` : ''}`)
    });
  } catch (e: any) {
    checks.push({ id: 'unsettled', label: 'Finished games are scored in our record', level: 'warn', detail: `Check failed: ${e.message}` });
  }

  await slice();
  // stored results: outcome matches the score
  try {
    const bad = db.prepare(`SELECT match_id, home_goals, away_goals, outcome FROM results WHERE outcome IN ('H','D','A') AND home_goals IS NOT NULL AND away_goals IS NOT NULL AND outcome != CASE WHEN home_goals > away_goals THEN 'H' WHEN home_goals < away_goals THEN 'A' ELSE 'D' END`).all() as any[];
    checks.push({ id: 'results', label: 'Stored results match the score', level: bad.length ? 'fail' : 'ok', detail: bad.length ? `${bad.length} stored result(s) where the outcome doesn't match the score` : 'All stored results are consistent', items: bad.slice(0, 15).map(r => `match ${r.match_id}: ${r.home_goals}–${r.away_goals} stored as ${r.outcome}`) });
  } catch { /* table missing */ }

  // league tables add up
  const tableIssues: string[] = [];
  for (const [code, st] of footballDataAPI.standings) {
    const total = (st as any)?.standings?.find((s: any) => s.type === 'TOTAL') || (st as any)?.standings?.[0];
    for (const r of total?.table || []) {
      const name = `${code} ${r.team?.shortName || r.team?.name}`;
      if (r.playedGames !== r.won + r.draw + r.lost) tableIssues.push(`${name}: played ${r.playedGames} ≠ ${r.won}+${r.draw}+${r.lost}`);
      if (r.goalDifference !== r.goalsFor - r.goalsAgainst) tableIssues.push(`${name}: goal difference ${r.goalDifference} ≠ ${r.goalsFor}−${r.goalsAgainst}`);
      if (r.points > 3 * r.won + r.draw) tableIssues.push(`${name}: ${r.points} points is more than 3×${r.won}+${r.draw}`);
    }
  }
  await slice();
  checks.push({ id: 'tables', label: 'League tables add up', level: tableIssues.length ? 'fail' : 'ok', detail: tableIssues.length ? `${tableIssues.length} table row(s) don't add up` : `${footballDataAPI.standings.size} tables checked`, items: tableIssues.slice(0, 15) });

  await slice();
  // model history (results used for ratings) not falling behind: a division is behind only when games were
  // actually played after its last stored result (international breaks are not a problem)
  try {
    const rows = db.prepare(`SELECT division, MAX(date) AS last FROM history_matches GROUP BY division`).all() as any[];
    const behind: string[] = [];
    for (const r of rows) {
      if (!r.last) continue;
      // games finished more than 3 days after the last stored result (the results files update a few times a week)
      const after = new Date(new Date(r.last).getTime() + 3 * 86400000).toISOString().slice(0, 10);
      let missed = 0;
      try {
        missed = (db.prepare(`SELECT COUNT(*) AS n FROM af_fixtures WHERE division = ? AND status IN ('FT','AET','PEN') AND date > ? AND kickoff < ?`)
          .get(r.division, after, new Date(now - 86400000).toISOString()) as any).n;
      } catch { /* no fixture store */ }
      await slice();
      if (missed > 0) behind.push(`${r.division}: last result ${r.last}, ${missed} game(s) played since are not in yet`);
    }
    checks.push({
      id: 'history', label: 'Results used by the model are current', level: behind.length ? 'warn' : 'ok',
      detail: behind.length ? `${behind.length} division(s) missing recent results` : `${rows.length} divisions up to date (no games missed; breaks are fine)`,
      items: behind
    });
  } catch { /* table missing */ }

  await slice();
  // daily player check: top scorers of 13 leagues, their pages vs the official lists + sanity checks
  try {
    const a = lastDataAudit();
    if (a) {
      const age = now - new Date(a.at).getTime();
      const mism = (a.issues || []).filter((i: any) => i.kind === 'mismatch' || i.kind === 'not-found').length;
      checks.push({
        id: 'players', label: 'Player pages match the official stats',
        level: age > 48 * 3600 * 1000 ? 'warn' : a.checked && mism > a.checked * 0.15 ? 'warn' : 'ok',
        detail: `${a.matched} of ${a.checked} top scorers match (${a.leagues}) · checked ${ago(age)} ago · ${(a.issues || []).length} note(s)`,
        items: (a.issues || []).slice(0, 25).map((i: any) => `${i.league || ''} ${i.player || ''}: ${i.detail}`)
      });
    }
  } catch { /* no report yet */ }

  // fix211: player photos — coverage (tennis top 100 / 500, basketball squads); fail when one is shown without its credit
  try { checks.push(photoHealth()); } catch (e: any) { logger.warn(`photo health: ${e?.message || e}`); }

  // fix210: freezes and memory — web stalls, worker stalls, worker memory, worker restarts
  try { checks.push(...perfChecks(now)); } catch (e: any) { logger.warn(`perf checks: ${e?.message || e}`); }

  const level: Level = checks.some(c => c.level === 'fail') ? 'fail' : checks.some(c => c.level === 'warn') ? 'warn' : 'ok';
  return { level, at: new Date(now).toISOString(), checks };
}

/* ---------------- scheduler + email ---------------- */

const store = createHealthStore(db);
const failStreak = new Map<string, number>();
let lastEmailAt = 0;

/** fix200: the last stored report (null before the first run on a fresh database) */
export const lastDataHealth = () => store.read();
/** fix200: what /api/data-health returns: the stored report with its "at" time, never computed on the request */
export const storedDataHealth = () => store.read() || NOT_YET;

/** Alert email: what has been failing for 30+ minutes, then what still works. */
export function healthEmail(failing: Check[], all: Check[]) {
  const when = new Date().toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';
  const okCount = all.filter(c => c.level === 'ok').length;
  let body = `<tr><td style="padding:18px 28px 4px">
    <div style="font-size:13px;color:${C.muted};font-weight:600">Data alert</div>
    <div style="font-size:22px;line-height:1.25;font-weight:800;color:${C.red};margin-top:6px">${failing.length === 1 ? esc(failing[0].label) + ' has a problem' : `${failing.length} data feeds have a problem`}</div>
    <div style="font-size:14px;color:${C.muted};margin-top:6px">Failing for 30 minutes or more. ${okCount} of ${all.length} checks are still fine.</div>
  </td></tr>`;
  body += section('What’s wrong');
  body += `<tr><td style="padding:0 28px">${failing
    .map(c => `<div style="border:1px solid ${C.line};border-left:4px solid ${C.red};border-radius:10px;padding:10px 12px;margin:8px 0">
      <div style="font-size:14px;font-weight:700">${esc(c.label)}</div>
      <div style="font-size:13px;color:${C.muted};margin-top:3px">${esc(c.detail)}</div>
      ${c.items?.length ? `<div style="font-size:12px;color:${C.muted};margin-top:6px">${c.items.slice(0, 6).map(i => '· ' + esc(i)).join('<br>')}${c.items.length > 6 ? `<br><span style="color:${C.faint}">+${c.items.length - 6} more</span>` : ''}</div>` : ''}
    </div>`)
    .join('')}</td></tr>`;
  const others = all.filter(c => !failing.includes(c));
  if (others.length) {
    body += section('Everything else');
    body += `<tr><td style="padding:0 28px;font-size:13px;line-height:1.9">${others
      .map(c => `<span style="color:${c.level === 'ok' ? C.green : c.level === 'warn' ? C.amber : C.red}">●</span>&nbsp; ${esc(c.label)}`)
      .join('<br>')}</td></tr>`;
  }
  body += `<tr><td style="height:12px"></td></tr>`;
  const subject = `Data alert: ${failing.map(c => c.label).slice(0, 2).join(', ')}${failing.length > 2 ? ` +${failing.length - 2}` : ''}`;
  const html = layout({
    preheader: `${failing.map(c => c.label).join(', ')}: failing for 30+ minutes.`,
    label: when,
    body,
    cta: { text: 'Open Data health', href: `${SITE}/admin` },
    footer: 'You get at most one alert every 6 hours. It stops by itself once the feed recovers.'
  });
  const text = [
    `SportLikely · data alert · ${when}`,
    'Failing for 30+ minutes:',
    ...failing.map(c => `- ${c.label}: ${c.detail}${c.items?.length ? '\n    ' + c.items.slice(0, 6).join('\n    ') : ''}`),
    '',
    `Data health: ${SITE}/admin`
  ].join('\n');
  return { subject, html, text };
}

async function run() {
  try {
    const last = await dataHealth();
    store.save(last);
    const failing = last.checks.filter(c => c.level === 'fail');
    for (const c of last.checks) failStreak.set(c.id, c.level === 'fail' ? (failStreak.get(c.id) || 0) + 1 : 0);
    const persistent = failing.filter(c => (failStreak.get(c.id) || 0) >= 6); // 30 minutes at 5-minute runs
    if (failing.length) logger.warn(`Data health: ${failing.map(c => c.label).join(', ')}`);
    const to = (process.env.ADMIN_EMAILS || '').split(',').map(x => x.trim()).filter(Boolean);
    if (persistent.length && emailEnabled && to.length && Date.now() - lastEmailAt > 6 * 3600 * 1000) {
      lastEmailAt = Date.now();
      const { subject, html, text } = healthEmail(persistent, last.checks);
      for (const addr of to) await sendEmail(addr, subject, html, text).catch(() => undefined);
    }
  } catch (e: any) {
    logger.warn(`Data health run failed: ${e.message}`);
  }
}

export function startDataHealthScheduler() {
  // fix196: in the heavy() queue (one heavy job at a time, never during a live tick)
  // fix200: every 5 minutes (the endpoint reads the stored copy), the first a minute after start
  afterHeavy('data health', run, 1 * MIN);
  everyHeavy('data health', run, 5 * MIN);
}
