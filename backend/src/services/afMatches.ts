/**
 * Extra competitions from API-Football (national teams, Europa/Conference League, Israel, Saudi Arabia,
 * more European leagues), served in the SAME shape as Football-Data.org matches so every page works
 * unchanged. Ids are offset so they never collide with Football-Data.org ids:
 *   match id = AF_OFFSET + fixture id,  team id = AF_OFFSET + team id,  competition code = "AF<league id>".
 *
 * Budget (Pro 7,500/day): fixture window every 30 min (~15 leagues), live scores every 60 s only while one of
 * these matches is in play, match details / tables / scorers / odds on demand with caching.
 */
import { withLive } from './liveChance';
import { cachedPredictions, mainPrediction } from './predCache';
import { isTrialCompetition } from './trial';
import logger from '../utils/logger';
import { markFresh } from './freshness';
import { freezePredictions } from './tracking';
import { db } from '../db';
import { playerValue } from './squadValues';
import { afGet, afConfigured, afRemaining } from './apiFootball';
import { predictFromStandings, Prediction } from './predictionModel';
import { groupForCompetition, buildTeamMap, fdNameFor } from './history';
import { predictV2 } from './historyModel';
import { predictV3 } from './gridModel';
import { mixPredictions } from './featureModel';
import { reportLive } from './liveScores';
import { predictNational, isNationalTeam } from './nationalElo';
import { predictClubEuro } from './clubElo';
import { onExtraLeague } from './leagueConfig';
import { every, after, yielder } from './perf';

export const AF_OFFSET = 1_000_000_000;
export const isAfMatchId = (id: number) => id >= AF_OFFSET;
export const isAfCode = (code: string) => /^AF\d+$/i.test(code);

type Kind = 'national' | 'cup' | 'league';
export const EXTRA_COMPETITIONS: { id: number; kind: Kind; name?: string }[] = [
  // National teams
  { id: 5, kind: 'national' }, // UEFA Nations League
  { id: 10, kind: 'national' }, // International friendlies
  { id: 32, kind: 'national' }, // World Cup qualification — Europe
  { id: 34, kind: 'national' }, // World Cup qualification — South America
  { id: 29, kind: 'national' }, // World Cup qualification — Africa
  { id: 30, kind: 'national' }, // World Cup qualification — Asia
  { id: 31, kind: 'national' }, // World Cup qualification — CONCACAF
  { id: 960, kind: 'national' }, // Euro qualification
  // European cups
  { id: 3, kind: 'cup' }, // UEFA Europa League
  { id: 848, kind: 'cup' }, // UEFA Conference League
  // Israel + Middle East
  { id: 383, kind: 'league' }, // Israel — Ligat Ha'Al
  { id: 307, kind: 'league' }, // Saudi Pro League
  // More European leagues
  { id: 144, kind: 'league' }, // Belgium — Jupiler Pro League
  { id: 203, kind: 'league' }, // Turkey — Süper Lig
  { id: 179, kind: 'league' }, // Scotland — Premiership
  { id: 197, kind: 'league' }, // Greece — Super League 1
  { id: 218, kind: 'league' }, // Austria — Bundesliga
  { id: 207, kind: 'league' }, // Switzerland — Super League
  // Oct 2026: 15 more leagues, tracked as "new" until v3 has proven itself on each (see services/trial.ts)
  { id: 79, kind: 'league' }, // Germany — 2. Bundesliga
  { id: 136, kind: 'league' }, // Italy — Serie B
  { id: 141, kind: 'league' }, // Spain — LaLiga 2
  { id: 62, kind: 'league' }, // France — Ligue 2
  { id: 180, kind: 'league' }, // Scotland — Championship
  { id: 41, kind: 'league' }, // England — League One
  { id: 71, kind: 'league' }, // Brazil — Série A
  { id: 128, kind: 'league' }, // Argentina — Liga Profesional
  { id: 253, kind: 'league' }, // USA — MLS
  { id: 262, kind: 'league' }, // Mexico — Liga MX
  { id: 98, kind: 'league' }, // Japan — J1 League
  { id: 119, kind: 'league' }, // Denmark — Superliga
  { id: 106, kind: 'league' }, // Poland — Ekstraklasa
  { id: 103, kind: 'league' }, // Norway — Eliteserien
  { id: 113, kind: 'league' } // Sweden — Allsvenskan
];
// Leagues added from the admin panel (services/leagueConfig.ts)
onExtraLeague(l => { if (!EXTRA_COMPETITIONS.some(c => c.id === l.id)) EXTRA_COMPETITIONS.push({ id: l.id, kind: 'league' }); });
const KIND_RANK: Record<Kind, number> = { cup: 1, league: 2, national: 3 };
/** Senior men's teams only: API-Football's "Friendlies" also carries U17–U23 and women's sides. */
const YOUTH = /\bU-?(1[5-9]|2[0-3])\b|\bUnder[- ]?\d{2}\b|\b(W|Women)$/i;
const senior = (f: any) => !YOUTH.test(f.teams?.home?.name || '') && !YOUTH.test(f.teams?.away?.name || '');
const WINDOW_DAYS = 30;

/* ------------------------------------------------------------------ */
/* Small cache                                                          */
/* ------------------------------------------------------------------ */

const cache = new Map<string, { data: any; expires: number }>();
async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.data as T;
  const data = await load();
  cache.set(key, { data, expires: Date.now() + ttlMs });
  return data;
}
// drop expired entries so the cache can't grow without limit
every('AF cache cleanup', () => {
  const now = Date.now();
  for (const [k, v] of cache) if (v.expires < now) cache.delete(k);
}, 10 * 60 * 1000).unref();

/* ------------------------------------------------------------------ */
/* Conversion to Football-Data.org shape                                */
/* ------------------------------------------------------------------ */

const STATUS: Record<string, string> = {
  TBD: 'SCHEDULED', NS: 'TIMED', '1H': 'IN_PLAY', HT: 'PAUSED', '2H': 'IN_PLAY', ET: 'IN_PLAY', BT: 'PAUSED', P: 'IN_PLAY',
  SUSP: 'SUSPENDED', INT: 'SUSPENDED', FT: 'FINISHED', AET: 'FINISHED', PEN: 'FINISHED', PST: 'POSTPONED',
  CANC: 'CANCELLED', ABD: 'CANCELLED', AWD: 'AWARDED', WO: 'AWARDED', LIVE: 'IN_PLAY'
};

const leagueMeta = new Map<number, { name: string; logo: string; country: string; flag: string | null; season: number; kind: Kind }>();

export function afTeam(t: any) {
  if (!t) return null;
  return { id: AF_OFFSET + t.id, name: t.name, shortName: t.name, tla: String(t.name || '').replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase(), crest: t.logo };
}

/*
 * Every national-team competition, not only the fixed list: API-Football files them under country "World".
 * Club, youth, women's, futsal and similar "World" competitions are left out by name.
 */
const NOT_NATIONAL = /club|champions (league|cup)|challenge league|central american cup|caribbean cup|shield|libertadores|sudamericana|recopa|leagues cup|confederation cup|afc cup|super cup|intercontinental|youth|\bu-?\d{2}\b|under[- ]?\d{2}|women|olympic|futsal|beach|e-?soccer|premier league international|challenge cup|charity|reserve|amateur|universit|military|toulon|revello|emirates cup|audi cup|trophy/i;
export function isNationalLeague(league: any): boolean {
  if (EXTRA_COMPETITIONS.some(c => c.id === league?.id && c.kind === 'national')) return true;
  return league?.country === 'World' && !NOT_NATIONAL.test(String(league?.name || ''));
}

function competitionOf(league: any) {
  const kind: Kind = EXTRA_COMPETITIONS.find(c => c.id === league.id)?.kind || (isNationalLeague(league) ? 'national' : 'league');
  const country = league.country && !['World', 'Europe'].includes(league.country) ? league.country : null;
  return {
    id: AF_OFFSET + league.id,
    code: `AF${league.id}`,
    ...(isTrialCompetition(`AF${league.id}`) ? { trial: true } : {}),
    name: country && kind === 'league' ? `${league.name} (${country})` : league.name,
    emblem: league.logo,
    type: kind === 'national' ? 'NATIONAL' : kind === 'cup' ? 'CUP' : 'LEAGUE',
    rank: KIND_RANK[kind],
    source: 'api-football'
  };
}

export function toFdMatch(f: any) {
  const st = f.fixture?.status || {};
  const round: string = f.league?.round || '';
  const md = round.match(/(\d+)\s*$/);
  const hg = f.goals?.home ?? null, ag = f.goals?.away ?? null;
  const status = STATUS[st.short] || 'SCHEDULED';
  return {
    id: AF_OFFSET + f.fixture.id,
    utcDate: new Date(f.fixture.date).toISOString(),
    status,
    minute: st.elapsed ?? null,
    injuryTime: st.extra ?? null,
    matchday: /regular season|group|league stage/i.test(round) && md ? parseInt(md[1], 10) : null,
    stage: /regular season/i.test(round) ? 'REGULAR_SEASON' : round.toUpperCase().replace(/\s+/g, '_') || null,
    group: null,
    venue: f.fixture?.venue?.name || null,
    competition: competitionOf(f.league),
    area: { name: f.league?.country, flag: f.league?.flag },
    season: { startDate: `${f.league?.season}-07-01`, endDate: `${(f.league?.season || 0) + 1}-06-30` },
    homeTeam: afTeam(f.teams?.home),
    awayTeam: afTeam(f.teams?.away),
    score: {
      winner: hg === null || ag === null || status !== 'FINISHED' ? null : hg > ag ? 'HOME_TEAM' : hg < ag ? 'AWAY_TEAM' : 'DRAW',
      fullTime: { home: hg, away: ag },
      halfTime: { home: f.score?.halftime?.home ?? null, away: f.score?.halftime?.away ?? null }
    },
    referees: f.fixture?.referee ? [{ id: 0, name: String(f.fixture.referee).split(',')[0], type: 'REFEREE' }] : [],
    source: 'api-football'
  };
}

