/**
 * fix168 — bot-proof sign-ups without friction for people:
 *  - a signed form token (GET /api/auth/signup-token when the form opens): a sign-up sent less than 3 s after the
 *    form appeared, or with a token older than 1 h / not ours, gets the generic "Please try again";
 *  - the hidden "website" field (honeypot): when filled, the caller gets the normal success answer and nothing is
 *    created;
 *  - Cloudflare Turnstile when TURNSTILE_SITE_KEY and TURNSTILE_SECRET are set (sign-up always, login after 3 failed
 *    attempts); without them nothing renders and nothing is checked. The secret never leaves this file;
 *  - the trust grade the CRM shows (Real / Unsure / Bot) and an email to the admin when 5+ unverified sign-ups arrive
 *    within an hour.
 */
import crypto from 'crypto';
import { db } from '../db';
import logger from '../utils/logger';

// the token key: random, made once and kept in the database (a deploy doesn't invalidate open forms)
db.exec(`CREATE TABLE IF NOT EXISTS app_secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL)`);
function tokenKey(): Buffer {
  let row = db.prepare(`SELECT value FROM app_secrets WHERE name = 'signup-token'`).get() as any;
  if (!row) {
    db.prepare(`INSERT OR IGNORE INTO app_secrets (name, value) VALUES ('signup-token', ?)`).run(crypto.randomBytes(32).toString('hex'));
    row = db.prepare(`SELECT value FROM app_secrets WHERE name = 'signup-token'`).get() as any;
  }
  return Buffer.from(row.value, 'hex');
}
let key: Buffer | null = null;
const k = () => (key ||= tokenKey());

export function signupToken(): string {
  const payload = `${Date.now()}.${crypto.randomBytes(6).toString('base64url')}`;
  const sig = crypto.createHmac('sha256', k()).update(payload).digest('base64url').slice(0, 32);
  return `${payload}.${sig}`;
}
/** null = fine; otherwise why it was refused (for the log only — the visitor sees "Please try again"). */
export function checkSignupToken(token: unknown): string | null {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return 'no token';
  const [ts, nonce, sig] = parts;
  const want = crypto.createHmac('sha256', k()).update(`${ts}.${nonce}`).digest('base64url').slice(0, 32);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return 'bad token';
  const age = Date.now() - Number(ts);
  if (!Number.isFinite(age) || age < 0) return 'bad time';
  if (age < 3000) return `too fast (${age} ms)`;
  if (age > 3600 * 1000) return 'token expired';
  return null;
}

/** The hidden field was filled in (a person never sees it). */
export const honeypotHit = (body: any) => typeof body?.website === 'string' && body.website.trim() !== '';

/* ---------- Cloudflare Turnstile ---------- */

export const turnstileSiteKey = () => (process.env.TURNSTILE_SITE_KEY && process.env.TURNSTILE_SECRET ? process.env.TURNSTILE_SITE_KEY : null);
/** true when Turnstile is off or Cloudflare accepted the token. */
export async function turnstileOk(token: unknown, ip: string): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET;
  if (!secret || !process.env.TURNSTILE_SITE_KEY) return true;
  const response = String(token || '');
  if (!response || response.length > 2048) return false;
  try {
    const body = new URLSearchParams({ secret, response, ...(ip ? { remoteip: ip } : {}) });
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body, signal: AbortSignal.timeout(8000) });
    const j: any = await r.json();
    if (!j?.success) logger.info(`turnstile refused: ${(j?.['error-codes'] || []).join(', ') || 'no reason'}`);
    return !!j?.success;
  } catch (e: any) {
    // Cloudflare unreachable: let the person in (the other checks still apply) rather than block every sign-up
    logger.warn(`turnstile check failed: ${e?.message || e}`);
    return true;
  }
}

/* ---------- trust (CRM) ---------- */

