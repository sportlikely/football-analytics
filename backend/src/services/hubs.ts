/**
 * Weekly league prediction hubs (fix125, Oct 2026): /predictions/<league> for the big leagues — an intro paragraph and
 * this week's games (today to 6 days ahead, UTC), each with its English preview text and a link to the game page.
 * Never the pick or a percentage. English only for now (other language versions: same text, canonical to English).
 * Used by the app (GET /api/hub/:slug), the crawler HTML and the sitemap (seo.ts).
 */
import { db } from '../db';
import { pubPath } from './slugs';
import { getPreview } from './matchPreview';
import { bbPreview } from './bbPreview';
import { bbPublic } from './bbSite';
import { nflPublic } from './nflSite';
import { nflPreview } from './nflGameExtras';
import { slicer, yieldLoop } from './perf';
import { runsJobs } from './role';
import { onState, publishState } from './shared';

/** slug = the URL (/predictions/<slug>); old = the fix125 URL, answered with a 301 to the slug (fix134) */
export type HubSport = 'football' | 'basketball' | 'american-football';
export interface HubDef { slug: string; old: string; sport: HubSport; code: string; name: string; intro: string }

export const HUBS: HubDef[] = [
  { slug: 'premier-league', old: 'PL', sport: 'football', code: 'PL', name: 'Premier League', intro: 'Premier League predictions for every match this week: win, draw and loss chances for all 20 clubs, our double-chance pick, over 2.5 goals and both teams to score, with a short preview of form, absences and head-to-head. Updated when the line-ups are announced, about an hour before kick-off. Every prediction is saved before kick-off and checked after the final whistle.' },
  { slug: 'la-liga', old: 'PD', sport: 'football', code: 'PD', name: 'La Liga', intro: "La Liga predictions for this week's matches: the chances of a home win, draw or away win, our double-chance pick and goals numbers, with a preview of each game's form, absences and recent meetings. Recalculated with the confirmed line-ups an hour before kick-off, saved before the game and scored after it." },
  { slug: 'serie-a', old: 'SA', sport: 'football', code: 'SA', name: 'Serie A', intro: 'Serie A predictions for every match this week: win, draw and loss percentages, double chance, over 2.5 goals and both teams to score, plus a short preview of form, injuries and head-to-head. Final numbers about an hour before kick-off, when the line-ups are out.' },
  { slug: 'bundesliga', old: 'BL1', sport: 'football', code: 'BL1', name: 'Bundesliga', intro: 'Bundesliga predictions for this week: each match\'s win, draw and loss chances, our double-chance pick and goals numbers, with a preview of form, absences and past meetings. Updated with the starting line-ups before kick-off and checked after every game.' },
  { slug: 'ligue-1', old: 'FL1', sport: 'football', code: 'FL1', name: 'Ligue 1', intro: 'Ligue 1 predictions for every match this week: home win, draw and away win chances, double chance, over 2.5 goals and both teams to score, and a short preview of each game. Final numbers when the line-ups are announced.' },
  { slug: 'champions-league', old: 'CL', sport: 'football', code: 'CL', name: 'Champions League', intro: 'Champions League predictions for this round: win, draw and loss chances for every match, our double-chance pick and goals numbers, with a preview of form and absences. Clubs from different leagues are compared on one scale, and every prediction is saved before kick-off.' },
  { slug: 'nba', old: 'NBA', sport: 'basketball', code: 'NBA', name: 'NBA', intro: 'NBA predictions for the coming games: each team\'s chance to win, the expected margin and total points, with rest, back-to-backs and the latest injury report taken into account. Saved before tip-off and checked after the final buzzer.' },
  // fix137: NFL week hub, listed once NFL_PUBLIC=1 (fix139: predictions)
  { slug: 'nfl', old: 'NFL', sport: 'american-football', code: 'NFL', name: 'NFL', intro: "NFL predictions for this week's games: each team's chance to win, the expected margin and total points, with rest, the starting quarterback and the latest injury report taken into account. Kick-off times, form, head-to-head and injuries for every game. Saved before kick-off and checked after the final whistle." },
  // fix142: college football (FBS games), same rules
  { slug: 'college-football', old: 'NCAA', sport: 'american-football', code: 'NCAA', name: 'College football', intro: "College football predictions for this week's FBS games: each team's chance to win, the expected margin and total points, with home field, neutral sites and rest taken into account. Kick-off times, form and head-to-head for every game. Saved before kick-off and checked after the final whistle." },
  { slug: 'euroleague', old: 'EUROLEAGUE', sport: 'basketball', code: 'EL', name: 'EuroLeague', intro: 'EuroLeague predictions for this round: win chances, expected margin and total points for every game, based on each team\'s attack, defence, pace and the players they actually use. Saved before tip-off and checked after every game.' }
];
export const hubBySlug = (slug: string) => HUBS.find(h => h.slug === slug.toLowerCase()) || null;
/** an old /predictions/PL-style slug (fix125) → its hub, for the 301 */
export const hubByOld = (slug: string) => HUBS.find(h => h.old === slug.toUpperCase()) || null;
/** Is this hub shown? Football always; basketball / NFL once public (admins see them before). */
export const hubOpen = (h: HubDef, admin = false) => h.sport === 'football' || admin || (h.sport === 'basketball' ? bbPublic() : nflPublic());
export const hubForCode = (sport: HubSport, code: string) => HUBS.find(h => h.sport === sport && h.code === code) || null;

