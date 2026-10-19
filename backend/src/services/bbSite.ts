/**
 * The basketball site's data (Oct 2026): game lists, game pages, standings, the record.
 * Built from bb_games / bb_team_stats / bb_player_stats (services/basketball.ts) and the bb-v1 model (services/bbModel.ts).
 * Visible to everyone when BASKETBALL_PUBLIC=1; before that, admins only (everyone else sees the "coming soon" page).
 */
import { db } from '../db';
import logger from '../utils/logger';
import { bbPreview } from './bbPreview';
import { bbTeamAnalysis, bbTeamAnalysisTeaser } from './bbTeamAnalysis';
import { BB_LEAGUES, bbGet } from './basketball';
import { bbExtraFlag } from './bbLeagueConfig';
import { fillOvertime, openCheck, resultFix } from './bbResults';
import { predictGameCached, teamRating, isPreseason, leagueRatings, BB_MODEL, leagueModelInfo, normCdf, normInv, BB_TRIAL, teamTalent, V3 } from './bbModel';
import { nbaInjuries } from './bbInjuries';
import { bbSquad, nbaBoxExtras } from './bbPlayers';
import { personKey } from './bdl';
import { bbLiveFor, periodLen, bbLiveCurve } from './bbLive';
import { bbProbableLineup, bbBeforeAfter } from './bbLineups';

export const bbPublic = () => process.env.BASKETBALL_PUBLIC === '1';

const LIVE = ['Q1', 'Q2', 'Q3', 'Q4', 'OT', 'BT', 'HT'];
const DONE = ['FT', 'AOT'];
const OFF = ['POST', 'CANC', 'SUSP', 'AWD', 'ABD'];

export function bbLeagues() {
  const rows = db.prepare(`SELECT code, league_id, name, country, logo FROM bb_leagues`).all() as any[];
  return BB_LEAGUES.map(l => {
    const r = rows.find(x => x.code === l.code);
    return { code: l.code, name: l.name, country: l.country, logo: r?.logo || null, flag: bbExtraFlag(l.code) };
  });
}
const leagueName = (code: string) => BB_LEAGUES.find(l => l.code === code)?.name || code;

type Row = any;

/** One game in list / page shape. `full` = percentages and numbers; otherwise nothing about the prediction (fix123). */
function shape(g: Row, full: boolean) {
  return present(core(g), full);
}

/** fix159: the part of a game that is the same for every visitor (cached by the lists for 30 s). */
type Core = ReturnType<typeof core>;
function core(g: Row) {
  const status = g.status || 'NS';
  const state = DONE.includes(status) ? 'done' : LIVE.includes(status) ? 'live' : OFF.includes(status) ? 'off' : 'upcoming';
  // finished games: the prediction saved before tip-off; otherwise the latest one
  const saved: any = db.prepare(`SELECT * FROM bb_predictions WHERE game_id = ?`).get(g.game_id);
  let pred: any = null;
  if (saved && (state !== 'upcoming' || saved)) {
    pred = { pHome: saved.p_home, margin: saved.margin, total: saved.total, home: saved.home_pts, away: saved.away_pts, savedAt: saved.made_at };
  }
  if (state === 'upcoming') {
    const p = predictGameCached(g); // fix159: cached, filled by the bb tick
    if (p) pred = { pHome: p.pHome, margin: p.margin, total: p.total, home: p.home, away: p.away, savedAt: saved?.made_at || null, b2bHome: p.b2bHome, b2bAway: p.b2bAway, restHome: p.restHome, restAway: p.restAway, injHome: p.injHome || 0, injAway: p.injAway || 0, newHome: p.newHome || null, newAway: p.newAway || null };
  }
  const pick = pred ? (pred.pHome >= 0.5 ? 'H' : 'A') : null;
  const r1 = (x: number) => Math.round(x * 10) / 10;
  const q = fillOvertime((() => { try { return JSON.parse(g.quarters || 'null'); } catch { return null; } })(), g.hs, g.as_);
  const check = state === 'done' ? openCheck(g.game_id) : null;
  const fixed = state === 'done' ? resultFix(g.game_id) : null;
  // live win chance + projected final score while the game is on (services/bbLive.ts), from the tip-off prediction
  const live = state === 'live' && pred ? bbLiveFor({ ...g, quarters: q }, { pHome: pred.pHome, home: pred.home, away: pred.away }) : null;
  return { g, status, state, pred, pick, q, check, fixed, live };
}

