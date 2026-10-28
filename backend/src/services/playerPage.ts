/**
 * Player pages: /api/player-page/<API-Football player id> (1e9 + id is accepted too, as the site uses for scorers).
 *
 * Built from API-Football when someone opens the page (4 calls: this season, last season, injury history,
 * transfers), then kept for 12 hours in memory and in the database (served after restarts and when the daily
 * budget is out, marked stale). Free users get the profile, appearances and goals; premium users get everything.
 *
 * /api/player-page/find?name=&team=&c=&n= turns a Football-Data.org scorer (its own ids) into an API-Football id:
 * the team is resolved like team pages, then the player is matched by surname + first initial in the squad data we
 * already store (af_player_season), else by one API-Football search.
 */
import { db } from '../db';
import logger from '../utils/logger';
import { afGet, afRemaining, afConfigured } from './apiFootball';
import { pageBudgetLeft, isCrawlerRequest, noProviderCalls, outsideRequest } from './afUsage';
import { resolveAfTeamId, competitionName, teamNameOf } from './teamPage';
import { everyHeavy, yieldLoop } from './perf';
import { isWeb, isWorker } from './role';
import { onIpc, sendIpc } from './ipc';
import { samePlayerName, nameSearchTerms } from '../utils/nameMatch';

const AF_OFFSET = 1_000_000_000;
// fix166: 24 h (was 12 h); 3 h while his club has played in the last 24 h (the provider's numbers catch up)
const PAGE_TTL = 24 * 3600 * 1000;
const PAGE_TTL_PLAYED = 3 * 3600 * 1000;
const PAGE_VERSION = 7; // bump when the page shape changes: older stored copies are rebuilt
const cache = new Map<number, { at: number; data: any }>();

db.exec(`CREATE TABLE IF NOT EXISTS player_page_store (player_id INTEGER PRIMARY KEY, json TEXT NOT NULL, built_at TEXT NOT NULL)`);

/** API-Football season number now (2026 = 2026-27, and calendar-year leagues' 2026). */
function seasonNow() {
  const d = new Date();
  return d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}

const n = (x: any) => (x === null || x === undefined || x === '' ? null : Number(x));
const siteTeam = (t: any) => (t?.id ? { id: AF_OFFSET + t.id, name: t.name, logo: t.logo || `https://media.api-sports.io/football/teams/${t.id}.png` } : null);

function statRow(s: any) {
  const minutes = n(s.games?.minutes) || 0;
  return {
    league: { id: s.league?.id, code: s.league?.id ? `AF${s.league.id}` : null, name: s.league?.name, logo: s.league?.logo, country: s.league?.country, flag: s.league?.flag },
    team: siteTeam(s.team),
    position: s.games?.position || null,
    number: n(s.games?.number),
    // the provider sometimes records minutes (and even goals) with 0 appearances: a player who played did appear
    apps: Math.max(n(s.games?.appearences) || 0, minutes > 0 ? 1 : 0),
    starts: n(s.games?.lineups) || 0,
    minutes,
    // a rating from a few minutes on the pitch says little (a 17-minute cameo can read 3.4): shown from 30 minutes
    rating: s.games?.rating && minutes >= 30 ? Math.round(Number(s.games.rating) * 100) / 100 : null,
    goals: n(s.goals?.total) || 0,
    assists: n(s.goals?.assists) || 0,
    conceded: n(s.goals?.conceded),
    saves: n(s.goals?.saves),
    shots: n(s.shots?.total),
    shotsOn: n(s.shots?.on),
    keyPasses: n(s.passes?.key),
    passAcc: n(s.passes?.accuracy),
    tackles: n(s.tackles?.total),
    interceptions: n(s.tackles?.interceptions),
    dribbles: n(s.dribbles?.success),
    duelsWon: n(s.duels?.won),
    duels: n(s.duels?.total),
    yellow: n(s.cards?.yellow) || 0,
    red: (n(s.cards?.red) || 0) + (n(s.cards?.yellowred) || 0),
    penScored: n(s.penalty?.scored),
    penMissed: n(s.penalty?.missed)
  };
}

function totalsOf(rows: ReturnType<typeof statRow>[]) {
  const sum = (k: keyof ReturnType<typeof statRow>) => rows.reduce((a, r) => a + ((r[k] as number) || 0), 0);
  const rated = rows.filter(r => r.rating && r.minutes);
  const mins = rated.reduce((a, r) => a + r.minutes, 0);
  return {
    apps: sum('apps'), starts: sum('starts'), minutes: sum('minutes'), goals: sum('goals'), assists: sum('assists'),
    yellow: sum('yellow'), red: sum('red'), shots: sum('shots'), keyPasses: sum('keyPasses'),
    rating: mins ? Math.round((rated.reduce((a, r) => a + r.rating! * r.minutes, 0) / mins) * 100) / 100 : null
  };
}

/*
 * A player's season as the provider has it, stored for good: past seasons never change, so each is fetched once
 * (the current seasons are fetched again whenever the page is rebuilt). null = the provider has nothing that season.
 */
db.exec(`CREATE TABLE IF NOT EXISTS player_season_raw (player_id INTEGER NOT NULL, season INTEGER NOT NULL, json TEXT, fetched_at TEXT NOT NULL, PRIMARY KEY (player_id, season))`);
db.exec(`CREATE TABLE IF NOT EXISTS player_seasons_list (player_id INTEGER PRIMARY KEY, years TEXT NOT NULL, fetched_at TEXT NOT NULL)`);