const POS: Record<string, string> = { G: 'Goalkeeper', D: 'Defence', M: 'Midfield', F: 'Offence' };
const STAT_KEYS: Record<string, string> = {
  'Ball Possession': 'ball_possession', 'Total Shots': 'shots', 'Shots on Goal': 'shots_on_goal', 'Shots off Goal': 'shots_off_goal',
  'Blocked Shots': 'blocked_shots', 'Shots insidebox': 'shots_inside_box', 'Shots outsidebox': 'shots_outside_box',
  'Corner Kicks': 'corner_kicks', Fouls: 'fouls', Offsides: 'offsides', 'Goalkeeper Saves': 'saves',
  'Yellow Cards': 'yellow_cards', 'Red Cards': 'red_cards', 'Total passes': 'passes', 'Passes accurate': 'passes_accurate',
  'Passes %': 'pass_accuracy', expected_goals: 'expected_goals', goals_prevented: 'goals_prevented'
};

/** Full match (events, lineups, statistics) from /fixtures?id=. */
function toFdMatchFull(f: any) {
  const m: any = toFdMatch(f);
  const team = (t: any) => ({ id: AF_OFFSET + t.id, name: t.name });
  for (const side of ['homeTeam', 'awayTeam'] as const) {
    const afId = side === 'homeTeam' ? f.teams.home.id : f.teams.away.id;
    const lu = (f.lineups || []).find((l: any) => l.team?.id === afId);
    if (lu) {
      // Small nations often have players without an API-Football id: keep them (synthetic negative id), never drop them.
      // grid = "row:col" from API-Football (row 1 = goalkeeper), used to draw the pitch exactly.
      const pl = (x: any, i: number, bench = false) => ({
        id: x.player.id ? AF_OFFSET + x.player.id : -((side === 'homeTeam' ? 1000 : 2000) + (bench ? 100 : 0) + i),
        name: x.player.name || '?', position: POS[x.player.pos] || null, shirtNumber: x.player.number ?? null, grid: x.player.grid || null
      });
      m[side].formation = lu.formation || null;
      m[side].lineup = (lu.startXI || []).filter((x: any) => x.player?.name).map((x: any, i: number) => pl(x, i));
      m[side].bench = (lu.substitutes || []).filter((x: any) => x.player?.name).map((x: any, i: number) => pl(x, i, true));
      m[side].coach = lu.coach?.name ? { id: lu.coach.id, name: lu.coach.name } : null;
    }
    const st = (f.statistics || []).find((s: any) => s.team?.id === afId);
    if (st) {
      const out: Record<string, number> = {};
      for (const s of st.statistics || []) {
        const k = STAT_KEYS[s.type];
        if (!k || s.value === null || s.value === undefined) continue;
        const v = typeof s.value === 'string' ? parseFloat(s.value) : s.value;
        if (Number.isFinite(v)) out[k] = v;
      }
      m[side].statistics = out;
    }
  }
  const goals: any[] = [], bookings: any[] = [], subs: any[] = [];
  for (const e of f.events || []) {
    const minute = e.time?.elapsed ?? 0;
    const extra = e.time?.extra ?? null;
    if (e.type === 'Goal' && !/missed/i.test(e.detail || '')) {
      goals.push({
        minute, injuryTime: extra,
        type: /own/i.test(e.detail) ? 'OWN' : /penalty/i.test(e.detail) ? 'PENALTY' : 'REGULAR',
        team: team(e.team), scorer: { id: AF_OFFSET + (e.player?.id || 0), name: e.player?.name || '?' },
        assist: e.assist?.name ? { id: AF_OFFSET + (e.assist.id || 0), name: e.assist.name } : null
      });
    } else if (e.type === 'Card') {
      bookings.push({
        minute, team: team(e.team), player: { id: AF_OFFSET + (e.player?.id || 0), name: e.player?.name || '?' },
        card: /second yellow/i.test(e.detail) ? 'YELLOW_RED' : /red/i.test(e.detail) ? 'RED' : 'YELLOW'
      });
    } else if (e.type === 'subst') {
      // API-Football: "player" = player coming ON, "assist" = player going OFF
      subs.push({
        minute, team: team(e.team),
        playerIn: { id: AF_OFFSET + (e.player?.id || 0), name: e.player?.name || '?' },
        playerOut: { id: AF_OFFSET + (e.assist?.id || 0), name: e.assist?.name || '?' }
      });
    }
  }
  m.goals = goals;
  m.bookings = bookings;
  m.substitutions = subs;
  return m;
}

/** API-Football standings → Football-Data.org standings (TOTAL / HOME / AWAY tables, one per group). */
function toFdStandings(resp: any) {
  const league = resp?.[0]?.league;
  if (!league) return null;
  const groups: any[][] = league.standings || [];
  const tables: any[] = [];
  const row = (r: any, key: 'all' | 'home' | 'away') => ({
    position: r.rank,
    team: { id: AF_OFFSET + r.team.id, name: r.team.name, shortName: r.team.name, tla: '', crest: r.team.logo },
    playedGames: r[key]?.played ?? 0,
    form: key === 'all' && r.form ? r.form.split('').join(',') : null,
    won: r[key]?.win ?? 0, draw: r[key]?.draw ?? 0, lost: r[key]?.lose ?? 0,
    points: key === 'all' ? r.points : (r[key]?.win ?? 0) * 3 + (r[key]?.draw ?? 0),
    goalsFor: r[key]?.goals?.for ?? 0, goalsAgainst: r[key]?.goals?.against ?? 0,
    goalDifference: key === 'all' ? r.goalsDiff : (r[key]?.goals?.for ?? 0) - (r[key]?.goals?.against ?? 0)
  });
  for (const g of groups) {
    const groupName = groups.length > 1 ? g[0]?.group || null : null;
    for (const [type, key] of [['TOTAL', 'all'], ['HOME', 'home'], ['AWAY', 'away']] as const)
      tables.push({ stage: 'REGULAR_SEASON', type, group: groupName, table: g.map(r => row(r, key)) });
  }
  return {
    competition: { id: AF_OFFSET + league.id, name: league.name, code: `AF${league.id}`, emblem: league.logo },
    season: { startDate: `${league.season}-07-01` },
    standings: tables
  };
}

/* ------------------------------------------------------------------ */
/* Window + live                                                        */
/* ------------------------------------------------------------------ */

let windowMatches: any[] = [];
let windowAt: number | null = null;
// The last window is kept in the database so the match list is complete right after a restart / deploy
// (a fresh refresh takes a minute or two); replaced by the live one as soon as that is ready.
db.exec(`CREATE TABLE IF NOT EXISTS af_window_store (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL, at TEXT NOT NULL)`);
try {
  const row: any = db.prepare(`SELECT json, at FROM af_window_store WHERE id = 1`).get();
  if (row) {
    const since = new Date(Date.now() - 86400000).toISOString();
    windowMatches = (JSON.parse(row.json) as any[]).filter(m => m.utcDate >= since);
    windowAt = new Date(row.at).getTime();
  }
} catch { /* first run */ }
let liveById = new Map<number, any>();
// the whole live=all answer (every fixture in play, ours or not) by API-Football fixture id, and when it was fetched:
// Football-Data.org matches take their fresher live score from it (syncFdLiveFromAf, liveScores.ts)
let afLiveRaw = new Map<number, any>();
let afLiveAt = 0;
const standingsByCode = new Map<string, any>();

async function currentSeason(leagueId: number): Promise<number | null> {
  return cached(`season:${leagueId}`, 24 * 3600 * 1000, async () => {
    const j = await afGet('/leagues', { id: leagueId, current: 'true' });
    const l = j.response?.[0];
    if (!l) return null;
    const season = l.seasons?.find((s: any) => s.current)?.year ?? l.seasons?.[l.seasons.length - 1]?.year ?? null;
    const kind = EXTRA_COMPETITIONS.find(c => c.id === leagueId)?.kind || 'league';
    if (season) leagueMeta.set(leagueId, { name: l.league?.name, logo: l.league?.logo, country: l.country?.name, flag: l.country?.flag, season, kind });
    return season;
  });
}

let windowListener: ((matches: any[]) => void) | null = null;
/** Called after every window refresh (used to record predictions for tracking). */
export function onAfWindow(fn: (matches: any[]) => void) {
  windowListener = fn;
}

/** Only fixtures we know about get a details page (stops random ids from spending API-Football requests). */
export function isKnownAfFixture(matchId: number): boolean {
  if (windowMatches.some(m => m.id === matchId) || liveById.has(matchId)) return true;
  const fid = matchId - AF_OFFSET;
  for (const t of ['af_fixtures', 'eur_matches', 'nat_matches']) {
    try {
      if (db.prepare(`SELECT 1 FROM ${t} WHERE fixture_id = ?`).get(fid)) return true;
    } catch {
      /* table not created yet */
    }
  }
  return db.prepare(`SELECT 1 FROM predictions WHERE match_id = ? LIMIT 1`).get(matchId) ? true : false;
}

const natDays = new Map<string, { at: number; matches: any[] }>();
async function nationalByDate(from: string, to: string): Promise<any[]> {
  const out: any[] = [];
  const start = new Date(from + 'T00:00:00Z').getTime(), end = new Date(to + 'T00:00:00Z').getTime();
  const now = Date.now();
  for (let t = start; t <= end; t += 86400000) {
    const day = new Date(t).toISOString().slice(0, 10);
    const near = t <= now + 2 * 86400000;
    const have = natDays.get(day);
    if (!have || now - have.at > (near ? 25 * 60 * 1000 : 6 * 3600 * 1000)) {
      try {
        const j = await afGet('/fixtures', { date: day });
        const ms: any[] = [];
        for (const f of j.response || []) {
          if (!isNationalLeague(f.league) || !senior(f)) continue;
          if (!leagueMeta.has(f.league.id))
            leagueMeta.set(f.league.id, { name: f.league.name, logo: f.league.logo, country: f.league.country, flag: f.league.flag || null, season: f.league.season, kind: 'national' });
          ms.push(toFdMatch(f));
        }
        natDays.set(day, { at: now, matches: ms });
      } catch (e: any) {
        logger.warn(`AF national ${day}: ${e.message}`);
      }
    }
    out.push(...(natDays.get(day)?.matches || []));
  }
  for (const k of natDays.keys()) if (k < from) natDays.delete(k);
  return out;
}