/** fix159: a cached core as one visitor sees it (`full` = the prediction's numbers). */
function present(c: Core, full: boolean) {
  const { g, status, state, pred, pick, q, check, fixed } = c;
  const r1 = (x: number) => Math.round(x * 10) / 10;
  const showAll = full || state === 'done';
  return {
    id: g.game_id,
    league: { code: g.code, name: leagueName(g.code), ...(BB_TRIAL.has(g.code) ? { trial: true } : {}) },
    season: g.season,
    round: g.stage || null,
    preseason: isPreseason({ code: g.code, kickoff: g.kickoff }),
    kickoff: g.kickoff,
    status, state,
    home: { id: g.home_id, name: g.home_name, logo: g.home_logo },
    away: { id: g.away_id, name: g.away_name, logo: g.away_logo },
    score: g.hs !== null && g.as_ !== null ? { home: g.hs, away: g.as_ } : null,
    quarters: q,
    resultCheck: !!check,
    corrected: !!fixed,
    // live clock: minutes left in the period (NBA / CBA quarters 12 min, FIBA 10, overtime 5); the provider gives whole minutes
    clock: state === 'live' && g.timer != null && ['Q1', 'Q2', 'Q3', 'Q4', 'OT'].includes(status)
      ? (() => { const len = status === 'OT' ? 5 : periodLen(g.code); return { played: g.timer, left: Math.max(0, len - g.timer) }; })()
      : null,
    // locked (free / signed-out, game not finished): { model, locked } only — no hint of the prediction (fix182)
    prediction: pred && !showAll ? { model: BB_MODEL, locked: true } : pred ? {
      model: BB_MODEL,
      pick,
      locked: false,
      ...(showAll ? {
        pHome: Math.round(pred.pHome * 1000) / 10, pAway: Math.round((1 - pred.pHome) * 1000) / 10,
        spread: r1(pred.margin), total: r1(pred.total), score: { home: Math.round(pred.home), away: Math.round(pred.away) },
        restHome: pred.restHome ?? null, restAway: pred.restAway ?? null, b2bHome: !!pred.b2bHome, b2bAway: !!pred.b2bAway,
        injHome: pred.injHome || 0, injAway: pred.injAway || 0,
        // fix192: a side with no games in this league, rated from another of our leagues
        newHome: pred.newHome || null, newAway: pred.newAway || null,
        live: c.live
      } : {}),
      hit: state === 'done' && g.hs !== null && !check ? (pick === 'H') === (g.hs > g.as_) : null
    } : null
  };
}

const SELECT = `SELECT * FROM bb_games`;

/** Games from `from` to `to` (ISO), optionally one league; newest first for results, soonest first otherwise. */
/** `full`: true / false for every game, or per game (fix144: a free pick spent on one game opens that game). */
/*
 * fix159: game lists are cached for 30 s per range (the same for every visitor); what depends on the visitor (the
 * prediction's numbers) is applied last. Games that are live, or should have started, are re-read on every request so
 * live scores stay current.
 */
const listCache = new Map<string, { at: number; cores: Core[] }>();
const LIST_TTL = 30 * 1000;
export function bbGames(opts: { from: string; to: string; code?: string; results?: boolean; limit?: number }, full: boolean | ((gameId: number) => boolean)) {
  const key = `${opts.from}|${opts.to}|${opts.code || ''}|${opts.results ? 1 : 0}|${opts.limit || 300}`;
  let c = listCache.get(key);
  if (!c || Date.now() - c.at > LIST_TTL) {
    const rows = db.prepare(`${SELECT} WHERE kickoff BETWEEN ? AND ? ${opts.code ? 'AND code = ?' : ''}
      ORDER BY kickoff ${opts.results ? 'DESC' : 'ASC'} LIMIT ?`).all(...[opts.from, opts.to, ...(opts.code ? [opts.code] : []), opts.limit || 300]) as Row[];
    c = { at: Date.now(), cores: rows.map(core) };
    listCache.set(key, c);
    for (const [k, v] of listCache) if (Date.now() - v.at > LIST_TTL) listCache.delete(k);
    if (listCache.size > 200) listCache.delete(listCache.keys().next().value as string);
  } else {
    // live merge: re-read the games that are on (or due to start) — a handful, by primary key
    const now = new Date().toISOString();
    const idx = c.cores.map((x, i) => (x.state === 'live' || (x.state === 'upcoming' && x.g.kickoff <= now) ? i : -1)).filter(i => i >= 0);
    if (idx.length) {
      const fresh = new Map((db.prepare(`${SELECT} WHERE game_id IN (${idx.map(() => '?').join(',')})`).all(...idx.map(i => c!.cores[i].g.game_id)) as Row[]).map(r => [r.game_id, r]));
      for (const i of idx) { const r = fresh.get(c.cores[i].g.game_id); if (r && r.updated_at !== c.cores[i].g.updated_at) c.cores[i] = core(r); }
    }
  }
  return c.cores.map(x => present(x, typeof full === 'function' ? full(x.g.game_id) : full));
}

/* ---------- game page ---------- */

function lastGames(teamId: number, before: string, n = 10) {
  return db.prepare(`${SELECT} WHERE (home_id = ? OR away_id = ?) AND kickoff < ? AND status IN ('FT','AOT') ORDER BY kickoff DESC LIMIT ?`)
    .all(teamId, teamId, before, n) as Row[];
}

