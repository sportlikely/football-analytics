/**
 * Contact form (Oct 2026): messages from the site go to the support inbox (Google Workspace group support@) with the
 * sender as reply-to, so a plain "Reply" answers them. Each message is also kept in contact_messages for the admin
 * page and the coming CRM. Spam guards: honeypot field, minimum fill time, links limit, per-IP and per-email limits.
 */
import { db } from '../db';
import { sendEmail, emailEnabled } from './email';
import { renderAdminMail, adminUrl, israelTime } from './adminMail';
import logger from '../utils/logger';

export const SUPPORT_TO = process.env.SUPPORT_EMAIL || 'support@sportlikely.com';
export const TOPICS = ['question', 'account', 'billing', 'privacy', 'bug', 'idea', 'business', 'other'] as const;
const TOPIC_LABEL: Record<string, string> = {
  question: 'Question', account: 'Account / sign-in', billing: 'Billing / plan', privacy: 'Privacy / my data',
  bug: 'Something is broken', idea: 'Idea / feedback', business: 'Business / partnership', other: 'Other'
};

db.exec(`
  CREATE TABLE IF NOT EXISTS contact_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, user_id INTEGER, name TEXT, email TEXT NOT NULL,
    topic TEXT NOT NULL, message TEXT NOT NULL, page TEXT, sent INTEGER NOT NULL DEFAULT 0, handled INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_contact_at ON contact_messages(at);
`);

export class ContactError extends Error { constructor(public status: number, msg: string) { super(msg); } }

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[a-z]{2,}$/i;
const recent = new Map<string, number[]>(); // email → send times (last 24h)

export async function submitContact(body: any, user: { id: number; email: string } | null) {
  // honeypot: real people never fill the hidden "website" field
  if (body?.website) return { ok: true };
  // filled in under 3 seconds = a script
  const started = Number(body?.startedAt);
  if (Number.isFinite(started) && Date.now() - started < 3000) return { ok: true };
  const email = String(user?.email || body?.email || '').trim().toLowerCase().slice(0, 254);
  const name = String(body?.name || '').trim().slice(0, 80) || null;
  const topic = TOPICS.includes(body?.topic) ? String(body.topic) : 'other';
  const message = String(body?.message || '').replace(/\r/g, '').trim().slice(0, 5000);
  const page = String(body?.page || '').slice(0, 200) || null;
  if (!EMAIL_RE.test(email)) throw new ContactError(400, 'Please enter a valid email address so we can reply.');
  if (message.length < 10) throw new ContactError(400, 'Please write a little more (at least 10 characters).');
  if ((message.match(/https?:\/\//gi) || []).length > 3) throw new ContactError(400, 'Please include no more than 3 links.');
  const now = Date.now();
  const list = (recent.get(email) || []).filter(t => now - t < 86400000);
  if (list.length >= 5) throw new ContactError(429, 'You have sent several messages today. We will answer them soon.');
  list.push(now); recent.set(email, list);

  const at = new Date().toISOString();
  const r = db.prepare(`INSERT INTO contact_messages (at, user_id, name, email, topic, message, page) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(at, user?.id ?? null, name, email, topic, message, page);
  const id = Number(r.lastInsertRowid);
  if (emailEnabled) {
    const label = TOPIC_LABEL[topic] || topic;
    const subject = `[Contact #${id}] ${label} — ${name || email}`;
    // fix239: the staff template (the message as its body; replying answers the sender)
    const { html } = renderAdminMail({
      label: `Contact form · ${label}`, tone: 'warn',
      title: `New message from ${name || email}`,
      what: `${name || 'Someone'} (${email}${user ? `, account #${user.id}` : ', not signed in'}) wrote about “${label}” at ${israelTime(at)}${page ? ` from ${page}` : ''}.`,
      todo: `Reply to this email to answer ${name || 'them'} directly, then press "Mark answered" in Admin.`,
      pre: message,
      buttons: [{ text: 'Open in Admin', href: adminUrl('needs-you') }]
    });
    const text = `${label}\nFrom: ${name || '—'} <${email}>${user ? ` (account #${user.id})` : ''}\n${page ? `Page: ${page}\n` : ''}\n${message}\n`;
    try {
      await sendEmail(SUPPORT_TO, subject, html, text, email);
      db.prepare(`UPDATE contact_messages SET sent = 1 WHERE id = ?`).run(id);
    } catch (e: any) {
      logger.warn('Contact email not sent', { id, message: e?.message }); // kept in the table; the admin page shows it
    }
  }
  return { ok: true, id };
}

export function contactInbox(limit = 100) {
  const rows = db.prepare(`SELECT id, at, user_id AS userId, name, email, topic, message, page, sent, handled FROM contact_messages ORDER BY id DESC LIMIT ?`).all(limit) as any[];
  const open = (db.prepare(`SELECT COUNT(*) AS n FROM contact_messages WHERE handled = 0`).get() as any).n;
  return { open, rows: rows.map(r => ({ ...r, sent: !!r.sent, handled: !!r.handled })) };
}

export function markContact(id: number, handled: boolean) {
  // keep the CRM status in step (column added by crm.ts)
  try { db.prepare(`UPDATE contact_messages SET handled = ?, status = ?, updated_at = ? WHERE id = ?`).run(handled ? 1 : 0, handled ? 'closed' : 'open', new Date().toISOString(), id); }
  catch { db.prepare(`UPDATE contact_messages SET handled = ? WHERE id = ?`).run(handled ? 1 : 0, id); }
}
