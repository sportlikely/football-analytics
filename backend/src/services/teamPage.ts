/**
 * Team pages and site search.
 *
 * A team page = a slow part from API-Football (team + venue, competitions, squad, player season stats, scorers),
 * kept 24 h (6 h after a game), and a fast part from our own database (results, next games, form, table) read
 * when the page is asked for (fix166, see "team page" below). Crawlers never make a provider call.
 * Free users get the basics; premium users get every player stat. (AI analysis: placeholder until an AI
 * writer is connected.)
 *
 * Team ids on the site: API-Football-backed matches use 1e9 + AF team id; Football-Data.org teams are
 * resolved to their AF id through the history mapping (af_teams.fd_name), else by name.
 */
import { db } from '../db';
import logger from '../utils/logger';
import { afGet, afRemaining, afConfigured } from './apiFootball';
import { groupForCompetition, fdNameFor, normalizeName } from './history';
import { noteAfFixture, fdTwinOf, afCompetitions, afStandingsCached, afWindowMatches, currentSeason } from './afMatches';
import { isMissingPlayer } from './missingPlayers';
import { isCrawlerRequest, noProviderCalls } from './afUsage';
import { teamAnalysis, teamAnalysisTeaser } from './teamAnalysis';
import { twinDupIds, warmPlayers } from './playerPage';

const AF_OFFSET = 1_000_000_000;
const TTL = 6 * 3600 * 1000; // search index
const cache = new Map<string, { at: number; data: any }>();
const logo = (id: number) => `https://media.api-sports.io/football/teams/${id}.png`;

/*
 * Corrections for facts the provider gets wrong or keeps stale (stadium, capacity, coach…), set by an admin.
 * They win over provider data and are shown as-is.
 */
db.exec(`CREATE TABLE IF NOT EXISTS team_overrides (af_id INTEGER NOT NULL, field TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (af_id, field))`);
// Last good copy of every team page, kept in the database: survives restarts (no API calls after a deploy) and is
// served when the daily API-Football budget runs out, instead of an error page.
db.exec(`CREATE TABLE IF NOT EXISTS team_page_store (af_id INTEGER PRIMARY KEY, json TEXT NOT NULL, built_at TEXT NOT NULL)`);
const OVERRIDE_FIELDS = new Set(['venue', 'city', 'capacity', 'founded', 'name']);
export function setTeamOverride(afId: number, field: string, value: string | null) {
  if (!OVERRIDE_FIELDS.has(field)) throw new Error(`field must be one of ${[...OVERRIDE_FIELDS].join(', ')}`);
  if (value === null || value === '') db.prepare(`DELETE FROM team_overrides WHERE af_id = ? AND field = ?`).run(afId, field);
  else db.prepare(`INSERT OR REPLACE INTO team_overrides (af_id, field, value, updated_at) VALUES (?, ?, ?, ?)`).run(afId, field, value, new Date().toISOString());
  cache.delete(`team:${afId}`);
  db.prepare(`DELETE FROM team_page_store WHERE af_id = ?`).run(afId);
  return teamOverrides(afId);
}
export function teamOverrides(afId?: number) {
  return afId
    ? (db.prepare(`SELECT field, value, updated_at FROM team_overrides WHERE af_id = ?`).all(afId) as any[])
    : (db.prepare(`SELECT af_id, field, value, updated_at FROM team_overrides ORDER BY af_id`).all() as any[]);
}

async function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const c = cache.get(key);
  if (c && Date.now() - c.at < ttl) return c.data;
  const data = await load();
  cache.set(key, { at: Date.now(), data });
  if (cache.size > 2000) cache.delete(cache.keys().next().value as string);
  return data;
}

/* ---------------- team index (search + name resolution) ---------------- */

type IndexTeam = { id: number; name: string; norm: string; national: boolean; n: number };
let index: { at: number; teams: IndexTeam[] } | null = null;

function teamIndex(): IndexTeam[] {
  if (index && Date.now() - index.at < TTL) return index.teams;
  const byId = new Map<number, IndexTeam>();
  const add = (id: number, name: string, national: boolean) => {
    if (!id || !name) return;
    const t = byId.get(id);
    if (t) { t.n++; t.name = name; t.norm = normalizeName(name); return; }
    byId.set(id, { id, name, norm: normalizeName(name), national, n: 1 });
  };
  const since = new Date(Date.now() - 3 * 365 * 86400000).toISOString().slice(0, 10);
  const q = (sql: string, national: boolean) => {
    try { for (const r of db.prepare(sql).all(since) as any[]) add(r.id, r.name, national); } catch { /* table missing */ }
  };
  q(`SELECT home_id AS id, home_name AS name FROM af_fixtures WHERE date >= ? UNION ALL SELECT away_id, away_name FROM af_fixtures WHERE date >= ?1`, false);
  q(`SELECT home_id AS id, home_name AS name FROM eur_matches WHERE date >= ? UNION ALL SELECT away_id, away_name FROM eur_matches WHERE date >= ?1`, false);
  q(`SELECT home_id AS id, home_name AS name FROM nat_matches WHERE date >= ? UNION ALL SELECT away_id, away_name FROM nat_matches WHERE date >= ?1`, true);
  index = { at: Date.now(), teams: [...byId.values()] };
  return index.teams;
}

export function searchTeams(q: string, limit = 8) {
  const needle = normalizeName(q);
  if (needle.length < 2) return [];
  const scored: { t: IndexTeam; s: number }[] = [];
  for (const t of teamIndex()) {
    let s = 0;
    if (t.norm === needle) s = 100;
    else if (t.norm.startsWith(needle)) s = 80;
    else if (t.norm.split(' ').some(w => w.startsWith(needle))) s = 60;
    else if (t.norm.includes(needle)) s = 40;
    if (s) scored.push({ t, s: s + Math.min(10, t.n / 10) });
  }
  return scored
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map(({ t }) => ({ id: AF_OFFSET + t.id, name: t.name, logo: logo(t.id), national: t.national }));
}

/* ---------------- player index (search) ---------------- */

type IndexPlayer = { id: number; name: string; words: string[]; norm: string; teamId: number; position: string | null; minutes: number };
let pIndex: { at: number; players: IndexPlayer[] } | null = null;

/**
 * Every player in the club data we store (af_player_season, this season and last): his current club = the latest
 * season, most minutes. API-Football's short names ("E. Haaland") are joined with the full name when the player's
 * page has been built, so "erling haaland", "haaland" and "e haaland" all find him.
 */
function playerIndex(): IndexPlayer[] {
  if (pIndex && Date.now() - pIndex.at < TTL) return pIndex.players;
  const best = new Map<number, { name: string; team: number; season: number; minutes: number; position: string | null }>();
  try {
    const rows = db.prepare(`
      SELECT player_id, name, team_id, season, SUM(COALESCE(minutes, 0)) AS minutes, MAX(position) AS position
      FROM af_player_season WHERE season >= (SELECT MAX(season) - 1 FROM af_player_season)
      GROUP BY player_id, team_id, season`).all() as any[];
    for (const r of rows) {
      if (!r.name) continue;
      const b = best.get(r.player_id);
      if (!b || r.season > b.season || (r.season === b.season && r.minutes > b.minutes))
        best.set(r.player_id, { name: r.name, team: r.team_id, season: r.season, minutes: r.minutes, position: r.position || null });
    }
  } catch { /* table missing */ }
  const full = new Map<number, { name: string; all: string }>();
  try {
    const rows = db.prepare(`SELECT player_id, json_extract(json, '$.player.name') AS name, json_extract(json, '$.player.firstname') AS f, json_extract(json, '$.player.lastname') AS l FROM player_page_store`).all() as any[];
    for (const r of rows) if (r.name) full.set(r.player_id, { name: String(r.name), all: [r.name, r.f, r.l].filter(Boolean).join(' ') });
  } catch { /* no pages yet */ }
  const players: IndexPlayer[] = [];
  for (const [id, b] of best) {
    const f = full.get(id);
    const norm = normalizeName(`${b.name} ${f?.all || ''}`);
    const display = f ? f.name : b.name;
    players.push({ id, name: display, words: [...new Set(norm.split(' '))], norm: normalizeName(b.name), teamId: b.team, position: b.position, minutes: b.minutes });
  }
  pIndex = { at: Date.now(), players };
  return players;
}