async function rawSeason(pid: number, season: number, refresh: boolean): Promise<{ player: any; statistics: any[] } | null> {
  const row: any = db.prepare(`SELECT json FROM player_season_raw WHERE player_id = ? AND season = ?`).get(pid, season);
  if (row && !refresh) return row.json ? JSON.parse(row.json) : null;
  try {
    const j: any = await afGet('/players', { id: pid, season });
    const it = j.response?.[0];
    const data = it ? { player: it.player, statistics: it.statistics || [] } : null;
    db.prepare(`INSERT OR REPLACE INTO player_season_raw (player_id, season, json, fetched_at) VALUES (?, ?, ?, ?)`)
      .run(pid, season, data ? JSON.stringify(data) : null, new Date().toISOString());
    return data;
  } catch (e) {
    if (row) return row.json ? JSON.parse(row.json) : null; // provider down: the stored copy
    throw e;
  }
}

/** Every season the provider has for this player (his whole career), refreshed monthly. */
async function careerYears(pid: number): Promise<number[]> {
  const row: any = db.prepare(`SELECT years, fetched_at FROM player_seasons_list WHERE player_id = ?`).get(pid);
  if (row && Date.now() - new Date(row.fetched_at).getTime() < 30 * 86400000) return JSON.parse(row.years);
  try {
    const j: any = await afGet('/players/seasons', { player: pid });
    const years = ((j.response || []) as any[]).map(Number).filter(y => y > 1990).sort((a, b) => a - b);
    db.prepare(`INSERT OR REPLACE INTO player_seasons_list (player_id, years, fetched_at) VALUES (?, ?, ?)`).run(pid, JSON.stringify(years), new Date().toISOString());
    return years;
  } catch {
    return row ? JSON.parse(row.years) : [];
  }
}

/** Run jobs a few at a time (the provider limits requests per minute). */
async function pool<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

/*
 * When each competition-season was played. The provider's season numbers do not match club seasons for
 * tournaments (World Cup 2026 = "2026", its qualifiers March–November 2025 = also "2026"; Club World Cup of
 * June 2025 = "2025"), so rows are placed by the competition's real dates. Stored for good (dates don't change
 * once a season is over; the current one is refreshed after a week).
 */
db.exec(`CREATE TABLE IF NOT EXISTS af_league_dates (league_id INTEGER NOT NULL, season INTEGER NOT NULL, start TEXT, end TEXT, fetched_at TEXT NOT NULL, PRIMARY KEY (league_id, season))`);
async function leagueDates(leagueId: number, season: number): Promise<{ start: string; end: string } | null> {
  const row: any = db.prepare(`SELECT start, end, fetched_at FROM af_league_dates WHERE league_id = ? AND season = ?`).get(leagueId, season);
  const fresh = row && (row.end && row.end < new Date().toISOString().slice(0, 10) ? true : Date.now() - new Date(row.fetched_at).getTime() < 7 * 86400000);
  if (row && fresh) return row.start && row.end ? { start: row.start, end: row.end } : null;
  try {
    const j: any = await afGet('/leagues', { id: leagueId, season });
    const se = (j.response?.[0]?.seasons || []).find((x: any) => x.year === season) || null;
    db.prepare(`INSERT OR REPLACE INTO af_league_dates (league_id, season, start, end, fetched_at) VALUES (?, ?, ?, ?, ?)`)
      .run(leagueId, season, se?.start || null, se?.end || null, new Date().toISOString());
    return se?.start && se?.end ? { start: se.start, end: se.end } : null;
  } catch {
    return row?.start && row?.end ? { start: row.start, end: row.end } : null;
  }
}

/*
 * When THIS team played THIS competition-season (its own games' dates), for competitions whose season dates are
 * missing or misleading (one-match super cups filed under the calendar year, tournaments spread over two years).
 * Stored for good once the games are in the past.
 */
db.exec(`CREATE TABLE IF NOT EXISTS af_team_comp_games (league_id INTEGER NOT NULL, season INTEGER NOT NULL, team_id INTEGER NOT NULL, dates TEXT NOT NULL, fetched_at TEXT NOT NULL, PRIMARY KEY (league_id, season, team_id))`);
/** Dates of this team's finished games in a competition-season (stored; refreshed daily while it may still change). */
async function teamCompGames(leagueId: number, season: number, teamId: number): Promise<string[]> {
  const row: any = db.prepare(`SELECT dates, fetched_at FROM af_team_comp_games WHERE league_id = ? AND season = ? AND team_id = ?`).get(leagueId, season, teamId);
  const dates: string[] = row ? JSON.parse(row.dates) : [];
  const done = dates.length && dates[dates.length - 1] < new Date(Date.now() - 30 * 86400000).toISOString();
  if (row && (done || Date.now() - new Date(row.fetched_at).getTime() < 86400000)) return dates;
  try {
    const j: any = await afGet('/fixtures', { league: leagueId, season, team: teamId });
    const fresh = ((j.response || []) as any[]).filter(f => ['FT', 'AET', 'PEN'].includes(f.fixture?.status?.short)).map(f => String(f.fixture.date)).sort();
    db.prepare(`INSERT OR REPLACE INTO af_team_comp_games (league_id, season, team_id, dates, fetched_at) VALUES (?, ?, ?, ?, ?)`)
      .run(leagueId, season, teamId, JSON.stringify(fresh), new Date().toISOString());
    return fresh;
  } catch {
    return dates;
  }
}
async function teamCompDates(leagueId: number, season: number, teamId: number): Promise<{ start: string; end: string; mid: string } | null> {
  const dates = await teamCompGames(leagueId, season, teamId);
  return dates.length ? { start: dates[0], end: dates[dates.length - 1], mid: dates[Math.floor(dates.length / 2)] } : null;
}

/*
 * Competitions where the provider files a PLAYER's stats under the calendar year of the edition (the Spanish Super
 * Cup of January 2026 = "2026") while the competition's own season is numbered differently. Found automatically:
 * stats for a season in which the team has no finished game in that competition. Remembered for good.
 */