export async function refreshAfWindow() {
  if (!afConfigured()) return 0;
  const from = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
  const to = new Date(Date.now() + WINDOW_DAYS * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const all: any[] = [];
  let failed = 0;
  for (const c of EXTRA_COMPETITIONS) {
    try {
      const season = await currentSeason(c.id);
      if (!season) continue;
      const j = await afGet('/fixtures', { league: c.id, season, from, to });
      for (const f of j.response || []) if (senior(f)) all.push(toFdMatch(f));
    } catch (e: any) {
      failed++;
      logger.warn(`AF window ${c.id}: ${e.message}`);
    }
  }
  // All other national-team competitions (CONCACAF Nations League, Asian/African qualifiers, regional cups…),
  // found day by day: one request per date, near dates every run, the rest every 6 hours
  const national = await nationalByDate(from, to);
  const seen = new Set(all.map(m => m.id));
  for (const m of national) if (!seen.has(m.id)) all.push(m);
  // international friendlies (AF10) sometimes list club vs national-team games (Konyaspor – Palestine): keep only
  // games between two national teams we have a rating for
  for (let i = all.length - 1; i >= 0; i--) {
    const m = all[i];
    if (m.competition?.code === 'AF10' && !(isNationalTeam(m.homeTeam?.id - AF_OFFSET) && isNationalTeam(m.awayTeam?.id - AF_OFFSET))) all.splice(i, 1);
  }
  if (failed && windowMatches.length && all.length < windowMatches.length * 0.5) return windowMatches.length; // keep a healthy window
  windowMatches = all.sort((a, b) => a.utcDate.localeCompare(b.utcDate));
  windowAt = Date.now();
  markFresh('extra-fixtures', `${windowMatches.length} matches`);
  try { db.prepare(`INSERT OR REPLACE INTO af_window_store (id, json, at) VALUES (1, ?, ?)`).run(JSON.stringify(windowMatches), new Date(windowAt).toISOString()); } catch (e: any) { logger.warn(`AF window store: ${e.message}`); }
  try {
    windowListener?.(windowMatches);
  } catch (e: any) {
    logger.warn(`AF window listener: ${e.message}`);
  }
  // Standings for leagues/cups with tables (not friendlies), for the v1 model and the league panel
  const fixedCodes = new Set(EXTRA_COMPETITIONS.filter(c => c.id !== 10).map(c => `AF${c.id}`));
  const codes = [...new Set(windowMatches.map(m => m.competition.code))].filter(c => fixedCodes.has(c));
  for (const code of codes) await getAfStandings(code).catch(() => null);
  return windowMatches.length;
}

/** Live scores for our extra competitions — one request, only while one of them can be in play. */
/*
 * Games that need their true state from the provider: ones that just dropped out of the live list (the last live
 * poll can miss a stoppage-time goal) and ones still shown as live or not started long after kick-off (a provider
 * hiccup). Checked by fixture id, up to 20 per request, each at most every 10 minutes.
 */
const lastChecked = new Map<number, number>();
async function confirmStates(ids: number[]) {
  const now = Date.now();
  const todo = ids.filter(id => (lastChecked.get(id) || 0) < now - 10 * 60 * 1000).slice(0, 20);
  if (!todo.length || afRemaining() < 100) return 0;
  todo.forEach(id => lastChecked.set(id, now));
  if (lastChecked.size > 5000) for (const [k, t] of lastChecked) if (t < now - 86400000) lastChecked.delete(k);
  try {
    const j = await afGet('/fixtures', { ids: todo.map(id => id - AF_OFFSET).join('-') });
    const fresh = new Map<number, any>((j.response || []).map((f: any) => { const m = toFdMatch(f); return [m.id, m]; }));
    windowMatches = windowMatches.map(m => {
      const f = fresh.get(m.id);
      return f ? { ...m, status: f.status, minute: f.minute, injuryTime: f.injuryTime, score: f.score } : m;
    });
    return fresh.size;
  } catch (e: any) {
    logger.warn(`AF confirm states: ${e.message}`);
    return 0;
  }
}

const FINAL = ['FINISHED', 'CANCELLED', 'POSTPONED', 'AWARDED'];
/** In-window games that should have a result by now but don't (kick-off more than 2 h 30 min ago). */
function overdue(now: number) {
  return windowMatches.filter(m => !FINAL.includes(m.status) && new Date(m.utcDate).getTime() < now - 150 * 60 * 1000 && new Date(m.utcDate).getTime() > now - 3 * 86400000);
}

/**
 * Live scores for our extra competitions — one request, only while one of them can be in play.
 * `force`: poll even when none of ours can be (Football-Data.org matches are live and want API-Football's score).
 */
export async function pollAfLive(force = false) {
  if (!afConfigured()) return [];
  const now = Date.now();
  const maybeLive = windowMatches.some(m => {
    const t = new Date(m.utcDate).getTime();
    return t <= now + 5 * 60 * 1000 && t >= now - 3 * 3600 * 1000 && !FINAL.includes(m.status);
  });
  if (!maybeLive && !force) {
    liveById = new Map();
    afLiveRaw = new Map();
    const late = overdue(now);
    if (late.length) await confirmStates(late.map(m => m.id));
    return [];
  }
  try {
    // all live fixtures in one request, kept when they belong to our window (fixed list + every national competition)
    const inWindow = new Set(windowMatches.map(m => m.id));
    const fixed = new Set(EXTRA_COMPETITIONS.map(c => c.id));
    const j = await afGet('/fixtures', { live: 'all' });
    afLiveRaw = new Map((j.response || []).filter((f: any) => f?.fixture?.id).map((f: any) => [f.fixture.id, f]));
    afLiveAt = Date.now();
    const live = (j.response || [])
      .filter((f: any) => senior(f) && (inWindow.has(AF_OFFSET + f.fixture.id) || fixed.has(f.league?.id) || isNationalLeague(f.league)))
      .map(toFdMatch);
    liveById = new Map(live.map((m: any) => [m.id, m]));
    // fold live status/score into the window
    const liveIds = new Set(liveById.keys());
    const dropped: number[] = [];
    windowMatches = windowMatches.map(m => {
      const l = liveById.get(m.id);
      if (l) return { ...m, status: l.status, minute: l.minute, injuryTime: l.injuryTime, score: l.score };
      if (['IN_PLAY', 'PAUSED'].includes(m.status)) {
        // gone from the live list: finished (or suspended). Shown as finished now, confirmed right below.
        dropped.push(m.id);
        return { ...m, status: 'FINISHED' };
      }
      return m;
    });
    // confirm the final score of games that just ended, and fix any stuck game
    const late = overdue(now).filter(m => !liveIds.has(m.id)).map(m => m.id);
    if (dropped.length || late.length) await confirmStates([...dropped, ...late]);
    return live;
  } catch (e: any) {
    logger.warn(`AF live poll: ${e.message}`);
    return [...liveById.values()];
  }
}

/** Data health: games in our extra-competition window that are overdue a result (for the health check). */
export function afOverdue() {
  return overdue(Date.now()).map(m => ({ id: m.id, home: m.homeTeam?.name, away: m.awayTeam?.name, utcDate: m.utcDate, status: m.status, minute: m.minute ?? null, competition: m.competition?.name }));
}

export function startAfMatchesScheduler() {
  if (!afConfigured()) return;
  const refresh = () => refreshAfWindow().then(n => logger.info(`AF extra competitions: ${n} matches in window`)).catch(() => undefined);
  after('AF matches', refresh, 30 * 1000);
  every('AF matches', refresh, 30 * 60 * 1000);
}

/* ------------------------------------------------------------------ */
/* Public API used by the routes                                        */
/* ------------------------------------------------------------------ */

export function afUpcoming(days = WINDOW_DAYS) {
  const cutoff = Date.now() + days * 24 * 3600 * 1000;
  return windowMatches.filter(m => new Date(m.utcDate).getTime() <= cutoff && new Date(m.utcDate).getTime() >= Date.now() - 3 * 3600 * 1000);
}
export const afLive = () => [...liveById.values()];
/** fix166: the fixture window as loaded (team pages read results / next games from it, no provider call). */
export const afWindowMatches = () => windowMatches;
export const afWindowStatus = () => ({ matches: windowMatches.length, at: windowAt ? new Date(windowAt).toISOString() : null, competitions: [...new Set(windowMatches.map(m => m.competition.name))] });

export function afCompetitions() {
  return [...leagueMeta.entries()].map(([id, l]) => ({
    id: AF_OFFSET + id, code: `AF${id}`, name: l.name, emblem: l.logo, area: { name: l.country, flag: l.flag },
    type: l.kind === 'national' ? 'NATIONAL' : l.kind === 'cup' ? 'CUP' : 'LEAGUE', currentSeason: { startDate: `${l.season}-07-01` }
  }));
}

/** Last loaded table of an API-Football competition (crawler pages; never a provider call). */
export const afStandingsCached = (code: string) => standingsByCode.get(code) || null;

export async function getAfStandings(code: string) {
  const id = parseInt(code.replace(/^AF/i, ''), 10);
  return cached(`standings:${id}`, 30 * 60 * 1000, async () => {
    const season = await currentSeason(id);
    if (!season) return null;
    const j = await afGet('/standings', { league: id, season });
    const s = toFdStandings(j.response);
    if (s) {
      standingsByCode.set(`AF${id}`, s);
      // leagues with football-data.co.uk history (Belgium, Turkey, Scotland, Greece): map team names for v2/v3
      const group = groupForCompetition(`AF${id}`);
      if (group) {
        const teams = new Map<number, any>();
        for (const t of s.standings) for (const r of t.table) teams.set(r.team.id, { id: r.team.id, name: r.team.name, shortName: r.team.shortName });
        try { buildTeamMap(group, [...teams.values()], `AF${id}`); } catch (e: any) { logger.warn(`AF team map ${group}: ${e.message}`); }
      }
    }
    return s;
  });
}

/*
 * Any API-Football competition, even one outside our fixture window (a super cup, a past tournament): its name,
 * the latest edition that has been played (results, winner of the final) — so a competition page is never empty.
 */
async function leagueSeasons(leagueId: number): Promise<number[]> {
  return cached(`seasons:${leagueId}`, 24 * 3600 * 1000, async () => {
    const j = await afGet('/leagues', { id: leagueId });
    const l = j.response?.[0];
    if (!l) return [];
    const years = (l.seasons || []).map((x: any) => x.year).filter(Boolean).sort((a: number, b: number) => b - a);
    if (!leagueMeta.has(leagueId)) {
      const kind: Kind = EXTRA_COMPETITIONS.find(c => c.id === leagueId)?.kind || (String(l.league?.type).toLowerCase() === 'cup' ? 'cup' : 'league');
      leagueMeta.set(leagueId, { name: l.league?.name, logo: l.league?.logo, country: l.country?.name, flag: l.country?.flag, season: years[0], kind });
    }
    return years;
  });
}

export async function getAfRecent(code: string) {
  const id = parseInt(code.replace(/^AF/i, ''), 10);
  return cached(`recent:${id}`, 30 * 60 * 1000, async () => {
    const years = await leagueSeasons(id);
    const meta = leagueMeta.get(id) || null;
    const competition = meta ? { code: `AF${id}`, name: meta.name, emblem: meta.logo, area: { name: meta.country, flag: meta.flag } } : null;
    for (const y of years.slice(0, 3)) {
      const j = await afGet('/fixtures', { league: id, season: y });
      const done = ((j.response || []) as any[]).filter(f => senior(f) && ['FT', 'AET', 'PEN', 'AWD', 'WO'].includes(f.fixture?.status?.short));
      if (!done.length) continue;
      done.sort((a, b) => String(b.fixture.date).localeCompare(String(a.fixture.date)));
      // the final (a single match named "Final"), and who won it, penalties included
      const fin = done.find(f => /^final$/i.test(String(f.league?.round || '').trim()));
      let winner: any = null;
      if (fin) {
        const w = fin.teams?.home?.winner ? fin.teams.home : fin.teams?.away?.winner ? fin.teams.away : null;
        if (w) winner = afTeam(w);
      }
      return {
        competition, season: y, winner,
        matches: done.slice(0, 60).map(f => ({ ...toFdMatch(f), round: f.league?.round || null, penalties: f.score?.penalty?.home != null ? { home: f.score.penalty.home, away: f.score.penalty.away } : null }))
      };
    }
    return { competition, season: null, winner: null, matches: [] };
  });
}

export async function getAfScorers(code: string, limit = 40) {
  const id = parseInt(code.replace(/^AF/i, ''), 10);
  return cached(`scorers:${id}`, 60 * 60 * 1000, async () => {
    const season = await currentSeason(id);
    if (!season) return { scorers: [] };
    let j = await afGet('/players/topscorers', { league: id, season });
    let usedSeason = season;
    if (!(j.response || []).length) {
      // nothing played yet this season (a cup between editions): the latest edition that has been played
      const recent: any = await getAfRecent(code).catch(() => null);
      if (recent?.season && recent.season !== season) { j = await afGet('/players/topscorers', { league: id, season: recent.season }); usedSeason = recent.season; }
    }
    return {
      season: usedSeason,
      scorers: (j.response || []).slice(0, limit).map((r: any) => {
        const s = r.statistics?.[0] || {};
        return {
          player: { id: AF_OFFSET + r.player.id, name: r.player.name, nationality: r.player.nationality },
          team: afTeam(s.team),
          playedMatches: s.games?.appearences ?? null,
          goals: s.goals?.total ?? 0,
          assists: s.goals?.assists ?? 0,
          penalties: s.penalty?.scored ?? null
        };
      })
    };
  });
}

/** v1 (standings) prediction when the competition has a table; none for friendlies / knockout ties. */
export function afPrediction(m: any): Prediction | null {
  const st = standingsByCode.get(m.competition?.code);
  if (!st) return null;
  const inTable = (id: number) => st.standings.some((t: any) => t.type === 'TOTAL' && t.table.some((r: any) => r.team.id === id));
  if (!inTable(m.homeTeam?.id) || !inTable(m.awayTeam?.id)) return null;
  try { return predictFromStandings(st, m.homeTeam.id, m.awayTeam.id); } catch { return null; }
}

/** Every model that covers the match: v1 (table), plus v2/v3 where the league has history (Belgium, Turkey, Scotland, Greece). */
export function afPredictions(m: any): Prediction[] {
  return cachedPredictions(m, () => freezePredictions(m, computeAfPredictions(m)));
}

function computeAfPredictions(m: any): Prediction[] {
  const out: Prediction[] = [];
  // national teams: international Elo first (the main prediction), table model as a second opinion
  if (m.competition?.type === 'NATIONAL') {
    try { const e = predictNational(m, (m.competition.id || 0) - AF_OFFSET); if (e) out.push(e); } catch { /* not rated */ }
  }
  // European cups: European club Elo first
  if (m.competition?.type === 'CUP') {
    try { const e = predictClubEuro(m); if (e) out.push(e); } catch { /* not rated */ }
  }
  const v1 = afPrediction(m);
  if (v1) out.push(v1);
  for (const f of [predictV2, predictV3]) {
    try { const p = f(m); if (p) out.push(p); } catch { /* not covered */ }
  }
  // league games with a v3 number: v3-mix and the feature model (featureModel.ts); never national teams or cups
  const v3 = out.find(p => p.model === 'grid-v3');
  if (v3 && m.competition?.type !== 'NATIONAL' && m.competition?.type !== 'CUP') {
    try { out.push(...mixPredictions(m, v3)); } catch { /* feature model not ready */ }
  }
  return out;
}

export function afWithPredictions(matches: any[]) {
  return matches.map(m => {
    const predictions = afPredictions(m);
    return withLive({ ...m, prediction: mainPrediction(predictions), predictions });
  });
}

/**
 * Bookmaker odds for window matches kicking off within the next 3 hours (so tracked predictions of national-team /
 * cup / extra-league matches carry the market too and can be compared with the bookmakers). Cached 30 min per fixture.
 */
export async function withAfOdds(matches: any[]): Promise<any[]> {
  const now = Date.now();
  const soon = matches.filter(m => {
    const t = new Date(m.utcDate).getTime();
    return t > now && t - now <= 3 * 3600_000 && !['POSTPONED', 'CANCELLED', 'SUSPENDED'].includes(m.status);
  }).slice(0, 60);
  const out: any[] = [];
  for (const m of soon) {
    if (afRemaining() < 800) break;
    try {
      const odds = await afMarket(m.id - AF_OFFSET);
      if (odds) out.push({ ...m, odds });
    } catch { /* no odds for this fixture */ }
  }
  return out;
}

/**
 * Fill in bookmaker odds for tracked API-Football matches that were saved without them (national teams, cups, extra
 * leagues) — kicked off in the last 7 days, or starting within 3 hours. API-Football keeps pre-match odds for a
 * few days after the game, so the Bookmakers view of the Accuracy page can cover every tracked game.
 * Odds are market data, not our prediction, so a locked row may still receive them.
 */
export async function backfillAfOdds(max = 40): Promise<{ checked: number; filled: number }> {
  const since = new Date(Date.now() - 7 * 86400_000).toISOString();
  const until = new Date(Date.now() + 3 * 3600_000).toISOString();
  const rows = db.prepare(`
    SELECT DISTINCT match_id, utc_date FROM predictions
    WHERE match_id >= ? AND odds_home IS NULL AND utc_date BETWEEN ? AND ?
    ORDER BY utc_date DESC LIMIT ?
  `).all(AF_OFFSET, since, until, max) as any[];
  const upd = db.prepare(`UPDATE predictions SET odds_home = ?, odds_draw = ?, odds_away = ?, updated_at = ? WHERE match_id = ? AND odds_home IS NULL`);
  let checked = 0, filled = 0;
  for (const r of rows) {
    if (afRemaining() < 800) break;
    checked++;
    try {
      const odds = await afMarket(r.match_id - AF_OFFSET);
      if (!odds) continue;
      upd.run(odds.msw.homeWin, odds.msw.draw, odds.msw.awayWin, new Date().toISOString(), r.match_id);
      filled++;
    } catch { /* no odds for this fixture */ }
  }
  if (filled) logger.info(`AF odds backfill: ${filled} of ${checked} tracked matches got bookmaker odds`);
  return { checked, filled };
}

async function afMarket(fixtureId: number) {
  return cached(`odds:${fixtureId}`, 30 * 60 * 1000, async () => {
    const j = await afGet('/odds', { fixture: fixtureId, bet: 1 });
    const books: any[] = j.response?.[0]?.bookmakers || [];
    const lines: { name: string; h: number; d: number; a: number }[] = [];
    for (const b of books) {
      const bet = (b.bets || []).find((t: any) => t.id === 1);
      if (!bet) continue;
      const odd = (v: string) => parseFloat((bet.values || []).find((x: any) => x.value === v)?.odd);
      const h = odd('Home'), d = odd('Draw'), a = odd('Away');
      if ([h, d, a].every(x => Number.isFinite(x) && x > 1)) lines.push({ name: b.name, h, d, a });
    }
    if (!lines.length) return null;
    const main = lines.find(l => l.name === 'Pinnacle') || lines.find(l => l.name === 'Bet365') || lines[0];
    const inv = 1 / main.h + 1 / main.d + 1 / main.a;
    return {
      msw: { homeWin: main.h, draw: main.d, awayWin: main.a },
      bookmaker: main.name.toLowerCase().replace(/\s+/g, '_'),
      books: lines.length,
      best: { homeWin: Math.max(...lines.map(l => l.h)), draw: Math.max(...lines.map(l => l.d)), awayWin: Math.max(...lines.map(l => l.a)) },
      probs: { home: Math.round((1 / main.h / inv) * 1000) / 10, draw: Math.round((1 / main.d / inv) * 1000) / 10, away: Math.round((1 / main.a / inv) * 1000) / 10 },
      overround: Math.round((inv - 1) * 1000) / 10,
      fetchedAt: new Date().toISOString()
    };
  });
}

async function afTeamForm(afTeamId: number) {
  return cached(`form:${afTeamId}`, 30 * 60 * 1000, async () => {
    const j = await afGet('/fixtures', { team: afTeamId, last: 5 });
    return (j.response || []).map(toFdMatch);
  });
}

async function afH2H(homeAf: number, awayAf: number, homeId: number, awayId: number) {
  return cached(`h2h:${homeAf}-${awayAf}`, 12 * 3600 * 1000, async () => {
    const j = await afGet('/fixtures/headtohead', { h2h: `${homeAf}-${awayAf}`, last: 16 });
    // the last 10 meetings that were played, however long ago, newest first
    const matches = (j.response || []).map(toFdMatch).filter((m: any) => m.status === 'FINISHED')
      .sort((a: any, b: any) => b.utcDate.localeCompare(a.utcDate)).slice(0, 10);
    const agg = { numberOfMatches: matches.length, totalGoals: 0, homeTeam: { id: homeId, wins: 0, draws: 0, losses: 0 }, awayTeam: { id: awayId, wins: 0, draws: 0, losses: 0 } };
    for (const m of matches) {
      const hg = m.score.fullTime.home ?? 0, ag = m.score.fullTime.away ?? 0;
      agg.totalGoals += hg + ag;
      const homeGoals = m.homeTeam.id === homeId ? hg : ag, awayGoals = m.homeTeam.id === homeId ? ag : hg;
      if (homeGoals > awayGoals) { agg.homeTeam.wins++; agg.awayTeam.losses++; }
      else if (homeGoals < awayGoals) { agg.homeTeam.losses++; agg.awayTeam.wins++; }
      else { agg.homeTeam.draws++; agg.awayTeam.draws++; }
    }
    return { aggregates: agg, matches };
  });
}

function standingRow(st: any, teamId: number) {
  if (!st) return null;
  const table = st.standings.find((t: any) => t.type === 'TOTAL' && t.table.some((r: any) => r.team.id === teamId));
  if (!table) return null;
  const r = table.table.find((x: any) => x.team.id === teamId);
  return r ? { ...r, group: table.group || null, teamsInTable: table.table.length } : null;
}

/** Same payload as footballDataAPI.getMatchDetails, for an API-Football match. */
/**
 * /fixtures?id= sometimes comes back without statistics or lineups while the dedicated endpoints have them
 * (they are filled at different times). Ask those endpoints directly when the fixture lacks them.
 */
async function withStatsAndLineups(raw: any) {
  if (!raw) return raw;
  const fid = raw.fixture?.id;
  const st = raw.fixture?.status?.short;
  const ko = new Date(raw.fixture?.date).getTime();
  const started = !['TBD', 'NS', 'PST', 'CANC'].includes(st);
  const live = ['1H', 'HT', '2H', 'ET', 'BT', 'P', 'LIVE'].includes(st);
  // fix162: the provider fills statistics a few minutes into a game; until 3 h after kick-off nothing is kept for 30 min
  const recent = Number.isFinite(ko) && Date.now() - ko < 3 * 3600 * 1000;
  const out = { ...raw };
  if (started && !(raw.statistics && raw.statistics.length)) {
    try {
      const j = await cached(`stats:${fid}`, live || recent ? 45 * 1000 : 30 * 60 * 1000, () => afGet('/fixtures/statistics', { fixture: fid }));
      if (j?.response?.length) out.statistics = j.response;
    } catch (e: any) {
      logger.warn(`AF statistics ${fid}: ${e.message}`);
    }
  }
  if (!(raw.lineups && raw.lineups.length) && Date.now() > ko - 75 * 60 * 1000) {
    try {
      const j = await cached(`lineups:${fid}`, 5 * 60 * 1000, () => afGet('/fixtures/lineups', { fixture: fid }));
      if (j?.response?.length) out.lineups = j.response;
    } catch (e: any) {
      logger.warn(`AF lineups ${fid}: ${e.message}`);
    }
  }
  return out;
}

export async function getAfMatchDetails(matchId: number) {
  const fixtureId = matchId - AF_OFFSET;
  const raw0 = await cached(`fixture:${fixtureId}`, 60 * 1000, async () => {
    const j = await afGet('/fixtures', { id: fixtureId });
    return j.response?.[0] || null;
  });
  if (!raw0) throw Object.assign(new Error('Match not found'), { response: { status: 404 } });
  const raw = await withStatsAndLineups(raw0);
  const match = toFdMatchFull(raw);
  const code = match.competition.code;
  const [standings, homeForm, awayForm, h2h, market] = await Promise.all([
    code !== 'AF10' ? getAfStandings(code).catch(() => null) : Promise.resolve(null),
    afTeamForm(raw.teams.home.id).catch(() => []),
    afTeamForm(raw.teams.away.id).catch(() => []),
    afH2H(raw.teams.home.id, raw.teams.away.id, match.homeTeam.id, match.awayTeam.id).catch(() => null),
    match.status === 'FINISHED' ? Promise.resolve(null) : afMarket(fixtureId).catch(() => null)
  ]);
  const predictions = afPredictions(match);
  return {
    match,
    prediction: mainPrediction(predictions),
    predictions,
    head2head: h2h,
    standings: { home: standingRow(standings, match.homeTeam.id), away: standingRow(standings, match.awayTeam.id) },
    form: { home: homeForm, away: awayForm },
    probableLineups: null,
    market
  };
}


/* ------------------------------------------------------------------ */
/* Live stats + lineups for Football-Data.org matches                   */
/* (Football-Data.org's plan has no statistics / lineups; API-Football does) */
/* ------------------------------------------------------------------ */

const FD_TO_AF_LEAGUE: Record<string, number> = { CL: 2 };
const fdToAf = new Map<number, number | null>(); // FD match id → AF fixture id (null = not found)
/** fix162: when a "not found" was stored (it is retried after 20 min); home/away swapped at API-Football */
const fdToAfMissAt = new Map<number, number>();
const fdToAfSwap = new Set<number>();

function nameKey(s: string) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ')
    .split(' ').filter(w => w && !['fc', 'cf', 'afc', 'sc', 'ac', 'as', 'ssc', 'sv', 'club', 'de', 'cp'].includes(w)).join(' ');
}
function sameTeam(a: string, b: string) {
  const x = nameKey(a), y = nameKey(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}

/**
 * Our Football-Data.org match for an API-Football fixture (the page that carries the v3 prediction), or null.
 * Same kick-off (±10 min) and at least one team name that matches; only when exactly one candidate fits.
 */
export function fdTwinOf(kickoff: string, homeName: string, awayName: string): number | null {
  const t = new Date(kickoff).getTime();
  if (!Number.isFinite(t)) return null;
  const lo = new Date(t - 10 * 60000).toISOString().slice(0, 19), hi = new Date(t + 10 * 60000 + 1000).toISOString().slice(0, 19);
  let rows: any[] = [];
  try {
    rows = db.prepare(`SELECT DISTINCT match_id, home_team, away_team FROM predictions WHERE match_id < ? AND utc_date >= ? AND utc_date < ?`).all(AF_OFFSET, lo, hi) as any[];
  } catch {
    return null;
  }
  const hits = rows.filter(r => sameTeam(r.home_team, homeName) || sameTeam(r.away_team, awayName));
  return hits.length === 1 ? hits[0].match_id : null;
}

/**
 * fix165: an API-Football match with the live state of the last live=all poll (status, minute, score, half-time),
 * applied when a details response is sent, so the match page is never older than the live list. Unchanged when the
 * fixture is not in the last poll (or the poll is over 3 min old); a finished match is never turned back to live.
 */
export function afLiveOverlay<T extends { id: number; status?: string; score?: any }>(match: T): T {
  if (!match || match.id < AF_OFFSET || Date.now() - afLiveAt > 3 * 60 * 1000) return match;
  const raw = afLiveRaw.get(match.id - AF_OFFSET);
  if (!raw) return match;
  const m: any = toFdMatch(raw);
  if (match.status === 'FINISHED' && m.status !== 'FINISHED') return match;
  return { ...match, status: m.status, minute: m.minute, injuryTime: m.injuryTime, score: { ...(match.score || {}), ...m.score } };
}

/** API-Football fixture id for a Football-Data.org match, or null. */
async function afFixtureForFd(match: any): Promise<number | null> {
  if (fdToAf.has(match.id)) {
    const v = fdToAf.get(match.id)!;
    if (v !== null || Date.now() - (fdToAfMissAt.get(match.id) || 0) < 20 * 60 * 1000) return v;
    fdToAf.delete(match.id); // fix162: try again
  }
  const day = String(match.utcDate || '').slice(0, 10);
  if (!day) return null;
  const d = new Date(day + 'T00:00:00Z').getTime();
  const lo = new Date(d - 86400000).toISOString().slice(0, 10), hi = new Date(d + 86400000).toISOString().slice(0, 10);
  let found: number | null = null;
  // domestic leagues: our own fixture table, matched through the team-name mapping used by the models
  const group = match.competition?.code ? groupForCompetition(match.competition.code) : null;
  if (group) {
    const home = fdNameFor(group, match.homeTeam?.id), away = fdNameFor(group, match.awayTeam?.id);
    if (home && away) {
      const r: any = db.prepare(`
        SELECT f.fixture_id FROM af_fixtures f
        JOIN af_teams th ON th.grp = f.grp AND th.team_id = f.home_id
        JOIN af_teams ta ON ta.grp = f.grp AND ta.team_id = f.away_id
        WHERE f.grp = ? AND th.fd_name = ? AND ta.fd_name = ? AND f.date BETWEEN ? AND ?`).get(group, home, away, lo, hi);
      if (r) found = r.fixture_id;
    }
  }
  // fix162: a fixture from our table must be this game (teams + kick-off), else look it up again below
  if (found && !(await sameGame(found, match))) { logger.warn(`AF fixture ${found} is not FD ${match.id} (${match.homeTeam?.name} – ${match.awayTeam?.name}): looking again`); found = null; }
  // cups (Champions League): that day's fixtures of the competition, matched by team names
  const leagueId = FD_TO_AF_LEAGUE[match.competition?.code];
  if (!found && leagueId) {
    try {
      const dt = new Date(day + 'T00:00:00Z');
      const season = dt.getUTCMonth() >= 6 ? dt.getUTCFullYear() : dt.getUTCFullYear() - 1; // European season = start year
      const j = await cached(`day:${leagueId}:${day}`, 6 * 3600 * 1000, () => afGet('/fixtures', { league: leagueId, season, date: day }));
      const f = (j.response || []).find((x: any) =>
        sameTeam(x.teams?.home?.name, match.homeTeam?.name) || sameTeam(x.teams?.home?.name, match.homeTeam?.shortName || '')
          ? sameTeam(x.teams?.away?.name, match.awayTeam?.name) || sameTeam(x.teams?.away?.name, match.awayTeam?.shortName || '')
          : false
      );
      if (f) found = f.fixture.id;
    } catch (e: any) {
      logger.warn(`AF lookup for FD ${match.id}: ${e.message}`);
      return null; // don't remember a failure caused by the API
    }
  }
  // anything else (national teams, other cups): every fixture of that day, matched by kick-off time and both names
  if (!found) {
    try {
      const j = await cached(`alldate:${day}`, 3 * 3600 * 1000, () => afGet('/fixtures', { date: day }));
      const ko = new Date(match.utcDate).getTime();
      const hits = (j.response || []).filter((x: any) =>
        Math.abs(new Date(x.fixture?.date).getTime() - ko) <= 2 * 3600 * 1000 && // fix162: ±2 h (moved kick-offs)
        (sameTeam(x.teams?.home?.name, match.homeTeam?.name) || sameTeam(x.teams?.home?.name, match.homeTeam?.shortName || '')) &&
        (sameTeam(x.teams?.away?.name, match.awayTeam?.name) || sameTeam(x.teams?.away?.name, match.awayTeam?.shortName || ''))
      );
      if (hits.length === 1) found = hits[0].fixture.id;
      // fix162: home and away swapped at API-Football (rare, neutral or moved games): same names the other way round
      if (!found) {
        const sw = (j.response || []).filter((x: any) =>
          Math.abs(new Date(x.fixture?.date).getTime() - ko) <= 2 * 3600 * 1000 &&
          (sameTeam(x.teams?.home?.name, match.awayTeam?.name) || sameTeam(x.teams?.home?.name, match.awayTeam?.shortName || '')) &&
          (sameTeam(x.teams?.away?.name, match.homeTeam?.name) || sameTeam(x.teams?.away?.name, match.homeTeam?.shortName || ''))
        );
        if (sw.length === 1) { found = sw[0].fixture.id; fdToAfSwap.add(match.id); }
      }
    } catch (e: any) {
      logger.warn(`AF date lookup for FD ${match.id}: ${e.message}`);
      return null;
    }
  }
  fdToAf.set(match.id, found);
  if (found === null) { fdToAfMissAt.set(match.id, Date.now()); logger.info(`AF fixture for FD ${match.id} (${match.competition?.code} ${match.homeTeam?.name} – ${match.awayTeam?.name}, ${match.utcDate}): not found`); }
  return found;
}

/** fix162: the API-Football fixture is this FD game: both teams (either way round) and kick-off within 2 h. */
async function sameGame(fid: number, match: any): Promise<boolean> {
  try {
    const x = await cached(`fixture:${fid}`, 60 * 1000, async () => (await afGet('/fixtures', { id: fid })).response?.[0] || null);
    if (!x) return false;
    const near = Math.abs(new Date(x.fixture?.date).getTime() - new Date(match.utcDate).getTime()) <= 2 * 3600 * 1000;
    const is = (a: string, t: any) => sameTeam(a, t?.name) || sameTeam(a, t?.shortName || '');
    const straight = is(x.teams?.home?.name, match.homeTeam) && is(x.teams?.away?.name, match.awayTeam);
    const swapped = is(x.teams?.home?.name, match.awayTeam) && is(x.teams?.away?.name, match.homeTeam);
    if (swapped && !straight) fdToAfSwap.add(match.id);
    return near && (straight || swapped);
  } catch { return true; } // the API failed: keep the table's answer
}

/** fix162: one log line per live match: which AF fixture we read and how many statistics it had. */
const liveStatsLogged = new Map<number, number>();
function logLiveStats(match: any, fid: number, raw: any, n: number) {
  const prev = liveStatsLogged.get(match.id);
  // once, and once more when the statistics first arrive
  if (prev !== undefined && (prev > 0 || n === 0)) return;
  liveStatsLogged.set(match.id, n);
  if (liveStatsLogged.size > 500) liveStatsLogged.clear();
  logger.info(`live stats: FD ${match.id} (${match.homeTeam?.name} – ${match.awayTeam?.name}) -> AF ${fid} (${raw?.teams?.home?.name} – ${raw?.teams?.away?.name}, ${raw?.fixture?.status?.short} ${raw?.fixture?.status?.elapsed ?? ''}'${fdToAfSwap.has(match.id) ? ', home/away swapped' : ''}), ${n} stats`);
}

/**
 * Football-Data.org live matches: report API-Football's reading of each (liveScores.ts) — from the last live=all answer,
 * or, when the fixture has just left it (ended), from /fixtures?id= (cached 45 s, only with ≥ 200 calls left today).
 */
export async function syncFdLiveFromAf(fdMatches: any[]) {
  if (!afConfigured()) return;
  for (const m of fdMatches) {
    if (!['IN_PLAY', 'PAUSED'].includes(m?.status)) continue;
    try {
      const fid = await afFixtureForFd(m);
      if (!fid) continue;
      if (fdToAfSwap.has(m.id)) continue; // fix162: home/away the other way round at API-Football
      const raw = afLiveRaw.get(fid);
      if (raw) { reportLive(m.id, 'af', toFdMatch(raw), afLiveAt); continue; }
      if (afRemaining() < 200) continue;
      const one = await cached(`fixture:${fid}`, 45 * 1000, async () => (await afGet('/fixtures', { id: fid })).response?.[0] || null);
      if (one) reportLive(m.id, 'af', toFdMatch(one));
    } catch (e: any) {
      logger.warn(`AF live score for FD ${m?.id}: ${e.message}`);
    }
  }
}

/**
 * Live statistics (possession, shots, xG, corners…), lineups and minute for a Football-Data.org match,
 * from the matching API-Football fixture. Only around the match (1 h before kick-off onwards).
 */
export async function afExtrasForFd(match: any): Promise<{ home: any; away: any; minute: number | null } | null> {
  if (!afConfigured()) return null;
  const ko = new Date(match.utcDate).getTime();
  if (!Number.isFinite(ko) || Date.now() < ko - 75 * 60 * 1000) return null;
  const fid = await afFixtureForFd(match);
  if (!fid) return null;
  const live = ['IN_PLAY', 'PAUSED'].includes(match.status);
  const done = ['FINISHED', 'AWARDED'].includes(match.status);
  const ttl = live ? 45 * 1000 : done ? 6 * 3600 * 1000 : 5 * 60 * 1000;
  const raw = await cached(`fixture:${fid}`, ttl, async () => {
    const j = await afGet('/fixtures', { id: fid });
    return j.response?.[0] || null;
  });
  if (!raw) return null;
  const swapped = fdToAfSwap.has(match.id);
  if (!swapped) reportLive(match.id, 'af', toFdMatch(raw)); // one live score everywhere (liveScores.ts); a swapped fixture's score would be the wrong way round
  const m = toFdMatchFull(await withStatsAndLineups(raw));
  const pick = (t: any) => ({ statistics: t.statistics || null, formation: t.formation || null, lineup: t.lineup || [], bench: t.bench || [], coach: t.coach || null });
  if (live) logLiveStats(match, fid, raw, Object.keys(m.homeTeam?.statistics || {}).length);
  return swapped ? { home: pick(m.awayTeam), away: pick(m.homeTeam), minute: m.minute ?? null } : { home: pick(m.homeTeam), away: pick(m.awayTeam), minute: m.minute ?? null };
}


/* ------------------------------------------------------------------ */
/* Match page extras: last-10 averages, probable lineups, last-10 H2H   */
/* (API-Football, for both API-Football and Football-Data.org matches)  */
/* ------------------------------------------------------------------ */

// Finished games never change: their statistics and lineups are kept in the database for good.
db.exec(`CREATE TABLE IF NOT EXISTS af_fixture_extra (fixture_id INTEGER NOT NULL, kind TEXT NOT NULL, json TEXT NOT NULL, fetched_at TEXT NOT NULL, PRIMARY KEY (fixture_id, kind))`);
const getExtra = db.prepare(`SELECT json FROM af_fixture_extra WHERE fixture_id = ? AND kind = ?`);
const putExtra = db.prepare(`INSERT OR REPLACE INTO af_fixture_extra (fixture_id, kind, json, fetched_at) VALUES (?, ?, ?, ?)`);

async function storedFixturePart(fixtureId: number, kind: 'statistics' | 'lineups'): Promise<any[]> {
  const row: any = getExtra.get(fixtureId, kind);
  if (row) return JSON.parse(row.json);
  // an empty answer may still be filled later by the provider: remember it, but only in memory for a day
  return cached(`part:${kind}:${fixtureId}`, 24 * 3600 * 1000, async () => {
    const j = await afGet(`/fixtures/${kind}`, { fixture: fixtureId });
    const resp = j.response || [];
    if (resp.length) putExtra.run(fixtureId, kind, JSON.stringify(resp), new Date().toISOString());
    return resp;
  });
}

/**
 * Load statistics + lineups of many finished games in ONE request (/fixtures?ids= takes up to 20 ids and returns
 * each fixture with its statistics and lineups), and store them. Ten games cost 1 request instead of 15.
 */
async function prefetchFixtureParts(fixtureIds: number[]) {
  const missing = fixtureIds.filter(id => (['statistics', 'lineups'] as const).some(k => !getExtra.get(id, k) && !cache.has(`part:${k}:${id}`)));
  for (let i = 0; i < missing.length; i += 20) {
    const chunk = missing.slice(i, i + 20);
    let resp: any[] = [];
    try {
      resp = (await afGet('/fixtures', { ids: chunk.join('-') })).response || [];
    } catch (e: any) {
      logger.warn(`AF fixtures batch: ${e.message}`);
      continue; // the per-game calls below still fill the gaps
    }
    const now = new Date().toISOString();
    for (const f of resp) {
      const id = f.fixture?.id;
      if (!id) continue;
      for (const kind of ['statistics', 'lineups'] as const) {
        const part = f[kind] || [];
        if (part.length) putExtra.run(id, kind, JSON.stringify(part), now);
        else cache.set(`part:${kind}:${id}`, { data: [], expires: Date.now() + 24 * 3600 * 1000 });
      }
    }
  }
}

const FINISHED_SHORT = new Set(['FT', 'AET', 'PEN']);
const inflight = new Map<string, Promise<any>>();
function once<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const run = inflight.get(key);
  if (run) return run;
  const p = cached(key, ttlMs, load).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** A team's last `n` finished games (raw API-Football fixtures, newest first). */
async function lastFinished(afTeamId: number, n: number): Promise<any[]> {
  return once(`lastfin:${afTeamId}:${n}`, 4 * 3600 * 1000, async () => {
    const j = await afGet('/fixtures', { team: afTeamId, last: n + 6 });
    return (j.response || [])
      .filter((f: any) => FINISHED_SHORT.has(f.fixture?.status?.short))
      .sort((a: any, b: any) => new Date(b.fixture.date).getTime() - new Date(a.fixture.date).getTime())
      .slice(0, n);
  });
}

/** API-Football team ids of a match page (API-Football match, or the twin fixture of a Football-Data.org match). */
export async function afTeamsByAfMatchId(matchId: number): Promise<{ home: number; away: number } | null> {
  const fixtureId = matchId - AF_OFFSET;
  const raw = await cached(`fixture:${fixtureId}`, 60 * 1000, async () => {
    const j = await afGet('/fixtures', { id: fixtureId });
    return j.response?.[0] || null;
  });
  return raw ? { home: raw.teams.home.id, away: raw.teams.away.id } : null;
}

export async function afTeamsOf(match: any): Promise<{ home: number; away: number } | null> {
  if (isAfMatchId(match.id)) return { home: match.homeTeam.id - AF_OFFSET, away: match.awayTeam.id - AF_OFFSET };
  if (!afConfigured()) return null;
  const fid = await afFixtureForFd(match);
  if (!fid) return null;
  const raw = await cached(`fixture:${fid}`, 6 * 3600 * 1000, async () => {
    const j = await afGet('/fixtures', { id: fid });
    return j.response?.[0] || null;
  });
  return raw ? { home: raw.teams.home.id, away: raw.teams.away.id } : null;
}

const AVG_KEYS: [string, string][] = [
  ['ball_possession', 'Ball Possession'], ['shots', 'Total Shots'], ['shots_on_goal', 'Shots on Goal'], ['shots_off_goal', 'Shots off Goal'],
  ['corner_kicks', 'Corner Kicks'], ['fouls', 'Fouls'], ['offsides', 'Offsides'], ['saves', 'Goalkeeper Saves'],
  ['yellow_cards', 'Yellow Cards'], ['red_cards', 'Red Cards'], ['expected_goals', 'expected_goals'], ['pass_accuracy', 'Passes %']
];

/** Average per game over a team's last `n` finished games: goals for/against always, the rest where the provider has statistics. */
export async function teamAverages(afTeamId: number, n = 10) {
  return once(`avg:${afTeamId}:${n}`, 4 * 3600 * 1000, async () => {
    const games = await lastFinished(afTeamId, n);
    await prefetchFixtureParts(games.map((f: any) => f.fixture.id));
    let gf = 0, ga = 0, cleanSheets = 0, btts = 0, over25 = 0, w = 0, d = 0, l = 0;
    const sums: Record<string, { sum: number; n: number }> = {};
    const list: any[] = [];
    for (const f of games) {
      const home = f.teams.home.id === afTeamId;
      const f1 = (home ? f.goals.home : f.goals.away) ?? 0, a1 = (home ? f.goals.away : f.goals.home) ?? 0;
      gf += f1; ga += a1;
      if (a1 === 0) cleanSheets++;
      if (f1 > 0 && a1 > 0) btts++;
      if (f1 + a1 > 2) over25++;
      if (f1 > a1) w++; else if (f1 < a1) l++; else d++;
      list.push({ ...toFdMatch(f), venueSide: home ? 'H' : 'A' });
      let stats: any[] = [];
      try { stats = await storedFixturePart(f.fixture.id, 'statistics'); } catch { /* no statistics for this game */ }
      const mine = stats.find((s: any) => s.team?.id === afTeamId);
      if (!mine) continue;
      for (const [key, label] of AVG_KEYS) {
        const raw = (mine.statistics || []).find((s: any) => s.type === label)?.value;
        if (raw === null || raw === undefined) continue;
        const v = typeof raw === 'string' ? parseFloat(raw) : raw;
        if (!Number.isFinite(v)) continue;
        (sums[key] ||= { sum: 0, n: 0 }).sum += v;
        sums[key].n++;
      }
    }
    const g = games.length || 1;
    const r1 = (x: number) => Math.round(x * 10) / 10;
    const averages: Record<string, number> = {};
    for (const [k, v] of Object.entries(sums)) if (v.n >= Math.min(3, games.length)) averages[k] = k === 'expected_goals' ? Math.round((v.sum / v.n) * 100) / 100 : r1(v.sum / v.n);
    return {
      games: games.length,
      withStats: Math.max(0, ...Object.values(sums).map(v => v.n)),
      record: { won: w, draw: d, lost: l },
      goalsFor: r1(gf / g), goalsAgainst: r1(ga / g), totalGoals: r1((gf + ga) / g),
      cleanSheets, btts, over25,
      averages,
      matches: list
    };
  });
}

const POS_NAME: Record<string, string> = { G: 'Goalkeeper', D: 'Defence', M: 'Midfield', F: 'Offence' };

/**
 * The XI we expect, from a team's last `n` lineups: the formation used most (latest wins a tie), then for every
 * position of that formation the player who played there most often (latest game wins a tie).
 */
export async function probableXI(afTeamId: number, n = 5) {
  return once(`xi:${afTeamId}:${n}`, 4 * 3600 * 1000, async () => {
    const games = (await lastFinished(afTeamId, 10)).slice(0, n); // same request as the averages
    await prefetchFixtureParts(games.map((f: any) => f.fixture.id));
    const ups: { date: string; formation: string | null; xi: any[] }[] = [];
    for (const f of games) {
      let lu: any[] = [];
      try { lu = await storedFixturePart(f.fixture.id, 'lineups'); } catch { /* no lineup */ }
      const mine = lu.find((x: any) => x.team?.id === afTeamId);
      if (mine?.startXI?.length) ups.push({ date: f.fixture.date, formation: mine.formation || null, xi: mine.startXI.map((x: any) => x.player).filter((p: any) => p?.name) });
    }
    if (!ups.length) return { basedOn: 0, formation: null, lineup: [] };
    const fcount = new Map<string, number>();
    for (const u of ups) if (u.formation) fcount.set(u.formation, (fcount.get(u.formation) || 0) + 1);
    const formation = [...fcount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null; // ups are newest first → stable sort keeps the latest on a tie
    const starts = new Map<string, number>();
    const keyOf = (p: any) => (p.id ? `i${p.id}` : `n${p.name}`);
    for (const u of ups) for (const p of u.xi) starts.set(keyOf(p), (starts.get(keyOf(p)) || 0) + 1);

    const same = ups.filter(u => u.formation === formation);
    const useGrid = !!formation && same.length > 0 && same.every(u => u.xi.every((p: any) => p.grid));
    const picked = new Set<string>();
    const out: any[] = [];
    if (useGrid) {
      // slot → candidates with how often they played there
      const slots = new Map<string, Map<string, { p: any; n: number; latest: number }>>();
      same.forEach((u, gi) => u.xi.forEach((p: any) => {
        const m = slots.get(p.grid) || new Map();
        const c = m.get(keyOf(p)) || { p, n: 0, latest: gi };
        c.n++;
        m.set(keyOf(p), c);
        slots.set(p.grid, m);
      }));
      // fill the most settled slots first, so a regular is not taken by a weaker slot
      const order = [...slots.entries()].sort((a, b) => Math.max(...[...b[1].values()].map(c => c.n)) - Math.max(...[...a[1].values()].map(c => c.n)));
      for (const [grid, cands] of order) {
        const best = [...cands.values()].filter(c => !picked.has(keyOf(c.p)))
          .sort((a, b) => b.n - a.n || (starts.get(keyOf(b.p)) || 0) - (starts.get(keyOf(a.p)) || 0) || a.latest - b.latest)[0];
        // nobody left for this slot: the most used player not picked yet, from the latest game
        const p = best?.p || ups[0].xi.find((x: any) => !picked.has(keyOf(x)));
        if (!p) continue;
        picked.add(keyOf(p));
        out.push({ ...p, grid });
      }
    } else {
      const ranked = [...new Map(ups.flatMap(u => u.xi.map((p: any) => [keyOf(p), p] as [string, any]))).values()]
        .sort((a, b) => (starts.get(keyOf(b)) || 0) - (starts.get(keyOf(a)) || 0));
      const gk = ranked.find(p => p.pos === 'G');
      const rest = ranked.filter(p => p.pos !== 'G').slice(0, 10);
      const ord: Record<string, number> = { D: 0, M: 1, F: 2 };
      out.push(...(gk ? [gk] : []), ...rest.sort((a, b) => (ord[a.pos] ?? 1) - (ord[b.pos] ?? 1)).map(p => ({ ...p, grid: null })));
    }
    return {
      basedOn: ups.length,
      formation,
      lineup: out.map((p, i) => ({
        id: p.id ? AF_OFFSET + p.id : -(5000 + i),
        name: p.name,
        position: POS_NAME[p.pos] || null,
        shirtNumber: p.number ?? null,
        grid: p.grid || null,
        starts: starts.get(keyOf(p)) || 0
      }))
    };
  });
}

/** The last `n` meetings of two teams, however long ago (API-Football keeps history back to ~2010 and earlier for big leagues). */
export async function lastMeetings(homeAf: number, awayAf: number) {
  return afH2H(homeAf, awayAf, AF_OFFSET + homeAf, AF_OFFSET + awayAf);
}

/** API-Football fixture id, team ids and kick-off of a match page (an API-Football match, or a Football-Data.org match's twin). */
export async function afFixtureInfo(match: any): Promise<{ fid: number; home: number; away: number; kickoff: string } | null> {
  if (!afConfigured()) return null;
  const fid = isAfMatchId(match.id) ? match.id - AF_OFFSET : await afFixtureForFd(match);
  if (!fid) return null;
  const raw = await cached(`fixture:${fid}`, 60 * 1000, async () => {
    const j = await afGet('/fixtures', { id: fid });
    return j.response?.[0] || null;
  });
  if (!raw) return null;
  return { fid, home: raw.teams.home.id, away: raw.teams.away.id, kickoff: new Date(raw.fixture.date).toISOString() };
}

/** Players listed as out ("Missing Fixture") or doubtful ("Questionable") for a fixture, per side. */
export async function fixtureInjuries(fid: number, homeAf: number, awayAf: number) {
  return once(`inj:${fid}`, 2 * 3600 * 1000, async () => {
    const j = await afGet('/injuries', { fixture: fid });
    const side = (teamId: number) =>
      (j.response || [])
        .filter((r: any) => r.team?.id === teamId && r.player?.name)
        .map((r: any) => ({
          id: r.player.id ? AF_OFFSET + r.player.id : null,
          name: r.player.name,
          out: r.player.type !== 'Questionable',
          reason: r.player.reason || null
        }))
        // API-Football often lists the same player twice for one fixture: keep one row (out wins over doubtful)
        .reduce((acc: any[], p: any) => {
          const i = acc.findIndex(x => (p.id && x.id === p.id) || x.name === p.name);
          if (i < 0) acc.push(p);
          else if (p.out && !acc[i].out) acc[i] = p;
          return acc;
        }, [])
        .sort((a: any, b: any) => Number(b.out) - Number(a.out) || a.name.localeCompare(b.name));
    return { home: side(homeAf), away: side(awayAf) };
  });
}

/**
 * How important each player is to his team, 1–5 (Oct 2026, for the injury list):
 *  - usage: share of the team's last 10 games (all competitions) he started;
 *  - value: his market value against the average of the team's usual XI (so a star who has been out for weeks
 *    and has not started lately still counts).
 * The level is the higher of the two. null when we know neither.
 */
export const IMPORTANCE_LABEL: Record<number, string> = { 5: 'Key player', 4: 'Important', 3: 'Regular', 2: 'Rotation', 1: 'Fringe' };
export async function squadImportance(afTeamId: number) {
  return once(`imp:${afTeamId}`, 4 * 3600 * 1000, async () => {
    const games = await lastFinished(afTeamId, 10);
    await prefetchFixtureParts(games.map((f: any) => f.fixture.id));
    let club: string | null = null;
    let of = 0;
    const starts = new Map<number, number>();
    const names = new Map<number, string>();
    for (const f of games) {
      club = club || (f.teams?.home?.id === afTeamId ? f.teams.home.name : f.teams?.away?.name) || null;
      let lu: any[] = [];
      try { lu = await storedFixturePart(f.fixture.id, 'lineups'); } catch { /* no lineup */ }
      const mine = lu.find((x: any) => x.team?.id === afTeamId);
      if (!mine?.startXI?.length) continue;
      of++;
      for (const x of mine.startXI) if (x.player?.id) { starts.set(x.player.id, (starts.get(x.player.id) || 0) + 1); names.set(x.player.id, x.player.name || ''); }
    }
    const top11 = [...starts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 11);
    const vals = top11.map(([id]) => playerValue(names.get(id) || '', club)).filter((v): v is number => v !== null && v > 0);
    const ref = vals.length >= 5 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    return {
      of,
      rate(rawId: number | null, name: string): { level: number; starts: number | null; of: number } | null {
        const st = rawId ? starts.get(rawId) ?? 0 : null;
        let lu = 0;
        if (of >= 3 && st !== null) {
          const w = st / of;
          lu = w >= 0.8 ? 5 : w >= 0.6 ? 4 : w >= 0.35 ? 3 : w >= 0.1 ? 2 : 1;
        }
        let lv = 0;
        const v = ref ? playerValue(name, club) : null;
        if (ref && v) {
          const q = v / ref;
          lv = q >= 1.5 ? 5 : q >= 1.1 ? 4 : q >= 0.75 ? 3 : q >= 0.4 ? 2 : 1;
        }
        const level = Math.max(lu, lv);
        return level ? { level, starts: of >= 3 ? st : null, of } : null;
      }
    };
  });
}

/** fixtureInjuries + each player's importance (1–5), most important first. */
export async function fixtureInjuriesRated(fid: number, homeAf: number, awayAf: number) {
  const inj = await fixtureInjuries(fid, homeAf, awayAf);
  const rateSide = async (teamId: number, list: any[]) => {
    if (!list.length) return list;
    let imp: Awaited<ReturnType<typeof squadImportance>> | null = null;
    try { imp = await squadImportance(teamId); } catch { /* no history: list without levels */ }
    return list
      .map(p => {
        const r = imp?.rate(p.id ? p.id - AF_OFFSET : null, p.name) || null;
        return { ...p, importance: r?.level ?? null, importanceLabel: r ? IMPORTANCE_LABEL[r.level] : null, starts: r?.starts ?? null, of: r?.of ?? null };
      })
      .sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0) || Number(b.out) - Number(a.out) || a.name.localeCompare(b.name));
  };
  return { home: await rateSide(homeAf, inj.home), away: await rateSide(awayAf, inj.away) };
}