/** How well a typed search matches a player's name words (0 = no match). */
function playerMatch(words: string[], norm: string, needle: string): number {
  const tokens = needle.split(' ');
  let real = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (words.some(w => w.length > 1 && w.startsWith(t))) real++;
    // an initial ("e" in "E. Haaland") stands for a first name only, never for the last word typed
    else if (i === tokens.length - 1 || !words.some(w => w.length === 1 && t.startsWith(w))) return 0;
  }
  if (!real) return 0;
  // tiers far enough apart that playing time (up to +20) only orders players within a tier
  if (norm === needle) return 200;
  if (norm.startsWith(needle)) return 150;
  if (words.includes(tokens[tokens.length - 1])) return 120;
  return 50;
}

export function searchPlayers(q: string, limit = 6) {
  const needle = normalizeName(q);
  if (needle.length < 2) return [];
  const teams = new Map(teamIndex().map(t => [t.id, t]));
  const scored: { p: IndexPlayer; s: number }[] = [];
  const dups = twinDupIds();
  for (const p of playerIndex()) {
    if (dups.has(p.id)) continue;
    const s = playerMatch(p.words, p.norm, needle);
    if (s) scored.push({ p, s: s + Math.min(20, p.minutes / 150) });
  }
  return scored
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map(({ p }) => ({ id: p.id, name: p.name, position: p.position, team: teams.get(p.teamId)?.name || null, teamLogo: logo(p.teamId), country: null as string | null }));
}

/*
 * Players outside the club data we store (Israeli league, Saudi league, other extra competitions) are found with
 * the provider's profile search. Only when the local search finds little, cached for a day per word, and capped
 * per hour so typing can never eat the daily API budget.
 */
const remoteCache = new Map<string, { at: number; hits: any[] }>();
let remoteHour = { at: 0, n: 0 };
const REMOTE_PER_HOUR = parseInt(process.env.PLAYER_SEARCHES_PER_HOUR || '200', 10);

export async function searchPlayersRemote(q: string, limit = 6) {
  const needle = normalizeName(q);
  const last = needle.split(' ').pop() || '';
  if (last.length < 4 || !afConfigured()) return [];
  let c = remoteCache.get(last);
  if (!c || Date.now() - c.at > 86400000) {
    if (Date.now() - remoteHour.at > 3600000) remoteHour = { at: Date.now(), n: 0 };
    if (remoteHour.n >= REMOTE_PER_HOUR || afRemaining() < 1000) return [];
    remoteHour.n++;
    try {
      const j: any = await afGet('/players/profiles', { search: last });
      c = { at: Date.now(), hits: (j.response || []).map((it: any) => it.player).filter(Boolean) };
    } catch (e: any) {
      logger.warn(`player search (profiles) ${last}: ${e.message}`);
      return [];
    }
    remoteCache.set(last, c);
    if (remoteCache.size > 5000) remoteCache.delete(remoteCache.keys().next().value as string);
  }
  const out: { p: any; s: number }[] = [];
  for (const p of c.hits) {
    const short = String(p.name || '');
    const words = [...new Set(normalizeName(`${short} ${p.firstname || ''} ${p.lastname || ''}`).split(' '))];
    const s = playerMatch(words, normalizeName(short), needle);
    if (s) out.push({ p, s });
  }
  return out
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map(({ p }) => {
      const display = /^[A-Z]\.\s/.test(p.name || '') && p.firstname && p.lastname ? `${String(p.firstname).split(' ')[0]} ${p.lastname}` : p.name;
      return { id: p.id, name: display, position: p.position || null, team: null as string | null, teamLogo: '', country: p.nationality || null };
    });
}

/** Site team id (+ competition code / name for Football-Data.org teams) → API-Football team id. */
/**
 * fix164: a Football-Data.org team id → its API-Football team, from any link the site makes (league, cup, favorites,
 * short names, no params). Steps, cheapest first, no API-Football call:
 *  1. the link's league group (team_map → af_teams);
 *  2. the FD id in every league group (a cup link: PSG from the Champions League, the code CL has no group);
 *  3. the club matching the UEFA cups use (clubElo), with every name we stored for that FD id + the link's name;
 *  4. a name search with the usual short names (PSG, Barça, Man City, Spurs, Inter, Atleti …).
 * A hit is kept (team_resolve) so the next open is instant; a miss is logged once per id / code / name.
 */
