/**
 * fix249: how long each log / copy table keeps its rows, and the slice runner that deletes the rest (the worker's
 * "db retention" job, services/dbSpace.ts). Pure: no imports, the database is passed in (tests use a temp file).
 *
 * Rules (Yarin, 27 Oct 2026): logs 14 days; deleted in small slices (SLICE rows a statement, a yield between) so no
 * delete holds the write lock for long. Tables the record, settled predictions, accounts or money need are in
 * PROTECTED and no rule may name them (scripts/fix249.test.ts). Retention that already lives elsewhere and is kept:
 * security_log 90 days (CLAUDE.md privacy rule, securityLog.ts), people's visits 90 days (the 30 / 90-day visitor
 * numbers), perf_hours 48 h, slow_requests 7 days, push_events 60 days, page_cache (pageCache.cleanPageCache).
 */

/** never deleted by retention: the public record, predictions, results, accounts, money, consent */
export const PROTECTED = new Set([
  'predictions', 'results', 'prediction_extras', 'bb_predictions', 'nfl_predictions', 'nfl_pred_first', 'tennis_predictions',
  'bb_games', 'nfl_games', 'tennis_matches', 'af_fixtures', 'history_matches', 'nat_matches', 'eur_matches', 'settle_meta',
  'settle_review', 'result_fix', 'result_review', 'result_checks', 'diff_view_flags', 'clv_tracking', 'user_picks', 'users',
  'plan_events', 'credit_events', 'email_consent_log', 'push_consent_log', 'email_prefs', 'email_suppressed', 'push_subs',
  'push_prefs', 'favorites', 'staff_activity', 'security_log', 'contact_messages', 'support_replies', 'feature_model',
  'model_daily', 'season_forecast_history', 'season_forecast_accuracy', 'bb_live_samples', 'nfl_live_samples',
  'tennis_live_samples', 'slugs', 'slug_ids', 'app_secrets', 'admin_email_actions',
  // fix258: staff console logins (and the session's "console unlocked" flag) are never touched
  'staff_console', 'staff_console_keep', 'sessions', 'roles',
  // fix261: the names in Hebrew / Arabic (admin spellings among them)
  'names', 'name_items'
]);

/** how a rule's column holds time */
export type TimeKind = 'iso' | 'day' | 'ms' | 'minute';
export type Rule = {
  table: string;
  col: string;
  kind: TimeKind;
  keepDays: number;
  /** extra SQL condition (AND …) on the rows to delete */
  extra?: string;
  /** rows per statement when not SLICE (big rows: each deleted row frees its overflow pages) */
  slice?: number;
  /** keep the newest row whatever its age (a "last report" table) */
  keepLatest?: boolean;
  why: string;
};

export const LOG_DAYS = 14;

export const RULES: Rule[] = [
  // ---------- network / visitor / crawler logs ----------
  { table: 'visits', col: 'day', kind: 'day', keepDays: LOG_DAYS, extra: 'human = 0 AND signed_in = 0', why: 'bot / no-signs visits (people kept 90 days: the 30-day numbers)' },
  { table: 'league_visits', col: 'day', kind: 'day', keepDays: LOG_DAYS, extra: 'NOT EXISTS (SELECT 1 FROM visits v WHERE v.day = league_visits.day AND v.vid = league_visits.vid AND v.human = 1)', why: 'league opens by bots (never counted)' },
  { table: 'crawler_day', col: 'day', kind: 'day', keepDays: LOG_DAYS, why: 'search-engine checks per day' },
  { table: 'who_day', col: 'day', kind: 'day', keepDays: LOG_DAYS, why: 'proxy / scraper networks per day' },
  { table: 'af_usage_ua', col: 'day', kind: 'day', keepDays: LOG_DAYS, why: 'requests per user-agent per day' },
  { table: 'client_errors', col: 'last_at', kind: 'iso', keepDays: LOG_DAYS, why: 'browser errors' },
  // ---------- perf / admin logs ----------
  { table: 'worker_exits', col: 'at', kind: 'ms', keepDays: LOG_DAYS, why: 'worker restarts' },
  { table: 'reader_hours', col: 'hour', kind: 'iso', keepDays: LOG_DAYS, why: 'slow reads per hour (fix249)' },
  { table: 'admin_alert_once', col: 'day', kind: 'day', keepDays: LOG_DAYS, why: 'once-a-day alert marks' },
  { table: 'admin_auto_fixes', col: 'at', kind: 'iso', keepDays: LOG_DAYS, extra: 'summary_day IS NOT NULL', why: 'auto-fix notes already in a 07:00 summary' },
  { table: 'data_audit', col: 'at', kind: 'iso', keepDays: LOG_DAYS, keepLatest: true, why: 'data audit runs (the last one kept)' },
  { table: 'deploy_errors', col: 'started_at', kind: 'iso', keepDays: LOG_DAYS, keepLatest: true, why: 'errors after each start' },
  // ---------- copies ----------
  { table: 'route_cache', col: 'at', kind: 'ms', keepDays: 2, slice: 200, why: 'signed-out copies of worker routes (2 days, as before; now in slices)' }
];

