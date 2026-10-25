/**
 * NBA injuries (Oct 2026): balldontlie's player-injuries list (GOAT plan, key BALLDONTLIE_KEY in Railway),
 * refreshed every 15 minutes. Without the key it falls back to ESPN's public list (which blocks our server). Used two ways:
 *  - the game page lists each team's injured / doubtful players;
 *  - the model takes points off a team for the regulars who will miss the game, weighted by their minutes and
 *    how much they produce (box scores of the team's last 15 games). Out = full weight, doubtful 75%,
 *    questionable 50%, day-to-day 40%, probable 10%.
 * Backtest (research, 7 Oct 2026): knowing who plays improved NBA log loss 0.603 → 0.597 and picks +0.7 pp.
 */
import logger from '../utils/logger';
import { db } from '../db';
import { assertProviderCallAllowed } from './afUsage';

const URL = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries';
const BDL = 'https://api.balldontlie.io';

/** balldontlie GET (admin raw calls and the injury list). Throws without the key. */
export async function bdlGet(path: string, params: Record<string, string | string[]> = {}): Promise<any> {
  const key = process.env.BALLDONTLIE_KEY;
  if (!key) throw new Error('BALLDONTLIE_KEY not set');
  assertProviderCallAllowed(); // fix166: crawler pages are built from our database only
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) for (const x of Array.isArray(v) ? v : [v]) q.append(k, x);
  const res = await fetch(`${BDL}${path}${q.toString() ? `?${q}` : ''}`, { signal: AbortSignal.timeout(20000), headers: { Authorization: key } });
  if (!res.ok) throw new Error(`balldontlie HTTP ${res.status}`);
  return res.json();
}

type InjRow = { team: string; player: string; status: string; comment: string | null; reported: string | null };

let bdlTeams: Map<number, string> | null = null;
async function fromBalldontlie(): Promise<InjRow[]> {
  if (!bdlTeams) {
    const t = await bdlGet('/v1/teams');
    bdlTeams = new Map((t.data || []).map((x: any) => [Number(x.id), String(x.full_name || x.name)] as [number, string]));
  }
  const out: InjRow[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const j: any = await bdlGet('/v1/player_injuries', { per_page: '100', ...(cursor ? { cursor } : {}) });
    for (const i of j.data || []) {
      const p = i.player || {};
      const teamName = bdlTeams.get(Number(p.team_id)) || '';
      const name = `${p.first_name || ''} ${p.last_name || ''}`.trim();
      if (!teamName || !name || !i.status) continue;
      out.push({ team: nbaKey(teamName), player: name, status: String(i.status), comment: i.description || null, reported: i.return_date ? `back ${i.return_date}` : null });
    }
    cursor = j.meta?.next_cursor ? String(j.meta.next_cursor) : null;
    if (!cursor) break;
  }
  return out;
}

async function fromEspn(): Promise<InjRow[]> {
  const res = await fetch(URL, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'SportLikely/1.0 (+https://sportlikely.com)' } });
  if (!res.ok) throw new Error(`ESPN HTTP ${res.status}`);
  const j: any = await res.json();
  const out: InjRow[] = [];
  for (const t of j.injuries || []) {
    const team = nbaKey(t.displayName);
    for (const i of t.injuries || []) {
      const name = i.athlete?.displayName;
      if (!team || !name || !i.status) continue;
      out.push({ team, player: name, status: String(i.status), comment: i.shortComment || null, reported: i.date || null });
    }
  }
  return out;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS bb_injuries (
    team TEXT NOT NULL,          -- team nickname, lower case ("lakers")
    player TEXT NOT NULL,        -- "LeBron James"
    status TEXT NOT NULL,        -- Out, Doubtful, Questionable, Day-To-Day, Probable…
    comment TEXT,
    reported TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (team, player)
  );