/** Averages over a team's last `n` finished games: points for/against always, shooting etc. where box scores exist. */
function averages(teamId: number, before: string, n = 10) {
  const games = lastGames(teamId, before, n);
  if (!games.length) return null;
  let pf = 0, pa = 0, w = 0;
  const sum: Record<string, number> = {};
  let withStats = 0;
  const one = db.prepare(`SELECT * FROM bb_team_stats WHERE game_id = ? AND team_id = ?`);
  for (const g of games) {
    const home = g.home_id === teamId;
    const f = home ? g.hs : g.as_, a = home ? g.as_ : g.hs;
    pf += f; pa += a;
    if (f > a) w++;
    const s: any = one.get(g.game_id, teamId);
    if (s && s.fga) {
      withStats++;
      for (const k of ['fgm', 'fga', 'tpm', 'tpa', 'ftm', 'fta', 'reb', 'ast', 'stl', 'blk', 'tov']) sum[k] = (sum[k] || 0) + (s[k] || 0);
    }
  }
  const r1 = (x: number) => Math.round(x * 10) / 10;
  const per = (k: string) => (withStats ? r1(sum[k] / withStats) : null);
  return {
    games: games.length, won: w, lost: games.length - w,
    pointsFor: r1(pf / games.length), pointsAgainst: r1(pa / games.length),
    fgPct: withStats && sum.fga ? r1((sum.fgm / sum.fga) * 100) : null,
    threePct: withStats && sum.tpa ? r1((sum.tpm / sum.tpa) * 100) : null,
    threeMade: per('tpm'), threeAttempts: per('tpa'),
    ftPct: withStats && sum.fta ? r1((sum.ftm / sum.fta) * 100) : null,
    rebounds: per('reb'), assists: per('ast'), steals: per('stl'), blocks: per('blk'), turnovers: per('tov'),
    withStats,
    form: games.slice(0, 5).map(g => ((g.home_id === teamId ? g.hs > g.as_ : g.as_ > g.hs) ? 'W' : 'L'))
  };
}

function brief(g: Row, teamId: number) {
  const home = g.home_id === teamId;
  return {
    id: g.game_id, kickoff: g.kickoff, league: g.code, home,
    opponent: home ? g.away_name : g.home_name, opponentLogo: home ? g.away_logo : g.home_logo,
    score: g.hs !== null ? (home ? `${g.hs}-${g.as_}` : `${g.as_}-${g.hs}`) : null,
    result: g.hs !== null && DONE.includes(g.status) ? ((home ? g.hs > g.as_ : g.as_ > g.hs) ? 'W' : 'L') : null
  };
}

/** Rest and schedule around a game, from every game we hold for the team. */
function schedule(teamId: number, kickoff: string) {
  const ko = new Date(kickoff).getTime();
  const all = db.prepare(`${SELECT} WHERE (home_id = ? OR away_id = ?) AND kickoff BETWEEN ? AND ? ORDER BY kickoff`)
    .all(teamId, teamId, new Date(ko - 30 * 86400000).toISOString(), new Date(ko + 14 * 86400000).toISOString()) as Row[];
  const before = all.filter(g => new Date(g.kickoff).getTime() < ko - 3 * 3600 * 1000).reverse();
  const after = all.filter(g => new Date(g.kickoff).getTime() > ko + 3 * 3600 * 1000);
  const days = (g: Row) => Math.round((Math.abs(ko - new Date(g.kickoff).getTime()) / 86400000) * 10) / 10;
  const in7 = before.filter(g => ko - new Date(g.kickoff).getTime() <= 7 * 86400000);
  return {
    restDays: before[0] ? days(before[0]) : null,
    backToBack: before[0] ? days(before[0]) < 1.4 : false,
    games7: in7.length,
    away7: in7.filter(g => g.away_id === teamId).length,
    nextIn: after[0] ? days(after[0]) : null,
    recent: before.slice(0, 5).map(g => brief(g, teamId)),
    upcoming: after.slice(0, 3).map(g => brief(g, teamId))
  };
}

