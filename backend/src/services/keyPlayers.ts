/**
 * fix224 — key players (basketball, every league). The maths is in utils/keyPlayers.ts; this file runs it on our data:
 *
 *  - Key players card (game page): each team's top 5 by impact × expected minutes from the bb-v4 grid snapshot (ratings,
 *    projected minutes, the last 10 games: services/bbGrid.ts), with photo, impact in points per game, status (NBA
 *    injury report, news "reported out", star-rest pattern, rested / missed the last games) and "team without him" in
 *    the model's points. A missing player who moves the margin 1.5+ points gets a line in "Why we think so".
 *  - Star rest patterns (worker, daily → bb_rest_rates): NBA second nights of back-to-backs and 3-in-4s (this and last
 *    season), EuroLeague clubs' domestic games in double weeks. A game that fits a pattern lowers the player's expected
 *    minutes by his rate (NBA: until the injury report or the line-up confirms). Row #4 uses it (NBA: nbaV4.sideOf,
 *    other leagues: the bbGrid keep hook); every application is logged per game (bb_rest_log).
 *  - Injuries from news (worker, every 30 min → bb_news_injuries): basketball stories naming a club, scanned for
 *    "out / injured / weeks" sentences about its players (every league but the NBA, which has its injury report). A
 *    "reported out" status with the story's link, until the stated time or until he plays. Admin review list; a
 *    dismissed item is never applied again.
 *  - Player page "Impact": rating, rank in his league, his team's record with and without him this season.
 */
import logger from '../utils/logger';
import { db } from '../db';
import { yieldLoop, every, after, everyHeavy, afterHeavy } from './perf';
import { gridSnap, setKeepHook, bumpGridVer, gameMinOf, teamPlayers, plRating } from './bbGrid';
import { gridLive, gridWeight, impactLive, topFactor } from './bbTuner';
import { nbaKey, playerKey, nbaInjuryStatus } from './bbInjuries';
import { bbTeamNames } from './news';
import { photoUrl } from './playerPhotos';
import { statusKeep, V4_TUNED } from '../utils/nbaImpact';
import {
  keyList, nbaRestCounts, elRestCounts, restKeep, nbaSpot, weekOf, scanStory, normText,
  type RestKind, type TeamGame, type KpIn, type RestCount
} from '../utils/keyPlayers';
import type { Check } from './dataHealth';

const DAY = 86400000;
db.exec(`
  CREATE TABLE IF NOT EXISTS bb_rest_rates (
    player_id INTEGER NOT NULL, team_id INTEGER NOT NULL, kind TEXT NOT NULL, sat INTEGER NOT NULL, chances INTEGER NOT NULL,
    keep REAL NOT NULL, at TEXT NOT NULL, PRIMARY KEY (player_id, team_id, kind)
  );
  CREATE TABLE IF NOT EXISTS bb_rest_log (
    game_id INTEGER NOT NULL, team_id INTEGER NOT NULL, player_id INTEGER NOT NULL, kind TEXT NOT NULL, keep REAL NOT NULL,
    kickoff TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (game_id, player_id, kind)
  );
  CREATE INDEX IF NOT EXISTS idx_bb_rest_log_kickoff ON bb_rest_log(kickoff);
  CREATE TABLE IF NOT EXISTS bb_news_injuries (
    id INTEGER PRIMARY KEY AUTOINCREMENT, player_id INTEGER NOT NULL, team_id INTEGER NOT NULL, code TEXT NOT NULL,
    name TEXT NOT NULL, status TEXT NOT NULL, injury TEXT, days INTEGER NOT NULL, sentence TEXT NOT NULL, link TEXT NOT NULL,
    source TEXT, published TEXT NOT NULL, until TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active', reviewed INTEGER NOT NULL DEFAULT 0,
    at TEXT NOT NULL, UNIQUE (player_id, link)
  );
  CREATE TABLE IF NOT EXISTS bb_kp_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`);

/* ---------- in-memory state (every process that predicts reads the tables, reloaded every 5 min or after a job) ---------- */

