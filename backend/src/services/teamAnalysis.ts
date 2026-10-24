/**
 * Team analysis (team page, paid plans; "our record on this team" is public).
 *
 *  - model:   how v3 rates the club now (strength rank, Elo, attack / defence adjusted for opponents, home / away,
 *             form, draw rate, 1–10 scores) and how that changed over the last 6 months. National teams: Elo + rank.
 *  - form:    last 5 / last 10 games (league games from our API-Football store, with xG where we have it; the team
 *             page's last 10 fixtures otherwise), home / away split, clean sheets, both-teams-scored, over 2.5.
 *  - record:  every settled prediction on this team's games (best model per match), vs the bookmakers' favourite,
 *             plus both-teams-score and over/under 2.5.
 *  - notes:   strengths / weaknesses written from those numbers by fixed rules (no guessing).
 *
 * Everything comes from our own database; no API calls. Cached 15 minutes per team.
 */
import { db } from '../db';
import { teamModelView } from './gridModel';
import { nationalTeamView } from './nationalElo';
import { mainSettledRows, SettledRow } from './tracking';

const AF_OFFSET = 1_000_000_000;
const TTL = 15 * 60 * 1000;
const cache = new Map<number, { at: number; data: any }>();
let settledCache: { at: number; rows: SettledRow[] } | null = null;
const logo = (id: number) => `https://media.api-sports.io/football/teams/${id}.png`;
const r2 = (x: number) => Math.round(x * 100) / 100;
const pct = (a: number, n: number) => (n ? Math.round((a / n) * 100) : null);

interface Game { date: string; home: boolean; opp: string; oppId: number; gf: number; ga: number; xgf: number | null; xga: number | null; comp: string | null }

/** v3 group + history name of this club (first group where the model knows it). */
function v3Link(afId: number): { group: string; name: string } | null {
  let rows: any[] = [];
  try { rows = db.prepare(`SELECT grp, fd_name FROM af_teams WHERE team_id = ? AND fd_name IS NOT NULL`).all(afId) as any[]; } catch { return null; }
  for (const r of rows) if (teamModelView(r.grp, r.fd_name)) return { group: r.grp, name: r.fd_name };
  return null;
}

function storedGames(afId: number): Game[] {
  let rows: any[] = [];
  try {
    rows = db.prepare(`
      SELECT kickoff, home_id, away_id, home_name, away_name, hg, ag, xg_h, xg_a FROM af_fixtures
      WHERE (home_id = ? OR away_id = ?) AND status IN ('FT','AET','PEN') AND hg IS NOT NULL AND ag IS NOT NULL
      ORDER BY kickoff DESC LIMIT 20`).all(afId, afId) as any[];
  } catch { return []; }
  return rows.map(r => {
    const home = r.home_id === afId;
    return {
      date: r.kickoff, home, opp: home ? r.away_name : r.home_name, oppId: home ? r.away_id : r.home_id,
      gf: home ? r.hg : r.ag, ga: home ? r.ag : r.hg,
      xgf: (home ? r.xg_h : r.xg_a) ?? null, xga: (home ? r.xg_a : r.xg_h) ?? null, comp: 'League'
    };
  });
}

/** The team page's last fixtures (all competitions, no xG) when we store too few league games. */
function pageGames(afId: number, last: any[]): Game[] {
  return (last || [])
    .filter(f => f.hg !== null && f.ag !== null && ['FT', 'AET', 'PEN'].includes(f.status))
    .map(f => {
      const home = f.home.id === AF_OFFSET + afId;
      const opp = home ? f.away : f.home;
      return { date: f.date, home, opp: opp.name, oppId: opp.id - AF_OFFSET, gf: home ? f.hg : f.ag, ga: home ? f.ag : f.hg, xgf: null, xga: null, comp: f.comp || null };
    });
}

