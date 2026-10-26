/**
 * Basketball player pages and team squads (Oct 2026).
 * Every league: built from our API-Basketball box scores (bb_player_stats), keyed by API-Basketball player id.
 * NBA players also get balldontlie data (services/bdl.ts): bio, full box lines with plus-minus, advanced stats per game,
 * season averages with league ranks, injury status and contract.
 */
import { db } from '../db';
import { BB_LEAGUES, bbGet } from './basketball';
import logger from '../utils/logger';
import { isPreseason } from './bbModel';
import { nbaKey } from './bbInjuries';
import { bdlPlayerOf, bdlTeamOf, bdlSeasonNow, bdlContract, personKey } from './bdl';
import { isCrawlerRequest } from './afUsage';
import { yieldLoop, yieldEvery } from './perf';
import { runsJobs } from './role';
import { onState, publishState } from './shared';
import { photoUrl } from './playerPhotos';
import { playerImpact } from './keyPlayers';

db.exec(`
  CREATE TABLE IF NOT EXISTS bb_roster (
    team_id INTEGER NOT NULL, season TEXT NOT NULL, player_id INTEGER NOT NULL, name TEXT NOT NULL,
    number TEXT, country TEXT, position TEXT, age INTEGER, updated_at TEXT NOT NULL,
    PRIMARY KEY (team_id, season, player_id)
  );
  CREATE INDEX IF NOT EXISTS idx_bb_roster_player ON bb_roster(player_id);
`);

// fix166: when the provider was last asked for a squad (also when it had none: an empty answer is not asked again every view)
db.exec(`CREATE TABLE IF NOT EXISTS bb_roster_check (team_id INTEGER NOT NULL, season TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (team_id, season))`);

/**
 * A team's current squad from API-Basketball (on failure the last stored list is used). fix166: refreshed once a day,
 * every 6 hours when the team has played in the last 24 hours; crawlers get the stored list (never a provider call).
 */
