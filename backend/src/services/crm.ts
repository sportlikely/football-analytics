/**
 * CRM inside the site (Oct 2026): support inbox, segments + email campaigns, revenue & churn.
 *
 * Who can use what (checked in index.ts with staffOf):
 *   inbox      – admin and support staff (support = role set by an admin + two-step login)
 *   campaigns  – admin only
 *   revenue    – admin only
 *
 * Inbox: contact_messages are the threads. Replies go out by email from support@ (Resend, the domain is verified) with
 * the thread number in the subject; the customer's answer arrives in the support@ Gmail inbox (no inbound webhook yet).
 * Internal notes stay in the site. Status: open → waiting (we replied) → closed.
 *
 * Campaigns: only to accounts with the "Product news" switch on (email_prefs.news = 1, fix218; before: "email updates",
 * users.marketing_opt_in) and a confirmed email. Every
 * email carries a one-click unsubscribe link (HMAC-signed, no login) and List-Unsubscribe headers. Sent in the
 * background, about 2 per second (Resend limit), each recipient recorded.
 */
import crypto from 'crypto';
import { db } from '../db';
import { trustOf } from './signupGuard';
import logger from '../utils/logger';
import { saveEmailPrefs } from './pickEmails';
import { sendMail, emailEnabled, layout, esc, SITE } from './email';
import { PLANS } from './billing';

export class CrmError extends Error { constructor(public status: number, msg: string) { super(msg); } }
const SUPPORT_FROM = process.env.SUPPORT_FROM || 'SportLikely Support <support@sportlikely.com>';
const SUPPORT_ADDR = 'support@sportlikely.com';

{
  const cols = new Set((db.prepare('PRAGMA table_info(contact_messages)').all() as any[]).map(c => c.name));
  if (!cols.has('status')) {
    db.exec(`ALTER TABLE contact_messages ADD COLUMN status TEXT NOT NULL DEFAULT 'open'`);
    db.exec(`UPDATE contact_messages SET status = 'closed' WHERE handled = 1`);
  }
  if (!cols.has('updated_at')) db.exec(`ALTER TABLE contact_messages ADD COLUMN updated_at TEXT`);
  if (!cols.has('assigned_to')) db.exec(`ALTER TABLE contact_messages ADD COLUMN assigned_to INTEGER`);
}
db.exec(`
  CREATE TABLE IF NOT EXISTS support_replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL, at TEXT NOT NULL, by_user INTEGER, by_name TEXT,
    kind TEXT NOT NULL, body TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_support_replies_msg ON support_replies(message_id);
  CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, by_user INTEGER, subject TEXT NOT NULL, body TEXT NOT NULL,
    segment TEXT NOT NULL, total INTEGER NOT NULL DEFAULT 0, sent INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'sending', finished_at TEXT
  );
  CREATE TABLE IF NOT EXISTS campaign_recipients (
    campaign_id INTEGER NOT NULL, user_id INTEGER NOT NULL, email TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', at TEXT,
    PRIMARY KEY (campaign_id, user_id)
  );
`);

const now = () => new Date().toISOString();
const STATUSES = ['open', 'waiting', 'closed'] as const;
type Status = (typeof STATUSES)[number];

/* ================================================================== */
/* Support inbox                                                      */
/* ================================================================== */

/** Who is looking: their id and whether they may see everyone's messages (inbox.manage). */
export interface Viewer { id: number; manage: boolean }
const visible = (v: Viewer) => (v.manage ? '1 = 1' : `(m.assigned_to IS NULL OR m.assigned_to = ${Number(v.id)})`);

