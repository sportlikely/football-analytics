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

/* ---------- fix198: every refusal logged and counted (Admin → Data health: "sign-ups refused today, by reason") ---------- */

/** "iPhone Safari", "Android Chrome", "in-app (Instagram)" — for the log lines (never the email or the IP) */
export function uaFamily(ua: unknown): string {
  const u = String(ua || '');
  if (!u.trim()) return 'no UA';
  const app = /Instagram/.test(u) ? 'Instagram' : /FBAN|FBAV|FB_IAB|FBIOS/.test(u) ? 'Facebook' : /WhatsApp/i.test(u) ? 'WhatsApp' : /BytedanceWebview|musical_ly|TikTok/i.test(u) ? 'TikTok'
    : /Snapchat/.test(u) ? 'Snapchat' : /\bLine\//.test(u) ? 'LINE' : /Twitter/.test(u) ? 'X' : /LinkedInApp/.test(u) ? 'LinkedIn' : /GSA\//.test(u) ? 'Google app' : null;
  const os = /iPhone|iPad/.test(u) ? 'iPhone' : /Android/.test(u) ? 'Android' : /Windows/.test(u) ? 'Windows' : /Mac OS/.test(u) ? 'Mac' : /Linux/.test(u) ? 'Linux' : 'other';
  if (app) return `in-app (${app}, ${os})`;
  const b = /EdgiOS|Edg\//.test(u) ? 'Edge' : /OPR\//.test(u) ? 'Opera' : /SamsungBrowser/.test(u) ? 'Samsung' : /FxiOS|Firefox\//.test(u) ? 'Firefox' : /CriOS|Chrome\//.test(u) ? 'Chrome'
    : /Safari\//.test(u) ? 'Safari' : /iPhone|iPad/.test(u) && /AppleWebKit/.test(u) ? 'in-app (unknown)' : 'other';
  return `${os} ${b}`;
}

