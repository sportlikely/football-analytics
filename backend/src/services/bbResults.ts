/**
 * Basketball result checks and corrections (Oct 2026).
 *
 * Why: API-Basketball sometimes sends a final score with home and away swapped (Wizards–Pistons pre-season,
 * 10 Oct 2026: the provider had 108–114, the real result was 114–108 to Washington in overtime). We showed the
 * provider's numbers as they were. Now:
 *  1. NBA (not pre-season): every final is compared with balldontlie; a different result is corrected automatically.
 *  2. Every league: the players' points in the box score are added up per team. fix239: when they match the score
 *     the other way round and the quarters (when we have them) add up the same way, the scores are swapped
 *     automatically (bb_result_fix source "box score", logged, listed in the 07:00 summary email). When the signals
 *     disagree or one is missing, or the quarters don't add up to the total, the game is put "under review": no
 *     Right/Wrong badge and left out of the record until it is settled. fix253: nobody is asked any more — still
 *     unsure 72 h later → void (out of the record, as a cancelled game), listed in Admin → Done for you with Undo.
 *  3. The admin can correct any result by hand (swap, set the score, or confirm the provider) on the game page, in
 *     Admin → Needs you, or from the email. A correction survives every later provider update; "undo" removes it.
 * Missing overtime column (provider sends quarters 1–4 only): overtime = total − quarters, shown on the page.
 */
import { db } from '../db';
import logger from '../utils/logger';
import { swapVerdict } from '../utils/resultSwap';
import { actionLink, adminUrl, israelTime, onEmailAction, siteUrl, type AdminMail } from './adminMail';
import { isPreseason } from './bbModel';
import { onUndo, recordDone } from './doneForYou';

/** fix253: a check still unsure this long after it was found is voided (out of the record, as a cancelled game) */
export const RESULT_VOID_AFTER_MS = 72 * 3600 * 1000;

db.exec(`
  CREATE TABLE IF NOT EXISTS bb_result_fix (
    game_id INTEGER PRIMARY KEY, hs INTEGER NOT NULL, as_ INTEGER NOT NULL, quarters TEXT, source TEXT NOT NULL,
    note TEXT, by_user TEXT, at TEXT NOT NULL, provider_hs INTEGER, provider_as INTEGER
  );
  CREATE TABLE IF NOT EXISTS bb_result_check (
    game_id INTEGER PRIMARY KEY, issue TEXT NOT NULL, detail TEXT, found_at TEXT NOT NULL,
    resolved_at TEXT, resolution TEXT, by_user TEXT
  );
`);
if (!(db.prepare('PRAGMA table_info(bb_result_check)').all() as any[]).some(c => c.name === 'voided')) db.exec('ALTER TABLE bb_result_check ADD COLUMN voided INTEGER NOT NULL DEFAULT 0');

type Q = { home: (number | null)[]; away: (number | null)[] } | null;
const parseQ = (s: string | null): Q => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const sum4 = (a: (number | null)[]) => a.slice(0, 4).reduce<number>((s, v) => s + (v ?? 0), 0);

/** Quarters with the overtime filled in when the provider left it out (total − four quarters, both sides ≥ 0). */
export function fillOvertime(q: Q, hs: number | null, as_: number | null): Q {
  if (!q || hs == null || as_ == null || q.home.length < 4 || q.away.length < 4) return q;
  if (q.home.slice(0, 4).some(v => v == null) || q.away.slice(0, 4).some(v => v == null)) return q;
  if (q.home[4] != null || q.away[4] != null) return q;
  const oh = hs - sum4(q.home), oa = as_ - sum4(q.away);
  if (oh === 0 && oa === 0) return q;
  if (oh < 0 || oa < 0 || oh > 40 || oa > 40) return q;
  return { home: [...q.home.slice(0, 4), oh], away: [...q.away.slice(0, 4), oa] };
}

