/**
 * NFL data (fix136 data check, fix137 site) — no predictions yet, no odds stored. The pages (/american-football) are
 * admin-only until NFL_PUBLIC=1 (services/nflSite.ts).
 * API-American-Football (api-sports.io, same account): https://v1.american-football.api-sports.io, header
 * x-apisports-key = API_NFL_KEY or API_FOOTBALL_KEY. NFL = league 1, NCAA college football = league 2 (fix142: same tables,
 * a `league` column; NCAA: the last 10 seasons of games, box scores for the last 3, rosters of FBS teams, no injury lists).
 * Sync (every job checks the day's quota first and keeps a reserve):
 *  - games: every season the league lists once, then the current season every 30 min; live games every 30 s while
 *    a game is on (one /games?live=all call);
 *  - box scores (team + player statistics) after full time, and a backfill for the current and last season;
 *  - teams + standings every 6 h, injuries every 2 h, rosters daily.
 *  - /api/admin/nfl-probe: what the plan gives us (quota, seasons + coverage, games per season, sample statistics).
 */
import { db } from '../db';
import logger from '../utils/logger';
import { timed, yieldLoop, every, after, slicer } from './perf';

const BASE = 'https://v1.american-football.api-sports.io';
const KEY = () => process.env.API_NFL_KEY || process.env.API_FOOTBALL_KEY || '';
export const NFL_LEAGUE = 1;
/** fix142: 1 = NFL, 2 = NCAA (college football). */
export type LeagueId = 1 | 2;
export const LEAGUES: LeagueId[] = [1, 2];
export const leagueName = (l: LeagueId) => (l === 2 ? 'College football' : 'NFL');
export const asLeague = (x: unknown): LeagueId => (String(x) === '2' || /^(college|ncaa)$/i.test(String(x)) ? 2 : 1);
/** NCAA: seasons of games kept, seasons with box scores. */
const NCAA_SEASONS = 10, NCAA_BOX_SEASONS = 3;
/**
 * College levels (fix143): FBS, FCS or 'other' (Division II / III, NAIA …), from the conference AND division the provider
 * gives (either may hold the conference name or "FBS" / "FCS"). FBS: SEC, Big Ten, Big 12, ACC, Pac-12, American (AAC),
 * Mountain West, Sun Belt, MAC, Conference USA, FBS Independents. FCS: Big Sky, CAA, Missouri Valley, Southland, SWAC,
 * MEAC, OVC, Big South, Patriot, Ivy, Pioneer, NEC, SoCon, UAC, ASUN, WAC, FCS Independents. A plain "Independent" is
 * unknown (decided from the schedule).
 */
const FBS_CONF = /\b(fbs|i-?a|sec|southeastern|big ten|big 10|big 12|big twelve|acc|atlantic coast|pac-?12|pac-?twelve|pacific-?12|american athletic|aac|american( conference)?|mountain west|mwc|sun belt|mid-american|mac|conference usa|c-?usa)\b/i;
const FCS_CONF = /\b(fcs|i-?aa|big sky|caa|colonial|coastal athletic|missouri valley|mvfc|southland|swac|southwestern athletic|meac|mid-eastern|ohio valley|ovc|big south|patriot|ivy|pioneer|northeast|nec|southern conference|socon|united athletic|uac|western athletic|wac|asun|atlantic sun)\b/i;
const OTHER_CONF = /division (ii|iii|2|3)|\bd-?(ii|iii|2|3)\b|\bnaia\b|\bjuco\b|gulf south|great lakes|lone star|\bpsac\b|mid-america intercollegiate|\bmiaa\b|\bgliac\b|\brmac\b|\bnsic\b|south atlantic|great american|\bciaa\b|\bsiac\b|mountain east|great northwest|\bnescac\b|centennial|liberty league|empire 8/i;
/** College nicknames of two words ("Crimson Tide"): dropped whole to leave the school name (same list as frontend lib/nfl.ts). */
const TWO_WORD = /\s(crimson tide|nittany lions|fighting irish|yellow jackets|golden gophers|blue devils|tar heels|red raiders|horned frogs|sun devils|golden bears|demon deacons|scarlet knights|mean green|golden hurricane|golden eagles|green wave|red wolves|black knights|thundering herd|golden flashes|blue raiders|fighting illini|rainbow warriors|wolf pack|golden panthers|black bears|blue hens|golden lions|fighting hawks|big green|big red|purple eagles|mountain hawks|delta devils|golden rams|red flash|red foxes|blue hose|golden griffins|fighting camels|river hawks)$/i;
/** "Ohio State Buckeyes" → "Ohio State", "Alabama Crimson Tide" → "Alabama". */
export const schoolName = (name: string) => { const m = name.match(TWO_WORD); if (m) return name.slice(0, m.index); const w = name.split(/\s+/); return w.length > 1 ? w.slice(0, -1).join(' ') : name; };
/** The nickname part ("Crimson Tide", "Buckeyes"). */
export const collegeNick = (name: string) => name.slice(schoolName(name).length).trim();
export type Level = 'FBS' | 'FCS' | 'other';
export function levelOf(conference: string | null, division: string | null = null): Level | null {
  const text = [conference, division].filter(Boolean).join(' · ');
  if (!text) return null;
  if (/\bfcs\b|\bi-?aa\b/i.test(text)) return 'FCS';
  if (/\bfbs\b|\bi-?a\b/i.test(text)) return 'FBS';
  if (OTHER_CONF.test(text)) return 'other';
  if (/independent/i.test(text) && !FBS_CONF.test(text.replace(/independents?/i, '')) && !FCS_CONF.test(text.replace(/independents?/i, ''))) return null;
  if (FCS_CONF.test(text)) return 'FCS';
  if (FBS_CONF.test(text)) return 'FBS';
  return null; // a name we don't know: decided from the schedule (classifyCollegeTeams)
}
/** Games of FBS + FCS teams only: college lists leave out games with a Division II / III / other team (fix143). */
import { isFbsName } from './collegeFbs';
export const HIDE_OTHER = `AND home_id NOT IN (SELECT team_id FROM nfl_teams WHERE level = 'other') AND away_id NOT IN (SELECT team_id FROM nfl_teams WHERE level = 'other')`;

/**
 * Every college team's level (fix143, fix146). Steps:
 *  1. every team of a college game gets a row (the provider's /teams list misses many: ~3,600 games a season);
 *  2. conference / division (levelOf); 3. the FBS school list (collegeFbs.ts) for teams still unknown;
 *  4. opponents: an unknown team takes the level 60%+ of its known opponents have (last 2 seasons);
 *  5. when more than 10% are still unknown (no conferences from the provider): a team with 8+ games against known FBS
 *     teams in a season = FBS; a team that played an FBS team in at least half of its seasons = FCS (FCS teams play
 *     1–2 "guarantee games" a year, Division II teams almost never); opponents again; the rest = 'other'.
 * Logs "ncaa levels: FBS=n FCS=n other=n unknown=n" (+ conference names it did not know).
 */
