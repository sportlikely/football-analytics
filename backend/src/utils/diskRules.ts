/**
 * fix249: the "Disk" data-health verdict (services/dbSpace.ts): volume free %, database size and its 7-day growth,
 * and how many days until the growth would fill the volume. Pure (scripts/fix249.test.ts).
 */
export type DiskInput = { volFree: number | null; volTotal: number | null; dbBytes: number; walBytes: number; growth7d: number | null };
export type DiskVerdict = { level: 'ok' | 'warn' | 'fail'; freePct: number | null; perDay: number | null; daysToFull: number | null; reasons: string[] };

export const DISK_RULES = { warnDays: 30, failDays: 7, warnFreePct: 20, failFreePct: 10, walWarnBytes: 512 * 1048576 };

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

export function diskVerdict(x: DiskInput): DiskVerdict {
  const reasons: string[] = [];
  const freePct = x.volFree != null && x.volTotal ? (x.volFree / x.volTotal) * 100 : null;
  const perDay = x.growth7d != null ? x.growth7d / 7 : null;
  const daysToFull = perDay != null && perDay > 0 && x.volFree != null ? x.volFree / perDay : null;
  let level: DiskVerdict['level'] = 'ok';
  const raise = (l: 'warn' | 'fail', why: string) => { reasons.push(why); if (l === 'fail' || level === 'ok') level = l; };
  if (freePct != null && freePct < DISK_RULES.failFreePct) raise('fail', `volume ${freePct.toFixed(0)}% free (under ${DISK_RULES.failFreePct}%)`);
  else if (freePct != null && freePct < DISK_RULES.warnFreePct) raise('warn', `volume ${freePct.toFixed(0)}% free (under ${DISK_RULES.warnFreePct}%)`);
  if (daysToFull != null && daysToFull < DISK_RULES.failDays) raise('fail', `at this growth the volume is full in ${Math.floor(daysToFull)} day(s)`);
  else if (daysToFull != null && daysToFull < DISK_RULES.warnDays) raise('warn', `at this growth the volume is full in ${Math.floor(daysToFull)} days (under ${DISK_RULES.warnDays})`);
  if (x.walBytes > DISK_RULES.walWarnBytes) raise('warn', `the WAL file is ${(x.walBytes / 1048576).toFixed(0)} MB (checkpoints are not catching up)`);
  return { level, freePct, perDay, daysToFull, reasons };
}
