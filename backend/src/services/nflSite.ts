/**
 * The NFL site's data (fix137, Oct 2026): game lists by week, game pages (quarters, form, H2H, box score, injuries),
 * standings by conference and division, team pages with the rule-based team analysis, player pages, leaders.
 * Predictions come from services/nflModel.ts (fix139, attached in index.ts), no odds. Built from services/nfl.ts tables only.
 * Visible to everyone when NFL_PUBLIC=1; before that, admins only. Past seasons: admins only.
 * fix142: every list takes a league (1 = NFL, 2 = college football); games, teams and players are found by their id.
 * College standings are grouped by conference (FBS conferences first).
 */
import { db } from '../db';
import { nflCurrentSeason, NFL_LIVE, NFL_DONE, LeagueId, HIDE_OTHER } from './nfl';

export const nflPublic = () => process.env.NFL_PUBLIC === '1';

const OFF = ['CANC', 'PST', 'SUSP', 'AWD', 'ABD'];
const num = (x: any): number | null => {
  if (x === null || x === undefined || x === '') return null;
  const n = Number(String(x).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};
const parseJson = (s: any) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

/* ---------- games ---------- */

export interface NflSide { id: number; name: string; logo: string | null }
export interface NflGame {
  id: number; season: number; week: string | null; weekKey: string; stage: string | null; kickoff: string; status: string;
  state: 'upcoming' | 'live' | 'done' | 'off'; home: NflSide; away: NflSide; score: { home: number; away: number } | null;
  quarters: { home: (number | null)[]; away: (number | null)[] } | null; venue: string | null; league: LeagueId
}

/**
 * "1".."18" for the regular season, "post" for the playoffs / bowls, "pre" for pre-season. fix150: college formats too —
 * "Week 8", "8", "Regular Season - 8", the number in the stage when the week has none, bowls / playoffs / championship.
 */
export function weekKey(stage: string | null, week: string | null): string {
  const st = String(stage || ''), wk = String(week || '');
  if (/post|bowl|playoff|championship|super bowl|wild ?card|divisional/i.test(st) || /bowl|playoff|championship|super bowl|wild ?card|divisional/i.test(wk)) return 'post';
  if (/^pre|pre[- ]?season/i.test(st) || /pre[- ]?season|hall of fame/i.test(wk)) return 'pre';
  const m = wk.match(/(\d+)/) || st.match(/(\d+)\s*$/);
  return m ? String(Number(m[1])) : 'post';
}

/** fix151: a team's name for a game row: the stored one, else the team list's, else "TBD" (never null). */
export const nameOf = (id: number | null, given: string | null) => (given && String(given).trim()) || (id ? ((db.prepare(`SELECT name FROM nfl_teams WHERE team_id = ?`).get(id) as any)?.name || null) : null) || 'TBD';
const logoOf = (id: number | null, given: string | null) => given || (id ? ((db.prepare(`SELECT logo FROM nfl_teams WHERE team_id = ?`).get(id) as any)?.logo ?? null) : null);

export function shapeGame(r: any): NflGame {
  const status = r.status || 'NS';
  const state = NFL_DONE.includes(status) ? 'done' : NFL_LIVE.includes(status) ? 'live' : OFF.includes(status) ? 'off' : 'upcoming';
  const q = parseJson(r.quarters);
  return {
    id: r.game_id, season: r.season, week: r.week, weekKey: weekKey(r.stage, r.week), stage: r.stage, kickoff: r.kickoff, status, state,
    home: { id: r.home_id, name: nameOf(r.home_id, r.home_name), logo: logoOf(r.home_id, r.home_logo) },
    away: { id: r.away_id, name: nameOf(r.away_id, r.away_name), logo: logoOf(r.away_id, r.away_logo) },
    score: r.home_pts != null && r.away_pts != null && state !== 'upcoming' ? { home: r.home_pts, away: r.away_pts } : null,
    quarters: Array.isArray(q) && q.length === 2 ? { home: q[0], away: q[1] } : null,
    venue: r.venue || null, league: r.league === 2 ? 2 : 1
  };
}

const GAME_COLS = `game_id, season, week, stage, kickoff, home_id, home_name, home_logo, away_id, away_name, away_logo, status, home_pts, away_pts, quarters, venue, league`;
export const leagueOfTeamId = (id: number): LeagueId => ((db.prepare(`SELECT league FROM nfl_teams WHERE team_id = ?`).get(id) as any)?.league === 2 ? 2 : 1);

/** Seasons we hold (admins see all; everyone else only the current one). */
export function nflSeasonsHeld(admin: boolean, league: LeagueId = 1): number[] {
  const cur = nflCurrentSeason(league);
  const all = (db.prepare(`SELECT DISTINCT season FROM nfl_games WHERE league = ? ORDER BY season DESC`).all(league) as any[]).map(r => r.season as number);
  return admin ? all : all.filter(s => s === cur);
}
/** The season a visitor may look at: past seasons are admin-only. */
export function allowedSeason(asked: unknown, admin: boolean, league: LeagueId = 1): number | null {
  const cur = nflCurrentSeason(league);
  const s = num(asked);
  if (s && (admin || s === cur)) return s;
  return cur;
}

/** The week list of a season (with dates and game counts) and the week to open by default. */
export function nflWeeks(season: number, league: LeagueId = 1) {
  const rows = db.prepare(`SELECT stage, week, MIN(kickoff) AS first, MAX(kickoff) AS last, COUNT(*) AS n FROM nfl_games WHERE league = ? ${HIDE_OTHER} AND season = ? GROUP BY stage, week`).all(league, season) as any[];
  const byKey = new Map<string, { key: string; label: string; first: string; last: string; games: number }>();
  for (const r of rows) {
    const key = weekKey(r.stage, r.week);
    if (key === 'pre') continue; // pre-season games are not shown
    const w = byKey.get(key) || { key, label: key === 'post' ? (league === 2 ? 'Bowls' : 'Playoffs') : `Week ${key}`, first: r.first, last: r.last, games: 0 };
    w.first = r.first < w.first ? r.first : w.first; w.last = r.last > w.last ? r.last : w.last; w.games += r.n;
    byKey.set(key, w);
  }
  const weeks = [...byKey.values()].sort((a, b) => (a.key === 'post' ? 99 : Number(a.key)) - (b.key === 'post' ? 99 : Number(b.key)));
  // default: the week of the next game not finished yet (live or upcoming), else the last week
  const next = db.prepare(`SELECT stage, week FROM nfl_games WHERE league = ? ${HIDE_OTHER} AND season = ? AND (status IS NULL OR status NOT IN ('FT','AOT','CANC','PST')) AND kickoff >= ? AND (stage IS NULL OR stage NOT LIKE 'Pre%') ORDER BY kickoff LIMIT 1`)
    .get(league, season, new Date(Date.now() - 6 * 3600 * 1000).toISOString()) as any;
  const current = next ? weekKey(next.stage, next.week) : weeks[weeks.length - 1]?.key || null;
  return { weeks, current };
}

/** Games of a week ("1".."18" / "post") of a season. */
export function nflWeekGames(season: number, key: string, league: LeagueId = 1): NflGame[] {
  const rows = db.prepare(`SELECT ${GAME_COLS} FROM nfl_games WHERE league = ? ${HIDE_OTHER} AND season = ? ORDER BY kickoff, game_id`).all(league, season) as any[];
  return rows.filter(r => weekKey(r.stage, r.week) === key).map(shapeGame);
}
/** Games between two moments (Today page, live strip). */
export function nflGamesBetween(from: string, to: string, league: LeagueId = 1): NflGame[] {
  return (db.prepare(`SELECT ${GAME_COLS} FROM nfl_games WHERE league = ? ${HIDE_OTHER} AND kickoff >= ? AND kickoff < ? AND (stage IS NULL OR stage NOT LIKE 'Pre%') ORDER BY kickoff, game_id`).all(league, from, to) as any[]).map(shapeGame);
}
/** The last finished games (home page "Latest results"). */
export function nflRecentResults(n = 8, league: LeagueId = 1): NflGame[] {
  const season = nflCurrentSeason(league);
  return (db.prepare(`SELECT ${GAME_COLS} FROM nfl_games WHERE league = ? ${HIDE_OTHER} AND season = ? AND status IN ('FT','AOT') AND home_pts IS NOT NULL AND (stage IS NULL OR stage NOT LIKE 'Pre%') ORDER BY kickoff DESC LIMIT ?`).all(league, season, n) as any[]).map(shapeGame);
}
export function nflLiveGames(league: LeagueId = 1): NflGame[] {
  return (db.prepare(`SELECT ${GAME_COLS} FROM nfl_games WHERE league = ? ${HIDE_OTHER} AND status IN ('Q1','Q2','Q3','Q4','OT','HT') ORDER BY kickoff`).all(league) as any[]).map(shapeGame);
}

/* ---------- teams ---------- */

export function nflTeamRow(id: number) {
  const t = db.prepare(`SELECT team_id AS id, name, code, city, logo, conference, division, coach, stadium, league, level FROM nfl_teams WHERE team_id = ?`).get(id) as any;
  if (t) return t;
  const g = db.prepare(`SELECT CASE WHEN home_id = ? THEN home_name ELSE away_name END AS name, CASE WHEN home_id = ? THEN home_logo ELSE away_logo END AS logo FROM nfl_games WHERE home_id = ? OR away_id = ? ORDER BY kickoff DESC LIMIT 1`).get(id, id, id, id) as any;
  return g ? { id, name: g.name, code: null, city: null, logo: g.logo, conference: null, division: null, coach: null, stadium: null, league: leagueOfTeamId(id), level: null } : null;
}

/* ---------- standings (computed from our games; conference / division from the provider's standings) ---------- */

export interface StandRow { team: NflSide; conference: string | null; division: string | null; level?: string | null; confW?: number; confL?: number; w: number; l: number; t: number; pct: number; pf: number; pa: number; diff: number; streak: string | null; games: number }

export function nflStandings(season: number, league: LeagueId = 1): { season: number; league: LeagueId; conferences: { name: string; level?: string | null; divisions: { name: string; rows: StandRow[] }[] }[]; rows: StandRow[] } {
  return cached(`stand|${league}|${season}`, () => standingsOf(season, league), 60 * 1000);
}
function standingsOf(season: number, league: LeagueId) {
  const games = db.prepare(`SELECT home_id, away_id, home_pts, away_pts, kickoff FROM nfl_games WHERE league = ? ${HIDE_OTHER} AND season = ? AND status IN ('FT','AOT') AND home_pts IS NOT NULL AND stage LIKE 'Regular%' ORDER BY kickoff`).all(league, season) as any[];
  const teams = new Map<number, StandRow & { seq: string[] }>();
  const ensure = (id: number) => {
    let r = teams.get(id);
    if (!r) {
      const t = nflTeamRow(id);
      r = { team: { id, name: t?.name || String(id), logo: t?.logo || null }, conference: t?.conference || null, division: t?.division || null, level: t?.level || null, confW: 0, confL: 0, w: 0, l: 0, t: 0, pct: 0, pf: 0, pa: 0, diff: 0, streak: null, games: 0, seq: [] };
      teams.set(id, r);
    }
    return r;
  };
  // teams with no game yet still get a row (from the regular-season schedule)
  for (const r of db.prepare(`SELECT DISTINCT home_id AS id FROM nfl_games WHERE league = ? ${HIDE_OTHER} AND season = ? AND stage LIKE 'Regular%' UNION SELECT DISTINCT away_id FROM nfl_games WHERE league = ? ${HIDE_OTHER} AND season = ? AND stage LIKE 'Regular%'`).all(league, season, league, season) as any[]) if (r.id) ensure(r.id);
  for (const g of games) {
    const h = ensure(g.home_id), a = ensure(g.away_id);
    h.pf += g.home_pts; h.pa += g.away_pts; a.pf += g.away_pts; a.pa += g.home_pts; h.games++; a.games++;
    if (g.home_pts > g.away_pts) { h.w++; a.l++; h.seq.push('W'); a.seq.push('L'); }
    else if (g.home_pts < g.away_pts) { a.w++; h.l++; a.seq.push('W'); h.seq.push('L'); }
    else { h.t++; a.t++; h.seq.push('T'); a.seq.push('T'); }
    // college: conference record (games between two teams of the same conference)
    if (league === 2 && h.conference && h.conference === a.conference && g.home_pts !== g.away_pts) {
      if (g.home_pts > g.away_pts) { h.confW!++; a.confL!++; } else { a.confW!++; h.confL!++; }
    }
  }
  const rows: StandRow[] = [...teams.values()].map(({ seq, ...r }) => {
    let streak: string | null = null;
    if (seq.length) { const last = seq[seq.length - 1]; let n = 0; for (let i = seq.length - 1; i >= 0 && seq[i] === last; i--) n++; streak = `${last}${n}`; }
    return { ...r, pct: r.games ? Math.round(((r.w + 0.5 * r.t) / r.games) * 1000) / 1000 : 0, diff: r.pf - r.pa, streak };
  }).sort((a, b) => (league === 2 ? pctOf(b.confW!, b.confL!) - pctOf(a.confW!, a.confL!) : 0) || b.pct - a.pct || b.diff - a.diff || b.pf - a.pf);
  const confs = new Map<string, Map<string, StandRow[]>>();
  for (const r of rows) {
    const c = r.conference || (league === 2 ? 'Other teams' : 'NFL'), d = r.division || c;
    if (!confs.has(c)) confs.set(c, new Map());
    const m = confs.get(c)!;
    if (!m.has(d)) m.set(d, []);
    m.get(d)!.push(r);
  }
  const order = (s: string) => (/east/i.test(s) ? 0 : /north/i.test(s) ? 1 : /south/i.test(s) ? 2 : /west/i.test(s) ? 3 : 4);
  // college: FBS conferences first, then FCS, teams without a conference last
  const levelOf = (m: Map<string, StandRow[]>) => [...m.values()].flat().find(r => r.level)?.level || null;
  const rankConf = (name: string, m: Map<string, StandRow[]>) => (league !== 2 ? 0 : name === 'Other teams' ? 2 : levelOf(m) === 'FBS' ? 0 : 1);
  return {
    season, league,
    conferences: [...confs.entries()].sort((a, b) => rankConf(a[0], a[1]) - rankConf(b[0], b[1]) || a[0].localeCompare(b[0])).map(([name, m]) => ({
      name, level: league === 2 ? levelOf(m) : undefined, divisions: [...m.entries()].sort((a, b) => order(a[0]) - order(b[0]) || a[0].localeCompare(b[0])).map(([dn, rs]) => ({ name: dn, rows: rs }))
    })),
    rows
  };
}

const pctOf = (w: number, l: number) => (w + l ? w / (w + l) : 0);

/* ---------- box scores ---------- */

/** A statistic from a team's box score, by a few possible paths ("first_downs.third_down_efficiency"). */
function stat(s: any, ...paths: string[]): any {
  for (const p of paths) {
    const v = p.split('.').reduce((o: any, k) => (o && typeof o === 'object' ? o[k] : undefined), s);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}
/** "5-12" / "5/12" → [5, 12] */
const pair = (v: any): [number, number] | null => {
  const m = String(v ?? '').match(/^\s*(\d+)\s*[-/]\s*(\d+)\s*$/);
  return m ? [Number(m[1]), Number(m[2])] : null;
};

/** The numbers the game page compares side by side (null where the provider has none). */
export function teamBox(s: any) {
  if (!s) return null;
  const third = pair(stat(s, 'first_downs.third_down_efficiency', 'third_down_efficiency'));
  const fourth = pair(stat(s, 'first_downs.fourth_down_efficiency', 'fourth_down_efficiency'));
  const rz = pair(stat(s, 'red_zone.made_att', 'red_zone'));
  const sacked = pair(stat(s, 'passing.sacks_yards_lost'));
  return {
    firstDowns: num(stat(s, 'first_downs.total')),
    plays: num(stat(s, 'plays.total')),
    yards: num(stat(s, 'yards.total')),
    yardsPerPlay: num(stat(s, 'yards.yards_per_play')),
    passYards: num(stat(s, 'passing.total')),
    rushYards: num(stat(s, 'rushings.total', 'rushing.total')),
    rushAttempts: num(stat(s, 'rushings.attempts', 'rushing.attempts')),
    third, fourth, redZone: rz,
    turnovers: num(stat(s, 'turnovers.total')),
    penalties: stat(s, 'penalties.total'),
    possession: stat(s, 'posession.total', 'possession.total'),
    sacks: num(stat(s, 'sacks.total')),
    sacked: sacked ? sacked[0] : null,
    interceptions: num(stat(s, 'interceptions.total')),
    fumblesRecovered: num(stat(s, 'fumbles_recovered.total'))
  };
}

/** Player lines of one team in one game: { group: [{ id, name, image, stats: { name: value } }] }. */
function playerGroups(json: string | null): Record<string, { id: number; name: string; image: string | null; stats: Record<string, string> }[]> {
  const groups = parseJson(json) || [];
  const out: Record<string, any[]> = {};
  for (const g of Array.isArray(groups) ? groups : []) {
    const name = String(g?.name || '').trim();
    if (!name) continue;
    out[name] = (g.players || []).map((p: any) => ({
      id: num(p?.player?.id), name: p?.player?.name || '', image: p?.player?.image || null,
      stats: Object.fromEntries((p.statistics || []).filter((x: any) => x?.name).map((x: any) => [String(x.name), x.value == null ? '' : String(x.value)]))
    })).filter((p: any) => p.id);
  }
  return out;
}

/* ---------- game page ---------- */

function formOf(teamId: number, before: string, n = 5) {
  return (db.prepare(`SELECT ${GAME_COLS} FROM nfl_games WHERE (home_id = ? OR away_id = ?) AND kickoff < ? AND status IN ('FT','AOT') AND home_pts IS NOT NULL AND (stage IS NULL OR stage NOT LIKE 'Pre%') ORDER BY kickoff DESC LIMIT ?`)
    .all(teamId, teamId, before, n) as any[]).map(r => {
      const g = shapeGame(r), home = g.home.id === teamId;
      const f = home ? g.score!.home : g.score!.away, a = home ? g.score!.away : g.score!.home;
      return { id: g.id, kickoff: g.kickoff, opponent: home ? g.away : g.home, home, for: f, against: a, result: f > a ? 'W' : f < a ? 'L' : 'T' };
    });
}

export function nflGame(id: number, admin: boolean) {
  const r = db.prepare(`SELECT ${GAME_COLS} FROM nfl_games WHERE game_id = ?`).get(id) as any;
  if (!r) return null;
  if (!admin && r.season !== nflCurrentSeason(r.league === 2 ? 2 : 1)) return null; // past seasons: admins only
  const g = shapeGame(r);
  const h2h = (db.prepare(`SELECT ${GAME_COLS} FROM nfl_games WHERE ((home_id = ? AND away_id = ?) OR (home_id = ? AND away_id = ?)) AND kickoff < ? AND status IN ('FT','AOT') AND home_pts IS NOT NULL ORDER BY kickoff DESC LIMIT 10`)
    .all(g.home.id, g.away.id, g.away.id, g.home.id, g.kickoff) as any[]).map(shapeGame);
  const ts = new Map((db.prepare(`SELECT team_id, json FROM nfl_team_stats WHERE game_id = ?`).all(id) as any[]).map(x => [x.team_id, parseJson(x.json)]));
  const ps = new Map((db.prepare(`SELECT team_id, json FROM nfl_player_stats WHERE game_id = ?`).all(id) as any[]).map(x => [x.team_id, x.json]));
  const inj = (teamId: number) => db.prepare(`SELECT player_id AS id, player_name AS name, image, status, description, date FROM nfl_injuries WHERE team_id = ? ORDER BY status, player_name`).all(teamId);
  return {
    game: g,
    form: { home: formOf(g.home.id, g.kickoff), away: formOf(g.away.id, g.kickoff) },
    h2h,
    teamStats: ts.size ? { home: teamBox(ts.get(g.home.id)), away: teamBox(ts.get(g.away.id)) } : null,
    players: ps.size ? { home: playerGroups(ps.get(g.home.id) ?? null), away: playerGroups(ps.get(g.away.id) ?? null) } : null,
    injuries: g.state === 'done' ? null : { home: inj(g.home.id), away: inj(g.away.id) },
    prediction: null // fix139: filled in by the route (withNflPrediction)
  };
}

/* ---------- season numbers per team (team analysis, leaders) ---------- */

type Agg = { games: number; pf: number; pa: number; yards: number; plays: number; give: number; take: number; thirdM: number; thirdA: number; rzM: number; rzA: number; sacks: number; boxGames: number };
const cache = new Map<string, { at: number; v: any }>();
const cached = <T>(key: string, fn: () => T, ms = 10 * 60 * 1000): T => {
  const c = cache.get(key);
  if (c && Date.now() - c.at < ms) return c.v;
  const v = fn();
  cache.set(key, { at: Date.now(), v });
  return v;
};

/** Season totals of every team (regular season + playoffs, finished games), up to week `upTo` if given. */
function seasonAgg(season: number, upTo?: number, league: LeagueId = 1): Map<number, Agg> {
  const rows = db.prepare(`SELECT game_id, stage, week, home_id, away_id, home_pts, away_pts FROM nfl_games WHERE league = ? ${HIDE_OTHER} AND season = ? AND status IN ('FT','AOT') AND home_pts IS NOT NULL AND (stage IS NULL OR stage NOT LIKE 'Pre%')`).all(league, season) as any[];
  const box = new Map<string, any>();
  for (const b of db.prepare(`SELECT s.game_id, s.team_id, s.json FROM nfl_team_stats s JOIN nfl_games g ON g.game_id = s.game_id WHERE g.league = ? AND g.season = ?`).all(league, season) as any[]) box.set(`${b.game_id}|${b.team_id}`, teamBox(parseJson(b.json)));
  const out = new Map<number, Agg>();
  const get = (id: number) => { let a = out.get(id); if (!a) out.set(id, (a = { games: 0, pf: 0, pa: 0, yards: 0, plays: 0, give: 0, take: 0, thirdM: 0, thirdA: 0, rzM: 0, rzA: 0, sacks: 0, boxGames: 0 })); return a; };
  for (const r of rows) {
    const wk = weekKey(r.stage, r.week);
    if (upTo !== undefined && (wk === 'post' || Number(wk) > upTo)) continue;
    for (const [me, op, f, a] of [[r.home_id, r.away_id, r.home_pts, r.away_pts], [r.away_id, r.home_id, r.away_pts, r.home_pts]] as [number, number, number, number][]) {
      const x = get(me);
      x.games++; x.pf += f; x.pa += a;
      const b = box.get(`${r.game_id}|${me}`), o = box.get(`${r.game_id}|${op}`);
      if (b) {
        x.boxGames++;
        x.yards += b.yards || 0; x.plays += b.plays || 0; x.give += b.turnovers || 0; x.take += o?.turnovers || 0;
        if (b.third) { x.thirdM += b.third[0]; x.thirdA += b.third[1]; }
        if (b.redZone) { x.rzM += b.redZone[0]; x.rzA += b.redZone[1]; }
        x.sacks += b.sacks || 0;
      }
    }
  }
  return out;
}

/** The six measures of the team analysis (null = not enough data). `better` = the direction that is good. */
const MEASURES: { id: string; label: string; better: 'high' | 'low'; of: (a: Agg) => number | null; fmt: (v: number) => string }[] = [
  { id: 'pf', label: 'Points scored per game', better: 'high', of: a => (a.games ? a.pf / a.games : null), fmt: v => v.toFixed(1) },
  { id: 'pa', label: 'Points allowed per game', better: 'low', of: a => (a.games ? a.pa / a.games : null), fmt: v => v.toFixed(1) },
  { id: 'ypp', label: 'Yards per play', better: 'high', of: a => (a.plays >= 50 ? a.yards / a.plays : null), fmt: v => v.toFixed(2) },
  { id: 'to', label: 'Turnover difference per game', better: 'high', of: a => (a.boxGames ? (a.take - a.give) / a.boxGames : null), fmt: v => (v > 0 ? '+' : '') + v.toFixed(2) },
  { id: 'third', label: 'Third downs converted', better: 'high', of: a => (a.thirdA >= 20 ? (100 * a.thirdM) / a.thirdA : null), fmt: v => `${v.toFixed(0)}%` },
  { id: 'rz', label: 'Red-zone trips scored', better: 'high', of: a => (a.rzA >= 5 ? (100 * a.rzM) / a.rzA : null), fmt: v => `${v.toFixed(0)}%` },
  { id: 'sacks', label: 'Sacks per game', better: 'high', of: a => (a.boxGames ? a.sacks / a.boxGames : null), fmt: v => v.toFixed(1) }
];

/** Every team's value, league rank and 1–10 score for each measure (cached 10 min per season). */
function leagueScores(season: number, league: LeagueId = 1) {
  return cached(`scores|${league}|${season}`, () => {
    const agg = seasonAgg(season, undefined, league);
    // college: only FBS teams are scored against each other (an FCS team is scored among FCS teams)
    if (league === 2) {
      const lvl = new Map((db.prepare(`SELECT team_id, level FROM nfl_teams WHERE league = 2`).all() as any[]).map(r => [r.team_id, r.level]));
      return new Map([...scoreAgg(new Map([...agg].filter(([id]) => lvl.get(id) === 'FBS'))), ...scoreAgg(new Map([...agg].filter(([id]) => lvl.get(id) !== 'FBS')))]);
    }
    return scoreAgg(agg);
  });
}
function scoreAgg(agg: Map<number, Agg>) {
  {
    const out = new Map<number, Record<string, { value: number; text: string; rank: number; of: number; score: number } | null>>();
    for (const id of agg.keys()) out.set(id, {});
    for (const m of MEASURES) {
      const vals = [...agg.entries()].map(([id, a]) => [id, m.of(a)] as [number, number | null]).filter(([, v]) => v !== null) as [number, number][];
      vals.sort((x, y) => (m.better === 'high' ? y[1] - x[1] : x[1] - y[1]));
      vals.forEach(([id, v], i) => {
        const score = vals.length > 1 ? Math.round(1 + (9 * (vals.length - 1 - i)) / (vals.length - 1)) : 5;
        out.get(id)![m.id] = { value: v, text: m.fmt(v), rank: i + 1, of: vals.length, score };
      });
      for (const id of agg.keys()) if (!(m.id in out.get(id)!)) out.get(id)![m.id] = null;
    }
    return out;
  }
}

/** Team analysis by fixed rules (fix137): strengths = league score 8+, weaknesses = 3 or less, on the six measures. */
export function nflTeamAnalysis(teamId: number, season: number) {
  const league = leagueOfTeamId(teamId);
  const s = leagueScores(season, league).get(teamId);
  if (!s) return null;
  const measures = MEASURES.map(m => ({ id: m.id, label: m.label, better: m.better, ...(s[m.id] || { value: null, text: null, rank: null, of: null, score: null }) }));
  return {
    season,
    measures,
    strengths: measures.filter(m => m.score !== null && m.score >= 8).sort((a, b) => b.score! - a.score!),
    weaknesses: measures.filter(m => m.score !== null && m.score <= 3).sort((a, b) => a.score! - b.score!),
    // rank by point difference per game after each week of the regular season
    rankByWeek: rankByWeek(teamId, season, league)
  };
}

function rankByWeek(teamId: number, season: number, league: LeagueId = 1) {
  const all = cached(`rbw|${league}|${season}`, () => {
    const weeks = (db.prepare(`SELECT DISTINCT week, stage FROM nfl_games WHERE league = ? ${HIDE_OTHER} AND season = ? AND status IN ('FT','AOT') AND stage LIKE 'Regular%'`).all(league, season) as any[])
      .map(r => Number(weekKey(r.stage, r.week))).filter(n => Number.isFinite(n)).sort((a, b) => a - b);
    const out = new Map<number, { week: number; rank: number; of: number }[]>();
    for (const w of weeks) {
      const agg = [...seasonAgg(season, w, league).entries()].filter(([, a]) => a.games > 0).map(([id, a]) => [id, (a.pf - a.pa) / a.games] as [number, number]).sort((x, y) => y[1] - x[1]);
      agg.forEach(([id], i) => { if (!out.has(id)) out.set(id, []); out.get(id)!.push({ week: w, rank: i + 1, of: agg.length }); });
    }
    return out;
  });
  return all.get(teamId) || [];
}

/* ---------- team page ---------- */

const GROUP_ORDER = ['Offense', 'Defense', 'Special Teams'];
export function nflTeam(id: number, season: number) {
  const t = nflTeamRow(id);
  if (!t) return null;
  const games = (db.prepare(`SELECT ${GAME_COLS} FROM nfl_games WHERE season = ? AND (home_id = ? OR away_id = ?) AND (stage IS NULL OR stage NOT LIKE 'Pre%') ORDER BY kickoff`).all(season, id, id) as any[]).map(shapeGame);
  const stand = nflStandings(season, leagueOfTeamId(id)).rows.find(r => r.team.id === id) || null;
  const players = db.prepare(`SELECT player_id AS id, name, position, grp, number, age, image FROM nfl_players WHERE team_id = ? ORDER BY grp, position, number`).all(id) as any[];
  const roster = GROUP_ORDER.concat([...new Set(players.map(p => p.grp || 'Other'))].filter(g => !GROUP_ORDER.includes(g)))
    .map(g => ({ group: g, players: players.filter(p => (p.grp || 'Other') === g) })).filter(x => x.players.length);
  return {
    team: t, season, standing: stand,
    schedule: games.filter(g => g.state !== 'done'),
    results: games.filter(g => g.state === 'done').reverse(),
    roster,
    injuries: db.prepare(`SELECT player_id AS id, player_name AS name, image, status, description, date FROM nfl_injuries WHERE team_id = ? ORDER BY status, player_name`).all(id),
    analysis: nflTeamAnalysis(id, season)
  };
}

/* ---------- players ---------- */

/** Add one game's statistic values into a season total ("21/30" style values add both parts; averages are skipped). */
const SKIP = /average|avg|rating|rate|long|lng|pct|percent|yards per|ypc|ypr/i;
function addStats(total: Record<string, number | [number, number]>, stats: Record<string, string>) {
  for (const [k, v] of Object.entries(stats)) {
    if (SKIP.test(k)) continue;
    const p = pair(v);
    if (p) { const c = total[k]; total[k] = Array.isArray(c) ? [c[0] + p[0], c[1] + p[1]] : p; continue; }
    const n = num(v);
    if (n === null) continue;
    const c = total[k];
    total[k] = (typeof c === 'number' ? c : 0) + n;
  }
}
const showTotal = (v: number | [number, number]) => (Array.isArray(v) ? `${v[0]}/${v[1]}` : Number.isInteger(v) ? String(v) : v.toFixed(1));

/** A player's lines in every game of a season (from the team box scores). */
function playerLines(playerId: number, season: number) {
  const rows = db.prepare(`SELECT p.game_id, p.team_id, p.json FROM nfl_player_stats p JOIN nfl_games g ON g.game_id = p.game_id WHERE g.season = ? AND p.json LIKE ? ORDER BY g.kickoff`)
    .all(season, `%"id":${playerId}%`) as any[];
  const out: { gameId: number; teamId: number; groups: Record<string, Record<string, string>> }[] = [];
  for (const r of rows) {
    const groups: Record<string, Record<string, string>> = {};
    for (const [name, list] of Object.entries(playerGroups(r.json))) { const me = list.find(p => p.id === playerId); if (me) groups[name] = me.stats; }
    if (Object.keys(groups).length) out.push({ gameId: r.game_id, teamId: r.team_id, groups });
  }
  return out;
}

export function nflPlayer(id: number, season: number) {
  const p = db.prepare(`SELECT player_id AS id, team_id, name, position, grp, number, age, height, weight, college, experience, image FROM nfl_players WHERE player_id = ?`).get(id) as any;
  const lines = playerLines(id, season);
  if (!p && !lines.length) return null;
  const totals: Record<string, Record<string, number | [number, number]>> = {};
  for (const l of lines) for (const [g, st] of Object.entries(l.groups)) addStats((totals[g] ||= {}), st);
  const gameRow = (gid: number) => shapeGame(db.prepare(`SELECT ${GAME_COLS} FROM nfl_games WHERE game_id = ?`).get(gid));
  let name = p?.name;
  if (!name && lines[0]) {
    const r = db.prepare(`SELECT json FROM nfl_player_stats WHERE game_id = ? AND team_id = ?`).get(lines[0].gameId, lines[0].teamId) as any;
    name = Object.values(playerGroups(r?.json)).flat().find(x => x.id === id)?.name || String(id);
  }
  const teamId = p?.team_id ?? lines[lines.length - 1]?.teamId ?? null;
  return {
    player: { id, name, position: p?.position || null, group: p?.grp || null, number: p?.number ?? null, age: p?.age ?? null, height: p?.height || null, weight: p?.weight || null, college: p?.college || null, experience: p?.experience ?? null, image: p?.image || null },
    team: teamId ? nflTeamRow(teamId) : null,
    season,
    games: lines.length,
    totals: Object.fromEntries(Object.entries(totals).map(([g, st]) => [g, Object.fromEntries(Object.entries(st).map(([k, v]) => [k, showTotal(v)]))])),
    log: lines.slice().reverse().map(l => ({ game: gameRow(l.gameId), teamId: l.teamId, groups: l.groups }))
  };
}

/* ---------- leaders ---------- */

const LEADERS: { id: string; label: string; group: RegExp; stat: RegExp }[] = [
  { id: 'passYds', label: 'Passing yards', group: /^passing$/i, stat: /^(yards|yds)$/i },
  { id: 'passTd', label: 'Passing touchdowns', group: /^passing$/i, stat: /touch ?downs?|^td$|^tds$/i },
  { id: 'rushYds', label: 'Rushing yards', group: /^rushing$/i, stat: /^(yards|yds)$/i },
  { id: 'recYds', label: 'Receiving yards', group: /^receiving$/i, stat: /^(yards|yds)$/i },
  { id: 'tackles', label: 'Tackles', group: /defens/i, stat: /^(total tackles|tackles|tot)$/i },
  { id: 'sacks', label: 'Sacks', group: /defens/i, stat: /^sacks?$/i },
  { id: 'ints', label: 'Interceptions', group: /defens|intercept/i, stat: /^(interceptions|int)$/i }
];

export function nflLeaders(season: number, top = 5, league: LeagueId = 1) {
  return cached(`leaders|${league}|${season}|${top}`, () => {
    const sums = new Map<string, Map<number, { id: number; name: string; image: string | null; teamId: number; value: number }>>();
    for (const L of LEADERS) sums.set(L.id, new Map());
    for (const r of db.prepare(`SELECT p.team_id, p.json FROM nfl_player_stats p JOIN nfl_games g ON g.game_id = p.game_id WHERE g.league = ? AND g.season = ? AND (g.stage IS NULL OR g.stage NOT LIKE 'Pre%')`).all(league, season) as any[]) {
      for (const [gname, list] of Object.entries(playerGroups(r.json))) {
        for (const L of LEADERS) {
          if (!L.group.test(gname)) continue;
          for (const pl of list) {
            const key = Object.keys(pl.stats).find(k => L.stat.test(k));
            const v = key ? num(pl.stats[key]) : null;
            if (v === null) continue;
            const m = sums.get(L.id)!;
            const cur = m.get(pl.id) || { id: pl.id, name: pl.name, image: pl.image, teamId: r.team_id, value: 0 };
            cur.value += v;
            m.set(pl.id, cur);
          }
        }
      }
    }
    return LEADERS.map(L => ({
      id: L.id, label: L.label,
      rows: [...sums.get(L.id)!.values()].filter(x => x.value > 0).sort((a, b) => b.value - a.value).slice(0, top)
        .map(x => ({ ...x, team: nflTeamRow(x.teamId) ? { id: x.teamId, name: nflTeamRow(x.teamId)!.name, logo: nflTeamRow(x.teamId)!.logo } : null }))
    })).filter(c => c.rows.length);
  });
}

/* ---------- fix150: college list diagnostics ---------- */

/**
 * What the college lists see: the current season, its weeks (keys + game counts), the default week and its games, the
 * season's games with and without the 'other' filter, team levels and the raw (stage, week) values. Logged once after
 * boot ("college lists: season S, week W, n games") and at /api/admin/nfl-college-debug.
 */
export function collegeListsDebug() {
  const season = nflCurrentSeason(2);
  const all = season ? (db.prepare(`SELECT COUNT(*) AS n FROM nfl_games WHERE league = 2 AND season = ?`).get(season) as any).n : 0;
  const shown = season ? (db.prepare(`SELECT COUNT(*) AS n FROM nfl_games WHERE league = 2 ${HIDE_OTHER} AND season = ?`).get(season) as any).n : 0;
  const w = season ? nflWeeks(season, 2) : { weeks: [], current: null };
  const games = season && w.current ? nflWeekGames(season, w.current, 2).length : 0;
  const raw = season ? db.prepare(`SELECT stage, week, COUNT(*) AS n FROM nfl_games WHERE league = 2 AND season = ? GROUP BY stage, week ORDER BY MIN(kickoff) LIMIT 40`).all(season) : [];
  const levels = db.prepare(`SELECT COALESCE(level, 'unknown') AS level, COUNT(*) AS n FROM nfl_teams WHERE league = 2 GROUP BY level`).all();
  const seasons = db.prepare(`SELECT season, COUNT(*) AS n FROM nfl_games WHERE league = 2 GROUP BY season ORDER BY season DESC LIMIT 4`).all();
  const now = new Date();
  const today = season ? nflGamesBetween(new Date(now.getTime() - 12 * 3600e3).toISOString(), new Date(now.getTime() + 12 * 3600e3).toISOString(), 2).length : 0;
  return { season, seasons, gamesInSeason: all, shownAfterHideOther: shown, weeks: w.weeks.map(x => `${x.key}:${x.games}`), current: w.current, currentWeekGames: games, next24h: today, levels, rawStageWeek: raw };
}

/* ---------- search, SEO helpers ---------- */

export function nflTeamsList(league?: LeagueId): (NflSide & { league: LeagueId })[] {
  return (db.prepare(`SELECT team_id AS id, name, logo, league FROM nfl_teams ${league ? 'WHERE league = ' + Number(league) : ''} ORDER BY name`).all() as any[]);
}

/** Search (fix144): teams, players and coming games of the NFL and college football (the basketball search's shape). */
export function nflSearch(q: string) {
  const term = q.replace(/[%_]/g, '').trim();
  if (term.length < 2) return { teams: [], players: [], leagues: [], games: [] };
  const like = `%${term}%`, start = `${term}%`;
  const lname = (l: number) => (l === 2 ? 'College football' : 'NFL');
  const teams = (db.prepare(`SELECT team_id AS id, name, logo, league FROM nfl_teams WHERE (level IS NULL OR level != 'other') AND name LIKE ? ORDER BY (name LIKE ?) DESC, league, name LIMIT 8`).all(like, start) as any[])
    .map(t => ({ id: t.id, name: t.name, logo: t.logo || null, league: lname(t.league) }));
  const players = (db.prepare(`SELECT p.player_id AS id, p.name, p.position, t.name AS team, t.logo AS teamLogo, t.league FROM nfl_players p LEFT JOIN nfl_teams t ON t.team_id = p.team_id
    WHERE p.name LIKE ? ORDER BY (p.name LIKE ?) DESC, p.name LIMIT 6`).all(like, start) as any[])
    .map(p => ({ id: p.id, name: p.name, team: p.team || '', teamLogo: p.teamLogo || null, league: lname(p.league || 1), position: p.position || null }));
  const games = (db.prepare(`SELECT game_id AS id, kickoff, status, league, home_name AS home, away_name AS away FROM nfl_games
    WHERE (home_name LIKE ? OR away_name LIKE ?) ${HIDE_OTHER} AND kickoff >= ? AND kickoff < ? AND (stage IS NULL OR stage NOT LIKE 'Pre%') ORDER BY kickoff LIMIT 6`)
    .all(like, like, new Date(Date.now() - 5 * 3600000).toISOString(), new Date(Date.now() + 14 * 86400000).toISOString()) as any[])
    .map(g => ({ id: g.id, kickoff: g.kickoff, status: g.status, league: lname(g.league), home: g.home || 'TBD', away: g.away || 'TBD' }));
  // fix174: the two leagues (their standings pages) when the term matches
  const t = term.toLowerCase();
  const leagues = [
    { code: 'NFL', name: 'NFL', country: 'USA', logo: null as string | null, keys: ['nfl', 'national football league', 'american football'] },
    { code: 'NCAA', name: 'College football', country: 'USA', logo: null as string | null, keys: ['college', 'ncaa', 'fbs', 'american football'] }
  ].filter(l => l.keys.some(k => k.startsWith(t) || t.startsWith(k) || k.includes(t))).map(({ keys, ...l }) => l);
  return { teams, players, leagues, games };
}