/** Re-apply our corrections after a provider update (they always win until undone). */
export function applyResultFixes() {
  db.exec(`UPDATE bb_games SET
      hs = (SELECT f.hs FROM bb_result_fix f WHERE f.game_id = bb_games.game_id),
      as_ = (SELECT f.as_ FROM bb_result_fix f WHERE f.game_id = bb_games.game_id),
      quarters = COALESCE((SELECT f.quarters FROM bb_result_fix f WHERE f.game_id = bb_games.game_id), quarters)
    WHERE game_id IN (SELECT game_id FROM bb_result_fix)`);
}

export const openCheck = (gameId: number) =>
  (db.prepare('SELECT issue, detail, found_at, voided FROM bb_result_check WHERE game_id = ? AND (resolved_at IS NULL OR voided = 1)').get(gameId) as any) || null; // fix253: voided = no badge either
export const resultFix = (gameId: number) =>
  (db.prepare('SELECT hs, as_, source, note, by_user, at, provider_hs, provider_as FROM bb_result_fix WHERE game_id = ?').get(gameId) as any) || null;

function saveFix(g: any, hs: number, as_: number, quarters: Q, source: string, note: string | null, by: string | null) {
  const prev = resultFix(g.game_id);
  db.prepare(`INSERT OR REPLACE INTO bb_result_fix (game_id, hs, as_, quarters, source, note, by_user, at, provider_hs, provider_as) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(g.game_id, hs, as_, quarters ? JSON.stringify(quarters) : null, source, note, by, new Date().toISOString(),
      prev ? prev.provider_hs : g.hs, prev ? prev.provider_as : g.as_);
  db.prepare('UPDATE bb_games SET hs = ?, as_ = ?, quarters = COALESCE(?, quarters) WHERE game_id = ?')
    .run(hs, as_, quarters ? JSON.stringify(quarters) : null, g.game_id);
}
function resolve(gameId: number, resolution: string, by: string | null) {
  db.prepare('UPDATE bb_result_check SET resolved_at = ?, resolution = ?, by_user = ? WHERE game_id = ? AND resolved_at IS NULL')
    .run(new Date().toISOString(), resolution, by, gameId);
}
const swapQ = (q: Q): Q => (q ? { home: q.away, away: q.home } : null);

/* ---------- admin actions ---------- */

export class ResultError extends Error { constructor(public status: number, msg: string) { super(msg); } }

export function adminResult(gameId: number, action: string, body: any, by: string) {
  const g: any = db.prepare('SELECT * FROM bb_games WHERE game_id = ?').get(gameId);
  if (!g) throw new ResultError(404, 'Game not found.');
  if (action === 'undo') {
    const f = resultFix(gameId);
    if (!f) throw new ResultError(400, 'Nothing to undo.');
    db.prepare('DELETE FROM bb_result_fix WHERE game_id = ?').run(gameId);
    if (f.provider_hs != null) db.prepare('UPDATE bb_games SET hs = ?, as_ = ? WHERE game_id = ?').run(f.provider_hs, f.provider_as, gameId);
    return { undone: true };
  }
  if (g.hs == null || g.as_ == null) throw new ResultError(400, 'This game has no score yet.');
  if (action === 'confirm') { resolve(gameId, 'provider confirmed', by); return { confirmed: true }; }
  if (action === 'swap') {
    saveFix(g, g.as_, g.hs, swapQ(parseQ(g.quarters)), 'manual', body?.note ? String(body.note).slice(0, 200) : 'home and away swapped', by);
    resolve(gameId, 'swapped', by);
    return { hs: g.as_, as_: g.hs };
  }
  if (action === 'set') {
    const hs = parseInt(String(body?.hs), 10), as_ = parseInt(String(body?.as_), 10);
    if (!Number.isFinite(hs) || !Number.isFinite(as_) || hs < 0 || as_ < 0 || hs > 250 || as_ > 250) throw new ResultError(400, 'Enter both scores (0–250).');
    if (hs === as_) throw new ResultError(400, 'A basketball game can’t end in a tie.');
    // quarters: swap them too when the new score is the old one the other way round
    const q = hs === g.as_ && as_ === g.hs ? swapQ(parseQ(g.quarters)) : null;
    saveFix(g, hs, as_, q, 'manual', body?.note ? String(body.note).slice(0, 200) : null, by);
    resolve(gameId, `set ${hs}-${as_}`, by);
    return { hs, as_ };
  }
  throw new ResultError(400, 'Unknown action.');
}

export function resultChecksList() {
  closePreseasonChecks(); // fix240: never listed
  const open = db.prepare(`SELECT c.game_id, c.issue, c.detail, c.found_at, g.code, g.kickoff, g.home_name, g.away_name, g.hs, g.as_
    FROM bb_result_check c JOIN bb_games g ON g.game_id = c.game_id WHERE c.resolved_at IS NULL ORDER BY c.found_at DESC`).all();
  const fixes = db.prepare(`SELECT f.game_id, f.hs, f.as_, f.source, f.note, f.by_user, f.at, f.provider_hs, f.provider_as, g.code, g.kickoff, g.home_name, g.away_name
    FROM bb_result_fix f JOIN bb_games g ON g.game_id = f.game_id ORDER BY f.at DESC LIMIT 30`).all();
  return { open, fixes };
}

/* ---------- automatic checks ---------- */

function bdlFinal(g: any): { hs: number; as_: number } | null {
  try {
    const team = (name: string) => (db.prepare('SELECT id FROM bdl_teams WHERE full_name = ? OR name = ?').get(name, String(name).split(' ').pop()) as any)?.id ?? null;
    const h = team(g.home_name), a = team(g.away_name);
    if (!h || !a) return null;
    // the same two teams in one window of ±36 h: the game closest in time (playoff games are 2+ days apart)
    const t = Date.parse(g.kickoff);
    const near = (db.prepare(`SELECT hs, as_, status, date FROM bdl_games WHERE home_id = ? AND away_id = ? AND hs IS NOT NULL AND date BETWEEN ? AND ?`)
      .all(h, a, new Date(t - 36 * 3600000).toISOString(), new Date(t + 36 * 3600000).toISOString()) as any[]);
    if (near.length !== 1) return null; // none, or ambiguous
    const r = near[0];
    if (!r || String(r.status || '').toLowerCase() !== 'final') return null;
    return { hs: r.hs, as_: r.as_ };
  } catch { return null; }
}

/** fix239: the players' points per team (null when a team has no box score) */
function boxPoints(g: any): [number, number] | null {
  const pts = (team: number) => (db.prepare('SELECT SUM(pts) AS s, COUNT(*) AS n FROM bb_player_stats WHERE game_id = ? AND team_id = ?').get(g.game_id, team) as any);
  const ph = pts(g.home_id), pa = pts(g.away_id);
  return ph?.n && pa?.n && ph.s != null && pa.s != null ? [ph.s, pa.s] : null;
}
const gameName = (g: any) => `${g.home_name} – ${g.away_name}`;
const gamePath = (g: any) => `/basketball/game/${g.game_id}`;

export async function checkResults(days = 10) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const games = db.prepare(`SELECT * FROM bb_games WHERE status IN ('FT','AOT') AND hs IS NOT NULL AND as_ IS NOT NULL AND kickoff >= ?`).all(since) as any[];
  let fixedAuto = 0;
  closePreseasonChecks(); // fix240: open checks of pre-season games from before are closed as they are
  for (const g of games) {
    const fix = resultFix(g.game_id);
    if (fix?.source === 'manual') continue; // the admin decided
    const done: any = db.prepare('SELECT resolved_at, resolution FROM bb_result_check WHERE game_id = ?').get(g.game_id);
    if (String(done?.resolution || '').startsWith('undo')) continue; // fix253: a person undid our decision: left as they chose
    if (isPreseason(g)) {
      // fix240: pre-season is not in the record, so it is never listed: fixed silently when the box score (and the
      // quarters, when there) clearly say swapped, otherwise kept as the provider has it
      if (fix || done) continue;
      const v = swapVerdict({ score: [g.hs, g.as_], box: boxPoints(g), periods: parseQ(g.quarters) });
      if (v.action === 'swap') {
        saveFix(g, g.as_, g.hs, null, 'box score', `pre-season; provider had ${g.hs}-${g.as_}; ${v.why}`, null);
        fixedAuto++;
        logger.info(`bb result (pre-season): ${gameName(g)} swapped silently ${g.hs}-${g.as_} → ${g.as_}-${g.hs} (${v.why})`);
      }
      continue;
    }
    // 1) NBA regular season / playoffs: balldontlie is the second source
    if (g.code === 'NBA' && !isPreseason({ code: g.code, kickoff: g.kickoff })) {
      const b = bdlFinal(g);
      if (b && (b.hs !== g.hs || b.as_ !== g.as_)) {
        const swapped = b.hs === g.as_ && b.as_ === g.hs;
        saveFix(g, b.hs, b.as_, swapped ? swapQ(parseQ(g.quarters)) : null, 'balldontlie', `provider had ${g.hs}-${g.as_}`, null);
        resolve(g.game_id, 'corrected from balldontlie', null);
        fixedAuto++;
        logger.warn(`bb result: ${gameName(g)} corrected from balldontlie ${g.hs}-${g.as_} → ${b.hs}-${b.as_}`);
        recordDone({ kind: 'result-fixed', sport: 'basketball', ref: `bb:${g.game_id}`, title: `${gameName(g)}: ${g.hs}-${g.as_} → ${b.hs}-${b.as_}`, why: `${g.code}, ${israelTime(g.kickoff)}. Two providers: balldontlie (the NBA's second source) had the other result; corrected and counted in the record.`, link: siteUrl(gamePath(g)), undo: { game: g.game_id } });
        continue;
      }
      if (b) continue; // both sources agree
    }
    if (done?.resolved_at || fix) continue; // already reviewed, or already corrected
    // 2) fix239: box score (and quarters) the other way round → swapped automatically when every signal agrees
    const q = parseQ(g.quarters);
    const v = swapVerdict({ score: [g.hs, g.as_], box: boxPoints(g), periods: q });
    let issue: string | null = null, detail: string | null = null;
    if (v.action === 'swap') {
      // the quarters (when there) already add up to the corrected score: only the totals change
      saveFix(g, g.as_, g.hs, null, 'box score', `provider had ${g.hs}-${g.as_}; ${v.why}`, null);
      if (done) resolve(g.game_id, 'swapped automatically (box score)', null);
      fixedAuto++;
      logger.warn(`bb result: ${gameName(g)} swapped automatically ${g.hs}-${g.as_} → ${g.as_}-${g.hs} (${v.why})`);
      recordDone({ kind: 'result-fixed', sport: 'basketball', ref: `bb:${g.game_id}`, title: `${gameName(g)}: ${g.hs}-${g.as_} → ${g.as_}-${g.hs}`,
        why: `${g.code}, ${israelTime(g.kickoff)}. Home and away scores were swapped in the data: the players' points${q ? ' and the quarters' : ''} add up to ${g.as_}-${g.hs}. Corrected and back in the record.`, link: siteUrl(gamePath(g)), undo: { game: g.game_id } });
      continue;
    }
    if (done) continue; // open: voided by voidStaleChecks after 72 h unless the data settles it first
    if (v.action === 'review') { issue = 'swapped?'; detail = `Score ${g.hs}-${g.as_}: ${v.why}.`; }
    // 3) quarters that can't add up to the total (more than a missing overtime explains)
    if (!issue && q && q.home.slice(0, 4).every(v => v != null) && q.away.slice(0, 4).every(v => v != null)) {
      const oh = g.hs - sum4(q.home) - (q.home[4] ?? 0), oa = g.as_ - sum4(q.away) - (q.away[4] ?? 0);
      if (oh < 0 || oa < 0 || (q.home[4] != null && (oh !== 0 || oa !== 0))) {
        issue = 'quarters';
        detail = `Quarters add up to ${sum4(q.home) + (q.home[4] ?? 0)}-${sum4(q.away) + (q.away[4] ?? 0)}, the final score is ${g.hs}-${g.as_}.`;
      }
    }
    if (issue) {
      db.prepare('INSERT OR IGNORE INTO bb_result_check (game_id, issue, detail, found_at) VALUES (?, ?, ?, ?)').run(g.game_id, issue, detail, new Date().toISOString());
      logger.info(`bb result: ${gameName(g)} ${g.hs}-${g.as_} unsure (${issue}): out of the record, void in 72 h unless the data settles it`);
    }
  }
  const voided = voidStaleChecks();
  return { checked: games.length, fixedAuto, voided, open: (db.prepare('SELECT COUNT(*) AS n FROM bb_result_check WHERE resolved_at IS NULL').get() as any).n };
}