type Rate = RestCount & { keep: number };
type News = { id: number; status: 'out' | 'doubtful'; injury: string | null; until: string; link: string; source: string | null; sentence: string };
let rates = new Map<string, Partial<Record<RestKind, Rate>>>(); // `${team}|${player}`
let news = new Map<string, News>(); // `${team}|${player}` (active only)
let loadedAt = 0;
function ensure(force = false) {
  if (!force && Date.now() - loadedAt < 5 * 60 * 1000) return;
  loadedAt = Date.now();
  const r = new Map<string, Partial<Record<RestKind, Rate>>>();
  for (const x of db.prepare(`SELECT * FROM bb_rest_rates WHERE keep < 1`).all() as any[]) {
    const k = `${x.team_id}|${x.player_id}`; let e = r.get(k); if (!e) r.set(k, (e = {}));
    e[x.kind as RestKind] = { sat: x.sat, chances: x.chances, keep: x.keep };
  }
  const n = new Map<string, News>();
  for (const x of db.prepare(`SELECT * FROM bb_news_injuries WHERE state = 'active' AND until > ?`).all(new Date().toISOString()) as any[]) {
    const k = `${x.team_id}|${x.player_id}`, cur = n.get(k);
    if (!cur || x.until > cur.until) n.set(k, { id: x.id, status: x.status, injury: x.injury, until: x.until, link: x.link, source: x.source, sentence: x.sentence });
  }
  const changed = JSON.stringify([...r]) !== JSON.stringify([...rates]) || JSON.stringify([...n]) !== JSON.stringify([...news]);
  rates = r; news = n;
  if (changed) { restCache.clear(); bumpGridVer(); }
}

/* ---------- star rest: which pattern a game fits ---------- */

const restCache = new Map<string, { at: number; v: Map<number, { kind: RestKind } & Rate> }>();
let prevStmt: any = null, elStmt: any = null, koStmt: any = null;
/** Players of a team whose rest pattern this game fits, with the share of minutes they keep. */
export function restFor(g: { code: string; game_id?: number; kickoff: string }, teamId: number): Map<number, { kind: RestKind } & Rate> {
  ensure();
  const key = `${g.game_id ?? g.kickoff}|${teamId}`;
  const hit = restCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.v;
  const out = new Map<number, { kind: RestKind } & Rate>();
  const ko = Date.parse(g.kickoff);
  let kind: RestKind | null = null;
  if (g.code === 'NBA') {
    prevStmt ||= db.prepare(`SELECT kickoff FROM bb_games WHERE (home_id = ? OR away_id = ?) AND kickoff < ? ORDER BY kickoff DESC LIMIT 2`);
    kind = nbaSpot(ko, (prevStmt.all(teamId, teamId, g.kickoff) as any[]).map(r => Date.parse(r.kickoff)));
  } else if (g.code !== 'EL') {
    const w = weekOf(ko), from = new Date((w * 7 - 3) * DAY).toISOString(), to = new Date((w * 7 + 4) * DAY).toISOString();
    elStmt ||= db.prepare(`SELECT COUNT(*) AS n FROM bb_games WHERE code = 'EL' AND (home_id = ? OR away_id = ?) AND kickoff >= ? AND kickoff < ? AND (status IS NULL OR status NOT IN ('CANC','POST','ABD'))`);
    if ((elStmt.get(teamId, teamId, from, to) as any).n >= 2) kind = 'el-double';
  }
  if (kind) for (const [k, e] of rates) {
    if (!k.startsWith(`${teamId}|`)) continue;
    const r = e[kind];
    if (r && r.keep < 1) out.set(Number(k.slice(k.indexOf('|') + 1)), { kind, ...r });
  }
  restCache.set(key, { at: Date.now(), v: out });
  if (restCache.size > 3000) restCache.delete(restCache.keys().next().value as string);
  return out;
}

/** NBA: the injury report (fetched in the last 20 min) and tip-off within the hour = rests are reported: the pattern stops. */
export function restConfirmed(kickoff: string, now = Date.now()): boolean {
  const inj = nbaInjuryStatus();
  return now >= Date.parse(kickoff) - 60 * 60000 && !!inj.lastFetch && now - Date.parse(inj.lastFetch) < 20 * 60000;
}

/** News "reported out" items of a team (active). */
export function newsFor(teamId: number): Map<number, News> {
  ensure();
  const out = new Map<number, News>();
  for (const [k, v] of news) if (k.startsWith(`${teamId}|`)) out.set(Number(k.slice(k.indexOf('|') + 1)), v);
  return out;
}

/** BB_REST=off: the rest patterns and news statuses stay on the card but leave the model's row #4 alone */
const inModel = () => String(process.env.BB_REST || '').toLowerCase() !== 'off';

/** NBA keep shares from the rest patterns (nbaV4.sideOf): only players not on the report, before it confirms. */
export function nbaRestKeep(gameId: number, teamId: number, kickoff: string | null): Map<number, { keep: number; kind: RestKind }> {
  const out = new Map<number, { keep: number; kind: RestKind }>();
  if (!kickoff || !inModel() || restConfirmed(kickoff)) return out;
  for (const [id, r] of restFor({ code: 'NBA', game_id: gameId, kickoff }, teamId)) out.set(id, { keep: r.keep, kind: r.kind });
  return out;
}