db.exec(`CREATE TABLE IF NOT EXISTS team_resolve (fd_id INTEGER PRIMARY KEY, af_id INTEGER NOT NULL, via TEXT, at TEXT NOT NULL)`);
const TEAM_ALIASES: Record<string, string> = {
  psg: 'paris saint germain', 'paris sg': 'paris saint germain', barca: 'barcelona', 'man city': 'manchester city', 'man united': 'manchester united',
  'man utd': 'manchester united', spurs: 'tottenham', inter: 'inter', atleti: 'atletico madrid', 'atletico de madrid': 'atletico madrid', wolves: 'wolverhampton',
  bayern: 'bayern munich', 'bayern munchen': 'bayern munich', 'bayern münchen': 'bayern munich', juve: 'juventus', bvb: 'borussia dortmund', 'leverkusen': 'bayer leverkusen',
  'real': 'real madrid', 'sporting cp': 'sporting cp', 'sporting': 'sporting cp', 'benfica': 'benfica', 'porto': 'fc porto', 'ajax': 'ajax', 'psv': 'psv eindhoven'
}
const missLogged = new Set<string>();
const resolveMemo = new Map<number, number>();
/** fix164: forget the resolved ids (the link check runs fresh; also for tests) */
export const clearTeamResolveCache = (stored = false) => { resolveMemo.clear(); if (stored) db.exec(`DELETE FROM team_resolve`); };
export function resolveAfTeamId(rawId: number, code?: string, name?: string): number | null {
  if (rawId >= AF_OFFSET) return rawId - AF_OFFSET;
  if (!Number.isFinite(rawId) || rawId <= 0) return name ? byName([name]) : null;
  const memo = resolveMemo.get(rawId);
  if (memo) return memo;
  const keep = (af: number, via: string) => {
    resolveMemo.set(rawId, af);
    try { db.prepare(`INSERT OR REPLACE INTO team_resolve (fd_id, af_id, via, at) VALUES (?, ?, ?, ?)`).run(rawId, af, via, new Date().toISOString()); } catch { /* read-only copy */ }
    return af;
  };
  const stored: any = db.prepare(`SELECT af_id FROM team_resolve WHERE fd_id = ?`).get(rawId);
  if (stored?.af_id) { resolveMemo.set(rawId, stored.af_id); return stored.af_id; }
  // 1. the link's league
  const g0 = code ? groupForCompetition(code) : null;
  if (g0) {
    const fdName = fdNameFor(g0, rawId);
    if (fdName) {
      const row: any = db.prepare(`SELECT team_id FROM af_teams WHERE grp = ? AND fd_name = ?`).get(g0, fdName);
      if (row?.team_id) return keep(row.team_id, `group ${g0}`);
    }
  }
  // 2. every league group that knows this FD id
  for (const m of db.prepare(`SELECT grp, fd_name FROM team_map WHERE team_id = ?`).all(rawId) as any[]) {
    const row: any = db.prepare(`SELECT team_id FROM af_teams WHERE grp = ? AND fd_name = ?`).get(m.grp, m.fd_name);
    if (row?.team_id) return keep(row.team_id, `group ${m.grp}`);
  }
  // the names this FD id has had in our predictions (full and short), + the link's
  const names = [...new Set([name, ...(db.prepare(`SELECT home_team AS n FROM predictions WHERE home_team_id = ? UNION SELECT away_team FROM predictions WHERE away_team_id = ?`).all(rawId, rawId) as any[]).map(r => r.n)]
    .filter((x): x is string => !!x && String(x).trim().length > 1))];
  // 3. the UEFA-cup club matching
  try {
    const { afIdForFdTeam } = require('./clubElo') as typeof import('./clubElo');
    for (const n of names) { const id = afIdForFdTeam({ name: n }); if (id) return keep(id, `club match "${n}"`); }
  } catch { /* club ratings not loaded */ }
  // 4. name search with aliases
  const hit = byName(names);
  if (hit) return keep(hit, 'name search');
  const key = `${rawId}|${code || ''}|${name || ''}`;
  if (!missLogged.has(key)) { missLogged.add(key); logger.warn(`team-page unresolved id=${rawId} c=${code || '-'} n=${name || '-'}`); }
  return null;
}
/** Exact name (or alias) first, then the best loose hit of the first name. */
function byName(names: string[]): number | null {
  const tries = names.flatMap(n => { const k = normalizeName(n); const al = TEAM_ALIASES[k] || TEAM_ALIASES[String(n).toLowerCase().trim()]; return al ? [al, n] : [n]; });
  for (const n of tries) {
    const hit = searchTeams(n, 3).find(h => normalizeName(h.name) === normalizeName(n));
    if (hit) return hit.id - AF_OFFSET;
  }
  for (const n of tries) { const loose = searchTeams(n, 1)[0]; if (loose) return loose.id - AF_OFFSET; }
  return null;
}

/* ---------------- team page ---------------- */

/*
 * fix166 (18 Oct 2026): a team page is two parts.
 *  - Slow part, from API-Football: team + venue, competitions, squad, player season stats, scorers / assists, and a
 *    snapshot of the table and fixtures (used for clubs outside the leagues we store). Kept 24 h, 6 h when the team
 *    has played in the last 24 h (the provider's season numbers change after a game). Kept in team_page_store: the
 *    page is rebuilt only when this part expires.
 *  - Fast part, from our own database when the page is asked for (no provider call): last results, next games, form,
 *    the league table (our record is in the team analysis). The schedulers keep those tables current, so "results and
 *    table refresh every 15 minutes" stays true.
 * Search-engine crawlers never make a provider call: the stored copy at any age, else a page built from our database
 * only (no squad), which is not stored — a real visitor's view fills the store later.
 * Before: the assembled page lived 15 minutes, so every view after that rebuilt it (3+ calls, 8–10 every 12 h).
 */
const SLOW_TTL = 24 * 3600 * 1000;
const SLOW_TTL_PLAYED = 6 * 3600 * 1000;
const CALL_TTL = 30 * 60 * 1000; // one provider answer, shared by builds running at once or retried after a failure
const FAST_TTL = 60 * 1000; // the fast part, per team (database reads only)
const FINISHED = new Set(['FT', 'AET', 'PEN']);
const NOT_STARTED = new Set(['NS', 'TBD']);
const TOP_LEAGUES: Record<number, string> = { 39: 'Premier League', 40: 'Championship', 140: 'La Liga', 135: 'Serie A', 78: 'Bundesliga', 61: 'Ligue 1', 88: 'Eredivisie', 94: 'Primeira Liga', 71: 'Serie A (Brazil)' };
// window (Football-Data.org style) status → API-Football short status, as the team page shows it
const WINDOW_STATUS: Record<string, string> = { FINISHED: 'FT', SCHEDULED: 'NS', TIMED: 'NS', IN_PLAY: 'LIVE', PAUSED: 'HT', POSTPONED: 'PST', CANCELLED: 'CANC', SUSPENDED: 'SUSP', AWARDED: 'AWD' };

const simpleFixture = (f: any) => ({
  fid: f.fixture.id as number,
  // prefer our Football-Data twin of the fixture (it carries the v3 prediction), else the API-Football page (fix180:
  // always — a fixture without a page yet gets one built on the first visit)
  matchId: fdTwinOf(f.fixture.date, f.teams.home.name, f.teams.away.name) ?? (noteAfFixture(f.fixture.id), AF_OFFSET + f.fixture.id),
  date: f.fixture.date,
  status: f.fixture.status?.short,
  comp: f.league?.name,
  compCode: f.league?.id ? `AF${f.league.id}` : null, // fix174: the competition's page (/league/AF<id>)
  home: { id: AF_OFFSET + f.teams.home.id, name: f.teams.home.name, logo: f.teams.home.logo },
  away: { id: AF_OFFSET + f.teams.away.id, name: f.teams.away.name, logo: f.teams.away.logo },
  hg: f.goals?.home ?? null,
  ag: f.goals?.away ?? null
});
type Fx = { fid?: number; matchId: number | null; date: string; status: string; comp: string | null; compCode?: string | null; home: any; away: any; hg: number | null; ag: number | null; timed?: boolean };

const gameKey = (f: Fx) => `${String(f.date).slice(0, 10)}|${f.home.id}|${f.away.id}`;
const side = (id: number, name: string) => ({ id: AF_OFFSET + id, name, logo: logo(id) });

/**
 * Home ground as it is NOW: the stadium of the team's most recent home game (fixtures are current; the provider's
 * team profile can be years old, e.g. during a rebuild). Capacity is not taken from the provider (often stale):
 * shown only when an admin has set it. Admin corrections win over everything.
 */
function currentVenue(afId: number, t: any, lastFixtures: any[]) {
  const ov = Object.fromEntries(teamOverrides(afId).map((o: any) => [o.field, o.value]));
  const nowIso = new Date().toISOString();
  const lastHome = [...lastFixtures]
    .filter(f => f.teams?.home?.id === afId && f.fixture?.venue?.name && String(f.fixture.date) <= nowIso)
    .sort((a, b) => (a.fixture.date < b.fixture.date ? 1 : -1))[0];
  const name = ov.venue || lastHome?.fixture?.venue?.name || t.venue?.name || null;
  if (!name) return null;
  return {
    name,
    city: ov.city || lastHome?.fixture?.venue?.city || t.venue?.city || null,
    capacity: ov.capacity ? Number(ov.capacity) : null,
    source: ov.venue ? 'checked' : lastHome ? 'last home game' : 'provider profile'
  };
}

