/**
 * fix231 — game-page extras, every sport where they apply:
 *  1. Weather at the venue for the start (football, American football outdoors, outdoor tennis): Open-Meteo (free, no
 *     key), fetched by the worker every 3 h for games in the next 72 h and stored (extras_games.weather). Venues get
 *     their coordinates once (extras_venues, Open-Meteo geocoding of the venue's city); the ones not found are listed in
 *     data health. Indoors (basketball, domed stadiums, indoor tennis): no weather.
 *  2. Referee (football, API-Football fixtures): games this season in the league, cards and penalties a game, home-win %
 *     in his games next to the league — shrunk toward the league (10 games' weight), rates shown from 10 games. The
 *     league's finished fixtures are listed once every 12 h; his games' events (cards, penalties) fetched 20 a call.
 *     The American-football provider sends no officials (no card there). No change to any model.
 *  3. Fixture difficulty: a team's next 5 games coloured by our model's win chance (utils/gameExtras.difficultyBand).
 *  4. Trends: true facts from our own results, at most 4 a game, rarest first next to the league (no trend under 6 games).
 * The pages ask /api/extras/<sport>/game/<id> and /api/extras/<sport>/team/<id> (answered by the worker, fix210).
 * Admin: /api/admin/game-extras (coverage per sport); data health "Game extras".
 */
import logger from '../utils/logger';
import { db } from '../db';
import { yieldEvery, every, after } from './perf';
import footballDataAPI from './footballDataAPI';
import { afUpcoming, afIdOfFd, AF_OFFSET } from './afMatches';
import { afGet, afRemaining, afConfigured } from './apiFootball';
import { mainRank } from './tracking';
import { groupForCompetition, fdNameFor, GROUPS } from './history';
import { tournamentPlace } from '../utils/tennisPlaces';
import {
  type ExtrasSport, type TeamGame, type Trend, type Band, type Weather,
  weatherNotes, isIndoor, hourAt, refereeStats, refName, difficultyBand, leagueRates, teamTrends, gameTrends, medianLine, trendIsTrue
} from '../utils/gameExtras';
import type { Check } from './dataHealth';

const HOUR = 3600 * 1000, DAY = 24 * HOUR;
const UA = 'SportLikely/1.0 (+https://sportlikely.com)';

db.exec(`
  CREATE TABLE IF NOT EXISTS extras_venues (
    sport TEXT NOT NULL, venue TEXT NOT NULL, city TEXT, country TEXT, lat REAL, lon REAL, source TEXT, tried_at TEXT NOT NULL,
    PRIMARY KEY (sport, venue)
  );
  CREATE TABLE IF NOT EXISTS extras_games (
    sport TEXT NOT NULL, game_id INTEGER NOT NULL, kickoff TEXT NOT NULL, venue TEXT, city TEXT, country TEXT, indoor INTEGER NOT NULL DEFAULT 0,
    referee TEXT, league INTEGER, season INTEGER, weather TEXT, weather_at TEXT, updated_at TEXT NOT NULL,
    PRIMARY KEY (sport, game_id)
  );
  CREATE INDEX IF NOT EXISTS idx_extras_games_kickoff ON extras_games(kickoff);
  CREATE TABLE IF NOT EXISTS extras_ref_fixtures (
    fixture_id INTEGER PRIMARY KEY, league INTEGER NOT NULL, season INTEGER NOT NULL, date TEXT NOT NULL, referee TEXT,
    hg INTEGER NOT NULL, ag INTEGER NOT NULL, cards INTEGER, pens INTEGER, detail_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_extras_ref_league ON extras_ref_fixtures(league, season);
  CREATE TABLE IF NOT EXISTS extras_ref_lists (league INTEGER NOT NULL, season INTEGER NOT NULL, at TEXT NOT NULL, PRIMARY KEY (league, season));
  CREATE TABLE IF NOT EXISTS extras_coverage (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL, at TEXT NOT NULL);
`);

/* ---------- http (Open-Meteo: free, no key, 10,000 calls a day) ---------- */

type Fetcher = (url: string) => Promise<any>;
let fetcher: Fetcher = async (url: string) => {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`${r.status} ${new URL(url).host}`);
  return r.json();
};
/** tests: a fake network */
export const setExtrasFetcher = (f: Fetcher) => { fetcher = f; };
let afFetch: (path: string, params: Record<string, string | number>) => Promise<any> = afGet;
export const setExtrasAf = (f: typeof afFetch) => { afFetch = f; };

/* ---------- 1. the games of the next 72 h, their venue and referee ---------- */

const putGame = db.prepare(`INSERT INTO extras_games (sport, game_id, kickoff, venue, city, country, indoor, referee, league, season, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(sport, game_id) DO UPDATE SET kickoff = excluded.kickoff, venue = COALESCE(excluded.venue, venue), city = COALESCE(excluded.city, city),
    country = COALESCE(excluded.country, country), indoor = excluded.indoor, referee = COALESCE(excluded.referee, referee),
    league = COALESCE(excluded.league, league), season = COALESCE(excluded.season, season), updated_at = excluded.updated_at`);
const gameRow = db.prepare(`SELECT * FROM extras_games WHERE sport = ? AND game_id = ?`);

