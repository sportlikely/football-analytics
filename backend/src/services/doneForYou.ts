/**
 * fix253 — "Done for you": the site decides by itself, a person only sees what was done and can undo it (Yarin, 27 Oct:
 * "why do I need to approve everything? I want you to do it all").
 *
 *  - Every automatic decision (injury news applied, a result corrected / voided, a football game voided, a site-error
 *    group closed) is written here with what, why, the source link and an Undo button that works for 24 h.
 *  - `recordDone` also notes it for the 07:00 summary email (adminMail.noteAutoFix: 3 lines per type).
 *  - Undo: each kind registers its own undo (`onUndo`), so this file knows no sport. The undo is a person's decision and
 *    is security-logged by the route.
 *  - Needs you keeps only what legally needs a person: contact messages and payment issues (adminSummary.ts).
 */
import { db } from '../db';
import logger from '../utils/logger';
import { noteAutoFix } from './adminMail';

export const UNDO_MS = 24 * 3600 * 1000;
const DAY = 86400000;

db.exec(`
  CREATE TABLE IF NOT EXISTS done_for_you (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL, sport TEXT, ref TEXT NOT NULL,
    title TEXT NOT NULL, why TEXT NOT NULL, link TEXT, undo TEXT, undone_at TEXT, undone_by TEXT, UNIQUE (kind, ref)
  );
  CREATE INDEX IF NOT EXISTS idx_done_for_you_at ON done_for_you(at);
`);

/** the kinds, as the admin page and the morning email name them */
export const DONE_KINDS: Record<string, string> = {
  'injury-news': 'Injury news applied',
  'result-fixed': 'Results corrected',
  'result-void': 'Results voided (still unsure after 72 h)',
  'football-void': 'Football games voided (no final after 7 days)',
  'site-errors': 'Site errors closed'
};

export interface DoneIn {
  kind: keyof typeof DONE_KINDS | string
  sport?: string | null
  /** one decision per (kind, ref): a second record of the same thing is ignored */
  ref: string
  title: string
  why: string
  link?: string | null
  /** what the kind's undo handler needs; null = nothing to undo */
  undo?: unknown
}

type UndoFn = (payload: any, by: string) => string;
const undoers = new Map<string, UndoFn>();
/** each kind (per sport when the sports undo differently) registers how to undo its decision (returns the message shown) */
export const onUndo = (kind: string, fn: UndoFn, sport?: string) => { undoers.set(sport ? `${kind}|${sport}` : kind, fn); };
const undoerOf = (kind: string, sport: string | null) => (sport && undoers.get(`${kind}|${sport}`)) || undoers.get(kind);

