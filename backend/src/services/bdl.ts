/**
 * NBA extra data from balldontlie (GOAT plan, key BALLDONTLIE_KEY in Railway), Oct 2026.
 * What it adds to API-Basketball (which stays the source of games, scores and the model's box scores):
 *   - player bios (position, height, weight, jersey, college, country, draft)
 *   - full box scores (steals, blocks, turnovers, offensive rebounds, fouls, plus-minus)
 *   - advanced stats per player and game (PIE, usage, offensive / defensive / net rating, true shooting)
 *   - season averages with league ranks (traditional and advanced), team season averages, league leaders
 *   - contracts
 * Not used: lineups (only published once a game has started, so no help before tip-off), play-by-play,
 * betting odds and props (never a model input, never shown publicly), fantasy data.
 *
 * Sync: players, season averages, team averages and leaders once a day; finished games every 10 minutes;
 * three past seasons of box scores and advanced stats back-filled once (a few hundred calls in all).
 */
import logger from '../utils/logger';
import { db } from '../db';
import { bdlGet, nbaKey } from './bbInjuries';
import { every, after } from './perf';
import { isCrawlerRequest } from './afUsage';

db.exec(`
  CREATE TABLE IF NOT EXISTS bdl_teams (
    id INTEGER PRIMARY KEY, abbr TEXT, city TEXT, name TEXT, full_name TEXT, conference TEXT, division TEXT, key TEXT
  );
  CREATE TABLE IF NOT EXISTS bdl_players (
    id INTEGER PRIMARY KEY, first TEXT, last TEXT, name_key TEXT, position TEXT, height TEXT, weight TEXT, jersey TEXT,
    college TEXT, country TEXT, draft_year INTEGER, draft_round INTEGER, draft_number INTEGER, team_id INTEGER,
    active INTEGER NOT NULL DEFAULT 0, updated_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_bdl_players_key ON bdl_players(name_key);
  CREATE TABLE IF NOT EXISTS bdl_games (
    id INTEGER PRIMARY KEY, date TEXT NOT NULL, season INTEGER NOT NULL, postseason INTEGER NOT NULL DEFAULT 0, status TEXT,
    home_id INTEGER NOT NULL, away_id INTEGER NOT NULL, hs INTEGER, as_ INTEGER, box INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_bdl_games_date ON bdl_games(date);
  CREATE TABLE IF NOT EXISTS bdl_box (
    game_id INTEGER NOT NULL, player_id INTEGER NOT NULL, team_id INTEGER NOT NULL, min REAL,
    pts INTEGER, fgm INTEGER, fga INTEGER, tpm INTEGER, tpa INTEGER, ftm INTEGER, fta INTEGER, oreb INTEGER, dreb INTEGER, reb INTEGER,
    ast INTEGER, stl INTEGER, blk INTEGER, tov INTEGER, pf INTEGER, pm INTEGER,
    PRIMARY KEY (game_id, player_id)
  );
  CREATE INDEX IF NOT EXISTS idx_bdl_box_player ON bdl_box(player_id);
  CREATE TABLE IF NOT EXISTS bdl_adv (
    game_id INTEGER NOT NULL, player_id INTEGER NOT NULL, team_id INTEGER NOT NULL,
    pie REAL, usg REAL, ortg REAL, drtg REAL, net REAL, ts REAL, efg REAL, ast_pct REAL, reb_pct REAL, pace REAL,
    PRIMARY KEY (game_id, player_id)
  );
  CREATE INDEX IF NOT EXISTS idx_bdl_adv_player ON bdl_adv(player_id);
  CREATE TABLE IF NOT EXISTS bdl_season (
    player_id INTEGER NOT NULL, season INTEGER NOT NULL, kind TEXT NOT NULL, stats TEXT NOT NULL, updated_at TEXT,
    PRIMARY KEY (player_id, season, kind)
  );
  CREATE TABLE IF NOT EXISTS bdl_team_season (
    team_id INTEGER NOT NULL, season INTEGER NOT NULL, kind TEXT NOT NULL, stats TEXT NOT NULL, updated_at TEXT,
    PRIMARY KEY (team_id, season, kind)
  );
  CREATE TABLE IF NOT EXISTS bdl_leaders (
    season INTEGER NOT NULL, stat TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT, PRIMARY KEY (season, stat)
  );
  CREATE TABLE IF NOT EXISTS bdl_contracts (player_id INTEGER PRIMARY KEY, data TEXT, updated_at TEXT);
  CREATE TABLE IF NOT EXISTS bdl_sync (key TEXT PRIMARY KEY, value TEXT);
`);

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
let calls = 0;
let lastError: string | null = null;
/** One call, spaced so we stay far under the plan's 600 a minute. */
async function get(path: string, params: Record<string, string | string[]> = {}): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    await sleep(150);
    calls++;
    try {
      return await bdlGet(path, params);
    } catch (e: any) {
      if (!/429/.test(e.message) || attempt >= 3) throw e;
      await sleep(15000 * (attempt + 1)); // over the minute limit: wait and try again
    }
  }
}
async function getAll(path: string, params: Record<string, string | string[]>, onPage: (rows: any[]) => void, maxPages = 400) {
  let cursor: string | null = null;
  for (let p = 0; p < maxPages; p++) {
    const j: any = await get(path, { ...params, per_page: '100', ...(cursor ? { cursor } : {}) });
    onPage(j.data || []);
    cursor = j.meta?.next_cursor != null ? String(j.meta.next_cursor) : null;
    if (!cursor) return null;
  }
  return cursor; // stopped early: where to continue
}