/** Why we think so: the reasons behind the pick, in points of expected margin (kind is translated on the site). */
function reasons(g: Row, pr: any, full: boolean) {
  if (!pr || !full) return [];
  const out: { kind: 'strength' | 'home' | 'b2b' | 'b2bBoth' | 'injuries' | 'attack' | 'talent'; side: 'H' | 'A'; points: number }[] = [];
  // injuries: the side that loses fewer points to injured regulars gains the difference
  const inj = (pr.injHome || 0) - (pr.injAway || 0);
  if (Math.abs(inj) >= 0.5) out.push({ kind: 'injuries', side: inj > 0 ? 'A' : 'H', points: Math.round(Math.abs(inj) * 10) / 10 });
  const rh = teamRating(g.code, g.home_id), ra = teamRating(g.code, g.away_id);
  const strength = rh && ra ? rh.net - ra.net : 0;
  if (rh && ra) out.push({ kind: 'strength', side: strength >= 0 ? 'H' : 'A', points: Math.round(Math.abs(strength) * 10) / 10 });
  // where the strength gap comes from: each attack against the other side's defence (points vs an average matchup)
  const extra: { kind: 'attack'; side: 'H' | 'A'; points: number }[] = [];
  if (rh && ra) {
    const hx = Math.round((rh.attack - ra.defence) * 10) / 10, ax = Math.round((ra.attack - rh.defence) * 10) / 10;
    if (Math.abs(hx) >= 0.5) extra.push({ kind: 'attack', side: 'H', points: hx });
    if (Math.abs(ax) >= 0.5) extra.push({ kind: 'attack', side: 'A', points: ax });
  }
  // bb-v3 player talent: the value of the players each team used most recently (points of margin)
  const th = teamTalent(g.home_id, g.code === 'NBA' ? 5 : 1), ta = teamTalent(g.away_id, g.code === 'NBA' ? 5 : 1);
  const sig = leagueModelInfo(g.code)?.sigma || 12;
  if (th != null && ta != null) {
    const tp = Math.round(((V3.talent * (th - ta)) / 13) * (sig / V3.stretch) * 10) / 10;
    if (Math.abs(tp) >= 0.5) out.push({ kind: 'talent', side: tp > 0 ? 'H' : 'A', points: Math.abs(tp) });
  }
  // back-to-back: only the side that is fresher gains; when both played last night it cancels out
  const b2bPts = Math.round((leagueModelInfo(g.code)?.b2b || 0) * 10) / 10;
  if (pr.b2bHome && pr.b2bAway) out.push({ kind: 'b2bBoth', side: 'H', points: 0 });
  else if (pr.b2bHome) out.push({ kind: 'b2b', side: 'A', points: b2bPts });
  else if (pr.b2bAway) out.push({ kind: 'b2b', side: 'H', points: b2bPts });
  const home = typeof pr.hca === 'number' ? pr.hca : !pr.b2bHome && !pr.b2bAway ? pr.margin - strength : 0;
  if (Math.abs(home) >= 0.5) out.push({ kind: 'home', side: home >= 0 ? 'H' : 'A', points: Math.round(Math.abs(home) * 10) / 10 });
  const sorted = out.sort((a, b) => b.points - a.points);
  const at = sorted.findIndex(x => x.kind === 'strength');
  if (at >= 0) sorted.splice(at + 1, 0, ...extra);
  return sorted;
}

/**
 * Points markets from the prediction (normal model on the margin and the total, the same one behind the win %):
 * winning margin bands, alternative spreads, total points lines, each team's points, overtime and the first half.
 */
function markets(code: string, pHome: number, margin: number, total: number, home: number, away: number) {
  const info = leagueModelInfo(code);
  if (!info) return null;
  // the margin spread implied by the win % (so every number agrees with it), within sane bounds
  const sm = Math.abs(margin) > 0.5 && pHome > 0.02 && pHome < 0.98 ? Math.max(6, Math.min(25, margin / normInv(pHome))) : info.sigma;
  const sT = info.sigmaTotal;
  const pct = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 1000) / 10;
  const inMargin = (lo: number, hi: number) => normCdf((hi - margin) / sm) - normCdf((lo - margin) / sm);
  const band = (lo: number, hi: number) => ({ lo, hi, home: pct(inMargin(lo - 0.5, hi + 0.5)), away: pct(inMargin(-hi - 0.5, -lo + 0.5)) });
  const base = Math.round(total);
  const sTeam = Math.sqrt(sT * sT + sm * sm) / 2;
  const over = (line: number, mean: number, sd: number) => ({ line, over: pct(1 - normCdf((line - mean) / sd)) });
  const m1 = margin * 0.5, s1 = sm * 0.68, t1 = total * 0.49;
  return {
    bands: [band(1, 5), band(6, 10), band(11, 15), band(16, 99)],
    overtime: pct(inMargin(-0.5, 0.5)),
    spreads: [2.5, 5.5, 7.5, 10.5].map(x => ({ line: x, home: pct(1 - normCdf((x - margin) / sm)), away: pct(normCdf((-x - margin) / sm)) })),
    totals: [base - 10.5, base - 5.5, base - 0.5, base + 4.5, base + 9.5].map(l => over(l, total, sT)),
    teamTotals: {
      home: [Math.round(home) - 5.5, Math.round(home) - 0.5, Math.round(home) + 4.5].map(l => over(l, home, sTeam)),
      away: [Math.round(away) - 5.5, Math.round(away) - 0.5, Math.round(away) + 4.5].map(l => over(l, away, sTeam))
    },
    firstHalf: { home: pct(1 - normCdf((0.5 - m1) / s1)), away: pct(normCdf((-0.5 - m1) / s1)), margin: Math.round(m1 * 10) / 10, total: Math.round(t1 * 10) / 10 },
    sigma: Math.round(sm * 10) / 10, sigmaTotal: Math.round(sT * 10) / 10
  };
}