/** One API-Football call, cached briefly (builds running at once share it). */
const g = (path: string, params: Record<string, string | number>) =>
  cached<any>(`${path}?${JSON.stringify(params)}`, CALL_TTL, () => afGet(path, params));

const BUILD_CAP = parseInt(process.env.TEAM_BUILDS_PER_HOUR || '600', 10);
let builds = { hour: 0, n: 0 };
function buildAllowed() {
  const h = Math.floor(Date.now() / 3600000);
  if (builds.hour !== h) builds = { hour: h, n: 0 };
  return ++builds.n <= BUILD_CAP;
}

/** The slow part (API-Football): 6–10 calls, once a day per team (every 6 h after a game). */
async function buildSlow(afId: number) {
  if (!afConfigured()) throw new Error('API-Football is not configured');
  if (!buildAllowed()) throw Object.assign(new Error('Busy right now, try again in a few minutes'), { response: { status: 503 } });
  if (afRemaining() < 200) throw new Error('Daily data budget reached, try again later');
  const [teamRes, leaguesRes, squadRes] = await Promise.all([
    g('/teams', { id: afId }),
    g('/leagues', { team: afId, current: 'true' }),
    g('/players/squads', { team: afId })
  ]);
  const t = teamRes.response?.[0];
  if (!t) throw Object.assign(new Error('Team not found'), { response: { status: 404 } });
  const national = !!t.team?.national;
  // the domestic league (or, for national teams, the first competition with a table)
  const leagues: any[] = leaguesRes.response || [];
  const league = leagues.find(l => l.league?.type === 'League') || leagues[0] || null;
  const season: number | null = league?.seasons?.find((s: any) => s.current)?.year ?? league?.seasons?.[0]?.year ?? null;
  const compNames: Record<number, string> = {};
  for (const l of leagues) if (l.league?.id && l.league?.name) compNames[l.league.id] = l.league.name;

  // the table as the provider has it (snapshot: our own games bring it up to date between builds, see fastStanding)
  let standing: any = null;
  const standingP = (async () => {
    if (!(league && season && league.league?.type === 'League')) return;
    try {
      const st = await g('/standings', { league: league.league.id, season });
      const groups: any[][] = st.response?.[0]?.league?.standings || [];
      const table = groups.find(g => g.some((r: any) => r.team?.id === afId)) || null;
      if (table) {
        const me = table.find((r: any) => r.team?.id === afId);
        standing = {
          rank: me.rank, points: me.points, played: me.all?.played, won: me.all?.win, drawn: me.all?.draw, lost: me.all?.lose,
          gf: me.all?.goals?.for, ga: me.all?.goals?.against,
          rows: table.map((r: any) => ({ rank: r.rank, id: AF_OFFSET + r.team.id, name: r.team.name, logo: r.team.logo, played: r.all?.played, gd: r.goalsDiff, points: r.points, me: r.team.id === afId }))
        };
      }
    } catch (e: any) {
      if (e?.code === 'PAGE_BUDGET') throw e;
      logger.warn(`team page standings ${afId}: ${e.message}`);
    }
  })();

  // Which competitions belong to THIS season: the provider files some one-off cups under the next season's
  // number (the Spanish Super Cup of January 2026 shows up as "2026" = 2026-27). Only competitions the team
  // actually played in since the domestic season started are counted.
  const seasonStart: string | null = league?.seasons?.find((x: any) => x.current)?.start ?? null;
  let validComps = null as Set<number> | null;
  let seasonFixtures: any[] = [];
  const seasonP = (async () => {
    if (national || !season || !seasonStart) return;
    try {
      const sf = await g('/fixtures', { team: afId, season });
      seasonFixtures = sf.response || [];
      // only competitions the team has actually played in since the season started (not future ones: the provider
      // files e.g. the Super Cup of Jan 2026 AND the one of Feb 2027 under the same season)
      const nowIso = new Date().toISOString();
      validComps = new Set(seasonFixtures.filter((f: any) => { const d = String(f.fixture?.date || ''); return d.slice(0, 10) >= seasonStart && d <= nowIso; }).map((f: any) => f.league?.id));
      if (!validComps.size) validComps = null;
    } catch (e: any) {
      if (e?.code === 'PAGE_BUDGET') throw e;
      logger.warn(`team page season fixtures ${afId}: ${e.message}`);
    }
  })();
  await Promise.all([standingP, seasonP]);
  for (const f of seasonFixtures) if (f.league?.id && f.league?.name) compNames[f.league.id] = f.league.name;

  // fixtures snapshot: from the season's fixtures when they hold enough, else the provider's last 10 / next 5
  const nowIso = new Date().toISOString();
  const played = seasonFixtures.filter(f => FINISHED.has(f.fixture?.status?.short)).sort((a, b) => (a.fixture.date < b.fixture.date ? 1 : -1));
  const coming = seasonFixtures.filter(f => NOT_STARTED.has(f.fixture?.status?.short) && String(f.fixture.date) >= nowIso).sort((a, b) => (a.fixture.date < b.fixture.date ? -1 : 1));
  const [lastRaw, nextRaw] = await Promise.all([
    played.length >= 10 ? played.slice(0, 10) : g('/fixtures', { team: afId, last: 10 }).then(r => r.response || []),
    coming.length >= 5 ? coming.slice(0, 5) : g('/fixtures', { team: afId, next: 5 }).then(r => r.response || [])
  ]);

  // fix176: national teams — the competition of the next (else the last) official game: its group table and the
  // team's players' numbers in it (scorers); friendlies have neither
  let natComp: { id: number; name: string; logo: string | null; season: number } | null = null;
  if (national) {
    const f0 = [...nextRaw, ...lastRaw].find((f: any) => f.league?.id && !/friendl/i.test(f.league?.name || '')) || nextRaw[0] || lastRaw[0];
    if (f0?.league?.id && f0.league.season) {
      natComp = { id: f0.league.id, name: f0.league.name, logo: f0.league.logo || null, season: f0.league.season };
      compNames[natComp.id] = natComp.name;
      if (!/friendl/i.test(natComp.name)) {
        try {
          const st = await g('/standings', { league: natComp.id, season: natComp.season });
          const groups: any[][] = st.response?.[0]?.league?.standings || [];
          const table = groups.find(x => x.some((r: any) => r.team?.id === afId)) || null;
          const me = table?.find((r: any) => r.team?.id === afId);
          if (table && me) standing = {
            rank: me.rank, points: me.points, played: me.all?.played, won: me.all?.win, drawn: me.all?.draw, lost: me.all?.lose,
            gf: me.all?.goals?.for, ga: me.all?.goals?.against, group: me.group || null,
            rows: table.map((r: any) => ({ rank: r.rank, id: AF_OFFSET + r.team.id, name: r.team.name, logo: r.team.logo, played: r.all?.played, gd: r.goalsDiff, points: r.points, me: r.team.id === afId }))
          };
        } catch (e: any) {
          if (e?.code === 'PAGE_BUDGET') throw e;
          logger.warn(`team page national table ${afId}: ${e.message}`);
        }
      }
    }
  }

  // player season stats (clubs; fix176: national teams in their current competition): up to 3 pages
  const stats = new Map<number, any>();
  if ((!national && season) || natComp) {
    for (let page = 1; page <= 3; page++) {
      try {
        const pr = await g('/players', natComp ? { team: afId, season: natComp.season, league: natComp.id, page } : { team: afId, season: season!, page });
        for (const it of pr.response || []) {
          // official competitions only: pre-season / club friendlies are left out, each competition counted once
          const s = { apps: 0, minutes: 0, goals: 0, assists: 0, yellow: 0, red: 0, leagueGoals: 0, leagueAssists: 0, ratingSum: 0, ratingN: 0, lRatingSum: 0, lRatingN: 0 };
          const byComp: { comp: string; apps: number; goals: number; assists: number }[] = [];
          const seen = new Set<number>();
          for (const st of it.statistics || []) {
            if (st.team?.id !== afId) continue;
            const lg = st.league || {};
            if (/friendl/i.test(lg.name || '') || !lg.id || seen.has(lg.id) || (validComps && !validComps.has(lg.id))) continue;
            seen.add(lg.id);
            const apps = st.games?.appearences || 0;
            const goals = st.goals?.total || 0, assists = st.goals?.assists || 0;
            s.apps += apps;
            s.minutes += st.games?.minutes || 0;
            s.goals += goals;
            s.assists += assists;
            s.yellow += st.cards?.yellow || 0;
            s.red += st.cards?.red || 0;
            const isLeague = league && lg.id === league.league?.id;
            if (isLeague) { s.leagueGoals += goals; s.leagueAssists += assists; }
            if (apps || goals || assists) byComp.push({ comp: lg.name, apps, goals, assists });
            const r = parseFloat(st.games?.rating);
            if (Number.isFinite(r) && apps) {
              s.ratingSum += r * apps; s.ratingN += apps;
              if (isLeague) { s.lRatingSum += r * apps; s.lRatingN += apps; }
            }
          }
          // rating: league games when there are enough of them, else all official games
          const rating = s.lRatingN >= 3 ? s.lRatingSum / s.lRatingN : s.ratingN ? s.ratingSum / s.ratingN : null;
          stats.set(it.player.id, { id: it.player.id, name: it.player.name, ...s, byComp, rating: rating === null ? null : Math.round(rating * 10) / 10 });
        }
        if ((pr.paging?.current || page) >= (pr.paging?.total || 1)) break;
      } catch (e: any) {
        if (e?.code === 'PAGE_BUDGET') throw e;
        logger.warn(`team page players ${afId}: ${e.message}`);
        break;
      }
    }
  }

  const POS: Record<string, number> = { Goalkeeper: 0, Defender: 1, Midfielder: 2, Attacker: 3 };
  const squad = (squadRes.response?.[0]?.players || [])
    .map((p: any) => {
      const s = stats.get(p.id);
      return {
        id: p.id, name: p.name, number: p.number ?? null, pos: p.position, age: p.age ?? null, photo: p.photo || null,
        apps: s?.apps ?? null, minutes: s?.minutes ?? null, goals: s?.goals ?? null, assists: s?.assists ?? null,
        yellow: s?.yellow ?? null, red: s?.red ?? null, rating: s?.rating ?? null
      };
    })
    .sort((a: any, b: any) => (POS[a.pos] ?? 9) - (POS[b.pos] ?? 9) || (a.number ?? 99) - (b.number ?? 99));
  const leaders = (key: 'goals' | 'assists') =>
    [...stats.values()]
      .filter(s => s[key] > 0)
      .sort((a, b) => b[key] - a[key])
      .slice(0, 8)
      .map(s => ({
        id: s.id, // fix174: scorer → player page
        name: s.name,
        value: s[key],
        detail: s.byComp.filter((c: any) => c[key] > 0).map((c: any) => `${c[key]} ${c.comp}`).join(' · ')
      }));

  const last = lastRaw.map(simpleFixture).sort((a: any, b: any) => (a.date < b.date ? 1 : -1));
  const next = nextRaw.map(simpleFixture).sort((a: any, b: any) => (a.date < b.date ? -1 : 1));
  return {
    team: (() => {
      const ov = Object.fromEntries(teamOverrides(afId).map((o: any) => [o.field, o.value]));
      return { id: AF_OFFSET + afId, afId, name: ov.name || t.team.name, logo: t.team.logo, country: t.team.country, founded: ov.founded ? Number(ov.founded) : t.team.founded, national };
    })(),
    venue: currentVenue(afId, t, [...seasonFixtures, ...lastRaw]),
    league: natComp ? { id: natComp.id, name: natComp.name, logo: natComp.logo, country: null, season: natComp.season, type: 'National' }
      : league ? { id: league.league.id, name: league.league.name, logo: league.league.logo, country: league.country?.name, season, type: league.league.type } : null,
    standing, last, next, squad,
    scorers: leaders('goals'),
    assists: leaders('assists'),
    compNames,
    builtAt: new Date().toISOString()
  };
}