// row #4 outside the NBA: news statuses + double-week rest
setKeepHook((g, teamId) => {
  if (g.code === 'NBA' || !inModel()) return null;
  const out = new Map<number, number>();
  for (const [id, n] of newsFor(teamId)) out.set(id, n.status === 'out' ? 0 : 0.25);
  for (const [id, r] of restFor(g, teamId)) out.set(id, Math.min(out.get(id) ?? 1, r.keep));
  return out.size ? out : null;
});

/* ---------- worker: rest rates (daily) ---------- */

const lastSeasons = (code: string, n = 2) => (db.prepare(`SELECT season, MAX(kickoff) AS k FROM bb_games WHERE code = ? AND status IN ('FT','AOT') GROUP BY season ORDER BY k DESC LIMIT ?`).all(code, n) as any[]).map(r => String(r.season));
const isPreNba = (iso: string) => { const d = new Date(iso); return d.getUTCMonth() === 9 && d.getUTCDate() < 19; };

/** Team games with their box-score minutes (only games with a box score for that team). */
function teamGames(where: string, args: any[]): Map<number, TeamGame[]> {
  const games = db.prepare(`SELECT game_id, kickoff, code, home_id, away_id FROM bb_games WHERE status IN ('FT','AOT') AND ${where} ORDER BY kickoff`).all(...args) as any[];
  const byId = new Map<number, any>(games.map(g => [g.game_id, g]));
  const mins = new Map<string, Map<number, number>>();
  for (let i = 0; i < games.length; i += 500) {
    const ids = games.slice(i, i + 500).map(g => g.game_id);
    for (const r of db.prepare(`SELECT game_id, team_id, player_id, minutes FROM bb_player_stats WHERE game_id IN (${ids.map(() => '?').join(',')}) AND minutes > 0`).all(...ids) as any[]) {
      const k = `${r.game_id}|${r.team_id}`; let m = mins.get(k); if (!m) mins.set(k, (m = new Map())); m.set(r.player_id, r.minutes);
    }
  }
  const out = new Map<number, TeamGame[]>();
  for (const [k, m] of mins) {
    const [gid, tid] = k.split('|').map(Number), g = byId.get(gid);
    if (!g || (g.home_id !== tid && g.away_id !== tid)) continue;
    let l = out.get(tid); if (!l) out.set(tid, (l = [])); l.push({ id: gid, ms: Date.parse(g.kickoff), code: g.code, min: m });
  }
  for (const l of out.values()) l.sort((a, b) => a.ms - b.ms);
  return out;
}

