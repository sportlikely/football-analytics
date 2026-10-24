/**
 * Staff activity log (Oct 2026): what every staff member did in the CRM and the Users area — replies, notes, plan
 * changes, password-reset emails, sign-outs, campaigns, team and role changes, tester links, backups — and which
 * customer profiles they opened. Recorded automatically for every successful staff action (middleware in index.ts),
 * so a new CRM feature is logged without extra code. Kept 1 year. No IP addresses here (those stay in the security log).
 * Passwords and message texts are never stored.
 */
import { db } from '../db';
import { isWeb as isWebProc } from './role';
import { userById } from './auth';
import { every } from './perf';

db.exec(`
  CREATE TABLE IF NOT EXISTS staff_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, staff_id INTEGER NOT NULL, staff_email TEXT, role TEXT,
    action TEXT NOT NULL, label TEXT NOT NULL, target_user INTEGER, target TEXT, detail TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_staff_activity_at ON staff_activity(at);
  CREATE INDEX IF NOT EXISTS idx_staff_activity_staff ON staff_activity(staff_id);
  CREATE INDEX IF NOT EXISTS idx_staff_activity_target ON staff_activity(target_user);
`);

type Req = { method: string; originalUrl: string; body?: any; params?: any; query?: any; user?: any; staff?: string | null };
interface Rule {
  m: string; re: RegExp; action: string; label: string;
  /** customer this is about (user id) */
  user?: (x: RegExpMatchArray, b: any) => number | null;
  /** short text about the target (message #, role, email) */
  target?: (x: RegExpMatchArray, b: any) => string | null;
  /** safe summary of what changed (never passwords / message text) */
  detail?: (x: RegExpMatchArray, b: any) => string | null;
}
const num = (v: any) => { const n = parseInt(String(v), 10); return Number.isFinite(n) ? n : null; };
const emailOf = (id: number | null) => (id ? userById(id)?.email || `account #${id}` : null);
const msgOwner = (id: number) => {
  try { return (db.prepare('SELECT user_id FROM contact_messages WHERE id = ?').get(id) as any)?.user_id ?? null; } catch { return null; }
};
const userByEmail = (e: any) => {
  try { return (db.prepare('SELECT id FROM users WHERE email = ?').get(String(e || '').trim().toLowerCase()) as any)?.id ?? null; } catch { return null; }
};