export function classifyCollegeTeams(): Record<string, number> {
  const now = new Date().toISOString();
  // 1. a row for every team that played a college game
  db.prepare(`INSERT OR IGNORE INTO nfl_teams (team_id, name, logo, updated_at, league)
    SELECT id, name, logo, ?, 2 FROM (SELECT home_id AS id, MAX(home_name) AS name, MAX(home_logo) AS logo FROM nfl_games WHERE league = 2 AND home_id IS NOT NULL GROUP BY home_id
      UNION SELECT away_id, MAX(away_name), MAX(away_logo) FROM nfl_games WHERE league = 2 AND away_id IS NOT NULL GROUP BY away_id)`).run(now);
  const teams = db.prepare(`SELECT team_id, name, conference, division FROM nfl_teams WHERE league = 2`).all() as any[];
  const level = new Map<number, Level | null>(teams.map(t => [t.team_id as number, levelOf(t.conference, t.division)]));
  const unknownNames = new Set<string>();
  for (const t of teams) if (!level.get(t.team_id) && (t.conference || t.division)) unknownNames.add([t.conference, t.division].filter(Boolean).join(' · '));
  // 3. the FBS school list
  const games = db.prepare(`SELECT season, home_id, away_id FROM nfl_games WHERE league = 2 AND status IN ('FT','AOT') AND (stage IS NULL OR stage NOT LIKE 'Pre%') AND home_id IS NOT NULL AND away_id IS NOT NULL`).all() as any[];
  // a name match counts only with an FBS schedule: 5+ games against other listed schools in one season (keeps out
  // Division II namesakes like "Ohio Dominican" that slip past the name rules)
  const byName = new Set(teams.filter(t => !level.get(t.team_id) && t.name && isFbsName(t.name)).map(t => t.team_id as number));
  const vsListed = new Map<string, number>();
  for (const g of games) if (byName.has(g.home_id) && byName.has(g.away_id)) for (const id of [g.home_id, g.away_id]) vsListed.set(`${id}|${g.season}`, (vsListed.get(`${id}|${g.season}`) || 0) + 1);
  const confirmed = new Set([...vsListed].filter(([, n]) => n >= 5).map(([k]) => Number(k.split('|')[0])));
  for (const id of byName) if (confirmed.has(id) || !games.length) level.set(id, 'FBS');
  const last = games.reduce((m, g) => Math.max(m, g.season), 0);
  // 4. opponents (last 2 seasons)
  const propagate = () => {
    const opp = new Map<number, number[]>();
    for (const g of games) if (g.season >= last - 1) { (opp.get(g.home_id) || opp.set(g.home_id, []).get(g.home_id)!).push(g.away_id); (opp.get(g.away_id) || opp.set(g.away_id, []).get(g.away_id)!).push(g.home_id); }
    for (let pass = 0; pass < 4; pass++) {
      let changed = 0;
      for (const [id, list] of opp) {
        if (level.get(id)) continue;
        const known = list.map(o => level.get(o)).filter(Boolean) as Level[];
        if (known.length < 3) continue;
        // share of ALL opponents (not only the known ones): FCS teams play 1–3 FBS teams a year and must not become FBS
        for (const L of ['FBS', 'FCS', 'other'] as Level[]) if (known.filter(k => k === L).length / list.length >= 0.6) { level.set(id, L); changed++; break; }
      }
      if (!changed) break;
    }
  };
  propagate();
  // 5. the schedule fallback
  const unknownShare = () => teams.filter(t => !level.get(t.team_id)).length / Math.max(1, teams.length);
  const fallback = unknownShare() > 0.1;
  if (fallback) {
    const vsFbs = new Map<string, number>(), seasonsOf = new Map<number, Set<number>>(), fbsSeasons = new Map<number, Set<number>>();
    for (let round = 0; round < 2; round++) {
      vsFbs.clear();
      for (const g of games) for (const [me, op] of [[g.home_id, g.away_id], [g.away_id, g.home_id]]) {
        if (level.get(op) === 'FBS') vsFbs.set(`${me}|${g.season}`, (vsFbs.get(`${me}|${g.season}`) || 0) + 1);
      }
      for (const [k, n] of vsFbs) { const id = Number(k.split('|')[0]); if (n >= 8 && !level.get(id)) level.set(id, 'FBS'); }
    }
    for (const g of games) for (const [me, op] of [[g.home_id, g.away_id], [g.away_id, g.home_id]]) {
      (seasonsOf.get(me) || seasonsOf.set(me, new Set()).get(me)!).add(g.season);
      if (level.get(op) === 'FBS') (fbsSeasons.get(me) || fbsSeasons.set(me, new Set()).get(me)!).add(g.season);
    }
    for (const [id, ss] of seasonsOf) if (!level.get(id) && (fbsSeasons.get(id)?.size || 0) >= Math.max(1, ss.size / 2)) level.set(id, 'FCS');
    propagate();
  }
  const nFbs = [...level.values()].filter(l => l === 'FBS').length, nFcs = [...level.values()].filter(l => l === 'FCS').length;
  const classifiedOk = nFbs >= 60 && nFcs >= 40;
  if (fallback && !classifiedOk) logger.warn(`ncaa levels: only FBS=${nFbs} FCS=${nFcs} found — the rest stay unknown (shown), not 'other'`);
  const upd = db.prepare(`UPDATE nfl_teams SET level = ? WHERE team_id = ?`);
  const count: Record<string, number> = { FBS: 0, FCS: 0, other: 0, unknown: 0 };
  db.exec('BEGIN');
  try {
    for (const t of teams) {
      let L = level.get(t.team_id) ?? null;
      // fix150: leftovers become 'other' (hidden) only when FBS and FCS were both found in numbers; a failed
      // classification must not hide every college game — then they stay unknown (shown)
      if (!L && (t.conference || t.division || (fallback && classifiedOk))) L = 'other';
      upd.run(L, t.team_id);
      count[L || 'unknown']++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  if (teams.length) logger.info(`ncaa levels: FBS=${count.FBS} FCS=${count.FCS} other=${count.other} unknown=${count.unknown}${fallback ? ' (schedule fallback used)' : ''}${unknownNames.size ? ` · conferences not recognised: ${[...unknownNames].slice(0, 15).join(', ')}` : ''}`);
  return count;
}

/** fix146: on boot, college teams without any level → teams + standings sync now, levels, then ncaa-v1 retrained. */
/** fix150: "college lists: season S, week W, n games" + the full numbers (once per boot). */
async function logCollegeLists() {
  try {
    const { collegeListsDebug } = await import('./nflSite');
    const d = collegeListsDebug();
    logger.info(`college lists: season ${d.season}, week ${d.current}, ${d.currentWeekGames} games (season ${d.gamesInSeason} games, ${d.shownAfterHideOther} after HIDE_OTHER; next 24 h ${d.next24h}; levels ${JSON.stringify(d.levels)}; weeks ${d.weeks.join(' ')}; raw stage/week ${JSON.stringify(d.rawStageWeek).slice(0, 600)})`);
  } catch (e: any) { logger.warn(`college lists: ${e.message}`); }
}

export async function collegeLevelsOnBoot(): Promise<void> {
  const known = (db.prepare(`SELECT COUNT(*) AS n FROM nfl_teams WHERE league = 2 AND level IS NOT NULL`).get() as any)?.n || 0;
  const done = db.prepare(`SELECT 1 FROM nfl_sync WHERE key = 'ncaa|levels-fix150'`).get();
  if (known > 0 && done) { await logCollegeLists(); return; }
  try { await teamsAndStandings(2); } catch (e: any) { logger.warn(`College teams / standings: ${e.message}`); }
  const c = classifyCollegeTeams();
  db.prepare(`INSERT OR REPLACE INTO nfl_sync (key, at, detail) VALUES ('ncaa|levels-fix150', ?, ?)`).run(new Date().toISOString(), JSON.stringify(c));
  logCollegeLists();
  if (!c.FBS) return;
  const { retrain } = await import('./nflModel');
  const rep = await retrain(2); // logs FBS vs FBS / FBS vs FCS / all per season
  logger.info(`ncaa-v1 retrained after levels: all LL ${(rep.total.ab as any).logLoss} n=${(rep.total.ab as any).games}, FBS vs FBS n=${rep.fbs?.games ?? 0}, FBS vs FCS n=${rep.fbsFcs?.games ?? 0}`);
}
const MIN_GAP_MS = 400;

db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_games (
    game_id    INTEGER PRIMARY KEY,
    season     INTEGER NOT NULL,
    week       TEXT,
    stage      TEXT,
    kickoff    TEXT,
    home_id    INTEGER,
    home_name  TEXT,
    away_id    INTEGER,
    away_name  TEXT,
    status     TEXT,
    home_pts   INTEGER,
    away_pts   INTEGER,
    venue      TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_nfl_games_season ON nfl_games(season, kickoff);
  CREATE TABLE IF NOT EXISTS nfl_sync (key TEXT PRIMARY KEY, at TEXT NOT NULL, detail TEXT);
  CREATE TABLE IF NOT EXISTS nfl_teams (
    team_id INTEGER PRIMARY KEY, name TEXT NOT NULL, code TEXT, city TEXT, logo TEXT, conference TEXT, division TEXT,
    coach TEXT, stadium TEXT, updated_at TEXT NOT NULL
  );
  -- box scores: one row per game and team, the provider's statistics as JSON
  CREATE TABLE IF NOT EXISTS nfl_team_stats (game_id INTEGER NOT NULL, team_id INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (game_id, team_id));
  CREATE TABLE IF NOT EXISTS nfl_player_stats (game_id INTEGER NOT NULL, team_id INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (game_id, team_id));
  CREATE TABLE IF NOT EXISTS nfl_players (
    player_id INTEGER PRIMARY KEY, team_id INTEGER, name TEXT NOT NULL, position TEXT, grp TEXT, number INTEGER, age INTEGER,
    height TEXT, weight TEXT, college TEXT, experience INTEGER, image TEXT, season INTEGER, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_nfl_players_team ON nfl_players(team_id);
  CREATE TABLE IF NOT EXISTS nfl_injuries (
    player_id INTEGER NOT NULL, team_id INTEGER NOT NULL, player_name TEXT, image TEXT, status TEXT, description TEXT, date TEXT,
    updated_at TEXT NOT NULL, PRIMARY KEY (player_id, team_id)
  );
  CREATE TABLE IF NOT EXISTS nfl_standings (season INTEGER NOT NULL, team_id INTEGER NOT NULL, json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (season, team_id));
`);
for (const col of ['home_logo TEXT', 'away_logo TEXT', 'quarters TEXT', 'stats INTEGER DEFAULT 0', 'league INTEGER NOT NULL DEFAULT 1', 'clock TEXT']) {
  try { db.exec(`ALTER TABLE nfl_games ADD COLUMN ${col}`); } catch { /* already there */ }
}
// fix142: the league of every team (1 NFL, 2 NCAA) and, for college teams, FBS / FCS
for (const col of ['league INTEGER NOT NULL DEFAULT 1', 'level TEXT']) { try { db.exec(`ALTER TABLE nfl_teams ADD COLUMN ${col}`); } catch { /* already there */ } }
try { db.exec(`ALTER TABLE nfl_standings ADD COLUMN league INTEGER NOT NULL DEFAULT 1`); } catch { /* already there */ }
db.exec(`CREATE INDEX IF NOT EXISTS idx_nfl_games_league ON nfl_games(league, season, kickoff)`);
// fix158: games still without a team name (the full name fill reads only these) and recent games by kick-off (live tick)
const NONAME = "(home_name IS NULL OR home_name = '' OR away_name IS NULL OR away_name = '')";
db.exec(`CREATE INDEX IF NOT EXISTS idx_nfl_games_noname ON nfl_games(league) WHERE ${NONAME}`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_nfl_games_kickoff ON nfl_games(kickoff)`);

/* ---------- HTTP client (like apiFootball.ts: spacing, timeout, one retry, call count) ---------- */

let lastCall = 0;
let callsThisBoot = 0;
let remainingDay: number | null = null;
let limitDay: number | null = null;
let lastError: string | null = null;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function nfl(path: string, params: Record<string, string | number> = {}, retry = true): Promise<any> {
  if (!KEY()) throw new Error('API_NFL_KEY / API_FOOTBALL_KEY is not set');
  const wait = lastCall + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  let res: Response;
  try {
    res = await fetch(url, { headers: { 'x-apisports-key': KEY() }, signal: AbortSignal.timeout(20_000) });
  } catch (e: any) {
    if (retry) { await sleep(2000); return nfl(path, params, false); }
    lastError = `${path}: ${e.message}`;
    throw e;
  }
  callsThisBoot++;
  const rem = res.headers.get('x-ratelimit-requests-remaining'), lim = res.headers.get('x-ratelimit-requests-limit');
  if (rem) remainingDay = parseInt(rem, 10);
  if (lim) limitDay = parseInt(lim, 10);
  if ((res.status === 429 || res.status >= 500) && retry) { await sleep(res.status === 429 ? 61_000 : 2000); return nfl(path, params, false); }
  if (!res.ok) { lastError = `${path} HTTP ${res.status}`; throw new Error(lastError); }
  const json: any = await res.json();
  const errs = json.errors;
  if (errs && ((Array.isArray(errs) && errs.length) || (!Array.isArray(errs) && Object.keys(errs).length))) {
    lastError = `${path}: ${JSON.stringify(errs)}`;
    throw new Error(lastError);
  }
  return json;
}

/* ---------- games ---------- */

const num = (x: any) => (x === null || x === undefined || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));
function kickoffOf(g: any): string | null {
  const ts = num(g?.game?.date?.timestamp);
  if (ts) return new Date(ts * 1000).toISOString();
  const d = g?.game?.date?.date, t = g?.game?.date?.time;
  return d ? new Date(`${d}T${t || '00:00'}:00Z`).toISOString() : null;
}

const LIVE_STATUS = ['Q1', 'Q2', 'Q3', 'Q4', 'OT', 'HT'];
export const NFL_LIVE = LIVE_STATUS;
export const NFL_DONE = ['FT', 'AOT'];

/** Requests we may still spend today, keeping a reserve for the live games and the probe. */
const RESERVE = 25;
const budget = () => (remainingDay === null ? Infinity : remainingDay - RESERVE);

const upsert = db.prepare(`INSERT INTO nfl_games (game_id, season, week, stage, kickoff, home_id, home_name, home_logo, away_id, away_name, away_logo, status, home_pts, away_pts, quarters, venue, updated_at, league, clock)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(game_id) DO UPDATE SET league = excluded.league, season = excluded.season, week = excluded.week, stage = excluded.stage, kickoff = excluded.kickoff,
    home_id = excluded.home_id, home_name = excluded.home_name, home_logo = COALESCE(excluded.home_logo, home_logo),
    away_id = excluded.away_id, away_name = excluded.away_name, away_logo = COALESCE(excluded.away_logo, away_logo),
    status = excluded.status, home_pts = excluded.home_pts, away_pts = excluded.away_pts,
    quarters = COALESCE(excluded.quarters, quarters), venue = COALESCE(excluded.venue, venue), updated_at = excluded.updated_at, clock = excluded.clock`);

/** fix174: called after every store of games (nflLive.ts keeps the live win-chance samples); set once at start-up. */
let storedHook: ((ids: number[]) => void) | null = null;
export const setNflStoredHook = (fn: (ids: number[]) => void) => { storedHook = fn; };

/** Quarter scores [[q1..q4, ot], [q1..q4, ot]] (null where the provider has none). */
function quartersOf(g: any): string | null {
  const side = (s: any) => ['quarter_1', 'quarter_2', 'quarter_3', 'quarter_4', 'overtime'].map(k => num(s?.[k]));
  const h = side(g?.scores?.home), a = side(g?.scores?.away);
  return h.some(x => x !== null) || a.some(x => x !== null) ? JSON.stringify([h, a]) : null;
}

export function storeGames(list: any[], season?: number, league: LeagueId = 1) {
  const at = new Date().toISOString();
  db.exec('BEGIN');
  try {
    for (const g of list) {
      const id = num(g?.game?.id);
      const lg = num(g?.league?.id) ?? league;
      if (!id || (lg !== 1 && lg !== 2)) continue;
      const venue = [g?.game?.venue?.name, g?.game?.venue?.city].filter(Boolean).join(', ') || null;
      upsert.run(id, num(g?.league?.season) ?? season ?? 0, g?.game?.week != null ? String(g.game.week) : null, g?.game?.stage || null, kickoffOf(g),
        num(g?.teams?.home?.id), g?.teams?.home?.name || null, g?.teams?.home?.logo || null,
        num(g?.teams?.away?.id), g?.teams?.away?.name || null, g?.teams?.away?.logo || null,
        g?.game?.status?.short || null, num(g?.scores?.home?.total), num(g?.scores?.away?.total), quartersOf(g), venue, at, lg,
        g?.game?.status?.timer != null && g.game.status.timer !== '' ? String(g.game.status.timer) : null);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  // live and just-finished games: one win-chance sample each (the swing chart)
  if (storedHook) {
    const ids = list.filter(g => [...LIVE_STATUS, ...NFL_DONE].includes(g?.game?.status?.short)).map(g => num(g?.game?.id)).filter((x): x is number => !!x);
    if (ids.length) storedHook(ids);
  }
  // fix158: only this batch's games without a name (the live tick used to rescan the whole table every 30 s)
  const noName = list.filter(g => !g?.teams?.home?.name || !g?.teams?.away?.name).map(g => num(g?.game?.id)).filter((x): x is number => !!x);
  if (noName.length) fillNamesOf(noName);
}

/** fix158: games whose team has no known name yet are retried at most every 30 min (not on every live tick). */
const noNameTried = new Map<number, number>();
function fillNamesOf(ids: number[]): number {
  const now = Date.now();
  const todo = ids.filter(id => now - (noNameTried.get(id) || 0) > 30 * 60 * 1000);
  if (!todo.length) return 0;
  const marks = todo.map(() => '?').join(',');
  let n = 0;
  for (const side of ['home', 'away']) {
    n += Number(db.prepare(`UPDATE nfl_games SET ${side}_name = (SELECT name FROM nfl_teams t WHERE t.team_id = nfl_games.${side}_id AND t.name IS NOT NULL AND t.name != '')
      WHERE game_id IN (${marks}) AND (${side}_name IS NULL OR ${side}_name = '') AND ${side}_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM nfl_teams t WHERE t.team_id = nfl_games.${side}_id AND t.name IS NOT NULL AND t.name != '')`).run(...todo).changes || 0);
  }
  // still without a name: remember, so the same game is not retried every 30 s
  const still = new Set((db.prepare(`SELECT game_id FROM nfl_games WHERE game_id IN (${marks}) AND (home_name IS NULL OR home_name = '' OR away_name IS NULL OR away_name = '')`).all(...todo) as any[]).map(x => x.game_id));
  for (const id of todo) if (still.has(id)) noNameTried.set(id, now); else noNameTried.delete(id);
  if (noNameTried.size > 5000) noNameTried.clear();
  return n;
}

/**
 * fix151: games stored without a team name (the provider sends null for some college games) take the name from
 * nfl_teams by team id. Logs "college: n games had no team name, m filled" (at boot always, otherwise when it changed).
 */
export function fillMissingNames(always = true): { missing: number; filled: number } {
  // fix158: full-table version — boot, the 30-min sync and the 6-h standings only (the partial index keeps it quick)
  const count = () => (db.prepare(`SELECT COUNT(*) AS n FROM nfl_games WHERE league = 2 AND ${NONAME}`).get() as any)?.n || 0;
  const before = count();
  if (!before && !always) return { missing: 0, filled: 0 };
  for (const side of ['home', 'away']) {
    db.prepare(`UPDATE nfl_games SET ${side}_name = (SELECT name FROM nfl_teams t WHERE t.team_id = nfl_games.${side}_id AND t.name IS NOT NULL AND t.name != '')
      WHERE league = 2 AND ${NONAME} AND (${side}_name IS NULL OR ${side}_name = '') AND ${side}_id IS NOT NULL AND EXISTS (SELECT 1 FROM nfl_teams t WHERE t.team_id = nfl_games.${side}_id AND t.name IS NOT NULL AND t.name != '')`).run();
  }
  const after = count();
  if (always || before - after > 0) logger.info(`college: ${before} games had no team name, ${before - after} filled${after ? ` (${after} still shown as "TBD")` : ''}`);
  return { missing: before, filled: before - after };
}

/** Store one season's games (scores only: no odds). Returns how many games came back. */
const seasonKey = (season: number, league: LeagueId) => (league === 1 ? `season|${season}` : `season|${league}|${season}`);
export async function syncSeason(season: number, league: LeagueId = 1): Promise<number> {
  const j = await nfl('/games', { league, season });
  const list: any[] = Array.isArray(j.response) ? j.response : [];
  storeGames(list, season, league);
  db.prepare(`INSERT OR REPLACE INTO nfl_sync (key, at, detail) VALUES (?, ?, ?)`).run(seasonKey(season, league), new Date().toISOString(), String(list.length));
  return list.length;
}

/** The league's seasons with their coverage flags (one call). */
export async function nflSeasons(league: LeagueId = 1): Promise<{ season: number; current: boolean; start: string | null; end: string | null; coverage: any }[]> {
  const j = await nfl('/leagues', { id: league });
  const lg = (Array.isArray(j.response) ? j.response : [])[0];
  const list = (lg?.seasons || []).map((s: any) => ({ season: Number(s.year ?? s.season), current: !!s.current, start: s.start || null, end: s.end || null, coverage: s.coverage || null }))
    .filter((s: any) => Number.isFinite(s.season)).sort((a: any, b: any) => a.season - b.season);
  const cur = currentOf(list);
  if (cur) db.prepare(`INSERT OR REPLACE INTO nfl_sync (key, at, detail) VALUES (?, ?, ?)`).run(league === 1 ? 'current' : `current|${league}`, new Date().toISOString(), String(cur));
  return list;
}
const currentOf = (seasons: { season: number; current: boolean }[]) => (seasons.find(s => s.current) || seasons[seasons.length - 1])?.season ?? null;

/** The current season (stored at the last /leagues call; else the latest season we hold games for). */
export function nflCurrentSeason(league: LeagueId = 1): number | null {
  const r = db.prepare(`SELECT detail FROM nfl_sync WHERE key = ?`).get(league === 1 ? 'current' : `current|${league}`) as any;
  if (r?.detail && Number.isFinite(Number(r.detail))) return Number(r.detail);
  return (db.prepare(`SELECT MAX(season) AS s FROM nfl_games WHERE league = ?`).get(league) as any)?.s ?? null;
}

/** Backfill every listed season not stored yet, then refresh the current one. */
export async function nflSync(): Promise<{ seasons: number; synced: Record<string, number | string> }> {
  const synced: Record<string, number | string> = {};
  let count = 0;
  for (const league of LEAGUES) {
    let seasons: Awaited<ReturnType<typeof nflSeasons>> = [];
    try { seasons = await nflSeasons(league); } catch (e: any) { synced[leagueName(league)] = e.message; continue; }
    // NCAA: the last 10 seasons only
    if (league === 2) seasons = seasons.slice(-NCAA_SEASONS);
    count += seasons.length;
    const cur = currentOf(seasons);
    for (const s of seasons) {
      const key = `${league === 1 ? '' : 'NCAA '}${s.season}`;
      const done = db.prepare(`SELECT 1 FROM nfl_sync WHERE key = ?`).get(seasonKey(s.season, league));
      if (done && s.season !== cur) continue;
      if (budget() < 1) { synced[key] = 'no requests left today'; break; }
      try { synced[key] = await syncSeason(s.season, league); }
      catch (e: any) { synced[key] = e.message; logger.warn(`${leagueName(league)} ${s.season}: ${e.message}`); }
      await yieldLoop();
    }
  }
  const seasons = { length: count };
  db.prepare(`INSERT OR REPLACE INTO nfl_sync (key, at, detail) VALUES ('last', ?, ?)`).run(new Date().toISOString(), JSON.stringify(synced));
  return { seasons: seasons.length, synced };
}

/* ---------- live ---------- */

/** A game is on (or about to start / just ended): poll the live scores every 30 s. */
function liveWindow(): boolean {
  const now = Date.now();
  const r = db.prepare(`SELECT COUNT(*) AS n FROM nfl_games WHERE kickoff >= ? AND kickoff <= ? AND (status IS NULL OR status NOT IN ('FT','AOT','CANC','PST'))`)
    .get(new Date(now - 5 * 3600 * 1000).toISOString(), new Date(now + 10 * 60 * 1000).toISOString()) as any;
  return (r?.n || 0) > 0;
}
let liveBusy = false;
export async function nflLiveTick(): Promise<number> {
  if (liveBusy || !liveWindow() || budget() < 1) return 0;
  liveBusy = true;
  try {
    const before = new Map((db.prepare(`SELECT game_id, status FROM nfl_games WHERE status IN ('Q1','Q2','Q3','Q4','OT','HT')`).all() as any[]).map(r => [r.game_id, r.status]));
    const j = await nfl('/games', { live: 'all' });
    const list: any[] = (Array.isArray(j.response) ? j.response : []).filter((g: any) => num(g?.league?.id) === 1 || num(g?.league?.id) === 2);
    storeGames(list);
    // games that were live and dropped off the live list: fetch them once to get the final score
    const live = new Set(list.map(g => num(g?.game?.id)));
    for (const id of before.keys()) if (!live.has(id) && budget() >= 1) {
      try { storeGames((await nfl('/games', { id })).response || []); } catch (e: any) { logger.warn(`NFL game ${id}: ${e.message}`); }
    }
    return list.length;
  } finally { liveBusy = false; }
}

/* ---------- box scores ---------- */

db.exec(`CREATE TABLE IF NOT EXISTS nfl_events (game_id INTEGER PRIMARY KEY, json TEXT, updated_at TEXT NOT NULL)`);
// fix174: which games each player has a box-score line in (player page career), filled with every box score
db.exec(`CREATE TABLE IF NOT EXISTS nfl_player_games (player_id INTEGER NOT NULL, game_id INTEGER NOT NULL, team_id INTEGER NOT NULL, PRIMARY KEY (player_id, game_id));
  CREATE INDEX IF NOT EXISTS idx_nfl_player_games_game ON nfl_player_games(game_id, team_id)`);
const putPlayerGame = db.prepare(`INSERT OR IGNORE INTO nfl_player_games (player_id, game_id, team_id) VALUES (?, ?, ?)`);
function indexPlayers(gameId: number, teamId: number, groupsJson: string | null) {
  let groups: any[] = [];
  try { groups = groupsJson ? JSON.parse(groupsJson) : []; } catch { groups = []; }
  const ids = new Set<number>();
  for (const g of Array.isArray(groups) ? groups : []) for (const p of g?.players || []) { const id = num(p?.player?.id); if (id) ids.add(id); }
  for (const id of ids) putPlayerGame.run(id, gameId, teamId);
}
/** Backfill of nfl_player_games from the box scores stored before fix174 (once; 30-ms slices, so visitors never wait). */
export async function backfillPlayerGames(): Promise<number> {
  const done = db.prepare(`SELECT at FROM nfl_sync WHERE key = 'player-games'`).get() as any;
  if (done) return 0;
  const todo = db.prepare(`SELECT p.game_id, p.team_id FROM nfl_player_stats p WHERE NOT EXISTS (SELECT 1 FROM nfl_player_games x WHERE x.game_id = p.game_id AND x.team_id = p.team_id)`).all() as any[];
  const one = db.prepare(`SELECT json FROM nfl_player_stats WHERE game_id = ? AND team_id = ?`);
  const slice = slicer();
  let n = 0;
  for (const r of todo) {
    indexPlayers(r.game_id, r.team_id, (one.get(r.game_id, r.team_id) as any)?.json ?? null);
    n++;
    await slice();
  }
  db.prepare(`INSERT OR REPLACE INTO nfl_sync (key, at, detail) VALUES ('player-games', ?, ?)`).run(new Date().toISOString(), String(n));
  return n;
}
/** fix174: the scoring plays of a game (games/events), stored as we show them; [] when the provider has none. */
function storeEvents(gameId: number, list: any[]) {
  const rows = (Array.isArray(list) ? list : []).map((e: any) => ({
    quarter: e?.quarter ?? null, minute: e?.minute ?? null, team: num(e?.team?.id), teamName: e?.team?.name || null, player: e?.player?.name || null, playerId: num(e?.player?.id),
    type: e?.type || null, comment: e?.comment || null, score: e?.score ? [num(e.score.home), num(e.score.away)] : null
  }));
  db.prepare(`INSERT OR REPLACE INTO nfl_events (game_id, json, updated_at) VALUES (?, ?, ?)`).run(gameId, JSON.stringify(rows), new Date().toISOString());
}

/** Team + player statistics of one finished game (2 calls; the current season also its scoring plays, 1 more). */
export async function syncBoxScore(gameId: number): Promise<boolean> {
  const teams = (await nfl('/games/statistics/teams', { id: gameId })).response || [];
  const players = (await nfl('/games/statistics/players', { id: gameId })).response || [];
  const row = db.prepare(`SELECT season, league FROM nfl_games WHERE game_id = ?`).get(gameId) as any;
  if (row && row.season === nflCurrentSeason(row.league === 2 ? 2 : 1) && budget() >= 1) {
    try { storeEvents(gameId, (await nfl('/games/events', { id: gameId })).response || []); } catch (e: any) { logger.warn(`NFL events ${gameId}: ${e.message}`); }
  }
  db.exec('BEGIN');
  try {
    for (const t of teams) { const tid = num(t?.team?.id); if (tid) db.prepare(`INSERT OR REPLACE INTO nfl_team_stats (game_id, team_id, json) VALUES (?, ?, ?)`).run(gameId, tid, JSON.stringify(t.statistics || {})); }
    for (const t of players) { const tid = num(t?.team?.id); if (tid) { const json = JSON.stringify(t.groups || []); db.prepare(`INSERT OR REPLACE INTO nfl_player_stats (game_id, team_id, json) VALUES (?, ?, ?)`).run(gameId, tid, json); indexPlayers(gameId, tid, json); } }
    // 1 = stored, 2 = the provider has none for this game (don't ask again)
    db.prepare(`UPDATE nfl_games SET stats = ? WHERE game_id = ?`).run(teams.length || players.length ? 1 : 2, gameId);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return teams.length > 0;
}

/** Finished games of the last 10 seasons without a box score yet, newest first (up to `max` per run; fix139: ~600 calls a
 *  season, so the backfill is spread over a few hours of 30-min ticks). */
export async function nflBoxScores(max = 150): Promise<number> {
  const cur = nflCurrentSeason(1), cur2 = nflCurrentSeason(2);
  if (!cur && !cur2) return 0;
  // NFL: the last 10 seasons; NCAA (fix142): the last 3 — newest first across both leagues
  const todo = db.prepare(`SELECT game_id FROM nfl_games WHERE status IN ('FT','AOT') AND COALESCE(stats, 0) = 0
    AND ((league = 1 AND season BETWEEN ? AND ?) OR (league = 2 AND season BETWEEN ? AND ?)) ORDER BY kickoff DESC LIMIT ?`)
    .all((cur ?? 0) - 9, cur ?? 0, (cur2 ?? 0) - (NCAA_BOX_SEASONS - 1), cur2 ?? 0, max) as any[];
  let n = 0;
  for (const g of todo) {
    if (budget() < 2) break;
    try { await syncBoxScore(g.game_id); n++; } catch (e: any) { logger.warn(`NFL box score ${g.game_id}: ${e.message}`); }
    if (n % 5 === 0) await yieldLoop();
  }
  return n;
}

/* ---------- teams, standings, injuries, rosters ---------- */

/** Teams (logo, coach, stadium) and standings (conference, division, record) of the current season: 2 calls. */
export async function nflTeamsAndStandings(): Promise<number> {
  let n = 0;
  for (const league of LEAGUES) { try { n += await teamsAndStandings(league); } catch (e: any) { logger.warn(`${leagueName(league)} teams / standings: ${e.message}`); } }
  return n;
}
async function teamsAndStandings(league: LeagueId): Promise<number> {
  const season = nflCurrentSeason(league);
  if (!season || budget() < 2) return 0;
  const at = new Date().toISOString();
  const teams: any[] = (await nfl('/teams', { league, season })).response || [];
  const rows: any[] = (await nfl('/standings', { league, season })).response || [];
  // NFL: AFC / NFC; college: the conference as the provider names it
  const confShort = (c: any) => (league === 2 ? (c ? String(c) : null) : /american/i.test(String(c)) ? 'AFC' : /national/i.test(String(c)) ? 'NFC' : c ? String(c) : null);
  db.exec('BEGIN');
  try {
    for (const t of teams) {
      const id = num(t?.id);
      if (!id || !t?.name) continue;
      db.prepare(`INSERT INTO nfl_teams (team_id, name, code, city, logo, coach, stadium, updated_at, league) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(team_id) DO UPDATE SET name = excluded.name, code = excluded.code, city = excluded.city, logo = COALESCE(excluded.logo, logo),
        coach = excluded.coach, stadium = excluded.stadium, updated_at = excluded.updated_at, league = excluded.league`)
        .run(id, t.name, t.code || null, t.city || null, t.logo || null, t.coach || null, t.stadium || null, at, league);
      // fix143: a college team's conference straight from /teams when the provider gives one (standings may lack it)
      const tc = league === 2 ? (t.conference?.name ?? t.conference ?? t.group?.name ?? null) : null;
      if (tc && typeof tc === 'string') db.prepare(`UPDATE nfl_teams SET conference = COALESCE(conference, ?), division = COALESCE(division, ?) WHERE team_id = ?`).run(tc, typeof t.division === 'string' ? t.division : t.division?.name ?? null, id);
    }
    for (const r of rows) {
      const id = num(r?.team?.id);
      if (!id) continue;
      db.prepare(`INSERT OR REPLACE INTO nfl_standings (season, team_id, json, updated_at, league) VALUES (?, ?, ?, ?, ?)`).run(season, id, JSON.stringify(r), at, league);
      const conf = confShort(typeof r.conference === 'object' && r.conference ? r.conference.name : r.conference);
      const div = typeof r.division === 'object' && r.division ? r.division.name : r.division;
      db.prepare(`INSERT INTO nfl_teams (team_id, name, logo, conference, division, updated_at, league, level) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(team_id) DO UPDATE SET conference = COALESCE(excluded.conference, conference), division = COALESCE(excluded.division, division), logo = COALESCE(logo, excluded.logo), league = excluded.league`)
        .run(id, r.team?.name || String(id), r.team?.logo || null, conf, div || null, at, league, null);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  if (league === 2) { classifyCollegeTeams(); fillMissingNames(false); } // fix143: levels; fix151: names from the team list
  return rows.length;
}

/** NFL teams (injuries: NFL only — a call per team every 2 h is too much for ~250 college teams). */
const teamIds = () => (db.prepare(`SELECT team_id FROM nfl_teams WHERE league = 1 ORDER BY team_id`).all() as any[]).map(r => r.team_id as number);
/** Rosters: NFL teams and FBS college teams (fix142). */
const rosterTeams = () => (db.prepare(`SELECT team_id, league FROM nfl_teams WHERE league = 1 OR (league = 2 AND level = 'FBS') ORDER BY league, team_id`).all() as any[]).map(r => ({ id: r.team_id as number, league: r.league as LeagueId }));

/** Injury list of every team (one call per team). */
export async function nflInjuries(): Promise<number> {
  let n = 0;
  const at = new Date().toISOString();
  for (const id of teamIds()) {
    if (budget() < 1) break;
    try {
      const list: any[] = (await nfl('/injuries', { team: id })).response || [];
      db.exec('BEGIN');
      try {
        db.prepare(`DELETE FROM nfl_injuries WHERE team_id = ?`).run(id);
        for (const x of list) {
          const pid = num(x?.player?.id);
          if (!pid) continue;
          db.prepare(`INSERT OR REPLACE INTO nfl_injuries (player_id, team_id, player_name, image, status, description, date, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(pid, id, x.player?.name || null, x.player?.image || null, x.status || null, x.description || null, x.date || null, at);
          n++;
        }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    } catch (e: any) { logger.warn(`NFL injuries ${id}: ${e.message}`); }
    await yieldLoop();
  }
  return n;
}

/** Rosters (bio, position, number, picture) of every team for the current season (one call per team). */
export async function nflRosters(): Promise<number> {
  let n = 0;
  const at = new Date().toISOString();
  for (const { id, league } of rosterTeams()) {
    const season = nflCurrentSeason(league);
    if (!season) continue;
    if (budget() < 1) break;
    try {
      const list: any[] = (await nfl('/players', { team: id, season })).response || [];
      db.exec('BEGIN');
      try {
        for (const p of list) {
          const pid = num(p?.id);
          if (!pid || !p?.name) continue;
          db.prepare(`INSERT OR REPLACE INTO nfl_players (player_id, team_id, name, position, grp, number, age, height, weight, college, experience, image, season, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(pid, id, p.name, p.position || null, p.group || null, num(p.number), num(p.age), p.height || null, p.weight || null, p.college || null, num(p.experience), p.image || null, season, at);
          n++;
        }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    } catch (e: any) { logger.warn(`NFL roster ${id}: ${e.message}`); }
    await yieldLoop();
  }
  return n;
}

/* ---------- scheduler ---------- */

const ranAt = (key: string) => { const r = db.prepare(`SELECT at FROM nfl_sync WHERE key = ?`).get(key) as any; return r ? Date.parse(r.at) : 0; };
const mark = (key: string, detail: unknown) => db.prepare(`INSERT OR REPLACE INTO nfl_sync (key, at, detail) VALUES (?, ?, ?)`).run(key, new Date().toISOString(), String(detail));

let started = false;
let tickBusy = false;
export function startNflScheduler() {
  if (started || !KEY()) return;
  started = true;
  // fix143 / fix146: levels for every college team; with none yet, sync teams + standings now and retrain ncaa-v1
  after('nfl names / levels', () => { try { fillMissingNames(true); } catch (e: any) { logger.warn(`college names: ${e.message}`); } return collegeLevelsOnBoot().catch(e => logger.warn(`College levels: ${e.message}`)); }, 20 * 1000);
  // every 30 min: games of the current season (+ backfill), box scores, then whatever is due (each job keeps its own clock)
  const tick = async () => {
    if (tickBusy) return;
    tickBusy = true;
    try {
      const r = await timed('nfl games', () => nflSync());
      await timed('nfl names', () => fillMissingNames(false)); // fix158: the full-table fill, every 30 min (never from the live tick)
      const synced = Object.entries(r.synced).map(([s, n]) => `${s}=${n}`).join(' ');
      if (synced) logger.info(`NFL games: ${synced}`);
      const box = await timed('nfl box scores', () => nflBoxScores());
      if (box) logger.info(`NFL box scores: ${box}`);
      if (Date.now() - ranAt('job|standings') > 6 * 3600 * 1000) mark('job|standings', await timed('nfl standings', () => nflTeamsAndStandings()));
      if (Date.now() - ranAt('job|injuries') > 2 * 3600 * 1000) mark('job|injuries', await timed('nfl injuries', () => nflInjuries()));
      if (Date.now() - ranAt('job|rosters') > 24 * 3600 * 1000) mark('job|rosters', await timed('nfl rosters', () => nflRosters()));
      // fix139: weekly re-tune (Tuesday) + save the coming predictions (after the injury report)
      const { nflModelTick } = await import('./nflModel');
      await timed('nfl model', () => nflModelTick());
    } catch (e: any) {
      logger.warn(`NFL sync: ${e.message}`);
    } finally { tickBusy = false; }
  };
  after('nfl sync', () => tick(), 10 * 60 * 1000).unref(); // after the football and basketball start-up work
  every('nfl sync', () => void tick(), 30 * 60 * 1000).unref();
  // live scores every 30 s while a game is on; box score right after full time
  // fix155: only the last 8 hours are looked at; a game that ended adds its result to the ratings (no replay) and the
  // coming predictions are re-saved asynchronously (yields between games), under their own label for /api/perf
  setInterval(() => void timed('nfl live', async () => {
    const since = () => new Date(Date.now() - 8 * 3600 * 1000).toISOString();
    const recentEnded = () => (db.prepare(`SELECT game_id FROM nfl_games WHERE status IN ('FT','AOT') AND COALESCE(stats, 0) = 0 AND kickoff > ?`).all(since()) as any[]).map(r => r.game_id as number);
    const before = new Set(recentEnded());
    await nflLiveTick();
    const ended = recentEnded().filter(id => !before.has(id));
    for (const id of ended) if (budget() >= 2) { try { await syncBoxScore(id); } catch (e: any) { logger.warn(`NFL box score ${id}: ${e.message}`); } await yieldLoop(); }
    if (ended.length) { const { saveNflPredictions } = await import('./nflModel'); await yieldLoop(); await timed('nfl live predictions', () => saveNflPredictions()); }
  }).catch(e => logger.warn(`NFL live: ${e.message}`)), 30 * 1000).unref();
  // fix155: the live ratings are built in the background (with yields) instead of on the first request
  // fix171: a 10 s pause between the leagues, so the two builds never run back to back
  setTimeout(() => void (async () => {
    const { rebuildLive } = await import('./nflModel');
    for (const [i, lg] of LEAGUES.entries()) {
      if (i) await new Promise(r => setTimeout(r, 10 * 1000));
      await timed('nfl ratings', () => rebuildLive(lg));
    }
  })().catch(e => logger.warn(`NFL ratings: ${e.message}`)), 60 * 1000).unref();
}

export const nflClientStatus = () => ({ callsThisBoot, remainingDay, limitDay, lastError });

/* ---------- admin probe ---------- */

const FINISHED_SQL = `status IN ('FT','AOT') AND home_pts IS NOT NULL AND away_pts IS NOT NULL`;

/** Field names of an API object, 2 levels deep ("game.date.timestamp" → "game.date"), for "what fields exist". */
function fieldsOf(x: any, depth = 2, prefix = ''): string[] {
  if (!x || typeof x !== 'object' || Array.isArray(x) || depth === 0) return prefix ? [prefix] : [];
  return Object.keys(x).flatMap(k => fieldsOf(x[k], depth - 1, prefix ? `${prefix}.${k}` : k));
}
/** Statistic names inside a statistics response (team rows or player groups). */
function statNames(resp: any[]): string[] {
  const names = new Set<string>();
  const walk = (v: any, d: number) => {
    if (!v || d > 10) return; // players: team → groups → group → players → player → statistics → stat
    if (Array.isArray(v)) { for (const y of v.slice(0, 40)) walk(y, d + 1); return; }
    if (typeof v !== 'object') return;
    if (typeof v.name === 'string' && ('value' in v || 'total' in v)) names.add(v.name);
    for (const [k, y] of Object.entries(v)) {
      if (k === 'statistics' && y && typeof y === 'object' && !Array.isArray(y)) {
        for (const [sk, sv] of Object.entries(y as any)) if (sv && typeof sv === 'object' && !Array.isArray(sv)) for (const k2 of Object.keys(sv as any)) names.add(`${sk}.${k2}`); else names.add(sk);
      } else walk(y, d + 1);
    }
  };
  walk(resp, 0);
  return [...names].slice(0, 120);
}

let probeCache: { at: number; data: any } | null = null;

/** What the NFL data looks like on our plan (about 10 API calls; cached 10 minutes unless refresh). */
export async function nflProbe(refresh = false) {
  if (probeCache && !refresh && Date.now() - probeCache.at < 10 * 60 * 1000) return { ...probeCache.data, cached: true };
  const errors: Record<string, string> = {};
  const safe = async <T>(label: string, fn: () => Promise<T>): Promise<T | null> => { try { return await fn(); } catch (e: any) { errors[label] = e.message; return null; } };

  const status = await safe('status', async () => {
    const r = (await nfl('/status')).response || {};
    return { plan: r.subscription?.plan ?? null, active: r.subscription?.active ?? null, end: r.subscription?.end ?? null, requestsToday: r.requests?.current ?? null, limitDay: r.requests?.limit_day ?? null };
  });
  const seasons = (await safe('leagues', () => nflSeasons())) || [];
  const cur = currentOf(seasons);

  // what we hold, per season (from our table: no calls)
  const stored = db.prepare(`SELECT season, COUNT(*) AS games,
      SUM(CASE WHEN ${FINISHED_SQL} THEN 1 ELSE 0 END) AS finished,
      SUM(CASE WHEN stage LIKE 'Regular%' THEN 1 ELSE 0 END) AS regular,
      SUM(CASE WHEN stage LIKE 'Post%' THEN 1 ELSE 0 END) AS playoffs,
      SUM(CASE WHEN stage LIKE 'Pre%' THEN 1 ELSE 0 END) AS preseason,
      MIN(kickoff) AS first, MAX(kickoff) AS last
    FROM nfl_games GROUP BY season ORDER BY season`).all() as any[];
  const bySeason = new Map(stored.map(r => [r.season, r]));

  // samples: 3 finished games of the latest season we hold finished games for
  const latest = (db.prepare(`SELECT MAX(season) AS s FROM nfl_games WHERE ${FINISHED_SQL}`).get() as any)?.s ?? null;
  const sample = latest ? db.prepare(`SELECT game_id, kickoff, home_id, home_name, away_id, away_name, home_pts, away_pts FROM nfl_games WHERE season = ? AND ${FINISHED_SQL} ORDER BY kickoff DESC LIMIT 3`).all(latest) as any[] : [];
  const samples = [];
  for (const g of sample) {
    const teams = await safe(`teams ${g.game_id}`, async () => (await nfl('/games/statistics/teams', { id: g.game_id })).response || []);
    const players = await safe(`players ${g.game_id}`, async () => (await nfl('/games/statistics/players', { id: g.game_id })).response || []);
    samples.push({
      game: `${g.home_name} ${g.home_pts}–${g.away_pts} ${g.away_name}`, id: g.game_id, date: g.kickoff,
      teamStats: teams ? { rows: teams.length, fields: fieldsOf(teams[0]), stats: statNames(teams) } : null,
      playerStats: players ? { rows: players.length, groups: [...new Set(players.flatMap((t: any) => (t.groups || []).map((x: any) => x.name)).filter(Boolean))], fields: fieldsOf(players[0]), stats: statNames(players) } : null
    });
  }

  // injuries for 2 teams (the first sample game's sides)
  const injuries = [];
  for (const t of sample[0] ? [[sample[0].home_id, sample[0].home_name], [sample[0].away_id, sample[0].away_name]] : []) {
    const r = await safe(`injuries ${t[1]}`, async () => (await nfl('/injuries', { team: t[0] })).response || []);
    injuries.push({ team: t[1], count: r ? r.length : null, fields: r && r[0] ? fieldsOf(r[0]) : [] });
  }

  const standings = cur ? await safe('standings', async () => {
    const r = (await nfl('/standings', { league: NFL_LEAGUE, season: cur })).response || [];
    return { season: cur, rows: r.length, fields: r[0] ? fieldsOf(r[0]) : [] };
  }) : null;

  const data = {
    checkedAt: new Date().toISOString(),
    keyFrom: process.env.API_NFL_KEY ? 'API_NFL_KEY' : process.env.API_FOOTBALL_KEY ? 'API_FOOTBALL_KEY' : null,
    status, currentSeason: cur,
    seasons: seasons.map(s => ({ ...s, stored: bySeason.get(s.season) || null })),
    stored: { games: stored.reduce((n, r) => n + r.games, 0), finished: stored.reduce((n, r) => n + r.finished, 0), seasons: stored.length },
    lastSync: db.prepare(`SELECT at, detail FROM nfl_sync WHERE key = 'last'`).get() || null,
    samples, injuries, standings,
    client: { callsThisBoot, remainingDay, limitDay, lastError },
    errors
  };
  probeCache = { at: Date.now(), data };
  return data;
}
