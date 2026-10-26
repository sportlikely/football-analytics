/**
 * fix237: the admin page's summary tiles and its "Needs you" counts in one light answer (`/api/admin/summary`, an admin
 * route: answered by the worker). Plain COUNT queries only; a table that does not exist yet counts as 0. The data-health
 * report is read by the page from /api/data-health (stored), so nothing here runs a check.
 */
import { db } from '../db';

const count = (sql: string, ...args: any[]): number => {
  try { return Number((db.prepare(sql).get(...args) as any)?.n) || 0; } catch { return 0; }
};

export interface AdminSummary {
  /** waiting for Yarin (Needs you) */
  injuriesToReview: number; bbResultsToCheck: number; contactOpen: number
  /** tiles */
  visitorsToday: number; signupsToday: number; accounts: number; paying: number
  siteErrorsOpen: number; siteErrors24h: number; failedSignIns24h: number
  backupOk: boolean | null; lastBackupAt: string | null
  at: string
}

export function adminSummary(now = Date.now()): AdminSummary {
  const day = new Date(now).toISOString().slice(0, 10);
  const dayAgo = new Date(now - 86400000).toISOString();
  let lastBackupAt: string | null = null;
  try { lastBackupAt = (db.prepare('SELECT at FROM backup_log WHERE ok = 1 ORDER BY id DESC LIMIT 1').get() as any)?.at || null; } catch { /* no backups yet */ }
  let backupTable = true;
  try { db.prepare('SELECT 1 FROM backup_log LIMIT 1').get(); } catch { backupTable = false; }
  return {
    injuriesToReview: count(`SELECT COUNT(*) AS n FROM bb_news_injuries WHERE state = 'active' AND reviewed = 0`),
    // fix239: + the American football / tennis results waiting for a decision (services/resultChecks.ts)
    bbResultsToCheck: count(`SELECT COUNT(*) AS n FROM bb_result_check WHERE resolved_at IS NULL`) + count(`SELECT COUNT(*) AS n FROM result_review WHERE resolved_at IS NULL`)
      + count(`SELECT COUNT(*) AS n FROM settle_review WHERE resolved_at IS NULL`), // fix240: football games with no final at 48 h
    contactOpen: count(`SELECT COUNT(*) AS n FROM contact_messages WHERE handled = 0`),
    // the same "people" rule as the Visitors card (services/visitors.ts)
    visitorsToday: count(`SELECT COUNT(DISTINCT vid) AS n FROM visits WHERE day >= ? AND (human = 1 OR signed_in = 1)`, day),
    signupsToday: count(`SELECT COUNT(*) AS n FROM users WHERE created_at >= ?`, day),
    accounts: count(`SELECT COUNT(*) AS n FROM users`),
    paying: count(`SELECT COUNT(*) AS n FROM users WHERE plan IN ('premium', 'pro')`),
    siteErrorsOpen: count(`SELECT COUNT(*) AS n FROM client_errors WHERE resolved_at IS NULL`),
    siteErrors24h: count(`SELECT COALESCE(SUM(count), 0) AS n FROM client_errors WHERE resolved_at IS NULL AND last_at >= ?`, dayAgo),
    failedSignIns24h: count(`SELECT COUNT(*) AS n FROM security_log WHERE at >= ? AND event IN ('login_fail', '2fa_fail')`, dayAgo),
    backupOk: backupTable ? !!lastBackupAt && now - Date.parse(lastBackupAt) < 36 * 3600000 : null,
    lastBackupAt,
    at: new Date(now).toISOString()
  };
}