/** NBA back-to-back / 3-in-4 rates and EuroLeague double-week rates, this and last season (bb_rest_rates). */
export async function buildRestRates(): Promise<{ nba: number; el: number }> {
  const t0 = Date.now();
  const rows: [number, number, RestKind, number, number, number][] = [];
  const ns = lastSeasons('NBA');
  if (ns.length) {
    const tg = teamGames(`code = 'NBA' AND season IN (${ns.map(() => '?').join(',')})`, ns);
    for (const [team, list] of tg) {
      const regular = list.filter(g => !isPreNba(new Date(g.ms).toISOString()));
      for (const [pid, by] of nbaRestCounts(regular)) for (const kind of ['b2b', '3in4'] as RestKind[]) { const c = by[kind]; if (c) rows.push([pid, team, kind, c.sat, c.chances, restKeep(kind, c)]); }
    }
    await yieldLoop();
  }
  let el = 0;
  const es = lastSeasons('EL');
  if (es.length) {
    const first = db.prepare(`SELECT MIN(kickoff) AS k FROM bb_games WHERE code = 'EL' AND season IN (${es.map(() => '?').join(',')})`).get(...es) as any;
    const clubs = (db.prepare(`SELECT DISTINCT home_id AS id FROM bb_games WHERE code = 'EL' AND season IN (${es.map(() => '?').join(',')})`).all(...es) as any[]).map(r => r.id as number);
    if (first?.k && clubs.length) {
      const tg = teamGames(`kickoff >= ? AND (home_id IN (${clubs.map(() => '?').join(',')}) OR away_id IN (${clubs.map(() => '?').join(',')}))`, [first.k, ...clubs, ...clubs]);
      for (const club of clubs) {
        for (const [pid, by] of elRestCounts(tg.get(club) || [])) { const c = by['el-double']; if (c) { rows.push([pid, club, 'el-double', c.sat, c.chances, restKeep('el-double', c)]); el++; } }
      }
    }
  }
  const at = new Date().toISOString();
  const up = db.prepare(`INSERT OR REPLACE INTO bb_rest_rates (player_id, team_id, kind, sat, chances, keep, at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  db.exec('BEGIN');
  try { db.exec(`DELETE FROM bb_rest_rates`); for (const r of rows) up.run(...r, at); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  ensure(true);
  const used = rows.filter(r => r[5] < 1).length;
  logger.info(`bb rest patterns: ${rows.length} player rates (${used} used: ${rows.filter(r => r[5] < 1 && r[2] !== 'el-double').length} NBA, ${rows.filter(r => r[5] < 1 && r[2] === 'el-double').length} EuroLeague clubs), ${Date.now() - t0} ms`);
  return { nba: rows.length - el, el };
}

/* ---------- worker: injuries from news (every 30 min) ---------- */

/** Teams outside the NBA that played in the last 400 days, with their name and roster (players of the last 10 games). */
function newsTeams(): { id: number; code: string; name: string; names: string[]; roster: { id: number; name: string }[] }[] {
  const since = new Date(Date.now() - 400 * DAY).toISOString();
  // a EuroLeague club goes by its domestic league (its latest one), the EuroLeague only when we have no other
  const teams = new Map<number, { code: string; name: string; k: string }>();
  for (const r of db.prepare(`SELECT code, home_id AS id, home_name AS name, kickoff AS k FROM bb_games WHERE code != 'NBA' AND kickoff > ? AND status IN ('FT','AOT')
    UNION ALL SELECT code, away_id, away_name, kickoff FROM bb_games WHERE code != 'NBA' AND kickoff > ? AND status IN ('FT','AOT') ORDER BY k`).all(since, since) as any[]) {
    const cur = teams.get(r.id);
    if (!cur || cur.code === 'EL' || r.code !== 'EL') teams.set(r.id, { code: r.code, name: r.name, k: r.k });
  }
  const nameStmt = db.prepare(`SELECT name FROM bb_player_stats WHERE player_id = ? AND name IS NOT NULL ORDER BY game_id DESC LIMIT 1`);
  const out: ReturnType<typeof newsTeams> = [];
  for (const [id, t] of teams) {
    const snap = gridSnap(t.code)?.teams.get(id) || gridSnap('EL')?.teams.get(id);
    const roster = (snap?.pl || []).map(p => ({ id: p[0], name: String((nameStmt.get(p[0]) as any)?.name || '') })).filter(p => p.name);
    if (roster.length) out.push({ id, code: t.code, name: t.name, names: bbTeamNames(t.name, t.code), roster });
  }
  return out;
}

const meta = (k: string) => (db.prepare(`SELECT v FROM bb_kp_meta WHERE k = ?`).get(k) as any)?.v ?? null;
const setMeta = (k: string, v: string) => db.prepare(`INSERT OR REPLACE INTO bb_kp_meta (k, v) VALUES (?, ?)`).run(k, v);

/** Scan the basketball stories seen since the last scan (21 days the first time); expire items. */
export async function scanNewsInjuries(now = Date.now()): Promise<{ stories: number; found: number; expired: number }> {
  const since = meta('news-scan') || new Date(now - 21 * DAY).toISOString();
  const stories = db.prepare(`SELECT link, title, summary, source, COALESCE(published, seen_at) AS published, seen_at FROM news_items WHERE sport = 'basketball' AND seen_at > ? AND COALESCE(published, seen_at) > ? ORDER BY seen_at`)
    .all(since, new Date(now - 21 * DAY).toISOString()) as any[];
  let found = 0, last = since;
  if (stories.length) {
    const teams = newsTeams().map(t => ({ ...t, re: new RegExp(`(?<![a-z0-9])(?:${t.names.map(n => normText(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![a-z0-9])`) }));
    const ins = db.prepare(`INSERT OR IGNORE INTO bb_news_injuries (player_id, team_id, code, name, status, injury, days, sentence, link, source, published, until, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    let i = 0;
    for (const s of stories) {
      if (++i % 50 === 0) await yieldLoop();
      last = s.seen_at > last ? s.seen_at : last;
      const text = normText(`${s.title} . ${s.summary || ''}`);
      if (!/injur|out|miss|sidelin|surgery|doubt/.test(text)) continue;
      for (const t of teams) {
        if (!t.re.test(text)) continue;
        for (const hit of scanStory(s.title, s.summary || '', t.roster, t.names)) {
          const p = t.roster.find(r => r.id === hit.playerId)!;
          const pub = new Date(Date.parse(s.published) || now).toISOString();
          const until = new Date(Date.parse(pub) + hit.inj.days * DAY).toISOString();
          if (until <= new Date(now).toISOString()) continue;
          const r = ins.run(hit.playerId, t.id, t.code, p.name, hit.inj.status, hit.inj.injury, hit.inj.days, hit.sentence, s.link, s.source || null, pub, until, new Date(now).toISOString());
          if (r.changes) found++;
        }
      }
    }
    setMeta('news-scan', last);
  }
  // expiry: the stated time is over, or he has played since the story (12 h later)
  const nowIso = new Date(now).toISOString();
  let expired = Number(db.prepare(`UPDATE bb_news_injuries SET state = 'expired' WHERE state = 'active' AND until <= ?`).run(nowIso).changes);
  for (const x of db.prepare(`SELECT id, player_id, published FROM bb_news_injuries WHERE state = 'active'`).all() as any[]) {
    const played = db.prepare(`SELECT 1 FROM bb_player_stats ps JOIN bb_games g ON g.game_id = ps.game_id WHERE ps.player_id = ? AND ps.minutes > 0 AND g.kickoff > ? LIMIT 1`)
      .get(x.player_id, new Date(Date.parse(x.published) + 12 * 3600 * 1000).toISOString());
    if (played) { db.prepare(`UPDATE bb_news_injuries SET state = 'played' WHERE id = ?`).run(x.id); expired++; }
  }
  if (found || expired) ensure(true);
  if (found) logger.info(`bb news injuries: ${found} new "reported out" item(s) from ${stories.length} stories (admin review list)`);
  return { stories: stories.length, found, expired };
}

/** Admin review list: active items first (unreviewed on top), then the last 30 days of the others. */
export function newsInjuryList() {
  const rows = db.prepare(`SELECT * FROM bb_news_injuries WHERE state = 'active' OR at > ? ORDER BY state = 'active' DESC, reviewed, at DESC LIMIT 300`).all(new Date(Date.now() - 30 * DAY).toISOString()) as any[];
  const team = db.prepare(`SELECT home_name AS n FROM bb_games WHERE home_id = ? ORDER BY kickoff DESC LIMIT 1`);
  return rows.map(r => ({ id: r.id, playerId: r.player_id, name: r.name, teamId: r.team_id, team: (team.get(r.team_id) as any)?.n || null, code: r.code, status: r.status, injury: r.injury, days: r.days, sentence: r.sentence, link: r.link, source: r.source, published: r.published, until: r.until, state: r.state, reviewed: !!r.reviewed }));
}
/** dismiss = a false positive, never applied again (the row stays, so the same story never brings it back); ok = reviewed */
export function reviewNewsInjury(id: number, action: 'dismiss' | 'ok'): boolean {
  const r = action === 'dismiss'
    ? db.prepare(`UPDATE bb_news_injuries SET state = 'dismissed', reviewed = 1 WHERE id = ?`).run(id)
    : db.prepare(`UPDATE bb_news_injuries SET reviewed = 1 WHERE id = ?`).run(id);
  ensure(true);
  return Number(r.changes) > 0;
}

/* ---------- worker: what was applied to each game (every 30 min, games of the next 36 h) ---------- */

export function logApplied(now = Date.now()): number {
  const games = db.prepare(`SELECT game_id, code, kickoff, home_id, away_id FROM bb_games WHERE (status IS NULL OR status = 'NS') AND kickoff > ? AND kickoff < ?`)
    .all(new Date(now).toISOString(), new Date(now + 36 * 3600 * 1000).toISOString()) as any[];
  const up = db.prepare(`INSERT OR REPLACE INTO bb_rest_log (game_id, team_id, player_id, kind, keep, kickoff, at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const at = new Date(now).toISOString();
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const g of games) for (const team of [g.home_id, g.away_id]) {
      const confirmed = g.code === 'NBA' && restConfirmed(g.kickoff, now);
      if (!confirmed) for (const [pid, r] of restFor(g, team)) { up.run(g.game_id, team, pid, r.kind, r.keep, g.kickoff, at); n++; }
      if (g.code !== 'NBA') for (const [pid, x] of newsFor(team)) { up.run(g.game_id, team, pid, 'news', x.status === 'out' ? 0 : 0.25, g.kickoff, at); n++; }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return n;
}

/* ---------- game page: the key players card ---------- */

export type KeyStatus = 'playing' | 'questionable' | 'doubtful' | 'out' | 'reported-out' | 'may-rest' | 'rested' | 'missed';
export type KeyCard = {
  id: number; name: string; photo: string | null; perGame: number; minutes: number; status: KeyStatus;
  /** injury part ("knee"), rest pattern ("4 of 6 back-to-backs"), games missed */
  note: string | null; noteKind: 'injury' | 'b2b' | '3in4' | 'el-double' | 'games' | null; link: string | null;
  without: number; cost: number;
};
export type KeySide = { teamId: number; team: string; players: KeyCard[] };
export type KeyReason = { side: 'H' | 'A'; team: string; id: number; name: string; status: KeyStatus; note: string | null; points: number };

/** Points of margin per point of player-impact strength in this league (the model's own weight for row #4). */
export function pointScale(code: string): number {
  if (gridLive(code)) return Math.round(gridWeight(code, 3) * 100) / 100 || 1;
  return code === 'NBA' ? V4_TUNED.wSame : 1;
}

const namesOf = (ids: number[]) => {
  const out = new Map<number, string>();
  for (let i = 0; i < ids.length; i += 200) {
    const part = ids.slice(i, i + 200);
    for (const r of db.prepare(`SELECT player_id, name FROM bb_player_stats WHERE player_id IN (${part.map(() => '?').join(',')}) AND name IS NOT NULL GROUP BY player_id`).all(...part) as any[]) out.set(r.player_id, r.name);
  }
  return out;
};
const partOf = (comment: string | null) => { const m = String(comment || '').match(/\(([A-Za-z ]{3,24})\)/); return m ? m[1].trim().toLowerCase() : null; };

function sideCard(g: { game_id: number; code: string; kickoff: string }, teamId: number, teamName: string): { side: KeySide; keep: Map<number, number> } | null {
  const snap = gridSnap(g.code);
  const t = snap?.teams.get(teamId);
  if (!snap || !t?.pl || !t.pl.length) return null;
  const L = snap.gameMin || gameMinOf(g.code);
  // fix225: the ratings live (box-score value blended with on/off once its gate passed) and the star factor's top 3
  const tp = teamPlayers(g.code, teamId, impactLive()) || [];
  const players: KpIn[] = tp.map(p => ({ id: p.id, rating: p.rating, proj: p.proj }));
  const tops = { ids: new Set(tp.filter(p => p.top).map(p => p.id)), factor: impactLive() ? topFactor(g.code) : 1 };
  const since = new Map(t.pl.map(p => [p[0], p[3]]));
  const names = namesOf(t.pl.map(p => p[0]));
  const keep = new Map<number, number>(), st = new Map<number, Pick<KeyCard, 'status' | 'note' | 'noteKind' | 'link'>>();
  // missed the last games (the model's row #4 rule: in the last 3, not in the last 2)
  for (const [id, n] of since) {
    if (n >= 2) { keep.set(id, 0); st.set(id, { status: 'missed', note: String(n), noteKind: 'games', link: null }); }
    else if (n === 1) st.set(id, { status: 'rested', note: null, noteKind: null, link: null });
  }
  if (g.code === 'NBA') {
    const byKey = new Map<string, number>();
    for (const [id, n] of names) byKey.set(playerKey(n), id);
    for (const x of db.prepare(`SELECT player, status, comment FROM bb_injuries WHERE team = ?`).all(nbaKey(teamName)) as any[]) {
      const id = byKey.get(playerKey(x.player));
      if (id === undefined) continue;
      const k = statusKeep(x.status);
      if (k >= 1) { keep.delete(id); st.delete(id); continue; } // on the report as available
      keep.set(id, k);
      st.set(id, { status: k === 0 ? 'out' : k <= 0.25 ? 'doubtful' : 'questionable', note: partOf(x.comment), noteKind: 'injury', link: null });
    }
  } else {
    for (const [id, n] of newsFor(teamId)) {
      keep.set(id, Math.min(keep.get(id) ?? 1, n.status === 'out' ? 0 : 0.25));
      st.set(id, { status: n.status === 'out' ? 'reported-out' : 'doubtful', note: n.injury, noteKind: n.injury ? 'injury' : null, link: n.link });
    }
  }
  const confirmed = g.code === 'NBA' && restConfirmed(g.kickoff);
  if (!confirmed) for (const [id, r] of restFor(g, teamId)) {
    if (st.has(id) && st.get(id)!.status !== 'rested') continue; // the report / news / missed games decide
    keep.set(id, Math.min(keep.get(id) ?? 1, r.keep));
    st.set(id, { status: 'may-rest', note: `${r.sat}/${r.chances}`, noteKind: r.kind, link: null });
  }
  const list = keyList(players, keep, L, pointScale(g.code), 5, tops);
  return {
    keep,
    side: {
      teamId, team: teamName,
      players: list.map(p => ({ id: p.id, name: names.get(p.id) || String(p.id), photo: photoUrl('basketball', p.id), perGame: p.perGame, minutes: p.proj, ...(st.get(p.id) || { status: 'playing' as const, note: null, noteKind: null, link: null }), without: p.without, cost: p.cost }))
    }
  };
}

/**
 * The key players card of a game to come or on (null: no box-score history for either team). `reasons` (only when
 * the viewer sees the full prediction): missing players who move the margin 1.5+ points.
 */
export function keyPlayersFor(g: { game_id: number; code: string; kickoff: string; home_id: number; away_id: number; home_name: string; away_name: string }, full: boolean): { home: KeySide | null; away: KeySide | null; reasons: KeyReason[] } | null {
  const h = sideCard(g, g.home_id, g.home_name), a = sideCard(g, g.away_id, g.away_name);
  if (!h && !a) return null;
  const reasons: KeyReason[] = [];
  if (full) for (const [x, side] of [[h, 'H'], [a, 'A']] as const) {
    if (!x) continue;
    for (const p of x.side.players) if (p.cost <= -1.5 && p.status !== 'playing' && p.status !== 'rested') reasons.push({ side, team: x.side.team, id: p.id, name: p.name, status: p.status, note: p.noteKind === 'injury' ? p.note : null, points: p.cost });
  }
  reasons.sort((p, q) => p.points - q.points);
  return { home: h?.side || null, away: a?.side || null, reasons };
}

/* ---------- player page: Impact ---------- */

export function playerImpact(playerId: number) {
  const last = db.prepare(`SELECT g.code, g.season, ps.team_id FROM bb_player_stats ps JOIN bb_games g ON g.game_id = ps.game_id WHERE ps.player_id = ? AND ps.minutes > 0 ORDER BY g.kickoff DESC LIMIT 1`).get(playerId) as any;
  if (!last) return null;
  // EuroLeague clubs play two competitions: the domestic league's snapshot first, then the EuroLeague's
  const codes = [last.code, ...(db.prepare(`SELECT DISTINCT g.code FROM bb_player_stats ps JOIN bb_games g ON g.game_id = ps.game_id WHERE ps.player_id = ? AND g.season = ? AND g.code != ?`).all(playerId, last.season, last.code) as any[]).map(r => r.code)];
  for (const code of codes) {
    const snap = gridSnap(code);
    const me = snap?.teams.get(last.team_id)?.pl?.find(p => p[0] === playerId);
    if (!snap || !me) continue;
    const L = snap.gameMin || gameMinOf(code);
    const pool: [number, number][] = [], imp = impactLive();
    for (const t of snap.teams.values()) for (const p of t.pl || []) if (p[2] >= 15 && p[3] <= 9) pool.push([p[0], plRating(p, imp)]);
    pool.sort((a, b) => b[1] - a[1]);
    const rank = pool.findIndex(p => p[0] === playerId) + 1;
    const games = db.prepare(`SELECT g.game_id, g.home_id, g.hs, g.as_ FROM bb_games g WHERE g.code = ? AND g.season = ? AND (g.home_id = ? OR g.away_id = ?) AND g.status IN ('FT','AOT') AND g.hs IS NOT NULL
      AND EXISTS (SELECT 1 FROM bb_player_stats x WHERE x.game_id = g.game_id AND x.team_id = ?)`).all(code, last.season, last.team_id, last.team_id, last.team_id) as any[];
    const played = new Set((db.prepare(`SELECT ps.game_id FROM bb_player_stats ps JOIN bb_games g ON g.game_id = ps.game_id WHERE ps.player_id = ? AND ps.minutes > 0 AND g.code = ? AND g.season = ?`).all(playerId, code, last.season) as any[]).map(r => r.game_id));
    const rec = { with: { won: 0, lost: 0 }, without: { won: 0, lost: 0 } };
    for (const x of games) {
      const won = (x.home_id === last.team_id) === (x.hs > x.as_);
      const b = played.has(x.game_id) ? rec.with : rec.without;
      if (won) b.won++; else b.lost++;
    }
    return {
      code, season: last.season, teamId: last.team_id, rating: Math.round(plRating(me, imp) * 10) / 10, minutes: Math.round(me[2] * 10) / 10,
      perGame: Math.round(((plRating(me, imp) * me[2]) / L) * 10) / 10, rank: rank || null, of: pool.length, ...rec
    };
  }
  return null;
}

/* ---------- data health ---------- */

export function keyPlayersHealth(now = Date.now()): Check[] {
  const out: Check[] = [];
  // every upcoming game whose two teams have box-score history has the card
  const games = db.prepare(`SELECT game_id, code, kickoff, home_id, away_id, home_name, away_name FROM bb_games WHERE (status IS NULL OR status = 'NS') AND kickoff > ? AND kickoff < ? ORDER BY kickoff`)
    .all(new Date(now).toISOString(), new Date(now + 7 * DAY).toISOString()) as any[];
  // box-score history = a finished game with stored box scores in the last 400 days (bb_games.stats, indexed by team)
  const hist = db.prepare(`SELECT 1 FROM bb_games WHERE (home_id = ? OR away_id = ?) AND stats = 1 AND kickoff > ? LIMIT 1`);
  const since = new Date(now - 400 * DAY).toISOString();
  const has = new Map<number, boolean>();
  const histOf = (id: number) => { if (!has.has(id)) has.set(id, !!hist.get(id, id, since)); return has.get(id)!; };
  // the card has players when the league's snapshot has rotation players for the team (what keyPlayersFor reads)
  const card = (code: string, id: number) => !!gridSnap(code)?.teams.get(id)?.pl?.some(p => p[2] > 0);
  const missing: string[] = [];
  let need = 0;
  for (const g of games) {
    if (!histOf(g.home_id) || !histOf(g.away_id)) continue;
    need++;
    const h = card(g.code, g.home_id), a = card(g.code, g.away_id);
    if (!h || !a) missing.push(`${g.code} ${g.home_name} – ${g.away_name} (${String(g.kickoff).slice(0, 10)}): ${!h ? g.home_name : g.away_name} has no players in the model snapshot`);
  }
  out.push({ id: 'bb-key-players', label: 'Key players shown (basketball)', level: missing.length ? 'warn' : 'ok', detail: missing.length ? `${missing.length} of ${need} upcoming game(s) with box-score history have no key players card` : `All ${need} upcoming game(s) with box-score history have the card`, items: missing.slice(0, 15) });
  // star rest applied, per week (Monday-based, last 4)
  const weeks = db.prepare(`SELECT kind, kickoff, game_id FROM bb_rest_log WHERE kickoff > ? AND kind != 'news'`).all(new Date(now - 28 * DAY).toISOString()) as any[];
  const by = new Map<number, { n: number; games: Set<number> }>();
  for (const r of weeks) { const w = weekOf(Date.parse(r.kickoff)); const b = by.get(w) || { n: 0, games: new Set<number>() }; b.n++; b.games.add(r.game_id); by.set(w, b); }
  const rates = db.prepare(`SELECT COUNT(*) AS n, SUM(keep < 1) AS used, MAX(at) AS at FROM bb_rest_rates`).get() as any;
  out.push({
    id: 'bb-star-rest', label: 'Star rest applied (basketball)', level: rates?.n ? 'ok' : 'warn',
    detail: rates?.n ? `${rates.used || 0} player pattern(s) in use of ${rates.n} (built ${String(rates.at).slice(0, 16).replace('T', ' ')} UTC)` : 'No rest patterns built yet (daily job)',
    items: [...by.entries()].sort((a, b) => b[0] - a[0]).map(([w, b]) => `week of ${new Date((w * 7 - 3) * DAY).toISOString().slice(0, 10)}: ${b.n} player reduction(s) in ${b.games.size} game(s)`)
  });
  // reported out (news) waiting for review
  const pend = db.prepare(`SELECT name, code, status, until, link FROM bb_news_injuries WHERE state = 'active' AND reviewed = 0 ORDER BY at DESC`).all() as any[];
  out.push({ id: 'bb-news-injuries', label: 'Reported out from news (basketball)', level: pend.length ? 'warn' : 'ok', detail: pend.length ? `${pend.length} item(s) pending review in Admin → Basketball injuries from news` : 'Nothing pending review', items: pend.slice(0, 15).map(p => `${p.name} (${p.code}): ${p.status} until ${String(p.until).slice(0, 10)} — ${p.link}`) });
  return out;
}

/* ---------- scheduler (worker) ---------- */

export function startKeyPlayersScheduler() {
  afterHeavy('bb rest patterns', () => buildRestRates().catch(e => logger.warn(`bb rest patterns: ${e.message}`)), 9 * 60 * 1000).unref();
  everyHeavy('bb rest patterns', () => buildRestRates().catch(e => logger.warn(`bb rest patterns: ${e.message}`)), 24 * 3600 * 1000).unref();
  const tick = async () => {
    try { await scanNewsInjuries(); } catch (e: any) { logger.warn(`bb news injuries: ${e.message}`); }
    try { logApplied(); } catch (e: any) { logger.warn(`bb rest log: ${e.message}`); }
  };
  after('bb key players', tick, 7 * 60 * 1000).unref();
  every('bb key players', tick, 30 * 60 * 1000).unref();
}