function summarise(games: Game[]) {
  const n = games.length;
  if (!n) return null;
  let w = 0, d = 0, gf = 0, ga = 0, cs = 0, fts = 0, btts = 0, o25 = 0, xn = 0, xgf = 0, xga = 0, xgGoals = 0, xgConc = 0;
  for (const g of games) {
    if (g.gf > g.ga) w++; else if (g.gf === g.ga) d++;
    gf += g.gf; ga += g.ga;
    if (g.ga === 0) cs++;
    if (g.gf === 0) fts++;
    if (g.gf > 0 && g.ga > 0) btts++;
    if (g.gf + g.ga > 2.5) o25++;
    if (g.xgf !== null && g.xga !== null) { xn++; xgf += g.xgf; xga += g.xga; xgGoals += g.gf; xgConc += g.ga; }
  }
  return {
    n, won: w, drawn: d, lost: n - w - d, points: w * 3 + d, ppg: r2((w * 3 + d) / n),
    gf: r2(gf / n), ga: r2(ga / n),
    cleanSheets: cs, failedToScore: fts, btts, over25: o25,
    xg: xn >= 3 ? { n: xn, for: r2(xgf / xn), against: r2(xga / xn), goalsFor: r2(xgGoals / xn), goalsAgainst: r2(xgConc / xn) } : null
  };
}

/** Is this settled row one of this team's games, and on which side? */
function sideOf(r: SettledRow, afId: number, fdIds: Map<string, Set<number>>): 'home' | 'away' | null {
  const aid = AF_OFFSET + afId;
  if (r.home_team_id === aid) return 'home';
  if (r.away_team_id === aid) return 'away';
  // Football-Data.org matches: their team ids, per competition code
  const ids = r.competition_code ? fdIds.get(r.competition_code) : undefined;
  if (ids) {
    if (r.home_team_id && ids.has(r.home_team_id)) return 'home';
    if (r.away_team_id && ids.has(r.away_team_id)) return 'away';
  }
  return null;
}

function teamRecord(afId: number, link: { group: string; name: string } | null) {
  if (!settledCache || Date.now() - settledCache.at > 10 * 60 * 1000) settledCache = { at: Date.now(), rows: mainSettledRows(400) };
  // Football-Data.org ids of this club: team_map (group, history name) → FD id, for each competition of the group
  const fdIds = new Map<string, Set<number>>();
  if (link) {
    try {
      const ids = (db.prepare(`SELECT team_id FROM team_map WHERE grp = ? AND fd_name = ?`).all(link.group, link.name) as any[]).map(x => x.team_id);
      const comps = (db.prepare(`SELECT DISTINCT competition_code AS c FROM predictions WHERE competition_code IS NOT NULL`).all() as any[]).map(x => x.c);
      for (const c of comps) fdIds.set(c, new Set(ids));
    } catch { /* no map */ }
  }
  const mine = settledCache.rows
    .map(r => ({ r, side: sideOf(r, afId, fdIds) }))
    .filter((x): x is { r: SettledRow; side: 'home' | 'away' } => x.side !== null && x.r.outcome !== ('VOID' as any));
  if (!mine.length) return { n: 0 };
  let hits = 0, mN = 0, mHits = 0, bN = 0, bHits = 0, oN = 0, oHits = 0;
  const games = mine.map(({ r, side }) => {
    const probs: [string, number][] = [['H', r.p_home], ['D', r.p_draw], ['A', r.p_away]];
    const pick = probs.sort((a, b) => b[1] - a[1])[0][0];
    const hit = pick === r.outcome;
    if (hit) hits++;
    if (r.odds_home && r.odds_draw && r.odds_away) {
      mN++;
      const fav = [['H', r.odds_home], ['D', r.odds_draw], ['A', r.odds_away]].sort((a: any, b: any) => a[1] - b[1])[0][0];
      if (fav === r.outcome) mHits++;
    }
    const total = r.home_goals + r.away_goals;
    if (r.btts !== null && r.btts !== undefined) { bN++; if ((Number(r.btts) >= 50) === (r.home_goals > 0 && r.away_goals > 0)) bHits++; }
    if (r.over25 !== null && r.over25 !== undefined) { oN++; if ((Number(r.over25) >= 50) === (total > 2.5)) oHits++; }
    const us = side === 'home' ? 'H' : 'A';
    const pickLabel = pick === 'D' ? 'Draw' : pick === us ? 'Win' : 'Loss';
    return {
      matchId: r.match_id, date: r.utc_date, comp: r.competition_name, home: side === 'home',
      opp: side === 'home' ? r.away_team : r.home_team,
      score: side === 'home' ? `${r.home_goals}–${r.away_goals}` : `${r.away_goals}–${r.home_goals}`,
      pick: pickLabel, hit
    };
  });
  return {
    n: mine.length,
    hits, hitRate: pct(hits, mine.length),
    market: mN ? { n: mN, hitRate: pct(mHits, mN) } : null,
    btts: bN ? { n: bN, hitRate: pct(bHits, bN) } : null,
    over25: oN ? { n: oN, hitRate: pct(oHits, oN) } : null,
    games: games.slice(0, 10)
  };
}