/* ---------- fast part: our database ---------- */

/** A competition's name from what we know without a provider call (player pages built from our database). */
export const competitionName = (leagueId: number) => compNamesFor(null).get(leagueId) || null;
/** A club's name from the games we store. */
export const teamNameOf = (afId: number) => teamIndex().find(t => t.id === afId)?.name || null;

function compNamesFor(slow: any): Map<number, string> {
  const m = new Map<number, string>(Object.entries(TOP_LEAGUES).map(([k, v]) => [Number(k), v]));
  try { const { CUPS } = require('./clubElo') as typeof import('./clubElo'); for (const [k, v] of Object.entries(CUPS)) m.set(Number(k), v); } catch { /* not loaded */ }
  try { const { COMPS } = require('./nationalElo') as typeof import('./nationalElo'); for (const [k, v] of Object.entries(COMPS)) m.set(Number(k), v.name); } catch { /* not loaded */ }
  for (const c of afCompetitions()) if (c.name) m.set(c.id - AF_OFFSET, c.name);
  for (const [k, v] of Object.entries(slow?.compNames || {})) m.set(Number(k), String(v));
  if (slow?.league?.id) m.set(slow.league.id, slow.league.name);
  return m;
}

/** Every game of the team we store (league fixtures, European cups, national teams, the fixture window), last ~13 months. */
function storedGames(afId: number, names: Map<number, string>): Fx[] {
  const since = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
  const byFid = new Map<number, Fx & { rank: number }>();
  const put = (f: Fx, rank: number) => {
    const cur = f.fid ? byFid.get(f.fid) : undefined;
    if (!cur || rank > cur.rank) byFid.set(f.fid!, { ...f, rank });
  };
  const fromRow = (r: any, date: string, timed: boolean, status: string): Fx => ({
    fid: r.fixture_id, matchId: AF_OFFSET + r.fixture_id, date, timed, status, comp: names.get(r.league_id) || null, compCode: r.league_id ? `AF${r.league_id}` : null,
    home: side(r.home_id, r.home_name), away: side(r.away_id, r.away_name), hg: r.hg ?? null, ag: r.ag ?? null
  });
  const q = (sql: string, fn: (r: any) => void) => { try { for (const r of db.prepare(sql).all(afId, afId, since) as any[]) fn(r); } catch { /* table missing */ } };
  q(`SELECT fixture_id, league_id, kickoff, home_id, away_id, home_name, away_name, status, hg, ag FROM af_fixtures WHERE (home_id = ? OR away_id = ?) AND kickoff >= ?`,
    r => put(fromRow(r, r.kickoff, true, r.status || 'NS'), 2));
  q(`SELECT fixture_id, league_id, date, home_id, away_id, home_name, away_name, hg, ag FROM eur_matches WHERE (home_id = ? OR away_id = ?) AND date >= ?`,
    r => put(fromRow(r, r.date, false, 'FT'), 1));
  q(`SELECT fixture_id, league_id, date, home_id, away_id, home_name, away_name, hg, ag FROM nat_matches WHERE (home_id = ? OR away_id = ?) AND date >= ?`,
    r => put(fromRow(r, r.date, false, 'FT'), 1));
  const me = AF_OFFSET + afId;
  for (const m of afWindowMatches()) {
    if (m.homeTeam?.id !== me && m.awayTeam?.id !== me) continue;
    put({
      fid: m.id - AF_OFFSET, matchId: m.id, date: m.utcDate, timed: true, status: WINDOW_STATUS[m.status] || m.status, comp: m.competition?.name || null, compCode: m.competition?.code || null,
      home: { id: m.homeTeam.id, name: m.homeTeam.name, logo: m.homeTeam.crest || logo(m.homeTeam.id - AF_OFFSET) },
      away: { id: m.awayTeam.id, name: m.awayTeam.name, logo: m.awayTeam.crest || logo(m.awayTeam.id - AF_OFFSET) },
      hg: m.score?.fullTime?.home ?? null, ag: m.score?.fullTime?.away ?? null
    }, 3);
  }
  return [...byFid.values()].map(({ rank, ...f }) => f);
}

