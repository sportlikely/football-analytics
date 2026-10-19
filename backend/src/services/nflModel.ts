/**
 * nfl-v1 (fix139, Oct 2026) — the NFL model. Built and tested on our own tables (services/nfl.ts): nfl_games,
 * nfl_team_stats, nfl_player_stats, nfl_injuries. No odds anywhere.
 *
 *  A. Elo (538 style): start 1500, K tuned, margin-of-victory multiplier ln(|m|+1) × 2.2 / (0.001 × winner Elo gap + 2.2),
 *     1/3 back to 1500 between seasons, home field tuned (separately before and from 2020), rest: bye week + / short week −
 *     (both tuned), neutral sites (international games, Super Bowl) = no home field.
 *  B. QB: the starter of a game = the passer with the most attempts. QB value = his rolling ANY/A
 *     ((pass yds + 20·TD − 45·INT − sack yds) / (att + sacks)), shrunk to the league mean (200 attempts). When this game's
 *     starter is not the team's usual starter, the team's Elo moves by (value gap × weight, tuned). Upcoming games: the usual
 *     starter unless the injury report has him Out / Doubtful / on IR — then the team's next QB by attempts.
 *  C. Efficiency (games with box scores): exp-weighted yards per play for / against, turnover margin, third-down %,
 *     red-zone %, sacks.
 *  D. Logistic blend of [A+B Elo gap, efficiency gaps]. Used only when it beats A+B on the walk-forward test log loss.
 * Outputs: pHome (ties ≈ 0), expected margin (Elo gap / 25), expected total (points-for / points-against ratings).
 *
 * Test (never on fitting data): each of the last 5 seasons is predicted game by game with settings tuned on the seasons
 * before it only. GET /api/admin/nfl-model has the report; one log line per season.
 * Live: settings re-tuned every Tuesday on every finished season; ratings replayed after each finished game; predictions
 * of the next 9 days saved in nfl_predictions until kick-off (then frozen).
 *
 * fix142 — ncaa-v1 (college football, league 2): the same code with its own settings, tuned on NCAA games only: the margin
 * multiplier capped (blowouts), regression toward the CONFERENCE mean between seasons (tuned share), FCS teams start lower
 * (tuned), home field tuned (bigger than the NFL), neutral sites (bowls, kickoff games: the venue is not the home team's
 * stadium) without home field, rest / bye. QB and efficiency only where box scores exist; the blend kept only if it beats A+B.
 * Report also for FBS vs FBS games alone. Strong pick = 75%+ (more mismatches than the NFL). NFL behaviour is unchanged
 * (its new settings are fixed at the old values: regression 1/3 to 1500, no FCS, no cap).
 */
import { db } from '../db';
import { winnerBands, winnerCalibration, winnerByConfidence } from '../utils/winnerBands';
import logger from '../utils/logger';
import { yieldLoop, timed, slicer } from './perf';
import { teamBox, NflGame } from './nflSite';
import { rememberFirstPrediction } from './nflGameExtras';
import { HIDE_OTHER, type LeagueId } from './nfl';

export const NFL_MODEL = 'nfl-v1';
export const NCAA_MODEL = 'ncaa-v1';
const MODEL_OF: Record<LeagueId, string> = { 1: NFL_MODEL, 2: NCAA_MODEL };
/** Strong pick: the picked side's chance at least this (college: more mismatches → 75%). */
export const STRONG_OF: Record<LeagueId, number> = { 1: 0.7, 2: 0.75 };
/** fix146: the experiments module, loaded when first needed (it imports this file's internals). */
const exps = () => require('./nflExperiments') as typeof import('./nflExperiments');
export const strongForModel = (model: string | null | undefined) => (model === NCAA_MODEL ? STRONG_OF[2] : STRONG_OF[1]);
/** Settings / report keys in nfl_sync (NFL keeps its fix139 keys). */
const KEY_OF: Record<LeagueId, string> = { 1: 'model', 2: 'model2' };
const DAY = 86400000;