/** "LeBron James" / "James LeBron" / "Luka Dončić" → the same key. */
export const personKey = (name: string) => String(name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z ]+/g, ' ').split(/\s+/).filter(w => w && !['jr', 'sr', 'ii', 'iii', 'iv'].includes(w)).sort().join(' ');

/** balldontlie season number: the year the season starts (2026 = 2026-27). */
export const bdlSeasonNow = () => { const d = new Date(); return d.getUTCMonth() >= 8 ? d.getUTCFullYear() : d.getUTCFullYear() - 1; };
const minOf = (m: any) => { if (m == null) return 0; const s = String(m); if (s.includes(':')) { const [a, b] = s.split(':'); return (+a || 0) + (+b || 0) / 60; } return +s || 0; };
const kv = (k: string) => (db.prepare(`SELECT value FROM bdl_sync WHERE key = ?`).get(k) as any)?.value ?? null;
const setKv = (k: string, v: string) => db.prepare(`INSERT OR REPLACE INTO bdl_sync (key, value) VALUES (?, ?)`).run(k, v);

/* ---------- writers ---------- */

const upPlayer = db.prepare(`INSERT INTO bdl_players (id, first, last, name_key, position, height, weight, jersey, college, country, draft_year, draft_round, draft_number, team_id, active, updated_at)
  VALUES (@id, @first, @last, @key, @position, @height, @weight, @jersey, @college, @country, @dy, @dr, @dn, @team, @active, @now)
  ON CONFLICT(id) DO UPDATE SET first=@first, last=@last, name_key=@key, position=@position, height=@height, weight=@weight, jersey=@jersey,
    college=@college, country=@country, draft_year=@dy, draft_round=@dr, draft_number=@dn, team_id=COALESCE(@team, team_id),
    active=MAX(active, @active), updated_at=@now`);
function savePlayer(p: any, active: number, teamId?: number | null) {
  if (!p?.id) return;
  upPlayer.run({
    id: p.id, first: p.first_name || '', last: p.last_name || '', key: personKey(`${p.first_name} ${p.last_name}`), position: p.position || null,
    height: p.height || null, weight: p.weight || null, jersey: p.jersey_number || null, college: p.college || null, country: p.country || null,
    dy: p.draft_year ?? null, dr: p.draft_round ?? null, dn: p.draft_number ?? null, team: teamId ?? p.team?.id ?? p.team_id ?? null, active, now: new Date().toISOString()
  });
}
const upGame = db.prepare(`INSERT INTO bdl_games (id, date, season, postseason, status, home_id, away_id, hs, as_) VALUES (@id, @date, @season, @post, @status, @h, @a, @hs, @as)
  ON CONFLICT(id) DO UPDATE SET date=@date, status=@status, hs=@hs, as_=@as`);