/**
 * fix253: a result still unsure 72 h after it was found is voided — out of the record, as a cancelled game — and
 * written to "Done for you" (Undo = keep the provider's score in the record). Nobody is asked.
 */
export function voidStaleChecks(now = Date.now()): number {
  const old = db.prepare(`SELECT c.game_id, c.issue, c.detail, c.found_at, g.code, g.kickoff, g.home_name, g.away_name, g.hs, g.as_ FROM bb_result_check c
    JOIN bb_games g ON g.game_id = c.game_id WHERE c.resolved_at IS NULL AND c.found_at <= ?`).all(new Date(now - RESULT_VOID_AFTER_MS).toISOString()) as any[];
  for (const g of old) {
    db.prepare('UPDATE bb_result_check SET resolved_at = ?, resolution = ?, voided = 1 WHERE game_id = ? AND resolved_at IS NULL')
      .run(new Date(now).toISOString(), 'void: still unsure after 72 h', g.game_id);
    logger.warn(`bb result: ${gameName(g)} ${g.hs}-${g.as_} void (still unsure after 72 h)`);
    recordDone({
      kind: 'result-void', sport: 'basketball', ref: `bb:${g.game_id}`, title: `${g.home_name} ${g.hs}–${g.as_} ${g.away_name}: void`,
      why: `${g.code}, ${israelTime(g.kickoff)}. ${g.detail || 'The checks disagree.'} No second source settled it in 72 h, so the game is out of the record (as a cancelled game).`,
      link: siteUrl(gamePath(g)), undo: { game: g.game_id }
    }, now);
  }
  return old.length;
}