/** API-Football country names → Open-Meteo's ("England" → "United Kingdom") */
const COUNTRY_ALIAS: Record<string, string> = {
  england: 'united kingdom', scotland: 'united kingdom', wales: 'united kingdom', 'northern ireland': 'united kingdom',
  usa: 'united states', 'czech republic': 'czechia', turkey: 'türkiye', 'south korea': 'south korea', 'korea republic': 'south korea'
};
const normCountry = (c: string | null | undefined) => { const k = String(c || '').replace(/-/g, ' ').trim().toLowerCase(); return COUNTRY_ALIAS[k] || k || null; };
/** American football abroad (London, Munich, Mexico City, Dublin…): the country of the city; else the United States */
const AF_ABROAD: Record<string, string> = { london: 'United Kingdom', tottenham: 'United Kingdom', munich: 'Germany', frankfurt: 'Germany', berlin: 'Germany', 'mexico city': 'Mexico', 'são paulo': 'Brazil', 'sao paulo': 'Brazil', dublin: 'Ireland', madrid: 'Spain', sydney: 'Australia' };

/** football: the window's games of the next 72 h, with venue / city / referee from their API-Football fixture */
async function collectFootball(now: number): Promise<number> {
  const until = now + 72 * HOUR;
  const fd = await footballDataAPI.getUpcomingMatches(4).catch(() => [] as any[]);
  const list = [...fd, ...afUpcoming(4)].filter(m => { const t = Date.parse(m.utcDate); return t > now - 2 * HOUR && t <= until; });
  const at = new Date(now).toISOString();
  const fids = new Map<number, any>();
  for (const m of list) {
    const fid = m.id >= AF_OFFSET ? m.id - AF_OFFSET : afIdOfFd(m.id)?.fid || null;
    const ref = (m.referees || []).find((r: any) => !r.type || r.type === 'REFEREE')?.name || null;
    putGame.run('football', m.id, m.utcDate, m.venue || null, null, m.area?.name || null, 0, refName(ref), null, null, at);
    if (fid) fids.set(fid, m);
  }
  // the fixtures themselves (venue city, referee, league, season): 20 a call, refreshed every 6 h, the last 3 h before
  // the start every tick (referees are named late)
  if (!afConfigured()) return list.length;
  const due = [...fids.entries()].filter(([, m]) => {
    const r: any = gameRow.get('football', m.id);
    const near = Date.parse(m.utcDate) - now < 3 * HOUR;
    return !r?.league || !r.city || (near && !r.referee) || Date.parse(r.updated_at) < now - 6 * HOUR;
  }).map(([fid]) => fid);
  for (let i = 0; i < due.length && afRemaining() > 5000; i += 20) {
    const chunk = due.slice(i, i + 20);
    let resp: any[] = [];
    try { resp = (await afFetch('/fixtures', { ids: chunk.join('-') }))?.response || []; } catch (e: any) { logger.warn(`game extras: fixtures ${e?.message || e}`); break; }
    for (const f of resp) {
      const m = fids.get(f?.fixture?.id);
      if (!m) continue;
      putGame.run('football', m.id, m.utcDate, f.fixture?.venue?.name || null, f.fixture?.venue?.city || null, f.league?.country || null, 0,
        refName(f.fixture?.referee), f.league?.id ?? null, f.league?.season ?? null, at);
    }
  }
  return list.length;
}

function collectNfl(now: number): number {
  const rows = db.prepare(`SELECT game_id, kickoff, venue, league, season FROM nfl_games WHERE kickoff > ? AND kickoff <= ? AND (status IS NULL OR status NOT IN ('FT','AOT','CANC','PST'))`)
    .all(new Date(now - 2 * HOUR).toISOString(), new Date(now + 72 * HOUR).toISOString()) as any[];
  const at = new Date(now).toISOString();
  for (const r of rows) {
    const [name, ...rest] = String(r.venue || '').split(',').map(s => s.trim());
    const city = rest.join(', ') || null;
    const country = AF_ABROAD[String(city || '').toLowerCase()] || 'United States';
    putGame.run('nfl', r.game_id, r.kickoff, name || null, city, country, isIndoor('nfl', name) ? 1 : 0, null, r.league ?? null, r.season ?? null, at);
  }
  return rows.length;
}

function collectTennis(now: number): number {
  const rows = db.prepare(`SELECT m.id, m.scheduled_at, m.tournament, m.indoor, t.indoor AS tindoor, t.city, t.country FROM tennis_matches m LEFT JOIN tennis_tournaments t ON t.id = m.tournament_id
    WHERE m.scheduled_at > ? AND m.scheduled_at <= ? AND (m.status IS NULL OR m.status NOT IN ('completed','finished','cancelled'))`)
    .all(new Date(now - 2 * HOUR).toISOString(), new Date(now + 72 * HOUR).toISOString()) as any[];
  const at = new Date(now).toISOString();
  for (const r of rows) {
    const place = tournamentPlace(r.country, r.city, r.tournament);
    const indoor = r.indoor == null ? (r.tindoor == null ? null : !!r.tindoor) : !!r.indoor;
    const venue = place.city ? `${place.city}${place.country ? `, ${place.country}` : ''}` : null;
    putGame.run('tennis', r.id, r.scheduled_at, venue, place.city, place.country, isIndoor('tennis', venue, indoor) ? 1 : 0, null, null, null, at);
  }
  return rows.length;
}

/* ---------- venue coordinates (once per venue) ---------- */