export function inboxList(status: string | null, v: Viewer = { id: 0, manage: true }) {
  const where = `WHERE ${visible(v)}${STATUSES.includes(status as Status) ? ` AND m.status = ?` : ''}`;
  const rows = db.prepare(`
    SELECT m.id, m.at, m.updated_at AS updatedAt, m.user_id AS userId, m.name, m.email, m.topic, m.message, m.status, m.sent,
           (SELECT COUNT(*) FROM support_replies r WHERE r.message_id = m.id AND r.kind = 'reply') AS replies,
           u.plan, m.assigned_to AS assignedTo, (SELECT COALESCE(a.name, a.email) FROM users a WHERE a.id = m.assigned_to) AS assignedName
    FROM contact_messages m LEFT JOIN users u ON u.id = m.user_id
    ${where} ORDER BY COALESCE(m.updated_at, m.at) DESC LIMIT 200
  `).all(...(STATUSES.includes(status as Status) ? [status] : [])) as any[];
  const counts = Object.fromEntries((db.prepare(`SELECT status, COUNT(*) AS n FROM contact_messages m WHERE ${visible(v)} GROUP BY status`).all() as any[]).map(r => [r.status, r.n]));
  return { counts: { open: counts.open || 0, waiting: counts.waiting || 0, closed: counts.closed || 0 }, rows: rows.map(r => ({ ...r, preview: String(r.message).slice(0, 160), message: undefined, sent: !!r.sent })) };
}

/** The message if this viewer may open it (404 otherwise, so ids can't be probed). */
export function canOpen(id: number, v: Viewer): any {
  const m = db.prepare(`SELECT * FROM contact_messages WHERE id = ?`).get(id) as any;
  if (!m || (!v.manage && m.assigned_to && m.assigned_to !== v.id)) throw new CrmError(404, 'Message not found.');
  return m;
}

export function inboxThread(id: number, v: Viewer = { id: 0, manage: true }) {
  const m = canOpen(id, v);
  const replies = db.prepare(`SELECT id, at, by_name AS byName, kind, body, sent FROM support_replies WHERE message_id = ? ORDER BY id`).all(id) as any[];
  const acct = m.user_id ? db.prepare(`SELECT id, email, plan, premium_until, created_at, last_login_at, cancel_at FROM users WHERE id = ?`).get(m.user_id) as any : null;
  const others = db.prepare(`SELECT id, at, topic, status FROM contact_messages WHERE email = ? AND id != ? ORDER BY id DESC LIMIT 10`).all(m.email, id);
  return {
    message: { id: m.id, at: m.at, name: m.name, email: m.email, topic: m.topic, message: m.message, page: m.page, status: m.status, sent: !!m.sent, userId: m.user_id, assignedTo: m.assigned_to || null },
    replies: replies.map(r => ({ ...r, sent: !!r.sent })),
    account: acct && { id: acct.id, plan: acct.plan, premiumUntil: acct.premium_until, createdAt: acct.created_at, lastLoginAt: acct.last_login_at, cancelAt: acct.cancel_at },
    others
  };
}

export function setStatus(id: number, status: unknown) {
  if (!STATUSES.includes(status as Status)) throw new CrmError(400, 'Unknown status.');
  const r = db.prepare(`UPDATE contact_messages SET status = ?, handled = ?, updated_at = ? WHERE id = ?`).run(status, status === 'closed' ? 1 : 0, now(), id);
  if (!Number(r.changes)) throw new CrmError(404, 'Message not found.');
}

export function addNote(id: number, by: { id: number; name: string }, body: unknown) {
  const text = String(body || '').trim().slice(0, 5000);
  if (text.length < 2) throw new CrmError(400, 'Write a note first.');
  if (!db.prepare(`SELECT 1 FROM contact_messages WHERE id = ?`).get(id)) throw new CrmError(404, 'Message not found.');
  db.prepare(`INSERT INTO support_replies (message_id, at, by_user, by_name, kind, body, sent) VALUES (?, ?, ?, ?, 'note', ?, 0)`).run(id, now(), by.id, by.name, text);
  db.prepare(`UPDATE contact_messages SET updated_at = ? WHERE id = ?`).run(now(), id);
}