/**
 * Last results and next games: the slow part's snapshot with our stored games over it (fresher scores and status;
 * games the snapshot doesn't have). A snapshot game that has kicked off but isn't in our data drops out of "next".
 */
function fastFixtures(afId: number, slow: any, names: Map<number, string>) {
  const snap: Fx[] = [...(slow?.last || []), ...(slow?.next || [])];
  const merged = new Map<string, Fx>();
  const keyOf = new Map<number, string>();
  for (const f of snap) { const k = gameKey(f); merged.set(k, f); if (f.fid) keyOf.set(f.fid, k); }
  for (const f of storedGames(afId, names)) {
    const k = (f.fid && keyOf.get(f.fid)) || gameKey(f);
    const s = merged.get(k);
    merged.set(k, s
      ? { ...s, fid: f.fid ?? s.fid, status: f.status, hg: f.hg, ag: f.ag, date: f.timed ? f.date : s.date, comp: s.comp || f.comp, compCode: s.compCode || f.compCode, matchId: s.matchId ?? f.matchId }
      : f);
  }
  const all = [...merged.values()];
  const soon = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
  const last = all.filter(f => FINISHED.has(f.status) && f.hg !== null && f.ag !== null).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 10);
  const next = all.filter(f => NOT_STARTED.has(f.status) && String(f.date) >= soon).sort((a, b) => (a.date < b.date ? -1 : 1)).slice(0, 5);
  // a snapshot game that kicked off since the build, with no result in our data: played, score unknown until the rebuild
  const playedUnknown = all.some(f => NOT_STARTED.has(f.status) && String(f.date) < new Date().toISOString() && String(f.date) > String(slow?.builtAt || ''));
  // games only in our database: link to our match page (the Football-Data twin carries the v3 prediction)
  const link = (f: Fx) => {
    const { timed, ...rest } = f;
    if (f.matchId && f.matchId >= AF_OFFSET && timed) return { ...rest, matchId: fdTwinOf(f.date, f.home.name, f.away.name) ?? f.matchId };
    return rest;
  };
  const form = last.slice(0, 6).map(f => {
    const mine = f.home.id === AF_OFFSET + afId ? f.hg! - f.ag! : f.ag! - f.hg!;
    return mine > 0 ? 'W' : mine < 0 ? 'L' : 'D';
  });
  return { last: last.map(link), next: next.map(link), form, playedUnknown };
}

type TableRow = { rank: number; id: number; name: string; logo: string; played: number; gd: number; points: number; me: boolean; won?: number; drawn?: number; lost?: number; gf?: number; ga?: number };
function standingOf(rows: TableRow[], afId: number) {
  const me = rows.find(r => r.id === AF_OFFSET + afId);
  if (!me) return null;
  return {
    rank: me.rank, points: me.points, played: me.played, won: me.won ?? null, drawn: me.drawn ?? null, lost: me.lost ?? null, gf: me.gf ?? null, ga: me.ga ?? null,
    rows: rows.map(({ won, drawn, lost, gf, ga, ...r }) => ({ ...r, me: r.id === AF_OFFSET + afId }))
  };
}

/** A league table from the games we store (pages built from our database only). */
function tableFromGames(leagueId: number, season: number, afId: number) {
  const games = db.prepare(`SELECT home_id, away_id, home_name, away_name, hg, ag FROM af_fixtures WHERE league_id = ? AND season = ? AND status IN ('FT','AET','PEN') AND hg IS NOT NULL AND ag IS NOT NULL`).all(leagueId, season) as any[];
  if (!games.length) return null;
  const t = new Map<number, TableRow>();
  const row = (id: number, name: string) => {
    let r = t.get(id);
    if (!r) { r = { rank: 0, id: AF_OFFSET + id, name, logo: logo(id), played: 0, gd: 0, points: 0, me: id === afId, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0 }; t.set(id, r); }
    return r;
  };
  for (const x of games) {
    for (const [id, name, f, a] of [[x.home_id, x.home_name, x.hg, x.ag], [x.away_id, x.away_name, x.ag, x.hg]] as [number, string, number, number][]) {
      const r = row(id, name);
      r.played++; r.gf! += f; r.ga! += a; r.gd += f - a;
      if (f > a) { r.won!++; r.points += 3; } else if (f === a) { r.drawn!++; r.points += 1; } else r.lost!++;
    }
  }
  const rows = [...t.values()].sort((a, b) => b.points - a.points || b.gd - a.gd || b.gf! - a.gf! || a.name.localeCompare(b.name));
  rows.forEach((r, i) => { r.rank = i + 1; });
  return standingOf(rows, afId);
}

/**
 * The table now, without a provider call:
 *  1. the official table the schedulers keep for the leagues in our fixture window (every 30 minutes);
 *  2. the slow part's snapshot brought up to date with the league games we stored since (each team's newest games
 *     beyond the number it had played in the snapshot). If our games don't add up with the snapshot (split seasons,
 *     a missing game), the snapshot as it is;
 *  3. no snapshot: the table from the games we store.
 */
