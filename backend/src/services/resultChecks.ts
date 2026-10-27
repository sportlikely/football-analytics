/**
 * fix239: the basketball result rule (bbResults.ts) for American football and tennis.
 *
 *  - American football: the scoring plays per team (games/events, by team id) against the final; the quarters, when we
 *    have them, must add up the same way. Every signal says "home and away swapped" → the scores are swapped here,
 *    kept in result_fix (source "scoring plays"), re-applied after every provider update, logged and listed in the 07:00
 *    summary. Signals that disagree → result_review ("Needs you" + an email with Swap scores / Keep as is).
 *  - Tennis: the winner field against the games of every set and the provider's sets count (retirements left alone).
 *    Both say the other player won → the winner is corrected (source "sets"); only one says so → review.
 *  - fix253: nobody is asked any more — a review still open 72 h later is voided (American football: status CANC kept over
 *    provider updates; tennis: status 'void', which the provider writes never undo) and listed in Done for you with Undo.
 * The record of both sports is read from the stored scores, so a correction counts at once.
 */
import { db } from '../db';
import logger from '../utils/logger';
import { swapVerdict, nflPlayPoints, tennisVerdict, type Verdict } from '../utils/resultSwap';
import { actionLink, adminUrl, israelTime, onEmailAction, siteUrl, type AdminMail } from './adminMail';
import { onUndo, recordDone } from './doneForYou';

/** fix253: still unsure this long after it was found → void (out of the record, as a cancelled game) */
export const REVIEW_VOID_AFTER_MS = 72 * 3600 * 1000;

export type CheckSport = 'american-football' | 'tennis';

db.exec(`
  CREATE TABLE IF NOT EXISTS result_fix (
    sport TEXT NOT NULL, id INTEGER NOT NULL, fields TEXT NOT NULL, provider TEXT NOT NULL, source TEXT NOT NULL, note TEXT,
    by_user TEXT, at TEXT NOT NULL, PRIMARY KEY (sport, id)
  );
  CREATE TABLE IF NOT EXISTS result_review (
    sport TEXT NOT NULL, id INTEGER NOT NULL, issue TEXT NOT NULL, detail TEXT, found_at TEXT NOT NULL,
    resolved_at TEXT, resolution TEXT, by_user TEXT, PRIMARY KEY (sport, id)
  );
`);

const SPORT_NAME: Record<CheckSport, string> = { 'american-football': 'American football', tennis: 'tennis' };
const parse = (s: string | null) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

/* ---------- corrections: stored, re-applied after the provider writes ---------- */

const fixOf = (sport: CheckSport, id: number) => db.prepare(`SELECT * FROM result_fix WHERE sport = ? AND id = ?`).get(sport, id) as any;
const reviewOf = (sport: CheckSport, id: number) => db.prepare(`SELECT * FROM result_review WHERE sport = ? AND id = ?`).get(sport, id) as any;
function resolveReview(sport: CheckSport, id: number, resolution: string, by: string | null) {
  db.prepare(`UPDATE result_review SET resolved_at = ?, resolution = ?, by_user = ? WHERE sport = ? AND id = ? AND resolved_at IS NULL`)
    .run(new Date().toISOString(), resolution, by, sport, id);
}

/** American football: the corrected scores win over every later provider update (called after nfl.storeGames). */
export function applyNflFixes(ids?: number[]) {
  if (ids && !ids.length) return;
  try {
    db.exec(`UPDATE nfl_games SET
        home_pts = json_extract((SELECT f.fields FROM result_fix f WHERE f.sport = 'american-football' AND f.id = nfl_games.game_id), '$.home'),
        away_pts = json_extract((SELECT f.fields FROM result_fix f WHERE f.sport = 'american-football' AND f.id = nfl_games.game_id), '$.away'),
        status = CASE WHEN json_extract((SELECT f.fields FROM result_fix f WHERE f.sport = 'american-football' AND f.id = nfl_games.game_id), '$.void') = 1 THEN 'CANC' ELSE status END
      WHERE game_id IN (SELECT id FROM result_fix WHERE sport = 'american-football')${ids?.length ? ` AND game_id IN (${ids.filter(Number.isInteger).join(',')})` : ''}`);
  } catch { /* table not there yet */ }
}
/** Tennis: the corrected winner wins over every later provider update (called after tennis.storeMatch). */
let tennisFixStmt: ReturnType<typeof db.prepare> | null = null;
export function applyTennisFix(id: number) {
  try {
    (tennisFixStmt ||= db.prepare(`UPDATE tennis_matches SET winner = (SELECT json_extract(f.fields, '$.winner') FROM result_fix f WHERE f.sport = 'tennis' AND f.id = tennis_matches.id)
      WHERE id = ? AND id IN (SELECT id FROM result_fix WHERE sport = 'tennis')`)).run(id);
  } catch { /* table not there yet */ }
}