/** Reply by email from support@ (subject keeps the thread number), then status → waiting. */
export async function reply(id: number, by: { id: number; name: string }, body: unknown, close = false) {
  const text = String(body || '').replace(/\r/g, '').trim().slice(0, 10000);
  if (text.length < 2) throw new CrmError(400, 'Write a reply first.');
  const m = db.prepare(`SELECT * FROM contact_messages WHERE id = ?`).get(id) as any;
  if (!m) throw new CrmError(404, 'Message not found.');
  if (!emailEnabled) throw new CrmError(503, 'Email is not configured on the server.');
  const quoted = String(m.message).split('\n').map((l: string) => `> ${l}`).join('\n');
  const html = layout({
    preheader: text.slice(0, 120), label: `Support · #${id}`,
    body: `<tr><td style="padding:16px 28px 8px;font-size:15px;line-height:1.6;white-space:pre-wrap">${esc(text)}</td></tr>
      <tr><td style="padding:8px 28px 24px"><div style="border-left:3px solid #e2e5ea;padding:4px 0 4px 12px;color:#969da8;font-size:13px;white-space:pre-wrap">${esc(String(m.message).slice(0, 2000))}</div></td></tr>`,
    footer: 'Reply to this email to continue the conversation.'
  });
  const plain = `${text}\n\n— SportLikely Support\n\nYour message:\n${quoted.slice(0, 2000)}\n`;
  db.prepare(`INSERT INTO support_replies (message_id, at, by_user, by_name, kind, body, sent) VALUES (?, ?, ?, ?, 'reply', ?, 0)`).run(id, now(), by.id, by.name, text);
  const rid = Number((db.prepare(`SELECT last_insert_rowid() AS id`).get() as any).id);
  try {
    await sendMail({ to: m.email, subject: `Re: your message to SportLikely [#${id}]`, html, text: plain, from: SUPPORT_FROM, replyTo: SUPPORT_ADDR });
    db.prepare(`UPDATE support_replies SET sent = 1 WHERE id = ?`).run(rid);
  } catch (e: any) {
    logger.warn('Support reply not sent', { id, message: e?.message });
    throw new CrmError(502, 'The reply was saved but the email could not be sent. Try again in a minute.');
  }
  db.prepare(`UPDATE contact_messages SET status = ?, handled = ?, updated_at = ? WHERE id = ?`).run(close ? 'closed' : 'waiting', close ? 1 : 0, now(), id);
}

/** Assign a message: managers to anyone with inbox access; others may only take an unassigned one for themselves. */
export function assign(id: number, to: number | null, v: Viewer, staffIds: Set<number>) {
  const m = canOpen(id, v);
  if (!v.manage) {
    if (to !== v.id || (m.assigned_to && m.assigned_to !== v.id)) throw new CrmError(403, 'Only a manager can assign messages to others.');
  }
  if (to !== null && !staffIds.has(to)) throw new CrmError(400, 'That person has no inbox access.');
  db.prepare(`UPDATE contact_messages SET assigned_to = ?, updated_at = ? WHERE id = ?`).run(to, now(), id);
}

/* ================================================================== */
/* Customers                                                          */
/* ================================================================== */

/** fix168: trust = Real / Unsure / Bot (signupGuard.trustOf); with a trust filter the newest 1,000 accounts are graded and 50 shown. */
export function searchCustomers(q: unknown, trustIn?: unknown) {
  const term = String(q || '').trim().toLowerCase().slice(0, 100);
  const want = ['real', 'unsure', 'bot'].includes(String(trustIn)) ? String(trustIn) : null;
  const lim = want ? 1000 : 50;
  const rows = term
    ? db.prepare(`SELECT id, email, name, plan, premium_until, created_at, last_login_at, cancel_at, email_verified FROM users WHERE lower(email) LIKE ? OR lower(COALESCE(name, '')) LIKE ? ORDER BY last_login_at DESC LIMIT ?`).all(`%${term}%`, `%${term}%`, lim)
    : db.prepare(`SELECT id, email, name, plan, premium_until, created_at, last_login_at, cancel_at, email_verified FROM users ORDER BY created_at DESC LIMIT ?`).all(lim);
  const nowIso = now();
  const graded = (rows as any[]).map(r => ({ r, t: trustOf(r) })).filter(x => !want || x.t.trust === want).slice(0, 50);
  return graded.map(({ r, t }) => ({
    trust: t.trust, trustReasons: t.reasons,
    id: r.id, email: r.email, name: r.name || null,
    plan: (r.plan === 'premium' || r.plan === 'pro') && (!r.premium_until || r.premium_until > nowIso) ? r.plan : 'free',
    premiumUntil: r.premium_until || null, createdAt: r.created_at, lastLoginAt: r.last_login_at || null, cancelAt: r.cancel_at || null, emailVerified: !!r.email_verified
  }));
}

