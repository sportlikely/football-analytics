/**
 * Basketball team analysis (fix126, Oct 2026) — the same card as football's (services/teamAnalysis.ts):
 *  - model:  how bb-v3 rates the team (strength rank + rating, attack / defence per 100 possessions, home · away,
 *            pace, 1–10 league scores incl. roster talent and shooting) and its league rank over the last 6 months
 *  - notes:  strengths and weaknesses written from those numbers by fixed rules (no guessing)
 *  - record: how often our saved pick was right on this team's games (public)
 * Paid plans get everything; free and signed-out visitors get the record and a locked preview (bbTeamAnalysisTeaser).
 * Our own database only, no API calls. Cached 15 minutes per team.
 */
import { db } from '../db';
import { bbTeamModel, isPreseason } from './bbModel';
import { nbaInjuries } from './bbInjuries';

const TTL = 15 * 60 * 1000;
const cache = new Map<number, { at: number; data: any }>();
const DONE = `status IN ('FT','AOT') AND hs IS NOT NULL AND as_ IS NOT NULL`;
const pct = (a: number, n: number) => (n ? Math.round((a / n) * 100) : null);
const r1 = (x: number) => Math.round(x * 10) / 10;

type Note = { kind: 'plus' | 'minus' | 'note'; text: string };
interface G { game_id: number; kickoff: string; code: string; home_id: number; away_id: number; hs: number; as_: number }

/** The season to describe: the latest one, or the one before while the new one has fewer than 5 games for this team. */
function seasonOf(teamId: number, code: string) {
  const now = new Date().toISOString();
  const seasons = (db.prepare(`SELECT DISTINCT season FROM bb_games WHERE code = ? AND ${DONE} AND kickoff < ? ORDER BY season DESC LIMIT 2`).all(code, now) as any[]).map(r => r.season as string);
  for (const s of seasons) {
    const games = (db.prepare(`SELECT game_id, kickoff, code, home_id, away_id, hs, as_ FROM bb_games WHERE code = ? AND season = ? AND ${DONE} AND kickoff < ? ORDER BY kickoff`)
      .all(code, s, now) as unknown as G[]).filter(g => !isPreseason(g));
    if (games.filter(g => g.home_id === teamId || g.away_id === teamId).length >= 5 || s === seasons[seasons.length - 1]) return { season: s, previous: s !== seasons[0], games };
  }
  return null;
}

/** Per-team home / away win % and eFG% for one season of a league (for the 1–10 scores). */
function leagueTable(games: G[], code: string, season: string) {
  const t = new Map<number, { hw: number; hl: number; aw: number; al: number; hm: number; am: number }>();
  const get = (id: number) => { let x = t.get(id); if (!x) t.set(id, (x = { hw: 0, hl: 0, aw: 0, al: 0, hm: 0, am: 0 })); return x; };
  for (const g of games) {
    const h = get(g.home_id), a = get(g.away_id), m = g.hs - g.as_;
    if (m > 0) { h.hw++; a.al++; } else { h.hl++; a.aw++; }
    h.hm += m; a.am -= m;
  }
  const efg = new Map<number, number>();
  for (const r of db.prepare(`SELECT s.team_id AS id, SUM(s.fgm) fgm, SUM(s.tpm) tpm, SUM(s.fga) fga FROM bb_team_stats s JOIN bb_games g ON g.game_id = s.game_id
      WHERE g.code = ? AND g.season = ? AND s.fga > 0 GROUP BY s.team_id HAVING COUNT(*) >= 3`).all(code, season) as any[])
    efg.set(r.id, (100 * (r.fgm + 0.5 * (r.tpm || 0))) / r.fga);
  return { t, efg };
}

const scoreOf = (vals: number[], mine: number | undefined) => {
  if (mine === undefined || vals.length < 2) return undefined;
  const better = vals.filter(v => v > mine).length;
  return Math.round((1 + (9 * (vals.length - 1 - better)) / (vals.length - 1)) * 10) / 10;
};

/** Our saved picks on this team's finished games (pre-season and unresolved result checks left out). */
function teamRecord(teamId: number) {
  const rows = (db.prepare(`
    SELECT p.game_id, p.code, p.kickoff, p.p_home, g.home_id, g.home_name, g.away_name, g.hs, g.as_
    FROM bb_predictions p JOIN bb_games g ON g.game_id = p.game_id
    WHERE (g.home_id = ? OR g.away_id = ?) AND g.status IN ('FT','AOT') AND g.hs IS NOT NULL AND p.made_at <= p.kickoff
      AND p.game_id NOT IN (SELECT game_id FROM bb_result_check WHERE resolved_at IS NULL)
    ORDER BY p.kickoff DESC`).all(teamId, teamId) as any[]).filter(r => !isPreseason(r));
  if (!rows.length) return { n: 0 };
  let hits = 0, sN = 0, sHits = 0;
  const games = rows.map(r => {
    const home = r.home_id === teamId;
    const hit = (r.p_home >= 0.5) === (r.hs > r.as_);
    if (hit) hits++;
    if (Math.max(r.p_home, 1 - r.p_home) >= 0.7) { sN++; if (hit) sHits++; }
    const weWin = home ? r.p_home >= 0.5 : r.p_home < 0.5;
    return {
      matchId: r.game_id, date: r.kickoff, comp: r.code, home, opp: home ? r.away_name : r.home_name,
      score: home ? `${r.hs}–${r.as_}` : `${r.as_}–${r.hs}`, pick: weWin ? 'Win' : 'Loss', hit
    };
  });
  return { n: rows.length, hits, hitRate: pct(hits, rows.length), strong: sN ? { n: sN, hitRate: pct(sHits, sN) } : null, games: games.slice(0, 10) };
}

