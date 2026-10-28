/**
 * fix267 — the whole career on every player page, every sport (Yarin: "like football", fix152).
 *
 * Seasons come from the providers and are stored for good in player_seasons (one row per player, season, team, league,
 * regular season / playoffs, with the source of every number); player_careers says when a player's career was built,
 * whether it is complete and why not. The page reads only the database; a player without a stored career (or a stale
 * one) is queued and the worker's "player careers" job fetches it (the page says "older seasons are loading").
 *
 *  - basketball, NBA: balldontlie season averages (GOAT plan: every season the provider has; we ask back to 1979-80),
 *    regular season and playoffs, the teams of each season from that season's game lines; the current season from
 *    bdl_season (synced daily);
 *  - basketball, every other league: API-Basketball game lines per player and season (/games/statistics/players),
 *    summed per team and league (our games say the league and the stage; other competitions = "other games");
 *  - our own box scores fill the current season live (they replace the provider's line for that season);
 *  - American football: API-American-Football season totals (/players/statistics) for every season the plan has,
 *    college seasons where the provider has them under the same id; our box scores fill the current season;
 *  - tennis: year by year from the results — 1968–2014 from the provider's archive (by name: the archive has its own
 *    ids), 2015–2022 from the stored archive, 2023 → now from our feed; no prize money (the provider gives none).
 *
 * Refreshed monthly (top 100 per sport + every stored career), the current season weekly. Data health "Player careers":
 * the share of each sport's top 100 with a complete career. Admin: /api/admin/player-careers?sport=&id=[&refresh=1].
 */
import { db } from '../db';
import logger from '../utils/logger';
import { runsJobs } from './role';
import { deferred } from './deferredWrites';
import { isCrawlerRequest } from './afUsage';
import { bdlCall, bdlPlayerOf, bdlSeasonNow } from './bdl';
import { bbGet, bbRemainingDay, BB_LEAGUES } from './basketball';
import { isPreseason } from './bbModel';
import { nbaKey } from './bbInjuries';
import { nflCall, nflBudgetLeft, nflSeasons, nflCurrentSeason, type LeagueId } from './nfl';
import { tennisCall } from './tennis';
import { canSpend } from './tennis';
import { tennisModelInternals } from './tennisModel';
import { normRound } from '../utils/tennisRounds';
import {
  bdlLine, apiBbLines, bbLabel, bbStart, nflStatsOf, nflGroupOf, tennisYears, careerView, num,
  type CareerLine, type CareerSport, type CareerTeam, type CareerView, type TennisCareerMatch
} from '../utils/careers';

const DAY = 86400000;
export const CAREER_MONTH = 30 * DAY;
export const CAREER_WEEK = 7 * DAY;
export const NBA_FIRST = 1979; // balldontlie: asked back to 1979-80 (Yarin's request; the provider goes further back)
const BB_FIRST = 2008; // API-Basketball's player game lines start around 2008-09
const TENNIS_ARCHIVE_FROM = 1968, TENNIS_STORED_ARCHIVE = 2015, TENNIS_FEED = 2023;

db.exec(`
  CREATE TABLE IF NOT EXISTS player_seasons (
    sport TEXT NOT NULL, player_id INTEGER NOT NULL, season TEXT NOT NULL, ord INTEGER NOT NULL, kind TEXT NOT NULL,
    league TEXT NOT NULL DEFAULT '', league_name TEXT, team_key TEXT NOT NULL DEFAULT '', team_id INTEGER, team_name TEXT, team_logo TEXT,
    gp INTEGER, min REAL, pts REAL, reb REAL, ast REAL, stl REAL, blk REAL, fg_pct REAL, tp_pct REAL, ft_pct REAL,
    stats TEXT, also TEXT, source TEXT NOT NULL, fetched_at TEXT NOT NULL,
    PRIMARY KEY (sport, player_id, ord, kind, team_key, league)
  );
  CREATE TABLE IF NOT EXISTS player_careers (
    sport TEXT NOT NULL, player_id INTEGER NOT NULL, built_at TEXT, current_at TEXT, partial TEXT, provider_seasons INTEGER,
    info TEXT, tried_at TEXT, PRIMARY KEY (sport, player_id)
  );
  CREATE TABLE IF NOT EXISTS career_queue (sport TEXT NOT NULL, player_id INTEGER NOT NULL, asked_at TEXT NOT NULL, PRIMARY KEY (sport, player_id));
  CREATE TABLE IF NOT EXISTS career_teams (sport TEXT NOT NULL, team_id INTEGER NOT NULL, name TEXT, logo TEXT, fetched_at TEXT NOT NULL, PRIMARY KEY (sport, team_id));
`);

const nowIso = () => new Date().toISOString();
const parse = (s: string | null) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

/* ---------- store ---------- */