/** API-Basketball standings of a league's current season (cached 1 hour). */
const standCache = new Map<string, { at: number; data: any }>();
export async function bbStandings(code: string) {
  const hit = standCache.get(code);
  if (hit && Date.now() - hit.at < 3600 * 1000) return hit.data;
  const lg: any = db.prepare(`SELECT league_id, seasons FROM bb_leagues WHERE code = ?`).get(code);
  if (!lg) return null;
  const seasons: string[] = JSON.parse(lg.seasons || '[]');
  // the current season until it has games played, else the last one
  let data: any = null;
  for (const season of [seasons[seasons.length - 1], seasons[seasons.length - 2]].filter(Boolean)) {
    const j = await bbGet('/standings', { league: lg.league_id, season });
    const groups = (j.response || [])
      .map((rows: any[]) => rows.filter(r => !/all.?star/i.test(r.stage || '') && !/all.?star/i.test(r.group?.name || '')))
      .filter((rows: any[]) => rows.length >= 4)
      .map((rows: any[]) => ({
        name: rows[0]?.group?.name || rows[0]?.stage || null,
        stage: rows[0]?.stage || null,
        rows: rows.map(r => ({
          position: r.position, team: { id: r.team?.id, name: r.team?.name, logo: r.team?.logo },
          played: r.games?.played ?? 0, won: r.games?.win?.total ?? 0, lost: r.games?.lose?.total ?? 0,
          pct: r.games?.win?.percentage != null ? Number(r.games.win.percentage) : null,
          pointsFor: r.points?.for ?? null, pointsAgainst: r.points?.against ?? null, form: r.form || null
        }))
      }));
    const played = groups.reduce((s: number, gr: any) => s + gr.rows.reduce((a: number, r: any) => a + r.played, 0), 0);
    if (groups.length && played > 0) { data = { season, groups }; break; }
    if (!data && groups.length) data = { season, groups };
  }
  standCache.set(code, { at: Date.now(), data });
  return data;
}