db.exec(`CREATE TABLE IF NOT EXISTS signup_refusals (day TEXT NOT NULL, reason TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, reason))`);
// every sign-up try with its outcome (7 days): the admin alert "attempts but no success" reads it
db.exec(`CREATE TABLE IF NOT EXISTS signup_attempts (at TEXT NOT NULL, ok INTEGER NOT NULL, reason TEXT)`);
export function noteAttempt(ok: boolean, reason: string | null) {
  try {
    db.prepare(`INSERT INTO signup_attempts (at, ok, reason) VALUES (?, ?, ?)`).run(new Date().toISOString(), ok ? 1 : 0, reason ? reason.slice(0, 80) : null);
    if (Math.random() < 0.05) db.prepare(`DELETE FROM signup_attempts WHERE at < ?`).run(new Date(Date.now() - 7 * 86400000).toISOString());
  } catch { /* never blocks a sign-up */ }
}
/** the last 24 h: how many tries, how many accounts — the alert fires at 4+ tries and 0 accounts */
export function signupLast24h(): { attempts: number; successes: number } {
  const since = new Date(Date.now() - 86400000).toISOString();
  const r = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(ok), 0) AS ok FROM signup_attempts WHERE at >= ?`).get(since) as any;
  return { attempts: r?.n || 0, successes: r?.ok || 0 };
}

/* ---------- fix198: the widget's own errors, recorded against the form token (the signed fallback flag) ---------- */

// nonce of the form token → the Cloudflare error codes the widget reported for that form (kept an hour)
const widgetErrors = new Map<string, { at: number; codes: string[] }>();
const nonceOf = (token: unknown) => { const p = String(token || '').split('.'); return p.length === 3 ? `${p[0]}.${p[1]}` : null; };
/** the widget failed on this form: only counted for a form token we signed (so a bot can't just claim two failures) */
export function recordWidgetError(formToken: unknown, code: string): boolean {
  const why = checkSignupToken(formToken);
  if (why && !/^too fast/.test(why)) return false;
  const n = nonceOf(formToken)!;
  const e = widgetErrors.get(n) || { at: Date.now(), codes: [] };
  if (e.codes.length < 10) e.codes.push(code.slice(0, 30));
  widgetErrors.set(n, e);
  if (widgetErrors.size > 5000) for (const [k, v] of widgetErrors) if (Date.now() - v.at > 3600000) widgetErrors.delete(k);
  return true;
}
/** the fallback flag: 2+ recorded widget failures on this very form */
export function fallbackSigned(formToken: unknown): string | null {
  const n = nonceOf(formToken);
  const e = n ? widgetErrors.get(n) : null;
  return e && e.codes.length >= 2 ? e.codes.join(',') : null;
}
/** "too fast (1662 ms)" → "too fast": one row per kind of reason a day (kept 30 days) */
export function countRefusal(reason: string) {
  const r = reason.replace(/\s*\(\d+ ms\)/, '').slice(0, 80);
  const day = new Date().toISOString().slice(0, 10);
  try {
    db.prepare(`INSERT INTO signup_refusals (day, reason, n) VALUES (?, ?, 1) ON CONFLICT(day, reason) DO UPDATE SET n = n + 1`).run(day, r);
    db.prepare(`DELETE FROM signup_refusals WHERE day < ?`).run(new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10));
  } catch { /* counting never blocks a sign-up */ }
}
export function signupRefusals(day = new Date().toISOString().slice(0, 10)): { reason: string; n: number }[] {
  return db.prepare(`SELECT reason, n FROM signup_refusals WHERE day = ? ORDER BY n DESC`).all(day) as any[];
}

/* ---------- Cloudflare Turnstile ---------- */

export const turnstileSiteKey = () => (process.env.TURNSTILE_SITE_KEY && process.env.TURNSTILE_SECRET ? process.env.TURNSTILE_SITE_KEY : null);
/**
 * fix198: Cloudflare's answer with the reason. ok when Turnstile is off or Cloudflare accepted the token; reason
 * "turnstile: no token" (the widget never gave one: blocked script, in-app browser …) or "turnstile: refused <codes>".
 */
export async function turnstileCheck(token: unknown, ip: string): Promise<{ ok: boolean; reason: string | null; missing: boolean }> {
  const secret = process.env.TURNSTILE_SECRET;
  if (!secret || !process.env.TURNSTILE_SITE_KEY) return { ok: true, reason: null, missing: false };
  const response = String(token || '');
  if (!response) return { ok: false, reason: 'turnstile: no token', missing: true };
  if (response.length > 2048) return { ok: false, reason: 'turnstile: refused too-long-token', missing: false };
  try {
    const body = new URLSearchParams({ secret, response, ...(ip ? { remoteip: ip } : {}) });
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body, signal: AbortSignal.timeout(8000) });
    const j: any = await r.json();
    if (j?.success) return { ok: true, reason: null, missing: false };
    return { ok: false, reason: `turnstile: refused ${(j?.['error-codes'] || []).join(', ') || 'no reason'}`, missing: false };
  } catch (e: any) {
    // Cloudflare unreachable: let the person in (the other checks still apply) rather than block every sign-up
    logger.warn(`turnstile check failed: ${e?.message || e}`);
    return { ok: true, reason: null, missing: false };
  }
}

/**
 * fix198: the fallback when the widget can't run in the person's browser (failed twice, or Cloudflare's script never
 * loaded): the sign-up goes on with the other checks (form token, honeypot, network / email limits, disposable-email
 * block), the account must confirm its email before any free pick and is marked "Unsure · no captcha" in the CRM.
 * Capped so a bot can't use it as a back door: 2 a day per network, 30 an hour in all.
 */
const fallbackHits = new Map<string, number[]>();
const recent = (k: string, ms: number) => (fallbackHits.get(k) || []).filter(t => Date.now() - t < ms);
/** may this network still use the fallback? (3 accounts a day per network, 30 an hour in all) */
export function fallbackAllowed(ip: string): boolean {
  return recent(`ip:${ip}`, 86400000).length < 3 && recent('all', 3600000).length < 30;
}
/** count it only once an account (or a login) really went through: a mistyped email doesn't use up a try */
export function fallbackUsed(ip: string) {
  const now = Date.now();
  fallbackHits.set(`ip:${ip}`, [...recent(`ip:${ip}`, 86400000), now]);
  fallbackHits.set('all', [...recent('all', 3600000), now]);
  if (fallbackHits.size > 5000) fallbackHits.clear();
}
db.exec(`CREATE TABLE IF NOT EXISTS signup_flags (user_id INTEGER PRIMARY KEY, reason TEXT NOT NULL, at TEXT NOT NULL)`);
export function flagSignup(userId: number, reason: string) {
  db.prepare(`INSERT OR REPLACE INTO signup_flags (user_id, reason, at) VALUES (?, ?, ?)`).run(userId, reason.slice(0, 120), new Date().toISOString());
}
/** the account was created without the Turnstile check (null = with it) */
export function signupFlag(userId: number): string | null {
  try { return (db.prepare(`SELECT reason FROM signup_flags WHERE user_id = ?`).get(userId) as any)?.reason || null; } catch { return null; }
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
  // fix198: signed up without the security check (the widget failed in their browser): never "Real"
  const flag = signupFlag(u.id);
  if (flag) minus.push('no captcha');
  const reasons = [...plus, ...minus];
  const strongBad = minus.some(m => /same network|random-looking/.test(m));
  const trust: Trust = plus.length >= 3 && !strongBad && !flag ? 'real' : (!u.email_verified && !back && !used && (strongBad || minus.length >= 3)) ? 'bot' : 'unsure';
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