function lineToRow(sport: CareerSport, pid: number, l: CareerLine) {
  const s = l.stats as Record<string, any>;
  const n = (k: string) => (typeof s[k] === 'number' ? s[k] : null);
  return [sport, pid, l.season, l.order, l.kind, l.league?.code ?? l.league?.name ?? '', l.league?.name ?? null, String(l.team?.id ?? l.team?.name ?? ''),
    l.team?.id ?? null, l.team?.name ?? null, l.team?.logo ?? null, l.gp, n('min'), n('pts'), n('reb'), n('ast'), n('stl'), n('blk'), n('fgPct'), n('tpPct'), n('ftPct'),
    JSON.stringify(s), l.also?.length ? JSON.stringify(l.also) : null, l.source, nowIso()];
}
function rowToLine(r: any): CareerLine {
  return {
    season: r.season, order: r.ord, kind: r.kind, league: r.league || r.league_name ? { code: r.league_name && r.league !== r.league_name ? r.league : r.league || null, name: r.league_name || r.league } : null,
    team: r.team_name ? { id: r.team_id ?? null, name: r.team_name, logo: r.team_logo ?? null } : null, also: parse(r.also) || undefined,
    gp: r.gp, stats: parse(r.stats) || {}, source: r.source
  };
}
const insRow = db.prepare(`INSERT OR REPLACE INTO player_seasons (sport, player_id, season, ord, kind, league, league_name, team_key, team_id, team_name, team_logo,
  gp, min, pts, reb, ast, stl, blk, fg_pct, tp_pct, ft_pct, stats, also, source, fetched_at) VALUES (${Array(25).fill('?').join(', ')})`);