function saveGame(g: any) {
  if (!g?.id) return;
  upGame.run({ id: g.id, date: g.datetime || g.date, season: g.season, post: g.postseason ? 1 : 0, status: g.status_state || null, h: g.home_team?.id ?? g.home_team_id, a: g.visitor_team?.id ?? g.visitor_team_id, hs: g.home_team_score ?? null, as: g.visitor_team_score ?? null });
}
const upBox = db.prepare(`INSERT OR REPLACE INTO bdl_box (game_id, player_id, team_id, min, pts, fgm, fga, tpm, tpa, ftm, fta, oreb, dreb, reb, ast, stl, blk, tov, pf, pm)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
function saveBox(rows: any[]) {
  for (const x of rows) {
    if (!x.game?.id || !x.player?.id) continue;
    saveGame(x.game);
    savePlayer(x.player, 0, null);
    upBox.run(x.game.id, x.player.id, x.team?.id ?? 0, minOf(x.min), x.pts, x.fgm, x.fga, x.fg3m, x.fg3a, x.ftm, x.fta, x.oreb, x.dreb, x.reb, x.ast, x.stl, x.blk, x.turnover, x.pf, x.plus_minus);
  }
}
const upAdv = db.prepare(`INSERT OR REPLACE INTO bdl_adv (game_id, player_id, team_id, pie, usg, ortg, drtg, net, ts, efg, ast_pct, reb_pct, pace) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
function saveAdv(rows: any[]) {
  for (const x of rows) {
    if (!x.game?.id || !x.player?.id) continue;
    upAdv.run(x.game.id, x.player.id, x.team?.id ?? 0, x.pie, x.usage_percentage, x.offensive_rating, x.defensive_rating, x.net_rating, x.true_shooting_percentage, x.effective_field_goal_percentage, x.assist_percentage, x.rebound_percentage, x.pace);
  }
}
const tx = <T>(fn: () => T): T => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };

/* ---------- jobs ---------- */