export interface HubGame { id: number; kickoff: string; home: string; away: string; score: [number, number] | null; preview: string | null; url: string; homeUrl?: string | null; awayUrl?: string | null }
/** fix174: a football team page link from a hub (API-Football ids open directly; others carry the name and the league) */
const FB_CUPS = new Set(['CL', 'EL', 'ECL', 'EC', 'WC']);
const fbTeamUrl = (id: number | null, name: string, code: string) => !id ? null
  : id >= 1_000_000_000 ? `/team/${id}` : `/team/${id}?${FB_CUPS.has(code) ? '' : `c=${encodeURIComponent(code)}&`}n=${encodeURIComponent(name)}`;
export interface Hub { slug: string; code: string; sport: HubSport; name: string; intro: string; from: string; to: string; games: HubGame[]; next: string | null }

const dayStart = () => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d; };
const firstSentence = (s: string) => s.match(/^.*?[.!?](?=\s|$)/)?.[0] || s;
export const hubDescription = (h: HubDef) => firstSentence(h.intro);
/** "15 Oct–21 Oct" for the hub's title. */
export const hubRange = (from: string, to: string) => {
  const f = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return `${f(from)}–${f(to)}`;
};

const cache = new Map<string, { at: number; hub: Hub }>();
const refreshing = new Set<string>();
onState('hub:', (key, v: { at: number; hub: Hub }) => { cache.set(key.slice(4), v); });
/**
 * This week's games of a hub with their previews. fix169: kept 15 minutes and then served as it is while a fresh copy is
 * built in the background (a yield between games — "GET /predictions/*" blocked 1.7 s); only a hub never built is
 * built inside the request. The hubs are also warmed in the background (warmHubs).
 */