`);

export const STATUS_WEIGHT = (s: string): number => {
  const x = s.toLowerCase();
  if (/out|suspend|inactive/.test(x)) return 1;
  if (/doubt/.test(x)) return 0.75;
  if (/question/.test(x)) return 0.5;
  if (/day-to-day|game.?time/.test(x)) return 0.4;
  if (/probable/.test(x)) return 0.1;
  return 0;
};

/** NBA team key: the nickname, unique in the league ("Los Angeles Lakers" / "LA Lakers" → "lakers"). */
export const nbaKey = (name: string) => {
  const w = String(name || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim().split(/\s+/);
  if (w.length >= 2 && w[w.length - 2] === 'trail') return 'trail blazers';
  return w[w.length - 1] || '';
};
/** Player name key: the name's words, sorted (box scores say "James LeBron", ESPN "LeBron James"). */
export const playerKey = (name: string) => String(name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z ]+/g, ' ').split(/\s+/).filter(w => w && !['jr', 'sr', 'ii', 'iii', 'iv'].includes(w)).sort().join(' ');

let lastFetch: string | null = null;
let lastError: string | null = null;
let lastSource: string | null = null;

export async function refreshNbaInjuries() {
  try {
    const source = process.env.BALLDONTLIE_KEY ? 'balldontlie' : 'espn';
    const rows = source === 'balldontlie' ? await fromBalldontlie() : await fromEspn();
    const now = new Date().toISOString();
    const ins = db.prepare(`INSERT OR REPLACE INTO bb_injuries (team, player, status, comment, reported, updated_at) VALUES (?, ?, ?, ?, ?, ?)`);
    db.exec('BEGIN');
    try {
      db.exec('DELETE FROM bb_injuries'); // the list is a full snapshot: players who are back drop off it
      for (const r of rows) ins.run(r.team, r.player, r.status, r.comment, r.reported, now);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    lastFetch = now;
    lastError = null;
    lastSource = source;
    return rows.length;
  } catch (e: any) {
    lastError = e.message;
    logger.warn(`NBA injuries: ${e.message}`);
    return null;
  }
}

/** The team's players from its last 15 games: average minutes (0 when he did not play) and production per minute. */
function roster(teamId: number, before: string) {
  const games = db.prepare(`SELECT game_id FROM bb_games WHERE (home_id = ? OR away_id = ?) AND status IN ('FT','AOT') AND kickoff < ? AND stats = 1 ORDER BY kickoff DESC LIMIT 15`)
    .all(teamId, teamId, before) as any[];
  if (games.length < 3) return null;
  const ids = games.map(g => g.game_id);
  const rows = db.prepare(`SELECT player_id, name, minutes, pts, fgm, fga, ftm, fta, reb, ast FROM bb_player_stats WHERE team_id = ? AND game_id IN (${ids.map(() => '?').join(',')})`)
    .all(teamId, ...ids) as any[];
  const by = new Map<number, { name: string; min: number; gs: number }>();
  for (const r of rows) {
    const m = r.minutes || 0;
    const gs = (r.pts || 0) + 0.4 * (r.fgm || 0) - 0.7 * (r.fga || 0) - 0.4 * ((r.fta || 0) - (r.ftm || 0)) + 0.5 * (r.reb || 0) + 0.7 * (r.ast || 0);
    const x = by.get(r.player_id) || { name: r.name, min: 0, gs: 0 };
    x.min += m; x.gs += gs;
    by.set(r.player_id, x);
  }
  const list = [...by.entries()].map(([id, x]) => ({ id, name: x.name, min: x.min / games.length, rate: x.min > 0 ? x.gs / x.min : 0 }));
  const totMin = list.reduce((a, p) => a + p.min, 0), totGs = list.reduce((a, p) => a + p.rate * p.min, 0);
  return { players: list, avgRate: totMin ? totGs / totMin : 0 };
}

/** Injured players of an NBA team, with their minutes when we can match them to our box scores. */
export function nbaInjuries(teamId: number, teamName: string, before: string) {
  const list = db.prepare(`SELECT player, status, comment, reported FROM bb_injuries WHERE team = ? ORDER BY player`).all(nbaKey(teamName)) as any[];
  if (!list.length) return [];
  const r = roster(teamId, before);
  const byKey = new Map((r?.players || []).map(p => [playerKey(p.name), p]));
  return list.map(x => {
    const p = byKey.get(playerKey(x.player));
    return { name: x.player, status: x.status, weight: STATUS_WEIGHT(x.status), comment: x.comment, minutes: p ? Math.round(p.min * 10) / 10 : null, playerId: p?.id ?? null };
  }).sort((a, b) => b.weight - a.weight || (b.minutes || 0) - (a.minutes || 0));
}

const KA = 0.3, MIN_REG = 12, REPL = 0.8, CAP = 8;
/** fix174: injuryLoss with each regular's share (the game page's "numbers changed" card): points per player, same cap. */
export function injuryLossDetail(teamId: number, teamName: string, before: string) {
  const inj = db.prepare(`SELECT player, status FROM bb_injuries WHERE team = ?`).all(nbaKey(teamName)) as any[];
  const none = { points: 0, players: [] as { id: number; name: string; status: string; points: number }[] };
  if (!inj.length) return none;
  const r = roster(teamId, before);
  if (!r) return none;
  const byKey = new Map(r.players.map(p => [playerKey(p.name), p]));
  let tot = 0;
  const list: { id: number; name: string; status: string; v: number }[] = [];
  for (const x of inj) {
    const w = STATUS_WEIGHT(x.status);
    const p = byKey.get(playerKey(x.player));
    if (!w || !p || p.min < MIN_REG) continue;
    const v = w * p.min * Math.max(0, p.rate - r.avgRate * REPL);
    if (v > 0) { tot += v; list.push({ id: p.id, name: x.player, status: x.status, v }); }
  }
  const points = Math.round(Math.min(CAP, KA * tot) * 10) / 10;
  return { points, players: list.map(x => ({ id: x.id, name: x.name, status: x.status, points: tot ? Math.round(((x.v / tot) * points) * 10) / 10 : 0 })) };
}

/** Points an NBA team is expected to lose to its injuries (regulars only, weighted by status). */
export function injuryLoss(teamId: number, teamName: string, before: string) {
  const inj = db.prepare(`SELECT player, status FROM bb_injuries WHERE team = ?`).all(nbaKey(teamName)) as any[];
  if (!inj.length) return { points: 0, players: [] as string[] };
  const r = roster(teamId, before);
  if (!r) return { points: 0, players: [] as string[] };
  const byKey = new Map(r.players.map(p => [playerKey(p.name), p]));
  let tot = 0;
  const who: string[] = [];
  for (const x of inj) {
    const w = STATUS_WEIGHT(x.status);
    const p = byKey.get(playerKey(x.player));
    if (!w || !p || p.min < MIN_REG) continue;
    const v = w * p.min * Math.max(0, p.rate - r.avgRate * REPL);
    if (v > 0) { tot += v; who.push(x.player); }
  }
  return { points: Math.round(Math.min(CAP, KA * tot) * 10) / 10, players: who };
}

export function nbaInjuryStatus() {
  const n: any = db.prepare(`SELECT COUNT(*) AS n, COUNT(DISTINCT team) AS t FROM bb_injuries`).get();
  return { source: lastSource, keySet: !!process.env.BALLDONTLIE_KEY, lastFetch, lastError, players: n.n, teams: n.t };
}
