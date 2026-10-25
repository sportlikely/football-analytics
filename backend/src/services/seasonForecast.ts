/**
 * fix215 — season forecast: every league of the current season simulated to the end 20,000 times with our own match
 * model (utils/seasonSim.ts, rules in utils/seasonRules.ts), for football, basketball and American football.
 *
 * Inputs (built here, in the worker, sliced):
 *   Football     the season's fixtures from af_fixtures (the API-Football twin of every league we predict; leagues
 *                outside that feed: their fixtures fetched here every 6 h into sf_fixtures), finished games also from
 *                our settled results (they arrive within 10 min, the fixture feed every 6 h), the table computed from
 *                those games (a points deduction in the provider's table is kept); every remaining game from our saved
 *                prediction (the main model: tracking.mainRank), else v3 for that pair (predictV3ByNames), else the
 *                teams' ratings fitted to our predictions of the season.
 *   Basketball   bb_games (regular season of the current season), bb-v3 for every remaining game (saved, else
 *                predictGame); NBA conferences from the provider's table.
 *   American football   nfl_games (regular season), our saved prediction, else nfl-v1 / ncaa-v1 Elo for the pair.
 * Ratings for the games that only exist inside a run (split-season groups, play-offs): least squares on the game
 * means of our predictions (rating difference + home advantage), on the same scale.
 *
 * Runs: in a worker thread (threadJob 'season sim'); in-process builds pause every 250 runs. Each league is run again
 * 10 minutes after a new finished game of that league (5-minute check), every night at 02:00 UTC, and at start-up when
 * its copy is older than a day. Stored: season_forecast (one row per league), season_forecast_games (what each watched
 * game means), season_forecast_teams (team → league), season_forecast_history (one row per team per day).
 *
 * Past seasons (the accuracy replay, seasonAccuracy) are admin-only.
 */
import { db } from '../db';
import logger from '../utils/logger';
import { yieldLoop, yieldEvery, every, after, heavy } from './perf';
import { threadJobsOn, inThread } from './threadJob';
import { simulateSeason, simulateSeasonAsync, probitOf, marginOf, hashSeed, type LeagueRules, type SimGame, type SimPlayed, type SimParams, type SimOut, type ZoneKey, type SimSport } from '../utils/seasonSim';
import { fitRatings, tableOf, rankNow, median, r4, type LeagueInput, type ReplayLeague, type ReplayOut, replayHere, fitNoiseHere } from '../utils/seasonFit';
import { FD_TWIN, FOOTBALL_RULES, FOOTBALL_SKIP, BASKETBALL_RULES, NFL_RULES, rulesFor, SIM_PARAMS } from '../utils/seasonRules';
import { AF_LEAGUES, afGet, afBudgetLeft, afConfigured } from './apiFootball';
import { AF_OFFSET, EXTRA_COMPETITIONS, currentSeason, afStandingsCached } from './afMatches';
import footballDataAPI from './footballDataAPI';
import { mainRank } from './tracking';
import { predictV3ByNames } from './gridModel';
import { BB_LEAGUES } from './basketball';
import { predictGame, isPreseason } from './bbModel';
import { bbStandings } from './bbSite';
import { stageKind } from '../utils/bbStandingsGroups';
import { HIDE_OTHER, nflCurrentSeason, type LeagueId } from './nfl';
import { nflRatings } from './nflModel';
import { weekKey } from './nflSite';

export type FcSport = SimSport;
const DAY = 86400000, MIN = 60000;
const NFL_CODES: Record<string, LeagueId> = { NFL: 1, NCAA: 2 };

db.exec(`
  CREATE TABLE IF NOT EXISTS season_forecast (
    sport TEXT NOT NULL, code TEXT NOT NULL, name TEXT, season TEXT NOT NULL,
    run_at TEXT NOT NULL, runs INTEGER NOT NULL, ms INTEGER, games_left INTEGER, known INTEGER NOT NULL DEFAULT 0,
    last_final TEXT, final_seen TEXT, rules TEXT, zones TEXT, groups_ TEXT, teams TEXT NOT NULL, note TEXT,
    PRIMARY KEY (sport, code)
  );
  CREATE TABLE IF NOT EXISTS season_forecast_games (
    sport TEXT NOT NULL, game_id TEXT NOT NULL, code TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (sport, game_id)
  );
  CREATE TABLE IF NOT EXISTS season_forecast_teams (
    sport TEXT NOT NULL, team_id TEXT NOT NULL, code TEXT NOT NULL, PRIMARY KEY (sport, team_id, code)
  );
  CREATE TABLE IF NOT EXISTS season_forecast_history (
    sport TEXT NOT NULL, code TEXT NOT NULL, season TEXT NOT NULL, day TEXT NOT NULL, team_id TEXT NOT NULL, json TEXT NOT NULL,
    PRIMARY KEY (sport, code, season, day, team_id)
  );
  CREATE TABLE IF NOT EXISTS season_forecast_skips (
    sport TEXT NOT NULL, code TEXT NOT NULL, name TEXT, reason TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (sport, code)
  );
  CREATE TABLE IF NOT EXISTS season_forecast_accuracy (
    sport TEXT NOT NULL, code TEXT NOT NULL, season TEXT NOT NULL, json TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (sport, code)
  );
  CREATE TABLE IF NOT EXISTS sf_fixtures (
    fixture_id INTEGER PRIMARY KEY, league_id INTEGER NOT NULL, season INTEGER NOT NULL, round TEXT, kickoff TEXT NOT NULL,
    status TEXT, home_id INTEGER, away_id INTEGER, home_name TEXT, away_name TEXT, hg INTEGER, ag INTEGER, at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sf_fixtures_league ON sf_fixtures(league_id, season);
`);

/* ---------- inputs ---------- */

interface Skip { sport: FcSport; code: string; name: string; reason: string }

const FINAL = new Set(['FT', 'AET', 'PEN', 'AWD', 'WO']);
const GONE = new Set(['CANC', 'ABD']);

/* football */

function footballLeagues(): { code: string; afId: number; own: boolean }[] {
  const out = new Map<string, { code: string; afId: number; own: boolean }>();
  const twin = new Map(Object.entries(FD_TWIN).map(([c, id]) => [id, c] as [number, string]));
  for (const [code, id] of Object.entries(FD_TWIN)) out.set(code, { code, afId: id, own: false });
  for (const l of AF_LEAGUES) if (!twin.has(l.id)) out.set(`AF${l.id}`, { code: `AF${l.id}`, afId: l.id, own: false });
  for (const c of EXTRA_COMPETITIONS) if (c.kind === 'league' && !out.has(`AF${c.id}`)) out.set(`AF${c.id}`, { code: `AF${c.id}`, afId: c.id, own: true });
  return [...out.values()];
}