function fastStanding(afId: number, slow: any) {
  const lg = slow?.league;
  // only league tables (pages stored before fix166 have no type: those with a table were leagues)
  if (!lg?.id || !lg.season || (lg.type ? lg.type !== 'League' : !slow.standing)) return slow?.standing ?? null;
  const off = afStandingsCached(`AF${lg.id}`);
  if (off) {
    const t = (off.standings || []).filter((x: any) => x.type === 'TOTAL').find((x: any) => x.table.some((r: any) => r.team?.id === AF_OFFSET + afId));
    if (t) return standingOf(t.table.map((r: any) => ({
      rank: r.position, id: r.team.id, name: r.team.name, logo: r.team.crest, played: r.playedGames, gd: r.goalDifference, points: r.points, me: false,
      won: r.won, drawn: r.draw, lost: r.lost, gf: r.goalsFor, ga: r.goalsAgainst
    })), afId);
  }
  const snap = slow.standing;
  if (!snap?.rows?.length) {
    if (slow.standing === undefined || slow.partial) { try { return tableFromGames(lg.id, lg.season, afId); } catch { return null; } }
    return snap ?? null;
  }
  let games: any[] = [];
  try {
    games = db.prepare(`SELECT home_id, away_id, hg, ag FROM af_fixtures WHERE league_id = ? AND season = ? AND status IN ('FT','AET','PEN') AND hg IS NOT NULL AND ag IS NOT NULL ORDER BY kickoff DESC`).all(lg.id, lg.season) as any[];
  } catch { return snap; }
  if (!games.length) return snap;
  const meRow = snap.rows.find((r: any) => r.me || r.id === AF_OFFSET + afId);
  const rows: TableRow[] = snap.rows.map((r: any) => ({ ...r, me: false, ...(r === meRow ? { won: snap.won, drawn: snap.drawn, lost: snap.lost, gf: snap.gf, ga: snap.ga } : {}) }));
  let changed = false;
  for (const r of rows) {
    const id = r.id - AF_OFFSET;
    const mine = games.filter(x => x.home_id === id || x.away_id === id);
    const extra = mine.length - (r.played || 0);
    if (extra < 0 || extra > 4) return snap; // our games don't match the provider's table: keep the snapshot
    for (const x of mine.slice(0, extra)) {
      const f = x.home_id === id ? x.hg : x.ag, a = x.home_id === id ? x.ag : x.hg;
      r.played++; r.gd += f - a; r.points += f > a ? 3 : f === a ? 1 : 0;
      if (r.won !== undefined && r.won !== null) { if (f > a) r.won++; else if (f === a) r.drawn!++; else r.lost!++; r.gf! += f; r.ga! += a; }
      changed = true;
    }
  }
  if (!changed) return snap;
  // new order: points; the provider's order (its tie-breaks) between teams level on points, unless one has new games
  const before = new Map(snap.rows.map((r: any) => [r.id, r.points]));
  rows.sort((a, b) => b.points - a.points
    || (before.get(a.id) === a.points && before.get(b.id) === b.points ? a.rank - b.rank : b.gd - a.gd || a.rank - b.rank));
  rows.forEach((r, i) => { r.rank = i + 1; });
  return standingOf(rows, afId);
}

const fastCache = new Map<number, { at: number; slowAt: string; data: any }>();
/** The page: the slow part with the fast part over it. */
function assemble(afId: number, slow: any) {
  const c = fastCache.get(afId);
  if (c && c.slowAt === slow.builtAt && Date.now() - c.at < FAST_TTL) return c.data;
  const names = compNamesFor(slow);
  const { last, next, form, playedUnknown } = fastFixtures(afId, slow, names);
  let standing: any = slow.standing ?? null;
  try { standing = fastStanding(afId, slow); } catch (e: any) { logger.warn(`team page table ${afId}: ${e.message}`); }
  const { compNames, ...rest } = slow;
  const data = { ...rest, standing, form, last, next, resultsAt: new Date().toISOString(), _playedUnknown: playedUnknown };
  fastCache.set(afId, { at: Date.now(), slowAt: slow.builtAt, data });
  if (fastCache.size > 3000) fastCache.delete(fastCache.keys().next().value as number);
  return data;
}

/** The slow part lives 24 h; 6 h when the team has played in the last 24 h. */
function slowTtl(page: any) {
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  // a game stored by day only (European cups, national teams) counts until the end of that day
  const at = (d: string) => Date.parse(String(d).length === 10 ? `${d}T23:59:59Z` : d);
  const played = page._playedUnknown || (page.last || []).some((f: any) => at(f.date) >= dayAgo);
  return played ? SLOW_TTL_PLAYED : SLOW_TTL;
}

/**
 * A page built from our database only (crawlers when nothing is stored yet): name, competition, table, results,
 * next games, scorers from the season data we store. No squad. Not stored: a visitor's view builds the full page.
 */
const offlineCache = new Map<number, { at: number; data: any }>();
function offlinePage(afId: number) {
  const c = offlineCache.get(afId);
  if (c && Date.now() - c.at < 3600 * 1000) return c.data;
  const names = compNamesFor(null);
  const games = storedGames(afId, names);
  const any = games.sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  if (!any) throw Object.assign(new Error('Team not found'), { response: { status: 404 } });
  const meSide = any.home.id === AF_OFFSET + afId ? any.home : any.away;
  const lg: any = db.prepare(`SELECT league_id, season, COUNT(*) AS n FROM af_fixtures WHERE (home_id = ? OR away_id = ?) GROUP BY league_id, season ORDER BY season DESC, n DESC LIMIT 1`).get(afId, afId);
  const national = !lg && games.some(f => /qualification|nations|friendl|cup of nations|euro|copa america|world cup|asian cup|gold cup/i.test(f.comp || ''));
  const ov = Object.fromEntries(teamOverrides(afId).map((o: any) => [o.field, o.value]));
  // scorers / assists: the season data we store (af_player_season), newest season
  const leaders = (key: 'goals' | 'assists') => {
    try {
      const rows = db.prepare(`SELECT player_id, name, league_id, ${key} AS v FROM af_player_season WHERE team_id = ? AND season = (SELECT MAX(season) FROM af_player_season WHERE team_id = ?) AND ${key} > 0`).all(afId, afId) as any[];
      const by = new Map<string, { id: number; name: string; value: number; parts: string[] }>();
      for (const r of rows) {
        const x = by.get(r.name) || { id: r.player_id, name: r.name, value: 0, parts: [] as string[] };
        x.value += r.v; x.parts.push(`${r.v} ${names.get(r.league_id) || 'other'}`);
        by.set(r.name, x);
      }
      return [...by.values()].sort((a, b) => b.value - a.value).slice(0, 8).map(x => ({ id: x.id, name: x.name, value: x.value, detail: x.parts.join(' · ') }));
    } catch { return []; }
  };
  const slow = {
    team: { id: AF_OFFSET + afId, afId, name: ov.name || meSide.name, logo: logo(afId), country: null, founded: ov.founded ? Number(ov.founded) : null, national },
    venue: ov.venue ? { name: ov.venue, city: ov.city || null, capacity: ov.capacity ? Number(ov.capacity) : null, source: 'checked' } : null,
    league: lg ? { id: lg.league_id, name: names.get(lg.league_id) || null, logo: `https://media.api-sports.io/football/leagues/${lg.league_id}.png`, country: null, season: lg.season, type: 'League' } : null,
    standing: undefined, last: [], next: [], squad: [],
    scorers: leaders('goals'), assists: leaders('assists'),
    partial: true,
    builtAt: new Date().toISOString()
  };
  const data = assemble(afId, slow);
  offlineCache.set(afId, { at: Date.now(), data });
  if (offlineCache.size > 2000) offlineCache.delete(offlineCache.keys().next().value as number);
  return data;
}

/** The slow part we have: memory, else the stored copy (survives restarts). */
function slowCopy(afId: number): { at: number; data: any } | null {
  const mem = cache.get(`team:${afId}`);
  if (mem) return mem;
  const stored: any = db.prepare(`SELECT json, built_at FROM team_page_store WHERE af_id = ?`).get(afId);
  if (!stored) return null;
  const c = { at: new Date(stored.built_at).getTime(), data: JSON.parse(stored.json) };
  cache.set(`team:${afId}`, c);
  return c;
}

