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
 * fix279: only what a person can act on is emailed (a feed stopped for 2 h+, a failed deploy, the disk filling within 3
 * days: utils/alertRules.ts), once per problem, at most one data alert every 6 hours — all stored in the database
 * (adminMail.ts), so a deploy never sends again. The rest goes to the For Claude list and the 07:00 summary.
 */
import { db } from '../db';
import logger from '../utils/logger';
import footballDataAPI from './footballDataAPI';
import { afUpcoming, afWithPredictions, afOverdue, fallbackReason } from './afMatches';
import { afConfigured } from './apiFootball';
import { feedState, bootedAt } from './freshness';
import { emailEnabled, sendEmail } from './email';
import { renderAdminMail, adminUrl, type AdminMail, trackAlerts, markEmailed, limitOk } from './adminMail';
import { DATA_ALERT_GAP_MS } from '../utils/alertRules';
import { lastDataAudit, leagueShare, AUDIT_TARGET } from './dataAudit';
import { everyHeavy, afterHeavy, heavySlicer, inBatches } from './perf';
import { missingPredictions } from './missingPredictions';
import { tennisDataCheck } from './tennis';
import { bbStandingsCheck } from './bbSite';
import { voidedThisMonth } from './unsettled';
import { moreHealth, outputPublic } from './morePredictions';
import { marketHealth } from './marketLines';
import type { MoreSport } from '../utils/moreMath';
import { createHealthStore, NOT_YET } from '../utils/healthStore';
import { LATE_MS } from '../utils/liveBox';
import { BB_MAJOR } from './basketball';
import { bbLiveVsBacktest, predictGameCached } from './bbModel';
import { rowSanityViews, clipSummary } from './bbTuner';
import { scorersHealth } from './scorersCheck';
import { perfChecks } from './perfChecks';
import { photoSourceHealth } from './playerPhotos';
import { fdFreeze, frozenText, israelTime, resultMismatches, afSettledCount, fdTwinless } from './fdReconcile';
import { bestLive } from './liveScores';
import { calibrationHealth } from './calibrationHealth';
import { leagueSettingsHealth } from './leagueSettingsHealth';
import { missingRowHealth, engineHealth } from './bbTuner';
import { afIdOfFd } from './afMatches';
import { seasonForecastChecks } from './seasonForecast';
import { emailHealth } from './pickEmails';
import { pushHealth } from './pushAlerts';
import { keyPlayersHealth } from './keyPlayers';
import { doneForYouHealth } from './doneForYou';
import { gameExtrasHealth } from './gameExtras';
import { deployErrorsHealth } from './deployErrors';
import { slowRequestsHealth, slowAdminRequestsHealth } from './deadline';
import { upsetTextHealth } from './upsetHealth';
import { crawlerHealth } from './crawlerIps';
import { swarmHealth } from './swarmGuard';
import { edgeStatus } from './edgeHops';
import { modelDailyHealth } from './modelDailyHealth';
import { leagueFixHealth } from './leagueFixHealth';
import { diskHealth } from './dbSpace';
import { namesHealth } from './names';
import { careerHealth } from './playerCareers';

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
  // games stuck as live, or never started, after kick-off. fix212: a fail (not a warning) from 30 min after kick-off
  // — the window already carries the freshest source per match (API-Football when Football-Data is behind), so a
  // game still "not started" here is wrong on the site; the items say which source the shown status came from
  const stuck = matches.filter(m => {
    const t = new Date(m.utcDate).getTime();
    if (FINAL.includes(m.status)) return false;
    if (LIVE.includes(m.status)) return t < now - 3 * 3600 * 1000;
    return t < now - 30 * MIN && t > now - 3 * 86400000;
  });
  await slice();
  const sourceOf = (m: any) => {
    const b = m.id < 1_000_000_000 ? bestLive(m.id) : null;
    if (b) return b.source === 'af' ? 'API-Football' : 'Football-Data';
    if (m.id >= 1_000_000_000) return 'API-Football';
    return afIdOfFd(m.id) ? 'Football-Data (API-Football twin linked, no reading)' : 'Football-Data (no API-Football twin)';
  };
  checks.push({
    id: 'stuck', label: 'Games with an up-to-date status', level: stuck.length ? 'fail' : 'ok',
    detail: stuck.length ? `${stuck.length} game(s) still shown as live or not started 30+ min after kick-off${fdFreeze().frozen ? ' · Football-Data frozen, statuses from API-Football' : ''}` : `Every game past kick-off has a live or final status${fdFreeze().frozen ? ' (Football-Data frozen: from API-Football)' : ''}`,
    items: stuck.slice(0, 15).map(m => `${gameName(m)} · ${m.status}${m.minute ? ` ${m.minute}'` : ''} · source: ${sourceOf(m)}${m.lastUpdated ? ` · FD lastUpdated ${String(m.lastUpdated).slice(11, 16)} UTC` : ''}`)
  });
  const overdueAf = afOverdue();
  if (overdueAf.length) {
    const c = checks[checks.length - 1];
    c.items = [...(c.items || []), ...overdueAf.filter(o => !stuck.some(s => s.id === o.id)).slice(0, 10).map(o => `${o.home} – ${o.away} (${o.competition}) · ${o.status}`)];
  }

  // fix212: the Football-Data feed moving (lastUpdated advancing while games are on), and the results we had to settle
  // from API-Football — with the ones Football-Data later disagreed on
  const fz = fdFreeze();
  checks.push({
    id: 'fd-moving', label: 'Football-Data feed moving', level: fz.frozen ? 'fail' : 'ok',
    detail: fz.frozen ? `${frozenText(fz)} — statuses, minutes and scores of its matches come from API-Football until it moves` : `Newest match update ${fz.newest ? `${israelTime(fz.newest)} (Israel time)` : 'not seen yet'}${fz.recoveredAt ? ` · recovered ${israelTime(fz.recoveredAt)}` : ''}`
  });
  // fix212b: an FD game of the coming days without an API-Football twin is a warning before kick-off, not a fail after
  if (afConfigured()) {
    const tw = fdTwinless();
    checks.push({
      id: 'fd-twins', label: 'Football-Data games linked to API-Football (next 7 days)', level: tw.list.length ? 'warn' : 'ok',
      detail: tw.list.length ? `${tw.list.length} game(s) without an API-Football twin — a freeze would leave them stale; add an alias (team_aliases) if the names differ` : `Every game linked${tw.at ? ` · checked ${ago(now - tw.at)} ago` : ''}`,
      items: [
        ...tw.list.slice(0, 20).map(x => {
          // fix264: the alias job's best guess for it (applied only when unambiguous)
          const p = tw.proposals.find(q => q.fdId === x.id && !q.applied);
          return `${x.name} · ${x.kickoff.slice(0, 16).replace('T', ' ')} UTC · FD ${x.id}${p ? ` · ${p.candidate ? `closest API-Football game: ${p.candidate} (score ${p.score}, not sure enough to apply)` : 'no API-Football game near that kick-off'}` : ''}`;
        }),
        ...tw.proposals.filter(p => p.applied && p.aliases.length).map(p => `alias added: ${p.aliases.join('; ')} (${p.game})`)
      ]
    });
  }
  try {
    const mm = resultMismatches();
    const n = afSettledCount(7);
    checks.push({
      id: 'result-sources', label: 'Results agree between the two providers', level: mm.length ? 'warn' : 'ok',
      detail: mm.length ? `${mm.length} result(s) where Football-Data's final differs from the API-Football final we settled on` : `${n} game(s) settled from API-Football in 7 days (Football-Data had no final 20 min after the end); no disagreement`,
      items: mm.map(x => `match ${x.match_id}: API-Football ${x.af}, Football-Data ${x.fd} (${x.at.slice(0, 16).replace('T', ' ')} UTC)`)
    });
  } catch { /* table missing */ }
  await slice();
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
  // fix278: Close to the market (<sport>) — red when a public output's median gap to the closing line over the last 7 days
  // is over its limit, yellow while the market lines are collected (under 300 settled games)
  try {
    for (const r of marketHealth((sport, output) => outputPublic(sport as MoreSport, output))) checks.push(r);
  } catch (e: any) {
    checks.push({ id: 'market-close-check', label: 'Close to the market', level: 'warn', detail: `Check failed: ${e.message}` });
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
    // fix240: a game in Admin → Needs you (no final at either provider 48 h after kick-off, "Enter result" / "Void")
    // is waiting for a person, not lost: warn. Fail = older than 48 h and in nobody's hands (the lookups never reached it).
    const waiting = new Set<number>();
    try { for (const r of db.prepare(`SELECT match_id FROM settle_review WHERE resolved_at IS NULL`).all() as any[]) waiting.add(r.match_id); } catch { /* none yet */ }
    // looked up in the last 2 h: the hourly run has it (it moves to Needs you on its next pass after 48 h)
    const looked = new Set<number>();
    try { for (const r of db.prepare(`SELECT match_id FROM settle_lookups WHERE updated_at >= ?`).all(new Date(now - 2 * 3600 * 1000).toISOString()) as any[]) looked.add(r.match_id); } catch { /* none yet */ }
    const old = rows.filter(r => new Date(r.utc_date).getTime() < now - 48 * 3600 * 1000);
    const lost = old.filter(r => !waiting.has(r.match_id) && !looked.has(r.match_id));
    let voided = 0;
    try { voided = voidedThisMonth(now); } catch { /* table missing */ }
    const tries = new Map<number, string>();
    try { for (const t of db.prepare(`SELECT match_id, note FROM settle_lookups`).all() as any[]) tries.set(t.match_id, t.note); } catch { /* none yet */ }
    const note = voided ? ` · ${voided} voided this month` : '';
    const inNeeds = old.filter(r => waiting.has(r.match_id)).length;
    checks.push({
      id: 'unsettled', label: 'Finished games are scored in our record', level: lost.length ? 'fail' : rows.length ? 'warn' : 'ok',
      detail: rows.length ? `${rows.length} game(s) past kick-off + 4 h not settled yet (${old.length} older than 48 h${inNeeds ? `, ${inNeeds} watched: settled by a final or void at 7 days` : ''})${note}` : `Every finished game is settled${note}`,
      items: rows.slice(0, 15).map(r => `${gameName(r)}${waiting.has(r.match_id) ? ' · watched (void at 7 days)' : ''}${tries.has(r.match_id) ? ` · ${tries.get(r.match_id)}` : ''}`)
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
      // fix240: every listed league must reach 95 % (players whose club played in the last 30 h and whose numbers the
      // provider is still updating are left out and checked again); every remaining note says why
      const issues = (a.issues || []) as any[];
      const bad = issues.filter(i => i.kind === 'mismatch' || i.kind === 'not-found');
      const lag = issues.filter(i => i.kind === 'lag');
      const known = issues.filter(i => i.kind === 'known'); // fix275: provider and league disagree for good — not counted
      const by = (a.byLeague || {}) as Record<string, { checked: number; matched: number; lag?: number; known?: number }>;
      const low = Object.entries(by).filter(([, t]) => { const s = leagueShare(t); return s != null && s < (a.target ?? AUDIT_TARGET); });
      const pct = (t: { checked: number; matched: number; lag?: number; known?: number }) => Math.round((leagueShare(t) ?? 1) * 100);
      checks.push({
        id: 'players', label: 'Player pages match the official stats',
        level: age > 48 * 3600 * 1000 || low.length ? 'warn' : 'ok',
        detail: `${a.matched} of ${a.checked - (a.lag || 0) - (a.known || 0)} top scorers match (${a.leagues})${lag.length ? ` · ${lag.length} still updating after a game` : ''}${known.length ? ` · ${known.length} known provider / league difference(s), not counted` : ''} · checked ${ago(age)} ago`
          + (low.length ? ` · under 95 %: ${low.map(([c, t]) => `${c} ${pct(t)} %`).join(', ')}` : ' · every league 95 %+'),
        // fix264: a player whose page waits for the provider's update after a game is "updating", not a difference
        items: [...bad.map((i: any) => `${i.league || ''} ${i.player || ''}: ${i.detail}${i.reason ? ` — ${i.reason}` : ''}`),
          ...lag.map((i: any) => `updating · ${i.league || ''} ${i.player || ''}: ${i.detail} — not counted until the provider's next update`),
          ...known.map((i: any) => `known · ${i.league || ''} ${i.player || ''}: ${i.detail} — provider and league disagree (known), not counted`)].slice(0, 25)
      });
    }
  } catch { /* no report yet */ }

  // fix241: "Photo sources: official only" (replaces fix211's "Player photos"): fail when a non-official photo is stored
  // fix216: picks emails — every person due today got one (or a skip reason), bounces, record lines = the public record
  try { checks.push(...emailHealth(now)); } catch (e: any) { logger.warn(`email health: ${e?.message || e}`); }
  // fix226: push alerts — failed device sends (warn > 5%) and no alert sent twice to anyone
  try { checks.push(...pushHealth(now)); } catch (e: any) { logger.warn(`push health: ${e?.message || e}`); }
  try { checks.push(photoSourceHealth()); } catch (e: any) { logger.warn(`photo health: ${e?.message || e}`); }
  // fix267: "Player careers" — the share of each sport's top 100 players with a complete career
  try { checks.push(careerHealth()); } catch (e: any) { logger.warn(`career health: ${e?.message || e}`); }
  // fix272: "Names (he / ar)" — entries per language and in the map the pages load (it stayed empty 9 h after fix261)
  try { checks.push(namesHealth(now)); } catch (e: any) { logger.warn(`names health: ${e?.message || e}`); }
  // fix217: basketball leagues (NBA first) — the last 30 days' hit rate against the league's backtest (50+ games)
  try {
    const list = bbLiveVsBacktest(now);
    const bad = list.filter(x => x.warn);
    checks.push({
      id: 'bb-vs-backtest', label: 'NBA vs backtest (basketball leagues, last 30 days)', level: bad.length ? 'warn' : 'ok',
      detail: list.length ? `${list.length} league(s) with 50+ games · ${bad.length ? `${bad.map(x => `${x.code} ${x.hitRate}% vs ${x.backtest}%`).join(', ')} more than 8 points under` : 'all within 8 points of their backtest'}` : 'no league with 50+ finished games in 30 days yet',
      items: list.map(x => `${x.code}: ${x.hitRate}% right over ${x.games} games, backtest ${x.backtest}% (${x.gap >= 0 ? '+' : ''}${x.gap})`)
    });
  } catch (e: any) { logger.warn(`bb vs backtest: ${e?.message || e}`); }
  // fix219: bb-v4 row sanity — no row of an upcoming game (48 h) more than 3 sd from its training spread
  try {
    const up = db.prepare(`SELECT game_id, code, season, kickoff, status, home_id, away_id, hs, as_, stage AS week, home_name, away_name FROM bb_games
      WHERE (status IS NULL OR status = 'NS') AND kickoff > ? AND kickoff < ? ORDER BY kickoff LIMIT 400`).all(new Date(now).toISOString(), new Date(now + 48 * 3600 * 1000).toISOString()) as any[];
    const preds = up.map(g => ({ g, p: predictGameCached(g), label: `${g.code} ${g.home_name} – ${g.away_name}` }));
    const views = preds.filter(x => x.p?.grid).map(x => ({ label: x.label, view: x.p!.grid! }));
    // fix238: a game with a row out of range (or a short rotation) is shown with bb-v3 — handled, listed; still warn
    // when bb-v4 is shown with an out-of-range row (its group's test season said bb-v4 is better there)
    const off = preds.filter(x => x.p?.gridOff?.length);
    // fix288: a row beyond 3 sd of its training range (measured on the games where the row is in play) is held at 3 sd
    // before it enters the points (listed: value → the value used); warn only for such a value on a row the clip leaves
    const clipped = preds.filter(x => x.p?.gridClip?.length);
    const r = rowSanityViews(views);
    checks.push({
      id: 'bb-grid-rows', label: 'Basketball model rows (bb-v4) within their usual range', level: r.loose.length ? 'warn' : 'ok',
      detail: views.length || off.length
        ? `${r.checked + off.length} upcoming game(s) · ${r.bad.length ? `${r.bad.length} row value(s) beyond 3 sd of all training games shown with bb-v4` : 'every row shown with bb-v4 inside 3 sd of training'}${clipped.length ? ` · ${clipped.length} game(s) with a row held at 3 sd of its in-play range (clipped before the points)` : ''}${r.loose.length ? ` · ${r.loose.length} value(s) beyond it on a row that is not clipped` : ''}${off.length ? ` · ${off.length} game(s) shown with bb-v3 (a row out of range or a short rotation)` : ''}`
        : 'no upcoming bb-v4 game in 48 h',
      items: [...((c = clipSummary()) => (c ? [c] : []))(), ...r.loose, ...clipped.map(x => `${x.label}: clipped — ${x.p!.gridClip!.join('; ')}`), ...off.map(x => `${x.label}: shown with bb-v3 — ${x.p!.gridOff!.join('; ')}`), ...r.bad].slice(0, 40)
    });
  } catch (e: any) { logger.warn(`bb grid rows: ${e?.message || e}`); }
  // fix220: calibration, every sport — said vs happened per band of the last 30 days' picks (error: a band of 50+
  // games more than 5 points off, 100+ games in all)
  try { checks.push(...calibrationHealth(now)); } catch (e: any) { logger.warn(`calibration health: ${e?.message || e}`); }
  // fix223: the per-league settings of every sport refitted in the last 35 days (and, basketball, on the live shared tune)
  try { checks.push(...leagueSettingsHealth(now)); } catch (e: any) { logger.warn(`league settings health: ${e?.message || e}`); }
  // fix215: season forecast — every league re-run after its last finished game, zone rules, position chances add up, last season's replay
  try { checks.push(...keyPlayersHealth(now)); } catch (e: any) { logger.warn(`key players health: ${e?.message || e}`); }
  // fix253: nothing waits for a person (only contact messages and payment issues may)
  try { checks.push(doneForYouHealth(now)); } catch (e: any) { logger.warn(`done for you health: ${e?.message || e}`); }
  // fix228: basketball row #4 — the weight live (frozen at the who-actually-played fit) and the games it moved this week
  try { checks.push(...missingRowHealth(now)); } catch (e: any) { logger.warn(`missing players row health: ${e?.message || e}`); }
  // fix236: which engine each basketball group runs (v3 / v4), why and since when; warn when the NBA runs bb-v3
  try { checks.push(...engineHealth()); } catch (e: any) { logger.warn(`bb engine health: ${e?.message || e}`); }
  // fix231: weather / referee / trends / difficulty on the next 48 h's games (warn under 80% with their weather card)
  try { checks.push(...gameExtrasHealth(now)); } catch (e: any) { logger.warn(`game extras health: ${e?.message || e}`); }
  // fix242: upset watch — the favourite named in the text is the side with the higher win %, a reason on every game, max 10 a week
  try { checks.push(...upsetTextHealth(now)); } catch (e: any) { logger.warn(`upset watch health: ${e?.message || e}`); }
  // fix277: scraper swarms — yellow while one is challenged, red if a trusted user-agent or a verified engine got the challenge
  try { checks.push(swarmHealth()); } catch (e: any) { logger.warn(`swarm health: ${e?.message || e}`); }
  // fix245: search engines verified (list / DNS); fail when a request from Google's ranges got a 429 / 503 today
  try { checks.push(...crawlerHealth(edgeStatus())); } catch (e: any) { logger.warn(`crawler health: ${e?.message || e}`); }
  // fix251: the football daily learning — warn after 30 days without a promotion while the best candidate is better in both windows
  try { checks.push(...modelDailyHealth(now)); } catch (e: any) { logger.warn(`model daily health: ${e?.message || e}`); }
  // fix255: a league with 60+ games under 50% on 1X2 on each of the last 30 days (the nightly league test)
  try { checks.push(...leagueFixHealth()); } catch (e: any) { logger.warn(`league fix health: ${e?.message || e}`); }
  try { checks.push(...seasonForecastChecks()); } catch (e: any) { logger.warn(`season forecast health: ${e?.message || e}`); }

  // fix210: freezes and memory — web stalls, worker stalls, worker memory, worker restarts
  try { checks.push(...perfChecks(now)); } catch (e: any) { logger.warn(`perf checks: ${e?.message || e}`); }
  // fix227: 5xx answered in the 5 minutes after the last start (files and pages: target 0)
  try { checks.push(...deployErrorsHealth()); } catch (e: any) { logger.warn(`deploy errors health: ${e?.message || e}`); }
  // fix250: public requests over 1 s in the last hour (services/deadline.ts)
  try { checks.push(slowRequestsHealth()); } catch (e: any) { logger.warn(`slow requests health: ${e?.message || e}`); }
  // fix266: admins' requests apart (an admin's list waited for the worker: 3–53 s on 28 Oct, no check saw it)
  try { checks.push(slowAdminRequestsHealth()); } catch (e: any) { logger.warn(`slow admin requests health: ${e?.message || e}`); }

  // fix249: volume free, database size and 7-day growth (warn when it would fill the volume within 30 days); reads over 500 ms for 3 h
  try { checks.push(...diskHealth()); } catch (e: any) { logger.warn(`disk health: ${e?.message || e}`); }

  const level: Level = checks.some(c => c.level === 'fail') ? 'fail' : checks.some(c => c.level === 'warn') ? 'warn' : 'ok';
  return { level, at: new Date(now).toISOString(), checks };
}

/* ---------------- scheduler + email ---------------- */

const store = createHealthStore(db);

/** fix200: the last stored report (null before the first run on a fresh database) */
export const lastDataHealth = () => store.read();
/** fix200: what /api/data-health returns: the stored report with its "at" time, never computed on the request */
export const storedDataHealth = () => store.read() || NOT_YET;
/** fix259: a check's last 3 values (newest first), for "Copy for Claude" */
export const dataHealthHistory = (id: string) => store.history(id);

/** Alert email: what has been failing for 30+ minutes, then what still works. */
/** Alert email (fix239: the admin template): what has been failing for 30+ minutes, then what still works. */
export function healthEmail(failing: Check[], all: Check[]) {
  const okCount = all.filter(c => c.level === 'ok').length;
  const title = failing.length === 1 ? `${failing[0].label}: failing` : `${failing.length} data checks failing`;
  const mail: AdminMail = {
    label: 'Data health', tone: 'fail', title,
    what: `${failing.length === 1 ? `“${failing[0].label}” has` : `${failing.length} checks have`} been red for a while (a feed 2 hours, anything else 30 minutes); ${okCount} of ${all.length} checks are still fine.`,
    todo: 'Open the check in Admin and do what its card says; most feeds recover by themselves, so tell Claude only if it is still red in a few hours.',
    rows: [
      ...failing.map(c => ({ title: c.label, detail: [c.detail, ...(c.items || []).slice(0, 6)].join(' · ') + ((c.items?.length || 0) > 6 ? ` · +${c.items!.length - 6} more` : ''), tone: 'fail' as const })),
      ...all.filter(c => !failing.includes(c) && c.level !== 'ok').slice(0, 8).map(c => ({ title: c.label, detail: c.detail, tone: c.level === 'warn' ? 'warn' as const : 'fail' as const }))
    ],
    buttons: [{ text: 'Open in Admin', href: adminUrl('needs-you') }],
    footer: 'One email per problem: while it stays red it is listed once a day in the 07:00 summary, not emailed again. At most one data alert every 6 hours.'
  };
  const subject = `Site problem: ${failing.map(c => c.label).slice(0, 2).join(', ')}${failing.length > 2 ? ` +${failing.length - 2}` : ''}`;
  return { subject, ...renderAdminMail(mail) };
}

async function run() {
  try {
    const last = await dataHealth();
    store.save(last);
    const failing = last.checks.filter(c => c.level === 'fail');
    if (failing.length) logger.warn(`Data health: ${failing.map(c => c.label).join(', ')}`);
    await alertFrom(last.checks);
  } catch (e: any) {
    logger.warn(`Data health run failed: ${e.message}`);
  }
}

/**
 * fix279: the email part, every state in the database (a deploy never sends again): only checks a person can act on
 * (utils/alertRules.ts), each problem once while it stays red, at most one data alert every 6 hours.
 */
export async function alertFrom(checks: Check[], now = Date.now()): Promise<{ sent: string[] }> {
  const to = (process.env.ADMIN_EMAILS || '').split(',').map(x => x.trim()).filter(Boolean);
  const due = pickDataAlert(checks, now, emailEnabled && to.length > 0);
  if (!due.length) return { sent: [] };
  const { subject, html, text } = healthEmail(due, checks);
  for (const addr of to) await sendEmail(addr, subject, html, text).catch(() => undefined);
  return { sent: due.map(c => c.id) };
}
/** the checks this run emails (state moved on, the 6-hour clock and "emailed" stored); `canSend` false = none */
export function pickDataAlert(checks: Check[], now = Date.now(), canSend = true): Check[] {
  const due = trackAlerts(checks, now);
  if (!due.length || !canSend) return [];
  if (!limitOk('data-alert', DATA_ALERT_GAP_MS, now)) return [];
  markEmailed(due.map(c => c.id), now);
  return due;
}

export function startDataHealthScheduler() {
  // fix196: in the heavy() queue (one heavy job at a time, never during a live tick)
  // fix200: every 5 minutes (the endpoint reads the stored copy), the first a minute after start
  afterHeavy('data health', run, 1 * MIN);
  everyHeavy('data health', run, 5 * MIN);
}