export const SLICE = 2000;

/** the cutoff value for a rule's column at `now` (rows strictly older are deleted) */
export function cutoffOf(rule: Rule, now = Date.now()): string | number {
  const t = now - rule.keepDays * 86400000;
  switch (rule.kind) {
    case 'ms': return t;
    case 'minute': return Math.floor(t / 60000);
    case 'day': return new Date(t).toISOString().slice(0, 10);
    default: return new Date(t).toISOString();
  }
}

/** one slice's DELETE (rowid tables only) */
export function sliceSql(rule: Rule, slice = SLICE): string {
  const t = rule.table;
  const latest = rule.keepLatest ? ` AND rowid <> (SELECT rowid FROM ${t} ORDER BY ${rule.col} DESC LIMIT 1)` : '';
  return `DELETE FROM ${t} WHERE rowid IN (SELECT rowid FROM ${t} WHERE ${rule.col} < ?${rule.extra ? ` AND (${rule.extra})` : ''}${latest} LIMIT ${slice})`;
}

type Db = { prepare(sql: string): { run(...a: any[]): { changes: number | bigint }; get(...a: any[]): any } };
export type RetentionResult = { table: string; deleted: number; ms: number; done: boolean; error?: string };

/**
 * Delete what every rule allows, SLICE rows a statement, `pause()` between slices (the worker yields to its event
 * loop), at most `budgetMs` in all (the next run carries on). A table that does not exist (yet) is skipped.
 */
export async function runRetention(db: Db, opts: { now?: number; rules?: Rule[]; slice?: number; budgetMs?: number; pause?: () => Promise<void> } = {}): Promise<RetentionResult[]> {
  const now = opts.now ?? Date.now(), rules = opts.rules ?? RULES, slice = opts.slice ?? SLICE, budget = opts.budgetMs ?? 60_000;
  const pause = opts.pause ?? (() => new Promise<void>(r => setImmediate(r)));
  const t0 = Date.now();
  const out: RetentionResult[] = [];
  for (const rule of rules) {
    if (PROTECTED.has(rule.table)) throw new Error(`retention rule on a protected table: ${rule.table}`);
    const r0 = Date.now();
    const res: RetentionResult = { table: rule.table, deleted: 0, ms: 0, done: false };
    out.push(res);
    if (!db.prepare(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?`).get(rule.table)) { res.done = true; continue; }
    try {
      const size = Math.min(slice, rule.slice ?? slice);
      const st = db.prepare(sliceSql(rule, size));
      const cut = cutoffOf(rule, now);
      for (;;) {
        const n = Number(st.run(cut).changes);
        res.deleted += n;
        if (n < size) { res.done = true; break; }
        if (Date.now() - t0 > budget) break;
        await pause();
      }
    } catch (e: any) { res.error = String(e?.message || e); }
    res.ms = Date.now() - r0;
    if (Date.now() - t0 > budget) break;
    await pause();
  }
  return out;
}