const inflight = new Map<number, Promise<any>>();
async function pageData(afId: number): Promise<any> {
  const have = slowCopy(afId);
  // crawlers: never a provider call — what we have at any age, else our database only
  if (isCrawlerRequest()) return have ? assemble(afId, have.data) : noProviderCalls(() => offlinePage(afId));
  if (have) {
    const page = assemble(afId, have.data);
    if (Date.now() - have.at < slowTtl(page)) return page;
  }
  try {
    let run = inflight.get(afId);
    if (!run) {
      run = buildSlow(afId).then(data => {
        cache.set(`team:${afId}`, { at: Date.now(), data });
        db.prepare(`INSERT OR REPLACE INTO team_page_store (af_id, json, built_at) VALUES (?, ?, ?)`).run(afId, JSON.stringify(data), data.builtAt);
        return data;
      }).finally(() => inflight.delete(afId));
      inflight.set(afId, run);
    }
    return assemble(afId, await run);
  } catch (e: any) {
    // out of API budget (or the provider is down): the last slow part we have; results and table are ours anyway
    if (have) {
      logger.warn(`team page ${afId}: squad data from ${new Date(have.at).toISOString()} (${e.message})`);
      return assemble(afId, have.data);
    }
    throw e;
  }
}

/**
 * fix177: a national team in one competition (the link's c=AF32 / WC / EC…, else the competition of its next or last
 * official game): the group table holding the team and the team's scorers / assist makers in it. Two provider calls,
 * cached; crawlers never call (the page keeps what it has).
 */
const NATIONAL_CODE: Record<string, number> = { WC: 1, EC: 4 };
async function nationalCompView(afId: number, code: string) {
  const id = NATIONAL_CODE[code.toUpperCase()] ?? (/^AF\d+$/i.test(code) ? parseInt(code.slice(2), 10) : NaN);
  if (!Number.isFinite(id)) return null;
  const season = await currentSeason(id);
  if (!season) return null;
  let standing: any = null, league: any = null;
  try {
    const st = await g('/standings', { league: id, season });
    const lg = st.response?.[0]?.league;
    if (lg) league = { id, name: lg.name, logo: lg.logo || null, country: null, season, type: 'National' };
    const table = ((lg?.standings || []) as any[][]).find(x => x.some((r: any) => r.team?.id === afId)) || null;
    const me = table?.find((r: any) => r.team?.id === afId);
    if (table && me) standing = {
      rank: me.rank, points: me.points, played: me.all?.played, won: me.all?.win, drawn: me.all?.draw, lost: me.all?.lose,
      gf: me.all?.goals?.for, ga: me.all?.goals?.against, group: me.group || null,
      rows: table.map((r: any) => ({ rank: r.rank, id: AF_OFFSET + r.team.id, name: r.team.name, logo: r.team.logo, played: r.all?.played, gd: r.goalsDiff, points: r.points, me: r.team.id === afId }))
    };
  } catch (e: any) { if (e?.code === 'PAGE_BUDGET' || e?.code === 'NO_PROVIDER_CALL') throw e; }
  const tot = new Map<number, { id: number; name: string; goals: number; assists: number }>();
  for (let page = 1; page <= 2; page++) {
    try {
      const pr = await g('/players', { team: afId, league: id, season, page });
      for (const it of pr.response || []) for (const s of it.statistics || []) {
        if (s.team?.id !== afId || s.league?.id !== id) continue;
        const x = tot.get(it.player.id) || { id: it.player.id, name: it.player.name, goals: 0, assists: 0 };
        x.goals += s.goals?.total || 0; x.assists += s.goals?.assists || 0;
        tot.set(it.player.id, x);
      }
      if ((pr.paging?.current || page) >= (pr.paging?.total || 1)) break;
    } catch (e: any) { if (e?.code === 'PAGE_BUDGET' || e?.code === 'NO_PROVIDER_CALL') throw e; break; }
  }
  const lead = (k: 'goals' | 'assists') => [...tot.values()].filter(x => x[k] > 0).sort((a, b) => b[k] - a[k]).slice(0, 8)
    .map(x => ({ id: x.id, name: x.name, value: x[k], detail: league?.name || undefined }));
  if (!league && !tot.size) return null;
  return { league: league || { id, name: null, logo: null, country: null, season, type: 'National' }, standing, scorers: lead('goals'), assists: lead('assists') };
}

/** fix176: a national team's players — each one's club this season (the club with most games) from our stored stats. */
function clubSeasons(afId: number, squad: any[]) {
  const q = db.prepare(`SELECT team_id, season, SUM(apps) AS apps, SUM(goals) AS goals, SUM(assists) AS assists FROM af_player_season
    WHERE player_id = ? AND team_id != ? AND season = (SELECT MAX(season) FROM af_player_season WHERE player_id = ? AND team_id != ?) GROUP BY team_id ORDER BY apps DESC LIMIT 1`);
  return squad.map(p => {
    try {
      const r = q.get(p.id, afId, p.id, afId) as any;
      return r ? { ...p, club: { id: AF_OFFSET + r.team_id, name: teamNameOf(r.team_id) || null, season: r.season, apps: r.apps ?? null, goals: r.goals ?? null, assists: r.assists ?? null } } : p;
    } catch { return p; }
  });
}

export async function teamPage(afId: number, full: boolean, comp?: string) {
  const { _playedUnknown, ...raw }: any = await pageData(afId);
  let data = raw.team?.national && Array.isArray(raw.squad) ? { ...raw, squad: clubSeasons(afId, raw.squad) } : raw;
  if (data.team?.national) {
    // fix177: the competition of the link (c=…), else the one of the next / last official game when the stored page
    // has no table yet; its group table and the team's scorers replace the empty ones
    const official = [...(data.next || []), ...(data.last || [])].find((f: any) => f.compCode && !/friendl/i.test(f.comp || ''))?.compCode || null;
    const target = comp && comp.toUpperCase() !== `AF${data.league?.id}` ? comp : !data.standing ? official : null;
    if (target && !isCrawlerRequest()) {
      try {
        const v = await nationalCompView(afId, target);
        if (v) data = { ...data, league: v.league.name ? v.league : data.league, standing: v.standing ?? data.standing, scorers: v.scorers.length ? v.scorers : data.scorers, assists: v.assists.length ? v.assists : data.assists };
      } catch (e: any) { logger.warn(`national team ${afId} ${target}: ${e.message}`); }
    }
    // a squad player the provider has no page for: no link (fix169's list of missing players)
    data = { ...data, squad: (data.squad || []).map((p: any) => (isMissingPlayer(p.id) ? { ...p, noPage: true } : p)) };
  }
  // player pages of the squad are built in the background — not for crawlers (no provider calls for them)
  if (!isCrawlerRequest()) try { warmPlayers((data.squad || []).map((p: any) => p.id).filter(Boolean)); } catch { /* optional */ }
  let analysis: any = null;
  try { analysis = teamAnalysis(afId, data); } catch (e: any) { logger.warn(`team analysis ${afId}: ${e.message}`); }
  if (full) return { ...data, analysis, premium: true };
  return {
    ...data,
    analysis: analysis ? teamAnalysisTeaser(analysis) : null,
    premium: false,
    squad: data.squad.map((p: any) => ({ id: p.id, name: p.name, number: p.number, pos: p.pos, age: p.age, photo: p.photo, goals: p.goals, club: p.club, noPage: p.noPage })),
    scorers: data.scorers.slice(0, 3),
    assists: [],
    locked: ['Assists, appearances, minutes, cards and ratings for every player', 'Full top-scorer and assist lists', 'AI analysis of the team']
  };
}