async function rosterOf(teamId: number, season: string) {
  const read = () => db.prepare(`SELECT * FROM bb_roster WHERE team_id = ? AND season = ? ORDER BY name`).all(teamId, season) as any[];
  const have = read();
  if (isCrawlerRequest()) return have;
  const checked: any = db.prepare(`SELECT at FROM bb_roster_check WHERE team_id = ? AND season = ?`).get(teamId, season);
  const at = Math.max(have.length ? Date.parse(have[0].updated_at) : 0, checked ? Date.parse(checked.at) : 0);
  const played = !!db.prepare(`SELECT 1 FROM bb_games WHERE (home_id = ? OR away_id = ?) AND status IN ('FT','AOT') AND kickoff > ? AND kickoff <= ? LIMIT 1`)
    .get(teamId, teamId, new Date(Date.now() - 24 * 3600000).toISOString(), new Date().toISOString());
  if (Date.now() - at < (played ? 6 : 24) * 3600000) return have;
  db.prepare(`INSERT OR REPLACE INTO bb_roster_check (team_id, season, at) VALUES (?, ?, ?)`).run(teamId, season, new Date().toISOString());
  try {
    const j = await bbGet('/players', { team: teamId, season });
    const list = (j.response || []) as any[];
    if (list.length) {
      const now = new Date().toISOString();
      const up = db.prepare(`INSERT OR REPLACE INTO bb_roster (team_id, season, player_id, name, number, country, position, age, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      db.exec('BEGIN');
      try {
        db.prepare(`DELETE FROM bb_roster WHERE team_id = ? AND season = ?`).run(teamId, season);
        for (const x of list) if (x.id && x.name) up.run(teamId, season, x.id, x.name, x.number ?? null, x.country ?? null, x.position ?? null, x.age ?? null, now);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    } else if (have.length) {
      db.prepare(`UPDATE bb_roster SET updated_at = ? WHERE team_id = ? AND season = ?`).run(new Date().toISOString(), teamId, season);
    }
  } catch (e: any) {
    logger.warn(`Basketball roster ${teamId}/${season}: ${e.message}`);
  }
  return read();
}

const r1 = (x: number | null | undefined) => (x == null || !isFinite(x) ? null : Math.round(x * 10) / 10);
const pct = (m: number, a: number) => (a > 0 ? Math.round((1000 * m) / a) / 10 : null);
const leagueName = (code: string) => BB_LEAGUES.find(l => l.code === code)?.name || code;
const parse = (s: string | null) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

/** "James LeBron" (API-Basketball) → the name as people write it, when balldontlie knows the player. */
function displayName(name: string, bdl: any | null) {
  return bdl ? `${bdl.first} ${bdl.last}`.trim() : name;
}

function sums(rows: any[]) {
  const s = { gp: 0, min: 0, pts: 0, reb: 0, ast: 0, fgm: 0, fga: 0, tpm: 0, tpa: 0, ftm: 0, fta: 0, starts: 0 };
  for (const r of rows) {
    if (!(r.minutes > 0)) continue;
    s.gp++; s.min += r.minutes; s.pts += r.pts || 0; s.reb += r.reb || 0; s.ast += r.ast || 0;
    s.fgm += r.fgm || 0; s.fga += r.fga || 0; s.tpm += r.tpm || 0; s.tpa += r.tpa || 0; s.ftm += r.ftm || 0; s.fta += r.fta || 0; s.starts += r.starter ? 1 : 0;
  }
  const per = (x: number) => (s.gp ? r1(x / s.gp) : null);
  return { gp: s.gp, starts: s.starts, min: per(s.min), pts: per(s.pts), reb: per(s.reb), ast: per(s.ast), fgPct: pct(s.fgm, s.fga), tpPct: pct(s.tpm, s.tpa), ftPct: pct(s.ftm, s.fta), tpm: per(s.tpm) };
}

/** Pick the advanced / traditional season numbers we show (with league ranks where balldontlie gives them). */
function seasonLine(base: any, adv: any) {
  if (!base && !adv) return null;
  const b = base || {}, a = adv || {};
  const rank = (o: any, k: string) => (o[`${k}_rank`] != null ? o[`${k}_rank`] : null);
  return {
    gp: b.gp ?? a.gp ?? null, min: b.min ?? a.min ?? null,
    pts: b.pts ?? null, reb: b.reb ?? null, ast: b.ast ?? null, stl: b.stl ?? null, blk: b.blk ?? null, tov: b.tov ?? null,
    fgPct: b.fg_pct != null ? r1(b.fg_pct * 100) : null, tpPct: b.fg3_pct != null ? r1(b.fg3_pct * 100) : null, ftPct: b.ft_pct != null ? r1(b.ft_pct * 100) : null,
    plusMinus: b.plus_minus ?? null,
    pie: a.pie != null ? r1(a.pie * 100) : null, usg: a.usg_pct != null ? r1(a.usg_pct * 100) : null, ts: a.ts_pct != null ? r1(a.ts_pct * 100) : null,
    ortg: a.off_rating ?? null, drtg: a.def_rating ?? null, net: a.net_rating ?? null, astPct: a.ast_pct != null ? r1(a.ast_pct * 100) : null, rebPct: a.reb_pct != null ? r1(a.reb_pct * 100) : null,
    ranks: { pts: rank(b, 'pts'), reb: rank(b, 'reb'), ast: rank(b, 'ast'), stl: rank(b, 'stl'), blk: rank(b, 'blk'), pie: rank(a, 'pie'), net: rank(a, 'net_rating'), ts: rank(a, 'ts_pct'), usg: rank(a, 'usg_pct') }
  };
}

function nbaSeason(bdlId: number, season: number) {
  const rows = db.prepare(`SELECT kind, stats FROM bdl_season WHERE player_id = ? AND season = ?`).all(bdlId, season) as any[];
  const base = parse(rows.find(r => r.kind === 'base')?.stats), adv = parse(rows.find(r => r.kind === 'advanced')?.stats);
  return seasonLine(base, adv);
}

/** fix174: an NBA team's id from its full name (the contract list names the team) — its team page */
function nbaTeamIdOf(name: string | null): number | null {
  if (!name) return null;
  try {
    const r = db.prepare(`SELECT home_id AS id FROM bb_games WHERE code = 'NBA' AND home_name = ? ORDER BY kickoff DESC LIMIT 1`).get(name) as any;
    return r?.id ?? null;
  } catch { return null; }
}

async function nbaPart(bdl: any, teamName: string, rawName: string) {
  const now = bdlSeasonNow();
  const cur = nbaSeason(bdl.id, now), prev = nbaSeason(bdl.id, now - 1);
  let contract: any = null;
  try { contract = await bdlContract(bdl.id); } catch { /* optional */ }
  return {
    bio: { position: bdl.position, height: bdl.height, weight: bdl.weight, jersey: bdl.jersey, college: bdl.college, country: bdl.country, draft: bdl.draft_year ? { year: bdl.draft_year, round: bdl.draft_round, pick: bdl.draft_number } : null },
    season: cur ? { label: `${now}-${String(now + 1).slice(2)}`, ...cur } : null,
    lastSeason: prev ? { label: `${now - 1}-${String(now).slice(2)}`, ...prev } : null,
    injury: injuryOf(teamName, displayName(rawName, bdl)),
    contract: Array.isArray(contract) ? contract.map((c: any) => ({ season: c.season, team: c.team, teamId: nbaTeamIdOf(c.team), amount: c.amount, type: c.type, status: c.status })).slice(0, 8) : null
  };
}

/** Injury report line for a player (NBA). */
function injuryOf(teamName: string, name: string) {
  const list = db.prepare(`SELECT player, status, comment, reported FROM bb_injuries WHERE team = ?`).all(nbaKey(teamName)) as any[];
  const k = personKey(name);
  const x = list.find(i => personKey(i.player) === k);
  return x ? { status: x.status, comment: x.comment, reported: x.reported } : null;
}

/** fix211: the player's photo (Wikidata / Commons) and its credit, or null (the page shows the jersey number / initials) */
const photoOf = (id: number) => ({ photo: photoUrl('basketball', id) }); // fix241: official photos only, no credit line

export async function bbPlayer(id: number) {
  const rows = db.prepare(`
    SELECT ps.*, g.kickoff, g.code, g.season, g.status, g.home_id, g.away_id, g.home_name, g.away_name, g.home_logo, g.away_logo, g.hs, g.as_
    FROM bb_player_stats ps JOIN bb_games g ON g.game_id = ps.game_id
    WHERE ps.player_id = ? ORDER BY g.kickoff DESC`).all(id) as any[];
  const ros = db.prepare(`SELECT r.*, g.code, g.home_id, g.home_name, g.home_logo, g.away_name, g.away_logo FROM bb_roster r
    LEFT JOIN bb_games g ON g.game_id = (SELECT game_id FROM bb_games WHERE home_id = r.team_id OR away_id = r.team_id ORDER BY kickoff DESC LIMIT 1)
    WHERE r.player_id = ? ORDER BY r.updated_at DESC LIMIT 1`).get(id) as any;
  const rosterBio = ros ? { number: ros.number, country: ros.country, position: ros.position, age: ros.age } : null;
  if (!rows.length) {
    if (!ros) return null;
    // on a squad, no games in our data yet
    const team = { id: ros.team_id, name: ros.home_id === ros.team_id ? ros.home_name : ros.away_name, logo: ros.home_id === ros.team_id ? ros.home_logo : ros.away_logo };
    const isNbaR = ros.code === 'NBA';
    const b = isNbaR ? bdlPlayerOf(ros.name, team.name) : null;
    return { player: { id, name: displayName(ros.name, b), team, league: { code: ros.code, name: leagueName(ros.code) }, ...photoOf(id) }, bio: rosterBio, current: null, seasons: [], form: [], log: [], nba: b ? await nbaPart(b, team.name, ros.name) : null };
  }
  const last = rows[0];
  const teamOf = (r: any) => (r.team_id === r.home_id ? { id: r.home_id, name: r.home_name, logo: r.home_logo } : { id: r.away_id, name: r.away_name, logo: r.away_logo });
  const team = teamOf(last);
  const isNba = rows.some(r => r.code === 'NBA');
  const rosName = ros ? (ros.home_id === ros.team_id ? ros.home_name : ros.away_name) : null;
  const nbaTeamName = ros?.code === 'NBA' && rosName ? rosName : isNba ? teamOf(rows.find(r => r.code === 'NBA')).name : null;
  const bdl = isNba ? bdlPlayerOf(last.name, nbaTeamName) : null;

  // seasons per league (regular season: pre-season left out)
  const groups = new Map<string, any[]>();
  for (const r of rows) {
    if (isPreseason({ code: r.code, kickoff: r.kickoff })) continue;
    const k = `${r.code}|${r.season}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  const seasons = [...groups.entries()].map(([k, list]) => {
    const [code, season] = k.split('|');
    return { code, league: leagueName(code), season, team: teamOf(list[0]), ...sums(list) };
  }).filter(s => s.gp > 0).sort((a, b) => b.season.localeCompare(a.season) || a.code.localeCompare(b.code));

  // game log: the last 15 games he played, with the balldontlie line (plus-minus, advanced) when we have it
  const played = rows.filter(r => r.minutes > 0).slice(0, 15);
  let extra = new Map<string, any>();
  if (bdl) {
    const lines = db.prepare(`
      SELECT g.date, b.min, b.pts, b.reb, b.ast, b.stl, b.blk, b.tov, b.pm, a.pie, a.usg, a.net, a.ts
      FROM bdl_box b JOIN bdl_games g ON g.id = b.game_id LEFT JOIN bdl_adv a ON a.game_id = b.game_id AND a.player_id = b.player_id
      WHERE b.player_id = ? ORDER BY g.date DESC LIMIT 60`).all(bdl.id) as any[];
    extra = new Map(lines.map(l => [String(l.date).slice(0, 10), l]));
  }
  const dayKeys = (iso: string) => { const t = Date.parse(iso); return [-1, 0, 1].map(d => new Date(t + d * 86400000).toISOString().slice(0, 10)); };
  const log = played.map(r => {
    const home = r.team_id === r.home_id;
    const f = home ? r.hs : r.as_, a = home ? r.as_ : r.hs;
    const x = r.code === 'NBA' ? dayKeys(r.kickoff).map(k => extra.get(k)).find(l => l && Math.abs((l.pts ?? -1) - (r.pts ?? -2)) <= 0) : null;
    return {
      gameId: r.game_id, kickoff: r.kickoff, league: r.code, home, opponent: home ? r.away_name : r.home_name, opponentId: home ? r.away_id : r.home_id, opponentLogo: home ? r.away_logo : r.home_logo,
      result: f != null && a != null ? { for: f, against: a, win: f > a } : null,
      starter: !!r.starter, min: r1(r.minutes), pts: r.pts, reb: r.reb, ast: r.ast, fgm: r.fgm, fga: r.fga, tpm: r.tpm, tpa: r.tpa, ftm: r.ftm, fta: r.fta,
      stl: x?.stl ?? null, blk: x?.blk ?? null, tov: x?.tov ?? null, plusMinus: x?.pm ?? null,
      pie: x?.pie != null ? r1(x.pie * 100) : null, usg: x?.usg != null ? r1(x.usg * 100) : null, net: x?.net ?? null, ts: x?.ts != null ? r1(x.ts * 100) : null
    };
  });

  // last 10 games' form: points and minutes, oldest first (for the chart)
  const form = played.slice(0, 10).reverse().map(r => ({ gameId: r.game_id, kickoff: r.kickoff, pts: r.pts ?? 0, min: r1(r.minutes) }));

  const nba = bdl ? await nbaPart(bdl, nbaTeamName || team.name, last.name) : null;

  // the team he is on now (roster) if it differs from his last game's team (a transfer)
  const nowTeam = ros && ros.team_id !== team.id ? { id: ros.team_id, name: ros.home_id === ros.team_id ? ros.home_name : ros.away_name, logo: ros.home_id === ros.team_id ? ros.home_logo : ros.away_logo } : team;
  return {
    player: { id, name: displayName(last.name, bdl), team: nowTeam?.name ? nowTeam : team, league: { code: ros?.code || last.code, name: leagueName(ros?.code || last.code) }, ...photoOf(id) },
    bio: rosterBio,
    current: seasons[0] || null,
    seasons,
    form,
    log,
    nba,
    // fix224: "Impact" — his rating, rank in the league, his team's record with and without him this season
    impact: playerImpact(id)
  };
}

/**
 * A team's squad: the current roster (API-Basketball) with each player's averages this season, or his last season in our
 * leagues when he hasn't played yet (new signings, start of the season). Without a roster: the players of the last 15 games.
 * NBA adds position, PIE, usage and net rating from balldontlie.
 */
export async function bbSquad(teamId: number, teamName: string, code: string, season: string) {
  const roster = await rosterOf(teamId, season);
  let ids: number[] = roster.map(r => r.player_id);
  if (!ids.length) {
    const games = db.prepare(`SELECT game_id FROM bb_games WHERE (home_id = ? OR away_id = ?) AND status IN ('FT','AOT') AND stats = 1 ORDER BY kickoff DESC LIMIT 15`).all(teamId, teamId) as any[];
    if (!games.length) return [];
    ids = (db.prepare(`SELECT DISTINCT player_id FROM bb_player_stats WHERE team_id = ? AND game_id IN (${games.map(() => '?').join(',')})`).all(teamId, ...games.map(g => g.game_id)) as any[]).map(r => r.player_id);
  }
  if (!ids.length) return [];
  // fix196: a few players per read, the thread given back between reads (a whole squad's careers, ~4,000 box-score
  // lines, was one 30–60 ms read on a copy of the database and several times that on the server)
  const rows: any[] = [];
  for (let i = 0; i < ids.length; i += 4) {
    const part = ids.slice(i, i + 4);
    rows.push(...(db.prepare(`SELECT ps.*, g.season, g.code, g.kickoff FROM bb_player_stats ps JOIN bb_games g ON g.game_id = ps.game_id
      WHERE ps.player_id IN (${part.map(() => '?').join(',')}) AND g.status IN ('FT','AOT')`).all(...part) as any[]));
    await yieldLoop();
  }
  rows.sort((a, b) => (a.kickoff < b.kickoff ? 1 : a.kickoff > b.kickoff ? -1 : 0));
  const by = new Map<number, any[]>();
  for (const r of rows) { if (isPreseason({ code: r.code, kickoff: r.kickoff })) continue; if (!by.has(r.player_id)) by.set(r.player_id, []); by.get(r.player_id)!.push(r); }
  const bdlSeason = bdlSeasonNow();
  const injured = code === 'NBA' ? new Map((db.prepare(`SELECT player, status FROM bb_injuries WHERE team = ?`).all(nbaKey(teamName)) as any[]).map(x => [personKey(x.player), x.status])) : new Map();
  const out = ids.map(pid => {
    const r = roster.find(x => x.player_id === pid);
    const list = by.get(pid) || [];
    const nameRaw = r?.name || list[0]?.name || '';
    // this season (any of our leagues); otherwise his latest season with games
    const cur = list.filter(x => x.season === season);
    const lastSeason = cur.length ? null : list[0]?.season ?? null;
    const use = cur.length ? cur : lastSeason ? list.filter(x => x.season === lastSeason && x.code === list[0].code) : [];
    const s = sums(use);
    const bdl = code === 'NBA' ? bdlPlayerOf(nameRaw, teamName) : null;
    const line = bdl ? (nbaSeason(bdl.id, bdlSeason) || nbaSeason(bdl.id, bdlSeason - 1)) : null;
    const name = displayName(nameRaw, bdl);
    return {
      id: pid, name, number: r?.number ?? bdl?.jersey ?? null, position: bdl?.position || r?.position || null, country: r?.country ?? bdl?.country ?? null, age: r?.age ?? null,
      injury: injured.get(personKey(name)) || null, photo: photoUrl('basketball', pid),
      statsFrom: cur.length ? 'current' : lastSeason ? { season: lastSeason, league: use[0]?.code || null } : null,
      gp: s.gp, starts: s.starts, min: s.min, pts: s.pts, reb: s.reb, ast: s.ast, fgPct: s.fgPct, tpPct: s.tpPct,
      pie: line?.pie ?? null, usg: line?.usg ?? null, net: line?.net ?? null
    };
  }).filter(p => p.name);
  return out.sort((a, b) => (b.statsFrom === 'current' ? 1 : 0) - (a.statsFrom === 'current' ? 1 : 0) || (b.min || 0) - (a.min || 0) || a.name.localeCompare(b.name));
}

/** NBA box score extras (steals, blocks, turnovers, plus-minus) for one of our games, matched by date, teams and name. */
export function nbaBoxExtras(kickoff: string, homeName: string, awayName: string) {
  const h = bdlTeamOf(homeName), a = bdlTeamOf(awayName);
  if (!h || !a) return null;
  const t = Date.parse(kickoff);
  const g = db.prepare(`SELECT id FROM bdl_games WHERE home_id = ? AND away_id = ? AND date BETWEEN ? AND ?`)
    .get(h, a, new Date(t - 18 * 3600000).toISOString(), new Date(t + 18 * 3600000).toISOString()) as any;
  if (!g) return null;
  const rows = db.prepare(`SELECT b.*, p.first, p.last FROM bdl_box b LEFT JOIN bdl_players p ON p.id = b.player_id WHERE b.game_id = ?`).all(g.id) as any[];
  if (!rows.length) return null;
  return new Map(rows.map(r => [personKey(`${r.first} ${r.last}`), { stl: r.stl, blk: r.blk, tov: r.tov, oreb: r.oreb, pf: r.pf, plusMinus: r.pm, name: `${r.first} ${r.last}`.trim() }]));
}

let idCache: { at: number; map: Map<string, number> } | null = null;
/** Our (API-Basketball) id of an NBA player, by name. */
function ourNbaId(name: string): number | null {
  if (!idCache || Date.now() - idCache.at > 3600000) {
    const rows = db.prepare(`SELECT ps.player_id, ps.name FROM bb_player_stats ps JOIN bb_games g ON g.game_id = ps.game_id WHERE g.code = 'NBA' AND g.kickoff > ? GROUP BY ps.player_id`)
      .all(new Date(Date.now() - 2 * 365 * 86400000).toISOString()) as any[];
    idCache = { at: Date.now(), map: new Map(rows.map(r => [personKey(r.name), r.player_id])) };
  }
  return idCache.map.get(personKey(name)) ?? null;
}

/** NBA league leaders (current season, or the last one before it starts). */
export function nbaLeaders() {
  const now = bdlSeasonNow();
  for (const season of [now, now - 1]) {
    const rows = db.prepare(`SELECT stat, data FROM bdl_leaders WHERE season = ?`).all(season) as any[];
    if (!rows.length) continue;
    return { season: `${season}-${String(season + 1).slice(2)}`, lists: rows.map(r => ({ stat: r.stat, top: (parse(r.data) || []).slice(0, 5).map((x: any) => ({ ...x, id: ourNbaId(x.name) })) })) };
  }
  return null;
}

/**
 * fix174: league leaders for every league with box scores (the NBA keeps balldontlie's): points, rebounds and assists a
 * game this season, players with at least 40% of the most games anyone played (min 3). Cached 30 minutes; null when
 * the league has no player stats (the page hides the card).
 */
const leadersCache = new Map<string, { at: number; v: any }>();
export function bbLeagueLeaders(code: string) {
  const c = leadersCache.get(code);
  if (c && Date.now() - c.at < 30 * 60 * 1000) return c.v;
  let v: any = null;
  const s = db.prepare(`SELECT season FROM bb_games WHERE code = ? AND stats = 1 ORDER BY kickoff DESC LIMIT 1`).get(code) as any;
  if (s) {
    const rows = db.prepare(`SELECT ps.player_id AS id, MAX(ps.name) AS name, MAX(ps.team_id) AS teamId, COUNT(*) AS gp, AVG(ps.pts) AS pts, AVG(ps.reb) AS reb, AVG(ps.ast) AS ast
      FROM bb_player_stats ps JOIN bb_games g ON g.game_id = ps.game_id WHERE g.code = ? AND g.season = ? AND ps.minutes > 0 GROUP BY ps.player_id`).all(code, s.season) as any[];
    const most = Math.max(0, ...rows.map(r => r.gp));
    const ok = rows.filter(r => r.gp >= Math.max(3, Math.ceil(most * 0.4)));
    if (ok.length >= 5) {
      const list = (stat: 'pts' | 'reb' | 'ast') => ({ stat, top: [...ok].filter(r => r[stat] != null).sort((a, b) => b[stat] - a[stat]).slice(0, 5).map((r, i) => ({ id: r.id, name: r.name, value: Math.round(r[stat] * 10) / 10, games: r.gp, rank: i + 1, teamId: r.teamId })) });
      v = { season: String(s.season), lists: [list('pts'), list('reb'), list('ast')].filter(l => l.top.length) };
    }
  }
  leadersCache.set(code, { at: Date.now(), v });
  return v;
}

/* ---------- search (the site's search box) ---------- */

type SearchPlayer = { id: number; name: string; tokens: string[]; teamId: number; team: string; logo: string | null; code: string; last: string };
type SearchTeam = { id: number; name: string; tokens: string[]; logo: string | null; code: string; last: string };
let searchCache: { at: number; players: SearchPlayer[]; teams: SearchTeam[] } | null = null;
const tokensOf = (s: string) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);

function searchIndex() {
  // fix202: the web process uses the worker's copy (rebuilt there every hour)
  // fix210: and never builds one (empty until the worker's copy arrives); the worker builds it in pages (buildSearch)
  return searchCache || { at: 0, players: [] as SearchPlayer[], teams: [] as SearchTeam[] };
}
/** fix210: the index in pages of player ids with a yield between (the GROUP BY over every box-score line was one block) */
async function buildSearch() {
  const step = yieldEvery(50, 100);
  const since = new Date(Date.now() - 2 * 365 * 86400000).toISOString();
  const teams = new Map<number, SearchTeam>();
  for (const g of db.prepare(`SELECT code, kickoff, home_id, home_name, home_logo, away_id, away_name, away_logo FROM bb_games WHERE kickoff > ? AND kickoff < ? ORDER BY kickoff`).all(since, new Date(Date.now() + 30 * 86400000).toISOString()) as any[]) {
    teams.set(g.home_id, { id: g.home_id, name: g.home_name, tokens: tokensOf(g.home_name), logo: g.home_logo, code: g.code, last: g.kickoff });
    teams.set(g.away_id, { id: g.away_id, name: g.away_name, tokens: tokensOf(g.away_name), logo: g.away_logo, code: g.code, last: g.kickoff });
  }
  await step();
  const players = new Map<number, SearchPlayer>();
  // one row per player: his latest game (SQLite returns the other columns from the MAX row) — 2,000 player ids a query
  const span: any = db.prepare(`SELECT MIN(player_id) AS lo, MAX(player_id) AS hi FROM bb_player_stats`).get();
  const latest = db.prepare(`SELECT ps.player_id, ps.name, ps.team_id, g.code, MAX(g.kickoff) AS kickoff FROM bb_player_stats ps JOIN bb_games g ON g.game_id = ps.game_id WHERE g.kickoff > ? AND ps.player_id >= ? AND ps.player_id < ? GROUP BY ps.player_id`);
  for (let lo = span?.lo ?? 0; span?.hi != null && lo <= span.hi; lo += 2000) {
    for (const r of latest.all(since, lo, lo + 2000) as any[]) {
      const t = teams.get(r.team_id);
      players.set(r.player_id, { id: r.player_id, name: r.name, tokens: tokensOf(r.name), teamId: r.team_id, team: t?.name || '', logo: t?.logo || null, code: r.code, last: r.kickoff });
    }
    await step();
  }
  // current squads: new signings and moves show with their new team
  for (const r of db.prepare(`SELECT player_id, name, team_id, updated_at FROM bb_roster`).all() as any[]) {
    const t = teams.get(r.team_id);
    const prev = players.get(r.player_id);
    players.set(r.player_id, { id: r.player_id, name: prev?.name || r.name, tokens: tokensOf(prev?.name || r.name), teamId: r.team_id, team: t?.name || prev?.team || '', logo: t?.logo || prev?.logo || null, code: t?.code || prev?.code || '', last: prev && prev.last > r.updated_at ? prev.last : r.updated_at });
    await step();
  }
  return { at: Date.now(), players: [...players.values()], teams: [...teams.values()] };
}
/** fix202 (worker): the basketball search index built again and handed to the web process */
export async function warmBbSearch() {
  searchCache = await buildSearch(); // fix210: in pages; the old copy serves meanwhile
  publishState('bb:search', searchCache);
}
onState('bb:search', (_k, v) => { searchCache = v; });

/** Score a name against the query words (any order: "lebron james" finds "James LeBron"). 0 = no match. */
function nameScore(tokens: string[], q: string[], full: string) {
  if (!q.length) return 0;
  let s = 0;
  for (const w of q) {
    const exact = tokens.includes(w), pre = tokens.some(t => t.startsWith(w)), inside = w.length >= 4 && tokens.some(t => t.includes(w));
    if (!exact && !pre && !inside) return 0;
    s += exact ? 3 : pre ? 2 : 1;
  }
  if (tokens.join(' ') === q.join(' ') || full.toLowerCase() === q.join(' ')) s += 3;
  return s;
}

export function bbSearch(qRaw: string) {
  const q = tokensOf(qRaw);
  if (!q.length) return { teams: [], players: [], leagues: [], games: [] };
  const idx = searchIndex();
  const rank = <T extends { tokens: string[]; name: string; last: string }>(list: T[], n: number) => list
    .map(x => ({ x, s: nameScore(x.tokens, q, x.name) }))
    .filter(y => y.s > 0)
    .sort((a, b) => b.s - a.s || b.x.last.localeCompare(a.x.last))
    .slice(0, n).map(y => y.x);
  const teams = rank(idx.teams, 6).map(t => ({ id: t.id, name: t.name, logo: t.logo, league: t.code }));
  const players = rank(idx.players, 6).map(p => {
    const b = p.code === 'NBA' ? bdlPlayerOf(p.name, p.team) : null;
    return { id: p.id, name: displayName(p.name, b), team: p.team, teamLogo: p.logo, photo: photoUrl('basketball', p.id), league: p.code, position: b?.position || null };
  });
  const leagues = BB_LEAGUES.filter(l => {
    const toks = tokensOf(`${l.name} ${l.code} ${l.country}`);
    return q.every(w => toks.some(t => t.startsWith(w)));
  }).slice(0, 4).map(l => ({ code: l.code, name: l.name, country: l.country, logo: (db.prepare(`SELECT logo FROM bb_leagues WHERE code = ?`).get(l.code) as any)?.logo || null }));
  const teamIds = new Set(teams.map(t => t.id));
  const games = teamIds.size ? (db.prepare(`SELECT game_id, code, kickoff, status, home_id, home_name, away_id, away_name FROM bb_games WHERE kickoff BETWEEN ? AND ? ORDER BY kickoff`)
    .all(new Date(Date.now() - 3 * 3600000).toISOString(), new Date(Date.now() + 14 * 86400000).toISOString()) as any[])
    .filter(g => teamIds.has(g.home_id) || teamIds.has(g.away_id)).slice(0, 5)
    .map(g => ({ id: g.game_id, kickoff: g.kickoff, status: g.status, league: g.code, home: g.home_name, away: g.away_name })) : [];
  return { teams, players, leagues, games };
}