/** A team's next fixtures (any competition). */
async function nextFixtures(afTeamId: number, n = 5): Promise<any[]> {
  return once(`next:${afTeamId}:${n}`, 3 * 3600 * 1000, async () => {
    const j = await afGet('/fixtures', { team: afTeamId, next: n });
    return j.response || [];
  });
}

/**
 * Schedule and rest around a match for one team: days since its previous game, how many games it played in the
 * last 14 / 30 days (all competitions), away trips, and when its next game is (rotation risk before a big midweek game).
 */
export async function teamSchedule(afTeamId: number, kickoffIso: string) {
  const ko = new Date(kickoffIso).getTime();
  const [past, next] = await Promise.all([lastFinished(afTeamId, 10), nextFixtures(afTeamId, 5)]);
  const seen = new Set<number>();
  const all = [...past, ...next].filter((f: any) => f?.fixture?.id && !seen.has(f.fixture.id) && seen.add(f.fixture.id));
  const brief = (f: any) => {
    const home = f.teams.home.id === afTeamId;
    const opp = home ? f.teams.away : f.teams.home;
    const gf = home ? f.goals?.home : f.goals?.away, ga = home ? f.goals?.away : f.goals?.home;
    const t = new Date(f.fixture.date).getTime();
    return {
      date: new Date(t).toISOString(),
      days: Math.round((Math.abs(ko - t) / 86400000) * 10) / 10,
      home,
      opponent: opp?.name || '?',
      opponentCrest: opp?.logo || null,
      opponentId: opp?.id ? AF_OFFSET + opp.id : null, // fix174: names link to the team / competition pages
      competition: f.league?.name || null,
      competitionCode: f.league?.id ? `AF${f.league.id}` : null,
      score: FINISHED_SHORT.has(f.fixture?.status?.short) && gf != null && ga != null ? `${gf}-${ga}` : null
    };
  };
  const HOUR = 3600 * 1000;
  const before = all.filter((f: any) => new Date(f.fixture.date).getTime() < ko - 2 * HOUR)
    .sort((a: any, b: any) => new Date(b.fixture.date).getTime() - new Date(a.fixture.date).getTime());
  const after = all.filter((f: any) => new Date(f.fixture.date).getTime() > ko + 2 * HOUR)
    .sort((a: any, b: any) => new Date(a.fixture.date).getTime() - new Date(b.fixture.date).getTime());
  const within = (days: number) => before.filter((f: any) => ko - new Date(f.fixture.date).getTime() <= days * 86400000);
  // the list only reaches back 10 games: say "unknown" rather than undercount a 30-day window it doesn't cover
  const oldest = before.length ? new Date(before[before.length - 1].fixture.date).getTime() : ko;
  const covers = (days: number) => before.length >= 10 ? ko - oldest >= days * 86400000 : true;
  return {
    previous: before[0] ? brief(before[0]) : null,
    next: after[0] ? brief(after[0]) : null,
    games14: within(14).length,
    games30: covers(30) ? within(30).length : null,
    away30: covers(30) ? within(30).filter((f: any) => f.teams.away.id === afTeamId).length : null,
    recent: before.slice(0, 5).map(brief),
    upcoming: after.slice(0, 3).map(brief)
  };
}