db.exec(`CREATE TABLE IF NOT EXISTS af_calendar_leagues (league_id INTEGER PRIMARY KEY, found_at TEXT NOT NULL)`);
db.prepare(`INSERT OR IGNORE INTO af_calendar_leagues (league_id, found_at) VALUES (556, ?)`).run(new Date().toISOString());
const isCalendarLeague = (id: number) => !!db.prepare(`SELECT 1 FROM af_calendar_leagues WHERE league_id = ?`).get(id);

/** Club season (2025 = 2025-26, July to June) that a date falls in. */
const clubSeasonOf = (iso: string) => {
  const d = new Date(iso);
  return d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
};

// competitions only national teams play (the Club World Cup is a club competition)
const INTL = /^(world cup|world cup - qualification.*|.*world cup qualifiers|.*world cup qualification.*|uefa nations league.*|euro championship.*|european championship.*|copa america.*|africa cup of nations.*|asian cup.*|.*gold cup|concacaf nations league.*|olympics.*|u2[013] .*|.*u2[013]|.*u1[789])$/i;

const MONEY = /^[€$£]|^\d/;
const transferType = (t: string | null | undefined) => {
  const x = String(t || '').trim();
  if (!x || x === 'N/A' || MONEY.test(x)) return 'Transfer'; // fees are left out: the provider's figures are often not the reported ones
  if (/loan/i.test(x)) return /back|end/i.test(x) ? 'End of loan' : 'Loan';
  if (/free/i.test(x)) return 'Free transfer';
  return x;
};

function ageFrom(date?: string | null) {
  if (!date) return null;
  const b = new Date(date), now = new Date();
  if (isNaN(b.getTime())) return null;
  let a = now.getUTCFullYear() - b.getUTCFullYear();
  if (now.getUTCMonth() < b.getUTCMonth() || (now.getUTCMonth() === b.getUTCMonth() && now.getUTCDate() < b.getUTCDate())) a--;
  return a;
}

// Safety cap on new page builds (each costs API-Football calls): protects the daily budget from scripted scraping
// across many addresses. Stored pages are still served when the cap is hit.
const BUILD_CAP = parseInt(process.env.PLAYER_BUILDS_PER_HOUR || '1500', 10);
let builds = { hour: 0, n: 0 };
function buildAllowed() {
  const h = Math.floor(Date.now() / 3600000);
  if (builds.hour !== h) builds = { hour: h, n: 0 };
  return ++builds.n <= BUILD_CAP;
}

/** Other provider ids of the same person: same club this season, same surname, same birth date. */
async function findTwins(pid: number, p: any, S: number, src: any[]): Promise<number[]> {
  const birth = p?.birth?.date;
  const last = plain(p?.lastname || p?.name || '').split(' ').pop() || '';
  if (!birth || last.length < 3) return [];
  const cur = src.find(r => r.season === S)?.data;
  const teams = [...new Set(((cur?.statistics || []) as any[]).map(x => x.team?.id).filter(Boolean))];
  if (!teams.length) return [];
  let cands: any[] = [];
  try {
    cands = db.prepare(`SELECT DISTINCT player_id, name FROM af_player_season WHERE season = ? AND team_id IN (${teams.map(() => '?').join(',')}) AND player_id != ?`).all(S, ...teams, pid) as any[];
  } catch { return []; }
  const out: number[] = [];
  const mins = (d: any) => ((d?.statistics || []) as any[]).reduce((t, x) => t + (Number(x.games?.minutes) || 0), 0);
  const mine = mins(cur);
  for (const c of cands.filter(c => plain(c.name).split(' ').pop() === last).slice(0, 3)) {
    try {
      const d = await rawSeason(c.player_id, S, false);
      if (d?.player?.birth?.date === birth) {
        out.push(c.player_id);
        // remember which id is the main one (more minutes): search shows only that one
        const [main, dup] = mins(d) > mine ? [c.player_id, pid] : [pid, c.player_id];
        db.prepare(`INSERT OR REPLACE INTO player_twins (dup_id, main_id) VALUES (?, ?)`).run(dup, main);
      }
    } catch { /* skip */ }
  }
  return out;
}
db.exec(`CREATE TABLE IF NOT EXISTS player_twins (dup_id INTEGER PRIMARY KEY, main_id INTEGER NOT NULL)`);
/** fix240: second record → the main id of the same player */
function twinMainOf(): Map<number, number> {
  try { return new Map((db.prepare(`SELECT dup_id, main_id FROM player_twins`).all() as any[]).map(r => [r.dup_id, r.main_id])); } catch { return new Map(); }
}
/** Provider ids that are a second record of another player (hidden from search). */
export function twinDupIds(): Set<number> {
  try { return new Set((db.prepare(`SELECT dup_id FROM player_twins`).all() as any[]).map(r => r.dup_id)); } catch { return new Set(); }
}

/**
 * Rows of the same competition, club and provider season added together (twin ids of one player: each has part of
 * his games). fix240: only rows of different ids are added, and only when they are not the same games — the data
 * check found top scorers with twice their goals: an exact copy of a row (the provider files a league twice for one
 * id) or a twin record carrying the same games was summed. Copies within one id → the fuller row; a twin row equal
 * to the main one (same apps, minutes and goals) → a copy, kept once.
 */