/** An email that looks typed by a person (not "xk3j9q2v7@…" or long random digits). */
export function plausibleEmail(email: string): boolean {
  const local = String(email || '').toLowerCase().split('@')[0] || '';
  if (local.length < 2) return false;
  const letters = local.replace(/[^a-z]/g, '');
  const digits = local.replace(/[^0-9]/g, '');
  if (digits.length >= 7 && digits.length > letters.length) return false; // mostly long numbers
  const vowels = letters.replace(/[^aeiouy]/g, '').length;
  if (letters.length >= 8 && vowels / letters.length < 0.15) return false; // no vowels: random letters
  if (/[bcdfghjklmnpqrstvwxz]{6,}/.test(letters)) return false; // 6+ consonants in a row
  return true;
}

export type Trust = 'real' | 'unsure' | 'bot';
/**
 * Real / Unsure / Bot from what the account did: email verified, came back after sign-up, any pick, favourite or
 * unlock, a plausible address, not from a network with 3+ sign-ups within an hour (security log, kept 90 days).
 */
export function trustOf(u: { id: number; email: string; created_at: string; last_login_at: string | null; email_verified: number }): { trust: Trust; reasons: string[] } {
  const one = (sql: string, ...a: any[]) => { try { return (db.prepare(sql).get(...a) as any)?.n || 0; } catch { return 0; } };
  const plus: string[] = [], minus: string[] = [];
  if (u.email_verified) plus.push('email verified'); else minus.push('email not verified');
  const back = u.last_login_at && Date.parse(u.last_login_at) - Date.parse(u.created_at) > 10 * 60 * 1000;
  if (back) plus.push('signed in again after sign-up'); else minus.push('never came back');
  const used = one(`SELECT COUNT(*) AS n FROM user_picks WHERE user_id = ?`, u.id) + one(`SELECT COUNT(*) AS n FROM user_favorites WHERE user_id = ?`, u.id) + one(`SELECT COUNT(*) AS n FROM match_unlocks WHERE user_id = ?`, u.id);
  if (used) plus.push('made picks / favourites / unlocks'); else minus.push('no activity');
  if (plausibleEmail(u.email)) plus.push('normal-looking email'); else minus.push('random-looking email');
  // the network of the sign-up (security log): 3+ sign-ups within an hour around it
  const ip = (() => { try { return (db.prepare(`SELECT ip FROM security_log WHERE user_id = ? AND event = 'signup' ORDER BY id LIMIT 1`).get(u.id) as any)?.ip || null; } catch { return null; } })();
  if (ip) {
    const t = Date.parse(u.created_at);
    const n = one(`SELECT COUNT(*) AS n FROM security_log WHERE event = 'signup' AND ip = ? AND at BETWEEN ? AND ?`, ip, new Date(t - 3600 * 1000).toISOString(), new Date(t + 3600 * 1000).toISOString());
    if (n >= 3) minus.push(`${n} sign-ups from the same network within an hour`);
  }
  const reasons = [...plus, ...minus];
  const strongBad = minus.some(m => /same network|random-looking/.test(m));
  const trust: Trust = plus.length >= 3 && !strongBad ? 'real' : (!u.email_verified && !back && !used && (strongBad || minus.length >= 3)) ? 'bot' : 'unsure';
  return { trust, reasons };
}

/* ---------- alert: 5+ unverified sign-ups in an hour ---------- */

let alertedAt = 0;
export async function checkSignupSurge(sendMail: (m: { to: string; subject: string; text: string; html: string }) => Promise<unknown>) {
  if (Date.now() - alertedAt < 6 * 3600 * 1000) return;
  const since = new Date(Date.now() - 3600 * 1000).toISOString();
  const n = (db.prepare(`SELECT COUNT(*) AS n FROM users WHERE created_at >= ? AND COALESCE(email_verified, 0) = 0`).get(since) as any)?.n || 0;
  if (n < 5) return;
  alertedAt = Date.now();
  logger.warn(`sign-up alert: ${n} unverified sign-ups in the last hour`);
  const to = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean)[0];
  if (!to) return;
  const text = `${n} new accounts in the last hour have not verified their email. This can be a bot run. Check CRM → Customers (trust filter: Bot / Unsure).`;
  try { await sendMail({ to, subject: `SportLikely: ${n} unverified sign-ups in an hour`, text, html: `<p>${text}</p>` }); } catch { /* email off */ }
}
