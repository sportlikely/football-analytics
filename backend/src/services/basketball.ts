/**
 * Basketball data (API-Basketball, api-sports.io — same account and key as API-Football, its own daily quota).
 *
 * Step 1 (Oct 2026): collect every game of our 4 leagues for the last 5 seasons and keep the current season up to date.
 *   bb_leagues  league id, name, the seasons the provider has
 *   bb_games    one row per game: date, teams, status, final score, quarter scores
 * The model, game pages and the public basketball site come next, built on this table.
 *
 * Admin: GET /api/bb/status (quota, games per league/season), GET /api/bb/raw?path=/leagues&search=…
 */
import logger from '../utils/logger';
import { db } from '../db';
import { buildAll, recordBbPredictions, bumpBbInjuries } from './bbModel';
import { timed, every, after, perGames } from './perf';
import { publishState } from './shared';
import { refreshNbaInjuries, nbaInjuryStatus } from './bbInjuries';
import { applyResultFixes, checkResults } from './bbResults';
import { onBbExtraLeague } from './bbLeagueConfig';
import { assertProviderCallAllowed } from './afUsage';
import { cleanName } from './sponsorNames';
import { boxUpdated, gameViews } from './gameViews';
import { dueGames, budgetAllows, chunks } from '../utils/liveBox';
import { nbaLiveExtras } from './bdl';

const BASE = 'https://v1.basketball.api-sports.io';
const KEY = () => process.env.API_BASKETBALL_KEY || process.env.API_FOOTBALL_KEY || '';
const MIN_GAP_MS = 400;
const SEASONS_BACK = 5;

/** Our leagues. `id` is API-Basketball's league id; `search` finds it again if an id is wrong (checked on every sync). */
export const BB_LEAGUES: { code: string; id: number; name: string; country: string; search: string }[] = [
  { code: 'NBA', id: 12, name: 'NBA', country: 'USA', search: 'NBA' },
  { code: 'EL', id: 120, name: 'EuroLeague', country: 'Europe', search: 'Euroleague' },
  { code: 'ACB', id: 117, name: 'Liga ACB', country: 'Spain', search: 'ACB' },
  { code: 'LBA', id: 52, name: 'Lega Basket Serie A', country: 'Italy', search: 'Lega A' },
  // added 8 Oct 2026 (all with player box scores in API-Basketball)
  { code: 'BSL', id: 104, name: 'Basketbol Süper Ligi', country: 'Turkey', search: 'Super Ligi' },
  { code: 'LNB', id: 2, name: 'LNB Pro A', country: 'France', search: '^LNB$' },
  { code: 'BBL', id: 40, name: 'Basketball Bundesliga', country: 'Germany', search: '^BBL$' },
  { code: 'GBL', id: 45, name: 'Greek Basket League', country: 'Greece', search: '^Basket League$' },
  { code: 'LKL', id: 60, name: 'LKL', country: 'Lithuania', search: '^LKL$' },
  { code: 'EC', id: 194, name: 'EuroCup', country: 'Europe', search: '^Eurocup$' },
  { code: 'BCL', id: 202, name: 'Basketball Champions League', country: 'Europe', search: '^Champions League$' },
  { code: 'ABA', id: 198, name: 'ABA League', country: 'Europe', search: '^ABA League$' },
  { code: 'FEC', id: 201, name: 'FIBA Europe Cup', country: 'Europe', search: '^FIBA Europe Cup$' },
  { code: 'NBL', id: 1, name: 'NBL', country: 'Australia', search: '^NBL$' },
  { code: 'JBL', id: 56, name: 'B.League', country: 'Japan', search: '^B League$' },
  { code: 'CBA', id: 31, name: 'CBA', country: 'China', search: '^CBA$' },
  { code: 'NBB', id: 26, name: 'NBB', country: 'Brazil', search: '^NBB$' },
  { code: 'BSN', id: 76, name: 'BSN', country: 'Puerto Rico', search: '^BSN$' }
];
// Leagues added from the admin panel (services/bbLeagueConfig.ts): the exact name is the check that the id is right
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
onBbExtraLeague(l => {
  if (BB_LEAGUES.some(x => x.id === l.id || x.code === l.code)) return;
  BB_LEAGUES.push({ code: l.code, id: l.id, name: l.name, country: l.country, search: `^${escapeRe(l.name)}$` });
});