/** Replace a player's stored seasons (all of them, or only the seasons in `only`) by `lines`, in one transaction. */
export function storeCareer(sport: CareerSport, pid: number, lines: CareerLine[], meta: { partial: string | null; providerSeasons: number; info?: any; only?: number[] }) {
  db.exec('BEGIN');
  try {
    if (meta.only) for (const o of meta.only) db.prepare(`DELETE FROM player_seasons WHERE sport = ? AND player_id = ? AND ord = ?`).run(sport, pid, o);
    else db.prepare(`DELETE FROM player_seasons WHERE sport = ? AND player_id = ?`).run(sport, pid);
    for (const l of lines) insRow.run(...lineToRow(sport, pid, l));
    const at = nowIso();
    if (meta.only) {
      db.prepare(`INSERT INTO player_careers (sport, player_id, current_at, tried_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(sport, player_id) DO UPDATE SET current_at = excluded.current_at, tried_at = excluded.tried_at`).run(sport, pid, at, at);
    } else {
      db.prepare(`INSERT OR REPLACE INTO player_careers (sport, player_id, built_at, current_at, partial, provider_seasons, info, tried_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(sport, pid, at, at, meta.partial, meta.providerSeasons, meta.info ? JSON.stringify(meta.info) : null, at);
    }
    db.prepare(`DELETE FROM career_queue WHERE sport = ? AND player_id = ?`).run(sport, pid);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
export const storedLines = (sport: CareerSport, pid: number): CareerLine[] =>
  (db.prepare(`SELECT * FROM player_seasons WHERE sport = ? AND player_id = ? ORDER BY ord DESC`).all(sport, pid) as any[]).map(rowToLine);
export const careerMeta = (sport: CareerSport, pid: number): any => db.prepare(`SELECT * FROM player_careers WHERE sport = ? AND player_id = ?`).get(sport, pid) || null;

const askNow = db.prepare(`INSERT OR IGNORE INTO career_queue (sport, player_id, asked_at) VALUES (?, ?, ?)`);
const askLater = deferred(`INSERT OR IGNORE INTO career_queue (sport, player_id, asked_at) VALUES (?, ?, ?)`);
/** queue a player whose career is missing or a month old (never for crawlers: they get what is stored) */
function askFor(sport: CareerSport, pid: number, meta: any) {
  if (isCrawlerRequest()) return;
  const built = meta?.built_at ? Date.parse(meta.built_at) : 0, tried = meta?.tried_at ? Date.parse(meta.tried_at) : 0;
  if (built && Date.now() - built < CAREER_MONTH) return;
  if (tried && Date.now() - tried < 6 * 3600 * 1000) return; // a failed try waits 6 h
  (runsJobs ? askNow : askLater).run(sport, pid, nowIso());
}

/* ---------- read (the pages) ---------- */

/**
 * The player's career table: the stored provider seasons with `live` (our own box scores / feed) over the seasons
 * `liveFrom` and later. The page builders call this; it never calls a provider.
 */
export function careerFor(sport: CareerSport, pid: number, o: { live?: CareerLine[]; liveFrom?: number; group?: string | null } = {}): CareerView {
  const meta = careerMeta(sport, pid);
  askFor(sport, pid, meta);
  let lines = storedLines(sport, pid);
  if (o.live?.length) {
    const from = o.liveFrom ?? Math.max(...o.live.map(l => l.order));
    // our lines replace the provider's for those seasons, team and league by team and league; provider lines of
    // those seasons for a team / league we have no line of stay (another competition)
    const key = (l: CareerLine) => `${l.order}|${l.team?.id ?? ''}|${l.league?.code ?? ''}`;
    const ours = new Set(o.live.filter(l => l.order >= from).map(key));
    lines = [...lines.filter(l => l.order < from || !ours.has(key(l)) || l.kind === 'playoffs'), ...o.live.filter(l => l.order >= from || !lines.some(x => x.order === l.order))];
  }
  const partial = !meta?.built_at ? 'loading' : meta.partial || null;
  return careerView(sport, lines, { group: o.group, partialWhy: partial });
}

/* ---------- basketball ---------- */

let nbaTeams: { at: number; map: Map<string, CareerTeam> } | null = null;
/** balldontlie team (full name) → our NBA team (API-Basketball id, logo); old franchises keep their name, no link */
function nbaTeamOf(fullName: string): CareerTeam {
  if (!nbaTeams || Date.now() - nbaTeams.at > DAY) {
    const map = new Map<string, CareerTeam>();
    // home and away sides, the latest name of each team
    for (const r of db.prepare(`SELECT id, name, logo, MAX(kickoff) FROM (SELECT home_id AS id, home_name AS name, home_logo AS logo, kickoff FROM bb_games WHERE code = 'NBA'
      UNION ALL SELECT away_id, away_name, away_logo, kickoff FROM bb_games WHERE code = 'NBA') GROUP BY id`).all() as any[]) map.set(nbaKey(r.name), { id: r.id, name: r.name, logo: r.logo });
    nbaTeams = { at: Date.now(), map };
  }
  return nbaTeams.map.get(nbaKey(fullName)) || { id: null, name: fullName, logo: null };
}

/** NBA seasons of one player from balldontlie: regular season + playoffs, teams from that season's game lines */
export async function fetchNba(bdl: { id: number; draft_year?: number | null }, seasons?: number[]) {
  const now = bdlSeasonNow();
  const first = Math.max(NBA_FIRST, bdl.draft_year || NBA_FIRST);
  const list = seasons || Array.from({ length: now - first + 1 }, (_, i) => now - i);
  const lines: CareerLine[] = [];
  let empties = 0, found = 0;
  for (const s of list) {
    const avg = async (kind: string) => (await bdlCall('/v1/season_averages/general', { season: String(s), season_type: kind, type: 'base', 'player_ids[]': [String(bdl.id)] }))?.data?.[0]?.stats || null;
    const reg = await avg('regular');
    if (!reg || !num(reg.gp)) {
      empties++;
      // no draft year (undrafted): stop after 2 empty seasons once his first is found, 3 when none is
      if (!seasons && !bdl.draft_year && (found ? empties >= 2 : empties >= 3)) break;
      continue;
    }
    empties = 0; found++;
    // the teams of the season, in the order he played for them (a trade = two teams)
    const games: any[] = (await bdlCall('/v1/stats', { 'player_ids[]': [String(bdl.id)], 'seasons[]': [String(s)], per_page: '100' }))?.data || [];
    const order = new Map<number, { name: string; first: string; n: number }>();
    for (const g of games) {
      if (!g?.team?.id || !(num(String(g.min ?? '').split(':')[0]) || 0)) continue;
      const x = order.get(g.team.id) || { name: g.team.full_name || g.team.name, first: g.game?.date || '', n: 0 };
      x.n++; if ((g.game?.date || '') < x.first) x.first = g.game?.date;
      order.set(g.team.id, x);
    }
    const teams = [...order.values()].sort((a, b) => b.first.localeCompare(a.first)).map(t => nbaTeamOf(t.name));
    const line = bdlLine(reg, s, 'regular', teams[0] || null);
    if (line) { if (teams.length > 1) line.also = teams.slice(1); lines.push(line); }
    const po = await avg('playoffs');
    const pl = po ? bdlLine(po, s, 'playoffs', teams[0] || null) : null;
    if (pl) lines.push(pl);
  }
  return { lines, providerSeasons: found, partial: bdl.draft_year && bdl.draft_year < NBA_FIRST ? `provider-start:${bbLabel(NBA_FIRST)}` : null };
}

const leagueName = (code: string) => BB_LEAGUES.find(l => l.code === code)?.name || code;
/** our team (name, logo) by API-Basketball id: our games first, else one /teams call stored for good */
async function bbTeam(id: number): Promise<CareerTeam> {
  const g = db.prepare(`SELECT CASE WHEN home_id = ? THEN home_name ELSE away_name END AS name, CASE WHEN home_id = ? THEN home_logo ELSE away_logo END AS logo
    FROM bb_games WHERE home_id = ? OR away_id = ? ORDER BY kickoff DESC LIMIT 1`).get(id, id, id, id) as any;
  if (g?.name) return { id, name: g.name, logo: g.logo || null };
  const c = db.prepare(`SELECT name, logo FROM career_teams WHERE sport = 'basketball' AND team_id = ?`).get(id) as any;
  if (c?.name) return { id, name: c.name, logo: c.logo };
  try {
    const t = (await bbGet('/teams', { id })).response?.[0];
    if (t?.name) { db.prepare(`INSERT OR REPLACE INTO career_teams (sport, team_id, name, logo, fetched_at) VALUES ('basketball', ?, ?, ?, ?)`).run(id, t.name, t.logo || null, nowIso()); return { id, name: t.name, logo: t.logo || null }; }
  } catch { /* named later */ }
  return { id, name: `#${id}`, logo: null };
}

/** Every season of one player in API-Basketball (all leagues), NBA rows dropped when balldontlie has them (`skipNba`). */
export async function fetchBbApi(pid: number, o: { skipNba: boolean; seasons?: number[] }) {
  const cur = bdlSeasonNow();
  const calendar = !!db.prepare(`SELECT 1 FROM bb_player_stats ps JOIN bb_games g ON g.game_id = ps.game_id WHERE ps.player_id = ? AND instr(g.season, '-') = 0 LIMIT 1`).get(pid);
  const ourFirst = (db.prepare(`SELECT MIN(CAST(substr(g.season, 1, 4) AS INTEGER)) AS y FROM bb_player_stats ps JOIN bb_games g ON g.game_id = ps.game_id WHERE ps.player_id = ?`).get(pid) as any)?.y ?? cur;
  const gameOf = db.prepare(`SELECT code, kickoff, stage FROM bb_games WHERE game_id = ?`);
  const lines: CareerLine[] = [];
  let empties = 0, found = 0;
  const list = o.seasons || Array.from({ length: cur - BB_FIRST + 1 }, (_, i) => cur - i);
  for (const y of list) {
    let any = false;
    for (const text of calendar ? [`${y}-${y + 1}`, String(y + 1)] : [`${y}-${y + 1}`]) {
      const rem = bbRemainingDay();
      if (rem !== null && rem < 300) throw new Error('API-Basketball: daily quota kept for the live jobs');
      const rows: any[] = (await bbGet('/games/statistics/players', { player: pid, season: text })).response || [];
      if (!rows.length) continue;
      any = true;
      const teamIds = [...new Set(rows.map(r => num(r.team?.id)).filter((x): x is number => x != null))];
      const teams = new Map<number, CareerTeam>();
      for (const t of teamIds) teams.set(t, await bbTeam(t));
      const got = apiBbLines(rows, text, gameId => {
        const g = gameOf.get(gameId) as any;
        if (!g) return { league: null, playoffs: false };
        if (isPreseason({ code: g.code, kickoff: g.kickoff, stage: g.stage })) return false;
        return { league: { code: g.code, name: leagueName(g.code) }, playoffs: /play.?off|final|semi|quarter/i.test(String(g.stage || '')) };
      }, t => teams.get(t) || null);
      // calendar-year seasons (2024) belong to the season that started the year before in our table (2023-24)
      for (const l of got) { if (!text.includes('-')) { l.order = y; l.season = bbLabel(y); } }
      lines.push(...got.filter(l => !(o.skipNba && l.league?.code === 'NBA')));
    }
    if (any) { empties = 0; found++; continue; }
    empties++;
    if (!o.seasons && y < ourFirst && (found ? empties >= 2 : empties >= 3)) break;
  }
  return { lines, providerSeasons: found };
}

function bbNameTeam(pid: number) {
  const r = db.prepare(`SELECT ps.name, g.code, CASE WHEN ps.team_id = g.home_id THEN g.home_name ELSE g.away_name END AS team FROM bb_player_stats ps JOIN bb_games g ON g.game_id = ps.game_id
    WHERE ps.player_id = ? ORDER BY g.kickoff DESC LIMIT 1`).get(pid) as any;
  if (r) return r;
  let ros: any = null;
  try { ros = db.prepare(`SELECT name FROM bb_roster WHERE player_id = ? ORDER BY updated_at DESC LIMIT 1`).get(pid); } catch { /* no squads stored yet */ }
  return ros ? { name: ros.name, code: null, team: null } : null;
}
const playedNba = (pid: number) => !!db.prepare(`SELECT 1 FROM bb_player_stats ps JOIN bb_games g ON g.game_id = ps.game_id WHERE ps.player_id = ? AND g.code = 'NBA' LIMIT 1`).get(pid);

async function buildBasketball(pid: number, currentOnly: boolean) {
  const who = bbNameTeam(pid);
  const bdl = who && (playedNba(pid) || who.code === 'NBA') ? bdlPlayerOf(who.name, who.code === 'NBA' ? who.team : null) : null;
  const cur = bdlSeasonNow();
  const seasons = currentOnly ? [cur] : undefined;
  const nba = bdl ? await fetchNba(bdl, seasons) : null;
  const api = await fetchBbApi(pid, { skipNba: !!bdl, seasons });
  const lines = [...(nba?.lines || []), ...api.lines];
  const years = new Set(lines.filter(l => l.kind === 'regular').map(l => l.order));
  return { lines, providerSeasons: years.size, partial: nba?.partial || null, info: { nba: nba ? { bdlId: bdl!.id, seasons: nba.providerSeasons } : null, apiBasketball: api.providerSeasons }, only: currentOnly ? [cur] : undefined };
}

/** basketball: our box-score seasons (bbPlayer's `seasons`) as career lines (the current season, live) */
export function bbLiveLines(seasons: { code: string; league: string; season: string; team: { id: number; name: string; logo: string | null }; gp: number; min: number | null; pts: number | null; reb: number | null; ast: number | null; fgPct: number | null; tpPct: number | null; ftPct: number | null }[]): CareerLine[] {
  return seasons.map(s => ({
    season: s.season.includes('-') ? bbLabel(bbStart(s.season)) : bbLabel(bbStart(s.season) - 1), order: s.season.includes('-') ? bbStart(s.season) : bbStart(s.season) - 1,
    kind: 'regular' as const, league: { code: s.code, name: s.league }, team: { id: s.team.id, name: s.team.name, logo: s.team.logo }, gp: s.gp,
    stats: { min: s.min, pts: s.pts, reb: s.reb, ast: s.ast, fgPct: s.fgPct, tpPct: s.tpPct, ftPct: s.ftPct }, source: 'our box scores'
  }));
}
/** NBA current season from balldontlie's daily season averages (bdl_season), over our box scores (it has steals / blocks) */
export function nbaCurrentLine(bdlId: number, team: CareerTeam | null): CareerLine | null {
  const s = bdlSeasonNow();
  const r = db.prepare(`SELECT stats FROM bdl_season WHERE player_id = ? AND season = ? AND kind = 'base'`).get(bdlId, s) as any;
  const l = r ? bdlLine(parse(r.stats), s, 'regular', team) : null;
  return l ? { ...l, source: 'balldontlie' } : null;
}
export const bbCurrentOrder = () => bdlSeasonNow();

/* ---------- American football ---------- */

/** one season's /players/statistics answer → a line per team */
export function nflSeasonLines(resp: any[], season: number, gpOf: (teamId: number) => number | null, teamLeague: (teamId: number) => LeagueId): CareerLine[] {
  const out: CareerLine[] = [];
  for (const p of resp || []) for (const t of p?.teams || []) {
    const id = num(t?.team?.id);
    const stats = nflStatsOf(t?.groups || []);
    if (!Object.keys(stats).length && !id) continue;
    const lg = id != null ? teamLeague(id) : 1;
    out.push({ season: String(season), order: season, kind: 'regular', league: { code: lg === 2 ? 'NCAA' : 'NFL', name: lg === 2 ? 'College football' : 'NFL' },
      team: id != null ? { id, name: t.team.name, logo: t.team.logo || null } : null, gp: id != null ? gpOf(id) : null, stats, source: 'API-American-Football' });
  }
  return out;
}

async function buildNfl(pid: number, currentOnly: boolean) {
  const p = db.prepare(`SELECT team_id, position, experience FROM nfl_players WHERE player_id = ?`).get(pid) as any;
  const lg: LeagueId = p?.team_id && (db.prepare(`SELECT league FROM nfl_teams WHERE team_id = ?`).get(p.team_id) as any)?.league === 2 ? 2 : 1;
  let have: number[] = [];
  try { have = (await nflSeasons(lg)).map(s => s.season); } catch { /* the stored seasons */ }
  if (!have.length) have = (db.prepare(`SELECT DISTINCT season FROM nfl_games WHERE league = ? ORDER BY season`).all(lg) as any[]).map(r => r.season);
  const cur = nflCurrentSeason(lg) ?? Math.max(...have, new Date().getUTCFullYear());
  const firstProvider = have.length ? Math.min(...have) : cur;
  const list = currentOnly ? [cur] : have.filter(s => s <= cur).sort((a, b) => b - a);
  const exp = num(p?.experience);
  const gpOf = (season: number) => (teamId: number) => (db.prepare(`SELECT COUNT(*) AS n FROM nfl_player_games x JOIN nfl_games g ON g.game_id = x.game_id
    WHERE x.player_id = ? AND x.team_id = ? AND g.season = ? AND (g.stage IS NULL OR g.stage NOT LIKE 'Pre%')`).get(pid, teamId, season) as any)?.n || null;
  const teamLeague = (id: number): LeagueId => ((db.prepare(`SELECT league FROM nfl_teams WHERE team_id = ?`).get(id) as any)?.league === 2 ? 2 : 1);
  const lines: CareerLine[] = [];
  let empties = 0, found = 0;
  for (const s of list) {
    if (nflBudgetLeft() < 5) throw new Error('API-American-Football: daily quota kept for the live jobs');
    const resp: any[] = (await nflCall('/players/statistics', { id: pid, season: s })).response || [];
    const got = nflSeasonLines(resp, s, gpOf(s), teamLeague);
    if (got.length) { lines.push(...got); empties = 0; found++; continue; }
    empties++;
    // stop after 2 empty seasons before his first (his NFL seasons say how far back to look at least)
    const mustReach = exp != null ? cur - exp : null;
    if (!currentOnly && (mustReach == null || s < mustReach) && (found ? empties >= 2 : empties >= 3)) break;
  }
  const startedBefore = exp != null && cur - exp + 1 < firstProvider;
  return { lines, providerSeasons: found, partial: startedBefore ? `provider-start:${firstProvider}` : null, info: { firstProvider, experience: exp }, only: currentOnly ? [cur] : undefined };
}

/** American football: the current season from our box scores (the same stat names as the provider's) */
export function nflLiveLines(rows: { season: number; league: number; teamId: number; team: CareerTeam | null; games: number; groups: { name: string; statistics: { name: string; value: any }[] }[][] }[]): CareerLine[] {
  return rows.map(r => {
    const sum: Record<string, number> = {};
    for (const g of r.groups) for (const [k, v] of Object.entries(nflStatsOf(g))) sum[k] = k === 'lng' ? Math.max(sum[k] ?? 0, v) : k === 'rate' ? 0 : (sum[k] || 0) + v;
    delete sum.rate; // recomputed from the totals
    return { season: String(r.season), order: r.season, kind: 'regular' as const, league: { code: r.league === 2 ? 'NCAA' : 'NFL', name: r.league === 2 ? 'College football' : 'NFL' },
      team: r.team, gp: r.games, stats: Object.fromEntries(Object.entries(sum).map(([k, v]) => [k, Math.round(v * 10) / 10])), source: 'our box scores' };
  });
}
export const nflGroup = (position: string | null) => nflGroupOf(position);

/* ---------- tennis ---------- */

const { classify } = tennisModelInternals;
export const normPerson = (s: string | null | undefined) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]+/g, ' ').trim();

/** a tennis_matches row (feed or archive) → the player's match */
function tennisMatchOf(r: any, isMe: (side: 1 | 2) => boolean): TennisCareerMatch | null {
  const side: 1 | 2 | null = isMe(1) ? 1 : isMe(2) ? 2 : null;
  if (!side || !(r.winner === 1 || r.winner === 2)) return null;
  const src = r.source === 'archive' ? 'archive' : 'live';
  const cls = classify(r.tour, r.tier, r.tournament, src);
  const extra = r.source === 'archive' ? parse(r.extra) : null;
  const meRank = extra ? num((r.winner === side ? extra.winner : extra.loser)?.rank) : null;
  return {
    date: String(r.scheduled_at || '').slice(0, 10), tournament: r.tournament, surface: r.surface, level: cls ? cls.lvl : 9,
    round: normRound(r.round_code, r.round, !!r.is_qualifying), won: r.winner === side, rank: meRank,
    walkover: /walkover|w\/o/i.test(String(r.outcome || ''))
  };
}
/** an ArchiveMatch of the provider (1968–2014) → the player's match */
export function archiveMatchOf(a: any, me: string): TennisCareerMatch | null {
  const w = normPerson(a?.winner?.name) === me, l = normPerson(a?.loser?.name) === me;
  if (!w && !l) return null;
  const cls = classify(a.tour, a.level, a.tournament, 'archive');
  return {
    date: String(a.event_date || '').slice(0, 10), tournament: a.tournament ?? null, surface: a.surface ?? null, level: cls ? cls.lvl : 9,
    round: normRound(a.round, a.round, false), won: w, rank: num((w ? a.winner : a.loser)?.rank), walkover: /walkover/.test(String(a.outcome || '')) || /W\/O/.test(String(a.score || ''))
  };
}

/** the player's matches from our feed (2023 →) and the stored archive (2015–2022, by name), from `fromYear` */
function tennisStored(pid: number, name: string, fromYear: number): TennisCareerMatch[] {
  const cols = `id, tournament, tour, tier, surface, round, round_code, is_qualifying, scheduled_at, p1_id, p1_name, p2_id, p2_name, winner, outcome, extra, source`;
  const since = `${fromYear}-01-01`;
  const feed = db.prepare(`SELECT ${cols} FROM tennis_matches WHERE id IN (SELECT id FROM tennis_matches WHERE p1_id = ? AND scheduled_at >= ? UNION SELECT id FROM tennis_matches WHERE p2_id = ? AND scheduled_at >= ?)
    AND source <> 'archive' AND status = 'completed' AND COALESCE(draw, 'singles') = 'singles'`).all(pid, since, pid, since) as any[];
  const out = feed.map(r => tennisMatchOf(r, s => (s === 1 ? r.p1_id : r.p2_id) === pid)).filter((x): x is TennisCareerMatch => !!x);
  const me = normPerson(name);
  if (me && fromYear < TENNIS_FEED) {
    // the archive has its own ids: matched by the full name (only its rows, ids < 0)
    const last = me.split(' ').pop() || me;
    const arch = db.prepare(`SELECT ${cols} FROM tennis_matches WHERE id < 0 AND scheduled_at >= ? AND (lower(p1_name) LIKE ? OR lower(p2_name) LIKE ?)`).all(since, `%${last}%`, `%${last}%`) as any[];
    for (const r of arch) { const m = tennisMatchOf(r, s => normPerson(s === 1 ? r.p1_name : r.p2_name) === me); if (m) out.push(m); }
  }
  return out;
}
/** the rank on the last stored ranking of each year (our rankings table) */
function tennisYearRanks(pid: number): Map<number, number> {
  const m = new Map<number, number>();
  for (const r of db.prepare(`SELECT date, rank FROM tennis_rankings WHERE player_id = ? ORDER BY date`).all(pid) as any[]) m.set(Number(String(r.date).slice(0, 4)), r.rank);
  return m;
}
const tennisSource = (y: number) => (y >= TENNIS_FEED ? 'our data (Live Tennis API)' : 'Live Tennis API results archive');

async function buildTennis(pid: number, currentOnly: boolean) {
  const p = db.prepare(`SELECT name, tour, dob FROM tennis_players WHERE id = ?`).get(pid) as any;
  if (!p?.name) throw new Error('tennis: player not known');
  const y = new Date().getUTCFullYear();
  const ranks = tennisYearRanks(pid);
  if (currentOnly) {
    const lines = tennisYears(tennisStored(pid, p.name, y), tennisSource, yr => ranks.get(yr) ?? null);
    return { lines, providerSeasons: lines.length, partial: null, only: [y] };
  }
  const ms = tennisStored(pid, p.name, TENNIS_STORED_ARCHIVE);
  let partial: string | null = null;
  const born = num(String(p.dob || '').slice(0, 4));
  const tour = String(p.tour || '').toLowerCase() === 'wta' ? 'wta' : 'atp';
  let archiveRows = 0;
  // 1968–2014: only a player old enough to have played then (born before 1999), by name, on the bulk budget
  if (!born || born < 1999) {
    const me = normPerson(p.name);
    let offset = 0;
    for (let page = 0; page < 25; page++) {
      if (!canSpend('bulk')) { partial = 'failed'; break; }
      const j = await tennisCall('/history/archive/matches', { tour, name: p.name, from: `${TENNIS_ARCHIVE_FROM}-01-01`, to: `${TENNIS_STORED_ARCHIVE - 1}-12-31`, limit: 200, offset });
      const rows: any[] = j?.data || [];
      for (const a of rows) { const m = archiveMatchOf(a, me); if (m) { ms.push(m); archiveRows++; } }
      offset += rows.length;
      if (!j?.meta?.has_more || !rows.length) break;
      if (page === 24) partial = 'failed';
    }
  }
  // the stored 2015–2022 archive is complete only once its backfill is done
  const archDone = (db.prepare(`SELECT COUNT(*) AS n FROM tennis_meta WHERE k LIKE 'arch:%'`).get() as any)?.n >= 8;
  if (!archDone && (!born || born < 2005)) partial = partial || 'loading';
  const lines = tennisYears(ms, tennisSource, yr => ranks.get(yr) ?? null);
  return { lines, providerSeasons: lines.length, partial, info: { archiveRowsBefore2015: archiveRows } };
}
/** tennis: this year live from our feed (the page) */
export function tennisLiveLines(pid: number): CareerLine[] {
  const y = new Date().getUTCFullYear();
  const ranks = tennisYearRanks(pid);
  const rank = (db.prepare(`SELECT ranking FROM tennis_players WHERE id = ?`).get(pid) as any)?.ranking ?? null;
  return tennisYears(tennisStored(pid, '', y), tennisSource, yr => ranks.get(yr) ?? (yr === y ? rank : null));
}

/* ---------- jobs ---------- */

const BUILDERS: Record<CareerSport, (pid: number, currentOnly: boolean) => Promise<{ lines: CareerLine[]; providerSeasons: number; partial: string | null; info?: any; only?: number[] }>> = {
  basketball: buildBasketball, 'american-football': buildNfl, tennis: buildTennis
};

/** Build one player's whole career (or only the current season) now and store it. */
export async function buildCareer(sport: CareerSport, pid: number, currentOnly = false) {
  try {
    const r = await BUILDERS[sport](pid, currentOnly);
    storeCareer(sport, pid, r.lines, { partial: r.partial, providerSeasons: r.providerSeasons, info: r.info, only: r.only });
    return { ok: true as const, seasons: r.providerSeasons, lines: r.lines.length, partial: r.partial, info: r.info ?? null };
  } catch (e: any) {
    db.prepare(`INSERT INTO player_careers (sport, player_id, tried_at, info) VALUES (?, ?, ?, ?)
      ON CONFLICT(sport, player_id) DO UPDATE SET tried_at = excluded.tried_at`).run(sport, pid, nowIso(), JSON.stringify({ error: String(e?.message || e) }));
    db.prepare(`DELETE FROM career_queue WHERE sport = ? AND player_id = ?`).run(sport, pid);
    return { ok: false as const, error: String(e?.message || e) };
  }
}

/** The 100 players per sport the health check and the monthly refresh follow. */
export function topPlayers(sport: CareerSport, n = 100): number[] {
  const since = (d: number) => new Date(Date.now() - d * DAY).toISOString();
  try {
    if (sport === 'basketball') return (db.prepare(`SELECT ps.player_id AS id FROM bb_player_stats ps JOIN bb_games g ON g.game_id = ps.game_id WHERE g.kickoff > ?
      GROUP BY ps.player_id ORDER BY SUM(ps.minutes) DESC LIMIT ?`).all(since(365), n) as any[]).map(r => r.id);
    if (sport === 'american-football') return (db.prepare(`SELECT x.player_id AS id FROM nfl_player_games x JOIN nfl_games g ON g.game_id = x.game_id WHERE g.kickoff > ?
      GROUP BY x.player_id ORDER BY COUNT(*) DESC, x.player_id LIMIT ?`).all(since(400), n) as any[]).map(r => r.id);
    const ids: number[] = [];
    for (const tour of ['atp', 'wta']) {
      const d = (db.prepare(`SELECT MAX(date) AS d FROM tennis_rankings WHERE tour = ?`).get(tour) as any)?.d;
      if (d) ids.push(...(db.prepare(`SELECT player_id AS id FROM tennis_rankings WHERE tour = ? AND date = ? AND player_id IS NOT NULL ORDER BY rank LIMIT ?`).all(tour, d, n / 2) as any[]).map(r => r.id));
    }
    return ids.length ? ids : (db.prepare(`SELECT id FROM tennis_players WHERE ranking IS NOT NULL ORDER BY ranking LIMIT ?`).all(n) as any[]).map(r => r.id);
  } catch { return []; }
}

const SPORTS: CareerSport[] = ['basketball', 'american-football', 'tennis'];
let busy = false;
export const careerJobState = { runs: 0, built: 0, failed: 0, lastError: null as string | null, lastRun: null as string | null };
/**
 * Every 5 minutes (worker): pages asked first (the queue), then the top 100 of each sport without a career or with one
 * a month old, then the current season of a stored career a week old. A few players a run, one sport after another.
 */
export async function careerTick(max = 6) {
  if (busy) return;
  busy = true;
  try {
    careerJobState.runs++; careerJobState.lastRun = nowIso();
    const todo: { sport: CareerSport; id: number; current: boolean }[] = [];
    for (const q of db.prepare(`SELECT sport, player_id FROM career_queue ORDER BY asked_at LIMIT ?`).all(max) as any[]) todo.push({ sport: q.sport, id: q.player_id, current: false });
    const monthAgo = new Date(Date.now() - CAREER_MONTH).toISOString(), weekAgo = new Date(Date.now() - CAREER_WEEK).toISOString(), sixH = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
    for (const sport of SPORTS) {
      if (todo.length >= max) break;
      for (const id of topPlayers(sport)) {
        if (todo.length >= max) break;
        const m = careerMeta(sport, id);
        if ((!m?.built_at || m.built_at < monthAgo) && !(m?.tried_at && m.tried_at > sixH) && !todo.some(t => t.sport === sport && t.id === id)) todo.push({ sport, id, current: false });
      }
    }
    if (todo.length < max) {
      for (const r of db.prepare(`SELECT sport, player_id FROM player_careers WHERE built_at IS NOT NULL AND (built_at < ? OR current_at < ?) AND (tried_at IS NULL OR tried_at < ?) ORDER BY current_at LIMIT ?`)
        .all(monthAgo, weekAgo, sixH, max - todo.length) as any[]) {
        const m = careerMeta(r.sport, r.player_id);
        todo.push({ sport: r.sport, id: r.player_id, current: m.built_at >= monthAgo });
      }
    }
    for (const t of todo) {
      const r = await buildCareer(t.sport, t.id, t.current);
      if (r.ok) careerJobState.built++; else { careerJobState.failed++; careerJobState.lastError = `${t.sport} ${t.id}: ${r.error}`; }
    }
  } catch (e: any) {
    careerJobState.lastError = String(e?.message || e);
    logger.warn(`player careers: ${careerJobState.lastError}`);
  } finally { busy = false; }
}

/* ---------- data health ---------- */

/** "Player careers": the share of each sport's top 100 with a complete career (football: its stored player pages). */
export function careerHealth() {
  const parts: string[] = [], items: string[] = [];
  let worst = 100;
  for (const sport of SPORTS) {
    const ids = topPlayers(sport);
    if (!ids.length) { parts.push(`${sport}: no players yet`); continue; }
    let complete = 0, providerShort = 0;
    for (const id of ids) {
      const m = careerMeta(sport, id);
      if (m?.built_at && !m.partial) complete++;
      else if (m?.built_at && String(m.partial).startsWith('provider-start')) { providerShort++; complete++; }
      else if (items.length < 30) items.push(`${sport} ${id}: ${!m ? 'not built yet' : m.built_at ? `partial (${m.partial})` : `failed: ${parse(m.info)?.error || 'not built yet'}`}`);
    }
    const share = Math.round((100 * complete) / ids.length);
    worst = Math.min(worst, share);
    parts.push(`${sport} ${share} % of ${ids.length}${providerShort ? ` (${providerShort} start before the provider's history)` : ''}`);
  }
  try {
    const f = db.prepare(`SELECT COUNT(*) AS n, SUM(CASE WHEN json LIKE '%"careerPartial":true%' THEN 1 ELSE 0 END) AS p FROM (SELECT json FROM player_page_store ORDER BY built_at DESC LIMIT 100)`).get() as any;
    if (f?.n) { const share = Math.round((100 * (f.n - (f.p || 0))) / f.n); parts.unshift(`football ${share} % of ${f.n}`); worst = Math.min(worst, share); }
  } catch { /* no football pages yet */ }
  return {
    id: 'player-careers', label: 'Player careers (top 100 per sport complete)', level: worst < 80 ? 'warn' : 'ok' as 'warn' | 'ok',
    detail: `${parts.join(' · ')} · job: ${careerJobState.built} built, ${careerJobState.failed} failed this run${careerJobState.lastError ? ` · last error: ${careerJobState.lastError}` : ''}`,
    items
  };
}