export function buildHub(h: HubDef): Hub {
  const c = cache.get(h.slug);
  if (c) {
    // fix202: the web process serves the worker's copy (warmed every 15 minutes there)
    if (runsJobs && Date.now() - c.at >= 15 * 60 * 1000) void refreshHub(h);
    return c.hub;
  }
  const g = hubSteps(h);
  let x = g.next();
  while (!x.done) x = g.next();
  return x.value;
}
export async function refreshHub(h: HubDef): Promise<void> {
  if (refreshing.has(h.slug)) return;
  refreshing.add(h.slug);
  try {
    const slice = slicer();
    const g = hubSteps(h);
    let x = g.next();
    while (!x.done) { await slice(); x = g.next(); }
  } finally { refreshing.delete(h.slug); }
}
/** Every hub a visitor can open, built again in the background (start-up and every 15 minutes). */
export async function warmHubs(): Promise<void> {
  for (const h of HUBS) if (h.sport === 'football' || (h.sport === 'basketball' ? bbPublic() : nflPublic())) { await refreshHub(h); await yieldLoop(); }
}
function* hubSteps(h: HubDef): Generator<void, Hub> {
  const start = dayStart(), end = new Date(start.getTime() + 7 * 86400000 - 1);
  const from = start.toISOString(), to = end.toISOString();
  let games: HubGame[] = [], next: string | null = null;
  if (h.sport === 'football') {
    const rows = db.prepare(`SELECT p.match_id AS id, MAX(p.utc_date) AS date, MAX(p.home_team) AS home, MAX(p.away_team) AS away, MAX(p.home_team_id) AS hid, MAX(p.away_team_id) AS aid, MAX(r.home_goals) AS hg, MAX(r.away_goals) AS ag
      FROM predictions p LEFT JOIN results r ON r.match_id = p.match_id AND r.outcome IN ('H','D','A')
      WHERE p.competition_code = ? AND p.utc_date >= ? AND p.utc_date <= ? GROUP BY p.match_id ORDER BY date`).all(h.code, from, to) as any[];
    for (const r of rows.filter(x => x.home && x.away)) {
      games.push({ id: r.id, kickoff: r.date, home: r.home, away: r.away, score: r.hg != null ? [r.hg, r.ag] : null, preview: getPreview(r.id)?.text || null, url: `/match/${r.id}`, homeUrl: fbTeamUrl(r.hid, r.home, h.code), awayUrl: fbTeamUrl(r.aid, r.away, h.code) });
      yield;
    }
    if (!games.length) next = (db.prepare(`SELECT MIN(utc_date) AS d FROM predictions WHERE competition_code = ? AND utc_date > ?`).get(h.code, to) as any)?.d || null;
  } else if (h.sport === 'american-football') {
    // fix142: NFL hub = league 1; college hub = league 2, games with at least one FBS team
    const league = h.code === 'NCAA' ? 2 : 1;
    const fbs = league === 2 ? `AND (home_id IN (SELECT team_id FROM nfl_teams WHERE league = 2 AND level = 'FBS') OR away_id IN (SELECT team_id FROM nfl_teams WHERE league = 2 AND level = 'FBS'))` : '';
    const rows = db.prepare(`SELECT game_id AS id, kickoff, home_id AS hid, away_id AS aid, home_name AS home, away_name AS away, home_pts AS hs, away_pts AS as_, status FROM nfl_games
      WHERE league = ? AND kickoff >= ? AND kickoff <= ? AND (stage IS NULL OR stage NOT LIKE 'Pre%') AND (status IS NULL OR status NOT IN ('CANC','PST')) ${fbs} ORDER BY kickoff`).all(league, from, to) as any[];
    // fix174: a preview per game, a yield between games (college weeks have 60+ games)
    for (const r of rows) {
      games.push({ id: r.id, kickoff: r.kickoff, home: r.home || 'TBD', away: r.away || 'TBD', score: (r.status === 'FT' || r.status === 'AOT') && r.hs != null ? [r.hs, r.as_] : null, preview: nflPreview(r.id), url: `/american-football/game/${r.id}`, homeUrl: r.hid ? `/american-football/team/${r.hid}` : null, awayUrl: r.aid ? `/american-football/team/${r.aid}` : null });
      yield;
    }
    if (!games.length) next = (db.prepare(`SELECT MIN(kickoff) AS d FROM nfl_games WHERE league = ? AND kickoff > ? AND (stage IS NULL OR stage NOT LIKE 'Pre%')`).get(league, to) as any)?.d || null;
  } else {
    const rows = db.prepare(`SELECT game_id AS id, kickoff, home_id AS hid, away_id AS aid, home_name AS home, away_name AS away, hs, as_, status FROM bb_games
      WHERE code = ? AND kickoff >= ? AND kickoff <= ? AND (status IS NULL OR status NOT IN ('CANC','POST')) ORDER BY kickoff`).all(h.code, from, to) as any[];
    for (const r of rows) {
      games.push({ id: r.id, kickoff: r.kickoff, home: r.home, away: r.away, score: (r.status === 'FT' || r.status === 'AOT') && r.hs != null ? [r.hs, r.as_] : null, preview: bbPreview(r.id), url: `/basketball/game/${r.id}`, homeUrl: r.hid ? `/basketball/team/${r.hid}` : null, awayUrl: r.aid ? `/basketball/team/${r.aid}` : null });
      yield;
    }
    if (!games.length) next = (db.prepare(`SELECT MIN(kickoff) AS d FROM bb_games WHERE code = ? AND kickoff > ?`).get(h.code, to) as any)?.d || null;
  }
  // fix229: every link at its slug address
  games = games.map(g => ({ ...g, url: pubPath(g.url), homeUrl: g.homeUrl ? pubPath(g.homeUrl) : g.homeUrl, awayUrl: g.awayUrl ? pubPath(g.awayUrl) : g.awayUrl }));
  const hub: Hub = { slug: h.slug, code: h.code, sport: h.sport, name: h.name, intro: h.intro, from, to, games, next };
  cache.set(h.slug, { at: Date.now(), hub });
  publishState(`hub:${h.slug}`, { at: Date.now(), hub });
  return hub;
}