// "Done for you" → Undo. A void: the provider's score counts again. A correction: the provider's score comes back.
// Both are marked 'undo…' so the checks leave the game as the person chose.
onUndo('result-void', (p: { game: number }, by) => {
  db.prepare('UPDATE bb_result_check SET voided = 0, resolution = ?, by_user = ? WHERE game_id = ?').run('undo: kept as the provider has it', by, p.game);
  return 'The game counts in the record again with the provider’s score.';
}, 'basketball');
onUndo('result-fixed', (p: { game: number }, by) => {
  if (resultFix(p.game)) adminResult(p.game, 'undo', null, by);
  const at = new Date().toISOString();
  db.prepare(`INSERT INTO bb_result_check (game_id, issue, detail, found_at, resolved_at, resolution, by_user) VALUES (?, 'undo', NULL, ?, ?, ?, ?)
    ON CONFLICT(game_id) DO UPDATE SET resolved_at = excluded.resolved_at, resolution = excluded.resolution, by_user = excluded.by_user, voided = 0`)
    .run(p.game, at, at, 'undo: provider score kept', by);
  return 'The provider’s score is back.';
}, 'basketball');

/** fix240: open checks of pre-season games (not in the record) closed as they are, so Needs you never lists them. */
export function closePreseasonChecks(): number {
  const open = db.prepare(`SELECT c.game_id, g.code, g.kickoff, g.stage FROM bb_result_check c JOIN bb_games g ON g.game_id = c.game_id WHERE c.resolved_at IS NULL`).all() as any[];
  let n = 0;
  for (const r of open) if (isPreseason(r)) { resolve(r.game_id, 'pre-season (not in the record), kept as is', null); n++; }
  return n;
}