const venueRow = db.prepare(`SELECT * FROM extras_venues WHERE sport = ? AND venue = ?`);
const putVenue = db.prepare(`INSERT OR REPLACE INTO extras_venues (sport, venue, city, country, lat, lon, source, tried_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
/** where to look a venue up: football / NFL by its city (the stadium's town is close enough for the weather), tennis by the city */
async function geocode(city: string, country: string | null): Promise<{ lat: number; lon: number } | null> {
  const j = await fetcher(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=10&language=en&format=json`);
  const list: any[] = Array.isArray(j?.results) ? j.results : [];
  const want = normCountry(country);
  const ok = want ? list.filter(r => normCountry(r.country) === want) : list;
  const best = ok.sort((a, b) => (b.population || 0) - (a.population || 0))[0];
  return best && Number.isFinite(best.latitude) && Number.isFinite(best.longitude) ? { lat: best.latitude, lon: best.longitude } : null;
}
const venueKey = (r: any) => (r.sport === 'tennis' ? r.venue : r.venue || (r.city ? `@${r.city}` : null));
async function geocodeVenues(now: number, max = 40): Promise<number> {
  const rows = db.prepare(`SELECT DISTINCT sport, venue, city, country FROM extras_games WHERE indoor = 0 AND kickoff > ? AND (city IS NOT NULL OR venue IS NOT NULL)`).all(new Date(now - 2 * HOUR).toISOString()) as any[];
  let n = 0;
  for (const r of rows) {
    const key = venueKey(r);
    if (!key) continue;
    const v: any = venueRow.get(r.sport, key);
    // a venue not found is tried again after 7 days (the provider may name its city by then)
    if (v && (v.lat != null || Date.parse(v.tried_at) > now - 7 * DAY)) continue;
    if (n >= max) break;
    n++;
    let at: { lat: number; lon: number } | null = null, source = 'city';
    try {
      if (r.city) at = await geocode(String(r.city).replace(/\s*\(.*\)\s*$/, ''), r.country);
      if (!at && r.venue && r.sport !== 'tennis') { at = await geocode(r.venue, r.country); source = 'venue name'; }
    } catch (e: any) { logger.warn(`game extras: geocoding ${key}: ${e?.message || e}`); continue; }
    putVenue.run(r.sport, key, r.city || null, r.country || null, at?.lat ?? null, at?.lon ?? null, at ? source : null, new Date(now).toISOString());
    await new Promise(res => setTimeout(res, 300)); // gentle on the free service
  }
  return n;
}

/* ---------- weather (every 3 h, games in the next 72 h) ---------- */