export function customerProfile(id: number, withSecurity: boolean) {
  const r = db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as any;
  if (!r) throw new CrmError(404, 'Account not found.');
  const nowIso = now();
  const safe = (sql: string, ...a: any[]) => { try { return db.prepare(sql).all(...a); } catch { return []; } };
  const one = (sql: string, ...a: any[]) => { try { return db.prepare(sql).get(...a) as any; } catch { return null; } };
  return {
    id: r.id, email: r.email, name: r.name || null, role: r.role || null,
    plan: (r.plan === 'premium' || r.plan === 'pro') && (!r.premium_until || r.premium_until > nowIso) ? r.plan : 'free',
    premiumUntil: r.premium_until || null, cancelAt: r.cancel_at || null, createdAt: r.created_at, lastLoginAt: r.last_login_at || null,
    emailVerified: !!r.email_verified, emailUpdates: !!r.marketing_opt_in, twoFactor: !!r.totp_secret,
    devices: one(`SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?`, id)?.n ?? 0,
    unlocksThisMonth: one(`SELECT COUNT(*) AS n FROM match_unlocks WHERE user_id = ? AND at >= ?`, id, nowIso.slice(0, 7) + '-01')?.n ?? 0,
    favorites: one(`SELECT COUNT(*) AS n FROM user_favorites WHERE user_id = ?`, id)?.n ?? 0,
    planHistory: safe(`SELECT at, from_plan AS fromPlan, to_plan AS toPlan, until, source FROM plan_events WHERE user_id = ? ORDER BY id DESC LIMIT 20`, id),
    messages: safe(`SELECT id, at, topic, status FROM contact_messages WHERE user_id = ? OR email = ? ORDER BY id DESC LIMIT 20`, id, r.email),
    security: withSecurity ? safe(`SELECT at, event, ip, ua FROM security_log WHERE user_id = ? ORDER BY id DESC LIMIT 30`, id) : null
  };
}

export function signOutEverywhere(id: number) {
  const r = db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(id);
  return Number(r.changes) || 0;
}

/* ================================================================== */
/* Segments + campaigns                                               */
/* ================================================================== */

export interface Segment {
  plans?: string[]; // free / premium / pro (empty = all)
  joinedWithinDays?: number | null;
  activeWithinDays?: number | null; // last sign-in within N days
  inactiveForDays?: number | null; // no sign-in for N days
  includeStaff?: boolean;
}
const ADMIN_EMAILS = new Set((process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean));

function cleanSegment(s: any): Segment {
  const num = (v: any) => (v === null || v === undefined || v === '' ? null : Math.max(1, Math.min(3650, Math.round(Number(v)))) || null);
  return {
    plans: Array.isArray(s?.plans) ? s.plans.filter((p: any) => ['free', 'premium', 'pro'].includes(p)) : [],
    joinedWithinDays: num(s?.joinedWithinDays), activeWithinDays: num(s?.activeWithinDays), inactiveForDays: num(s?.inactiveForDays),
    includeStaff: !!s?.includeStaff
  };
}

