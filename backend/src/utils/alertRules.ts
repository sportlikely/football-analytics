/**
 * fix279: which data-health checks may email the admin, and when (Yarin, 29 Oct: 24 "Site problem" emails in 2 days).
 *
 *  - Only what a person can act on is emailed: a data feed stopped for 2 h+, the last deploy failed (site down), the
 *    disk filling within 3 days. Every other check (model checks, speed, player pages vs official stats, careers, game
 *    extras, season forecast …) is "quiet": the For Claude list and the 07:00 summary only, never its own email.
 *  - One email per problem: a check that was in an email is not emailed again while it stays red ("still red since …"
 *    in the 07:00 summary); only after 24 h green does a new failure count as a new problem.
 *  - The state lives in the database (services/adminMail.ts: admin_alert_state, admin_mail_limit), so a deploy never
 *    sends again. Pure parts here (test:fix279).
 */

export type AlertClass = 'feed' | 'email' | 'quiet';
export const FEED_RED_MS = 2 * 3600_000;
export const RED_MS = 30 * 60_000;
export const GREEN_RESET_MS = 24 * 3600_000;
export const DATA_ALERT_GAP_MS = 6 * 3600_000;
export const DISK_DAYS = 3;

/** a data feed: emailed once it has been red for 2 h */
const FEED = /^(feed:|fd-moving$|api-football$|live-box$)/;
/** site down / deploy failed, disk filling */
const EMAIL = /^(deploy-errors|disk)$/;

export function alertClass(id: string): AlertClass {
  if (FEED.test(id)) return 'feed';
  if (EMAIL.test(id)) return 'email';
  return 'quiet';
}

type CheckLike = { id: string; label: string; level: string; detail?: string; items?: string[] };

/** the disk check says the volume is full within 3 days ("full in 2 days", "volume full in 20 h") */
export function diskSoon(c: CheckLike): boolean {
  const text = [c.detail || '', ...(c.items || [])].join(' · ');
  for (const m of text.matchAll(/full in (\d+(?:\.\d+)?) (h|days?)/g)) {
    const days = m[2] === 'h' ? Number(m[1]) / 24 : Number(m[1]);
    if (days <= DISK_DAYS) return true;
  }
  return false;
}

export interface AlertRow { id: string; label: string; redSince: number; emailedAt: number | null; greenSince: number | null }

/** one run of a check → its stored row (null = nothing to keep: green with no recent problem) */
export function stepAlert(prev: AlertRow | null, c: CheckLike, now: number): AlertRow | null {
  if (c.level === 'fail') {
    if (!prev) return { id: c.id, label: c.label, redSince: now, emailedAt: null, greenSince: null };
    // green for 24 h before this failure: a new problem (may be emailed again)
    if (prev.greenSince != null && now - prev.greenSince >= GREEN_RESET_MS) return { id: c.id, label: c.label, redSince: now, emailedAt: null, greenSince: null };
    // green for less than that: the same problem coming back
    return { ...prev, label: c.label, greenSince: null };
  }
  if (!prev) return null;
  if (prev.greenSince == null) return { ...prev, greenSince: now };
  return now - prev.greenSince >= GREEN_RESET_MS ? null : prev;
}

/** does this run email this check? (the 6-hour gap between data alerts is the caller's, stored too) */
export function wantsEmail(row: AlertRow | null, c: CheckLike, now: number): boolean {
  if (!row || c.level !== 'fail' || row.emailedAt != null || row.greenSince != null) return false;
  const cls = alertClass(c.id);
  if (cls === 'quiet') return false;
  if (cls === 'feed') return now - row.redSince >= FEED_RED_MS;
  if (now - row.redSince < RED_MS) return false;
  return c.id === 'disk' ? diskSoon(c) : true;
}
