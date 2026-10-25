/**
 * NFL + college game page extras (fix174), the parts football and basketball game pages have:
 *  - Schedule & rest: each team's last 5 / next 5 games, days of rest (short week / off a bye), the bye week;
 *  - Standings: the division (NFL) or conference (college) tables that hold the two teams;
 *  - Starters: QB, RB, WR1-2, TE and the defence leaders of each team (season stats from the box scores, the roster's
 *    position), with the injury report status;
 *  - Before vs after: the first prediction saved for the game against the current one, with the players who joined
 *    the injury report since (and a quarterback change);
 *  - Written preview (English, no pick, no %), for the game page, the crawler page and the weekly hub;
 *  - Scoring plays (API-American-Football games/events, stored after full time) when the provider has them.
 */
import { db } from '../db';
import { shapeGame, GAME_COLS, nflStandings, playerGroups, weekKey, type NflGame } from './nflSite';
import type { LeagueId } from './nfl';

db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_pred_first (game_id INTEGER PRIMARY KEY, p_home REAL NOT NULL, margin REAL, outs TEXT, qb TEXT, made_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS nfl_events (game_id INTEGER PRIMARY KEY, json TEXT, updated_at TEXT NOT NULL);
`);

const DAY = 86400000;
const num = (x: any): number | null => { if (x === null || x === undefined || x === '') return null; const n = Number(String(x).replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
const OUT = /out|doubtful|injured reserve|^ir$|reserve/i;

/* ---------- schedule & rest ---------- */

export interface NflBrief { id: number; kickoff: string; league: string; home: boolean; opponent: string; opponentId: number; opponentLogo: string | null; score: string | null; result: 'W' | 'L' | 'T' | null }
export interface NflSched { restDays: number | null; backToBack: boolean; offBye: boolean; bye: string | null; games7: number; away7: number; nextIn: number | null; recent: NflBrief[]; upcoming: NflBrief[] }

function brief(g: NflGame, teamId: number): NflBrief {
  const home = g.home.id === teamId, opp = home ? g.away : g.home;
  const f = g.score ? (home ? g.score.home : g.score.away) : null, a = g.score ? (home ? g.score.away : g.score.home) : null;
  return {
    id: g.id, kickoff: g.kickoff, league: g.league === 2 ? 'College football' : 'NFL', home, opponent: opp.name, opponentId: opp.id, opponentLogo: opp.logo,
    score: g.state === 'done' && f !== null && a !== null ? `${f}-${a}` : null,
    result: g.state === 'done' && f !== null && a !== null ? (f > a ? 'W' : f < a ? 'L' : 'T') : null
  };
}

export function nflSchedule(teamId: number, g: NflGame): NflSched {
  const rows = (db.prepare(`SELECT ${GAME_COLS} FROM nfl_games WHERE (home_id = ? OR away_id = ?) AND season = ? AND (stage IS NULL OR stage NOT LIKE 'Pre%') ORDER BY kickoff`).all(teamId, teamId, g.season) as any[]).map(shapeGame);
  const ko = Date.parse(g.kickoff);
  const before = rows.filter(x => Date.parse(x.kickoff) < ko - 3600000 && x.id !== g.id);
  const after = rows.filter(x => Date.parse(x.kickoff) > ko + 3600000 && x.id !== g.id);
  const last = before[before.length - 1], next = after[0];
  const restDays = last ? Math.round(((ko - Date.parse(last.kickoff)) / DAY) * 10) / 10 : null;
  // bye: a regular-season week with no game for this team (between its first and last week)
  const weeks = rows.map(x => weekKey(x.stage, x.week)).filter(k => /^\d+$/.test(k)).map(Number);
  let bye: string | null = null;
  if (weeks.length) {
    const have = new Set(weeks), max = Math.max(...weeks), cur = Number(weekKey(g.stage, g.week));
    const gaps = [];
    for (let w = Math.min(...weeks); w <= max; w++) if (!have.has(w)) gaps.push(w);
    // the bye nearest to this game (the last one before it, else the next one)
    const pickW = gaps.filter(w => !Number.isFinite(cur) || w < cur).pop() ?? gaps[0];
    if (pickW !== undefined) bye = `Week ${pickW}`;
  }
  return {
    restDays, backToBack: restDays !== null && restDays < 6.5, offBye: restDays !== null && restDays >= 12 && restDays < 30, bye,
    games7: before.filter(x => ko - Date.parse(x.kickoff) <= 14 * DAY).length, away7: 0,
    nextIn: next ? Math.round(((Date.parse(next.kickoff) - ko) / DAY) * 10) / 10 : null,
    recent: before.slice(-5).reverse().map(x => brief(x, teamId)), upcoming: after.slice(0, 5).map(x => brief(x, teamId))
  };
}

/* ---------- standings ---------- */

/** The division (NFL) or conference (college) tables holding either team, the two teams marked by the page. */
export function nflGameStandings(g: NflGame) {
  const st = nflStandings(g.season, g.league as LeagueId);
  const out: { conference: string; name: string; rows: any[] }[] = [];
  for (const c of st.conferences) for (const d of c.divisions) {
    if (d.rows.some(r => r.team.id === g.home.id || r.team.id === g.away.id)) out.push({ conference: c.name, name: d.name, rows: d.rows });
  }
  return out.length ? { season: st.season, league: g.league, tables: out } : null;
}

/* ---------- starters ---------- */

interface Starter { id: number; name: string; position: string; image: string | null; line: string | null; status: string | null; out: boolean }
const PICKS: { pos: string; group: RegExp; stat: RegExp; want: RegExp | null; n: number; unit: string }[] = [
  { pos: 'QB', group: /^passing$/i, stat: /^(yards|yds)$/i, want: /^QB$/i, n: 1, unit: 'pass yds' },
  { pos: 'RB', group: /^rushing$/i, stat: /^(yards|yds)$/i, want: /^(RB|HB|FB)$/i, n: 1, unit: 'rush yds' },
  { pos: 'WR', group: /^receiving$/i, stat: /^(yards|yds)$/i, want: /^WR$/i, n: 2, unit: 'rec yds' },
  { pos: 'TE', group: /^receiving$/i, stat: /^(yards|yds)$/i, want: /^TE$/i, n: 1, unit: 'rec yds' },
  { pos: 'Tackles', group: /defens/i, stat: /^(total tackles|tackles|tot)$/i, want: null, n: 1, unit: 'tackles' },
  { pos: 'Sacks', group: /defens/i, stat: /^sacks?$/i, want: null, n: 1, unit: 'sacks' }
];

/** The likely starters of a team for this game: season leaders by position, injury status from the latest report. */
export function nflStarters(teamId: number, season: number): Starter[] {
  const sums = PICKS.map(() => new Map<number, { id: number; name: string; image: string | null; v: number; g: number }>());
  for (const r of db.prepare(`SELECT p.json FROM nfl_player_stats p JOIN nfl_games g ON g.game_id = p.game_id WHERE p.team_id = ? AND g.season = ? AND (g.stage IS NULL OR g.stage NOT LIKE 'Pre%')`).all(teamId, season) as any[]) {
    for (const [gname, list] of Object.entries(playerGroups(r.json))) {
      PICKS.forEach((P, i) => {
        if (!P.group.test(gname)) return;
        for (const pl of list) {
          const key = Object.keys(pl.stats).find(k => P.stat.test(k));
          const v = key ? num(pl.stats[key]) : null;
          if (v === null) continue;
          const cur = sums[i].get(pl.id) || { id: pl.id, name: pl.name, image: pl.image, v: 0, g: 0 };
          cur.v += v; cur.g++;
          sums[i].set(pl.id, cur);
        }
      });
    }
  }
  const pos = new Map((db.prepare(`SELECT player_id, position, name, image FROM nfl_players WHERE team_id = ?`).all(teamId) as any[]).map(p => [p.player_id, p]));
  const inj = new Map((db.prepare(`SELECT player_id, status FROM nfl_injuries WHERE team_id = ?`).all(teamId) as any[]).map(r => [r.player_id, r.status as string]));
  const used = new Set<number>();
  const out: Starter[] = [];
  PICKS.forEach((P, i) => {
    const list = [...sums[i].values()]
      .filter(x => !used.has(x.id) && x.v > 0 && (!P.want || !pos.get(x.id)?.position || P.want.test(String(pos.get(x.id)?.position))))
      .sort((a, b) => b.v - a.v)
      .slice(0, P.n);
    for (const x of list) {
      used.add(x.id);
      const st = inj.get(x.id) || null;
      const v = Number.isInteger(x.v) ? x.v : Math.round(x.v * 10) / 10;
      out.push({ id: x.id, name: x.name || pos.get(x.id)?.name || String(x.id), position: P.want ? P.pos : String(pos.get(x.id)?.position || P.pos), image: x.image || pos.get(x.id)?.image || null,
        line: `${v} ${P.unit} in ${x.g} game${x.g === 1 ? '' : 's'}`, status: st, out: !!st && OUT.test(st) });
    }
  });
  return out;
}

/* ---------- fix224: key players (the shared card: basketball's top 5 by impact) ---------- */

/** points a game: passing yards / 25, rushing and receiving yards / 10, 6 a touchdown (4 thrown), −2 an interception, tackles, sacks ×2 */
const VAL: { group: RegExp; stat: RegExp; w: number }[] = [
  { group: /^passing$/i, stat: /^(yards|yds)$/i, w: 1 / 25 }, { group: /^passing$/i, stat: /^(passing touch downs|touchdowns|td|tds|passing touchdowns)$/i, w: 4 },
  { group: /^passing$/i, stat: /^(interceptions|int)$/i, w: -2 },
  { group: /^rushing$/i, stat: /^(yards|yds)$/i, w: 0.1 }, { group: /^rushing$/i, stat: /^(rushing touch downs|touchdowns|td|tds|rushing touchdowns)$/i, w: 6 },
  { group: /^receiving$/i, stat: /^(yards|yds)$/i, w: 0.1 }, { group: /^receiving$/i, stat: /^(receiving touch downs|touchdowns|td|tds|receiving touchdowns)$/i, w: 6 },
  { group: /defens/i, stat: /^(total tackles|tackles|tot)$/i, w: 0.5 }, { group: /defens/i, stat: /^sacks?$/i, w: 2 }
];
export interface NflKey { id: number; name: string; position: string | null; image: string | null; perGame: number; games: number; line: string | null; status: string | null; out: boolean; without: number | null }
/**
 * The key players of a team: the starting QB first, then the top players by games × value a game (no snap counts in
 * our data), with the injury report status. without = what the model takes off without him (QB only: the other
 * positions are not priced by nfl-v1).
 */
export function nflKeyPlayers(teamId: number, season: number, qb: { id: number; points: number } | null): NflKey[] {
  const acc = new Map<number, { id: number; name: string; image: string | null; v: number; games: Set<number>; pass: number }>();
  for (const r of db.prepare(`SELECT p.game_id, p.json FROM nfl_player_stats p JOIN nfl_games g ON g.game_id = p.game_id WHERE p.team_id = ? AND g.season = ? AND (g.stage IS NULL OR g.stage NOT LIKE 'Pre%')`).all(teamId, season) as any[]) {
    for (const [gname, list] of Object.entries(playerGroups(r.json))) {
      const rules = VAL.filter(v => v.group.test(gname));
      if (!rules.length) continue;
      for (const pl of list) {
        const cur = acc.get(pl.id) || { id: pl.id, name: pl.name, image: pl.image, v: 0, games: new Set<number>(), pass: 0 };
        for (const v of rules) { const k = Object.keys(pl.stats).find(x => v.stat.test(x)); const n = k ? num(pl.stats[k]) : null; if (n !== null) { cur.v += n * v.w; if (/^passing$/i.test(gname) && /^(yards|yds)$/i.test(k!)) cur.pass += n; } }
        cur.games.add(r.game_id);
        acc.set(pl.id, cur);
      }
    }
  }
  const pos = new Map((db.prepare(`SELECT player_id, position, name, image FROM nfl_players WHERE team_id = ?`).all(teamId) as any[]).map(p => [p.player_id, p]));
  const inj = new Map((db.prepare(`SELECT player_id, status FROM nfl_injuries WHERE team_id = ?`).all(teamId) as any[]).map(r => [r.player_id, r.status as string]));
  const all = [...acc.values()].filter(x => x.v > 0 && x.games.size);
  const starter = qb ? all.find(x => x.id === qb.id) : [...all].sort((a, b) => b.pass - a.pass)[0];
  const rest = all.filter(x => x !== starter).sort((a, b) => b.v - a.v);
  return [...(starter ? [starter] : []), ...rest].slice(0, 5).map(x => {
    const st = inj.get(x.id) || null;
    const isQb = !!starter && x.id === starter.id;
    return {
      id: x.id, name: x.name || pos.get(x.id)?.name || String(x.id), position: isQb ? 'QB' : pos.get(x.id)?.position || null, image: x.image || pos.get(x.id)?.image || null,
      perGame: Math.round((x.v / x.games.size) * 10) / 10, games: x.games.size, line: null, status: st, out: !!st && OUT.test(st),
      without: isQb && qb && qb.id === x.id ? qb.points : null
    };
  });
}

/* ---------- before vs after (injury news, quarterback change) ---------- */

const outsOf = (teamId: number) => (db.prepare(`SELECT player_id, status FROM nfl_injuries WHERE team_id = ?`).all(teamId) as any[]).filter(r => OUT.test(String(r.status || ''))).map(r => r.player_id as number);

/** Called when a prediction is saved: the first version of each game is kept (with who was out then). */
export function rememberFirstPrediction(gameId: number, homeId: number, awayId: number, pHome: number, margin: number, qb: any, at: string) {
  db.prepare(`INSERT OR IGNORE INTO nfl_pred_first (game_id, p_home, margin, outs, qb, made_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(gameId, pHome, margin, JSON.stringify([...outsOf(homeId), ...outsOf(awayId)]), JSON.stringify((qb || []).map((q: any) => q?.name || null)), at);
}

/** The first saved prediction against the current one when they differ by 3+ points and someone joined the report. */
export function nflBeforeAfter(g: NflGame, cur: { pHome: number; why?: any } | null) {
  if (!cur || g.state !== 'upcoming') return null;
  const f = db.prepare(`SELECT p_home, margin, outs, qb, made_at FROM nfl_pred_first WHERE game_id = ?`).get(g.id) as any;
  if (!f) return null;
  const before = Math.round(f.p_home * 1000) / 10;
  if (Math.abs(before - cur.pHome) < 3) return null;
  let was: number[] = []; try { was = JSON.parse(f.outs || '[]'); } catch { was = []; }
  const now = [...outsOf(g.home.id), ...outsOf(g.away.id)];
  const fresh = now.filter(id => !was.includes(id));
  const who = (id: number) => {
    const r = db.prepare(`SELECT i.player_name AS name, i.team_id, i.status, p.position FROM nfl_injuries i LEFT JOIN nfl_players p ON p.player_id = i.player_id WHERE i.player_id = ?`).get(id) as any;
    return r ? { id, name: r.name, position: r.position || null, status: r.status || null, side: r.team_id === g.home.id ? 'H' as const : 'A' as const } : null;
  };
  const players = fresh.map(who).filter(Boolean).slice(0, 10);
  let qbWas: (string | null)[] = []; try { qbWas = JSON.parse(f.qb || '[]'); } catch { qbWas = []; }
  const qbNow: (string | null)[] = (cur.why?.qb || []).map((q: any) => q?.name || null);
  const qb = [0, 1].map(i => (qbWas[i] && qbNow[i] && qbWas[i] !== qbNow[i] ? { side: i === 0 ? 'H' : 'A', was: qbWas[i], now: qbNow[i] } : null)).filter(Boolean);
  if (!players.length && !qb.length) return null;
  return { before: { pHome: before, pAway: Math.round((100 - before) * 10) / 10, at: f.made_at }, after: { pHome: cur.pHome, pAway: Math.round((100 - cur.pHome) * 10) / 10 }, players, qb };
}

/* ---------- scoring plays ---------- */

// stored by nfl.ts (syncBoxScore) after full time; [] = the provider has none for the game
export function nflEvents(gameId: number): any[] | null {
  const r = db.prepare(`SELECT json FROM nfl_events WHERE game_id = ?`).get(gameId) as any;
  if (!r) return null;
  try { return JSON.parse(r.json); } catch { return null; }
}

/* ---------- written preview ---------- */

function hash(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }
const pick = <T>(id: number, slot: string, list: T[]): T => list[hash(`nfl:${id}:${slot}`) % list.length];
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const nw = (n: number) => (n >= 0 && n <= 10 ? ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'][n] : String(n));
const FINAL = "See SportLikely's prediction for this game.";

function seasonRecord(teamId: number, season: number, before: string) {
  const rows = db.prepare(`SELECT home_id, home_pts, away_pts FROM nfl_games WHERE (home_id = ? OR away_id = ?) AND season = ? AND kickoff < ? AND status IN ('FT','AOT') AND home_pts IS NOT NULL AND (stage IS NULL OR stage NOT LIKE 'Pre%')`).all(teamId, teamId, season, before) as any[];
  let w = 0, l = 0, t = 0;
  for (const r of rows) { const f = r.home_id === teamId ? r.home_pts : r.away_pts, a = r.home_id === teamId ? r.away_pts : r.home_pts; if (f > a) w++; else if (f < a) l++; else t++; }
  return { w, l, t, n: rows.length };
}

/**
 * 100–180 words of plain English about one game, from our own tables (records, last five, meetings, rest, the starting
 * quarterbacks and the injury report). Never the pick or a percentage: the same text for visitors and crawlers.
 */
export function nflPreviewText(id: number, qbNames?: [string | null, string | null]): string | null {
  const r = db.prepare(`SELECT ${GAME_COLS} FROM nfl_games WHERE game_id = ?`).get(id) as any;
  if (!r) return null;
  const g = shapeGame(r);
  const H = g.home.name, A = g.away.name, past = g.state === 'done';
  const lg = g.league === 2 ? 'college football' : 'NFL';
  const wk = g.weekKey === 'post' ? (g.league === 2 ? 'bowl season' : 'the playoffs') : g.weekKey === 'pre' ? 'the pre-season' : `Week ${g.weekKey}`;
  const when = new Date(g.kickoff).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const parts: { prio: number; text: string }[] = [];
  const add = (prio: number, text: string | null) => { if (text) parts.push({ prio, text }); };
  add(0, past
    ? pick(id, 'intro', [`${H} hosted ${A} in ${wk} of the ${lg} season on ${when}.`, `On ${when}, ${A} visited ${H} (${lg}, ${wk}).`])
    : pick(id, 'intro', [`${H} host ${A} in ${wk} of the ${lg} season on ${when}.`, `On ${when}, ${A} visit ${H} (${lg}, ${wk}).`, `${wk} of the ${lg} season brings ${A} to ${H} on ${when}.`]));
  if (g.venue) add(3, `The game is played at ${g.venue}.`);
  if (past && g.score) add(0, `Final score: ${H} ${g.score.home}–${g.score.away} ${A}.`);
  const rh = seasonRecord(g.home.id, g.season, g.kickoff), ra = seasonRecord(g.away.id, g.season, g.kickoff);
  const rec = (x: typeof rh) => `${x.w}-${x.l}${x.t ? `-${x.t}` : ''}`;
  if (rh.n >= 2 && ra.n >= 2) add(1, pick(id, 'rec', [`${H} ${past ? 'were' : 'are'} ${rec(rh)} this season and ${A} ${rec(ra)}.`, `Season records: ${H} ${rec(rh)}, ${A} ${rec(ra)}.`]));
  for (const [T, tid] of [[H, g.home.id], [A, g.away.id]] as const) {
    const games = (db.prepare(`SELECT home_id, home_pts, away_pts FROM nfl_games WHERE (home_id = ? OR away_id = ?) AND kickoff < ? AND status IN ('FT','AOT') AND home_pts IS NOT NULL AND (stage IS NULL OR stage NOT LIKE 'Pre%') ORDER BY kickoff DESC LIMIT 5`).all(tid, tid, g.kickoff) as any[]);
    if (games.length < 3) continue;
    let w = 0, pf = 0, pa = 0;
    for (const x of games) { const f = x.home_id === tid ? x.home_pts : x.away_pts, a = x.home_id === tid ? x.away_pts : x.home_pts; if (f > a) w++; pf += f; pa += a; }
    add(1, pick(id, `form-${tid}`, [
      `${T} ${past ? 'had' : 'have'} won ${nw(w)} of their last ${nw(games.length)}, scoring ${(pf / games.length).toFixed(1)} and allowing ${(pa / games.length).toFixed(1)} points a game.`,
      `Over their last ${nw(games.length)} games ${T} went ${w}-${games.length - w}, averaging ${(pf / games.length).toFixed(1)} points for and ${(pa / games.length).toFixed(1)} against.`
    ]));
  }
  const h2h = db.prepare(`SELECT home_id, home_name, away_name, home_pts, away_pts FROM nfl_games WHERE ((home_id = ? AND away_id = ?) OR (home_id = ? AND away_id = ?)) AND kickoff < ? AND status IN ('FT','AOT') AND home_pts IS NOT NULL ORDER BY kickoff DESC LIMIT 5`)
    .all(g.home.id, g.away.id, g.away.id, g.home.id, g.kickoff) as any[];
  if (h2h.length) {
    const hw = h2h.filter(x => (x.home_id === g.home.id ? x.home_pts > x.away_pts : x.away_pts > x.home_pts)).length;
    const l = h2h[0];
    add(2, `In their last ${nw(h2h.length)} meetings ${H} won ${nw(hw)}; the most recent ended ${l.home_name} ${l.home_pts}–${l.away_pts} ${l.away_name}.`);
  } else add(3, 'This is the first meeting between the two teams in our records.');
  if (!past) {
    const sh = nflSchedule(g.home.id, g), sa = nflSchedule(g.away.id, g);
    const restLine = (T: string, s: NflSched) => (s.offBye ? `${T} come off a bye week` : s.backToBack ? `${T} play on a short week (${Math.floor(s.restDays!)} days of rest)` : null);
    const lines = [restLine(H, sh), restLine(A, sa)].filter(Boolean);
    if (lines.length) add(2, lines.join(', and ') + '.');
    if (qbNames && (qbNames[0] || qbNames[1])) add(2, `Expected quarterbacks: ${[qbNames[0] ? `${qbNames[0]} for ${H}` : '', qbNames[1] ? `${qbNames[1]} for ${A}` : ''].filter(Boolean).join(' and ')}.`);
    const ruled = (tid: number) => (db.prepare(`SELECT player_name AS name, status FROM nfl_injuries WHERE team_id = ?`).all(tid) as any[]).filter(x => /^out$/i.test(String(x.status || '').trim())).slice(0, 3).map(x => x.name);
    const oh = ruled(g.home.id), oa = ruled(g.away.id);
    if (oh.length || oa.length) add(2, [oh.length ? `${H} have ruled out ${oh.join(', ')}` : '', oa.length ? `${A} are without ${oa.join(', ')}` : ''].filter(Boolean).join(', while ') + '.');
  }
  const fillers = [
    `Kick-off ${past ? 'was' : 'is'} at ${new Date(g.kickoff).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC.`,
    'The game page also covers the expected margin, total points, the predicted score, rest and the injury report.',
    'Every SportLikely prediction is saved before kick-off and checked against the result afterwards.',
    'The numbers in this preview come from our own records of the games we cover.'
  ];
  let i = 0;
  const all = () => [...parts.map(p => p.text), FINAL].join(' ');
  while (words(all()) < 100 && i < fillers.length) parts.push({ prio: 5, text: fillers[i++] });
  while (words(all()) > 180) {
    const drop = parts.filter(p => p.prio > 0).sort((a, b) => b.prio - a.prio)[0];
    if (!drop) break;
    parts.splice(parts.indexOf(drop), 1);
  }
  return all();
}

const previewCache = new Map<number, { at: number; text: string | null }>();
/** The preview of a game (cached 30 minutes). */
export function nflPreview(id: number, qbNames?: [string | null, string | null]): string | null {
  const c = previewCache.get(id);
  if (c && Date.now() - c.at < 30 * 60 * 1000) return c.text;
  const text = nflPreviewText(id, qbNames);
  previewCache.set(id, { at: Date.now(), text });
  if (previewCache.size > 3000) for (const [k, v] of previewCache) if (Date.now() - v.at > 30 * 60 * 1000) previewCache.delete(k);
  return text;
}