export function mergeRows(rows: any[]): any[] {
  const SUM = ['apps', 'starts', 'minutes', 'goals', 'assists', 'yellow', 'red', 'shots', 'shotsOn', 'keyPasses', 'tackles', 'interceptions', 'dribbles', 'duelsWon', 'duels', 'saves', 'conceded', 'penScored', 'penMissed'];
  const groups = new Map<string, Map<string, any>>();
  for (const r of rows) {
    const k = `${r.league.id}|${r.team?.id}|${r.afSeason}`;
    const id = String(r._pid ?? 'main');
    const g = groups.get(k) || new Map<string, any>();
    groups.set(k, g);
    const cur = g.get(id);
    if (!cur || r.apps > cur.apps || (r.apps === cur.apps && r.minutes > cur.minutes)) g.set(id, r);
  }
  const same = (a: any, b: any) => a.apps === b.apps && a.minutes === b.minutes && a.goals === b.goals;
  const out: any[] = [];
  for (const g of groups.values()) {
    const kept: any[] = [];
    for (const r of g.values()) if (!kept.some(k => same(k, r))) kept.push(r);
    const first = kept[0];
    const cur = { ...first, _rw: first.rating && first.minutes ? first.rating * first.minutes : 0, _rm: first.rating && first.minutes ? first.minutes : 0 };
    for (const r of kept.slice(1)) {
      for (const f of SUM) if (r[f] !== null && r[f] !== undefined) cur[f] = (cur[f] || 0) + r[f];
      if (r.rating && r.minutes) { cur._rw += r.rating * r.minutes; cur._rm += r.minutes; }
    }
    if (kept.length > 1) cur.twinIds = kept.length; // the data check says why his page adds up two records
    out.push(cur);
  }
  return out.map(r => {
    const { _rw, _rm, _pid, ...rest } = r;
    return { ...rest, rating: _rm >= 30 ? Math.round((_rw / _rm) * 100) / 100 : null };
  });
}