/** leagues outside the API-Football fixture feed: their season's fixtures, every 6 h (1 call each) */
async function syncOwnFixtures(afId: number): Promise<number | null> {
  const last: any = db.prepare(`SELECT MAX(at) at, MAX(season) season FROM sf_fixtures WHERE league_id = ?`).get(afId);
  if (last?.at && Date.now() - Date.parse(last.at) < 6 * 3600 * 1000) return last.season;
  if (!afConfigured() || afBudgetLeft() < 1000) return last?.season ?? null;
  const season = await currentSeason(afId);
  if (!season) return last?.season ?? null;
  const json: any = await afGet('/fixtures', { league: afId, season });
  const up = db.prepare(`INSERT INTO sf_fixtures (fixture_id, league_id, season, round, kickoff, status, home_id, away_id, home_name, away_name, hg, ag, at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(fixture_id) DO UPDATE SET round = excluded.round, kickoff = excluded.kickoff,
    status = excluded.status, hg = excluded.hg, ag = excluded.ag, at = excluded.at`);
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    for (const f of json?.response || []) {
      if (!f.fixture?.id || !f.fixture?.date) continue;
      up.run(f.fixture.id, afId, season, f.league?.round || null, f.fixture.date, f.fixture.status?.short || null, f.teams?.home?.id, f.teams?.away?.id,
        f.teams?.home?.name, f.teams?.away?.name, f.goals?.home ?? null, f.goals?.away ?? null, now);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return season;
}

/** the regular season of a league: a round name that is a play-off / final is left out */
const NOT_REGULAR = /play.?off|final|relegation|promotion|qualif|knock/i;

async function footballInput(L: { code: string; afId: number; own: boolean }, nowIso: string): Promise<LeagueInput | Skip> {
  const name = (db.prepare(`SELECT competition_name n FROM predictions WHERE competition_code = ? ORDER BY utc_date DESC LIMIT 1`).get(L.code) as any)?.n || L.code;
  if (FOOTBALL_SKIP[L.code]) return { sport: 'football', code: L.code, name, reason: FOOTBALL_SKIP[L.code] };
  let rows: any[];
  let season: number | null;
  if (L.own) {
    season = await syncOwnFixtures(L.afId).catch(e => { logger.warn(`season forecast: fixtures ${L.code}: ${e?.message || e}`); return null; });
    rows = season ? (db.prepare(`SELECT fixture_id, kickoff, status, home_id, away_id, home_name, away_name, hg, ag, round, NULL grp, NULL fh, NULL fa FROM sf_fixtures WHERE league_id = ? AND season = ?`).all(L.afId, season) as any[]).filter(r => !NOT_REGULAR.test(r.round || '')) : [];
  } else {
    const s: any = db.prepare(`SELECT season FROM af_fixtures WHERE league_id = ? AND COALESCE(status, 'NS') IN ('NS','TBD','PST') AND kickoff >= ? ORDER BY kickoff LIMIT 1`).get(L.afId, new Date(Date.now() - 7 * DAY).toISOString());
    season = s?.season ?? null;
    rows = season ? db.prepare(`SELECT f.fixture_id, f.kickoff, f.status, f.home_id, f.away_id, f.home_name, f.away_name, f.hg, f.ag, f.grp, th.fd_name fh, ta.fd_name fa
      FROM af_fixtures f LEFT JOIN af_teams th ON th.grp = f.grp AND th.team_id = f.home_id LEFT JOIN af_teams ta ON ta.grp = f.grp AND ta.team_id = f.away_id
      WHERE f.league_id = ? AND f.season = ?`).all(L.afId, season) as any[] : [];
  }
  if (!season || !rows.length) return { sport: 'football', code: L.code, name, reason: 'no fixtures of the current season stored' };
  const isFd = !!FD_TWIN[L.code];
  // public ids: Football-Data.org match / team ids for its leagues, else API-Football + offset
  const links = new Map<number, { fd: number; swapped: boolean }>();
  if (isFd) for (const r of db.prepare(`SELECT fd_id, af_id, swapped FROM fd_af_links WHERE af_id IN (SELECT fixture_id FROM af_fixtures WHERE league_id = ? AND season = ?) OR af_id - ? IN (SELECT fixture_id FROM af_fixtures WHERE league_id = ? AND season = ?)`).all(L.afId, season, AF_OFFSET, L.afId, season) as any[]) {
    links.set(r.af_id >= AF_OFFSET ? r.af_id - AF_OFFSET : r.af_id, { fd: r.fd_id, swapped: !!r.swapped });
  }
  const pubGame = (fid: number) => isFd ? (links.get(fid)?.fd ?? AF_OFFSET + fid) : AF_OFFSET + fid;
  // team ids: the FD id of the same football-data.co.uk name (team_map), else API-Football + offset
  const fdTeam = new Map<number, number>();
  if (isFd) {
    const grp = rows.find(r => r.grp)?.grp;
    const tm = db.prepare(`SELECT team_id FROM team_map WHERE grp = ? AND fd_name = ? AND team_id < ?`);
    for (const r of rows) for (const [id, n] of [[r.home_id, r.fh], [r.away_id, r.fa]] as [number, string | null][]) {
      if (!fdTeam.has(id) && n && grp) { const x: any = tm.get(grp, n, AF_OFFSET); if (x) fdTeam.set(id, x.team_id); }
    }
  }
  const tid = (afTeam: number) => String(fdTeam.get(afTeam) ?? AF_OFFSET + afTeam);

  // settled results arrive before the fixture feed's next sync
  const resOf = db.prepare(`SELECT home_goals, away_goals, outcome FROM results WHERE match_id = ?`);
  const names = new Map<string, string>();
  const played: SimPlayed[] = [], remaining: any[] = [];
  let lastFinal: string | null = null;
  for (const r of rows) {
    if (!r.home_id || !r.away_id) continue;
    const h = tid(r.home_id), a = tid(r.away_id);
    names.set(h, r.home_name); names.set(a, r.away_name);
    const st = String(r.status || 'NS');
    if (GONE.has(st)) continue;
    let hg = r.hg, ag = r.ag, done = FINAL.has(st) && hg != null && ag != null;
    if (!done) {
      const pid = pubGame(r.fixture_id), res: any = resOf.get(pid);
      if (res && res.outcome !== 'VOID' && res.home_goals != null) {
        const sw = isFd && links.get(r.fixture_id)?.swapped;
        hg = sw ? res.away_goals : res.home_goals; ag = sw ? res.home_goals : res.away_goals; done = true;
      }
    }
    if (done) { played.push({ home: h, away: a, hg, ag }); if (!lastFinal || r.kickoff > lastFinal) lastFinal = r.kickoff; }
    else remaining.push({ ...r, h, a });
  }
  if (!remaining.length) return { sport: 'football', code: L.code, name, reason: 'season finished (no games left)' };
  const ids = [...names.keys()];
  // a points deduction: the provider's table, where it has played the same games
  const adj = new Map<string, number>();
  const prov: any = afStandingsCached(L.code) || (footballDataAPI as any).standings?.get?.(L.code);
  const ours = tableOf(ids, played, 'football');
  const total = prov?.standings?.find((s: any) => s.type === 'TOTAL' && !s.group) || prov?.standings?.find((s: any) => s.type === 'TOTAL');
  for (const row of total?.table || []) {
    const id = String(row.team?.id), t = ours.get(id);
    if (t && row.playedGames === t.played && Number.isFinite(row.points) && row.points !== t.pts && Math.abs(row.points - t.pts) <= 15) adj.set(id, row.points - t.pts);
  }

  // our predictions this season: the main model per match (played + upcoming), for the ratings and the games
  const start = rows.reduce((m: string, r: any) => (r.kickoff < m ? r.kickoff : m), '9999');
  const best = new Map<number, any>();
  for (const p of db.prepare(`SELECT match_id, model, p_home, p_draw, p_away, xg_home, xg_away, utc_date, home_team_id, away_team_id FROM predictions WHERE competition_code = ? AND utc_date >= ?`).all(L.code, start) as any[]) {
    const cur = best.get(p.match_id);
    if (mainRank(p.model, p.utc_date) >= 99) continue;
    if (!cur || mainRank(p.model, p.utc_date) < mainRank(cur.model, cur.utc_date)) best.set(p.match_id, p);
  }
  const obs: { h: string; a: string; m: number; w: number }[] = [], ws: number[] = [];
  const nowMs = Date.now();
  for (const p of best.values()) {
    if (!(p.p_home > 0 && p.p_away > 0)) continue;
    const h = String(p.home_team_id), a = String(p.away_team_id);
    if (!names.has(h) || !names.has(a)) continue;
    const { m, w } = probitOf(p.p_home / 100, p.p_away / 100);
    const age = Math.max(0, nowMs - Date.parse(p.utc_date)) / DAY;
    obs.push({ h, a, m, w: Math.exp(-age / 60) }); ws.push(w);
  }
  const step = yieldEvery(25, 50);
  const games: SimGame[] = [];
  const v3Cache = new Map<string, any>();
  const soon = nowMs + 10 * DAY;
  for (const r of remaining) {
    const pid = pubGame(r.fixture_id);
    let p = best.get(pid);
    let pH: number | undefined, pD: number | undefined, pA: number | undefined, xgH: number | undefined, xgA: number | undefined;
    const sw = isFd && links.get(r.fixture_id)?.swapped;
    if (p && p.p_home > 0) {
      [pH, pD, pA] = sw ? [p.p_away / 100, p.p_draw / 100, p.p_home / 100] : [p.p_home / 100, p.p_draw / 100, p.p_away / 100];
      if (p.xg_home > 0 && p.xg_away > 0) [xgH, xgA] = sw ? [p.xg_away, p.xg_home] : [p.xg_home, p.xg_away];
    } else if (r.grp && r.fh && r.fa) {
      const key = `${r.grp}|${r.fh}|${r.fa}|${String(r.kickoff).slice(0, 10)}`;
      let v = v3Cache.get(key);
      if (v === undefined) { try { v = predictV3ByNames(r.grp, r.fh, r.fa, String(r.kickoff)); } catch { v = null; } v3Cache.set(key, v); await step(); }
      if (v && v.home > 0) { pH = v.home / 100; pD = v.draw / 100; pA = v.away / 100; xgH = v.expectedGoals?.home; xgA = v.expectedGoals?.away; }
    }
    if (pH !== undefined && pA !== undefined) { const q = probitOf(pH, pA); obs.push({ h: r.h, a: r.a, m: q.m, w: 1 }); ws.push(q.w); }
    const ko = Date.parse(r.kickoff);
    games.push({ id: String(pid), home: r.h, away: r.a, pH, pD, pA, xgH, xgA, watch: ko <= soon && ko >= nowMs - 3 * 3600 * 1000 });
  }
  const base = SIM_PARAMS.football;
  const fit = fitRatings(ids, obs, base.home);
  const ownTable = tableOf(ids, played, 'football', adj);
  const gp = played.length || 1;
  const params: SimParams = {
    runs: SIM_PARAMS.runs, seed: hashSeed(`football|${L.code}|${nowIso.slice(0, 10)}`), home: fit.home,
    drawBand: Number.isFinite(median(ws)) ? median(ws) : base.drawBand, sigma: 1, noise: noiseFor('football').noise, walk: noiseFor('football').walk,
    goalsH: played.length >= 20 ? played.reduce((s, g) => s + g.hg, 0) / gp : base.goalsH,
    goalsA: played.length >= 20 ? played.reduce((s, g) => s + g.ag, 0) / gp : base.goalsA
  };
  const teams = ids.map(id => ({ ...ownTable.get(id)!, name: names.get(id) || id, rating: fit.r.get(id) || 0 }));
  const rank = rankNow(teams, 'football');
  return {
    sport: 'football', code: L.code, name, season: `${season}`, rules: rulesFor('football', L.code), teams, played, games, params,
    meta: Object.fromEntries(ids.map(id => [id, { rank: rank.get(id) || 0 }])), lastFinal
  };
}

/* basketball */

async function basketballInput(L: { code: string; name: string }, nowIso: string): Promise<LeagueInput | Skip> {
  const lg: any = db.prepare(`SELECT seasons FROM bb_leagues WHERE code = ?`).get(L.code);
  const seasons: string[] = lg ? JSON.parse(lg.seasons || '[]') : [];
  let season: string | null = null, rows: any[] = [];
  for (const s of [seasons[seasons.length - 1], seasons[seasons.length - 2]].filter(Boolean)) {
    rows = (db.prepare(`SELECT game_id, code, season, stage, kickoff, status, home_id, away_id, home_name, away_name, home_logo, away_logo, hs, as_ FROM bb_games WHERE code = ? AND season = ?`).all(L.code, s) as any[])
      .filter(g => stageKind(g.stage) === 'regular' && !isPreseason(g));
    if (rows.some(g => g.status === 'NS' && Date.parse(g.kickoff) > Date.now() - 7 * DAY)) { season = s; break; }
  }
  if (!season) return { sport: 'basketball', code: L.code, name: L.name, reason: 'no regular-season games left' };
  const names = new Map<string, string>(), logos = new Map<string, string | null>();
  const played: SimPlayed[] = [], remaining: any[] = [];
  let lastFinal: string | null = null;
  for (const g of rows) {
    if (!g.home_id || !g.away_id) continue;
    const h = String(g.home_id), a = String(g.away_id);
    names.set(h, g.home_name); names.set(a, g.away_name); logos.set(h, g.home_logo); logos.set(a, g.away_logo);
    if (['FT', 'AOT'].includes(g.status) && g.hs != null && g.as_ != null) { played.push({ home: h, away: a, hg: g.hs, ag: g.as_ }); if (!lastFinal || g.kickoff > lastFinal) lastFinal = g.kickoff; }
    else if (!['CANC', 'ABD', 'AWD'].includes(g.status)) remaining.push(g);
  }
  if (!remaining.length) return { sport: 'basketball', code: L.code, name: L.name, reason: 'no regular-season games left' };
  const rules = rulesFor('basketball', L.code);
  const ids = [...names.keys()];
  const groupOf = new Map<string, string>();
  if (rules.groupBy === 'group') {
    const st: any = await bbStandings(L.code).catch(() => null);
    for (const gr of st?.groups || []) if (gr.level === 'conference' && gr.kind !== 'pre') for (const row of gr.rows) groupOf.set(String(row.team?.id), gr.name || '');
    if (ids.some(id => !groupOf.has(id))) return { sport: 'basketball', code: L.code, name: L.name, reason: 'conferences not known yet (provider table)' };
  }
  const saved = new Map<number, any>();
  for (const p of db.prepare(`SELECT game_id, p_home, margin FROM bb_predictions WHERE code = ? AND kickoff >= ?`).all(L.code, new Date(Date.now() - DAY).toISOString()) as any[]) saved.set(p.game_id, p);
  const base = SIM_PARAMS.basketball;
  const step = yieldEvery(25, 50);
  const games: SimGame[] = [], obs: { h: string; a: string; m: number; w: number }[] = [];
  const nowMs = Date.now(), soon = nowMs + 10 * DAY;
  for (const g of remaining) {
    let pHome: number | undefined, margin: number | undefined;
    const s = saved.get(g.game_id);
    if (s) { pHome = s.p_home; margin = s.margin; }
    else {
      let p: any = null;
      try { p = predictGame({ ...g, week: null }); } catch { p = null; }
      await step();
      if (p) { pHome = p.pHome; margin = p.margin; }
    }
    if (pHome !== undefined) obs.push({ h: String(g.home_id), a: String(g.away_id), m: marginOf(pHome, margin ?? 0, base.sigma).mu, w: 1 });
    const ko = Date.parse(g.kickoff);
    games.push({ id: String(g.game_id), home: String(g.home_id), away: String(g.away_id), pHome, margin, watch: ko <= soon && ko >= nowMs - 3 * 3600 * 1000 });
  }
  const fit = fitRatings(ids, obs, base.home);
  const tab = tableOf(ids, played, 'basketball');
  const teams = ids.map(id => ({ ...tab.get(id)!, name: names.get(id) || id, rating: fit.r.get(id) || 0, group: groupOf.get(id) }));
  const rank = rankNow(teams, 'basketball');
  return {
    sport: 'basketball', code: L.code, name: L.name, season, rules, teams, played, games,
    params: { runs: SIM_PARAMS.runs, seed: hashSeed(`basketball|${L.code}|${nowIso.slice(0, 10)}`), home: fit.home, drawBand: 0, sigma: base.sigma, noise: noiseFor('basketball').noise, walk: noiseFor('basketball').walk, goalsH: 0, goalsA: 0 },
    meta: Object.fromEntries(ids.map(id => [id, { logo: logos.get(id) || null, rank: rank.get(id) || 0 }])), lastFinal
  };
}

/* American football */

const nflRegular = (league: LeagueId) => (r: { stage: string | null; week: string | null }) =>
  league === 1 ? /^regular/i.test(String(r.stage || '')) : /^\d+$/.test(weekKey(r.stage, r.week));

async function nflInput(code: string, nowIso: string): Promise<LeagueInput | Skip> {
  const league = NFL_CODES[code], name = league === 1 ? 'NFL' : 'College football';
  const season = nflCurrentSeason(league);
  if (!season) return { sport: 'nfl', code, name, reason: 'no season stored' };
  const rows = (db.prepare(`SELECT game_id, kickoff, status, stage, week, home_id, away_id, home_pts, away_pts FROM nfl_games WHERE league = ? ${HIDE_OTHER} AND season = ?`).all(league, season) as any[]).filter(nflRegular(league));
  const teamRows = new Map((db.prepare(`SELECT team_id, name, logo, conference, division, level FROM nfl_teams WHERE league = ?`).all(league) as any[]).map(t => [String(t.team_id), t]));
  const played: SimPlayed[] = [], remaining: any[] = [];
  const ids = new Set<string>();
  let lastFinal: string | null = null;
  for (const g of rows) {
    if (!g.home_id || !g.away_id) continue;
    const h = String(g.home_id), a = String(g.away_id);
    ids.add(h); ids.add(a);
    if (['FT', 'AOT'].includes(g.status) && g.home_pts != null) { played.push({ home: h, away: a, hg: g.home_pts, ag: g.away_pts }); if (!lastFinal || g.kickoff > lastFinal) lastFinal = g.kickoff; }
    else if (!['CANC', 'PST'].includes(g.status)) remaining.push(g);
  }
  if (!remaining.length) return { sport: 'nfl', code, name, reason: 'regular season finished' };
  const elo = nflRatings(league);
  const hfaElo = league === 1 ? 48 : 65;
  const saved = new Map<number, any>();
  for (const p of db.prepare(`SELECT game_id, p_home, margin FROM nfl_predictions WHERE season = ?`).all(season) as any[]) saved.set(p.game_id, p);
  const base = SIM_PARAMS.nfl;
  const games: SimGame[] = [], obs: { h: string; a: string; m: number; w: number }[] = [];
  const nowMs = Date.now(), soon = nowMs + 10 * DAY;
  for (const g of remaining) {
    const h = String(g.home_id), a = String(g.away_id);
    let pHome: number | undefined, margin: number | undefined;
    const s = saved.get(g.game_id);
    if (s) { pHome = s.p_home; margin = s.margin; }
    else if (elo.has(g.home_id) && elo.has(g.away_id)) {
      const diff = elo.get(g.home_id)!.elo - elo.get(g.away_id)!.elo + hfaElo;
      pHome = 1 / (1 + 10 ** (-diff / 400)); margin = diff / 25;
    }
    if (pHome !== undefined) obs.push({ h, a, m: marginOf(pHome, margin ?? 0, base.sigma).mu, w: 1 });
    const ko = Date.parse(g.kickoff);
    games.push({ id: String(g.game_id), home: h, away: a, pHome, margin, watch: ko <= soon && ko >= nowMs - 4 * 3600 * 1000 });
  }
  await yieldLoop();
  const list = [...ids];
  const fit = fitRatings(list, obs, base.home);
  const tab = tableOf(list, played, 'nfl');
  const teams = list.map(id => {
    const t = teamRows.get(id);
    const group = league === 1 ? (t?.conference || '') : (t?.level === 'FBS' || t?.level == null ? (t?.conference || 'Independents') : 'other');
    return { ...tab.get(id)!, name: t?.name || id, rating: fit.r.get(id) || 0, group, div: league === 1 ? (t?.division || '') : undefined };
  });
  const rank = rankNow(teams, 'nfl');
  return {
    sport: 'nfl', code, name, season: String(season), rules: rulesFor('nfl', code), teams, played, games,
    params: { runs: SIM_PARAMS.runs, seed: hashSeed(`nfl|${code}|${nowIso.slice(0, 10)}`), home: fit.home, drawBand: 0, sigma: base.sigma, noise: noiseFor('nfl').noise, walk: noiseFor('nfl').walk, goalsH: 0, goalsA: 0 },
    meta: Object.fromEntries(list.map(id => [id, { logo: teamRows.get(id)?.logo || null, rank: rank.get(id) || 0 }])), lastFinal
  };
}

/* ---------- the leagues, their last finished game ---------- */

export interface LeagueRef { sport: FcSport; code: string }
export function allLeagues(): LeagueRef[] {
  return [
    ...footballLeagues().map(l => ({ sport: 'football' as const, code: l.code })),
    ...BB_LEAGUES.map(l => ({ sport: 'basketball' as const, code: l.code })),
    ...Object.keys(NFL_CODES).map(code => ({ sport: 'nfl' as const, code }))
  ];
}
/** the newest finished game per league (cheap: three grouped reads) */
export function lastFinals(): Map<string, string> {
  const out = new Map<string, string>(), since = new Date(Date.now() - 400 * DAY).toISOString();
  const put = (k: string, v: string | null) => { if (v && (!out.get(k) || v > out.get(k)!)) out.set(k, v); };
  const twin = new Map(Object.entries(FD_TWIN).map(([c, id]) => [id, c] as [number, string]));
  for (const r of db.prepare(`SELECT league_id, MAX(kickoff) k FROM af_fixtures WHERE status IN ('FT','AET','PEN','AWD','WO') AND kickoff >= ? GROUP BY league_id`).all(since) as any[]) put(`football|${twin.get(r.league_id) || `AF${r.league_id}`}`, r.k);
  for (const r of db.prepare(`SELECT league_id, MAX(kickoff) k FROM sf_fixtures WHERE status IN ('FT','AET','PEN','AWD','WO') GROUP BY league_id`).all() as any[]) put(`football|AF${r.league_id}`, r.k);
  try {
    for (const r of db.prepare(`SELECT p.competition_code c, MAX(p.utc_date) k FROM results r JOIN predictions p ON p.match_id = r.match_id WHERE r.settled_at >= ? AND r.outcome != 'VOID' GROUP BY p.competition_code`).all(new Date(Date.now() - 30 * DAY).toISOString()) as any[]) put(`football|${r.c}`, r.k);
  } catch { /* results table not there yet */ }
  for (const r of db.prepare(`SELECT code, MAX(kickoff) k FROM bb_games WHERE status IN ('FT','AOT') AND kickoff >= ? GROUP BY code`).all(since) as any[]) put(`basketball|${r.code}`, r.k);
  for (const r of db.prepare(`SELECT league, MAX(kickoff) k FROM nfl_games WHERE status IN ('FT','AOT') AND kickoff >= ? GROUP BY league`).all(since) as any[]) put(`nfl|${r.league === 1 ? 'NFL' : 'NCAA'}`, r.k);
  return out;
}

async function inputOf(ref: LeagueRef, nowIso: string): Promise<LeagueInput | Skip> {
  if (ref.sport === 'football') { const L = footballLeagues().find(l => l.code === ref.code); return L ? footballInput(L, nowIso) : { ...ref, name: ref.code, reason: 'not a league we predict' }; }
  if (ref.sport === 'basketball') { const L = BB_LEAGUES.find(l => l.code === ref.code); return L ? basketballInput(L, nowIso) : { ...ref, name: ref.code, reason: 'not a league we predict' }; }
  return nflInput(ref.code, nowIso);
}

/* ---------- runs ---------- */

const status = { running: false, lastAt: null as string | null, lastLeagues: 0, lastMs: 0, lastError: null as string | null };

/* ---------- fix218: the season uncertainty, fitted by last season's replay (per sport) ---------- */

db.exec(`CREATE TABLE IF NOT EXISTS season_forecast_params (sport TEXT PRIMARY KEY, noise REAL NOT NULL, walk REAL NOT NULL, json TEXT, at TEXT NOT NULL)`);
/** the noise / walk a sport's forecasts use: the fitted pair when the replay has run, else the base (walk 0) */
export function noiseFor(sport: FcSport): { noise: number; walk: number; fitted: boolean } {
  const r = db.prepare(`SELECT noise, walk FROM season_forecast_params WHERE sport = ?`).get(sport) as any;
  if (r) return { noise: r.noise, walk: r.walk, fitted: true };
  return { noise: SIM_PARAMS[sport].noise, walk: 0, fitted: false };
}
/**
 * ">99 %" / "<1 %" are shown only when the replay says that level is calibrated: at least 20 forecasts at ≥ 99 % with
 * 98.5 %+ of them coming true (and the mirror for ≤ 1 %). Else the page says "99 %" / "1 %".
 */
export function extremesFor(sport: FcSport): { hi: boolean; lo: boolean } {
  let hi = { n: 0, hits: 0 }, lo = { n: 0, hits: 0 };
  for (const r of db.prepare(`SELECT json FROM season_forecast_accuracy WHERE sport = ?`).all(sport) as any[]) {
    const e = JSON.parse(r.json)?.extremes;
    if (!e) continue;
    hi = { n: hi.n + e.hi.n, hits: hi.hits + e.hi.hits }; lo = { n: lo.n + e.lo.n, hits: lo.hits + e.lo.hits };
  }
  return { hi: hi.n >= 20 && hi.hits / hi.n >= 0.985, lo: lo.n >= 20 && lo.hits / lo.n <= 0.015 };
}
/** fix218: position chances rounded to 4 decimals with the largest remainder, so a row adds up to exactly 100 % */
export function roundRow(pos: number[], dp = 4): number[] {
  const k = 10 ** dp;
  const scaled = pos.map(p => p * k), floor = scaled.map(Math.floor);
  let left = Math.round(k - floor.reduce((a, b) => a + b, 0));
  const order = scaled.map((v, i) => ({ i, rem: v - floor[i] })).sort((a, b) => b.rem - a.rem);
  for (let j = 0; j < order.length && left > 0; j++, left--) floor[order[j].i]++;
  return floor.map(v => v / k);
}
export const seasonForecastStatus = () => ({ ...status, dirty: [...dirtySince.entries()].map(([k, at]) => ({ league: k, since: new Date(at).toISOString() })) });

/** build, run and store the given leagues; returns how many ran */
export async function runSeasonForecast(refs: LeagueRef[] = allLeagues(), why = 'manual'): Promise<number> {
  if (status.running) return 0;
  status.running = true;
  const t0 = Date.now(), nowIso = new Date().toISOString();
  let ran = 0;
  try {
    const inputs: LeagueInput[] = [];
    for (const ref of refs) {
      let x: LeagueInput | Skip;
      try { x = await inputOf(ref, nowIso); } catch (e: any) { x = { ...ref, name: ref.code, reason: `inputs failed: ${e?.message || e}` }; }
      await yieldLoop();
      if ('reason' in x) {
        db.prepare(`INSERT OR REPLACE INTO season_forecast_skips (sport, code, name, reason, at) VALUES (?, ?, ?, ?, ?)`).run(x.sport, x.code, x.name, x.reason, nowIso);
        continue;
      }
      db.prepare(`DELETE FROM season_forecast_skips WHERE sport = ? AND code = ?`).run(x.sport, x.code);
      inputs.push(x);
    }
    // a few leagues per thread (one thread start each time; the inputs are plain data)
    for (let i = 0; i < inputs.length; i += 6) {
      const batch = inputs.slice(i, i + 6);
      let outs: { out: SimOut; ms: number }[];
      if (threadJobsOn()) outs = await inThread<{ out: SimOut; ms: number }[]>('season sim', [batch]);
      else {
        outs = [];
        for (const x of batch) { const t1 = Date.now(); outs.push({ out: await simulateSeasonAsync(x.rules, x.teams, x.played, x.games, x.params, yieldLoop), ms: Date.now() - t1 }); }
      }
      for (let k = 0; k < batch.length; k++) { store(batch[k], outs[k].out, outs[k].ms, nowIso); ran++; await yieldLoop(); }
    }
    status.lastError = null;
    logger.info(`season forecast (${why}): ${ran} league(s) in ${Math.round((Date.now() - t0) / 1000)} s`);
  } catch (e: any) {
    status.lastError = e?.message || String(e);
    logger.warn(`season forecast (${why}): ${status.lastError}`);
  } finally {
    status.running = false; status.lastAt = nowIso; status.lastLeagues = ran; status.lastMs = Date.now() - t0;
  }
  return ran;
}

function store(x: LeagueInput, out: SimOut, ms: number, nowIso: string) {
  const teams = out.teams.map(t => {
    const src = x.teams.find(s => s.id === t.id)!;
    return {
      id: t.id, name: t.name, group: t.group || null, logo: x.meta[t.id]?.logo ?? null,
      now: { rank: x.meta[t.id]?.rank || 0, pts: src.pts, played: src.played, w: src.w, d: src.d, l: src.l, diff: src.gf - src.ga },
      avgPts: Math.round(t.avgPts * 10) / 10, avgPos: Math.round(t.avgPos * 100) / 100,
      zones: Object.fromEntries(Object.entries(t.zones).map(([k, v]) => [k, r4(v as number)])),
      // fix218: the row adds up to exactly 100 % after rounding; the unrounded sum is kept for the data-health check
      pos: roundRow(t.pos), psum: t.pos.reduce((a, b) => a + b, 0)
    };
  });
  const seen = finalSeen.get(`${x.sport}|${x.code}`) || null;
  db.exec('BEGIN');
  try {
    db.prepare(`INSERT OR REPLACE INTO season_forecast (sport, code, name, season, run_at, runs, ms, games_left, known, last_final, final_seen, rules, zones, groups_, teams, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(x.sport, x.code, x.name, x.season, nowIso, out.runs, ms, x.games.length, x.rules.known ? 1 : 0,
      x.lastFinal, seen, JSON.stringify(x.rules), JSON.stringify(out.zones), JSON.stringify(out.groups), JSON.stringify(teams),
      `${x.games.filter(g => g.pH != null || g.pHome != null).length} of ${x.games.length} games from our predictions`);
    db.prepare(`DELETE FROM season_forecast_games WHERE sport = ? AND code = ?`).run(x.sport, x.code);
    const insG = db.prepare(`INSERT OR REPLACE INTO season_forecast_games (sport, game_id, code, json) VALUES (?, ?, ?, ?)`);
    for (const g of out.games) {
      const rnd = (o: Record<string, number[]>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.map(q => (Number.isFinite(q) ? r4(q) : null))]));
      insG.run(x.sport, g.id, x.code, JSON.stringify({ home: g.home, away: g.away, results: g.results, share: g.share.map(r4), homeZones: rnd(g.home_), awayZones: rnd(g.away_) }));
    }
    db.prepare(`DELETE FROM season_forecast_teams WHERE sport = ? AND code = ?`).run(x.sport, x.code);
    const insT = db.prepare(`INSERT OR IGNORE INTO season_forecast_teams (sport, team_id, code) VALUES (?, ?, ?)`);
    const insH = db.prepare(`INSERT OR REPLACE INTO season_forecast_history (sport, code, season, day, team_id, json) VALUES (?, ?, ?, ?, ?, ?)`);
    for (const t of teams) {
      if (t.group === 'other') continue;
      insT.run(x.sport, t.id, x.code);
      insH.run(x.sport, x.code, x.season, nowIso.slice(0, 10), t.id, JSON.stringify({ z: t.zones, p: t.avgPos, pts: t.avgPts }));
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/* ---------- scheduler: 10 min after a new finished game, nightly, at start-up ---------- */

const dirtySince = new Map<string, number>();
const finalSeen = new Map<string, string>();
const DEBOUNCE = 10 * MIN;

async function tick() {
  if (status.running) return;
  const finals = lastFinals();
  const stored = new Map((db.prepare(`SELECT sport, code, run_at, last_final FROM season_forecast`).all() as any[]).map(r => [`${r.sport}|${r.code}`, r]));
  const skipped = new Set((db.prepare(`SELECT sport, code, at FROM season_forecast_skips`).all() as any[]).filter(r => Date.now() - Date.parse(r.at) < DAY).map(r => `${r.sport}|${r.code}`));
  const now = Date.now(), due: LeagueRef[] = [];
  const nightly = new Date().getUTCHours() === 2;
  for (const ref of allLeagues()) {
    const k = `${ref.sport}|${ref.code}`, row = stored.get(k), fin = finals.get(k) || null;
    if (fin && row && row.last_final !== fin && (!row.last_final || fin > row.last_final)) {
      if (!dirtySince.has(k)) { dirtySince.set(k, now); finalSeen.set(k, new Date(now).toISOString()); }
    }
    const old = !row ? !skipped.has(k) : now - Date.parse(row.run_at) > (nightly ? 20 * 3600 * 1000 : 26 * 3600 * 1000);
    if ((dirtySince.has(k) && now - dirtySince.get(k)! >= DEBOUNCE) || old) due.push(ref);
  }
  if (!due.length) return;
  await heavy('season forecast', async () => {
    const n = await runSeasonForecast(due, 'scheduled');
    for (const ref of due) dirtySince.delete(`${ref.sport}|${ref.code}`);
    return n;
  });
}

export function startSeasonForecastScheduler() {
  after('season forecast start', () => tick(), 5 * MIN);
  every('season forecast check', () => tick(), 5 * MIN);
  // accuracy replay of last season (+ the noise fit, fix218): ~8 min after the start when none is stored or it is over
  // 7 days old, then Mondays 03:xx UTC (admin only). The forecasts are re-run with the fitted noise right after.
  const replay = async (force: boolean) => {
    const d = new Date();
    if (!force && (d.getUTCDay() !== 1 || d.getUTCHours() !== 3)) return;
    const last: any = db.prepare(`SELECT MAX(at) at FROM season_forecast_accuracy`).get();
    if (last?.at && Date.now() - Date.parse(last.at) < (force ? 7 : 5) * DAY) return;
    const n = await heavy('season forecast accuracy', () => runSeasonAccuracy());
    if (n) await heavy('season forecast', () => runSeasonForecast(allLeagues(), 'after the noise fit'));
  };
  after('season forecast accuracy', () => replay(true), 8 * MIN);
  every('season forecast accuracy', () => replay(false), 30 * MIN);
}

/* ---------- reads for the pages ---------- */

export interface FcTeamRow {
  id: string; name: string; group: string | null; logo: string | null;
  now: { rank: number; pts: number; played: number; w: number; d: number; l: number; diff: number };
  avgPts: number; avgPos: number; zones: Partial<Record<ZoneKey, number>>; pos: number[];
}
export interface FcLeague { sport: FcSport; code: string; name: string; season: string; runAt: string; runs: number; known: boolean; zones: ZoneKey[]; groups: string[]; teams: FcTeamRow[]; gamesLeft: number }

export function leagueForecast(sport: FcSport, code: string): FcLeague | null {
  const r: any = db.prepare(`SELECT * FROM season_forecast WHERE sport = ? AND code = ?`).get(sport, code);
  if (!r) return null;
  const teams: FcTeamRow[] = JSON.parse(r.teams).filter((t: FcTeamRow) => t.group !== 'other');
  return {
    sport, code, name: r.name, season: r.season, runAt: r.run_at, runs: r.runs, known: !!r.known, gamesLeft: r.games_left,
    zones: JSON.parse(r.zones || '[]'), groups: (JSON.parse(r.groups_ || '[]') as string[]).filter(g => g !== 'other'),
    teams: teams.sort((a, b) => (a.group || '').localeCompare(b.group || '') || a.avgPos - b.avgPos)
  };
}
export function teamForecastCodes(sport: FcSport, teamId: string): string[] {
  return (db.prepare(`SELECT code FROM season_forecast_teams WHERE sport = ? AND team_id = ?`).all(sport, teamId) as any[]).map(r => r.code);
}
export function teamHistory(sport: FcSport, code: string, season: string, teamId: string): { day: string; zones: Partial<Record<ZoneKey, number>>; avgPos: number }[] {
  return (db.prepare(`SELECT day, json FROM season_forecast_history WHERE sport = ? AND code = ? AND season = ? AND team_id = ? ORDER BY day`).all(sport, code, season, teamId) as any[])
    .map(r => { const j = JSON.parse(r.json); return { day: r.day, zones: j.z, avgPos: j.p }; });
}
export function gameMeans(sport: FcSport, gameId: string): { code: string; json: any } | null {
  const r: any = db.prepare(`SELECT code, json FROM season_forecast_games WHERE sport = ? AND game_id = ?`).get(sport, gameId);
  return r ? { code: r.code, json: JSON.parse(r.json) } : null;
}

/* ---------- admin ---------- */

export function seasonForecastAdmin() {
  const rows = (db.prepare(`SELECT sport, code, name, season, run_at, runs, ms, games_left, known, last_final, final_seen, rules, note FROM season_forecast ORDER BY sport, code`).all() as any[])
    .map(r => ({ ...r, known: !!r.known, rules: JSON.parse(r.rules || 'null') }));
  const skips = db.prepare(`SELECT sport, code, name, reason, at FROM season_forecast_skips ORDER BY sport, code`).all();
  const accuracy = (db.prepare(`SELECT sport, code, season, json, at FROM season_forecast_accuracy ORDER BY sport, code`).all() as any[]).map(r => ({ ...r, json: undefined, ...JSON.parse(r.json) }));
  return { status: seasonForecastStatus(), leagues: rows, skipped: skips, accuracy: { leagues: accuracy, sports: accuracySummary() } };
}

/* ---------- data health ---------- */

/** "Season forecast fresh" / "rules" / "sums" (services/dataHealth.ts) */
export function seasonForecastChecks(): { id: string; label: string; level: 'ok' | 'warn' | 'fail'; detail: string; items?: string[] }[] {
  const rows = db.prepare(`SELECT sport, code, name, run_at, last_final, final_seen, games_left, known, teams FROM season_forecast`).all() as any[];
  const finals = lastFinals();
  const late: string[] = [], bad: string[] = [];
  for (const r of rows) {
    const fin = finals.get(`${r.sport}|${r.code}`);
    // a newer finished game than the one the stored run saw: it must be re-run within 30 minutes of being seen
    if (r.games_left > 0 && fin && (!r.last_final || fin > r.last_final)) {
      const seen = finalSeen.get(`${r.sport}|${r.code}`);
      const since = seen ? Date.parse(seen) : Date.parse(fin);
      if (Date.now() - since > 30 * MIN) late.push(`${r.sport} ${r.name || r.code}: last run ${r.run_at.slice(0, 16)}, a game finished since (${fin.slice(0, 16)})`);
    }
    for (const t of JSON.parse(r.teams) as (FcTeamRow & { psum?: number })[]) {
      // fix218: the unrounded sum of the run counts (exact up to floating point); a stored row from before the rounding
      // fix is judged by its rounded values until its next run
      const s = t.psum ?? t.pos.reduce((a, b) => a + b, 0);
      if (Math.abs(s - 1) > (t.psum != null ? 1e-6 : 0.002)) bad.push(`${r.sport} ${r.code} ${t.name}: positions add up to ${(s * 100).toFixed(2)}%`);
    }
  }
  const unknown = rows.filter(r => !r.known).map(r => `${r.sport} ${r.name || r.code} (${r.code}): no zone rules — position chances only`);
  const skips = (db.prepare(`SELECT sport, code, name, reason FROM season_forecast_skips`).all() as any[]).filter(s => /not modelled/.test(s.reason)).map(s => `${s.sport} ${s.name || s.code}: ${s.reason}`);
  return [
    { id: 'season-forecast-fresh', label: 'Season forecast fresh', level: !rows.length ? 'warn' : late.length ? 'fail' : 'ok', detail: !rows.length ? 'No season forecast stored yet (first run ~5 min after start)' : late.length ? `${late.length} league(s) not re-run within 30 min of a finished game` : `${rows.length} leagues, each run after its last finished game`, items: late.slice(0, 30) },
    { id: 'season-forecast-rules', label: 'Season forecast rules', level: unknown.length + skips.length ? 'warn' : 'ok', detail: unknown.length + skips.length ? `${unknown.length} league(s) without zone rules, ${skips.length} not simulated` : 'Every league has its rules', items: [...skips, ...unknown].slice(0, 40) },
    { id: 'season-forecast-sums', label: 'Season forecast: position chances add up to 100%', level: bad.length ? 'fail' : 'ok', detail: bad.length ? `${bad.length} team(s) off` : 'Every team’s position chances add up to 100%', items: bad.slice(0, 20) },
    ...(['football', 'basketball', 'nfl'] as FcSport[]).map(sport => {
      const s = accuracySummary()[sport];
      return { id: `season-forecast-calibrated-${sport}`, label: `Season forecast calibrated (${sport === 'nfl' ? 'American football' : sport})`,
        level: (!s ? 'warn' : s.beats ? 'ok' : 'warn') as 'ok' | 'warn',
        detail: !s ? 'No replay of last season yet (first run ~8 min after the start, then Mondays 03:00 UTC, or Admin → Season forecast)' : `Last season replayed: Brier ${s.sim.toFixed(4)} vs table order ${s.base.toFixed(4)} over ${s.n} forecasts${s.beats ? '' : ' — admin only until it beats the table'} · season noise ${noiseFor(sport).fitted ? `fitted: ${noiseFor(sport).noise} + drift ${noiseFor(sport).walk}` : 'not fitted yet (base)'} · ">99%" ${extremesFor(sport).hi ? 'calibrated' : 'capped at 99%'}, "<1%" ${extremesFor(sport).lo ? 'calibrated' : 'capped at 1%'}` };
    })
  ];
}

/* ---------- accuracy: last season replayed week by week ---------- */

/**
 * For each week of last season: the table and the games known then; ratings fitted to the results known then
 * (our saved predictions of that time where there are 30+, else the results' margins); the rest simulated (2,000
 * runs). Brier score of the title / first zone (top 4, Champions League, promotion, play-offs) / relegation chances
 * against what happened, next to the "current table order" baseline (1 for the places the teams hold that week).
 */
const REPLAY_RUNS = 2000;

function pastFootball(): ReplayLeague[] {
  const out: ReplayLeague[] = [];
  for (const L of footballLeagues()) {
    if (L.own || !FOOTBALL_RULES[L.code]) continue;
    const s: any = db.prepare(`SELECT MAX(season) s FROM af_fixtures WHERE league_id = ? AND kickoff < ? AND status IN ('FT','AET','PEN')`).get(L.afId, new Date(Date.now() - 120 * DAY).toISOString());
    if (!s?.s) continue;
    const rows = db.prepare(`SELECT kickoff, home_id, away_id, home_name, away_name, hg, ag, status FROM af_fixtures WHERE league_id = ? AND season = ? ORDER BY kickoff`).all(L.afId, s.s) as any[];
    const games = rows.filter(r => FINAL.has(r.status) && r.hg != null).map(r => ({ home: String(r.home_id), away: String(r.away_id), hg: r.hg, ag: r.ag, kickoff: r.kickoff }));
    if (games.length < 100) continue;
    const names = new Map<string, string>(); for (const r of rows) { names.set(String(r.home_id), r.home_name); names.set(String(r.away_id), r.away_name); }
    const base = SIM_PARAMS.football;
    out.push({ sport: 'football', code: L.code, name: L.code, season: String(s.s), rules: FOOTBALL_RULES[L.code], teams: [...names].map(([id, name]) => ({ id, name })), games, preds: [],
      base: { runs: REPLAY_RUNS, seed: hashSeed(`acc|${L.code}`), home: base.home, drawBand: base.drawBand, sigma: 1, noise: base.noise, goalsH: base.goalsH, goalsA: base.goalsA } });
  }
  return out;
}
function pastBasketball(): ReplayLeague[] {
  const out: ReplayLeague[] = [];
  for (const L of BB_LEAGUES) {
    const rules = BASKETBALL_RULES[L.code];
    if (!rules || rules.groupBy) continue; // NBA conferences: not stored for past seasons (provider table)
    const lg: any = db.prepare(`SELECT seasons FROM bb_leagues WHERE code = ?`).get(L.code);
    const seasons: string[] = lg ? JSON.parse(lg.seasons || '[]') : [];
    const season = seasons[seasons.length - 2];
    if (!season) continue;
    const rows = (db.prepare(`SELECT kickoff, stage, status, home_id, away_id, home_name, away_name, hs, as_ FROM bb_games WHERE code = ? AND season = ? ORDER BY kickoff`).all(L.code, season) as any[]).filter(g => stageKind(g.stage) === 'regular');
    const games = rows.filter(g => ['FT', 'AOT'].includes(g.status) && g.hs != null).map(g => ({ home: String(g.home_id), away: String(g.away_id), hg: g.hs, ag: g.as_, kickoff: g.kickoff }));
    if (games.length < 100) continue;
    const names = new Map<string, string>(); for (const r of rows) { names.set(String(r.home_id), r.home_name); names.set(String(r.away_id), r.away_name); }
    const b = SIM_PARAMS.basketball;
    out.push({ sport: 'basketball', code: L.code, name: L.name, season, rules, teams: [...names].map(([id, name]) => ({ id, name })), games, preds: [],
      base: { runs: REPLAY_RUNS, seed: hashSeed(`acc|${L.code}`), home: b.home, drawBand: 0, sigma: b.sigma, noise: b.noise, goalsH: 0, goalsA: 0 } });
  }
  return out;
}
function pastNfl(): ReplayLeague[] {
  const season = nflCurrentSeason(1);
  if (!season) return [];
  const rows = (db.prepare(`SELECT kickoff, stage, week, status, home_id, away_id, home_pts, away_pts FROM nfl_games WHERE league = 1 AND season = ? ORDER BY kickoff`).all(season - 1) as any[]).filter(nflRegular(1));
  const games = rows.filter(g => ['FT', 'AOT'].includes(g.status) && g.home_pts != null).map(g => ({ home: String(g.home_id), away: String(g.away_id), hg: g.home_pts, ag: g.away_pts, kickoff: g.kickoff }));
  if (games.length < 200) return [];
  const teamRows = new Map((db.prepare(`SELECT team_id, name, conference, division FROM nfl_teams WHERE league = 1`).all() as any[]).map(t => [String(t.team_id), t]));
  const ids = [...new Set(games.flatMap(g => [g.home, g.away]))];
  const b = SIM_PARAMS.nfl;
  return [{ sport: 'nfl', code: 'NFL', name: 'NFL', season: String(season - 1), rules: NFL_RULES.NFL, teams: ids.map(id => ({ id, name: teamRows.get(id)?.name || id, group: teamRows.get(id)?.conference || '', div: teamRows.get(id)?.division || '' })), games, preds: [],
    base: { runs: REPLAY_RUNS, seed: hashSeed('acc|NFL'), home: b.home, drawBand: 0, sigma: b.sigma, noise: b.noise, goalsH: 0, goalsA: 0 } }];
}


export async function runSeasonAccuracy(): Promise<number> {
  const leagues = [...pastFootball(), ...pastBasketball(), ...pastNfl()];
  // fix218: 1. the noise fit per league (matchweeks 5 / 10 / 20, 600 runs a pair) → one (noise, walk) a sport: the
  // pair with the best mean Brier over its leagues, weighted by forecasts; stored and used by every forecast from now
  const fits = new Map<FcSport, { noise: number; walk: number; brier: number; n: number }[]>();
  for (const L of leagues) {
    try {
      const f = threadJobsOn() ? await inThread<ReturnType<typeof fitNoiseHere>>('season sim', [null, L, 'fit']) : fitNoiseHere(L);
      const list = fits.get(L.sport) || []; fits.set(L.sport, list);
      for (const t of f.tried) list.push({ ...t, n: 1 });
      logger.info(`season noise fit ${L.sport} ${L.code}: best noise ${f.noise} drift ${f.walk} (Brier ${f.brier})`);
    } catch (e: any) { logger.warn(`season noise fit ${L.code}: ${e?.message || e}`); }
    await yieldLoop();
  }
  for (const [sport, list] of fits) {
    // mean Brier per pair over the sport's leagues
    const by = new Map<string, { noise: number; walk: number; sum: number; n: number }>();
    for (const t of list) { const k = `${t.noise}|${t.walk}`; const x = by.get(k) || { noise: t.noise, walk: t.walk, sum: 0, n: 0 }; x.sum += t.brier; x.n++; by.set(k, x); }
    const best = [...by.values()].sort((a, b) => a.sum / a.n - b.sum / b.n)[0];
    if (!best) continue;
    db.prepare(`INSERT OR REPLACE INTO season_forecast_params (sport, noise, walk, json, at) VALUES (?, ?, ?, ?, ?)`)
      .run(sport, best.noise, best.walk, JSON.stringify([...by.values()].map(x => ({ noise: x.noise, walk: x.walk, brier: r4(x.sum / x.n), leagues: x.n }))), new Date().toISOString());
    logger.info(`season noise ${sport}: noise ${best.noise}, drift ${best.walk} (mean Brier ${r4(best.sum / best.n)} over ${best.n} league(s))`);
  }
  // 2. the full weekly replay with the fitted pair: the calibration check (Brier vs the table, the ">99 %" bins)
  let done = 0;
  for (const L of leagues) {
    try {
      const nz = noiseFor(L.sport);
      const LL: ReplayLeague = { ...L, base: { ...L.base, noise: nz.noise, walk: nz.walk } };
      const r = threadJobsOn() ? await inThread<ReplayOut>('season sim', [null, LL]) : replayHere(LL);
      db.prepare(`INSERT OR REPLACE INTO season_forecast_accuracy (sport, code, season, json, at) VALUES (?, ?, ?, ?, ?)`).run(L.sport, L.code, L.season, JSON.stringify(r), new Date().toISOString());
      done++;
    } catch (e: any) { logger.warn(`season forecast accuracy ${L.code}: ${e?.message || e}`); }
    await yieldLoop();
  }
  logger.info(`season forecast accuracy: ${done} of ${leagues.length} past league season(s) replayed`);
  return done;
}

/** per sport: the replay's Brier against the table order, weighted by forecasts */
export function accuracySummary(): Partial<Record<FcSport, { sim: number; base: number; n: number; beats: boolean }>> {
  const out: Partial<Record<FcSport, { sim: number; base: number; n: number; beats: boolean }>> = {};
  for (const r of db.prepare(`SELECT sport, json FROM season_forecast_accuracy`).all() as any[]) {
    const j = JSON.parse(r.json); if (!j.n) continue;
    const o = out[r.sport as FcSport] || (out[r.sport as FcSport] = { sim: 0, base: 0, n: 0, beats: false });
    o.sim += j.simAll * j.n; o.base += j.baseAll * j.n; o.n += j.n;
  }
  for (const o of Object.values(out)) { o!.sim /= o!.n; o!.base /= o!.n; o!.beats = o!.sim < o!.base; }
  return out;
}

/* ---------- what a visitor sees (Free vs Pro, like the predictions) ---------- */

/** Free: the forecast's top three and bottom three of each table + the visitor's favourite teams; Pro / admin: all */
export function visibleIds(lg: FcLeague, favs: Set<string>): Set<string> {
  const keep = new Set<string>();
  for (const g of lg.groups.length ? lg.groups : ['']) {
    const rows = lg.teams.filter(t => (t.group || '') === g).sort((a, b) => a.avgPos - b.avgPos);
    for (const t of [...rows.slice(0, 3), ...rows.slice(-3)]) keep.add(t.id);
  }
  for (const t of lg.teams) if (favs.has(t.id)) keep.add(t.id);
  return keep;
}
export function leagueView(lg: FcLeague, full: boolean, favs: Set<string>) {
  const extremes = extremesFor(lg.sport);
  if (full) return { ...lg, extremes, full: true, locked: 0 };
  const keep = visibleIds(lg, favs);
  const open = lg.teams.filter(t => keep.has(t.id));
  // a locked row keeps the team and today's table, not the forecast (ordered by today's place, so it gives nothing away)
  const shut = lg.teams.filter(t => !keep.has(t.id)).sort((a, b) => (a.group || '').localeCompare(b.group || '') || a.now.rank - b.now.rank)
    .map(t => ({ id: t.id, name: t.name, group: t.group, logo: t.logo, now: t.now, locked: true }));
  // per group: the top three, favourites, the locked middle, the bottom three
  const edgeIds = visibleIds(lg, new Set());
  const teams: any[] = [];
  for (const g of lg.groups.length ? lg.groups : ['']) {
    const o = open.filter(t => (t.group || '') === g).sort((a, b) => a.avgPos - b.avgPos);
    const fav = o.filter(t => !edgeIds.has(t.id));
    const edge = o.filter(t => !fav.includes(t));
    teams.push(...edge.slice(0, 3), ...fav, ...shut.filter(t => (t.group || '') === g), ...edge.slice(3));
  }
  return { ...lg, extremes, teams, full: false, locked: shut.length };
}

/** "What this game means": per side, the zones whose chance moves by 2 points or more with the result */
export function gameMeaning(sport: FcSport, gameId: string) {
  const m = gameMeans(sport, gameId);
  if (!m) return null;
  const lg = leagueForecast(sport, m.code);
  if (!lg || !lg.known) return null;
  const j = m.json;
  const side = (teamId: string, zones: Record<string, (number | null)[]>) => {
    const row = lg.teams.find(t => t.id === teamId);
    const lines = lg.zones.filter(z => z !== 'final').map(z => {
      const v = zones[z] || [];
      const vals = v.filter((q): q is number => q != null);
      if (vals.length < 2 || Math.max(...vals) - Math.min(...vals) < 0.02) return null;
      return { zone: z, now: row?.zones[z] ?? null, byResult: v };
    }).filter(Boolean);
    return { id: teamId, name: row?.name || teamId, lines };
  };
  const home = side(j.home, j.homeZones), away = side(j.away, j.awayZones);
  if (!home.lines.length && !away.lines.length) return null;
  return { code: m.code, league: lg.name, runAt: lg.runAt, runs: lg.runs, results: j.results, share: j.share, home, away };
}