const NEWS_ON = `email_verified = 1 AND id IN (SELECT user_id FROM email_prefs WHERE news = 1)`;
/** Accounts in a segment. Only confirmed emails with "Product news" on are ever included. */
export function segmentUsers(segIn: any): { id: number; email: string; name: string | null; plan: string }[] {
  const seg = cleanSegment(segIn);
  const nowIso = new Date().toISOString();
  const rows = db.prepare(`SELECT id, email, name, plan, premium_until, created_at, last_login_at, role FROM users WHERE ${NEWS_ON}`).all() as any[];
  const daysAgo = (d: number) => new Date(Date.now() - d * 86400000).toISOString();
  return rows.filter(r => {
    const plan = (r.plan === 'premium' || r.plan === 'pro') && (!r.premium_until || r.premium_until > nowIso) ? r.plan : 'free';
    r.plan = plan;
    if (seg.plans!.length && !seg.plans!.includes(plan)) return false;
    if (!seg.includeStaff && (ADMIN_EMAILS.has(String(r.email).toLowerCase()) || r.role)) return false;
    if (seg.joinedWithinDays && r.created_at < daysAgo(seg.joinedWithinDays)) return false;
    const last = r.last_login_at || r.created_at;
    if (seg.activeWithinDays && last < daysAgo(seg.activeWithinDays)) return false;
    if (seg.inactiveForDays && last >= daysAgo(seg.inactiveForDays)) return false;
    return true;
  }).map(r => ({ id: r.id, email: r.email, name: r.name || null, plan: r.plan }));
}

export function segmentPreview(seg: any) {
  const list = segmentUsers(seg);
  const optedIn = (db.prepare(`SELECT COUNT(*) AS n FROM users WHERE ${NEWS_ON}`).get() as any).n;
  return { count: list.length, optedIn, sample: list.slice(0, 8).map(u => ({ email: u.email.replace(/^(.{2}).*(@.*)$/, '$1•••$2'), plan: u.plan })) };
}