/** offline: crawler pages — every provider call is refused (noProviderCalls), each step uses what we stored */
async function build(pid: number, offline = false) {
  if (!offline) {
    if (!afConfigured()) throw new Error('API-Football is not configured');
    if (!buildAllowed()) throw Object.assign(new Error('Busy right now, try again in a few minutes'), { response: { status: 503 } });
    if (afRemaining() < 200) throw new Error('Daily data budget reached, try again later');
  }
  const S = seasonNow();
  // The whole career: every season the provider has. The three current provider seasons are fetched fresh
  // (S+1 catches this summer's tournaments and calendar-year leagues filed ahead); older ones come from our store
  // and are fetched only the first time.
  const years = new Set(await careerYears(pid));
  for (const y of [S - 1, S, S + 1]) years.add(y);
  const fresh = new Set([S - 1, S, S + 1]);
  const lowBudget = offline || afRemaining() < 2000;
  const list = [...years].sort((a, b) => b - a);
  const raws = await pool(list, 4, async y => {
    const stored = !fresh.has(y) && lowBudget ? db.prepare(`SELECT json FROM player_season_raw WHERE player_id = ? AND season = ?`).get(pid, y) as any : undefined;
    if (lowBudget && !fresh.has(y)) return stored?.json ? { season: y, data: JSON.parse(stored.json) } : { season: y, data: null, missing: !stored };
    try { return { season: y, data: await rawSeason(pid, y, fresh.has(y)) }; } catch { return { season: y, data: null, missing: true }; }
  });
  const src = raws.filter(r => r.data);
  if (!src.length) throw Object.assign(new Error('Player not found'), { response: { status: 404 } });
  const careerPartial = raws.some((r: any) => r.missing);
  const [sideRes, trRes] = await Promise.all([
    afGet('/sidelined', { player: pid }).catch(() => null),
    afGet('/transfers', { player: pid }).catch(() => null)
  ]);
  // the newest season's profile (current club, photo, name)
  const p = (src.find(r => r.season === S) || src[0]).data.player;
  const nationality: string = p.nationality || '';
  const toRows = (data: any, season: number) =>
    (data?.statistics || [])
      .map((x: any) => ({ ...statRow(x), afSeason: season, friendly: /friendl/i.test(x.league?.name || '') }))
      .filter((x: any) => x.apps > 0 || x.minutes > 0);
  let all: any[] = src.flatMap(r => toRows(r.data, r.season));
  // The provider sometimes keeps one player under two ids (same club, same surname, same birth date), each with part
  // of his games. Their rows are merged so the page shows everything he played.
  const twins = await findTwins(pid, p, S, src);
  if (twins.length) {
    for (const t of twins) for (const y of [S - 1, S, S + 1]) {
      try { const d = await rawSeason(t, y, y === S); if (d) all.push(...toRows(d, y).map((r: any) => ({ ...r, _pid: t }))); } catch { /* skip */ }
    }
    all = mergeRows(all);
  }
  const isNational = (r: any) =>
    (!!r.team && !!nationality && (r.team.name === nationality || r.team.name.startsWith(`${nationality} U`))) || /\bU-?\d{2}\b/.test(r.team?.name || '') || INTL.test(r.league.name || '');

  // When was each row played? The competition's dates; for one-off cups and competitions without usable dates,
  // the dates of this team's own games in it.
  await pool(all, 6, async (r: any) => {
    if (!r.league.id) return;
    const teamAf = r.team?.id ? r.team.id - AF_OFFSET : null;
    // stats filed under the edition's calendar year: the team's games in that competition played in that year
    if (teamAf && isCalendarLeague(r.league.id)) {
      const games = [...(await teamCompGames(r.league.id, r.afSeason - 1, teamAf)), ...(await teamCompGames(r.league.id, r.afSeason, teamAf))]
        .filter(d => d.startsWith(String(r.afSeason)) && d <= new Date().toISOString())
        .sort();
      if (games.length) { r.from = games[0].slice(0, 10); r.to = games[games.length - 1].slice(0, 10); r.mid = games[Math.floor(games.length / 2)]; return; }
    }
    const d = await leagueDates(r.league.id, r.afSeason);
    r.from = d?.start || null;
    r.to = d?.end || null;
    const span = d ? (new Date(d.end).getTime() - new Date(d.start).getTime()) / 86400000 : 0;
    const mid = d ? new Date((new Date(d.start).getTime() + new Date(d.end).getTime()) / 2).toISOString() : null;
    const suspicious = !d || span > 400 || span < 1 || (mid && clubSeasonOf(mid) > S) || (mid && mid > new Date().toISOString());
    if (suspicious && teamAf) {
      const t = await teamCompDates(r.league.id, r.afSeason, teamAf);
      if (t) { r.from = t.start.slice(0, 10); r.to = t.end.slice(0, 10); r.mid = t.mid; }
      else if (r.apps > 0 && (!d || span < 60)) {
        // he played, but the team has no finished game in this competition-season: the provider numbers this
        // competition by calendar year. Remember it, and place the row by the games played in that year.
        db.prepare(`INSERT OR IGNORE INTO af_calendar_leagues (league_id, found_at) VALUES (?, ?)`).run(r.league.id, new Date().toISOString());
        const games = (await teamCompGames(r.league.id, r.afSeason - 1, teamAf)).filter(x => x.startsWith(String(r.afSeason)) && x <= new Date().toISOString());
        if (games.length) { r.from = games[0].slice(0, 10); r.to = games[games.length - 1].slice(0, 10); r.mid = games[Math.floor(games.length / 2)]; }
      }
    }
  });

  // club rows (friendlies left out) → club season by when they were played
  const clubRows = all.filter(r => !isNational(r) && !r.friendly);
  const bySeason = new Map<number, any[]>();
  for (const r of clubRows) {
    let cs: number;
    if (r.mid) cs = clubSeasonOf(r.mid);
    else if (r.from && r.to) cs = clubSeasonOf(new Date((new Date(r.from).getTime() + new Date(r.to).getTime()) / 2).toISOString());
    else cs = r.afSeason;
    if (cs > S) cs = S; // nothing can belong to a season that hasn't started
    if (!bySeason.has(cs)) bySeason.set(cs, []);
    bySeason.get(cs)!.push(r);
  }
  const seasons = [...bySeason.keys()]
    .sort((a, b) => b - a)
    .map(y => {
      const rows = bySeason.get(y)!.sort((a, b) => b.minutes - a.minutes);
      return { season: y, label: `${y}-${String(y + 1).slice(2)}`, rows, totals: totalsOf(rows) };
    });
  const career = { ...totalsOf(clubRows), seasons: seasons.length, from: seasons.length ? seasons[seasons.length - 1].label : null };

  // national-team rows: the whole international career (friendlies included: they are caps), newest first
  const seen = new Set<string>();
  const international = all
    .filter(isNational)
    .filter(r => {
      const k = `${r.league.id}:${r.afSeason}:${r.team?.id}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => String(b.to || b.afSeason).localeCompare(String(a.to || a.afSeason)));
  const intlByTeam = new Map<string, { team: any; apps: number; goals: number; assists: number }>();
  for (const r of international) {
    const k = r.team?.name || 'National team';
    const t = intlByTeam.get(k) || { team: r.team, apps: 0, goals: 0, assists: 0 };
    t.apps += r.apps; t.goals += r.goals; t.assists += r.assists;
    intlByTeam.set(k, t);
  }
  const internationalTotals = [...intlByTeam.values()].sort((a, b) => b.apps - a.apps);

  // his club (not the national team) for the header: the most recent club rows
  const main = seasons[0]?.rows[0] || seasons[1]?.rows[0] || null;
  // "E. Haaland" → "Erling Haaland"
  const display = /^[A-Z]\.\s/.test(p.name || '') && p.firstname && p.lastname ? `${String(p.firstname).split(' ')[0]} ${p.lastname}` : p.name;

  const today = new Date().toISOString().slice(0, 10);
  const recent = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);
  const sidelined = ((sideRes as any)?.response || [])
    .map((x: any) => ({ type: x.type, start: x.start, end: x.end }))
    .filter((x: any) => x.start)
    .sort((a: any, b: any) => String(b.start).localeCompare(String(a.start)))
    .slice(0, 12);
  // out now = a spell that has started and not ended; an open-ended one only if it began in the last 4 months
  // (old entries often have no end date)
  const out = sidelined.find((x: any) => x.start <= today && (x.end ? x.end >= today : x.start >= recent)) || null;

  const transfers = (((trRes as any)?.response?.[0]?.transfers) || [])
    .map((t: any) => ({ date: t.date, type: transferType(t.type), from: siteTeam(t.teams?.out), to: siteTeam(t.teams?.in) }))
    .filter((t: any) => t.from && t.to && t.date && t.date <= today)
    .sort((a: any, b: any) => String(b.date).localeCompare(String(a.date)))
    .slice(0, 12);

  const birth = p.birth || null;
  return {
    player: {
      id: p.id, name: display, short: p.name, firstname: p.firstname, lastname: p.lastname, age: ageFrom(birth?.date) ?? p.age ?? null,
      birth, nationality: nationality || null,
      height: p.height ? (/^\d+$/.test(String(p.height)) ? `${p.height} cm` : p.height) : null,
      weight: p.weight ? (/^\d+$/.test(String(p.weight)) ? `${p.weight} kg` : p.weight) : null,
      photo: p.photo || `https://media.api-sports.io/football/players/${p.id}.png`
    },
    team: main?.team || null,
    position: main?.position || null,
    number: main?.number ?? null,
    status: out ? { out: true, type: out.type, since: out.start, until: out.end } : { out: false },
    seasons,
    career,
    careerPartial,
    international,
    internationalTotals,
    sidelined,
    transfers,
    v: PAGE_VERSION,
    builtAt: new Date().toISOString()
  };
}

/*
 * How long a page lives (fix166): 24 hours; 3 hours while his club has played in the last 24 hours — the provider
 * updates the season numbers hours after the final whistle, so a page built around a game is rebuilt until they have
 * caught up. (Before fix166: 12 hours, plus a rebuild after every club game and every 3 hours for 30 hours after it.)
 * Only the current seasons are fetched again; the rest of the career comes from our store.
 */