export async function bbGame(id: number, full: boolean) {
  // fix169: each part is timed; a page over 300 ms logs its slow parts by name ("bb game page 123: preview 640 ms …")
  const parts: [string, number][] = [];
  let tp = performance.now(), t0 = tp;
  const mark = (name: string) => { const t = performance.now(); parts.push([name, t - tp]); tp = t; };
  const g: Row = db.prepare(`${SELECT} WHERE game_id = ?`).get(id);
  if (!g) return null;
  const game = shape(g, full);
  mark('game');
  const pr = game.state === 'upcoming' ? predictGameCached(g) : null;
  mark('prediction');
  const h2h = db.prepare(`${SELECT} WHERE ((home_id = ? AND away_id = ?) OR (home_id = ? AND away_id = ?)) AND status IN ('FT','AOT') AND kickoff < ? ORDER BY kickoff DESC LIMIT 10`)
    .all(g.home_id, g.away_id, g.away_id, g.home_id, g.kickoff) as Row[];
  // box score (finished or live games)
  let box: any = null;
  if (game.state !== 'upcoming') {
    const ts = db.prepare(`SELECT * FROM bb_team_stats WHERE game_id = ?`).all(id) as any[];
    const ps = db.prepare(`SELECT * FROM bb_player_stats WHERE game_id = ? ORDER BY starter DESC, minutes DESC`).all(id) as any[];
    if (ts.length || ps.length) {
      // NBA: steals, blocks, turnovers and plus-minus from balldontlie (names as people write them)
      const ex = g.code === 'NBA' ? nbaBoxExtras(g.kickoff, g.home_name, g.away_name) : null;
      const side = (teamId: number) => ({
        team: ts.find(t => t.team_id === teamId) || null,
        players: ps.filter(p => p.team_id === teamId).map(p => {
          const x = ex?.get(personKey(p.name));
          return { id: p.player_id, name: x?.name || p.name, starter: !!p.starter, minutes: p.minutes, points: p.pts, fgm: p.fgm, fga: p.fga, tpm: p.tpm, tpa: p.tpa, ftm: p.ftm, fta: p.fta, rebounds: p.reb, assists: p.ast,
            ...(x ? { steals: x.stl, blocks: x.blk, turnovers: x.tov, plusMinus: x.plusMinus } : {}) };
        })
      });
      box = { home: side(g.home_id), away: side(g.away_id) };
    }
  }
  mark('h2h + box');
  let standings: any = null;
  try { standings = await bbStandings(g.code); } catch { /* table not available */ }
  tp = performance.now(); // (awaits are not counted)
  const ratings = full ? { home: teamRating(g.code, g.home_id), away: teamRating(g.code, g.away_id) } : null;
  // markets and model numbers: whoever sees the full prediction (and everyone once the game is over)
  const gp: any = game.prediction;
  const open = !!gp && !gp.locked && typeof gp.pHome === 'number';
  const info = open ? leagueModelInfo(g.code) : null;
  const mk = open && gp.score ? markets(g.code, gp.pHome / 100, gp.spread, gp.total, gp.score.home, gp.score.away) : null;
  // players to watch: each team's top players this season (or last season before the first games)
  const top = async (teamId: number, name: string) => {
    try { return (await bbSquad(teamId, name, g.code, g.season)).filter(p => p.gp > 0).sort((a, b) => (b.pts || 0) - (a.pts || 0)).slice(0, 8); } catch { return []; }
  };
  mark('ratings + markets');
  const players = { home: await top(g.home_id, g.home_name), away: await top(g.away_id, g.away_name) };
  tp = performance.now();
  const why = reasons(g, pr || (game.prediction && (game.prediction as any).spread != null ? { margin: (game.prediction as any).spread, b2bHome: (game.prediction as any).b2bHome, b2bAway: (game.prediction as any).b2bAway } : null), full || game.state === 'done');
  mark('why');
  const stats = { home: averages(g.home_id, g.kickoff), away: averages(g.away_id, g.kickoff) };
  mark('averages');
  const sched = { home: schedule(g.home_id, g.kickoff), away: schedule(g.away_id, g.kickoff) };
  mark('schedule');
  const pv = preview(g);
  mark('preview');
  const writeup = bbPreview(id);
  mark('writeup');
  const injuries = g.code === 'NBA' ? { home: nbaInjuries(g.home_id, g.home_name, g.kickoff), away: nbaInjuries(g.away_id, g.away_name, g.kickoff) } : null;
  mark('injuries');
  // fix174: probable starting five + bench + players out (football's line-ups, basketball's way); NBA: numbers changed
  const lineups = game.state === 'done' ? null : { home: bbProbableLineup(g.home_id, g.home_name, g.code, g.kickoff), away: bbProbableLineup(g.away_id, g.away_name, g.code, g.kickoff) };
  const beforeAfter = open && game.state === 'upcoming' ? bbBeforeAfter(g, gp.pHome) : null;
  mark('lineups');
  const syncMs = parts.reduce((x, [, ms]) => x + ms, 0);
  if (syncMs > 300) logger.warn(`bb game page ${id}: ${Math.round(syncMs)} ms (${parts.filter(([, ms]) => ms >= 30).sort((a, b) => b[1] - a[1]).map(([n, ms]) => `${n} ${Math.round(ms)} ms`).join(', ')}; total with waits ${Math.round(performance.now() - t0)} ms)`);
  return {
    game,
    why,
    ratings,
    stats,
    schedule: sched,
    preview: pv,
    writeup, // fix124: the English text preview (same as crawlers get, no pick, no %)
    injuries,
    h2h: h2h.map(x => ({ id: x.game_id, kickoff: x.kickoff, home: x.home_name, away: x.away_name, homeId: x.home_id, score: [x.hs, x.as_], league: x.code })),
    box,
    standings,
    markets: mk,
    lineups: lineups && (lineups.home || lineups.away) ? lineups : null,
    // fix178: the swing chart (live and finished games; numbers unlocked)
    liveCurve: open && game.state !== 'upcoming' ? bbLiveCurve(id) : [],
    beforeAfter,
    model: info ? { version: info.version, avgPoints: Math.round(info.avgPoints * 10) / 10, homeEdge: Math.round(((pr as any)?.hca ?? info.homeEdge) * 10) / 10, b2b: info.b2b, gamesRated: info.gamesRated } : null,
    players
  };
}

/* ---------- analysis (game preview and team page) ---------- */

/** A team's finished games of one season in its league (pre-season left out), oldest first. */
function seasonGames(teamId: number, code: string, season: string, before: string) {
  return (db.prepare(`${SELECT} WHERE code = ? AND season = ? AND (home_id = ? OR away_id = ?) AND status IN ('FT','AOT') AND kickoff < ? ORDER BY kickoff`)
    .all(code, season, teamId, teamId, before) as Row[]).filter(g => !isPreseason({ code: g.code, kickoff: g.kickoff }))
}
/** The season to describe: the game's season, or last season when this one has barely started (fewer than 5 games). */
function seasonFor(teamId: number, code: string, season: string, before: string) {
  const now = seasonGames(teamId, code, season, before)
  if (now.length >= 5) return { season, games: now, previous: false }
  const prev: any = db.prepare(`SELECT MAX(season) AS s FROM bb_games WHERE code = ? AND season < ?`).get(code, season)
  if (!prev?.s) return { season, games: now, previous: false }
  return { season: prev.s as string, games: seasonGames(teamId, code, prev.s, before), previous: true }
}