async function syncTeams() {
  const j = await get('/v1/teams');
  const up = db.prepare(`INSERT OR REPLACE INTO bdl_teams (id, abbr, city, name, full_name, conference, division, key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  tx(() => { for (const t of j.data || []) if (t.id <= 30 || t.conference) up.run(t.id, t.abbreviation, t.city, t.name, t.full_name, t.conference, t.division, nbaKey(t.full_name || t.name)); });
}

async function syncPlayers() {
  const rows: any[] = [];
  await getAll('/v1/players/active', {}, r => rows.push(...r));
  tx(() => {
    db.exec(`UPDATE bdl_players SET active = 0`);
    for (const p of rows) savePlayer(p, 1, p.team?.id ?? null);
  });
  return rows.length;
}

/** Season averages of every player (traditional and advanced, with league ranks). */
async function syncSeasonAverages(season: number) {
  const up = db.prepare(`INSERT OR REPLACE INTO bdl_season (player_id, season, kind, stats, updated_at) VALUES (?, ?, ?, ?, ?)`);
  let n = 0;
  for (const kind of ['base', 'advanced']) {
    const rows: any[] = [];
    await getAll('/v1/season_averages/general', { season: String(season), season_type: 'regular', type: kind }, r => rows.push(...r), 30);
    const now = new Date().toISOString();
    tx(() => { for (const x of rows) if (x.player?.id && x.stats) { savePlayer(x.player, 0, null); up.run(x.player.id, season, kind, JSON.stringify(x.stats), now); n++; } });
  }
  return n;
}

async function syncTeamAverages(season: number) {
  const up = db.prepare(`INSERT OR REPLACE INTO bdl_team_season (team_id, season, kind, stats, updated_at) VALUES (?, ?, ?, ?, ?)`);
  for (const kind of ['base', 'advanced']) {
    const rows: any[] = [];
    await getAll('/nba/v1/team_season_averages/general', { season: String(season), season_type: 'regular', type: kind }, r => rows.push(...r), 5);
    const now = new Date().toISOString();
    tx(() => { for (const x of rows) if (x.team?.id && x.stats) up.run(x.team.id, season, kind, JSON.stringify(x.stats), now); });
  }
}

export const LEADER_STATS = ['pts', 'reb', 'ast', 'stl', 'blk'];
async function syncLeaders(season: number) {
  const up = db.prepare(`INSERT OR REPLACE INTO bdl_leaders (season, stat, data, updated_at) VALUES (?, ?, ?, ?)`);
  for (const stat of LEADER_STATS) {
    try {
      const j = await get('/v1/leaders', { season: String(season), stat_type: stat });
      const list = (j.data || []).slice(0, 25).map((x: any) => ({ playerId: x.player?.id, name: `${x.player?.first_name} ${x.player?.last_name}`, teamId: x.player?.team_id ?? null, value: x.value, games: x.games_played, rank: x.rank }));
      if (list.length) up.run(season, stat, JSON.stringify(list), new Date().toISOString());
    } catch (e: any) { logger.warn(`balldontlie leaders ${stat}: ${e.message}`); }
  }
}

/** Box scores and advanced stats of finished games that don't have them yet (recent days). */
async function syncRecentGames() {
  const day = (d: number) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
  const games: any[] = [];
  await getAll('/v1/games', { 'dates[]': [day(-3), day(-2), day(-1), day(0), day(1), day(2)] }, r => games.push(...r), 5);
  tx(() => { for (const g of games) saveGame(g); });
  const todo = db.prepare(`SELECT id FROM bdl_games WHERE status = 'final' AND box = 0 AND date >= ? ORDER BY date LIMIT 30`).all(day(-10)) as any[];
  for (let i = 0; i < todo.length; i += 10) {
    const ids = todo.slice(i, i + 10).map(x => String(x.id));
    const box: any[] = [], adv: any[] = [];
    await getAll('/v1/stats', { 'game_ids[]': ids }, r => box.push(...r), 10);
    await getAll('/nba/v1/stats/advanced', { 'game_ids[]': ids }, r => adv.push(...r), 10);
    tx(() => {
      saveBox(box); saveAdv(adv);
      const has = new Set(box.map(x => x.game?.id));
      for (const id of ids) if (has.has(+id)) db.prepare(`UPDATE bdl_games SET box = 1 WHERE id = ?`).run(+id);
    });
  }
  return todo.length;
}

/** Past seasons for player pages and the model: box scores and advanced stats, a chunk per run until done. */
async function backfill(budgetPages = 120) {
  const now = bdlSeasonNow();
  for (const season of [now - 3, now - 2, now - 1, now]) {
    for (const [what, path] of [['stats', '/v1/stats'], ['adv', '/nba/v1/stats/advanced']] as const) {
      const k = `bf:${what}:${season}`;
      const state = kv(k);
      if (state === 'done' && season < now) continue;
      if (season === now && state === 'done') continue; // the running season is kept current by syncRecentGames
      let cursor: string | null = state && state !== 'done' ? state : null;
      while (budgetPages > 0) {
        const j: any = await get(path, { 'seasons[]': String(season), per_page: '100', ...(cursor ? { cursor } : {}) });
        tx(() => (what === 'stats' ? saveBox(j.data || []) : saveAdv(j.data || [])));
        budgetPages--;
        cursor = j.meta?.next_cursor != null ? String(j.meta.next_cursor) : null;
        setKv(k, cursor || 'done');
        if (!cursor) break;
      }
      if (budgetPages <= 0) return false;
    }
  }
  db.exec(`UPDATE bdl_games SET box = 1 WHERE box = 0 AND id IN (SELECT DISTINCT game_id FROM bdl_box)`);
  return true;
}

let running = false;
let lastDaily = 0;
export async function bdlTick() {
  if (running || !process.env.BALLDONTLIE_KEY) return;
  running = true;
  try {
    const season = bdlSeasonNow();
    if (Date.now() - lastDaily > 20 * 3600 * 1000 || !(db.prepare(`SELECT COUNT(*) AS n FROM bdl_teams`).get() as any).n) {
      await syncTeams();
      const n = await syncPlayers();
      let s = 0;
      for (const y of [season, season - 1]) { s += await syncSeasonAverages(y); await syncTeamAverages(y); await syncLeaders(y); }
      lastDaily = Date.now();
      logger.info(`balldontlie: ${n} active players, ${s} season lines`);
    }
    await syncRecentGames();
    await backfill();
    lastError = null;
  } catch (e: any) {
    lastError = e.message;
    logger.warn(`balldontlie: ${e.message}`);
  } finally {
    running = false;
  }
}

let started = false;
export function startBdlScheduler() {
  if (started) return;
  started = true;
  after('bdl', () => bdlTick(), 60 * 1000).unref();
  every('bdl', () => void bdlTick(), 10 * 60 * 1000).unref();
}

export function bdlStatus() {
  const c = (sql: string) => (db.prepare(sql).get() as any).n;
  return {
    keySet: !!process.env.BALLDONTLIE_KEY, running, calls, lastError, lastDaily: lastDaily ? new Date(lastDaily).toISOString() : null,
    players: c(`SELECT COUNT(*) AS n FROM bdl_players`), activePlayers: c(`SELECT COUNT(*) AS n FROM bdl_players WHERE active = 1`),
    games: c(`SELECT COUNT(*) AS n FROM bdl_games`), box: c(`SELECT COUNT(*) AS n FROM bdl_box`), adv: c(`SELECT COUNT(*) AS n FROM bdl_adv`),
    seasonLines: c(`SELECT COUNT(*) AS n FROM bdl_season`), backfill: db.prepare(`SELECT key, value FROM bdl_sync WHERE key LIKE 'bf:%' ORDER BY key`).all()
  };
}

/* ---------- linking to our (API-Basketball) teams and players ---------- */

/** balldontlie team id of one of our NBA teams (by nickname). */
export function bdlTeamOf(teamName: string): number | null {
  const r = db.prepare(`SELECT id FROM bdl_teams WHERE key = ?`).get(nbaKey(teamName)) as any;
  return r?.id ?? null;
}

/** The balldontlie player behind one of our player ids (same name; same team when several share it). */
export function bdlPlayerOf(name: string, teamName?: string | null): any | null {
  const rows = db.prepare(`SELECT * FROM bdl_players WHERE name_key = ? ORDER BY active DESC, updated_at DESC`).all(personKey(name)) as any[];
  if (!rows.length) return null;
  if (rows.length > 1 && teamName) {
    const t = bdlTeamOf(teamName);
    const same = rows.find(r => r.team_id === t);
    if (same) return same;
  }
  return rows[0];
}

/** Contract details (tried once a week per player; the endpoint is optional). */
export async function bdlContract(playerId: number) {
  const row = db.prepare(`SELECT data, updated_at FROM bdl_contracts WHERE player_id = ?`).get(playerId) as any;
  if (row && Date.now() - Date.parse(row.updated_at) < 7 * 86400000) return row.data ? JSON.parse(row.data) : null;
  // fix166: crawlers get what is stored, at any age (no provider call, and no empty answer stored for a week)
  if (isCrawlerRequest()) return row?.data ? JSON.parse(row.data) : null;
  let data: any = null;
  for (const path of ['/v1/contracts/players', '/nba/v1/contracts/players']) {
    try {
      const j = await bdlGet(path, { player_id: String(playerId) });
      data = (j.data || []).map((c: any) => ({ season: c.season ?? null, team: c.team?.full_name ?? null, amount: c.cap_hit ?? c.base_salary ?? c.salary ?? c.amount ?? null, type: c.contract_type ?? c.type ?? null, status: c.contract_status ?? c.status ?? null, raw: c }));
      break;
    } catch { /* try the next path */ }
  }
  db.prepare(`INSERT OR REPLACE INTO bdl_contracts (player_id, data, updated_at) VALUES (?, ?, ?)`).run(playerId, data ? JSON.stringify(data) : null, new Date().toISOString());
  return data;
}