const playedCache = new Map<number, { at: number; v: boolean }>();
function clubPlayedRecently(data: any): boolean {
  const teamId = data?.team?.id ? data.team.id - AF_OFFSET : null;
  if (!teamId) return false;
  const c = playedCache.get(teamId);
  if (c && Date.now() - c.at < 5 * 60 * 1000) return c.v;
  let v = false;
  try {
    const now = new Date().toISOString(), dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    v = !!db.prepare(`SELECT 1 FROM af_fixtures WHERE (home_id = ? OR away_id = ?) AND status IN ('FT','AET','PEN') AND kickoff > ? AND kickoff <= ? LIMIT 1`).get(teamId, teamId, dayAgo, now)
      || !!db.prepare(`SELECT 1 FROM eur_matches WHERE (home_id = ? OR away_id = ?) AND date >= ? LIMIT 1`).get(teamId, teamId, dayAgo.slice(0, 10));
  } catch { /* table missing */ }
  playedCache.set(teamId, { at: Date.now(), v });
  if (playedCache.size > 5000) playedCache.delete(playedCache.keys().next().value as number);
  return v;
}
const fresh = (data: any, at: number) => data?.v === PAGE_VERSION && Date.now() - at < (clubPlayedRecently(data) ? PAGE_TTL_PLAYED : PAGE_TTL);

async function pageData(pid: number, wait = false, minBuiltAt = 0) {
  // crawlers: never a provider call (fix166) — the stored page at any age, else one built from our database only
  if (isCrawlerRequest()) return crawlerPage(pid);
  const mem = cache.get(pid);
  if (mem && mem.at >= minBuiltAt && fresh(mem.data, mem.at)) return mem.data;
  const stored: any = db.prepare(`SELECT json, built_at FROM player_page_store WHERE player_id = ?`).get(pid);
  const storedData = stored ? JSON.parse(stored.json) : null;
  if (stored && new Date(stored.built_at).getTime() >= minBuiltAt && fresh(storedData, new Date(stored.built_at).getTime())) {
    const data = storedData;
    cache.set(pid, { at: new Date(stored.built_at).getTime(), data });
    return data;
  }
  // several visitors (or the warm-up) asking for the same player share one build
  let running = inflight.get(pid);
  if (!running) {
    running = buildAndStore(pid, stored).finally(() => inflight.delete(pid));
    inflight.set(pid, running);
  }
  // Speed (Oct 2026): a saved page of the current version is shown at once while the new one is built in the
  // background (the next visit gets it) — instead of making this visitor wait ~15 s for the rebuild.
  if (!wait && stored && storedData?.v === PAGE_VERSION) {
    running.catch(() => undefined);
    return storedData;
  }
  return running;
}

const inflight = new Map<number, Promise<any>>();
async function buildAndStore(pid: number, stored: any) {
  try {
    const data = await build(pid);
    cache.set(pid, { at: Date.now(), data });
    if (cache.size > 400) cache.delete(cache.keys().next().value as number); // fix210: capped low (the page is also stored in the database; the worker answers every page request)
    db.prepare(`INSERT OR REPLACE INTO player_page_store (player_id, json, built_at) VALUES (?, ?, ?)`).run(pid, JSON.stringify(data), data.builtAt);
    return data;
  } catch (e: any) {
    if (stored) {
      logger.warn(`player page ${pid}: serving the copy from ${stored.built_at} (${e.message})`);
      return { ...JSON.parse(stored.json), stale: true };
    }
    throw e;
  }
}

/*
 * Crawlers (fix166): the stored page at any age; else the page built from what we store (each season's provider
 * answer, career years, competition dates — every provider call refused, so each step falls back to its stored copy);
 * else a short page from the season data we keep for every player (af_player_season). Never stored: a real visitor's
 * view builds and stores the full page.
 */
const crawlerCache = new Map<number, { at: number; data: any }>();
async function crawlerPage(pid: number) {
  const mem = cache.get(pid);
  if (mem?.data?.v === PAGE_VERSION) return mem.data;
  const stored: any = db.prepare(`SELECT json FROM player_page_store WHERE player_id = ?`).get(pid);
  const storedData = stored ? JSON.parse(stored.json) : null;
  if (storedData?.v === PAGE_VERSION) return storedData;
  const c = crawlerCache.get(pid);
  if (c && Date.now() - c.at < 3600 * 1000) return c.data;
  let data: any = null;
  try { data = await noProviderCalls(() => build(pid, true)); } catch { /* nothing stored from the provider about him */ }
  data = data || storedData || seasonDataPage(pid);
  if (!data) throw Object.assign(new Error('Player not found'), { response: { status: 404 } });
  crawlerCache.set(pid, { at: Date.now(), data });
  if (crawlerCache.size > 300) crawlerCache.delete(crawlerCache.keys().next().value as number); // fix210: capped low (the page is also stored in the database; the worker answers every page request)
  return data;
}