/** fix239: the "Needs you" email (one per run with new games): each game with Swap scores / Keep as is / Open game. */
export function needsYouMail(games: any[], now = Date.now()) {
  const n = games.length;
  const mail: AdminMail = {
    label: 'Basketball results', tone: 'warn',
    title: `${n} basketball result${n === 1 ? '' : 's'} to check`,
    what: n === 1
      ? `The score of ${gameName(games[0])} may be wrong in the data (${games[0].detail?.replace(/\.$/, '') || 'the checks disagree'}), so it is left out of the record.`
      : `The scores of ${n} games may be wrong in the data and the checks disagree, so they are left out of the record.`,
    todo: 'Compare with the league’s own site, then press "Swap scores" or "Keep as is".',
    rows: games.map(g => ({
      when: `${g.code} · ${israelTime(g.kickoff)}`,
      title: `${g.home_name} ${g.hs}–${g.as_} ${g.away_name}`, titleHref: siteUrl(gamePath(g)),
      detail: g.detail || undefined,
      buttons: [
        ...(g.issue === 'swapped?' ? [{ text: `Swap scores (${g.as_}–${g.hs})`, href: actionLink('bb-result', { game: g.game_id, act: 'swap' }, `Swap ${gameName(g)} to ${g.as_}-${g.hs}`, now) }] : []),
        { text: 'Keep as is', href: actionLink('bb-result', { game: g.game_id, act: 'confirm' }, `Keep ${gameName(g)} at ${g.hs}-${g.as_}`, now), kind: 'secondary' as const },
        { text: 'Open game', href: siteUrl(gamePath(g)), kind: 'secondary' as const }
      ]
    })),
    buttons: [{ text: 'Open in Admin', href: adminUrl('needs-you') }],
    footer: 'Swapped scores that the box score and the quarters confirm are fixed automatically and listed in the 07:00 summary instead.'
  };
  return { subject: `Needs you: ${n} basketball result${n === 1 ? '' : 's'}`, mail };
}


// the email buttons (services/adminMail.ts): Swap scores / Keep as is
onEmailAction('bb-result', (p: { game: number; act: 'swap' | 'confirm' }, by) => {
  const g: any = db.prepare('SELECT game_id, home_name, away_name, hs, as_ FROM bb_games WHERE game_id = ?').get(p.game);
  if (!g) return { message: 'This game is no longer in the data.' };
  const open = siteUrl(gamePath(g)).replace(/^https:\/\/[^/]+/, '');
  const c: any = db.prepare('SELECT resolved_at, resolution, by_user FROM bb_result_check WHERE game_id = ?').get(p.game);
  if (c?.resolved_at) return { message: `Already decided (${c.resolution}${c.by_user ? `, ${c.by_user}` : ''}): ${g.home_name} ${g.hs}–${g.as_} ${g.away_name}.`, open };
  const r: any = adminResult(p.game, p.act, { note: 'from the admin email' }, by);
  return p.act === 'swap'
    ? { message: `Scores swapped: ${g.home_name} ${r.hs}–${r.as_} ${g.away_name}. The game counts in the record again.`, open }
    : { message: `Kept as is: ${g.home_name} ${g.hs}–${g.as_} ${g.away_name}. The game counts in the record again.`, open };
});