db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_predictions (
    game_id INTEGER PRIMARY KEY, season INTEGER NOT NULL, kickoff TEXT NOT NULL, model TEXT NOT NULL,
    p_home REAL NOT NULL, margin REAL NOT NULL, total REAL NOT NULL, home_pts REAL NOT NULL, away_pts REAL NOT NULL,
    why TEXT, made_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_nfl_pred_kickoff ON nfl_predictions(kickoff);
`);

/* ---------- data ---------- */

interface G { id: number; season: number; kickoff: string; t: number; stage: string | null; week: string | null; h: number; a: number; hn: string; an: string; hs: number | null; as: number | null; done: boolean; neutral: boolean }
interface Passer { id: number; name: string; att: number; anya: number }
interface Box { ypp: number | null; to: number | null; third: [number, number] | null; rz: [number, number] | null; sacks: number | null }
/** conf / fcs: college teams (regression to the conference mean, FCS start); empty for the NFL */
interface Ctx { qb: Map<string, Passer[]>; box: Map<string, Box>; teams: Map<number, { conf: string | null; fcs: boolean; fbs: boolean; isFcs?: boolean }> }

const INTL = /london|wembley|tottenham|twickenham|munich|m[üu]nchen|frankfurt|berlin|madrid|mexico|s[ãa]o paulo|dublin|croke|toronto|rio de janeiro|melbourne/i;
const isNeutral = (stage: string | null, week: string | null, venue: string | null) => INTL.test(venue || '') || (/post/i.test(stage || '') && /super/i.test(week || ''));

/** College (fix142): neutral when the venue is not the home team's stadium (bowls, kickoff games); without a known
 *  stadium, post-season games count as neutral (bowls) — the CFP first round on campus is matched by the stadium. */
const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function collegeNeutral(stage: string | null, venue: string | null, stadium: string | null) {
  if (venue && stadium) { const v = norm(venue), st = norm(stadium); return !(v.includes(st) || st.includes(v.split(' ').slice(0, 3).join(' '))); }
  return /post|bowl/i.test(stage || '');
}

/**
 * fix155: the games of a league are read once and kept; a cheap signature (number of games, finished games, their
 * scores, latest kick-off) is checked at most every 2 s, and the list is re-read when it changed or after 10 min.
 * Live score changes don't touch the signature (only finished games count), so a live tick never re-reads them.
 */
const gamesCache = new Map<LeagueId, { sig: string; checked: number; loaded: number; games: G[]; maxUpd: string; index: Map<number, number> }>();
function gamesSig(league: LeagueId): string {
  const r = db.prepare(`SELECT COUNT(*) AS n, SUM(CASE WHEN status IN ('FT','AOT') AND home_pts IS NOT NULL AND away_pts IS NOT NULL THEN 1 ELSE 0 END) AS d,
    SUM(CASE WHEN status IN ('FT','AOT') THEN COALESCE(home_pts, 0) * 1000 + COALESCE(away_pts, 0) ELSE 0 END) AS s, MAX(kickoff) AS k FROM nfl_games WHERE league = ?`).get(league) as any;
  return `${r?.n}|${r?.d}|${r?.s}|${r?.k}`;
}
const GAME_SQL = `SELECT game_id, season, week, stage, kickoff, home_id, away_id, home_name, away_name, status, home_pts, away_pts, venue, updated_at FROM nfl_games
  WHERE league = ? ${HIDE_OTHER} AND kickoff IS NOT NULL AND home_id IS NOT NULL AND away_id IS NOT NULL AND (stage IS NULL OR stage NOT LIKE 'Pre%')`;
function stadiums(league: LeagueId) {
  return league === 2 ? new Map((db.prepare(`SELECT team_id, stadium FROM nfl_teams WHERE league = 2`).all() as any[]).map(r => [r.team_id, r.stadium as string | null])) : null;
}
function toG(r: any, stadium: Map<number, string | null> | null): G {
  return {
    id: r.game_id, season: r.season, kickoff: r.kickoff, t: Date.parse(r.kickoff), stage: r.stage, week: r.week, h: r.home_id, a: r.away_id, hn: r.home_name, an: r.away_name,
    hs: r.home_pts, as: r.away_pts, done: ['FT', 'AOT'].includes(r.status) && Number.isFinite(r.home_pts) && Number.isFinite(r.away_pts), // fix149: both scores
    neutral: stadium ? collegeNeutral(r.stage, r.venue, stadium.get(r.home_id) ?? null) : isNeutral(r.stage, r.week, r.venue)
  };
}
const byTime = (x: G, y: G) => x.t - y.t || x.id - y.id;
function keepGames(league: LeagueId, sig: string, list: G[], maxUpd: string, loaded = Date.now()) {
  const games = list.sort(byTime);
  gamesCache.set(league, { sig, checked: Date.now(), loaded, games, maxUpd, index: new Map(games.map((g, i) => [g.id, i])) });
  return games;
}
const GAMES_MAX_AGE = 6 * 3600 * 1000;
/**
 * fix171: ids of games patched in by the partial updates since current() last looked ('all' after a full re-read:
 * current() then compares every game once). current() takes them with takeChanged().
 */
const changedIds = new Map<LeagueId, Set<number> | 'all'>();
const noteChanged = (league: LeagueId, ids: number[] | 'all') => {
  const cur = changedIds.get(league);
  if (ids === 'all' || cur === 'all') { changedIds.set(league, 'all'); return; }
  const s = cur || new Set<number>();
  for (const id of ids) s.add(id);
  changedIds.set(league, s);
};
const takeChanged = (league: LeagueId) => { const c = changedIds.get(league) || null; changedIds.delete(league); return c; };
/**
 * fix156 / fix165 / fix171: the games of a league as kept in memory, or null when they were never read — never a full
 * read. A cheap signature is checked at most every 2 s; when it changed (a game finished, a score was corrected, a game
 * was added), only the rows updated since the last read are read and patched in. A list older than 6 h is still served
 * (patched) while a full re-read runs in the background, in pages with yields.
 */
function peekGames(league: LeagueId): G[] | null {
  const c = gamesCache.get(league), now = Date.now();
  if (!c) return null;
  if (now - c.loaded >= GAMES_MAX_AGE) void loadGamesAsync(league, true).catch(e => logger.warn(`${MODEL_OF[league]} games: ${e.message}`));
  if (now - c.checked < 2000) return c.games;
  const sig = gamesSig(league);
  if (c.sig === sig) { c.checked = now; return c.games; }
  const st = stadiums(league);
  const rows = db.prepare(`${GAME_SQL} AND updated_at > ?`).all(league, c.maxUpd) as any[];
  const games = c.games.slice();
  let maxUpd = c.maxUpd;
  for (const row of rows) {
    const g = toG(row, st);
    const i = c.index.get(g.id);
    if (i === undefined) games.push(g); else games[i] = g;
    if (row.updated_at > maxUpd) maxUpd = row.updated_at;
  }
  noteChanged(league, rows.map(r => r.game_id as number));
  return keepGames(league, sig, games, maxUpd, c.loaded);
}
/**
 * The full read in pages of 3,000 games with a yield between them (the background build at boot, the 6-hourly
 * re-read). A list read less than 6 h ago is served as it is (patched). One read per league at a time.
 */
const gamesReading = new Map<LeagueId, Promise<G[]>>();
async function loadGamesAsync(league: LeagueId, force = false): Promise<G[]> {
  const c = gamesCache.get(league);
  if (c && !force && Date.now() - c.loaded < GAMES_MAX_AGE) return peekGames(league)!;
  const running = gamesReading.get(league);
  if (running) return running;
  const p = (async () => {
    const sig = gamesSig(league), st = stadiums(league);
    const prevUpd = gamesCache.get(league)?.maxUpd ?? null;
    const out: G[] = [];
    let after = 0, maxUpd = '';
    for (;;) {
      const rows = db.prepare(`${GAME_SQL} AND game_id > ? ORDER BY game_id LIMIT 3000`).all(league, after) as any[];
      if (!rows.length) break;
      for (const x of rows) { out.push(toG(x, st)); if (x.updated_at > maxUpd) maxUpd = x.updated_at; }
      after = rows[rows.length - 1].game_id;
      await yieldLoop();
    }
    noteChanged(league, 'all');
    // a re-read keeps the previous high-water mark: a row updated while the pages were read is patched in again
    // on the next check (re-patching a row is harmless)
    return keepGames(league, sig, out, prevUpd !== null && prevUpd < maxUpd ? prevUpd : maxUpd);
  })();
  gamesReading.set(league, p);
  try { return await p; } finally { gamesReading.delete(league); }
}

const numOf = (v: any): number | null => { if (v === null || v === undefined || v === '') return null; const n = Number(String(v).replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
const pairOf = (v: any): [number, number] | null => { const m = String(v ?? '').match(/^\s*(\d+)\s*[-/]\s*(\d+)\s*$/); return m ? [Number(m[1]), Number(m[2])] : null; };

/** Passers of one team in one game, from the provider's "Passing" group (the starter = most attempts). */
export function passersOf(json: string | null): Passer[] {
  let groups: any[] = [];
  try { groups = json ? JSON.parse(json) : []; } catch { return []; }
  const pass = (Array.isArray(groups) ? groups : []).find(g => /^passing$/i.test(String(g?.name || '').trim()));
  if (!pass) return [];
  const out: Passer[] = [];
  for (const p of pass.players || []) {
    const id = numOf(p?.player?.id);
    if (!id) continue;
    const st: Record<string, any> = {};
    for (const x of p.statistics || []) if (x?.name) st[String(x.name).toLowerCase().trim()] = x.value;
    const key = (re: RegExp) => Object.keys(st).find(k => re.test(k));
    const ca = pairOf(st[key(/comp.*att|c\/att|^comp/) || '']);
    const att = ca ? ca[1] : numOf(st[key(/^att(empts)?$/) || '']);
    if (!att) continue;
    const yds = numOf(st[key(/^(yards|yds|passing yards)$/) || '']) ?? 0;
    const td = numOf(st[key(/touch ?downs?|^td/) || '']) ?? 0;
    const int = numOf(st[key(/^(interceptions?|int)$/) || '']) ?? 0;
    const sk = st[key(/^sacks?$/) || ''];
    const sp = pairOf(sk);
    const sacks = sp ? sp[0] : numOf(sk) ?? 0, sackYds = sp ? sp[1] : 0;
    // fix149: ANY/A only with attempts + sacks > 0 and a finite result (a bad line would poison the QB ratings)
    if (!(att + sacks > 0)) continue;
    const anya = (yds + 20 * td - 45 * int - sackYds) / (att + sacks);
    if (!Number.isFinite(anya) || !Number.isFinite(att)) continue;
    out.push({ id, name: p?.player?.name || String(id), att, anya });
  }
  return out.sort((a, b) => b.att - a.att);
}

/**
 * QB lines and efficiency numbers of every game with a box score. fix155: parsed once; afterwards only the rows added
 * (or replaced) since the last read are parsed, into the same maps the engine already holds. Team levels (college) are
 * re-read when they change.
 */
const ctxCache = new Map<LeagueId, { ctx: Ctx; pRow: number; tRow: number; teamsSig: string }>();
/** fix165: the first parse of every stored box score, 400 rows at a time with a yield between (the boot build). */
async function loadCtxAsync(league: LeagueId): Promise<Ctx> {
  while (ctxPass(league, 100) > 0) await yieldLoop(); // fix169: 100 rows a step (production box scores are large)
  return ctxCache.get(league)!.ctx;
}
/** One pass: parses up to `limit` new rows of each table (-1 = all); returns how many new rows it read. */
function ctxPass(league: LeagueId, limit: number): number {
  let fresh = 0;
  let c = ctxCache.get(league);
  if (!c) { c = { ctx: { qb: new Map(), box: new Map(), teams: new Map() }, pRow: 0, tRow: 0, teamsSig: '' }; ctxCache.set(league, c); }
  const { qb, box, teams } = c.ctx;
  // ">=": a replaced last row can get the same rowid back (re-reading one row is harmless)
  for (const r of db.prepare(`SELECT s.rowid AS rid, s.game_id, s.team_id, s.json FROM nfl_player_stats s JOIN nfl_games g ON g.game_id = s.game_id WHERE g.league = ? AND s.rowid >= ? ORDER BY s.rowid LIMIT ?`).all(league, c.pRow, limit) as any[]) {
    if (r.rid > c.pRow) fresh++;
    c.pRow = Math.max(c.pRow, r.rid);
    const list = passersOf(r.json);
    if (list.length) qb.set(`${r.game_id}|${r.team_id}`, list);
  }
  for (const r of db.prepare(`SELECT s.rowid AS rid, s.game_id, s.team_id, s.json FROM nfl_team_stats s JOIN nfl_games g ON g.game_id = s.game_id WHERE g.league = ? AND s.rowid >= ? ORDER BY s.rowid LIMIT ?`).all(league, c.tRow, limit) as any[]) {
    if (r.rid > c.tRow) fresh++;
    c.tRow = Math.max(c.tRow, r.rid);
    let s: any = null;
    try { s = JSON.parse(r.json); } catch { s = null; }
    const b = teamBox(s);
    if (!b) continue;
    box.set(`${r.game_id}|${r.team_id}`, {
      ypp: b.yardsPerPlay ?? (b.yards != null && b.plays ? b.yards / b.plays : null), to: b.turnovers, third: b.third, rz: b.redZone, sacks: b.sacks
    });
  }
  // college teams: conference (regression target) and level (FCS start lower); a team we have no row for = FCS
  if (league === 2) {
    const t = db.prepare(`SELECT COUNT(*) AS n, SUM(level = 'FBS') AS fbs, SUM(level = 'FCS') AS fcs, COUNT(conference) AS conf FROM nfl_teams WHERE league = 2`).get() as any;
    const sig = `${t?.n}|${t?.fbs}|${t?.fcs}|${t?.conf}`;
    if (sig !== c.teamsSig) {
      c.teamsSig = sig;
      teams.clear();
      for (const r of db.prepare(`SELECT team_id, conference, level FROM nfl_teams WHERE league = 2`).all() as any[]) teams.set(r.team_id, { conf: r.conference || null, fcs: r.level !== 'FBS', fbs: r.level === 'FBS', isFcs: r.level === 'FCS' });
    }
  }
  return fresh;
}

/* ---------- the engine ---------- */

/** reg = share pulled back between seasons (NFL: 1/3 toward 1500; college: toward the conference mean), fcs = Elo below
 *  1500 an FCS team starts at, movCap = cap of the margin multiplier (99 = none). */
export interface Params { k: number; hfaPre: number; hfaPost: number; bye: number; short: number; qbW: number; alpha: number; reg: number; fcs: number; movCap: number }
const DEFAULT: Params = { k: 20, hfaPre: 55, hfaPost: 30, bye: 15, short: 10, qbW: 40, alpha: 0.08, reg: 1 / 3, fcs: 0, movCap: 99 };
const NCAA_DEFAULT: Params = { k: 25, hfaPre: 70, hfaPost: 60, bye: 10, short: 10, qbW: 30, alpha: 0.08, reg: 0.4, fcs: 250, movCap: 2.5 };
const DEFAULTS: Record<LeagueId, Params> = { 1: DEFAULT, 2: NCAA_DEFAULT };
const ELO_ONLY = (p: Params): Params => ({ ...p, bye: 0, short: 0, qbW: 0 });
/**
 * fix149: every setting present and finite. Settings stored before fix142 have no reg / fcs / movCap: undefined made the
 * season regression NaN and poisoned every rating after it (nfl-exp "LL NaN" from 2022 on).
 */
export function fullParams(p: Partial<Params> | null | undefined, league: LeagueId = 1): Params {
  const d = DEFAULTS[league], out = { ...d };
  for (const k of Object.keys(d) as (keyof Params)[]) { const v = (p as any)?.[k]; if (typeof v === 'number' && Number.isFinite(v)) out[k] = v; }
  return out;
}
const nanSeen = new Set<string>();
/** Log the first non-finite value of a kind once per process: "<who>: first NaN at game X season Y field Z". */
export function noteNaN(who: string, g: { id: number; season: number }, field: string) {
  if (nanSeen.has(who)) return;
  nanSeen.add(who);
  logger.warn(`${who}: first NaN at game ${g.id} season ${g.season} field ${field}`);
}
const QB_PRIOR = 200, QB_DECAY = 0.985, EFF_A = 0.15;
/** Passers with few attempts are shrunk toward a replacement level below the league mean (most of them are backups). */
const QB_REPLACEMENT = 0.7;
/** The team's usual starter = most attempts over its recent games (each older game counts 0.75 as much). */
const USUAL_DECAY = 0.75;

interface TeamState {
  elo: number; season: number; last: number; o: number; d: number; starter: number | null; seasonAtt: Map<number, number>; recentAtt: Map<number, number>;
  eff: { ypp: number; dypp: number; give: number; take: number; third: number; rz: number; sacks: number; n: number }
}
interface Pre {
  g: G; diff: number; p: number; margin: number; total: number; homePts: number; awayPts: number;
  hfa: number; rest: [number | null, number | null]; restAdj: [number, number];
  qb: [QbInfo | null, QbInfo | null]; eloH: number; eloA: number;
  eff: [TeamState['eff'], TeamState['eff']] | null;
}
interface QbInfo { id: number; name: string; value: number; usualId: number | null; usualName: string | null; usualValue: number | null; adj: number; reason: 'same' | 'changed' | 'injury' | 'new' }

class Engine {
  teams = new Map<number, TeamState>();
  qbr = new Map<number, { s: number; w: number; name: string }>();
  qbMean = 6.0; avg = 22;
  p: Params;
  constructor(p: Params, public ctx: Ctx, public league: LeagueId = 1) { this.p = fullParams(p, league); }

  /** College: the mean Elo of a conference's teams (the regression target between seasons). */
  confMean(conf: string | null): number {
    if (!conf) return 1500 - this.p.fcs / 2;
    let s = 0, n = 0;
    for (const [id, t] of this.teams) if (this.ctx.teams.get(id)?.conf === conf) { s += t.elo; n++; }
    return n ? s / n : 1500;
  }

  team(id: number, season: number): TeamState {
    let t = this.teams.get(id);
    if (!t) {
      const info = this.league === 2 ? this.ctx.teams.get(id) : null;
      const start = this.league === 2 && (!info || info.fcs) ? 1500 - this.p.fcs : 1500;
      t = { elo: start, season, last: 0, o: 0, d: 0, starter: null, seasonAtt: new Map(), recentAtt: new Map(), eff: { ypp: 5.3, dypp: 5.3, give: 1.3, take: 1.3, third: 0.39, rz: 0.55, sacks: 2.4, n: 0 } };
      this.teams.set(id, t);
    } else if (t.season !== season) {
      // NFL: 1/3 back to 1500; college: a tuned share back to the conference mean (fix142)
      const target = this.league === 2 ? this.confMean(this.ctx.teams.get(id)?.conf ?? null) : 1500;
      t.elo = target + (t.elo - target) * (1 - this.p.reg);
      if (!Number.isFinite(t.elo)) { noteNaN(`${this.league === 2 ? 'ncaa' : 'nfl'}-v1`, { id, season }, 'elo (season regression)'); t.elo = 1500; }
      t.o *= 2 / 3; t.d *= 2 / 3;
      const e = t.eff;
      t.eff = { ypp: (e.ypp + 5.3) / 2, dypp: (e.dypp + 5.3) / 2, give: (e.give + 1.3) / 2, take: (e.take + 1.3) / 2, third: (e.third + 0.39) / 2, rz: (e.rz + 0.55) / 2, sacks: (e.sacks + 2.4) / 2, n: Math.min(e.n, 4) };
      t.season = season; t.seasonAtt = new Map();
    }
    return t;
  }
  qbValue(id: number | null): number | null {
    if (!id) return null;
    const r = this.qbr.get(id);
    const prior = this.qbMean - QB_REPLACEMENT;
    return r ? (r.s + prior * QB_PRIOR) / (r.w + QB_PRIOR) : prior; // unknown passer: replacement level
  }
  qbName(id: number | null) { return id ? this.qbr.get(id)?.name ?? null : null; }

  /** The starter: the box score's (finished games) or the usual one / his backup (upcoming games). */
  starterFor(g: G, teamId: number, t: TeamState, injuredOut?: Set<number>): { id: number | null; name: string | null; reason: QbInfo['reason'] } {
    const list = this.ctx.qb.get(`${g.id}|${teamId}`);
    if (list && list.length) return { id: list[0].id, name: list[0].name, reason: t.starter && t.starter !== list[0].id ? 'changed' : t.starter ? 'same' : 'new' };
    if (!t.starter) return { id: null, name: null, reason: 'new' };
    if (injuredOut && injuredOut.has(t.starter)) {
      const backup = [...t.seasonAtt.entries()].filter(([id]) => id !== t.starter && !injuredOut.has(id)).sort((a, b) => b[1] - a[1])[0];
      return { id: backup ? backup[0] : -1, name: backup ? this.qbName(backup[0]) : 'Backup QB', reason: 'injury' };
    }
    return { id: t.starter, name: this.qbName(t.starter), reason: 'same' };
  }

  pre(g: G, injuredOut?: Set<number>): Pre {
    const H = this.team(g.h, g.season), A = this.team(g.a, g.season);
    const hfa = g.neutral ? 0 : g.season >= 2020 ? this.p.hfaPost : this.p.hfaPre;
    const restOf = (t: TeamState) => (t.last && t.season === g.season ? (g.t - t.last) / DAY : null);
    const rH = restOf(H), rA = restOf(A);
    const restAdj = (r: number | null) => (r === null ? 0 : r >= 12.5 ? this.p.bye : r <= 5.5 ? -this.p.short : 0);
    const qbInfo = (teamId: number, t: TeamState): QbInfo | null => {
      const s = this.starterFor(g, teamId, t, injuredOut);
      if (!s.id) return null;
      const value = s.id === -1 ? this.qbMean - QB_REPLACEMENT : this.qbValue(s.id)!;
      const usualValue = this.qbValue(t.starter);
      const changed = t.starter !== null && s.id !== t.starter;
      return { id: s.id, name: s.name || String(s.id), value, usualId: t.starter, usualName: this.qbName(t.starter), usualValue, adj: changed && usualValue !== null ? this.p.qbW * (value - usualValue) : 0, reason: s.reason };
    };
    const qH = qbInfo(g.h, H), qA = qbInfo(g.a, A);
    const diff = H.elo - A.elo + hfa + restAdj(rH) - restAdj(rA) + (qH?.adj || 0) - (qA?.adj || 0);
    const p = 1 / (1 + Math.pow(10, -diff / 400));
    const margin = diff / 25;
    const total = 2 * this.avg + H.o + A.d + A.o + H.d;
    const effOk = H.eff.n >= 3 && A.eff.n >= 3;
    return {
      g, diff, p, margin, total, homePts: (total + margin) / 2, awayPts: (total - margin) / 2, hfa, rest: [rH, rA], restAdj: [restAdj(rH), restAdj(rA)],
      qb: [qH, qA], eloH: H.elo, eloA: A.elo, eff: effOk ? [{ ...H.eff }, { ...A.eff }] : null
    };
  }

  update(pr: Pre) {
    const g = pr.g;
    if (!g.done) return;
    const H = this.team(g.h, g.season), A = this.team(g.a, g.season);
    const m = g.hs! - g.as!;
    const res = m > 0 ? 1 : m < 0 ? 0 : 0.5;
    const winnerDiff = m > 0 ? pr.diff : m < 0 ? -pr.diff : 0;
    const mult = Math.min(this.p.movCap, Math.log(Math.abs(m) + 1) * (2.2 / (winnerDiff * 0.001 + 2.2))); // college: capped (blowouts)
    const delta = this.p.k * mult * (res - pr.p);
    // fix149: a non-finite step never reaches the ratings (logged once with the game)
    const who = this.league === 2 ? 'ncaa-v1' : 'nfl-v1';
    if (Number.isFinite(delta)) { H.elo += delta; A.elo -= delta; } else noteNaN(who, g, `elo update (p ${pr.p}, mult ${mult})`);
    // points for / against ratings
    const eH = g.hs! - (this.avg + H.o + A.d), eA = g.as! - (this.avg + A.o + H.d);
    if (Number.isFinite(eH) && Number.isFinite(eA)) {
      H.o += this.p.alpha * eH; A.d += this.p.alpha * eH; A.o += this.p.alpha * eA; H.d += this.p.alpha * eA;
      this.avg += 0.004 * ((g.hs! + g.as!) / 2 - this.avg);
    } else noteNaN(who, g, 'points ratings');
    // QB ratings
    for (const [teamId, t] of [[g.h, H], [g.a, A]] as [number, TeamState][]) {
      const list = this.ctx.qb.get(`${g.id}|${teamId}`);
      if (!list || !list.length) continue;
      for (const q of list) {
        if (!Number.isFinite(q.anya) || !(q.att > 0)) { noteNaN(this.league === 2 ? 'ncaa-v1' : 'nfl-v1', g, `QB ANY/A of ${q.id}`); continue; }
        const r = this.qbr.get(q.id) || { s: 0, w: 0, name: q.name };
        r.s = r.s * QB_DECAY + q.anya * q.att; r.w = r.w * QB_DECAY + q.att; r.name = q.name;
        this.qbr.set(q.id, r);
        this.qbMean += 0.0005 * q.att * (q.anya - this.qbMean) / 30;
        t.seasonAtt.set(q.id, (t.seasonAtt.get(q.id) || 0) + q.att);
      }
      // usual starter: most recent attempts (a backup takes over after 2–3 starts, not after one)
      for (const [id, a] of t.recentAtt) t.recentAtt.set(id, a * USUAL_DECAY);
      for (const q of list) t.recentAtt.set(q.id, (t.recentAtt.get(q.id) || 0) + q.att);
      const top = [...t.recentAtt.entries()].sort((a, b) => b[1] - a[1])[0];
      if (top && top[1] >= 10) t.starter = top[0];
    }
    // efficiency
    const bH = this.ctx.box.get(`${g.id}|${g.h}`), bA = this.ctx.box.get(`${g.id}|${g.a}`);
    if (bH && bA) {
      const upd = (t: TeamState, me: Box, op: Box) => {
        const e = t.eff, a = EFF_A;
        if (me.ypp != null) e.ypp += a * (me.ypp - e.ypp);
        if (op.ypp != null) e.dypp += a * (op.ypp - e.dypp);
        if (me.to != null) e.give += a * (me.to - e.give);
        if (op.to != null) e.take += a * (op.to - e.take);
        if (me.third && me.third[1]) e.third += a * (me.third[0] / me.third[1] - e.third);
        if (me.rz && me.rz[1]) e.rz += a * (me.rz[0] / me.rz[1] - e.rz);
        if (me.sacks != null) e.sacks += a * (me.sacks - e.sacks);
        e.n++;
      };
      upd(H, bH, bA); upd(A, bA, bH);
    }
    H.last = g.t; A.last = g.t;
  }
}

/** One pass over games in order; `onPre` sees every game's pre-game numbers (finished games update the ratings). */
function run(games: G[], p: Params, ctx: Ctx, onPre?: (pr: Pre) => void, stopBefore?: number, league: LeagueId = 1) {
  const E = new Engine(p, ctx, league);
  for (const g of games) {
    if (stopBefore !== undefined && g.t >= stopBefore) break;
    if (!g.done) { // an unplayed game in the past (cancelled / postponed): only the schedule clock moves on
      continue;
    }
    const pr = E.pre(g);
    onPre?.(pr);
    E.update(pr);
  }
  return E;
}

/* ---------- efficiency blend (D) ---------- */

const featOf = (pr: Pre): number[] | null => {
  if (!pr.eff) return null;
  const [h, a] = pr.eff;
  return [pr.diff / 100, (h.ypp - h.dypp) - (a.ypp - a.dypp), (h.take - h.give) - (a.take - a.give), h.third - a.third, h.rz - a.rz, h.sacks - a.sacks];
};
interface Blend { w: number[]; b: number; mu: number[]; sd: number[] }
function fitBlend(rows: { x: number[]; y: number }[]): Blend | null {
  if (rows.length < 150) return null;
  const k = rows[0].x.length;
  const mu = Array.from({ length: k }, (_, j) => rows.reduce((s, r) => s + r.x[j], 0) / rows.length);
  const sd = Array.from({ length: k }, (_, j) => Math.sqrt(rows.reduce((s, r) => s + (r.x[j] - mu[j]) ** 2, 0) / rows.length) || 1);
  const z = rows.map(r => ({ x: r.x.map((v, j) => (v - mu[j]) / sd[j]), y: r.y }));
  const w = new Array(k).fill(0); let b = 0;
  const lr = 0.1, l2 = 0.01;
  for (let it = 0; it < 400; it++) {
    const gw = new Array(k).fill(0); let gb = 0;
    for (const r of z) {
      const s = b + r.x.reduce((acc, v, j) => acc + v * w[j], 0);
      const e = 1 / (1 + Math.exp(-s)) - r.y;
      gb += e; for (let j = 0; j < k; j++) gw[j] += e * r.x[j];
    }
    b -= (lr * gb) / z.length;
    for (let j = 0; j < k; j++) w[j] -= lr * (gw[j] / z.length + l2 * w[j]);
  }
  return { w, b, mu, sd };
}
const blendP = (bl: Blend, x: number[]) => 1 / (1 + Math.exp(-(bl.b + x.reduce((s, v, j) => s + ((v - bl.mu[j]) / bl.sd[j]) * bl.w[j], 0))));

/* ---------- metrics ---------- */

interface Row { p: number; y: number; m: number; mHat: number; tot: number; totHat: number }
const clip = (p: number) => Math.min(0.995, Math.max(0.005, p));
function metrics(rows: Row[]) {
  const n = rows.length;
  if (!n) return { games: 0 };
  let ll = 0, br = 0, hit = 0, hitN = 0, mae = 0, tmae = 0;
  const bins = [[50, 60], [60, 70], [70, 80], [80, 101]].map(([lo, hi]) => ({ bin: hi > 100 ? `${lo}+` : `${lo}-${hi}`, lo, hi, n: 0, sumP: 0, hits: 0 }));
  for (const r of rows) {
    const p = clip(r.p);
    ll += -(r.y * Math.log(p) + (1 - r.y) * Math.log(1 - p));
    br += (p - r.y) ** 2;
    if (r.y !== 0.5) { hitN++; if ((p >= 0.5 ? 1 : 0) === r.y) hit++; }
    mae += Math.abs(r.m - r.mHat); tmae += Math.abs(r.tot - r.totHat);
    const top = Math.max(p, 1 - p) * 100;
    const b = bins.find(x => top >= x.lo && top < x.hi);
    if (b && r.y !== 0.5) { b.n++; b.sumP += top; if ((p >= 0.5 ? 1 : 0) === r.y) b.hits++; }
  }
  const r1 = (x: number) => Math.round(x * 10) / 10, r4 = (x: number) => Math.round(x * 10000) / 10000;
  return {
    games: n, hit: hitN ? r1((100 * hit) / hitN) : null, logLoss: r4(ll / n), brier: r4(br / n), marginMAE: r1(mae / n), totalMAE: r1(tmae / n),
    calibration: bins.map(b => ({ bin: b.bin, games: b.n, predicted: b.n ? r1(b.sumP / b.n) : null, actual: b.n ? r1((100 * b.hits) / b.n) : null }))
  };
}
const rowOf = (pr: Pre, p = pr.p, mHat = pr.margin): Row => {
  const m = pr.g.hs! - pr.g.as!;
  return { p, y: m > 0 ? 1 : m < 0 ? 0 : 0.5, m, mHat, tot: pr.g.hs! + pr.g.as!, totHat: pr.total };
};
const logLossOf = (rows: Row[]) => rows.reduce((s, r) => s - (r.y * Math.log(clip(r.p)) + (1 - r.y) * Math.log(1 - clip(r.p))), 0) / Math.max(1, rows.length);
const marginFromP = (p: number) => (Math.log10(clip(p) / (1 - clip(p))) * 400) / 25;

/* ---------- tuning (coordinate search on log loss; points rate on total MAE) ---------- */

const GRID: Record<keyof Params, number[]> = {
  k: [12, 16, 20, 24, 28, 34], hfaPre: [35, 45, 55, 65, 75], hfaPost: [5, 15, 25, 35, 45, 55], bye: [0, 10, 20, 30], short: [0, 10, 20, 30], qbW: [0, 15, 30, 45, 60, 80], alpha: [0.04, 0.06, 0.08, 0.11, 0.15],
  reg: [1 / 3], fcs: [0], movCap: [99]
};
/** College (fix142): its own ranges — bigger home field, conference regression, FCS start, the blowout cap. */
const NCAA_GRID: Record<keyof Params, number[]> = {
  k: [16, 20, 25, 30, 36, 44], hfaPre: [40, 55, 70, 85, 100, 115, 130], hfaPost: [30, 45, 60, 75, 90, 105, 120], bye: [0, 10, 20, 30], short: [0, 10, 20, 30], qbW: [0, 15, 30, 45, 60], alpha: [0.04, 0.06, 0.08, 0.11, 0.15],
  reg: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6], fcs: [100, 175, 250, 325, 400, 500], movCap: [1.8, 2.2, 2.6, 3.0, 99]
};
const GRIDS: Record<LeagueId, Record<keyof Params, number[]>> = { 1: GRID, 2: NCAA_GRID };
const TUNE_KEYS: Record<LeagueId, (keyof Params)[]> = { 1: ['k', 'hfaPre', 'hfaPost', 'qbW', 'bye', 'short'], 2: ['k', 'hfaPre', 'hfaPost', 'reg', 'fcs', 'movCap', 'qbW', 'bye', 'short'] };
const ELO_KEYS: Record<LeagueId, (keyof Params)[]> = { 1: ['k', 'hfaPre', 'hfaPost'], 2: ['k', 'hfaPre', 'hfaPost', 'reg', 'fcs', 'movCap'] };

/** Tune on the games before `before` (ms), the first season being warm-up only. */
async function tune(games: G[], ctx: Ctx, before: number, eloOnly = false, league: LeagueId = 1): Promise<Params> {
  const grid = GRIDS[league];
  const train = games.filter(g => g.t < before);
  const first = train.find(g => g.done)?.season;
  const score = (p: Params, key: 'll' | 'tot') => {
    const rows: Row[] = [];
    run(train, p, ctx, pr => { if (pr.g.season !== first) rows.push(rowOf(pr)); }, undefined, league);
    return key === 'll' ? logLossOf(rows) : rows.reduce((s, r) => s + Math.abs(r.tot - r.totHat), 0) / Math.max(1, rows.length);
  };
  let best: Params = eloOnly ? ELO_ONLY(DEFAULTS[league]) : { ...DEFAULTS[league] };
  const keys = eloOnly ? ELO_KEYS[league] : TUNE_KEYS[league];
  for (let pass = 0; pass < 2; pass++) {
    for (const key of keys) {
      let bestS = Infinity, bestV = best[key];
      for (const v of grid[key]) {
        const s = score({ ...best, [key]: v }, 'll');
        if (s < bestS - 1e-6) { bestS = s; bestV = v; }
        await yieldLoop();
      }
      best = { ...best, [key]: bestV };
    }
  }
  let bestT = Infinity;
  for (const v of grid.alpha) { const s = score({ ...best, alpha: v }, 'tot'); if (s < bestT) { bestT = s; best = { ...best, alpha: v }; } await yieldLoop(); }
  return best;
}

/* ---------- walk-forward test ---------- */

export interface Report {
  model: string; league?: LeagueId; builtAt: string; seasons: any[]; total: any; baselines: any; fbs?: any; fbsFcs?: any; levels?: Record<string, number>; blend: { used: boolean; testLogLossAB: number | null; testLogLossD: number | null };
  live: { params: Params; blend: boolean; seasonsTrained: number[] } | null; data: { games: number; finished: number; withBox: number; withQb: number; seasons: number[] }
}

export async function buildReport(league: LeagueId = 1): Promise<Report> {
  const MODEL = MODEL_OF[league];
  const games = await loadGamesAsync(league); // fix171: paged, with yields
  const ctx = await loadCtxAsync(league);
  // college: FBS vs FBS games reported apart as well
  const isFbs = (g: G) => league === 2 && !!ctx.teams.get(g.h)?.fbs && !!ctx.teams.get(g.a)?.fbs;
  // fix143: FBS against FCS (either way round)
  const isMix = (g: G) => league === 2 && ((!!ctx.teams.get(g.h)?.fbs && !!ctx.teams.get(g.a)?.isFcs) || (!!ctx.teams.get(g.a)?.fbs && !!ctx.teams.get(g.h)?.isFcs));
  const fbsAll: Row[] = [], mixAll: Row[] = [];
  const finished = games.filter(g => g.done);
  const seasons = [...new Set(finished.map(g => g.season))].sort((a, b) => a - b);
  const testSeasons = seasons.filter(s => finished.filter(g => g.season === s).length >= 30).slice(-5).filter(s => s !== seasons[0]);
  const per: any[] = [];
  const all = { ab: [] as Row[], d: [] as Row[], elo: [] as Row[] };
  const base = { home: { hit: 0, n: 0, ll: 0 }, record: { hit: 0, n: 0 } };
  for (const S of testSeasons) {
    const start = Math.min(...finished.filter(g => g.season === S).map(g => g.t));
    const p = await tune(games, ctx, start, false, league);
    const pElo = await tune(games, ctx, start, true, league);
    // blend fitted on the training seasons' pre-game numbers
    const trainRows: { x: number[]; y: number }[] = [];
    run(games, p, ctx, pr => { if (pr.g.t < start && pr.g.season !== seasons[0]) { const x = featOf(pr); if (x) trainRows.push({ x, y: rowOf(pr).y }); } }, start, league);
    const bl = fitBlend(trainRows.filter(r => r.y !== 0.5));
    const homeRate = (() => { const tr = finished.filter(g => g.t < start); return tr.filter(g => g.hs! > g.as!).length / Math.max(1, tr.length); })();
    const ab: Row[] = [], d: Row[] = [], elo: Row[] = [], fbs: Row[] = [], mix: Row[] = [];
    const rec = new Map<number, { w: number; g: number }>();
    run(games, p, ctx, pr => {
      if (pr.g.season !== S) return;
      const r = rowOf(pr);
      ab.push(r);
      if (isFbs(pr.g)) fbs.push(r);
      if (isMix(pr.g)) mix.push(r);
      const x = featOf(pr);
      const pd = bl && x ? blendP(bl, x) : pr.p;
      d.push({ ...r, p: pd, mHat: bl && x ? marginFromP(pd) : r.mHat });
      // baselines
      if (r.y !== 0.5) {
        base.home.n++; if (r.y === 1) base.home.hit++;
        const rh = rec.get(pr.g.h) || { w: 0, g: 0 }, ra = rec.get(pr.g.a) || { w: 0, g: 0 };
        const ph = rh.g ? rh.w / rh.g : 0, pa = ra.g ? ra.w / ra.g : 0;
        base.record.n++; if ((pa > ph ? 0 : 1) === r.y) base.record.hit++;
      }
      base.home.ll += -(r.y * Math.log(homeRate) + (1 - r.y) * Math.log(1 - homeRate));
      for (const [id, won] of [[pr.g.h, r.y], [pr.g.a, 1 - r.y]] as [number, number][]) { const x2 = rec.get(id) || { w: 0, g: 0 }; x2.w += won; x2.g++; rec.set(id, x2); }
    }, undefined, league);
    run(games, pElo, ctx, pr => { if (pr.g.season === S) elo.push(rowOf(pr)); }, undefined, league);
    const mAB = metrics(ab), mD = metrics(d), mElo = metrics(elo);
    const homeS = ab.filter(r => r.y !== 0.5), homeHit = homeS.length ? Math.round((1000 * homeS.filter(r => r.y === 1).length) / homeS.length) / 10 : null;
    const mFbs = league === 2 ? metrics(fbs) : null, mMix = league === 2 ? metrics(mix) : null;
    per.push({ season: S, params: p, ab: mAB, blend: bl ? mD : null, eloOnly: mElo, homeTeamHit: homeHit, ...(mFbs ? { fbsOnly: mFbs, fbsFcs: mMix } : {}) });
    all.ab.push(...ab); all.d.push(...d); all.elo.push(...elo); fbsAll.push(...fbs); mixAll.push(...mix);
    if (mFbs) logger.info(`${MODEL} ${S} FBS vs FBS: hit ${(mFbs as any).hit}% LL ${(mFbs as any).logLoss} over ${(mFbs as any).games} games`);
    if (mMix) logger.info(`${MODEL} ${S} FBS vs FCS: hit ${(mMix as any).hit}% LL ${(mMix as any).logLoss} over ${(mMix as any).games} games`);
    logger.info(`${MODEL} ${S}: hit ${(mAB as any).hit}% LL ${(mAB as any).logLoss} over ${(mAB as any).games} games (home ${homeHit}%, Elo ${(mElo as any).hit}%)${bl ? ` · with efficiency: hit ${(mD as any).hit}% LL ${(mD as any).logLoss}` : ''}`);
    await yieldLoop();
  }
  const llAB = all.ab.length ? logLossOf(all.ab) : null, llD = all.d.length ? logLossOf(all.d) : null;
  const useD = llAB !== null && llD !== null && Number.isFinite(llD) && Number.isFinite(llAB) && llD < llAB - 0.0005;
  logger.info(`${MODEL} total: A+B LL ${llAB === null ? '–' : llAB.toFixed(4)}, with efficiency ${llD === null ? '–' : llD.toFixed(4)} → ${useD ? 'efficiency blend (D) kept' : 'A+B kept'}`);
  const r1 = (x: number) => Math.round(x * 10) / 10;
  const report: Report = {
    model: MODEL, league, builtAt: new Date().toISOString(), seasons: per,
    ...(league === 2 ? { fbs: metrics(fbsAll), fbsFcs: metrics(mixAll), levels: Object.fromEntries((db.prepare(`SELECT COALESCE(level, 'unknown') AS l, COUNT(*) AS n FROM nfl_teams WHERE league = 2 GROUP BY l`).all() as any[]).map(r => [r.l, r.n])) } : {}),
    total: { ab: metrics(all.ab), blend: metrics(all.d), eloOnly: metrics(all.elo) },
    baselines: {
      homeTeam: base.home.n ? { hit: r1((100 * base.home.hit) / base.home.n), logLoss: Math.round((base.home.ll / Math.max(1, all.ab.length)) * 10000) / 10000 } : null,
      betterRecord: base.record.n ? { hit: r1((100 * base.record.hit) / base.record.n) } : null,
      eloOnly: { hit: (metrics(all.elo) as any).hit ?? null, logLoss: (metrics(all.elo) as any).logLoss ?? null }
    },
    blend: { used: useD, testLogLossAB: llAB, testLogLossD: llD },
    live: null,
    data: { games: games.length, finished: finished.length, withBox: new Set([...ctx.box.keys()].map(k => k.split('|')[0])).size, withQb: new Set([...ctx.qb.keys()].map(k => k.split('|')[0])).size, seasons }
  };
  return report;
}

/* ---------- live model ---------- */

interface Live {
  params: Params; blend: Blend | null; trained: number[]; builtAt: string; finishedCount: number; engine: Engine; games: G[]
  /** fix155: games already in the ratings, the latest kick-off among them, games by id */
  applied: Set<number>; lastT: number; byId: Map<number, G>; outOfOrder: boolean
  /** fix171: games patched in since that may have finished, waiting to be added (box scores still being parsed) */
  pending: Set<number>
}
const lives = new Map<LeagueId, Live>();
const sync = (key: string, v: unknown) => db.prepare(`INSERT OR REPLACE INTO nfl_sync (key, at, detail) VALUES (?, ?, ?)`).run(key, new Date().toISOString(), JSON.stringify(v));
const readSync = (key: string): any => { const r = db.prepare(`SELECT detail FROM nfl_sync WHERE key = ?`).get(key) as any; try { return r ? JSON.parse(r.detail) : null; } catch { return null; } };

/** Re-tune on every finished season (+ the walk-forward report), then replay. Weekly (Tuesday) or when nothing is stored. */
export async function retrain(league: LeagueId = 1): Promise<Report> {
  const report = await buildReport(league);
  const games = await loadGamesAsync(league), ctx = await loadCtxAsync(league); // fix171
  const finished = games.filter(g => g.done);
  const params = finished.length >= 200 ? await tune(games, ctx, Date.now() + DAY, false, league) : DEFAULTS[league];
  let blend: Blend | null = null;
  if (report.blend.used) {
    const first = finished[0]?.season;
    const rows: { x: number[]; y: number }[] = [];
    run(games, params, ctx, pr => { if (pr.g.season !== first) { const x = featOf(pr); const y = rowOf(pr).y; if (x && y !== 0.5) rows.push({ x, y }); } }, undefined, league);
    blend = fitBlend(rows);
  }
  const trained = [...new Set(finished.map(g => g.season))].sort((a, b) => a - b);
  report.live = { params, blend: !!blend, seasonsTrained: trained };
  // fix149: a walk-forward test with a NaN / Infinity log loss or under 55% right is invalid: the old settings stay
  const tot: any = report.blend.used ? report.total.blend : report.total.ab;
  if (tot?.games && (!Number.isFinite(tot.logLoss) || tot.hit === null || tot.hit < 55)) {
    logger.warn(`${MODEL_OF[league]} invalid (LL ${tot.logLoss}, hit ${tot.hit}%): settings not stored, the previous ones stay`);
    sync(`${KEY_OF[league]}|report`, { ...report, invalid: true });
    return report;
  }
  sync(`${KEY_OF[league]}|params`, { params, blend, trained, at: new Date().toISOString() });
  sync(`${KEY_OF[league]}|report`, report);
  await rebuildLive(league); // fix155: replayed now, with yields (not on the next request)
  return report;
}

function liveOf(games: G[], params: Params, stored: any, engine: Engine): Live {
  const done = games.filter(g => g.done);
  return { params, blend: stored?.blend || null, trained: stored?.trained || [], builtAt: new Date().toISOString(), finishedCount: done.length, engine, games,
    applied: new Set(done.map(g => g.id)), lastT: done.reduce((m, g) => Math.max(m, g.t), 0), byId: new Map(games.map(g => [g.id, g])), outOfOrder: false, pending: new Set() };
}
/** fix155: the same replay without blocking the server (yields every 150 games); the live ratings are swapped at the end. */
const replaying = new Set<LeagueId>();
const slice40 = slicer(40); // fix169: the replay gives way every ~40 ms
export async function rebuildLive(league: LeagueId): Promise<void> {
  if (replaying.has(league)) return;
  replaying.add(league);
  try {
    const games = await loadGamesAsync(league);
    takeChanged(league); // this replay starts from this list (no await since it was read)
    if (games.filter(g => g.done).length < 50) return;
    const stored = readSync(`${KEY_OF[league]}|params`);
    const params: Params = { ...DEFAULTS[league], ...(stored?.params || {}) };
    const E = new Engine(params, await loadCtxAsync(league), league); // fix165: paged, with yields
    let i = 0;
    for (const g of games) {
      if (!g.done) continue;
      E.update(E.pre(g));
      if (++i % 20 === 0) await slice40(); // fix169: ~40 ms slices
    }
    // fix171: games patched in during the replay were taken by the old ratings: the new ones compare once
    if (gamesCache.get(league)?.games !== games) noteChanged(league, 'all');
    lives.set(league, liveOf(games, params, stored, E));
  } finally { replaying.delete(league); }
}
/**
 * The current ratings. fix155: built once (full replay); afterwards each newly finished game is added on top (cheap,
 * a few ms), so a live tick never replays ten seasons. A result that arrives out of order (an earlier kick-off than
 * games already counted) or 6 hours since the last full replay starts a background replay that yields to visitors.
 */
function current(league: LeagueId = 1): Live | null {
  // fix171: never a full read here (the first one froze the server 6.7 s at start-up): no list yet = the background
  // build runs (with yields) and this request goes without
  const games = peekGames(league);
  const live = games ? lives.get(league) : undefined;
  if (!games || !live) {
    void timed('nfl ratings', () => rebuildLive(league)).catch(e => logger.warn(`${MODEL_OF[league]} replay: ${e.message}`));
    return null;
  }
  const ch = takeChanged(league);
  if (ch === 'all') { for (const g of games) if (g.done && !live.applied.has(g.id)) live.pending.add(g.id); }
  else if (ch) for (const id of ch) if (!live.applied.has(id)) live.pending.add(id);
  if (live.games !== games) { live.games = games; live.byId = new Map(games.map(g => [g.id, g])); }
  if (live.pending.size) {
    // the new box scores (same maps the engine reads), 50 rows a step; while more are waiting, only the games whose
    // box score is already parsed are added, the rest on a later tick
    const more = ctxPass(league, 50) >= 50;
    const ctx = ctxCache.get(league)!.ctx;
    const fresh: G[] = [];
    for (const id of live.pending) {
      const g = live.byId.get(id);
      if (!g || !g.done || live.applied.has(id)) { live.pending.delete(id); continue; }
      if (more && !ctx.box.has(`${id}|${g.h}`) && !ctx.qb.has(`${id}|${g.h}`)) continue;
      fresh.push(g);
      live.pending.delete(id);
    }
    fresh.sort(byTime);
    for (const g of fresh) {
      live.engine.update(live.engine.pre(g));
      live.applied.add(g.id);
      if (g.t < live.lastT - 12 * 3600 * 1000) live.outOfOrder = true;
      live.lastT = Math.max(live.lastT, g.t);
    }
    live.finishedCount = live.applied.size;
  }
  if (live.outOfOrder || Date.now() - Date.parse(live.builtAt) > 6 * 3600 * 1000) void timed('nfl ratings', () => rebuildLive(league)).catch(e => logger.warn(`${MODEL_OF[league]} replay: ${e.message}`));
  return live;
}
const leagueOfGame = (gameId: number): LeagueId => ((db.prepare(`SELECT league FROM nfl_games WHERE game_id = ?`).get(gameId) as any)?.league === 2 ? 2 : 1);
const leagueOfTeam = (teamId: number): LeagueId => ((db.prepare(`SELECT league FROM nfl_teams WHERE team_id = ?`).get(teamId) as any)?.league === 2 ? 2 : 1);

const OUT = /out|doubtful|injured reserve|^ir$|reserve/i;
function injuredOut(teamId: number): Set<number> {
  return new Set((db.prepare(`SELECT player_id, status FROM nfl_injuries WHERE team_id = ?`).all(teamId) as any[]).filter(r => OUT.test(String(r.status || ''))).map(r => r.player_id));
}

export interface NflPred {
  pHome: number; pAway: number; pick: 'H' | 'A'; margin: number; total: number; homePts: number; awayPts: number; strong: boolean; model: string;
  why: { eloHome: number; eloAway: number; eloGap: number; homeField: number; neutral: boolean; rest: [number | null, number | null]; restAdj: [number, number];
    qb: [QbInfo | null, QbInfo | null]; eff: { yppHome: number; yppAway: number; toHome: number; toAway: number } | null; blend: boolean }
}

/** A prediction for one game that has not started, from the current ratings (null when the model has too few games). */
export function predictNfl(gameId: number): NflPred | null {
  const league = leagueOfGame(gameId);
  const L = current(league);
  if (!L) return null;
  const g = L.byId.get(gameId);
  if (!g || g.done) return null;
  const outs = new Set([...injuredOut(g.h), ...injuredOut(g.a)]);
  // the engine's state is "after every finished game"; a copy is not needed: pre() only reads (team() may regress a new season)
  const pr = L.engine.pre(g, outs);
  const x = featOf(pr);
  let p = L.blend && x ? blendP(L.blend, x) : pr.p;
  let margin = L.blend && x ? marginFromP(p) : pr.margin;
  // fix146: the NFL uses nfl-v2 once the experiments adopted one (the reasons below stay nfl-v1's numbers)
  let model = MODEL_OF[league];
  if (league === 1) { const q = exps().v2Prob(g as any, pr as any); if (q !== null) { p = q; margin = marginFromP(q); model = exps().NFL_V2; } }
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const pHome = Math.round(p * 1000) / 10;
  return {
    pHome, pAway: r1(100 - pHome), pick: p >= 0.5 ? 'H' : 'A', margin: r1(margin), total: r1(pr.total),
    homePts: r1((pr.total + margin) / 2), awayPts: r1((pr.total - margin) / 2), strong: Math.max(p, 1 - p) >= STRONG_OF[league], model,
    why: {
      eloHome: Math.round(pr.eloH), eloAway: Math.round(pr.eloA), eloGap: Math.round(pr.eloH - pr.eloA), homeField: Math.round(pr.hfa), neutral: g.neutral,
      rest: [pr.rest[0] === null ? null : Math.round(pr.rest[0]), pr.rest[1] === null ? null : Math.round(pr.rest[1])], restAdj: pr.restAdj,
      qb: pr.qb.map(q => (q ? { ...q, value: r1(q.value), usualValue: q.usualValue === null ? null : r1(q.usualValue), adj: Math.round(q.adj) } : null)) as [QbInfo | null, QbInfo | null],
      eff: pr.eff ? { yppHome: r1(pr.eff[0].ypp - pr.eff[0].dypp), yppAway: r1(pr.eff[1].ypp - pr.eff[1].dypp), toHome: r1(pr.eff[0].take - pr.eff[0].give), toAway: r1(pr.eff[1].take - pr.eff[1].give) } : null,
      blend: !!L.blend
    }
  };
}

/**
 * Save / refresh the predictions of the games of the next 9 days that have not started (frozen at kick-off).
 * fix155: async — yields to visitors every 25 games, then one short write.
 */
export async function saveNflPredictions(): Promise<number> {
  const now = new Date();
  const rows = db.prepare(`SELECT game_id, season, kickoff, home_id, away_id FROM nfl_games WHERE kickoff > ? AND kickoff < ? AND (status IS NULL OR status = 'NS') AND (stage IS NULL OR stage NOT LIKE 'Pre%')`)
    .all(now.toISOString(), new Date(now.getTime() + 9 * DAY).toISOString()) as any[];
  const out: { r: any; pr: NflPred }[] = [];
  let i = 0;
  for (const r of rows) {
    const pr = predictNfl(r.game_id);
    if (pr) out.push({ r, pr });
    if (++i % 25 === 0) await yieldLoop();
  }
  const up = db.prepare(`INSERT OR REPLACE INTO nfl_predictions (game_id, season, kickoff, model, p_home, margin, total, home_pts, away_pts, why, made_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const at = new Date().toISOString();
  db.exec('BEGIN');
  try {
    // a game that kicked off while we were computing keeps the prediction it had at kick-off
    for (const { r, pr } of out) if (Date.parse(r.kickoff) > Date.now()) {
      up.run(r.game_id, r.season, r.kickoff, pr.model, pr.pHome / 100, pr.margin, pr.total, pr.homePts, pr.awayPts, JSON.stringify(pr.why), at);
      // fix174: the first version of each game (who was out then), for "numbers changed because…"
      try { rememberFirstPrediction(r.game_id, r.home_id, r.away_id, pr.pHome / 100, pr.margin, pr.why?.qb, at); } catch { /* optional */ }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return out.length;
}

/** The saved prediction of a game (what was shown before kick-off), with the result once it is over. */
export function savedNflPrediction(gameId: number) {
  const r = db.prepare(`SELECT p.*, g.status, g.home_pts AS hs, g.away_pts AS as_ FROM nfl_predictions p JOIN nfl_games g ON g.game_id = p.game_id WHERE p.game_id = ? AND p.made_at <= p.kickoff`).get(gameId) as any;
  if (!r) return null;
  const done = ['FT', 'AOT'].includes(r.status) && r.hs != null;
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const pHome = Math.round(r.p_home * 1000) / 10;
  let why: any = null; try { why = r.why ? JSON.parse(r.why) : null; } catch { why = null; }
  return {
    pHome, pAway: r1(100 - pHome), pick: (r.p_home >= 0.5 ? 'H' : 'A') as 'H' | 'A', margin: r1(r.margin), total: r1(r.total), homePts: r1(r.home_pts), awayPts: r1(r.away_pts),
    strong: Math.max(r.p_home, 1 - r.p_home) >= strongForModel(r.model), model: r.model, why,
    hit: done && r.hs !== r.as_ ? (r.p_home >= 0.5) === (r.hs > r.as_) : null
  };
}

/**
 * Predictions on game lists (rows, home, game page). Paid / admin get the numbers; everyone else gets a locked
 * marker for games that have not finished (no pick, like basketball since fix123) and the pick + hit once it is over.
 */
export function withNflPrediction<T extends NflGame>(g: T, full: boolean): T & { prediction: any } {
  const s = savedNflPrediction(g.id);
  if (!s) return { ...g, prediction: null };
  if (full) return { ...g, prediction: { ...s, locked: false } };
  // finished games: everyone sees the numbers and the hit (like basketball), not the reasons
  if (g.state === 'done') { const { why: _why, ...rest } = s; return { ...g, prediction: { ...rest, locked: false } }; }
  return { ...g, prediction: { locked: true, model: s.model } };
}

/** Our record on one team's games (saved before kick-off, finished): picks, right, strong picks right. */
/**
 * The NFL record (fix141, home "Our record"): predictions saved before kick-off of finished games in the last `days`
 * (never a backtest), the share where the picked team won, all picks and by how sure we were. Ties don't count.
 */
export function nflRecord(days = 30, leagues: LeagueId | LeagueId[] = [1, 2]) {
  // fix185: one combined record of the leagues asked (both by default); the bands are the same 60 / 70 / 80 lines
  const lgs = (Array.isArray(leagues) ? leagues : [leagues]).filter(l => l === 1 || l === 2);
  const rows = db.prepare(`SELECT p.p_home, g.home_pts AS hs, g.away_pts AS as_ FROM nfl_predictions p JOIN nfl_games g ON g.game_id = p.game_id
    WHERE g.league IN (${lgs.map(() => '?').join(',') || '1'}) AND p.kickoff >= ? AND p.made_at <= p.kickoff AND g.status IN ('FT','AOT') AND g.home_pts IS NOT NULL AND g.home_pts != g.away_pts`)
    .all(...lgs, new Date(Date.now() - days * 86400000).toISOString()) as any[];
  return { days, bands: winnerBands(rows.map(r => ({ p: Math.max(r.p_home, 1 - r.p_home), hit: (r.p_home >= 0.5) === (r.hs > r.as_) }))) };
}

/**
 * NFL accuracy page (fix144, admins): every pick saved before kick-off and checked after the game, both leagues, in the
 * basketball record's shape — total, per league (NFL / NCAA), confidence bands, the latest checked picks and the ones
 * waiting. Strong = the league's own line (NFL 70%, college 75%). Ties (no winner) left out.
 */
/** fix174: mean miss of the expected margin and of the total points (finished games with a saved prediction). */
export function scoreOff(rows: { margin: number | null; total: number | null; hs: number; as_: number }[]) {
  const m = rows.filter(r => typeof r.margin === 'number'), t = rows.filter(r => typeof r.total === 'number');
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return {
    marginOff: m.length ? r1(m.reduce((s, r) => s + Math.abs(r.margin! - (r.hs - r.as_)), 0) / m.length) : null,
    totalOff: t.length ? r1(t.reduce((s, r) => s + Math.abs(r.total! - (r.hs + r.as_)), 0) / t.length) : null,
    scoreN: m.length
  };
}

export function nflAccuracy(days = 3650) {
  const rows = db.prepare(`SELECT p.game_id, p.kickoff, p.p_home, p.margin, p.total, g.league, g.home_name, g.away_name, g.home_logo, g.away_logo, g.home_pts AS hs, g.away_pts AS as_
    FROM nfl_predictions p JOIN nfl_games g ON g.game_id = p.game_id
    WHERE p.kickoff >= ? AND p.made_at <= p.kickoff AND g.status IN ('FT','AOT') AND g.home_pts IS NOT NULL AND g.home_pts != g.away_pts ORDER BY p.kickoff DESC`)
    .all(new Date(Date.now() - days * 86400000).toISOString()) as any[];
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
  const code = (l: number) => (l === 2 ? 'NCAA' : 'NFL');
  const hit = (r: any) => (r.p_home >= 0.5) === (r.hs > r.as_);
  const tot = { n: 0, hits: 0, strongN: 0, strongHits: 0 };
  const by = new Map<string, typeof tot>();
  for (const r of rows) {
    const strong = Math.max(r.p_home, 1 - r.p_home) >= STRONG_OF[r.league === 2 ? 2 : 1];
    const lg = by.get(code(r.league)) || (by.set(code(r.league), { n: 0, hits: 0, strongN: 0, strongHits: 0 }), by.get(code(r.league))!);
    for (const b of [tot, lg]) { b.n++; if (hit(r)) b.hits++; if (strong) { b.strongN++; if (hit(r)) b.strongHits++; } }
  }
  const pending = (db.prepare(`SELECT p.game_id, p.kickoff, p.p_home, g.league, g.home_name, g.away_name, g.home_logo, g.away_logo, g.status, g.home_pts AS hs, g.away_pts AS as_
    FROM nfl_predictions p JOIN nfl_games g ON g.game_id = p.game_id
    WHERE (g.status IS NULL OR g.status NOT IN ('FT','AOT','CANC','PST')) AND p.kickoff BETWEEN ? AND ? ORDER BY p.kickoff LIMIT 60`)
    .all(new Date(Date.now() - 5 * 3600000).toISOString(), new Date(Date.now() + 36 * 3600000).toISOString()) as any[]).map(r => ({
      gameId: r.game_id, code: code(r.league), kickoff: r.kickoff, home: r.home_name || 'TBD', away: r.away_name || 'TBD', homeLogo: r.home_logo, awayLogo: r.away_logo,
      status: r.status, live: !!r.status && r.status !== 'NS' && Date.parse(r.kickoff) <= Date.now(), score: r.hs != null ? [r.hs, r.as_] : null,
      pick: r.p_home >= 0.5 ? 'H' : 'A', preseason: false
    }));
  return {
    pending,
    since: rows.length ? rows[rows.length - 1].kickoff : null,
    total: { ...tot, hitRate: pct(tot.hits, tot.n), strongHitRate: pct(tot.strongHits, tot.strongN) },
    bands: winnerBands(rows.map(r => ({ p: Math.max(r.p_home, 1 - r.p_home), hit: hit(r) }))),
    // fix152b: the shared Accuracy page (football's layout)
    calibration: winnerCalibration(rows.map(r => ({ pHome: r.p_home, homeWon: r.hs > r.as_ }))),
    byConfidence: winnerByConfidence(rows.map(r => ({ p: Math.max(r.p_home, 1 - r.p_home), hit: hit(r) }))),
    leagues: [...by.entries()].map(([c, b]) => ({ code: c, ...b, hitRate: pct(b.hits, b.n), strongHitRate: pct(b.strongHits, b.strongN), ...scoreOff(rows.filter(r => code(r.league) === c)) })),
    // fix174: how far the expected margin and the total were off (football's goals numbers, for a points sport)
    scores: scoreOff(rows),
    recent: rows.slice(0, 50).map(r => ({
      gameId: r.game_id, code: code(r.league), kickoff: r.kickoff, home: r.home_name || 'TBD', away: r.away_name || 'TBD', homeLogo: r.home_logo, awayLogo: r.away_logo,
      score: [r.hs, r.as_], pick: r.p_home >= 0.5 ? 'H' : 'A', pHome: r.p_home, hit: hit(r)
    }))
  };
}

export function nflTeamRecord(teamId: number, season: number) {
  const rows = db.prepare(`SELECT p.p_home, g.home_pts AS hs, g.away_pts AS as_ FROM nfl_predictions p JOIN nfl_games g ON g.game_id = p.game_id
    WHERE p.season = ? AND (g.home_id = ? OR g.away_id = ?) AND p.made_at <= p.kickoff AND g.status IN ('FT','AOT') AND g.home_pts IS NOT NULL AND g.home_pts != g.away_pts`).all(season, teamId, teamId) as any[];
  const hit = (r: any) => (r.p_home >= 0.5) === (r.hs > r.as_);
  const strong = rows.filter(r => Math.max(r.p_home, 1 - r.p_home) >= STRONG_OF[leagueOfTeam(teamId)]);
  return { games: rows.length, right: rows.filter(hit).length, strong: strong.length, strongRight: strong.filter(hit).length };
}

/** Team page model tiles (fix139): Elo and its rank, the starting QB and his value, points for / against ratings. */
export function nflTeamModel(teamId: number) {
  const league = leagueOfTeam(teamId);
  // fix159: a team page never runs the first full replay itself (seconds); it starts the yielding one and shows no tiles
  if (!lives.has(league)) { void timed('nfl ratings', () => rebuildLive(league)).catch(e => logger.warn(`${MODEL_OF[league]} replay: ${e.message}`)); return null; }
  const L = current(league);
  if (!L) return null;
  const E = L.engine;
  const season = Math.max(...L.games.filter(g => g.done).map(g => g.season));
  const active = [...E.teams.entries()].filter(([, t]) => t.season === season);
  const me = E.teams.get(teamId);
  if (!me || me.season !== season) return null;
  const rank = active.filter(([, t]) => t.elo > me.elo).length + 1;
  const r1 = (v: number) => Math.round(v * 10) / 10;
  return {
    elo: Math.round(me.elo), rank, teams: active.length,
    qb: me.starter ? { id: me.starter, name: E.qbName(me.starter), value: r1(E.qbValue(me.starter)!) , league: r1(E.qbMean) } : null,
    offense: r1(E.avg + me.o), defense: r1(E.avg + me.d), leaguePoints: r1(E.avg),
    offRank: active.filter(([, t]) => t.o > me.o).length + 1, defRank: active.filter(([, t]) => t.d < me.d).length + 1
  };
}

export const nflModelReport = (league: LeagueId = 1): Report | null => readSync(`${KEY_OF[league]}|report`);

/* ---------- jobs ---------- */

let busy = false;
/** Weekly re-tune (Tuesday, or first run without settings) + save the coming predictions. Called from the NFL scheduler. */
export async function nflModelTick(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    let retrainedNfl = false;
    for (const league of [1, 2] as LeagueId[]) {
      const MODEL = MODEL_OF[league];
      try {
        const stored = readSync(`${KEY_OF[league]}|params`);
        const last = stored?.at ? Date.parse(stored.at) : 0;
        const finished = (db.prepare(`SELECT COUNT(*) AS n FROM nfl_games WHERE league = ? AND status IN ('FT','AOT') AND home_pts IS NOT NULL`).get(league) as any)?.n || 0;
        if (finished >= 200 && (!stored || (new Date().getUTCDay() === 2 && Date.now() - last > 5 * DAY) || Date.now() - last > 8 * DAY)) {
          const rep = await retrain(league);
          if (league === 1) retrainedNfl = true;
          logger.info(`${MODEL}: re-tuned (${rep.live?.seasonsTrained.join(', ')}), test LL ${rep.blend.testLogLossAB}${rep.blend.used ? ` → blend ${rep.blend.testLogLossD}` : ''}`);
        }
      } catch (e: any) { logger.warn(`${MODEL}: ${e.message}`); }
    }
    // fix146: nfl-v2 experiments — once after a deploy (new version), then with every weekly re-tune
    try {
      const fin = (db.prepare(`SELECT COUNT(*) AS n FROM nfl_games WHERE league = 1 AND status IN ('FT','AOT') AND home_pts IS NOT NULL`).get() as any)?.n || 0;
      const ex = exps().nflExperimentReport();
      if (fin >= 200 && (!ex || ex.version !== exps().EXP_VERSION || retrainedNfl)) await exps().runNflExperiments();
      await exps().refreshV2();
    } catch (e: any) { logger.warn(`nfl-exp: ${e.message}`); }
    const n = await saveNflPredictions();
    if (n) logger.info(`NFL / college: ${n} predictions saved`);
  } catch (e: any) {
    logger.warn(`NFL model: ${e.message}`);
  } finally { busy = false; }
}

/* ---------- fix146: internals the nfl-v2 experiments reuse (services/nflExperiments.ts) ---------- */
export type { G as NflG, Pre as NflPre, Ctx as NflCtx, Row as NflRow, Box as NflBox, Passer as NflPasser };
export const modelInternals = { loadGamesAsync, loadCtxAsync, run, tune, metrics, marginFromP, readSync, sync, logLossOf, clip, DEFAULTS, featOf, fitBlend, blendP, fullParams, noteNaN };