function saveFix(sport: CheckSport, id: number, fields: object, provider: object, source: string, note: string, by: string | null) {
  const prev = fixOf(sport, id);
  db.prepare(`INSERT OR REPLACE INTO result_fix (sport, id, fields, provider, source, note, by_user, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(sport, id, JSON.stringify(fields), prev ? prev.provider : JSON.stringify(provider), source, note.slice(0, 300), by, new Date().toISOString());
  if (sport === 'american-football') applyNflFixes([id]); else applyTennisFix(id);
}

/* ---------- the checks ---------- */

interface Found { sport: CheckSport; id: number; name: string; when: string; league: string; score: string; swapTo: string; detail: string; path: string }

function nflSignals(g: any): Verdict {
  const q = parse(g.quarters);
  const periods = Array.isArray(q) && Array.isArray(q[0]) && Array.isArray(q[1]) ? { home: q[0], away: q[1] } : null;
  const ev = parse((db.prepare(`SELECT json FROM nfl_events WHERE game_id = ?`).get(g.game_id) as any)?.json ?? null);
  return swapVerdict({ score: [g.home_pts, g.away_pts], box: g.home_id && g.away_id ? nflPlayPoints(ev, g.home_id, g.away_id) : null, periods });
}

export async function checkOtherResults(days = 10, now = Date.now()): Promise<{ checked: number; fixedAuto: number; review: number }> {
  const since = new Date(now - days * 86400000).toISOString();
  const found: Found[] = [];
  let checked = 0, fixedAuto = 0;
  // American football
  let nfl: any[] = [];
  try {
    nfl = db.prepare(`SELECT game_id, league, kickoff, home_id, home_name, away_id, away_name, home_pts, away_pts, quarters FROM nfl_games
      WHERE status IN ('FT','AOT') AND home_pts IS NOT NULL AND away_pts IS NOT NULL AND kickoff >= ?`).all(since) as any[];
  } catch { /* no NFL tables */ }
  for (const g of nfl) {
    checked++;
    if (fixOf('american-football', g.game_id) || reviewOf('american-football', g.game_id)?.resolved_at) continue;
    const v = nflSignals(g);
    const name = `${g.home_name} – ${g.away_name}`, path = `/american-football/game/${g.game_id}`, league = g.league === 2 ? 'College' : 'NFL';
    if (v.action === 'swap') {
      saveFix('american-football', g.game_id, { home: g.away_pts, away: g.home_pts }, { home: g.home_pts, away: g.away_pts }, 'scoring plays', `provider had ${g.home_pts}-${g.away_pts}; ${v.why}`, null);
      resolveReview('american-football', g.game_id, 'swapped automatically (scoring plays)', null);
      fixedAuto++;
      logger.warn(`af result: ${name} swapped automatically ${g.home_pts}-${g.away_pts} → ${g.away_pts}-${g.home_pts} (${v.why})`);
      recordDone({ kind: 'result-fixed', sport: 'american-football', ref: `af:${g.game_id}`, title: `${name}: ${g.home_pts}-${g.away_pts} → ${g.away_pts}-${g.home_pts}`,
        why: `${league}, ${israelTime(g.kickoff)}. Home and away scores were swapped in the data: the scoring plays add up to ${g.away_pts}-${g.home_pts}. Corrected and counted in the record.`, link: siteUrl(path), undo: { sport: 'american-football', id: g.game_id } }, now);
    } else if (v.action === 'review' && !reviewOf('american-football', g.game_id)) {
      const detail = `Score ${g.home_pts}-${g.away_pts}: ${v.why}.`;
      db.prepare(`INSERT OR IGNORE INTO result_review (sport, id, issue, detail, found_at) VALUES ('american-football', ?, 'swapped?', ?, ?)`).run(g.game_id, detail, new Date(now).toISOString());
      found.push({ sport: 'american-football', id: g.game_id, name, when: `${league} · ${israelTime(g.kickoff)}`, league, score: `${g.home_name} ${g.home_pts}–${g.away_pts} ${g.away_name}`, swapTo: `${g.away_pts}–${g.home_pts}`, detail, path });
    }
  }
  // tennis
  let tn: any[] = [];
  try {
    tn = db.prepare(`SELECT id, tour, tournament, scheduled_at, p1_name, p2_name, sets, games, winner, retired FROM tennis_matches
      WHERE status = 'completed' AND winner IN (1, 2) AND scheduled_at >= ?`).all(since) as any[];
  } catch { /* no tennis tables */ }
  for (const m of tn) {
    checked++;
    if (fixOf('tennis', m.id) || reviewOf('tennis', m.id)?.resolved_at) continue;
    const v = tennisVerdict({ winner: m.winner, games: parse(m.games), sets: parse(m.sets), retired: !!m.retired });
    const name = `${m.p1_name} – ${m.p2_name}`, path = `/tennis/match/${m.id}`;
    const winnerName = (w: number) => (w === 1 ? m.p1_name : m.p2_name);
    if (v.action === 'swap' && v.winner) {
      saveFix('tennis', m.id, { winner: v.winner }, { winner: m.winner }, 'sets', `provider had ${winnerName(m.winner)} as the winner; ${v.why}`, null);
      resolveReview('tennis', m.id, 'winner corrected automatically (sets)', null);
      fixedAuto++;
      logger.warn(`tennis result: ${name} winner corrected automatically → ${winnerName(v.winner)} (${v.why})`);
      recordDone({ kind: 'result-fixed', sport: 'tennis', ref: `tn:${m.id}`, title: `${name}: winner → ${winnerName(v.winner)}`,
        why: `${m.tournament || m.tour}, ${israelTime(m.scheduled_at)}. The data named ${winnerName(m.winner)} as the winner, but every set score says ${winnerName(v.winner)}. Corrected and counted in the record.`, link: siteUrl(path), undo: { sport: 'tennis', id: m.id } }, now);
    } else if (v.action === 'review' && !reviewOf('tennis', m.id)) {
      const detail = `Winner in the data: ${winnerName(m.winner)}. ${v.why}.`;
      db.prepare(`INSERT OR IGNORE INTO result_review (sport, id, issue, detail, found_at) VALUES ('tennis', ?, 'winner?', ?, ?)`).run(m.id, detail, new Date(now).toISOString());
      found.push({ sport: 'tennis', id: m.id, name, when: `${m.tournament || m.tour} · ${israelTime(m.scheduled_at)}`, league: m.tour, score: `${name}, winner ${winnerName(m.winner)}`, swapTo: winnerName(m.winner === 1 ? 2 : 1), detail, path });
    }
  }
  // fix253: no "Needs you" email any more — an unsure result is voided after 72 h (voidStaleReviews)
  for (const f of found) logger.info(`${SPORT_NAME[f.sport]} result: ${f.score} unsure: void in 72 h unless the data settles it`);
  voidStaleReviews(now);
  return { checked, fixedAuto, review: (db.prepare(`SELECT COUNT(*) AS n FROM result_review WHERE resolved_at IS NULL`).get() as any).n };
}

/**
 * fix253: reviews still open 72 h after they were found → void, written to Done for you (Undo = the provider's result
 * counts again).
 */
export function voidStaleReviews(now = Date.now()): number {
  const old = db.prepare(`SELECT sport, id, detail FROM result_review WHERE resolved_at IS NULL AND found_at <= ?`).all(new Date(now - REVIEW_VOID_AFTER_MS).toISOString()) as any[];
  for (const r of old) {
    const sport = r.sport as CheckSport;
    let title = '', path = '';
    if (sport === 'american-football') {
      const g: any = db.prepare(`SELECT home_name, away_name, home_pts, away_pts, status FROM nfl_games WHERE game_id = ?`).get(r.id);
      if (!g) { resolveReview(sport, r.id, 'game gone from the data', null); continue; }
      saveFix(sport, r.id, { home: g.home_pts, away: g.away_pts, void: 1 }, { home: g.home_pts, away: g.away_pts, status: g.status }, 'void', 'still unsure after 72 h', null);
      title = `${g.home_name} ${g.home_pts}–${g.away_pts} ${g.away_name}: void`; path = `/american-football/game/${r.id}`;
    } else {
      const m: any = db.prepare(`SELECT p1_name, p2_name, status FROM tennis_matches WHERE id = ?`).get(r.id);
      if (!m) { resolveReview(sport, r.id, 'match gone from the data', null); continue; }
      db.prepare(`UPDATE tennis_matches SET status = 'void', outcome = COALESCE(outcome, 'unresolved') WHERE id = ?`).run(r.id);
      title = `${m.p1_name} – ${m.p2_name}: void`; path = `/tennis/match/${r.id}`;
    }
    resolveReview(sport, r.id, 'void: still unsure after 72 h', null);
    logger.warn(`${SPORT_NAME[sport]} result: ${title} (still unsure after 72 h)`);
    recordDone({ kind: 'result-void', sport, ref: `${sport === 'tennis' ? 'tn' : 'af'}:${r.id}`, title, why: `${r.detail || 'Our checks disagree.'} No second source settled it in 72 h, so it is out of the record (as a cancelled game).`, link: siteUrl(path), undo: { sport, id: r.id } }, now);
  }
  return old.length;
}

/** fix253: Undo from Done for you — the stored correction / void is removed and the provider's result is back. */
function undoFix(p: { sport: CheckSport; id: number }, by: string): string {
  const f = fixOf(p.sport, p.id);
  if (p.sport === 'tennis') {
    const prov = f ? parse(f.provider) : null;
    if (f) db.prepare(`DELETE FROM result_fix WHERE sport = 'tennis' AND id = ?`).run(p.id);
    if (prov?.winner) db.prepare(`UPDATE tennis_matches SET winner = ? WHERE id = ?`).run(prov.winner, p.id);
    db.prepare(`UPDATE tennis_matches SET status = 'completed' WHERE id = ? AND status = 'void'`).run(p.id);
  } else if (f) {
    const prov = parse(f.provider) || {};
    db.prepare(`DELETE FROM result_fix WHERE sport = 'american-football' AND id = ?`).run(p.id);
    db.prepare(`UPDATE nfl_games SET home_pts = COALESCE(?, home_pts), away_pts = COALESCE(?, away_pts), status = CASE WHEN status = 'CANC' THEN COALESCE(?, 'FT') ELSE status END WHERE game_id = ?`)
      .run(prov.home ?? null, prov.away ?? null, prov.status ?? null, p.id);
  }
  db.prepare(`INSERT INTO result_review (sport, id, issue, detail, found_at, resolved_at, resolution, by_user) VALUES (?, ?, 'undo', NULL, ?, ?, 'undo: provider result kept', ?)
    ON CONFLICT(sport, id) DO UPDATE SET resolved_at = excluded.resolved_at, resolution = excluded.resolution, by_user = excluded.by_user`)
    .run(p.sport, p.id, new Date().toISOString(), new Date().toISOString(), by);
  return 'The provider’s result is back and counts in the record.';
}
onUndo('result-void', undoFix, 'american-football'); onUndo('result-void', undoFix, 'tennis');
onUndo('result-fixed', undoFix, 'american-football'); onUndo('result-fixed', undoFix, 'tennis');

function reviewMail(sport: CheckSport, list: Found[], now: number): { subject: string; mail: AdminMail } {
  const n = list.length, what = `${SPORT_NAME[sport]} result${n === 1 ? '' : 's'}`;
  return {
    subject: `Needs you: ${n} ${what}`,
    mail: {
      label: `${sport === 'tennis' ? 'Tennis' : 'American football'} results`, tone: 'warn',
      title: `${n} ${what} to check`,
      what: n === 1 ? `The result of ${list[0].name} may be wrong in the data and our checks disagree.` : `The results of ${n} games may be wrong in the data and our checks disagree.`,
      todo: sport === 'tennis' ? 'Compare with the tournament’s own site, then press "Give the win to …" or "Keep as is".' : 'Compare with the league’s own site, then press "Swap scores" or "Keep as is".',
      rows: list.map(f => ({
        when: f.when, title: f.score, titleHref: siteUrl(f.path), detail: f.detail,
        buttons: [
          { text: sport === 'tennis' ? `Give the win to ${f.swapTo}` : `Swap scores (${f.swapTo})`, href: actionLink('result-review', { sport, id: f.id, act: 'swap' }, `${sport === 'tennis' ? 'Change the winner of' : 'Swap'} ${f.name}`, now) },
          { text: 'Keep as is', href: actionLink('result-review', { sport, id: f.id, act: 'confirm' }, `Keep ${f.name}`, now), kind: 'secondary' as const },
          { text: 'Open game', href: siteUrl(f.path), kind: 'secondary' as const }
        ]
      })),
      buttons: [{ text: 'Open in Admin', href: adminUrl('needs-you') }]
    }
  };
}

/* ---------- admin decisions (Needs you, the email buttons) ---------- */

export class ReviewError extends Error { constructor(public status: number, msg: string) { super(msg); } }

export function decideReview(sport: string, id: number, act: string, by: string): { message: string } {
  if (sport !== 'american-football' && sport !== 'tennis') throw new ReviewError(400, 'Unknown sport.');
  const r = reviewOf(sport, id);
  if (!r) throw new ReviewError(404, 'Nothing to check for this game.');
  if (r.resolved_at) return { message: `Already decided (${r.resolution}${r.by_user ? `, ${r.by_user}` : ''}).` };
  if (act === 'confirm') { resolveReview(sport, id, 'provider confirmed', by); return { message: 'Kept as is.' }; }
  if (act !== 'swap') throw new ReviewError(400, 'Unknown action.');
  if (sport === 'american-football') {
    const g: any = db.prepare(`SELECT home_name, away_name, home_pts, away_pts FROM nfl_games WHERE game_id = ?`).get(id);
    if (!g || g.home_pts == null) throw new ReviewError(404, 'Game not found.');
    saveFix(sport, id, { home: g.away_pts, away: g.home_pts }, { home: g.home_pts, away: g.away_pts }, 'manual', 'home and away swapped', by);
    resolveReview(sport, id, 'swapped', by);
    return { message: `Scores swapped: ${g.home_name} ${g.away_pts}–${g.home_pts} ${g.away_name}.` };
  }
  const m: any = db.prepare(`SELECT p1_name, p2_name, winner FROM tennis_matches WHERE id = ?`).get(id);
  if (!m || (m.winner !== 1 && m.winner !== 2)) throw new ReviewError(404, 'Match not found.');
  const w = m.winner === 1 ? 2 : 1;
  saveFix(sport, id, { winner: w }, { winner: m.winner }, 'manual', 'winner changed', by);
  resolveReview(sport, id, 'winner changed', by);
  return { message: `The win now goes to ${w === 1 ? m.p1_name : m.p2_name}.` };
}

/** open reviews for Admin → Needs you */
export function openReviews() {
  const rows = db.prepare(`SELECT sport, id, issue, detail, found_at FROM result_review WHERE resolved_at IS NULL ORDER BY found_at DESC LIMIT 50`).all() as any[];
  return rows.map(r => {
    let name = '', when: string | null = null, home: string | null = null, away: string | null = null;
    try {
      if (r.sport === 'american-football') { const g: any = db.prepare(`SELECT home_name, away_name, home_pts, away_pts, kickoff FROM nfl_games WHERE game_id = ?`).get(r.id); if (g) { name = `${g.home_name} ${g.home_pts}–${g.away_pts} ${g.away_name}`; when = g.kickoff; home = g.home_name; away = g.away_name; } }
      else { const m: any = db.prepare(`SELECT p1_name, p2_name, scheduled_at FROM tennis_matches WHERE id = ?`).get(r.id); if (m) { name = `${m.p1_name} – ${m.p2_name}`; when = m.scheduled_at; home = m.p1_name; away = m.p2_name; } }
    } catch { /* table missing */ }
    return { ...r, name, when, home, away, path: r.sport === 'american-football' ? `/american-football/game/${r.id}` : `/tennis/match/${r.id}` };
  });
}

onEmailAction('result-review', (p: { sport: string; id: number; act: string }, by) => {
  const out = decideReview(p.sport, p.id, p.act, by);
  return { message: out.message, open: siteUrl(p.sport === 'american-football' ? `/american-football/game/${p.id}` : `/tennis/match/${p.id}`).replace(/^https:\/\/[^/]+/, '') };
});