const putWeather = db.prepare(`UPDATE extras_games SET weather = ?, weather_at = ? WHERE sport = ? AND game_id = ?`);
async function fetchWeather(now: number): Promise<{ games: number; calls: number }> {
  const rows = db.prepare(`SELECT sport, game_id, kickoff, venue, city FROM extras_games WHERE indoor = 0 AND kickoff > ? AND kickoff <= ?`)
    .all(new Date(now - HOUR).toISOString(), new Date(now + 72 * HOUR).toISOString()) as any[];
  const byPlace = new Map<string, { lat: number; lon: number; games: any[] }>();
  for (const r of rows) {
    const key = venueKey(r);
    const v: any = key ? venueRow.get(r.sport, key) : null;
    if (v?.lat == null) continue;
    const k = `${v.lat.toFixed(2)},${v.lon.toFixed(2)}`;
    const p = byPlace.get(k) || { lat: v.lat, lon: v.lon, games: [] as any[] };
    p.games.push(r);
    byPlace.set(k, p);
  }
  const places = [...byPlace.values()];
  let games = 0, calls = 0;
  const at = new Date(now).toISOString();
  for (let i = 0; i < places.length; i += 25) {
    const chunk = places.slice(i, i + 25);
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${chunk.map(p => p.lat.toFixed(3)).join(',')}&longitude=${chunk.map(p => p.lon.toFixed(3)).join(',')}`
      + `&hourly=temperature_2m,precipitation_probability,precipitation,wind_speed_10m&timezone=GMT&forecast_days=4&wind_speed_unit=kmh`;
    let j: any;
    try { j = await fetcher(url); calls++; } catch (e: any) { logger.warn(`game extras: weather ${e?.message || e}`); break; }
    const list: any[] = Array.isArray(j) ? j : [j];
    chunk.forEach((p, k) => {
      const h = list[k]?.hourly;
      if (!h?.time) return;
      for (const g of p.games) {
        const i = hourAt(h.time, g.kickoff);
        if (i == null) continue;
        const num = (a: any) => (Array.isArray(a) && Number.isFinite(Number(a[i])) && a[i] !== null ? Math.round(Number(a[i]) * 10) / 10 : null);
        const w: Weather = { tempC: num(h.temperature_2m), rainPct: num(h.precipitation_probability), rainMm: num(h.precipitation), windKmh: num(h.wind_speed_10m) };
        putWeather.run(JSON.stringify(w), at, g.sport, g.game_id);
        games++;
      }
    });
  }
  return { games, calls };
}

/* ---------- referees (football) ---------- */

const putRefFixture = db.prepare(`INSERT INTO extras_ref_fixtures (fixture_id, league, season, date, referee, hg, ag) VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(fixture_id) DO UPDATE SET referee = COALESCE(excluded.referee, referee), hg = excluded.hg, ag = excluded.ag`);
const putRefDetail = db.prepare(`UPDATE extras_ref_fixtures SET cards = ?, pens = ?, detail_at = ? WHERE fixture_id = ?`);
/** cards (yellow + red) and penalties awarded (scored or missed, not the shoot-out) from a fixture's events */
export function cardsAndPens(events: any[] | null | undefined): { cards: number | null; pens: number | null } {
  if (!Array.isArray(events) || !events.length) return { cards: null, pens: null };
  let cards = 0, pens = 0;
  for (const e of events) {
    const type = String(e?.type || ''), detail = String(e?.detail || ''), comments = String(e?.comments || '');
    if (type === 'Card') cards++;
    else if (type === 'Goal' && /^(Penalty|Missed Penalty)$/i.test(detail) && !/shoot/i.test(comments) && (e?.time?.elapsed ?? 0) <= 120) pens++;
  }
  return { cards, pens };
}
async function refreshReferees(now: number): Promise<{ lists: number; details: number }> {
  if (!afConfigured()) return { lists: 0, details: 0 };
  const games = db.prepare(`SELECT referee, league, season FROM extras_games WHERE sport = 'football' AND referee IS NOT NULL AND league IS NOT NULL AND kickoff > ? AND kickoff <= ?`)
    .all(new Date(now - 2 * HOUR).toISOString(), new Date(now + 72 * HOUR).toISOString()) as any[];
  let lists = 0, details = 0;
  const leagues = new Map<string, { league: number; season: number; refs: Set<string> }>();
  for (const g of games) {
    const k = `${g.league}|${g.season}`;
    const x = leagues.get(k) || { league: g.league, season: g.season, refs: new Set<string>() };
    x.refs.add(g.referee);
    leagues.set(k, x);
  }
  const listAt = db.prepare(`SELECT at FROM extras_ref_lists WHERE league = ? AND season = ?`);
  for (const l of leagues.values()) {
    if (afRemaining() < 5000) break;
    const r: any = listAt.get(l.league, l.season);
    if (!r || Date.parse(r.at) < now - 12 * HOUR) {
      try {
        const resp: any[] = (await afFetch('/fixtures', { league: l.league, season: l.season, status: 'FT-AET-PEN' }))?.response || [];
        db.exec('BEGIN');
        try {
          for (const f of resp) if (f?.fixture?.id && f.goals?.home != null && f.goals?.away != null)
            putRefFixture.run(f.fixture.id, l.league, l.season, String(f.fixture.date || '').slice(0, 10), refName(f.fixture.referee), f.goals.home, f.goals.away);
          db.prepare(`INSERT OR REPLACE INTO extras_ref_lists (league, season, at) VALUES (?, ?, ?)`).run(l.league, l.season, new Date(now).toISOString());
          db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); throw e; }
        lists++;
      } catch (e: any) { logger.warn(`game extras: referee list ${l.league}/${l.season}: ${e?.message || e}`); continue; }
    }
    // the named referees' games without events yet (20 a call, at most 10 calls a league a tick)
    const todo: number[] = [];
    for (const ref of l.refs) for (const x of db.prepare(`SELECT fixture_id FROM extras_ref_fixtures WHERE league = ? AND season = ? AND referee = ? AND detail_at IS NULL`).all(l.league, l.season, ref) as any[]) todo.push(x.fixture_id);
    for (let i = 0; i < todo.length && i < 200 && afRemaining() > 5000; i += 20) {
      const chunk = todo.slice(i, i + 20);
      try {
        const resp: any[] = (await afFetch('/fixtures', { ids: chunk.join('-') }))?.response || [];
        const at = new Date(now).toISOString();
        for (const f of resp) { const c = cardsAndPens(f?.events); putRefDetail.run(c.cards, c.pens, at, f.fixture.id); details++; }
        // a fixture the provider didn't return: marked so it isn't asked again every tick
        for (const id of chunk) if (!resp.some(f => f?.fixture?.id === id)) putRefDetail.run(null, null, at, id);
      } catch (e: any) { logger.warn(`game extras: referee games: ${e?.message || e}`); break; }
    }
  }
  return { lists, details };
}

const sameRef = (a: string | null, b: string | null) => !!a && !!b && a.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase() === b.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
/** the referee card of a football game (null: no referee named yet / no league to compare with) */
export function refereeCard(name: string | null, league: number | null, season: number | null) {
  if (!name) return null;
  if (league == null || season == null) return { name, games: 0, show: false };
  const rows = db.prepare(`SELECT referee, hg, ag, cards, pens FROM extras_ref_fixtures WHERE league = ? AND season = ?`).all(league, season) as any[];
  if (!rows.length) return { name, games: 0, show: false };
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const withCards = rows.filter(r => r.cards != null), withPens = rows.filter(r => r.pens != null);
  const lg = {
    homeWin: mean(rows.map(r => (r.hg > r.ag ? 1 : 0))) ?? 0.45,
    cards: withCards.length >= 20 ? mean(withCards.map(r => r.cards)) : null,
    pens: withPens.length >= 20 ? mean(withPens.map(r => r.pens)) : null
  };
  const his = rows.filter(r => sameRef(r.referee, name)).map(r => ({ homeWin: r.hg > r.ag, cards: r.cards, pens: r.pens }));
  return { name, ...refereeStats(his, lg) };
}

/* ---------- games, past results and upcoming games per sport ---------- */

interface GameInfo { sport: ExtrasSport; id: number; kickoff: string; homeId: number | null; awayId: number | null; home: string; away: string; league: string | null; surface: string | null; done: boolean }
/** `sides` = the game's home / away (tennis: first / second player) names and ids, for the page's link (fix229 slugs) */
interface Next { id: number; date: string; opp: string; oppId: number | null; home: boolean | null; band: Band; sides: { home: string; away: string; homeId: number | null; awayId: number | null } }

const fbMain = (rows: any[]) => rows.sort((a, b) => mainRank(a.model, a.utc_date) - mainRank(b.model, b.utc_date)).find(r => mainRank(r.model, r.utc_date) < 99) || null;

function gameInfo(sport: ExtrasSport, id: number): GameInfo | null {
  if (sport === 'football') {
    const rows = db.prepare(`SELECT model, utc_date, competition_code, home_team_id, home_team, away_team_id, away_team FROM predictions WHERE match_id = ?`).all(id) as any[];
    const r = fbMain(rows) || rows[0];
    if (!r) return null;
    const res: any = db.prepare(`SELECT outcome FROM results WHERE match_id = ?`).get(id);
    return { sport, id, kickoff: r.utc_date, homeId: r.home_team_id, awayId: r.away_team_id, home: r.home_team, away: r.away_team, league: r.competition_code, surface: null, done: !!res && ['H', 'D', 'A'].includes(res.outcome) };
  }
  if (sport === 'basketball') {
    const r: any = db.prepare(`SELECT game_id, kickoff, home_id, home_name, away_id, away_name, code, status FROM bb_games WHERE game_id = ?`).get(id);
    return r ? { sport, id, kickoff: r.kickoff, homeId: r.home_id, awayId: r.away_id, home: r.home_name, away: r.away_name, league: r.code, surface: null, done: ['FT', 'AOT'].includes(r.status) } : null;
  }
  if (sport === 'nfl') {
    const r: any = db.prepare(`SELECT game_id, kickoff, home_id, home_name, away_id, away_name, league, status FROM nfl_games WHERE game_id = ?`).get(id);
    return r ? { sport, id, kickoff: r.kickoff, homeId: r.home_id, awayId: r.away_id, home: r.home_name, away: r.away_name, league: String(r.league ?? 1), surface: null, done: ['FT', 'AOT'].includes(r.status) } : null;
  }
  const r: any = db.prepare(`SELECT id, scheduled_at, p1_id, p1_name, p2_id, p2_name, surface, status FROM tennis_matches WHERE id = ?`).get(id);
  return r ? { sport, id, kickoff: r.scheduled_at, homeId: r.p1_id, awayId: r.p2_id, home: r.p1_name, away: r.p2_name, league: null, surface: r.surface ? String(r.surface).toLowerCase() : null, done: r.status === 'completed' || r.status === 'finished' } : null;
}

/** a team's finished games before `before`, newest first (from its side) */
function pastGames(sport: ExtrasSport, teamId: number, before: string, league: string | null): TeamGame[] {
  const side = (date: string, homeId: number, hs: number, as: number, tag: string | null = null): TeamGame =>
    homeId === teamId ? { date, home: true, gf: hs, ga: as, tag } : { date, home: false, gf: as, ga: hs, tag };
  if (sport === 'basketball') return (db.prepare(`SELECT kickoff, home_id, hs, as_ FROM bb_games WHERE (home_id = ? OR away_id = ?) AND kickoff < ? AND status IN ('FT','AOT') AND hs IS NOT NULL ORDER BY kickoff DESC LIMIT 40`)
    .all(teamId, teamId, before) as any[]).map(r => side(r.kickoff, r.home_id, r.hs, r.as_));
  if (sport === 'nfl') return (db.prepare(`SELECT kickoff, home_id, home_pts, away_pts FROM nfl_games WHERE (home_id = ? OR away_id = ?) AND kickoff < ? AND status IN ('FT','AOT') AND home_pts IS NOT NULL ORDER BY kickoff DESC LIMIT 40`)
    .all(teamId, teamId, before) as any[]).map(r => side(r.kickoff, r.home_id, r.home_pts, r.away_pts));
  if (sport === 'tennis') return (db.prepare(`SELECT scheduled_at, p1_id, p2_id, winner, surface FROM tennis_matches WHERE (p1_id = ? OR p2_id = ?) AND scheduled_at < ? AND status = 'completed' AND winner IN (1, 2)
      AND COALESCE(draw, 'singles') = 'singles' AND COALESCE(outcome, '') NOT LIKE '%walkover%' ORDER BY scheduled_at DESC LIMIT 60`).all(teamId, teamId, before) as any[])
    .map(r => { const won = (r.winner === 1) === (r.p1_id === teamId); return { date: r.scheduled_at, home: null, gf: won ? 1 : 0, ga: won ? 0 : 1, tag: r.surface ? String(r.surface).toLowerCase() : null }; });
  // football: our tracked games (every competition) + the league's result history (football-data.co.uk), one per day
  const byDay = new Map<string, TeamGame>();
  for (const r of db.prepare(`SELECT DISTINCT p.match_id, p.utc_date, p.home_team_id, r.home_goals, r.away_goals FROM predictions p JOIN results r ON r.match_id = p.match_id
      WHERE (p.home_team_id = ? OR p.away_team_id = ?) AND p.utc_date < ? AND r.outcome IN ('H','D','A') ORDER BY p.utc_date DESC LIMIT 60`).all(teamId, teamId, before) as any[])
    byDay.set(String(r.utc_date).slice(0, 10), side(r.utc_date, r.home_team_id, r.home_goals, r.away_goals));
  const grp = league ? groupForCompetition(league) : null;
  const name = grp ? fdNameFor(grp, teamId) : null;
  const divs = grp ? GROUPS[grp]?.divisions || [] : [];
  if (name && divs.length) {
    for (const r of db.prepare(`SELECT date, home, hg, ag FROM history_matches WHERE division IN (${divs.map(() => '?').join(',')}) AND (home = ? OR away = ?) AND date < ? ORDER BY date DESC LIMIT 40`)
      .all(...divs, name, name, before.slice(0, 10)) as any[]) {
      const day = String(r.date).slice(0, 10);
      if (!byDay.has(day)) byDay.set(day, r.home === name ? { date: day, home: true, gf: r.hg, ga: r.ag } : { date: day, home: false, gf: r.ag, ga: r.hg });
    }
  }
  return [...byDay.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
}

/** a league's games from both sides (the base rates), and its over / under line */
const leagueCache = new Map<string, { at: number; rows: TeamGame[]; line: number }>();
function leagueGames(sport: ExtrasSport, league: string | null, now: number): { rows: TeamGame[]; line: number } {
  const key = `${sport}|${league}`;
  const hit = leagueCache.get(key);
  if (hit && now - hit.at < 6 * HOUR) return hit;
  const since = new Date(now - 400 * DAY).toISOString();
  const both = (hs: number, as: number, tag: string | null = null): TeamGame[] => [{ date: '', home: true, gf: hs, ga: as, tag }, { date: '', home: false, gf: as, ga: hs, tag }];
  let raw: [number, number][] = [];
  if (sport === 'basketball') raw = (db.prepare(`SELECT hs, as_ FROM bb_games WHERE code = ? AND kickoff > ? AND status IN ('FT','AOT') AND hs IS NOT NULL LIMIT 5000`).all(league, since) as any[]).map(r => [r.hs, r.as_]);
  else if (sport === 'nfl') raw = (db.prepare(`SELECT home_pts, away_pts FROM nfl_games WHERE league = ? AND kickoff > ? AND status IN ('FT','AOT') AND home_pts IS NOT NULL LIMIT 5000`).all(Number(league) || 1, since) as any[]).map(r => [r.home_pts, r.away_pts]);
  else if (sport === 'tennis') raw = Array.from({ length: 200 }, () => [1, 0] as [number, number]); // two sides of every match: one win, one loss (50%)
  else {
    const grp = league ? groupForCompetition(league) : null;
    const divs = grp ? GROUPS[grp]?.divisions || [] : [];
    if (divs.length) raw = (db.prepare(`SELECT hg, ag FROM history_matches WHERE division IN (${divs.map(() => '?').join(',')}) AND date > ? LIMIT 8000`).all(...divs, since.slice(0, 10)) as any[]).map(r => [r.hg, r.ag]);
    if (raw.length < 100 && league) raw = (db.prepare(`SELECT DISTINCT r.match_id, r.home_goals, r.away_goals FROM results r JOIN predictions p ON p.match_id = r.match_id WHERE p.competition_code = ? AND p.utc_date > ? AND r.outcome IN ('H','D','A') LIMIT 5000`).all(league, since) as any[]).map(r => [r.home_goals, r.away_goals]);
    if (raw.length < 100) raw = (db.prepare(`SELECT home_goals, away_goals FROM results WHERE outcome IN ('H','D','A') AND settled_at > ? LIMIT 8000`).all(since) as any[]).map(r => [r.home_goals, r.away_goals]);
  }
  const line = sport === 'football' ? 2.5 : sport === 'tennis' ? 0 : medianLine(raw.map(([h, a]) => h + a));
  const out = { at: now, rows: raw.flatMap(([h, a]) => both(h, a)), line };
  leagueCache.set(key, out);
  if (leagueCache.size > 400) leagueCache.delete(leagueCache.keys().next().value as string);
  return out;
}

/** the game's trends (at most 4), each checked against the games it came from */
export function trendsFor(g: GameInfo, now = Date.now()): Trend[] {
  if (g.homeId == null || g.awayId == null) return [];
  const { rows, line } = leagueGames(g.sport, g.league, now);
  const rates = leagueRates(g.sport, rows, line);
  const hg = pastGames(g.sport, g.homeId, g.kickoff, g.league), ag = pastGames(g.sport, g.awayId, g.kickoff, g.league);
  const ht = teamTrends(g.sport, 'home', g.home, hg, rates, line, g.surface).filter(t => trendIsTrue(t, hg, g.surface));
  const at = teamTrends(g.sport, 'away', g.away, ag, rates, line, g.surface).filter(t => trendIsTrue(t, ag, g.surface));
  return gameTrends(ht, at);
}

/** a team's (player's) next games after `after`, coloured by our win chance */
export function nextGames(sport: ExtrasSport, teamId: number, after: string, n = 5, skip: number | null = null): Next[] {
  const out: Next[] = [];
  if (sport === 'basketball' || sport === 'nfl') {
    const T = sport === 'basketball' ? 'bb_games' : 'nfl_games', P = sport === 'basketball' ? 'bb_predictions' : 'nfl_predictions';
    const rows = db.prepare(`SELECT g.game_id, g.kickoff, g.home_id, g.home_name, g.away_id, g.away_name, p.p_home FROM ${T} g LEFT JOIN ${P} p ON p.game_id = g.game_id
      WHERE (g.home_id = ? OR g.away_id = ?) AND g.kickoff > ? AND (g.status IS NULL OR g.status NOT IN ('FT','AOT','CANC','PST')) ORDER BY g.kickoff LIMIT ?`).all(teamId, teamId, after, n + 1) as any[];
    for (const r of rows) {
      if (r.game_id === skip) continue;
      const home = r.home_id === teamId;
      out.push({ id: r.game_id, date: r.kickoff, opp: home ? r.away_name : r.home_name, oppId: home ? r.away_id : r.home_id, home, band: difficultyBand(r.p_home == null ? null : home ? r.p_home : 1 - r.p_home, false), sides: { home: r.home_name, away: r.away_name, homeId: r.home_id, awayId: r.away_id } });
    }
  } else if (sport === 'tennis') {
    const rows = db.prepare(`SELECT m.id, m.scheduled_at, m.p1_id, m.p1_name, m.p2_id, m.p2_name, p.p1 FROM tennis_matches m LEFT JOIN tennis_predictions p ON p.match_id = m.id
      WHERE (m.p1_id = ? OR m.p2_id = ?) AND m.scheduled_at > ? AND (m.status IS NULL OR m.status NOT IN ('completed','finished','cancelled')) ORDER BY m.scheduled_at LIMIT ?`).all(teamId, teamId, after, n + 1) as any[];
    for (const r of rows) {
      if (r.id === skip) continue;
      const first = r.p1_id === teamId;
      out.push({ id: r.id, date: r.scheduled_at, opp: first ? r.p2_name : r.p1_name, oppId: first ? r.p2_id : r.p1_id, home: null, band: difficultyBand(r.p1 == null ? null : first ? r.p1 : 1 - r.p1, false), sides: { home: r.p1_name, away: r.p2_name, homeId: r.p1_id, awayId: r.p2_id } });
    }
  } else {
    const rows = db.prepare(`SELECT match_id, model, utc_date, home_team_id, home_team, away_team_id, away_team, p_home, p_draw, p_away FROM predictions WHERE (home_team_id = ? OR away_team_id = ?) AND utc_date > ? AND settled = 0 ORDER BY utc_date LIMIT 60`)
      .all(teamId, teamId, after) as any[];
    const by = new Map<number, any[]>();
    for (const r of rows) by.set(r.match_id, [...(by.get(r.match_id) || []), r]);
    for (const [id, list] of by) {
      if (id === skip) continue;
      const main = fbMain(list), r = main || list[0];
      const home = r.home_team_id === teamId;
      // stored as percents (or shares): the team's win chance as a share of the three results
      const sum = r.p_home + r.p_draw + r.p_away;
      const p = main && sum > 0 ? (home ? r.p_home : r.p_away) / sum : null;
      out.push({ id, date: r.utc_date, opp: home ? r.away_team : r.home_team, oppId: home ? r.away_team_id : r.home_team_id, home, band: difficultyBand(p, true), sides: { home: r.home_team, away: r.away_team, homeId: r.home_team_id, awayId: r.away_team_id } });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date)).slice(0, n);
}

/* ---------- what the pages get ---------- */

const PUBLIC_REF_SPORTS = new Set<ExtrasSport>(['football']);
/** the extras of one game (null = no such game). Built by the worker only (fix210: registered as a builder in app.ts). */
export function gameExtras(sport: ExtrasSport, id: number, now = Date.now()) {
  const g = gameInfo(sport, id);
  if (!g) return null;
  const row: any = gameRow.get(sport, id);
  const upcoming = !g.done && Date.parse(g.kickoff) > now - 3 * HOUR;
  let weather: any = null;
  if (sport !== 'basketball' && upcoming && row && !row.indoor && row.weather) {
    const w = JSON.parse(row.weather) as Weather;
    weather = { ...w, notes: weatherNotes(w), at: row.weather_at, venue: row.venue || null, city: row.city || null, start: g.kickoff };
  }
  const referee = PUBLIC_REF_SPORTS.has(sport) && row?.referee ? refereeCard(row.referee, row.league, row.season) : null;
  return {
    sport, id,
    indoor: sport === 'basketball' || !!row?.indoor,
    surface: g.surface,
    weather,
    referee,
    trends: upcoming ? trendsFor(g, now) : [],
    difficulty: upcoming && g.homeId != null && g.awayId != null
      ? { home: { id: g.homeId, name: g.home, next: nextGames(sport, g.homeId, g.kickoff, 5, id) }, away: { id: g.awayId, name: g.away, next: nextGames(sport, g.awayId, g.kickoff, 5, id) } }
      : null
  };
}
/** a team's (tennis: a player's) next 5 games for its page */
export function teamExtras(sport: ExtrasSport, id: number, now = Date.now()) {
  return { sport, id, next: nextGames(sport, id, new Date(now - 2 * HOUR).toISOString(), 5) };
}

/* ---------- the worker job, coverage, data health ---------- */

let running = false;
let lastRun: { at: string; ms: number; games: Record<string, number>; geocoded: number; weather: { games: number; calls: number }; referees: { lists: number; details: number }; error?: string } | null = null;
export async function extrasTick(now = Date.now(), opts: { football?: boolean } = {}) {
  if (running) return lastRun;
  running = true;
  const t0 = Date.now();
  try {
    const games: Record<string, number> = {};
    try { if (opts.football !== false) games.football = await collectFootball(now); } catch (e: any) { logger.warn(`game extras: football ${e?.message || e}`); }
    try { games.nfl = collectNfl(now); } catch (e: any) { logger.warn(`game extras: nfl ${e?.message || e}`); }
    try { games.tennis = collectTennis(now); } catch (e: any) { logger.warn(`game extras: tennis ${e?.message || e}`); }
    const geocoded = await geocodeVenues(now);
    const weather = await fetchWeather(now);
    const referees = await refreshReferees(now);
    db.prepare(`DELETE FROM extras_games WHERE kickoff < ?`).run(new Date(now - 30 * DAY).toISOString());
    lastRun = { at: new Date(now).toISOString(), ms: Date.now() - t0, games, geocoded, weather, referees };
    await buildCoverage(now);
    logger.info(`game extras: ${JSON.stringify(games)} games, ${geocoded} venues looked up, weather for ${weather.games} (${weather.calls} calls), referees ${referees.lists} lists / ${referees.details} games`);
  } catch (e: any) {
    lastRun = { at: new Date(now).toISOString(), ms: Date.now() - t0, games: {}, geocoded: 0, weather: { games: 0, calls: 0 }, referees: { lists: 0, details: 0 }, error: e?.message || String(e) };
    logger.warn(`game extras: ${e?.message || e}`);
  } finally { running = false; }
  return lastRun;
}

interface SportCov { games: number; games48: number; weatherShould: number; weatherHave: number; weather48Should: number; weather48Have: number; refereeNamed: number; refereeStats: number; trends: number; difficulty: number; indoor: number }
/** every upcoming game of the next 72 h through the same builder the page uses: what it would show */
async function buildCoverage(now: number) {
  const step = yieldEvery(50, 100);
  const from = new Date(now).toISOString(), to = new Date(now + 72 * HOUR).toISOString(), to48 = now + 48 * HOUR;
  const ids: Record<ExtrasSport, { id: number; kickoff: string }[]> = {
    football: (db.prepare(`SELECT DISTINCT match_id AS id, utc_date AS kickoff FROM predictions WHERE utc_date > ? AND utc_date <= ? AND settled = 0`).all(from, to) as any[]),
    basketball: (db.prepare(`SELECT game_id AS id, kickoff FROM bb_games WHERE kickoff > ? AND kickoff <= ? AND (status IS NULL OR status = 'NS')`).all(from, to) as any[]),
    nfl: (db.prepare(`SELECT game_id AS id, kickoff FROM nfl_games WHERE kickoff > ? AND kickoff <= ? AND (status IS NULL OR status NOT IN ('FT','AOT','CANC','PST'))`).all(from, to) as any[]),
    tennis: (db.prepare(`SELECT id, scheduled_at AS kickoff FROM tennis_matches WHERE scheduled_at > ? AND scheduled_at <= ? AND (status IS NULL OR status NOT IN ('completed','finished','cancelled'))`).all(from, to) as any[])
  };
  const out: Record<string, SportCov> = {};
  const missingWeather: string[] = [];
  for (const sport of Object.keys(ids) as ExtrasSport[]) {
    const c: SportCov = { games: 0, games48: 0, weatherShould: 0, weatherHave: 0, weather48Should: 0, weather48Have: 0, refereeNamed: 0, refereeStats: 0, trends: 0, difficulty: 0, indoor: 0 };
    for (const r of ids[sport]) {
      await step();
      let x: ReturnType<typeof gameExtras> = null;
      try { x = gameExtras(sport, r.id, now); } catch { x = null; }
      if (!x) continue;
      const in48 = Date.parse(r.kickoff) <= to48;
      c.games++; if (in48) c.games48++;
      if (x.indoor) c.indoor++;
      else {
        c.weatherShould++; if (x.weather) c.weatherHave++;
        if (in48) { c.weather48Should++; if (x.weather) c.weather48Have++; else if (missingWeather.length < 40) { const row: any = gameRow.get(sport, r.id); missingWeather.push(`${sport} ${r.id} (${r.kickoff.slice(0, 16).replace('T', ' ')}): ${row ? `no weather for ${row.venue || row.city || 'an unknown venue'}` : 'not collected yet'}`); } }
      }
      if (x.referee) { c.refereeNamed++; if (x.referee.show) c.refereeStats++; }
      if (x.trends.length) c.trends++;
      if (x.difficulty && (x.difficulty.home.next.length || x.difficulty.away.next.length)) c.difficulty++;
    }
    out[sport] = c;
  }
  const venuesMissing = (db.prepare(`SELECT sport, venue, city, country FROM extras_venues WHERE lat IS NULL ORDER BY sport, venue LIMIT 60`).all() as any[])
    .map(v => `${v.sport}: ${v.venue}${v.city && !String(v.venue).includes(v.city) ? ` (${v.city})` : ''}${v.country ? `, ${v.country}` : ''}`);
  db.prepare(`INSERT OR REPLACE INTO extras_coverage (id, json, at) VALUES (1, ?, ?)`).run(JSON.stringify({ sports: out, missingWeather, venuesMissing }), new Date(now).toISOString());
}

function coverage(): { at: string; sports: Record<string, SportCov>; missingWeather: string[]; venuesMissing: string[] } | null {
  const r: any = db.prepare(`SELECT json, at FROM extras_coverage WHERE id = 1`).get();
  try { return r ? { at: r.at, ...JSON.parse(r.json) } : null; } catch { return null; }
}
/** admin: coverage per sport (weather / referee / trends / difficulty per upcoming game), venues without coordinates */
export function gameExtrasAdmin() {
  const venues = db.prepare(`SELECT sport, COUNT(*) AS n, SUM(lat IS NOT NULL) AS found FROM extras_venues GROUP BY sport`).all() as any[];
  const refs = db.prepare(`SELECT COUNT(*) AS n, SUM(detail_at IS NOT NULL) AS detailed, COUNT(DISTINCT league || '|' || season) AS leagues FROM extras_ref_fixtures`).get() as any;
  return { coverage: coverage(), lastRun, venues, referees: refs };
}

/** data health "Game extras": warn when under 80% of the next 48 h's games have the cards they should have */
export function gameExtrasHealth(now = Date.now()): Check[] {
  const c = coverage();
  if (!c) return [{ id: 'game-extras', label: 'Game extras', level: 'warn', detail: 'Not built yet (the worker builds it every 3 h, first ~6 min after the start)' }];
  const age = now - Date.parse(c.at);
  const parts: string[] = [];
  let should = 0, have = 0;
  for (const [sport, s] of Object.entries(c.sports)) {
    should += s.weather48Should; have += s.weather48Have;
    parts.push(`${sport}: ${s.games48} game(s) in 48 h, weather ${s.weather48Have}/${s.weather48Should}${sport === 'football' ? `, referee ${s.refereeNamed} (stats ${s.refereeStats})` : ''}, trends ${s.trends}/${s.games}, difficulty ${s.difficulty}/${s.games}`);
  }
  const share = should ? have / should : 1;
  const stale = age > 8 * HOUR;
  return [{
    id: 'game-extras', label: 'Game extras',
    level: stale || share < 0.8 ? 'warn' : 'ok',
    detail: `${stale ? `Last built ${Math.round(age / HOUR)} h ago. ` : ''}${should ? `${Math.round(share * 100)}% of the next 48 h's outdoor games have their weather card` : 'No outdoor game in the next 48 h'} · ${parts.join(' · ')}`,
    items: [...c.missingWeather.slice(0, 20), ...c.venuesMissing.slice(0, 20).map(v => `venue without coordinates: ${v}`)]
  }];
}

export function startGameExtrasScheduler() {
  if (process.env.GAME_EXTRAS === '0') return;
  after('game extras', () => extrasTick(), 6 * 60 * 1000).unref();
  every('game extras', () => extrasTick(), 3 * HOUR).unref();
}