/** A short page from af_player_season (club, competitions, apps, minutes, goals, assists per season). */
function seasonDataPage(pid: number) {
  let rows: any[] = [];
  try { rows = db.prepare(`SELECT * FROM af_player_season WHERE player_id = ? ORDER BY season DESC, minutes DESC`).all(pid) as any[]; } catch { return null; }
  if (!rows.length) return null;
  const toRow = (r: any) => ({
    league: { id: r.league_id, code: `AF${r.league_id}`, name: competitionName(r.league_id), logo: `https://media.api-sports.io/football/leagues/${r.league_id}.png`, country: null, flag: null },
    team: siteTeam({ id: r.team_id, name: teamNameOf(r.team_id) }),
    position: r.position || null, number: null,
    apps: Math.max(r.apps || 0, (r.minutes || 0) > 0 ? 1 : 0), starts: r.starts || 0, minutes: r.minutes || 0,
    rating: r.rating && (r.minutes || 0) >= 30 ? Math.round(Number(r.rating) * 100) / 100 : null,
    goals: r.goals || 0, assists: r.assists || 0, conceded: null, saves: null, shots: null, shotsOn: null, keyPasses: null, passAcc: null,
    tackles: null, interceptions: null, dribbles: null, duelsWon: null, duels: null, yellow: 0, red: 0, penScored: null, penMissed: null,
    afSeason: r.season
  });
  const bySeason = new Map<number, any[]>();
  for (const r of rows.filter(r => (r.apps || 0) > 0 || (r.minutes || 0) > 0)) {
    if (!bySeason.has(r.season)) bySeason.set(r.season, []);
    bySeason.get(r.season)!.push(toRow(r));
  }
  const seasons = [...bySeason.keys()].sort((a, b) => b - a).map(y => {
    const list = bySeason.get(y)!;
    return { season: y, label: `${y}-${String(y + 1).slice(2)}`, rows: list, totals: totalsOf(list) };
  });
  const all = seasons.flatMap(s => s.rows);
  const main = seasons[0]?.rows[0] || null;
  const top = rows[0];
  return {
    player: { id: pid, name: top.name, short: top.name, firstname: null, lastname: null, age: top.age ?? null, birth: null, nationality: null, height: null, weight: null, photo: `https://media.api-sports.io/football/players/${pid}.png` },
    team: main?.team || siteTeam({ id: top.team_id, name: teamNameOf(top.team_id) }),
    position: main?.position || top.position || null,
    number: null,
    status: { out: false },
    seasons,
    career: { ...totalsOf(all), seasons: seasons.length, from: seasons.length ? seasons[seasons.length - 1].label : null },
    careerPartial: true,
    international: [], internationalTotals: [], sidelined: [], transfers: [],
    partial: true,
    v: PAGE_VERSION,
    builtAt: new Date().toISOString()
  };
}

/*
 * Warm-up: when a team page is opened, its players' pages are built in the background (three a minute,
 * only while the daily data budget is comfortable), so the first visit to a player page is instant instead of ~15 s.
 */
const warmQueue = new Set<number>();
if (isWorker) onIpc('players:warm', m => warmPlayers(Array.isArray(m.ids) ? (m.ids as number[]).filter(Number.isFinite) : []));
let warmTimer: NodeJS.Timeout | null = null;
export function warmPlayers(ids: number[]) {
  // fix202: the warm-up is the worker's job (the web process only passes the ids on)
  if (isWeb) { if (ids.length) sendIpc({ t: 'players:warm', ids: ids.slice(0, 200) }); return; }
  for (const id of ids) {
    const pid = id >= AF_OFFSET ? id - AF_OFFSET : id;
    if (!pid || cache.has(pid)) continue;
    const row: any = db.prepare(`SELECT json FROM player_page_store WHERE player_id = ?`).get(pid);
    if (row) { try { if (JSON.parse(row.json).v === PAGE_VERSION) continue; } catch { /* rebuild */ } }
    warmQueue.add(pid);
  }
  while (warmQueue.size > 2000) warmQueue.delete(warmQueue.values().next().value as number);
  if (!warmTimer && warmQueue.size) {
    // fix166: started outside the visitor's request — warm-ups are background work, not that visitor's page calls
    // fix194: in the heavy-job queue (never with the daily model job or the tennis jobs)
    warmTimer = outsideRequest(() => everyHeavy('player pages warm', async () => {
      if (!warmQueue.size) { clearInterval(warmTimer!); warmTimer = null; return; }
      if (afRemaining() < 20000 || pageBudgetLeft() < 150) return; // fix140: visitors first, warm-ups give way
      for (const pid of [...warmQueue].slice(0, 3)) {
        warmQueue.delete(pid);
        try { await pageData(pid); } catch { /* skipped */ }
        await yieldLoop();
      }
    }, 60 * 1000));
    warmTimer.unref?.();
  }
}

/*
 * The provider sometimes files the same cup twice for one club season: an exact copy (same provider season) or
 * two editions that both fall in that season (calendar-year cups such as Copa Argentina). Copies are dropped
 * (the fuller one is kept); two real editions stay, named by year so they don't look like a duplicate.
 * Done when the page is served, so stored pages are fixed without rebuilding them.
 */