const RULES: Rule[] = [
  // support inbox
  { m: 'GET', re: /^\/api\/crm\/inbox\/(\d+)$/, action: 'inbox_open', label: 'Opened a support message', target: x => `message #${x[1]}`, user: x => msgOwner(+x[1]) },
  { m: 'POST', re: /^\/api\/crm\/inbox\/(\d+)\/reply$/, action: 'inbox_reply', label: 'Replied to a customer', target: x => `message #${x[1]}`, user: x => msgOwner(+x[1]), detail: (_x, b) => (b?.close ? 'and closed it' : null) },
  { m: 'POST', re: /^\/api\/crm\/inbox\/(\d+)\/note$/, action: 'inbox_note', label: 'Wrote an internal note', target: x => `message #${x[1]}`, user: x => msgOwner(+x[1]) },
  { m: 'POST', re: /^\/api\/crm\/inbox\/(\d+)\/status$/, action: 'inbox_status', label: 'Changed message status', target: x => `message #${x[1]}`, user: x => msgOwner(+x[1]), detail: (_x, b) => (b?.status ? `→ ${String(b.status).slice(0, 20)}` : null) },
  { m: 'POST', re: /^\/api\/crm\/inbox\/(\d+)\/assign$/, action: 'inbox_assign', label: 'Assigned a message', target: x => `message #${x[1]}`, user: x => msgOwner(+x[1]), detail: (_x, b) => (b?.to == null ? '→ unassigned' : `→ ${emailOf(num(b.to))}`) },
  // customers
  { m: 'GET', re: /^\/api\/crm\/customers\/(\d+)$/, action: 'customer_open', label: 'Opened a customer profile', user: x => +x[1] },
  { m: 'POST', re: /^\/api\/crm\/customers\/(\d+)\/plan$/, action: 'customer_plan', label: 'Changed a customer’s plan', user: x => +x[1], detail: (_x, b) => `→ ${['premium', 'pro'].includes(b?.plan) ? `${b.plan}, ${num(b?.days) ?? 30} days` : 'free'}` },
  { m: 'POST', re: /^\/api\/crm\/customers\/(\d+)\/reset-email$/, action: 'customer_reset_email', label: 'Sent a password-reset email', user: x => +x[1] },
  { m: 'POST', re: /^\/api\/crm\/customers\/(\d+)\/sign-out$/, action: 'customer_sign_out', label: 'Signed a customer out everywhere', user: x => +x[1] },
  // campaigns
  { m: 'POST', re: /^\/api\/crm\/campaigns\/test$/, action: 'campaign_test', label: 'Sent a test campaign email', detail: (_x, b) => (b?.subject ? `“${String(b.subject).slice(0, 80)}”` : null) },
  { m: 'POST', re: /^\/api\/crm\/campaigns$/, action: 'campaign_send', label: 'Sent an email campaign', detail: (_x, b) => (b?.subject ? `“${String(b.subject).slice(0, 80)}”` : null) },
  // testers
  { m: 'POST', re: /^\/api\/crm\/testers\/invite$/, action: 'tester_invite', label: 'Created a tester invite link', detail: (_x, b) => [b?.label, b?.days ? `${num(b.days)} days` : null, b?.maxUses ? `max ${num(b.maxUses)}` : null].filter(Boolean).join(' · ') || null },
  { m: 'POST', re: /^\/api\/crm\/testers\/invite\/([A-Za-z0-9]+)$/, action: 'tester_invite_toggle', label: 'Opened / closed a tester link', target: x => x[1], detail: (_x, b) => (b?.open ? 'opened' : 'closed') },
  // team
  { m: 'POST', re: /^\/api\/crm\/team\/member$/, action: 'team_member', label: 'Changed the team', user: (_x, b) => userByEmail(b?.email), target: (_x, b) => String(b?.email || '').slice(0, 120), detail: (_x, b) => (b?.role ? `role → ${String(b.role).slice(0, 40)}` : 'removed from the team') },
  { m: 'POST', re: /^\/api\/crm\/team\/console$/, action: 'team_console', label: 'Set a console login', user: (_x, b) => num(b?.userId), target: (_x, b) => emailOf(num(b?.userId)), detail: (_x, b) => [b?.username ? `username ${String(b.username).slice(0, 40)}` : null, b?.password ? 'new password' : null].filter(Boolean).join(' · ') || null },
  { m: 'POST', re: /^\/api\/crm\/team\/roles$/, action: 'role_create', label: 'Created a role', target: (_x, b) => String(b?.name || '').slice(0, 40) },
  { m: 'POST', re: /^\/api\/crm\/team\/roles\/([a-z0-9_]+)$/, action: 'role_edit', label: 'Edited a role', target: x => x[1], detail: (_x, b) => (Array.isArray(b?.perms) ? `permissions: ${b.perms.join(', ') || 'none'}` : b?.name ? `renamed → ${String(b.name).slice(0, 40)}` : null) },
  { m: 'DELETE', re: /^\/api\/crm\/team\/roles\/([a-z0-9_]+)$/, action: 'role_delete', label: 'Deleted a role', target: x => x[1] },
  { m: 'POST', re: /^\/api\/crm\/team\/sudo$/, action: 'team_unlock', label: 'Unlocked team changes (two-step code)' },
  // console
  { m: 'POST', re: /^\/api\/crm\/console\/login$/, action: 'console_login', label: 'Signed in to the staff console' },
  { m: 'POST', re: /^\/api\/crm\/console\/lock$/, action: 'console_lock', label: 'Locked the staff console' },
  // Users area (admin)
  { m: 'GET', re: /^\/api\/admin\/users\.csv$/, action: 'users_export', label: 'Exported the users list (CSV)' },
  { m: 'POST', re: /^\/api\/admin\/users\/(\d+)\/plan$/, action: 'customer_plan', label: 'Changed a customer’s plan (Users)', user: x => +x[1], detail: (_x, b) => (b?.plan ? `→ ${String(b.plan).slice(0, 20)}` : null) },
  { m: 'POST', re: /^\/api\/admin\/users\/(\d+)\/password$/, action: 'customer_password', label: 'Set a customer’s account password', user: x => +x[1] },
  { m: 'POST', re: /^\/api\/admin\/contact\/(\d+)$/, action: 'inbox_status', label: 'Marked a contact message', target: x => `message #${x[1]}`, user: x => msgOwner(+x[1]) },
  { m: 'POST', re: /^\/api\/admin\/bb\/game\/(\d+)\/result$/, action: 'bb_result', label: 'Corrected a basketball result', target: x => `game ${x[1]}`, detail: (_x, b) => [b?.action, b?.hs != null ? `${num(b.hs)}-${num(b.as_)}` : null].filter(Boolean).join(' ') || null },
  { m: 'POST', re: /^\/api\/admin\/backups\/run$/, action: 'backup_run', label: 'Started a database backup' },
  { m: 'GET', re: /^\/api\/admin\/backups\/download\/(.+)$/, action: 'backup_download', label: 'Downloaded a database backup', target: x => decodeURIComponent(x[1]).slice(0, 80) }
];