type Note = { kind: 'plus' | 'minus' | 'note'; text: string };

function notesFor(model: any, last10: any, home: any, away: any): Note[] {
  const out: Note[] = [];
  if (model) {
    const s = model.scores || {};
    const of = `#${model.rank} of ${model.teams}`;
    if (s.strength >= 8) out.push({ kind: 'plus', text: `One of the strongest teams in the league by our rating (${of}).` });
    else if (s.strength <= 3) out.push({ kind: 'minus', text: `Among the weaker teams in the league by our rating (${of}).` });
    if (s.attack >= 8) out.push({ kind: 'plus', text: `Dangerous attack: about ${model.attack.toFixed(1)} goals a game against average opposition (league average ${model.leagueGoals.toFixed(1)}).` });
    else if (s.attack <= 3) out.push({ kind: 'minus', text: `Struggles to score: about ${model.attack.toFixed(1)} goals a game against average opposition (league average ${model.leagueGoals.toFixed(1)}).` });
    if (s.defence >= 8) out.push({ kind: 'plus', text: `Solid defence: concedes about ${model.defence.toFixed(1)} a game against average opposition.` });
    else if (s.defence <= 3) out.push({ kind: 'minus', text: `Leaky defence: concedes about ${model.defence.toFixed(1)} a game against average opposition.` });
    if (model.homePpg - model.awayPpg >= 0.8) out.push({ kind: 'note', text: `Much stronger at home (${model.homePpg.toFixed(1)} points a game) than away (${model.awayPpg.toFixed(1)}).` });
    else if (model.awayPpg >= model.homePpg && model.played >= 6) out.push({ kind: 'note', text: `Travels well: as good away (${model.awayPpg.toFixed(1)} points a game) as at home (${model.homePpg.toFixed(1)}).` });
    if (s.form >= 8) out.push({ kind: 'plus', text: `In good form: ${model.formPts} points from the last 6 league games.` });
    else if (s.form <= 3) out.push({ kind: 'minus', text: `Poor form: ${model.formPts} points from the last 6 league games.` });
    if (s.draws >= 8) out.push({ kind: 'note', text: `Draws often: about ${model.drawRate}% of recent games.` });
    if (s.squad >= 8 && s.strength <= 5) out.push({ kind: 'note', text: 'The squad is worth more than the results so far: room to improve.' });
    else if (s.squad <= 3 && s.strength >= 7) out.push({ kind: 'note', text: 'Getting more out of the squad than its market value suggests.' });
    const tr = model.trend || [];
    if (tr.length >= 2) {
      const first = tr[0], now = tr[tr.length - 1];
      const since = new Date(first.date).toLocaleDateString('en-GB', { month: 'long' });
      if (first.rank - now.rank >= 3) out.push({ kind: 'plus', text: `Rising: up from #${first.rank} to #${now.rank} in our ratings since ${since}.` });
      else if (now.rank - first.rank >= 3) out.push({ kind: 'minus', text: `Falling: down from #${first.rank} to #${now.rank} in our ratings since ${since}.` });
    }
  }
  if (last10 && last10.n >= 6) {
    const n = last10.n;
    const x = last10.xg;
    if (x && x.n >= 6) {
      const over = x.goalsFor - x.for, conc = x.goalsAgainst - x.against;
      if (over >= 0.35) out.push({ kind: 'note', text: `Scoring more than its chances suggest (${x.goalsFor.toFixed(1)} goals vs ${x.for.toFixed(1)} xG a game): this may cool down.` });
      else if (over <= -0.35) out.push({ kind: 'note', text: `Creating more than it scores (${x.for.toFixed(1)} xG vs ${x.goalsFor.toFixed(1)} goals a game): goals may come.` });
      if (conc >= 0.35) out.push({ kind: 'note', text: `Conceding more than the chances it allows (${x.goalsAgainst.toFixed(1)} vs ${x.against.toFixed(1)} xG a game): some bad luck at the back.` });
      else if (conc <= -0.35) out.push({ kind: 'note', text: `Conceding fewer than the chances it allows (${x.goalsAgainst.toFixed(1)} vs ${x.against.toFixed(1)} xG a game): may not last.` });
    }
    if (last10.cleanSheets / n >= 0.5) out.push({ kind: 'plus', text: `Clean sheet in ${last10.cleanSheets} of the last ${n}.` });
    if (last10.failedToScore / n >= 0.4) out.push({ kind: 'minus', text: `Failed to score in ${last10.failedToScore} of the last ${n}.` });
    if (last10.btts / n >= 0.7) out.push({ kind: 'note', text: `Both teams scored in ${last10.btts} of the last ${n}.` });
    else if (last10.btts / n <= 0.3) out.push({ kind: 'note', text: `Both teams scored in only ${last10.btts} of the last ${n}.` });
    if (last10.over25 / n >= 0.7) out.push({ kind: 'note', text: `Over 2.5 goals in ${last10.over25} of the last ${n}.` });
    else if (last10.over25 / n <= 0.3) out.push({ kind: 'note', text: `Under 2.5 goals in ${n - last10.over25} of the last ${n}.` });
  }
  if (!model && home && away && home.n >= 3 && away.n >= 3 && home.ppg - away.ppg >= 0.8)
    out.push({ kind: 'note', text: `Much stronger at home (${home.ppg.toFixed(1)} points a game) than away (${away.ppg.toFixed(1)}).` });
  const order = { plus: 0, minus: 1, note: 2 };
  return out.sort((a, b) => order[a.kind] - order[b.kind]).slice(0, 8);
}