function splits(teamId: number, games: Row[]) {
  const r = { won: 0, lost: 0, homeWon: 0, homeLost: 0, awayWon: 0, awayLost: 0, b2bWon: 0, b2bLost: 0, marginHome: 0, marginAway: 0, closeWon: 0, closeLost: 0 }
  let prevTs = 0
  for (const g of games) {
    const home = g.home_id === teamId
    const m = home ? g.hs - g.as_ : g.as_ - g.hs
    const won = m > 0
    const ts = new Date(g.kickoff).getTime()
    const b2b = prevTs && ts - prevTs < 1.4 * 86400000
    prevTs = ts
    if (won) r.won++; else r.lost++
    if (home) { won ? r.homeWon++ : r.homeLost++; r.marginHome += m } else { won ? r.awayWon++ : r.awayLost++; r.marginAway += m }
    if (b2b) won ? r.b2bWon++ : r.b2bLost++
    if (Math.abs(m) <= 5) won ? r.closeWon++ : r.closeLost++
  }
  const hg = r.homeWon + r.homeLost, ag = r.awayWon + r.awayLost
  const r1 = (x: number) => Math.round(x * 10) / 10
  return { ...r, games: games.length, marginHome: hg ? r1(r.marginHome / hg) : null, marginAway: ag ? r1(r.marginAway / ag) : null }
}

function streakOf(teamId: number, games: Row[]) {
  let n = 0, kind: 'W' | 'L' | null = null
  for (const g of [...games].reverse()) {
    const w = (g.home_id === teamId ? g.hs > g.as_ : g.as_ > g.hs) ? 'W' : 'L'
    if (!kind) kind = w
    if (w !== kind) break
    n++
  }
  return kind ? { kind, n } : null
}

/** Season box-score averages of a team and of its league, for "better / worse than average". */
function profile(teamId: number, code: string, season: string, before: string) {
  const one = (where: string, args: any[]) => db.prepare(`
    SELECT COUNT(*) AS n, SUM(t.fgm) fgm, SUM(t.fga) fga, SUM(t.tpm) tpm, SUM(t.tpa) tpa, SUM(t.ftm) ftm, SUM(t.fta) fta,
      AVG(t.reb) reb, AVG(t.ast) ast, AVG(t.tov) tov, AVG(t.stl) stl, AVG(t.blk) blk
    FROM bb_team_stats t JOIN bb_games g ON g.game_id = t.game_id
    WHERE g.code = ? AND g.season = ? AND g.kickoff < ? AND t.fga > 0 ${where}`).get(code, season, before, ...args) as any
  const shape = (x: any) => !x || !x.n ? null : {
    games: x.n,
    fgPct: x.fga ? Math.round((x.fgm / x.fga) * 1000) / 10 : null,
    threePct: x.tpa ? Math.round((x.tpm / x.tpa) * 1000) / 10 : null,
    threeAttempts: Math.round((x.tpa / x.n) * 10) / 10,
    ftPct: x.fta ? Math.round((x.ftm / x.fta) * 1000) / 10 : null,
    rebounds: x.reb != null ? Math.round(x.reb * 10) / 10 : null,
    assists: x.ast != null ? Math.round(x.ast * 10) / 10 : null,
    turnovers: x.tov != null ? Math.round(x.tov * 10) / 10 : null,
    steals: x.stl != null ? Math.round(x.stl * 10) / 10 : null,
    blocks: x.blk != null ? Math.round(x.blk * 10) / 10 : null
  }
  return { team: shape(one('AND t.team_id = ?', [teamId])), league: shape(one('', [])) }
}

/** Everything the written preview of a game is built from (the site turns it into sentences). */
function preview(g: Row) {
  const ranks = new Map(leagueRatings(g.code).map(x => [x.id, x]))
  const side = (teamId: number) => {
    const s = seasonFor(teamId, g.code, g.season, g.kickoff)
    const pts = s.games.map(x => (x.home_id === teamId ? [x.hs, x.as_] : [x.as_, x.hs]))
    const r = ranks.get(teamId)
    return {
      season: s.season, previousSeason: s.previous,
      splits: splits(teamId, s.games),
      streak: streakOf(teamId, s.games),
      last10: (() => { const l = s.games.slice(-10); const w = l.filter(x => (x.home_id === teamId ? x.hs > x.as_ : x.as_ > x.hs)).length; return { won: w, lost: l.length - w } })(),
      pointsFor: pts.length ? Math.round((pts.reduce((a, p) => a + p[0], 0) / pts.length) * 10) / 10 : null,
      pointsAgainst: pts.length ? Math.round((pts.reduce((a, p) => a + p[1], 0) / pts.length) * 10) / 10 : null,
      ranks: r ? { attack: r.attackRank, defence: r.defenceRank, overall: r.netRank, of: r.of } : null,
      profile: profile(teamId, g.code, s.season, g.kickoff)
    }
  }
  const h2h = db.prepare(`${SELECT} WHERE ((home_id = ? AND away_id = ?) OR (home_id = ? AND away_id = ?)) AND status IN ('FT','AOT') AND kickoff < ? ORDER BY kickoff DESC LIMIT 10`)
    .all(g.home_id, g.away_id, g.away_id, g.home_id, g.kickoff) as Row[]
  const homeWins = h2h.filter(x => (x.home_id === g.home_id ? x.hs > x.as_ : x.as_ > x.hs)).length
  return { home: side(g.home_id), away: side(g.away_id), h2h: { games: h2h.length, homeWins, awayWins: h2h.length - homeWins } }
}