db.exec(`
  CREATE TABLE IF NOT EXISTS bb_leagues (
    code TEXT PRIMARY KEY, league_id INTEGER NOT NULL, name TEXT NOT NULL, country TEXT, logo TEXT,
    seasons TEXT NOT NULL DEFAULT '[]', checked_at TEXT
  );
  CREATE TABLE IF NOT EXISTS bb_games (
    game_id   INTEGER PRIMARY KEY,
    code      TEXT NOT NULL,
    league_id INTEGER NOT NULL,
    season    TEXT NOT NULL,
    stage     TEXT,
    kickoff   TEXT NOT NULL,
    status    TEXT,
    home_id   INTEGER NOT NULL, home_name TEXT NOT NULL, home_logo TEXT,
    away_id   INTEGER NOT NULL, away_name TEXT NOT NULL, away_logo TEXT,
    hs INTEGER, as_ INTEGER,
    quarters  TEXT,               -- JSON {home:[q1..q4,ot], away:[...]}
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_bb_games_code_kickoff ON bb_games(code, kickoff);
  -- fix159: a team's previous game (rest days) in one index step instead of a table scan
  CREATE INDEX IF NOT EXISTS idx_bb_games_home_kickoff ON bb_games(home_id, kickoff);
  CREATE INDEX IF NOT EXISTS idx_bb_games_away_kickoff ON bb_games(away_id, kickoff);
  CREATE TABLE IF NOT EXISTS bb_sync (key TEXT PRIMARY KEY, done_at TEXT NOT NULL, info TEXT);
  CREATE TABLE IF NOT EXISTS bb_team_stats (
    game_id INTEGER NOT NULL, team_id INTEGER NOT NULL,
    fgm INTEGER, fga INTEGER, tpm INTEGER, tpa INTEGER, ftm INTEGER, fta INTEGER,
    reb INTEGER, oreb INTEGER, dreb INTEGER, ast INTEGER, stl INTEGER, blk INTEGER, tov INTEGER, pf INTEGER,
    PRIMARY KEY (game_id, team_id)
  );
  CREATE TABLE IF NOT EXISTS bb_player_stats (
    game_id INTEGER NOT NULL, team_id INTEGER NOT NULL, player_id INTEGER NOT NULL, name TEXT,
    starter INTEGER, minutes REAL, pts INTEGER, fgm INTEGER, fga INTEGER, tpm INTEGER, tpa INTEGER, ftm INTEGER, fta INTEGER,
    reb INTEGER, ast INTEGER,
    PRIMARY KEY (game_id, player_id)
  );
  CREATE INDEX IF NOT EXISTS idx_bb_player_stats_player ON bb_player_stats(player_id);
`);
// live clock: minutes played in the current quarter (API-Basketball status.timer)
try { db.exec(`ALTER TABLE bb_games ADD COLUMN timer INTEGER`); } catch { /* column exists */ }
// box scores fetched? 0 = not yet, 1 = stored, 2 = the provider has none
try { db.exec(`ALTER TABLE bb_games ADD COLUMN stats INTEGER NOT NULL DEFAULT 0`); } catch { /* column exists */ }
// field goals checked against the score? 0 = not yet, 1 = fine, 2 = corrected (see fixFieldGoals)
try { db.exec(`ALTER TABLE bb_team_stats ADD COLUMN fg_checked INTEGER NOT NULL DEFAULT 0`); } catch { /* column exists */ }
// fix208: live box scores, apart from the final ones (the model, player averages and injuries read bb_team_stats /
// bb_player_stats as finished games): same columns + when they were fetched; NBA extras from balldontlie's live feed.
// The final fetch (syncBoxScores, or the live job once the game is over) deletes a game's live rows.
db.exec(`
  CREATE TABLE IF NOT EXISTS bb_team_stats_live (
    game_id INTEGER NOT NULL, team_id INTEGER NOT NULL,
    fgm INTEGER, fga INTEGER, tpm INTEGER, tpa INTEGER, ftm INTEGER, fta INTEGER,
    reb INTEGER, oreb INTEGER, dreb INTEGER, ast INTEGER, stl INTEGER, blk INTEGER, tov INTEGER, pf INTEGER,
    updated_at INTEGER NOT NULL, PRIMARY KEY (game_id, team_id)
  );
  CREATE TABLE IF NOT EXISTS bb_player_stats_live (
    game_id INTEGER NOT NULL, team_id INTEGER NOT NULL, player_id INTEGER NOT NULL, name TEXT,
    starter INTEGER, minutes REAL, pts INTEGER, fgm INTEGER, fga INTEGER, tpm INTEGER, tpa INTEGER, ftm INTEGER, fta INTEGER,
    reb INTEGER, ast INTEGER, stl INTEGER, blk INTEGER, tov INTEGER, pm INTEGER,
    updated_at INTEGER NOT NULL, PRIMARY KEY (game_id, player_id)
  );
`);