/**
 * Build the match-page tabs (last-10 averages, expected XI, last-10 meetings) for every game in the next `hours`,
 * soonest first, so visitors never wait for them. Finished games' stats/lineups are stored for good, so after the
 * first pass a team costs about one request (its latest results). Stops before eating the reserve kept for live use.
 */
let warming = false;
export async function warmMatchExtras(matches: any[], hours = 48) {
  if (warming || !afConfigured()) return;
  warming = true;
  const t0 = Date.now();
  let done = 0, skipped = 0;
  try {
    const horizon = Date.now() + hours * 3600 * 1000;
    const list = matches
      .filter(m => { const t = new Date(m.utcDate).getTime(); return t > Date.now() - 3 * 3600 * 1000 && t <= horizon; })
      .sort((a, b) => a.utcDate.localeCompare(b.utcDate));
    const seen = new Set<number>();
    // fix167: most of this is cached, so the awaits never gave the thread back (1,071 ms block on 17 Oct): yield
    // every 30 ms, so a turn stays far under 300 ms
    const step = yielder(30);
    for (const m of list) {
      if (afRemaining() < 3500) { skipped = list.length - done; break; }
      await step();
      try {
        const teams = await afTeamsOf(m);
        if (!teams) continue;
        for (const id of [teams.home, teams.away]) {
          if (seen.has(id)) continue;
          seen.add(id);
          await teamAverages(id, 10);
          await step();
          await probableXI(id, 5);
          await step();
        }
        await lastMeetings(teams.home, teams.away);
        done++;
      } catch (e: any) {
        logger.warn(`Match extras warm-up ${m.id}: ${e.message}`);
      }
    }
    logger.info(`Match extras ready for ${done} matches (${seen.size} teams) in ${Math.round((Date.now() - t0) / 1000)}s${skipped ? `, ${skipped} left for later (API budget)` : ''}`);
  } finally {
    warming = false;
  }
}