export function bbTeamAnalysis(teamId: number, code: string, name: string) {
  const c = cache.get(teamId);
  if (c && Date.now() - c.at < TTL) return c.data;
  const model = bbTeamModel(code, teamId);
  const s = seasonOf(teamId, code);
  const mine = (s?.games || []).filter(g => g.home_id === teamId || g.away_id === teamId);
  const notes: Note[] = [];
  let homeAway: any = null, scores: Record<string, number | undefined> = { ...(model?.scores || {}) };
  if (s && mine.length) {
    const { t, efg } = leagueTable(s.games, code, s.season);
    const me = t.get(teamId)!;
    const hg = me.hw + me.hl, ag = me.aw + me.al;
    homeAway = {
      homeWinPct: pct(me.hw, hg), awayWinPct: pct(me.aw, ag), homeGames: hg, awayGames: ag,
      homeMargin: hg ? r1(me.hm / hg) : null, awayMargin: ag ? r1(me.am / ag) : null, season: s.season, previousSeason: s.previous
    };
    const rate = (w: number, l: number) => (w + l ? w / (w + l) : null);
    const homes = [...t.values()].map(x => rate(x.hw, x.hl)).filter((x): x is number => x !== null);
    const aways = [...t.values()].map(x => rate(x.aw, x.al)).filter((x): x is number => x !== null);
    scores.home = scoreOf(homes, rate(me.hw, me.hl) ?? undefined);
    scores.away = scoreOf(aways, rate(me.aw, me.al) ?? undefined);
    scores.shooting = scoreOf([...efg.values()], efg.get(teamId));
    if (efg.has(teamId)) homeAway.efg = r1(efg.get(teamId)!);
  }

  /* ---------- notes: fixed rules on the numbers ---------- */
  if (model) {
    const sc = model.scores, of = `#${model.rank} of ${model.teams}`;
    const unit = model.perPossession ? 'points per 100 possessions' : 'points a game';
    if ((sc.strength ?? 0) >= 8) notes.push({ kind: 'plus', text: `One of the strongest teams in the league by our rating (${of}).` });
    else if (sc.strength !== undefined && sc.strength <= 3) notes.push({ kind: 'minus', text: `Among the weaker teams in the league by our rating (${of}).` });
    if ((sc.attack ?? 0) >= 8) notes.push({ kind: 'plus', text: `Strong attack: ${model.attack.toFixed(1)} ${unit} against average opposition (league ${model.leagueAttack.toFixed(1)}).` });
    else if (sc.attack !== undefined && sc.attack <= 3) notes.push({ kind: 'minus', text: `Struggles to score: ${model.attack.toFixed(1)} ${unit} against average opposition (league ${model.leagueAttack.toFixed(1)}).` });
    if ((sc.defence ?? 0) >= 8) notes.push({ kind: 'plus', text: `Solid defence: allows ${model.defence.toFixed(1)} ${unit} (league ${model.leagueAttack.toFixed(1)}).` });
    else if (sc.defence !== undefined && sc.defence <= 3) notes.push({ kind: 'minus', text: `Leaky defence: allows ${model.defence.toFixed(1)} ${unit} (league ${model.leagueAttack.toFixed(1)}).` });
    if (model.pace !== null && model.leaguePace !== null) {
      if ((sc.pace ?? 0) >= 8.5) notes.push({ kind: 'note', text: `Plays fast: about ${Math.round(model.pace)} possessions a game (league ${Math.round(model.leaguePace)}).` });
      else if (sc.pace !== undefined && sc.pace <= 2.5) notes.push({ kind: 'note', text: `Plays slow: about ${Math.round(model.pace)} possessions a game (league ${Math.round(model.leaguePace)}).` });
    }
    if ((sc.talent ?? 0) >= 8 && (sc.strength ?? 10) <= 5) notes.push({ kind: 'note', text: 'The roster is better than the results so far: room to improve.' });
    else if (sc.talent !== undefined && sc.talent <= 3 && (sc.strength ?? 0) >= 7) notes.push({ kind: 'note', text: 'Getting more out of the roster than its players\' numbers suggest.' });
    const tr = model.trend;
    if (tr.length >= 2) {
      const first = tr[0], now = tr[tr.length - 1];
      const since = new Date(first.date).toLocaleDateString('en-GB', { month: 'long' });
      if (first.rank - now.rank >= 3) notes.push({ kind: 'plus', text: `Rising: up from #${first.rank} to #${now.rank} in our ratings since ${since}.` });
      else if (now.rank - first.rank >= 3) notes.push({ kind: 'minus', text: `Falling: down from #${first.rank} to #${now.rank} in our ratings since ${since}.` });
    }
  }
  const won = (g: G) => (g.home_id === teamId ? g.hs > g.as_ : g.as_ > g.hs);
  const last10 = [...mine].reverse().slice(0, 10);
  if (last10.length >= 8) {
    const w = last10.filter(won).length, n = last10.length;
    if (w >= Math.ceil(0.8 * n)) notes.push({ kind: 'plus', text: `In good form: ${w} wins in the last ${n}.` });
    else if (w <= Math.floor(0.2 * n)) notes.push({ kind: 'minus', text: `Poor form: ${w} wins in the last ${n}.` });
  }
  if (homeAway && homeAway.homeGames >= 4 && homeAway.awayGames >= 4) {
    const h = homeAway.homeWinPct, a = homeAway.awayWinPct;
    if (h - a >= 30) notes.push({ kind: 'note', text: `Much stronger at home (${h}% wins) than away (${a}%).` });
    else if (a >= h && a >= 50) notes.push({ kind: 'note', text: `Travels well: ${a}% wins away, ${h}% at home.` });
  }
  if (mine.length) {
    const close = mine.filter(g => Math.abs(g.hs - g.as_) <= 5), cw = close.filter(won).length;
    if (close.length >= 6 && cw / close.length >= 0.7) notes.push({ kind: 'plus', text: `Wins close games: ${cw} of ${close.length} decided by 5 points or less.` });
    else if (close.length >= 6 && cw / close.length <= 0.3) notes.push({ kind: 'minus', text: `Loses close games: ${close.length - cw} of ${close.length} decided by 5 points or less.` });
    // back-to-backs: the second game within ~1.4 days of the previous one (any league)
    const all = db.prepare(`SELECT game_id, kickoff, code, home_id, away_id, hs, as_ FROM bb_games WHERE (home_id = ? OR away_id = ?) AND ${DONE} AND kickoff >= ? ORDER BY kickoff`)
      .all(teamId, teamId, mine[0].kickoff) as unknown as G[];
    let bw = 0, bl = 0;
    for (let i = 1; i < all.length; i++) {
      if (Date.parse(all[i].kickoff) - Date.parse(all[i - 1].kickoff) < 1.4 * 86400000 && !isPreseason(all[i])) won(all[i]) ? bw++ : bl++;
    }
    if (bw + bl >= 4 && bw / (bw + bl) <= 0.3) notes.push({ kind: 'minus', text: `Struggles on the second night of back-to-backs (${bw}–${bl}).` });
    else if (bw + bl >= 4 && bw / (bw + bl) >= 0.7) notes.push({ kind: 'plus', text: `Handles back-to-backs well: ${bw}–${bl} on the second night.` });
    // totals: against a round line near the league's average total this season
    if (last10.length >= 8 && s) {
      const avgTotal = s.games.reduce((a, g) => a + g.hs + g.as_, 0) / s.games.length;
      const line = Math.round(avgTotal / 5) * 5, n = last10.length;
      const over = last10.filter(g => g.hs + g.as_ > line).length;
      if (over >= Math.ceil(0.7 * n)) notes.push({ kind: 'note', text: `High-scoring games: total over ${line} in ${over} of the last ${n}.` });
      else if (n - over >= Math.ceil(0.7 * n)) notes.push({ kind: 'note', text: `Low-scoring games: total under ${line} in ${n - over} of the last ${n}.` });
    }
  }
  if (code === 'NBA') {
    try {
      const out = nbaInjuries(teamId, name, new Date().toISOString()).filter(x => /out/i.test(x.status) && (x.minutes || 0) >= 20).slice(0, 4).map(x => x.name);
      if (out.length) notes.push({ kind: 'minus', text: `Missing key players: ${out.join(', ')}.` });
    } catch { /* no injury report */ }
  }
  const order = { plus: 0, minus: 1, note: 2 };
  const data = {
    model: model ? { ...model, scores, homeAway } : null,
    homeAway,
    record: teamRecord(teamId),
    notes: notes.sort((a, b) => order[a.kind] - order[b.kind]).slice(0, 8),
    builtAt: new Date().toISOString()
  };
  // not cached while the league's model is still being built (server start)
  if (model) cache.set(teamId, { at: Date.now(), data });
  if (cache.size > 500) cache.delete(cache.keys().next().value as number); // fix210: capped low (the page is also stored in the database; the worker answers every page request)
  return data;
}

/** What a free / signed-out visitor gets: our public record on the team, the rest locked. */
export function bbTeamAnalysisTeaser(full: any) {
  return { locked: true, record: full.record || { n: 0 }, notesCount: (full.notes || []).length };
}