function tidySeasons(data: any) {
  if (!data?.seasons?.length) return data;
  const yearsOf = (r: any) => {
    const a = String(r.from || '').slice(0, 4), b = String(r.to || '').slice(0, 4);
    if (a && b) return a === b ? a : `${a}-${b.slice(2)}`;
    return String(r.afSeason ?? '');
  };
  const seasons = data.seasons.map((se: any) => {
    const groups = new Map<string, any[]>();
    for (const r of se.rows || []) {
      const k = `${r.league?.id}|${r.team?.id}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(r);
    }
    let changed = false;
    const rows: any[] = [];
    for (const g of groups.values()) {
      if (g.length === 1) { rows.push(g[0]); continue; }
      changed = true;
      const bySeason = new Map<string, any>();
      for (const r of g) {
        const k = String(r.afSeason);
        const cur = bySeason.get(k);
        if (!cur || r.apps > cur.apps || (r.apps === cur.apps && r.minutes > cur.minutes)) bySeason.set(k, r);
      }
      const kept = [...bySeason.values()];
      if (kept.length === 1) rows.push(kept[0]);
      else for (const r of kept) rows.push({ ...r, league: { ...r.league, name: `${r.league?.name} ${yearsOf(r)}` } });
    }
    if (!changed) return se;
    rows.sort((a, b) => (b.minutes || 0) - (a.minutes || 0));
    return { ...se, rows, totals: totalsOf(rows) };
  });
  const all = seasons.flatMap((se: any) => se.rows);
  const career = data.career ? { ...data.career, ...totalsOf(all), seasons: data.career.seasons, from: data.career.from } : data.career;
  return { ...data, seasons, career };
}

/**
 * wait: always the up-to-date page (the data check), never the saved copy while it is being rebuilt;
 * minBuiltAt (fix240, the data check): a copy built before this time is rebuilt (his club played since)
 */
export async function playerPage(rawId: number, full: boolean, wait = false, minBuiltAt = 0) {
  const pid = rawId >= AF_OFFSET ? rawId - AF_OFFSET : rawId;
  const data: any = tidySeasons(await pageData(pid, wait, minBuiltAt));
  // fix176: builtAt = the last refresh of the page's numbers — a season answer fetched since the page was stored counts
  // (the audit found builtAt 30 Sep on a page with data to 17 Oct; the admin data-health check reads it)
  try {
    const last = (db.prepare(`SELECT MAX(fetched_at) AS at FROM player_season_raw WHERE player_id = ? AND season >= ?`).get(pid, seasonNow() - 1) as any)?.at as string | undefined;
    if (last && (!data.builtAt || last > data.builtAt)) data.builtAt = last;
  } catch { /* table missing */ }
  if (full) return { ...data, premium: true };
  const lite = (r: any) => ({ league: r.league, team: r.team, position: r.position, apps: r.apps, goals: r.goals });
  return {
    ...data,
    premium: false,
    seasons: data.seasons.map((s: any) => ({ ...s, rows: s.rows.map(lite), totals: { apps: s.totals.apps, goals: s.totals.goals } })),
    international: (data.international || []).map((r: any) => ({ ...lite(r), from: r.from, to: r.to })),
    career: data.career ? { apps: data.career.apps, goals: data.career.goals, seasons: data.career.seasons, from: data.career.from } : null,
    internationalTotals: (data.internationalTotals || []).map((t: any) => ({ team: t.team, apps: t.apps, goals: t.goals })),
    sidelined: [],
    locked: ['Minutes, assists, rating, cards, shots, passes and duels for every competition', 'Injury history']
  };
}

/* ---------- Football-Data.org scorer → API-Football player ---------- */

const plain = (s: string) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** fix264: shared with the twin finder (utils/nameMatch.ts); `loose` inside one club or league only */
const sameName = (a: string, b: string, loose = false) => samePlayerName(a, b, loose);

const findCache = new Map<string, number | null>();
// Football-Data.org competition code → API-Football league id
export const FD_TO_AF: Record<string, number> = { PL: 39, ELC: 40, PD: 140, SA: 135, BL1: 78, FL1: 61, DED: 88, PPL: 94, BSA: 71, CL: 2, EC: 4, WC: 1 };

/** fix264: the one player of a provider answer with this name (exact spellings first; the loose one only when unique) */
function pickByName(list: any[], name: string, loose: boolean): number | null {
  const is = (it: any, l: boolean) => sameName(it.player?.name, name, l) || sameName(`${it.player?.firstname} ${it.player?.lastname}`, name, l);
  const exact = list.find((it: any) => is(it, false));
  if (exact) return exact.player?.id ?? null;
  if (!loose) return null;
  const ids = [...new Set(list.filter((it: any) => is(it, true)).map((it: any) => it.player?.id).filter(Boolean))];
  return ids.length === 1 ? ids[0] as number : null;
}
export async function findPlayer(name: string, teamId: number, code?: string, teamName?: string): Promise<number | null> {
  const key = `${name}|${teamId}|${code}`;
  if (findCache.has(key)) return findCache.get(key)!;
  const af = resolveAfTeamId(teamId, code, teamName);
  let hit: number | null = null;
  if (af) {
    const S = seasonNow();
    // fix240: this season's record first, then the one with the most minutes — the first name match could be last
    // season's id or a second record of the same player with no league numbers ("his page has no league row")
    const rows = db.prepare(`SELECT player_id, name, MAX(season) AS season, SUM(COALESCE(minutes, 0)) AS minutes FROM af_player_season WHERE team_id = ? AND season IN (?, ?)
      GROUP BY player_id, name ORDER BY MAX(season) DESC, SUM(COALESCE(minutes, 0)) DESC`).all(af, S, S - 1) as any[];
    const main = twinMainOf();
    // fix264: the exact spellings first, then the loose one ("Marcus Thuram-Ulien" = "Marcus Thuram") — his club only
    hit = rows.find(r => sameName(r.name, name))?.player_id ?? null;
    if (!hit) { const ids = [...new Set(rows.filter(r => sameName(r.name, name, true)).map(r => r.player_id))]; if (ids.length === 1) hit = ids[0]; }
    if (hit && main.has(hit)) hit = main.get(hit)!;
    for (const term of nameSearchTerms(name)) {
      if (hit || afRemaining() <= 500) break;
      try {
        const j: any = await afGet('/players', { team: af, season: S, search: term });
        hit = pickByName(j.response || [], name, true);
      } catch (e: any) {
        logger.warn(`player find ${name}: ${e.message}`);
      }
    }
  }
  // promoted clubs the history mapping doesn't know yet: search the league instead of the team
  for (const term of code && FD_TO_AF[code] ? nameSearchTerms(name) : []) {
    if (hit || afRemaining() <= 500) break;
    try {
      const j: any = await afGet('/players', { league: FD_TO_AF[code!], season: seasonNow(), search: term });
      // fix264: the loose spelling only when one player of the league fits it
      hit = pickByName(j.response || [], name, true);
    } catch (e: any) {
      logger.warn(`player find (league) ${name}: ${e.message}`);
    }
  }
  // last resort: the provider's profile search (all players, any club)
  if (!hit && afRemaining() > 500) {
    const last = plain(name).split(' ').pop() || '';
    if (last.length >= 4) {
      try {
        const j: any = await afGet('/players/profiles', { search: last });
        const cands = (j.response || []).filter((it: any) => sameName(it.player?.name, name) || sameName(`${it.player?.firstname} ${it.player?.lastname}`, name));
        if (cands.length === 1) hit = cands[0].player.id; // only when it is unambiguous
      } catch (e: any) {
        logger.warn(`player find (profiles) ${name}: ${e.message}`);
      }
    }
  }
  findCache.set(key, hit);
  return hit;
}