const ins = db.prepare('INSERT INTO staff_activity (at, staff_id, staff_email, role, action, label, target_user, target, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');

/** Called after a successful staff request. Unknown changes (POST/DELETE) are still recorded with their path. */
export function recordActivity(req: Req) {
  try {
    if (!req.user || !req.staff) return;
    const p = req.originalUrl.split('?')[0];
    const rule = RULES.find(r => r.m === req.method && r.re.test(p));
    if (!rule && req.method === 'GET') return;
    if (!rule && /^\/api\/crm\/console\/(status|setup|change|reset)$/.test(p)) return; // own console housekeeping (security log has it)
    const x = rule ? p.match(rule.re)! : ([] as unknown as RegExpMatchArray);
    const b = req.body || {};
    ins.run(new Date().toISOString(), req.user.id, req.user.email || null, req.staff,
      rule?.action || 'other', rule?.label || `${req.method} ${p}`.slice(0, 120),
      rule?.user ? rule.user(x, b) : null, rule?.target ? rule.target(x, b) : null, rule?.detail ? rule.detail(x, b) : null);
  } catch { /* logging never breaks a request */ }
}

export function activityList(o: { staffId?: number | null; userId?: number | null; action?: string | null; limit?: number }) {
  const where: string[] = [];
  const args: any[] = [];
  if (o.staffId) { where.push('a.staff_id = ?'); args.push(o.staffId); }
  if (o.userId) { where.push('a.target_user = ?'); args.push(o.userId); }
  if (o.action) { where.push('a.action LIKE ?'); args.push(`${o.action}%`); }
  const rows = db.prepare(`
    SELECT a.*, u.email AS target_email FROM staff_activity a LEFT JOIN users u ON u.id = a.target_user
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.id DESC LIMIT ?`).all(...args, Math.min(1000, o.limit || 300)) as any[];
  const staff = db.prepare(`SELECT staff_id AS id, MAX(staff_email) AS email, COUNT(*) AS n, MAX(at) AS last FROM staff_activity GROUP BY staff_id ORDER BY last DESC`).all();
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const week = db.prepare(`SELECT action, COUNT(*) AS n FROM staff_activity WHERE at >= ? GROUP BY action`).all(since);
  return {
    staff, week,
    rows: rows.map(r => ({ id: r.id, at: r.at, staffId: r.staff_id, staffEmail: r.staff_email, role: r.role, action: r.action, label: r.label, targetUser: r.target_user, targetEmail: r.target_email || null, target: r.target, detail: r.detail }))
  };
}

// fix210b: the database cleanups run in the worker only (the web process writes nothing)
if (!isWebProc) every('activity flush', () => {
  try { db.prepare('DELETE FROM staff_activity WHERE at < ?').run(new Date(Date.now() - 365 * 86400000).toISOString()); } catch { /* ignore */ }
}, 12 * 3600000).unref();