/** Full analysis for a team; `page` is the built team page (for the name, national flag and fallback fixtures). */
export function teamAnalysis(afId: number, page: any) {
  const c = cache.get(afId);
  if (c && Date.now() - c.at < TTL) return c.data;
  const national = !!page?.team?.national;
  const link = national ? null : v3Link(afId);
  const model = link ? teamModelView(link.group, link.name) : null;
  const nat = national ? nationalTeamView(afId) : null;

  const stored = national ? [] : storedGames(afId);
  const games = stored.length >= 5 ? stored : pageGames(afId, page?.last || []);
  const source = stored.length >= 5 ? 'league' : 'all';
  const home = summarise(games.filter(g => g.home).slice(0, 10));
  const away = summarise(games.filter(g => !g.home).slice(0, 10));
  const last10 = summarise(games.slice(0, 10));
  const form = {
    source,
    last5: summarise(games.slice(0, 5)),
    last10, home, away,
    games: games.slice(0, 10).map(g => ({ ...g, oppLogo: logo(g.oppId), res: g.gf > g.ga ? 'W' : g.gf < g.ga ? 'L' : 'D' }))
  };
  const data = {
    model: model ? { ...model, trend: model.trend } : null,
    national: nat,
    form,
    record: teamRecord(afId, link),
    notes: notesFor(model, last10, home, away),
    builtAt: new Date().toISOString()
  };
  cache.set(afId, { at: Date.now(), data });
  if (cache.size > 500) cache.delete(cache.keys().next().value as number); // fix210: capped low (the page is also stored in the database; the worker answers every page request)
  return data;
}

/** What a free / signed-out visitor gets: our public record on the team, the rest locked. */
export function teamAnalysisTeaser(full: any) {
  const rec = full.record || { n: 0 };
  return { locked: true, record: rec.n ? { ...rec } : rec, notesCount: (full.notes || []).length };
}