/**
 * API-Basketball changed its box scores during 2025-26: "field goals" became 2-point field goals only (3-pointers
 * separate). Every stored team line is checked against the final score once: when 2·FGM + 3·3PM + FTM matches the
 * score better than 2·FGM + 3PM + FTM, the 3-pointers are added back into FGM/FGA (team line and its players), so
 * shooting % and possessions mean the same in every season.
 */
export function fixFieldGoals() {
  const rows = db.prepare(`
    SELECT t.game_id, t.team_id, t.fgm, t.fga, t.tpm, t.tpa, t.ftm, g.home_id, g.hs, g.as_
    FROM bb_team_stats t JOIN bb_games g ON g.game_id = t.game_id
    WHERE t.fg_checked = 0 AND g.hs IS NOT NULL AND t.fgm IS NOT NULL`).all() as any[];
  if (!rows.length) return 0;
  const mark = db.prepare(`UPDATE bb_team_stats SET fg_checked = ? WHERE game_id = ? AND team_id = ?`);
  const fixT = db.prepare(`UPDATE bb_team_stats SET fgm = fgm + COALESCE(tpm, 0), fga = fga + COALESCE(tpa, 0), fg_checked = 2 WHERE game_id = ? AND team_id = ?`);
  const fixP = db.prepare(`UPDATE bb_player_stats SET fgm = COALESCE(fgm, 0) + COALESCE(tpm, 0), fga = COALESCE(fga, 0) + COALESCE(tpa, 0) WHERE game_id = ? AND team_id = ?`);
  let fixed = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const score = r.team_id === r.home_id ? r.hs : r.as_;
      const tpm = r.tpm || 0, ftm = r.ftm || 0;
      const included = Math.abs(2 * r.fgm + tpm + ftm - score), separate = Math.abs(2 * r.fgm + 3 * tpm + ftm - score);
      if (separate < included) { fixT.run(r.game_id, r.team_id); fixP.run(r.game_id, r.team_id); fixed++; }
      else mark.run(1, r.game_id, r.team_id);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  if (fixed) logger.info(`API-Basketball: field goals corrected in ${fixed} of ${rows.length} team box scores (3-pointers were counted separately)`);
  return fixed;
}

let lastCall = 0;
let remainingDay: number | null = null;
let limitDay: number | null = null;
let lastError: string | null = null;
let calls = 0;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function bb(path: string, params: Record<string, string | number> = {}): Promise<any> {
  if (!KEY()) throw new Error('No API-Sports key set');
  assertProviderCallAllowed(); // fix166: crawler pages are built from our database only
  if (path !== '/status' && remainingDay !== null && remainingDay <= 50) throw new Error('API-Basketball daily limit nearly used up');
  const wait = lastCall + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { 'x-apisports-key': KEY() }, signal: AbortSignal.timeout(30_000) });
  calls++;
  const rem = res.headers.get('x-ratelimit-requests-remaining');
  const lim = res.headers.get('x-ratelimit-requests-limit');
  if (rem) remainingDay = parseInt(rem, 10);
  if (lim) limitDay = parseInt(lim, 10);
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}`);
  const json: any = await res.json();
  const errs = json.errors;
  if (errs && ((Array.isArray(errs) && errs.length) || (!Array.isArray(errs) && Object.keys(errs).length))) {
    lastError = `${path}: ${JSON.stringify(errs)}`;
    throw new Error(lastError);
  }
  return json;
}
export const bbGet = (path: string, params: Record<string, string | number> = {}) => bb(path, params);

const markSync = (key: string, info: any = null) =>
  db.prepare(`INSERT OR REPLACE INTO bb_sync (key, done_at, info) VALUES (?, ?, ?)`).run(key, new Date().toISOString(), info ? JSON.stringify(info) : null);
const syncedAt = (key: string): number | null => {
  const r: any = db.prepare(`SELECT done_at FROM bb_sync WHERE key = ?`).get(key);
  return r ? new Date(r.done_at).getTime() : null;
};

/** League details and the seasons the provider has (re-checked daily). A wrong id is replaced by a name search. */
async function syncLeague(l: (typeof BB_LEAGUES)[number]) {
  const prev: any = db.prepare(`SELECT * FROM bb_leagues WHERE code = ?`).get(l.code);
  if (prev?.checked_at && Date.now() - new Date(prev.checked_at).getTime() < 24 * 3600 * 1000) return prev;
  let row = (await bb('/leagues', { id: prev?.league_id || l.id })).response?.[0];
  const looksRight = (r: any) => r && (String(r.country?.name || '').replace(/-/g, ' ') === l.country || (l.country === 'Europe' && /europe|world/i.test(r.country?.name || ''))) &&
    new RegExp(l.search, 'i').test(r.name || '');
  if (!looksRight(row)) {
    const found = (await bb('/leagues', { search: l.search })).response || [];
    row = found.find(looksRight) || null;
    if (!row) throw new Error(`league ${l.code} not found (id ${l.id})`);
    logger.info(`API-Basketball: ${l.code} is league ${row.id} (${row.name}, ${row.country?.name})`);
  }
  const seasons = (row.seasons || []).map((s: any) => String(s.season)).sort();
  db.prepare(`INSERT OR REPLACE INTO bb_leagues (code, league_id, name, country, logo, seasons, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(l.code, row.id, row.name, row.country?.name || null, row.logo || null, JSON.stringify(seasons), new Date().toISOString());
  return db.prepare(`SELECT * FROM bb_leagues WHERE code = ?`).get(l.code);
}

