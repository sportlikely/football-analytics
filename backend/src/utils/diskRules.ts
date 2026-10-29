/**
 * fix249: the "Disk" data-health verdict (services/dbSpace.ts): volume free %, database size and its 7-day growth,
 * and how many days until the growth would fill the volume. Pure (scripts/fix249.test.ts, fix272.test.ts).
 * fix272: + the growth of the last 6 hours (red when the volume would fill within 3 days at that rate), how long a
 * TRUNCATE checkpoint waits for old readers, and when the size report runs again on its own.
 */
/** fix273: `truncateAgeMs` = how long since the WAL last started over (TRUNCATE done), null = not known yet (first hour) */
export type DiskInput = { volFree: number | null; volTotal: number | null; dbBytes: number; walBytes: number; growth7d: number | null; perDay6h?: number | null; truncateAgeMs?: number | null };
export type DiskVerdict = { level: 'ok' | 'warn' | 'fail'; freePct: number | null; perDay: number | null; daysToFull: number | null; daysToFull6h: number | null; reasons: string[] };

export const DISK_RULES = { warnDays: 30, failDays: 7, fail6hDays: 3, warnFreePct: 20, failFreePct: 10, walWarnBytes: 64 * 1048576, walFailBytes: 256 * 1048576, truncateFailMs: 3600 * 1000 };
// fix273: red over 256 MB (Yarin, 29 Oct: 2,350 MB with "blocked by a reader (8 in a row)") or with no TRUNCATE done
// in an hour; fix276: under that plain ok (the 64 MB journal_size_limit is the TRUNCATE trigger, not a warning)

/** size history rows (day, total bytes = file + WAL) → bytes per day over the last 7 days (null under 2 days of rows) */
export function growthPerDay(rows: { day: string; bytes: number }[], today: string): number | null {
  const sorted = rows.filter(r => r.day <= today).sort((a, b) => a.day.localeCompare(b.day));
  if (sorted.length < 2) return null;
  const last = sorted[sorted.length - 1];
  const from = new Date(Date.parse(`${last.day}T00:00:00Z`) - 7 * 86400000).toISOString().slice(0, 10);
  const first = sorted.find(r => r.day >= from) || sorted[0];
  const days = (Date.parse(`${last.day}T00:00:00Z`) - Date.parse(`${first.day}T00:00:00Z`)) / 86400000;
  return days > 0 ? (last.bytes - first.bytes) / days : null;
}

/**
 * fix272: growth over the last `hours` from the 10-minute size rows (at = ISO time, bytes = file + WAL) up to `now`:
 * { bytes grown, per day, hours covered } from the oldest row inside the window; null under an hour of rows
 */
export function growthOver(rows: { at: string; bytes: number }[], now: { at: string; bytes: number }, hours = 6): { bytes: number; perDay: number; hours: number } | null {
  const t = Date.parse(now.at), from = t - hours * 3600 * 1000;
  const first = rows.filter(r => Date.parse(r.at) >= from && Date.parse(r.at) < t).sort((a, b) => a.at.localeCompare(b.at))[0];
  if (!first) return null;
  const h = (t - Date.parse(first.at)) / 3600000;
  if (h < 1) return null;
  const bytes = now.bytes - first.bytes;
  return { bytes, perDay: (bytes / h) * 24, hours: h };
}

/**
 * fix272: how long TRUNCATE waits for readers on an old snapshot (writers wait as long) and how many WAL frames PASSIVE
 * may have left for it to copy under the writer lock — longer / more as the WAL grows or keeps failing to start over
 */
export function truncatePlan(walBytes: number, busyStreak: number): { busyMs: number; catchUp: number } {
  const GB = 1073741824;
  const busyMs = walBytes > 3 * GB || busyStreak >= 12 ? 4000 : walBytes > GB || busyStreak >= 6 ? 2000 : walBytes > 256 * 1048576 || busyStreak >= 3 ? 1000 : 300;
  // fix273: after 2 tries that found too much left (29 Oct: "8 in a row", WAL 2,350 MB — a long PASSIVE on the big WAL let
  // more frames in than the gate allowed, so TRUNCATE never even ran), up to 65,536 frames (256 MB) may be copied
  return { busyMs, catchUp: busyStreak >= 2 ? 65536 : walBytes > GB ? 16384 : 4096 };
}

/** fix272: run the dbstat size report again now? (≥ 1 GB grown in 6 h, the last report over 6 h old) */
export function reportDue(grown6h: number | null, lastReportAt: number | null, now: number): boolean {
  return grown6h != null && grown6h >= 1073741824 && (lastReportAt == null || now - lastReportAt > 6 * 3600 * 1000);
}

export function diskVerdict(x: DiskInput): DiskVerdict {
  const reasons: string[] = [];
  const freePct = x.volFree != null && x.volTotal ? (x.volFree / x.volTotal) * 100 : null;
  const perDay = x.growth7d != null ? x.growth7d / 7 : null;
  const daysToFull = perDay != null && perDay > 0 && x.volFree != null ? x.volFree / perDay : null;
  const daysToFull6h = x.perDay6h != null && x.perDay6h > 0 && x.volFree != null ? x.volFree / x.perDay6h : null;
  let level: DiskVerdict['level'] = 'ok';
  const raise = (l: 'warn' | 'fail', why: string) => { reasons.push(why); if (l === 'fail' || level === 'ok') level = l; };
  if (freePct != null && freePct < DISK_RULES.failFreePct) raise('fail', `volume ${freePct.toFixed(0)}% free (under ${DISK_RULES.failFreePct}%)`);
  else if (freePct != null && freePct < DISK_RULES.warnFreePct) raise('warn', `volume ${freePct.toFixed(0)}% free (under ${DISK_RULES.warnFreePct}%)`);
  if (daysToFull6h != null && daysToFull6h < DISK_RULES.fail6hDays) raise('fail', `at the last 6 hours' growth the volume is full in ${daysToFull6h < 1 ? `${Math.max(1, Math.floor(daysToFull6h * 24))} hour(s)` : `${Math.floor(daysToFull6h)} day(s)`}`);
  if (daysToFull != null && daysToFull < DISK_RULES.failDays) raise('fail', `at this growth the volume is full in ${Math.floor(daysToFull)} day(s)`);
  else if (daysToFull != null && daysToFull < DISK_RULES.warnDays) raise('warn', `at this growth the volume is full in ${Math.floor(daysToFull)} days (under ${DISK_RULES.warnDays})`);
  // fix276: no yellow over the 64 MB journal limit any more (113 MB on 29 Oct 18:04 with TRUNCATE working = plain ok)
  if (x.walBytes > DISK_RULES.walFailBytes) raise('fail', `the WAL file is ${(x.walBytes / 1048576).toFixed(0)} MB (over ${DISK_RULES.walFailBytes / 1048576} MB: checkpoints are not catching up)`);
  if (x.truncateAgeMs != null && x.truncateAgeMs > DISK_RULES.truncateFailMs) raise('fail', `the WAL has not started over for ${Math.floor(x.truncateAgeMs / 60000)} min (TRUNCATE must succeed at least hourly)`);
  return { level, freePct, perDay, daysToFull, daysToFull6h, reasons };
}
