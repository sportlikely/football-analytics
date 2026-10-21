/**
 * Security log (Oct 2026): sign-ins, two-step login and account changes, with the IP address and browser, kept 90 days.
 * Purpose: spot attempts to break into the admin or into users' accounts (legitimate interest: security; stated in the
 * privacy policy). Visitor statistics never use this table.
 * fix199: scraper lines of a data-centre / proxy network are one row per network and day (`grp` = 'AS60068:2026-10-21',
 * updated in place); its addresses are in security_log_ips (same 90 days).
 */
import { db } from '../db';
import { every } from './perf';

db.exec(`
  CREATE TABLE IF NOT EXISTS security_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, user_id INTEGER, email TEXT, event TEXT NOT NULL,
    ip TEXT, ua TEXT, detail TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_security_log_at ON security_log(at);
  CREATE INDEX IF NOT EXISTS idx_security_log_user ON security_log(user_id);
  CREATE TABLE IF NOT EXISTS security_log_ips (
    grp TEXT NOT NULL, ip TEXT NOT NULL, ua TEXT, requests INTEGER NOT NULL DEFAULT 0, refused INTEGER NOT NULL DEFAULT 0,
    first_at TEXT NOT NULL, last_at TEXT NOT NULL, PRIMARY KEY (grp, ip)
  );
`);
{
  const cols = new Set((db.prepare('PRAGMA table_info(security_log)').all() as any[]).map(c => c.name));
  if (!cols.has('grp')) db.exec('ALTER TABLE security_log ADD COLUMN grp TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_security_log_grp ON security_log(grp) WHERE grp IS NOT NULL');
}

const ins = db.prepare(`INSERT INTO security_log (at, user_id, email, event, ip, ua, detail) VALUES (?, ?, ?, ?, ?, ?, ?)`);

export function securityLog(req: { ip?: string; headers: Record<string, any> }, event: string, user?: { id?: number | null; email?: string | null } | null, detail?: string) {
  try {
    ins.run(new Date().toISOString(), user?.id ?? null, user?.email ? String(user.email).toLowerCase().slice(0, 254) : null, event,
      (req.ip || '').slice(0, 64) || null, String(req.headers?.['user-agent'] || '').slice(0, 200) || null, detail ? detail.slice(0, 300) : null);
  } catch { /* logging never breaks a request */ }
}

/** fix199: one grouped line (a network's day), written once and updated in place. */
const upGroup = db.prepare(`INSERT INTO security_log (at, event, ua, detail, grp) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(grp) WHERE grp IS NOT NULL DO UPDATE SET ua = excluded.ua, detail = excluded.detail`);
export function securityLogGroup(grp: string, event: string, detail: string, ua?: string | null) {
  try { upGroup.run(new Date().toISOString(), event, ua ? ua.slice(0, 200) : null, detail.slice(0, 300), grp); } catch { /* never breaks a request */ }
}
const upIp = db.prepare(`INSERT INTO security_log_ips (grp, ip, ua, requests, refused, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(grp, ip) DO UPDATE SET requests = requests + excluded.requests, refused = refused + excluded.refused, last_at = excluded.last_at, ua = COALESCE(excluded.ua, ua)`);
/** fix199: an address of a grouped line (requests / refused added since the last write). */
export function securityLogIp(grp: string, ip: string, ua: string | null, requests: number, refused: number) {
  try { const iso = new Date().toISOString(); upIp.run(grp, ip.slice(0, 64), ua ? ua.slice(0, 200) : null, requests, refused, iso, iso); } catch { /* ignore */ }
}

export function securityLogList(limit = 200, userId?: number) {
  const rows = userId
    ? db.prepare(`SELECT * FROM security_log WHERE user_id = ? ORDER BY id DESC LIMIT ?`).all(userId, limit)
    : db.prepare(`SELECT * FROM security_log ORDER BY id DESC LIMIT ?`).all(limit);
  const since = new Date(Date.now() - 86400000).toISOString();
  const failed24h = (db.prepare(`SELECT COUNT(*) AS n FROM security_log WHERE at >= ? AND event IN ('login_fail', '2fa_fail')`).get(since) as any).n;
  const ipsOf = db.prepare(`SELECT ip, ua, requests, refused, first_at AS firstAt, last_at AS lastAt FROM security_log_ips WHERE grp = ? ORDER BY requests DESC LIMIT 200`);
  return {
    failed24h,
    rows: (rows as any[]).map(r => ({
      id: r.id, at: r.at, userId: r.user_id, email: r.email, event: r.event, ip: r.ip, ua: r.ua, detail: r.detail,
      ...(r.grp ? { grp: r.grp, addresses: ipsOf.all(r.grp) } : {})
    }))
  };
}

/** A user's own sign-in history (for the account page later / data export). */
export function securityLogFor(userId: number) {
  return db.prepare(`SELECT at, event, ip, ua FROM security_log WHERE user_id = ? ORDER BY id DESC LIMIT 200`).all(userId);
}

every('security log cleanup', () => {
  try {
    const old = new Date(Date.now() - 90 * 86400000).toISOString();
    db.prepare(`DELETE FROM security_log WHERE at < ?`).run(old);
    db.prepare(`DELETE FROM security_log_ips WHERE last_at < ?`).run(old);
  } catch { /* ignore */ }
}, 6 * 3600000).unref();