const FINISHED = new Set(['FT', 'AOT']);

/** Store games from API-Basketball (insert or update; the box-score flag of a stored game is kept). */
/** fix178: called after every store of games (bbLive.ts keeps the swing-chart samples); set once at start-up. */
let storedHook: ((ids: number[]) => void) | null = null;
export const setBbStoredHook = (fn: (ids: number[]) => void) => { storedHook = fn; };

// fix182: names stored before the sponsor cleaner ("Partizan Mozzart Bet") are cleaned once at start-up
try {
  const fix = db.prepare(`UPDATE bb_games SET home_name = CASE WHEN home_name = ? THEN ? ELSE home_name END, away_name = CASE WHEN away_name = ? THEN ? ELSE away_name END WHERE home_name = ? OR away_name = ?`);
  for (const r of db.prepare(`SELECT DISTINCT home_name AS n FROM bb_games UNION SELECT DISTINCT away_name FROM bb_games`).all() as any[]) {
    const c = cleanName(r.n);
    if (c !== r.n) fix.run(r.n, c, r.n, c, r.n, r.n);
  }
} catch { /* table not ready */ }

function upsertGames(code: string, leagueId: number, season: string, list: any[]) {
  const up = db.prepare(`
    INSERT INTO bb_games (game_id, code, league_id, season, stage, kickoff, status, home_id, home_name, home_logo,
      away_id, away_name, away_logo, hs, as_, quarters, updated_at, timer)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(game_id) DO UPDATE SET code = excluded.code, league_id = excluded.league_id, season = excluded.season, stage = excluded.stage,
      kickoff = excluded.kickoff, status = excluded.status, home_id = excluded.home_id, home_name = excluded.home_name, home_logo = excluded.home_logo,
      away_id = excluded.away_id, away_name = excluded.away_name, away_logo = excluded.away_logo, hs = excluded.hs, as_ = excluded.as_,
      quarters = excluded.quarters, updated_at = excluded.updated_at, timer = excluded.timer`);
  const now = new Date().toISOString();
  let n = 0, done = 0;
  db.exec('BEGIN');
  try {
    for (const g of list) {
      if (!g.id || !g.teams?.home?.id || !g.teams?.away?.id) continue;
      const st = g.status?.short || null;
      const q = (x: any) => [x?.quarter_1, x?.quarter_2, x?.quarter_3, x?.quarter_4, x?.over_time].map((v: any) => (v == null ? null : Number(v)));
      up.run(
        g.id, code, leagueId, season, g.stage || g.week || null, new Date(g.date).toISOString(), st,
        g.teams.home.id, cleanName(g.teams.home.name), g.teams.home.logo || null, g.teams.away.id, cleanName(g.teams.away.name), g.teams.away.logo || null,
        g.scores?.home?.total ?? null, g.scores?.away?.total ?? null,
        JSON.stringify({ home: q(g.scores?.home), away: q(g.scores?.away) }), now,
        g.status?.timer != null && g.status.timer !== '' && Number.isFinite(Number(g.status.timer)) ? Number(g.status.timer) : null
      );
      n++;
      if (FINISHED.has(st)) done++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  applyResultFixes(); // our corrections win over the provider's numbers (services/bbResults.ts)
  // live and just-finished games: one win-chance sample each (the swing chart)
  if (storedHook) {
    const ids = list.filter(g => g.id && !['NS', 'TBD', 'POST', 'CANC', 'ABD', 'AWD'].includes(g.status?.short)).map(g => Number(g.id));
    if (ids.length) { try { storedHook(ids); } catch { /* optional */ } }
  }
  return { n, done };
}

/** Every game of a league season (one request). */
async function syncSeason(code: string, leagueId: number, season: string) {
  const json = await bb('/games', { league: leagueId, season });
  const { n, done } = upsertGames(code, leagueId, season, json.response || []);
  markSync(`games|${code}|${season}`, { n, done });
  return n;
}

/**
 * Live scores: once a minute while one of our games is on (from 10 minutes before tip-off until it is final),
 * that day's games of that league (one request per league and day).
 */
let liveRunning = false;
async function liveTick() {
  if (liveRunning || !KEY()) return;
  liveRunning = true;
  try {
    const now = Date.now();
    const rows = db.prepare(`SELECT DISTINCT code, league_id, season, substr(kickoff, 1, 10) AS day FROM bb_games
      WHERE kickoff BETWEEN ? AND ? AND (status IS NULL OR status NOT IN ('FT','AOT','CANC','POST','ABD','AWD'))`)
      .all(new Date(now - 4 * 3600 * 1000).toISOString(), new Date(now + 10 * 60 * 1000).toISOString()) as any[];
    for (const r of rows) {
      const json = await bb('/games', { league: r.league_id, season: r.season, date: r.day });
      // fix200: 20 games per write (with their win-chance samples), the rest on the next macrotask
      await perGames((json.response || []) as any[], b => upsertGames(r.code, r.league_id, r.season, b));
    }
  } catch (e: any) {
    logger.warn(`API-Basketball live: ${e.message}`);
  } finally {
    liveRunning = false;
  }
}

// fix204d: the rebound split is read under each spelling the provider has used (offence / offense / offensive …);
// bbModel's possessions fall back to the league's own rate when it is missing
const num = (x: any) => (x === null || x === undefined || x === '' ? null : Number(x));
const mins = (m: any) => {
  if (m === null || m === undefined || m === '') return null;
  const [a, b] = String(m).split(':');
  const v = Number(a) + (Number(b) || 0) / 60;
  return Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
};

/**
 * Store one batch of box scores (the /games/statistics/teams and /players responses). `live` = the live tables (with
 * the time; a game's player lines are rewritten each time); otherwise the final tables, the game marked (1 stored,
 * 2 the provider has none) and its live rows deleted (fix208: the final rows replace the live ones, nothing twice).
 * Returns the games that had numbers.
 */
export function storeBoxRows(ids: number[], teams: any[], players: any[], live: boolean, opts: { now?: number; markMissing?: boolean } = {}): Set<number> {
  const sfx = live ? '_live' : '';
  const insT = db.prepare(`INSERT OR REPLACE INTO bb_team_stats${sfx} (game_id, team_id, fgm, fga, tpm, tpa, ftm, fta, reb, oreb, dreb, ast, stl, blk, tov, pf${live ? ', updated_at' : ''})
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${live ? ', ?' : ''})`);
  const insP = db.prepare(`INSERT OR REPLACE INTO bb_player_stats${sfx} (game_id, team_id, player_id, name, starter, minutes, pts, fgm, fga, tpm, tpa, ftm, fta, reb, ast${live ? ', updated_at' : ''})
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${live ? ', ?' : ''})`);
  const mark = db.prepare(`UPDATE bb_games SET stats = ? WHERE game_id = ?`);
  const dropT = db.prepare(`DELETE FROM bb_team_stats_live WHERE game_id = ?`), dropP = db.prepare(`DELETE FROM bb_player_stats_live WHERE game_id = ?`);
  const got = new Set<number>();
  const extra = live ? [opts.now ?? Date.now()] : [];
  db.exec('BEGIN');
  try {
    if (live) {
      // a player the provider took off its list (a line corrected) must not stay from the last fetch
      const fresh = new Set<number>((players || []).map(r => Number(r.game?.id)).filter(Boolean));
      for (const gid of fresh) dropP.run(gid);
    }
    for (const r of teams || []) {
      const gid = r.game?.id, tid = r.team?.id;
      if (!gid || !tid) continue;
      got.add(gid);
      insT.run(gid, tid, num(r.field_goals?.total), num(r.field_goals?.attempts), num(r.threepoint_goals?.total), num(r.threepoint_goals?.attempts),
        num(r.freethrows_goals?.total), num(r.freethrows_goals?.attempts), num(r.rebounds?.total), num(r.rebounds?.offence ?? r.rebounds?.offense ?? r.rebounds?.offensive), num(r.rebounds?.defense ?? r.rebounds?.defence ?? r.rebounds?.defensive),
        num(r.assists), num(r.steals), num(r.blocks), num(r.turnovers), num(r.personal_fouls), ...extra);
    }
    for (const r of players || []) {
      const gid = r.game?.id, pid = r.player?.id;
      if (!gid || !pid) continue;
      got.add(gid);
      insP.run(gid, r.team?.id || 0, pid, r.player?.name || null, r.type === 'starters' ? 1 : 0, mins(r.minutes), num(r.points),
        num(r.field_goals?.total), num(r.field_goals?.attempts), num(r.threepoint_goals?.total), num(r.threepoint_goals?.attempts),
        num(r.freethrows_goals?.total), num(r.freethrows_goals?.attempts), num(r.rebounds?.total), num(r.assists), ...extra);
    }
    // markMissing false (the live job's fetch right after the final buzzer): a game the provider has no numbers for yet
    // keeps its live rows; the 30-minute pass asks again
    if (!live) for (const id of ids) { if (!got.has(id) && opts.markMissing === false) continue; mark.run(got.has(id) ? 1 : 2, id); dropT.run(id); dropP.run(id); }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  if (live) fixLiveFieldGoals([...got]);
  return got;
}

/**
 * Box scores (team and player stats) of finished games, 20 games per request, newest first.
 * `maxBatches` keeps one pass bounded; the next pass continues where this one stopped.
 */
async function syncBoxScores(maxBatches = 400) {
  const todo = db.prepare(`SELECT game_id FROM bb_games WHERE status IN ('FT','AOT') AND stats = 0 ORDER BY kickoff DESC LIMIT ?`).all(maxBatches * 20) as any[];
  let games = 0;
  for (let i = 0; i < todo.length; i += 20) {
    const ids = todo.slice(i, i + 20).map(r => r.game_id);
    const [t, p] = [await bb('/games/statistics/teams', { ids: ids.join('-') }), await bb('/games/statistics/players', { ids: ids.join('-') })];
    storeBoxRows(ids, t.response || [], p.response || [], false);
    games += ids.length;
  }
  if (games) logger.info(`API-Basketball: box scores for ${games} games`);
  fixFieldGoals();
  return games;
}

/**
 * fix208: the 2025-26 field-goal change (fixFieldGoals) on live lines, checked against the current score on every
 * fetch (the live rows are rewritten each time, so there is nothing to remember).
 */
function fixLiveFieldGoals(ids: number[]) {
  if (!ids.length) return;
  const rows = db.prepare(`SELECT t.game_id, t.team_id, t.fgm, t.tpm, t.ftm, g.home_id, g.hs, g.as_ FROM bb_team_stats_live t JOIN bb_games g ON g.game_id = t.game_id
    WHERE t.game_id IN (${ids.map(() => '?').join(',')}) AND g.hs IS NOT NULL AND t.fgm IS NOT NULL`).all(...ids) as any[];
  const fixT = db.prepare(`UPDATE bb_team_stats_live SET fgm = fgm + COALESCE(tpm, 0), fga = fga + COALESCE(tpa, 0) WHERE game_id = ? AND team_id = ?`);
  const fixP = db.prepare(`UPDATE bb_player_stats_live SET fgm = COALESCE(fgm, 0) + COALESCE(tpm, 0), fga = COALESCE(fga, 0) + COALESCE(tpa, 0) WHERE game_id = ? AND team_id = ?`);
  for (const r of rows) {
    const score = r.team_id === r.home_id ? r.hs : r.as_;
    const tpm = r.tpm || 0, ftm = r.ftm || 0;
    if (tpm > 0 && Math.abs(2 * r.fgm + 3 * tpm + ftm - score) < Math.abs(2 * r.fgm + tpm + ftm - score)) { fixT.run(r.game_id, r.team_id); fixP.run(r.game_id, r.team_id); }
  }
}

/* ---------- fix208: live box scores ---------- */

const LIVE_ST = ['Q1', 'Q2', 'Q3', 'Q4', 'OT', 'BT', 'HT'];
/** fetched every 3 minutes even when no one has the page open */
export const BB_MAJOR = new Set(['NBA', 'EL']);
const liveBox = { calls: 0, ticks: 0, skippedBudget: 0, games: 0, lastAt: 0, lastError: null as string | null, nbaExtras: null as string | null };
let liveBoxBusy = false;

/**
 * Every 60 s: the live games that are due (utils/liveBox.ts: watched 60 s, NBA / EuroLeague 3 min, others only while
 * watched), 20 per request pair; games that ended with live rows still stored get their final box score in the same
 * pass. Skipped when the day's quota is near its reserve (the bb() client counts every call and reads the quota left).
 */
export async function bbLiveBoxTick(now = Date.now()): Promise<number> {
  if (liveBoxBusy || !KEY()) return 0;
  liveBoxBusy = true;
  try {
    const rows = db.prepare(`SELECT g.game_id, g.code, (SELECT MAX(updated_at) FROM bb_player_stats_live p WHERE p.game_id = g.game_id) AS at
      FROM bb_games g WHERE g.status IN (${LIVE_ST.map(() => '?').join(',')}) AND g.kickoff > ?`).all(...LIVE_ST, new Date(now - 6 * 3600 * 1000).toISOString()) as any[];
    const due = dueGames(rows.map(r => ({ id: r.game_id, major: BB_MAJOR.has(r.code), lastAt: r.at ?? null })), gameViews('bb', now), now);
    const ended = (db.prepare(`SELECT DISTINCT p.game_id FROM bb_player_stats_live p JOIN bb_games g ON g.game_id = p.game_id WHERE g.status IN ('FT','AOT') AND g.stats = 0`).all() as any[]).map(r => r.game_id as number);
    if (!due.length && !ended.length) return 0;
    liveBox.ticks++;
    const batches = [...chunks(ended, 20).map(ids => ({ ids, live: false })), ...chunks(due, 20).map(ids => ({ ids, live: true }))];
    if (!budgetAllows(remainingDay, limitDay, batches.length * 2)) { liveBox.skippedBudget++; return 0; }
    let n = 0;
    for (const b of batches) {
      const t = await bb('/games/statistics/teams', { ids: b.ids.join('-') });
      const p = await bb('/games/statistics/players', { ids: b.ids.join('-') });
      liveBox.calls += 2;
      const got = storeBoxRows(b.ids, t.response || [], p.response || [], b.live, { markMissing: false });
      if (!b.live) fixFieldGoals();
      if (b.live) await nbaExtras([...got]);
      for (const id of got) boxUpdated('bb', id);
      n += b.live ? got.size : 0;
    }
    liveBox.games += n;
    liveBox.lastAt = Date.now();
    liveBox.lastError = null;
    return n;
  } catch (e: any) {
    liveBox.lastError = e.message;
    logger.warn(`API-Basketball live box scores: ${e.message}`);
    return 0;
  } finally {
    liveBoxBusy = false;
  }
}

/** NBA: steals, blocks, turnovers and plus-minus from balldontlie's live box scores (skipped quietly when it has none) */
async function nbaExtras(ids: number[]) {
  if (!ids.length) return;
  const nba = db.prepare(`SELECT game_id, home_name, away_name FROM bb_games WHERE code = 'NBA' AND game_id IN (${ids.map(() => '?').join(',')})`).all(...ids) as any[];
  if (!nba.length) return;
  try {
    const r = await nbaLiveExtras(nba.map(g => ({ id: g.game_id, home: g.home_name, away: g.away_name })));
    liveBox.nbaExtras = r.note;
    if (!r.byGame.size) return;
    const up = db.prepare(`UPDATE bb_player_stats_live SET stl = ?, blk = ?, tov = ?, pm = ? WHERE game_id = ? AND player_id = ?`);
    const list = db.prepare(`SELECT player_id, name FROM bb_player_stats_live WHERE game_id = ?`);
    db.exec('BEGIN');
    try {
      for (const [gid, byName] of r.byGame) {
        for (const pl of list.all(gid) as any[]) {
          const x = byName(pl.name);
          if (x) up.run(x.stl, x.blk, x.tov, x.pm, gid, pl.player_id);
        }
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  } catch (e: any) {
    liveBox.nbaExtras = `error: ${e.message}`;
  }
}

/** admin / data health: the live box-score job */
export const bbLiveBoxStatus = () => ({ ...liveBox, watched: gameViews('bb').size });

/** Past seasons once (a finished season never changes), the current season every 30 minutes. */
let ticking = false;
async function bbTick() {
  if (!KEY() || ticking) return;
  ticking = true;
  try { await bbTickInner(); } finally { ticking = false; }
}
async function bbTickInner() {
  for (const l of BB_LEAGUES) {
    try {
      const lg: any = await syncLeague(l);
      const seasons: string[] = JSON.parse(lg.seasons || '[]').slice(-SEASONS_BACK);
      const current = seasons[seasons.length - 1];
      for (const s of seasons) {
        const at = syncedAt(`games|${l.code}|${s}`);
        const fresh = s === current ? at && Date.now() - at < 25 * 60 * 1000 : !!at;
        if (fresh) continue;
        const n = await syncSeason(l.code, lg.league_id, s);
        logger.info(`API-Basketball: ${l.code} ${s} → ${n} games`);
      }
    } catch (e: any) {
      lastError = `${l.code}: ${e.message}`;
      logger.warn(`API-Basketball ${l.code}: ${e.message}`);
    }
  }
  try {
    fixFieldGoals();
    // fix135: only leagues with new results are refit, with a pause between leagues; then the predictions are saved
    await timed('bb model', () => buildAll(BB_LEAGUES.map(l => l.code)));
    await timed('bb predictions', () => recordBbPredictions());
  } catch (e: any) {
    logger.warn(`Basketball model: ${e.message}`);
  }
  try {
    await syncBoxScores();
  } catch (e: any) {
    lastError = `box scores: ${e.message}`;
    logger.warn(`API-Basketball box scores: ${e.message}`);
  }
  try {
    const r = await timed('bb result checks', () => checkResults());
    if (r.fixedAuto || r.open) logger.info(`bb result checks: ${r.checked} games, ${r.fixedAuto} corrected, ${r.open} open`);
  } catch (e: any) {
    logger.warn(`bb result checks: ${e.message}`);
  }
}

let started = false;
export function startBasketballScheduler() {
  if (started || !KEY()) return;
  started = true;
  // ratings from the stored games right away, so the site has predictions before the first sync finishes
  setTimeout(() => void (async () => {
    try {
      fixFieldGoals();
      await timed('bb model', () => buildAll(BB_LEAGUES.map(l => l.code)));
      await timed('bb predictions', () => recordBbPredictions());
    } catch (e: any) { logger.warn(`Basketball model: ${e.message}`); }
  })(), 15 * 1000).unref();
  after('bb sync', () => bbTick(), 45 * 1000).unref();
  every('bb sync', () => void bbTick(), 30 * 60 * 1000).unref();
  setInterval(() => void timed('bb live', () => liveTick()), 60 * 1000).unref(); // fix155: named in /api/perf
  // fix208: live box scores, 20 s after the scores (a game that just ended is already FT)
  setTimeout(() => setInterval(() => void timed('bb live box', () => bbLiveBoxTick()), 60 * 1000).unref(), 20 * 1000).unref();
  // NBA injury list every 15 minutes; the coming games' predictions are re-saved with it (until tip-off)
  const injuries = async () => {
    const n = await refreshNbaInjuries();
    // NBA only: the injury list touches NBA games, re-saving all 18 leagues every 15 min cost ~1.6 s (fix122)
    if (n !== null) { bumpBbInjuries(); publishState('bb:injuries', { at: Date.now() }); } // fix159: cached NBA predictions are recomputed with the new list
    if (n !== null) { try { await timed('bb predictions', () => recordBbPredictions(['NBA'])); } catch (e: any) { logger.warn(`Basketball predictions: ${e.message}`); } }
  };
  after('bb injuries', () => injuries(), 30 * 1000).unref();
  every('bb injuries', () => void injuries(), 15 * 60 * 1000).unref();
}

/** Admin: quota and how many games we hold per league and season. */
export async function bbStatus() {
  let account: any = null;
  try {
    const j = await bb('/status');
    const r = j.response?.requests;
    if (r) { limitDay = r.limit_day; remainingDay = Math.max(0, r.limit_day - r.current); }
    account = { plan: j.response?.subscription?.plan || null, active: j.response?.subscription?.active ?? null, end: j.response?.subscription?.end || null, requests: r || null };
  } catch (e: any) {
    account = { error: e.message };
  }
  const leagues = db.prepare(`SELECT code, league_id, name, country, seasons, checked_at FROM bb_leagues`).all() as any[];
  const games = db.prepare(`
    SELECT code, season, COUNT(*) AS games, SUM(CASE WHEN status IN ('FT','AOT') THEN 1 ELSE 0 END) AS finished,
      SUM(CASE WHEN stats = 1 THEN 1 ELSE 0 END) AS boxScores, SUM(CASE WHEN stats = 2 THEN 1 ELSE 0 END) AS noBoxScore, MIN(kickoff) AS first, MAX(kickoff) AS last
    FROM bb_games GROUP BY code, season ORDER BY code, season`).all();
  return { account, limitDay, remainingDay, callsThisBoot: calls, lastError, liveBox: bbLiveBoxStatus(), nbaInjuries: nbaInjuryStatus(), leagues: leagues.map(l => ({ ...l, seasons: JSON.parse(l.seasons) })), games };
}

/** Admin: start a sync pass now (runs in the background; box scores can take a few minutes). */
export async function bbSyncNow() {
  void bbTick();
  return bbStatus();
}