/** Team page analysis: season splits, ranks, stat profile against the league, the last 20 games. */
function teamAnalysis(teamId: number, code: string) {
  const latest: any = db.prepare(`SELECT MAX(season) AS s FROM bb_games WHERE code = ? AND kickoff < ?`).get(code, new Date().toISOString())
  if (!latest?.s) return null
  const now = new Date().toISOString()
  const s = seasonFor(teamId, code, latest.s, now)
  const r = leagueRatings(code).find(x => x.id === teamId)
  const last = db.prepare(`${SELECT} WHERE (home_id = ? OR away_id = ?) AND status IN ('FT','AOT') AND kickoff < ? ORDER BY kickoff DESC LIMIT 20`).all(teamId, teamId, now) as Row[]
  return {
    season: s.season, previousSeason: s.previous,
    splits: splits(teamId, s.games),
    streak: streakOf(teamId, s.games),
    ranks: r ? { attack: r.attackRank, defence: r.defenceRank, overall: r.netRank, of: r.of } : null,
    profile: profile(teamId, code, s.season, now),
    last20: last.reverse().map(x => {
      const home = x.home_id === teamId
      const f = home ? x.hs : x.as_, a = home ? x.as_ : x.hs
      return { id: x.game_id, kickoff: x.kickoff, home, opponent: home ? x.away_name : x.home_name, for: f, against: a, margin: f - a }
    })
  }
}

/** A team's page data: recent and next games. */
/**
 * fix177: a team we have no game of yet (a league added from admin lists its teams in the table before its games are
 * stored — e.g. Arlans, BB396): the page from the league table — name, logo, league, place — instead of a 404. Tables
 * already loaded are searched first; then the tables of the leagues added from admin (one cached call each).
 */
async function bbTeamFromTable(teamId: number) {
  const find = (code: string, data: any) => {
    for (const gr of data?.groups || []) for (const r of gr.rows || []) if (r.team?.id === teamId) return { code, row: r, group: gr.name };
    return null;
  };
  let hit: { code: string; row: any; group: string | null } | null = null;
  for (const [code, c] of standCache) { hit = find(code, c.data); if (hit) break; }
  if (!hit) for (const l of BB_LEAGUES) {
    if (standCache.has(l.code)) continue;
    try { hit = find(l.code, await bbStandings(l.code)); } catch { /* table not available */ }
    if (hit) break;
  }
  if (!hit) return null;
  logger.info(`basketball team ${teamId}: no games stored yet, page from the ${hit.code} table`);
  const r = hit.row;
  return {
    team: { id: teamId, name: r.team.name, logo: r.team.logo || null, league: hit.code }, rating: null, averages: null, analysis: null, teamAnalysis: null, squad: [],
    recent: [], next: [], standing: { position: r.position, played: r.played, won: r.won, lost: r.lost, group: hit.group }, noGamesYet: true
  };
}

export async function bbTeam(teamId: number, full: boolean) {
  const now = new Date().toISOString();
  const recent = db.prepare(`${SELECT} WHERE (home_id = ? OR away_id = ?) AND kickoff < ? ORDER BY kickoff DESC LIMIT 15`).all(teamId, teamId, now) as Row[];
  const next = db.prepare(`${SELECT} WHERE (home_id = ? OR away_id = ?) AND kickoff >= ? ORDER BY kickoff ASC LIMIT 8`).all(teamId, teamId, now) as Row[];
  const any = recent[0] || next[0];
  if (!any) return bbTeamFromTable(teamId);
  const name = any.home_id === teamId ? any.home_name : any.away_name, logo = any.home_id === teamId ? any.home_logo : any.away_logo;
  // fix126: "Team analysis" card like football's (paid plans; our record on the team is public)
  let ta: any = null;
  try { const x = bbTeamAnalysis(teamId, any.code, name); ta = full ? x : bbTeamAnalysisTeaser(x); } catch (e: any) { ta = null; }
  return { team: { id: teamId, name, logo, league: any.code }, rating: full ? teamRating(any.code, teamId) : null, averages: averages(teamId, now), analysis: teamAnalysis(teamId, any.code), teamAnalysis: ta, squad: await bbSquad(teamId, name, any.code, (next[0] || recent[0]).season), recent: recent.map(r => shape(r, full)), next: next.map(r => shape(r, full)) };
}