/** Write one automatic decision (and note it for the 07:00 summary). Returns false when it was already recorded. */
export function recordDone(d: DoneIn, now = Date.now()): boolean {
  try {
    const r = db.prepare(`INSERT OR IGNORE INTO done_for_you (at, kind, sport, ref, title, why, link, undo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(new Date(now).toISOString(), d.kind, d.sport ?? null, d.ref, d.title.slice(0, 200), d.why.slice(0, 500), d.link ?? null, d.undo == null ? null : JSON.stringify(d.undo));
    if (!Number(r.changes)) return false;
    noteAutoFix(DONE_KINDS[d.kind] || d.kind, d.title, d.why, d.link ?? null, new Date(now));
    return true;
  } catch (e: any) { logger.warn(`done for you: ${e?.message || e}`); return false; }
}

export class UndoError extends Error { constructor(public status: number, msg: string) { super(msg); } }

/** Undo one decision (within 24 h, once). */
export function undoDone(id: number, by: string, now = Date.now()): { message: string } {
  const r = db.prepare(`SELECT * FROM done_for_you WHERE id = ?`).get(id) as any;
  if (!r) throw new UndoError(404, 'Not found.');
  if (r.undone_at) return { message: `Already undone (${r.undone_by || 'admin'}).` };
  if (!r.undo) throw new UndoError(400, 'This one has nothing to undo.');
  if (now - Date.parse(r.at) > UNDO_MS) throw new UndoError(400, 'Undo is open for 24 hours only.');
  const fn = undoerOf(r.kind, r.sport);
  if (!fn) throw new UndoError(400, 'Undo is not available for this kind.');
  const message = fn(JSON.parse(r.undo), by);
  db.prepare(`UPDATE done_for_you SET undone_at = ?, undone_by = ? WHERE id = ?`).run(new Date(now).toISOString(), by, id);
  logger.info(`done for you: undo #${id} (${r.kind} ${r.ref}) by ${by}: ${message}`);
  return { message };
}

/** Admin → Needs you, bottom: the last `days` days, newest first. */
export function doneList(days = 7, now = Date.now()) {
  const rows = db.prepare(`SELECT * FROM done_for_you WHERE at >= ? ORDER BY at DESC LIMIT 300`).all(new Date(now - days * DAY).toISOString()) as any[];
  return rows.map(r => ({
    id: r.id, at: r.at, kind: r.kind, kindLabel: DONE_KINDS[r.kind] || r.kind, sport: r.sport, title: r.title, why: r.why, link: r.link,
    undoneAt: r.undone_at, undoneBy: r.undone_by, canUndo: !!r.undo && !r.undone_at && now - Date.parse(r.at) <= UNDO_MS && !!undoerOf(r.kind, r.sport)
  }));
}

/** keep 90 days (worker, daily) */
export function pruneDone(now = Date.now()) {
  try { db.prepare(`DELETE FROM done_for_you WHERE at < ?`).run(new Date(now - 90 * DAY).toISOString()); } catch { /* ignore */ }
}

/**
 * fix253 data health "Done for you": fail when something waits for a person for over 24 h that is not a customer message
 * or a payment issue — i.e. an automatic decision that did not happen (the rule's own wait included: injury news is
 * decided at once, results void at 72 h, football at 7 days).
 */
export function doneForYouHealth(now = Date.now()): import('./dataHealth').Check {
  const H = 3600 * 1000, iso = (ms: number) => new Date(now - ms).toISOString();
  const late: string[] = [];
  const q = (label: string, sql: string, ...args: any[]) => {
    try { for (const r of db.prepare(sql).all(...args) as any[]) late.push(`${label}: ${r.name} (since ${String(r.at).slice(0, 16).replace('T', ' ')} UTC)`); } catch { /* table missing */ }
  };
  q('injury news not decided', `SELECT name, at FROM bb_news_injuries WHERE state = 'active' AND reviewed = 0 AND at < ? LIMIT 20`, iso(24 * H));
  q('basketball result not voided', `SELECT c.game_id AS name, c.found_at AS at FROM bb_result_check c WHERE c.resolved_at IS NULL AND c.found_at < ? LIMIT 20`, iso(96 * H));
  q('result not voided', `SELECT sport || ' ' || id AS name, found_at AS at FROM result_review WHERE resolved_at IS NULL AND found_at < ? LIMIT 20`, iso(96 * H));
  q('football game not voided', `SELECT r.match_id AS name, MAX(p.utc_date) AS at FROM settle_review r JOIN predictions p ON p.match_id = r.match_id
    WHERE r.resolved_at IS NULL AND r.hold = 0 GROUP BY r.match_id HAVING MAX(p.utc_date) < ? LIMIT 20`, iso(8 * 24 * H));
  let n24 = 0;
  try { n24 = (db.prepare(`SELECT COUNT(*) AS n FROM done_for_you WHERE at >= ?`).get(iso(24 * H)) as any).n; } catch { /* none */ }
  return {
    id: 'done-for-you', label: 'Done for you (nothing waits for a person)', level: late.length ? 'fail' : 'ok',
    detail: late.length ? `${late.length} item(s) waited over 24 h for a decision the site should have made — tell Claude` : `Nothing waits; ${n24} automatic decision(s) in the last 24 h (Admin → Needs you → Done for you)`,
    items: late.slice(0, 15)
  };
}