/* unsubscribe links: HMAC of the user id with a key kept in the database */
function unsubKey(): Buffer {
  db.exec(`CREATE TABLE IF NOT EXISTS app_secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  let row = db.prepare(`SELECT value FROM app_secrets WHERE name = 'unsub_key'`).get() as any;
  if (!row) {
    db.prepare(`INSERT OR IGNORE INTO app_secrets (name, value) VALUES ('unsub_key', ?)`).run(crypto.randomBytes(32).toString('hex'));
    row = db.prepare(`SELECT value FROM app_secrets WHERE name = 'unsub_key'`).get();
  }
  return Buffer.from(row.value, 'hex');
}
let UK: Buffer | null = null;
const unsubSig = (userId: number) => crypto.createHmac('sha256', (UK ||= unsubKey())).update(`unsub:${userId}`).digest('base64url').slice(0, 32);
export const unsubscribeUrl = (userId: number) => `${SITE}/api/unsubscribe?u=${userId}&t=${unsubSig(userId)}`;
export function unsubscribe(u: unknown, t: unknown): boolean {
  const id = parseInt(String(u || ''), 10);
  if (!Number.isFinite(id)) return false;
  const want = unsubSig(id), got = String(t || '');
  if (got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) return false;
  db.prepare(`UPDATE users SET marketing_opt_in = 0, marketing_opt_in_at = ? WHERE id = ?`).run(now(), id);
  saveEmailPrefs(id, { news: false }, 'unsubscribe-link'); // fix218
  return true;
}

/** Plain text with blank-line paragraphs, **bold** and links → email HTML. {name} is replaced per person. */
function campaignHtml(body: string, name: string | null, unsubUrl: string) {
  const personal = body.replace(/\{name\}/g, name || 'there');
  const paras = personal.split(/\n{2,}/).map(p =>
    `<p style="margin:0 0 14px">${esc(p).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#10a35a">$1</a>').replace(/\n/g, '<br>')}</p>`).join('');
  return layout({
    preheader: personal.slice(0, 120), label: 'Update',
    body: `<tr><td style="padding:16px 28px 12px;font-size:15px;line-height:1.6">${paras}</td></tr>`,
    footer: `You get this because you asked for SportLikely updates. <a href="${unsubUrl}" style="color:#969da8">Unsubscribe</a> with one click.`
  });
}

export async function sendTest(subject: unknown, body: unknown, to: { id: number; email: string; name: string | null }) {
  const s = String(subject || '').trim().slice(0, 150), b = String(body || '').trim().slice(0, 20000);
  if (s.length < 3 || b.length < 10) throw new CrmError(400, 'Write a subject and a message first.');
  if (!emailEnabled) throw new CrmError(503, 'Email is not configured on the server.');
  const url = unsubscribeUrl(to.id);
  await sendMail({ to: to.email, subject: `[TEST] ${s}`, html: campaignHtml(b, to.name, url), text: `${b.replace(/\{name\}/g, to.name || 'there')}\n\nUnsubscribe: ${url}\n` });
}

let sending = false;
export async function startCampaign(subject: unknown, body: unknown, segIn: any, by: number) {
  const s = String(subject || '').trim().slice(0, 150), b = String(body || '').trim().slice(0, 20000);
  if (s.length < 3 || b.length < 10) throw new CrmError(400, 'Write a subject and a message first.');
  if (!emailEnabled) throw new CrmError(503, 'Email is not configured on the server.');
  if (sending) throw new CrmError(409, 'Another campaign is still sending. Wait for it to finish.');
  const list = segmentUsers(segIn);
  if (!list.length) throw new CrmError(400, 'Nobody in this segment.');
  const r = db.prepare(`INSERT INTO campaigns (created_at, by_user, subject, body, segment, total) VALUES (?, ?, ?, ?, ?, ?)`).run(now(), by, s, b, JSON.stringify(cleanSegment(segIn)), list.length);
  const id = Number(r.lastInsertRowid);
  const ins = db.prepare(`INSERT OR IGNORE INTO campaign_recipients (campaign_id, user_id, email) VALUES (?, ?, ?)`);
  for (const u of list) ins.run(id, u.id, u.email);
  sending = true;
  (async () => {
    let sent = 0, failed = 0;
    for (const u of list) {
      // re-check: someone may unsubscribe while the campaign is going out
      const still = db.prepare(`SELECT 1 ok FROM users WHERE id = ? AND ${NEWS_ON}`).get(u.id) as any;
      if (!still?.ok) { db.prepare(`UPDATE campaign_recipients SET status = 'skipped', at = ? WHERE campaign_id = ? AND user_id = ?`).run(now(), id, u.id); continue; }
      const url = unsubscribeUrl(u.id);
      try {
        await sendMail({
          to: u.email, subject: s, html: campaignHtml(b, u.name, url), text: `${b.replace(/\{name\}/g, u.name || 'there')}\n\nUnsubscribe: ${url}\n`,
          replyTo: SUPPORT_ADDR, headers: { 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
        });
        sent++;
        db.prepare(`UPDATE campaign_recipients SET status = 'sent', at = ? WHERE campaign_id = ? AND user_id = ?`).run(now(), id, u.id);
      } catch (e: any) {
        failed++;
        db.prepare(`UPDATE campaign_recipients SET status = 'failed', at = ? WHERE campaign_id = ? AND user_id = ?`).run(now(), id, u.id);
        logger.warn('Campaign email failed', { id, message: e?.message });
      }
      db.prepare(`UPDATE campaigns SET sent = ?, failed = ? WHERE id = ?`).run(sent, failed, id);
      await new Promise(res => setTimeout(res, 600)); // ~2 per second
    }
    db.prepare(`UPDATE campaigns SET status = 'done', finished_at = ? WHERE id = ?`).run(now(), id);
  })().catch(e => logger.error('Campaign stopped', { id, message: e?.message })).finally(() => { sending = false; });
  return { id, total: list.length };
}

export function campaignList() {
  return (db.prepare(`SELECT id, created_at AS createdAt, subject, segment, total, sent, failed, status, finished_at AS finishedAt FROM campaigns ORDER BY id DESC LIMIT 50`).all() as any[])
    .map(c => ({ ...c, segment: (() => { try { return JSON.parse(c.segment); } catch { return {}; } })() }));
}

/* ================================================================== */
/* Revenue & churn                                                    */
/* ================================================================== */

const PRICE: Record<string, number> = { premium: PLANS.find(p => p.id === 'premium')?.price ?? 15, pro: PLANS.find(p => p.id === 'pro')?.price ?? 30 };

export function revenue() {
  const nowIso = new Date().toISOString();
  const users = db.prepare(`SELECT id, email, plan, premium_until, created_at, cancel_at, role FROM users`).all() as any[];
  const real = users.filter(u => !ADMIN_EMAILS.has(String(u.email).toLowerCase()));
  const active = (u: any) => (u.plan === 'premium' || u.plan === 'pro') && (!u.premium_until || u.premium_until > nowIso);
  const paying = real.filter(active);
  const byPlan = { premium: paying.filter(u => u.plan === 'premium').length, pro: paying.filter(u => u.plan === 'pro').length };
  const events = db.prepare(`SELECT at, user_id, from_plan, to_plan, source, amount FROM plan_events ORDER BY at`).all() as any[];
  // the plan's source per user (latest event): payment / test / admin — revenue counts payments only
  const lastSource = new Map<number, string>();
  for (const e of events) lastSource.set(e.user_id, e.source);
  const payingReal = paying.filter(u => lastSource.get(u.id) === 'payment');
  const mrr = payingReal.reduce((s, u) => s + (PRICE[u.plan] || 0), 0);

  // last 12 months
  const months: string[] = [];
  const d = new Date(); d.setUTCDate(1);
  for (let i = 11; i >= 0; i--) { const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)); months.push(m.toISOString().slice(0, 7)); }
  const leave = db.prepare(`SELECT at, kind, reason FROM leave_feedback`).all() as any[];
  const monthly = months.map(m => {
    const inM = (iso: string | null) => !!iso && iso.slice(0, 7) === m;
    const ev = events.filter(e => inM(e.at));
    const paid = ev.filter(e => e.source === 'payment');
    return {
      month: m,
      signups: real.filter(u => inM(u.created_at)).length,
      newPaid: paid.filter(e => e.to_plan !== 'free' && (e.from_plan === 'free' || !e.from_plan)).length,
      revenue: Math.round(paid.reduce((s, e) => s + (Number(e.amount) || 0), 0) * 100) / 100,
      cancels: leave.filter(l => l.kind === 'cancel' && inM(l.at)).length,
      deletes: leave.filter(l => l.kind === 'delete' && inM(l.at)).length,
      testChanges: ev.filter(e => e.source !== 'payment').length
    };
  });
  const reasons: Record<string, number> = {};
  for (const l of leave) if (l.at >= new Date(Date.now() - 365 * 86400000).toISOString()) reasons[l.reason] = (reasons[l.reason] || 0) + 1;
  const thisMonth = monthly[monthly.length - 1];
  const startPaying = Math.max(1, payingReal.length + thisMonth.cancels - thisMonth.newPaid);
  return {
    accounts: real.length,
    paying: { total: paying.length, ...byPlan, fromPayments: payingReal.length, testOrManual: paying.length - payingReal.length },
    mrr, arr: mrr * 12, prices: PRICE,
    conversion: real.length ? Math.round((1000 * paying.length) / real.length) / 10 : null,
    churnThisMonth: payingReal.length ? Math.round((1000 * thisMonth.cancels) / startPaying) / 10 : null,
    cancelledStillActive: paying.filter(u => u.cancel_at).length,
    monthly, reasons: Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([reason, n]) => ({ reason, n })),
    paymentsLive: events.some(e => e.source === 'payment')
  };
}
