/**
 * Two-step login (Oct 2026): a 6-digit code from an authenticator app (TOTP, RFC 6238: SHA-1, 30 s, 6 digits) after
 * the password. No extra packages: Node crypto only.
 *
 * - The secret is stored encrypted (AES-256-GCM). Key: TOTP_KEY (Railway variable, any long random text); without it
 *   a random key kept in the database is used (still protects against a casual look, not against a full DB leak).
 * - Setup: start (password again) → scan / type the key → confirm with a code → 8 one-time recovery codes (only their
 *   SHA-256 hashes are stored). Confirming signs out every other device.
 * - Login: password OK + two-step on → a short ticket (5 min, 5 tries) instead of a session; the session is created only
 *   after a valid code (or a recovery code). The same applies after a password reset.
 * - A code works once (replay guard: last used 30-second step), ±1 step of clock drift.
 * - Admins: once an admin has two-step login on (or ADMIN_2FA_REQUIRED=1), admin access needs a session that passed it.
 */
import crypto from 'crypto';
import { db } from '../db';
import logger from '../utils/logger';
import { every } from './perf';

// columns: users.totp_* and sessions.mfa are added in auth.ts (the tables are created there)
db.exec(`CREATE TABLE IF NOT EXISTS app_secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL)`);

export const ADMIN_2FA_REQUIRED = process.env.ADMIN_2FA_REQUIRED === '1';
export class TwoFactorError extends Error { constructor(public status: number, msg: string) { super(msg); } }

/* ---------- encryption of the secret ---------- */
function key(): Buffer {
  let raw = process.env.TOTP_KEY;
  if (!raw) {
    const row = db.prepare(`SELECT value FROM app_secrets WHERE name = 'totp_key'`).get() as any;
    if (row) raw = row.value;
    else {
      raw = crypto.randomBytes(32).toString('hex');
      db.prepare(`INSERT OR IGNORE INTO app_secrets (name, value) VALUES ('totp_key', ?)`).run(raw);
      raw = (db.prepare(`SELECT value FROM app_secrets WHERE name = 'totp_key'`).get() as any).value;
    }
    logger.warn('TOTP_KEY is not set: two-step secrets are encrypted with a key stored in the database');
  }
  return crypto.createHash('sha256').update(String(raw)).digest();
}
let KEY: Buffer | null = null;
const K = () => (KEY ||= key());
function seal(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', K(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}
function open(sealed: string): string {
  const [v, iv, tag, ct] = sealed.split(':');
  if (v !== 'v1') throw new Error('bad secret format');
  const d = crypto.createDecipheriv('aes-256-gcm', K(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}
/** fix205: the same sealing for other small secrets (calendar links), so the database never holds them in plain text */
export const sealText = seal;
export const openText = open;

/* ---------- TOTP ---------- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export function totpAt(secretB32: string, step: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', base32Decode(secretB32)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}
const stepNow = () => Math.floor(Date.now() / 30000);
/** The matching step (−1, 0, +1 around now) or null. */
function matchStep(secretB32: string, code: string): number | null {
  const now = stepNow();
  for (const s of [now, now - 1, now + 1]) {
    const c = totpAt(secretB32, s);
    if (crypto.timingSafeEqual(Buffer.from(c), Buffer.from(code))) return s;
  }
  return null;
}

/* ---------- recovery codes ---------- */
const RC_ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
const hashRc = (c: string) => crypto.createHash('sha256').update(c.toLowerCase().replace(/[^a-z0-9]/g, '')).digest('hex');
function newRecoveryCodes(n = 8): string[] {
  return Array.from({ length: n }, () => {
    const b = crypto.randomBytes(10);
    const s = Array.from(b, x => RC_ALPHA[x % RC_ALPHA.length]).join('');
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}

/* ---------- per-account failure limit ---------- */
const fails = new Map<number, number[]>();
function guard(userId: number) {
  const now = Date.now();
  const list = (fails.get(userId) || []).filter(t => now - t < 15 * 60000);
  fails.set(userId, list);
  if (list.length >= 10) throw new TwoFactorError(429, 'Too many wrong codes. Wait 15 minutes and try again.');
}
const fail = (userId: number) => fails.set(userId, [...(fails.get(userId) || []), Date.now()]);

/* ---------- account state ---------- */
export function twoFactorEnabled(userId: number): boolean {
  const r = db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(userId) as any;
  return !!r?.totp_secret;
}
export function twoFactorStatus(userId: number) {
  const r = db.prepare('SELECT totp_secret, totp_enabled_at, totp_recovery FROM users WHERE id = ?').get(userId) as any;
  let left = 0;
  try { left = r?.totp_recovery ? (JSON.parse(r.totp_recovery) as string[]).length : 0; } catch { /* none */ }
  return { enabled: !!r?.totp_secret, enabledAt: r?.totp_enabled_at || null, recoveryLeft: left, adminRequired: ADMIN_2FA_REQUIRED };
}

/** Check a 6-digit code or a recovery code for an account with two-step on. Returns how it passed. */
export function checkCode(userId: number, input: unknown): 'app' | 'recovery' {
  guard(userId);
  const raw = String(input || '').trim();
  const r = db.prepare('SELECT totp_secret, totp_last_step, totp_recovery FROM users WHERE id = ?').get(userId) as any;
  if (!r?.totp_secret) throw new TwoFactorError(400, 'Two-step login is not on for this account.');
  const digits = raw.replace(/\s/g, '');
  if (/^\d{6}$/.test(digits)) {
    const s = matchStep(open(r.totp_secret), digits);
    if (s !== null && s > (r.totp_last_step ?? -1)) {
      db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(s, userId);
      return 'app';
    }
  } else if (raw.length >= 8) {
    const list: string[] = (() => { try { return JSON.parse(r.totp_recovery || '[]'); } catch { return []; } })();
    const h = hashRc(raw);
    const i = list.indexOf(h);
    if (i >= 0) {
      list.splice(i, 1);
      db.prepare('UPDATE users SET totp_recovery = ? WHERE id = ?').run(JSON.stringify(list), userId);
      return 'recovery';
    }
  }
  fail(userId);
  throw new TwoFactorError(401, 'Wrong code. Use the 6-digit code shown in your app now, or a recovery code.');
}

/** Step 1 of setup: a new secret (kept as pending until confirmed). */
export function startSetup(userId: number, email: string) {
  const secret = base32Encode(crypto.randomBytes(20));
  db.prepare('UPDATE users SET totp_pending = ? WHERE id = ?').run(seal(secret), userId);
  const label = encodeURIComponent(`SportLikely:${email}`);
  const otpauth = `otpauth://totp/${label}?secret=${secret}&issuer=SportLikely&algorithm=SHA1&digits=6&period=30`;
  return { secret, otpauth };
}

/** Step 2: confirm with a code from the app → on, with fresh recovery codes (shown once). */
export function confirmSetup(userId: number, code: unknown): string[] {
  guard(userId);
  const r = db.prepare('SELECT totp_pending FROM users WHERE id = ?').get(userId) as any;
  if (!r?.totp_pending) throw new TwoFactorError(400, 'Start the setup again.');
  const secret = open(r.totp_pending);
  const digits = String(code || '').replace(/\s/g, '');
  const s = /^\d{6}$/.test(digits) ? matchStep(secret, digits) : null;
  if (s === null) { fail(userId); throw new TwoFactorError(401, 'That code did not match. Check the time on your phone is set automatically, then try the newest code.'); }
  const codes = newRecoveryCodes();
  db.prepare(`UPDATE users SET totp_secret = ?, totp_pending = NULL, totp_enabled_at = ?, totp_last_step = ?, totp_recovery = ? WHERE id = ?`)
    .run(r.totp_pending, new Date().toISOString(), s, JSON.stringify(codes.map(hashRc)), userId);
  return codes;
}

export function newRecovery(userId: number, code: unknown): string[] {
  checkCode(userId, code);
  const codes = newRecoveryCodes();
  db.prepare('UPDATE users SET totp_recovery = ? WHERE id = ?').run(JSON.stringify(codes.map(hashRc)), userId);
  return codes;
}

/** Add another device: the same secret again (after a valid code), so a second phone or tablet can be set up. */
export function revealSetup(userId: number, email: string, code: unknown) {
  checkCode(userId, code);
  const r = db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(userId) as any;
  const secret = open(r.totp_secret);
  const label = encodeURIComponent(`SportLikely:${email}`);
  return { secret, otpauth: `otpauth://totp/${label}?secret=${secret}&issuer=SportLikely&algorithm=SHA1&digits=6&period=30` };
}

export function disableTwoFactor(userId: number, code: unknown) {
  checkCode(userId, code);
  db.prepare('UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_enabled_at = NULL, totp_last_step = NULL, totp_recovery = NULL WHERE id = ?').run(userId);
}

/* ---------- login tickets (password OK, code still needed) ---------- */
const tickets = new Map<string, { userId: number; exp: number; tries: number }>();
const thash = (t: string) => crypto.createHash('sha256').update(t).digest('hex');
export function issueTicket(userId: number): string {
  const t = crypto.randomBytes(24).toString('base64url');
  tickets.set(thash(t), { userId, exp: Date.now() + 5 * 60000, tries: 0 });
  return t;
}
/** Valid code for the ticket → the user id (the ticket is used up); otherwise an error. */
export function redeemTicket(ticket: unknown, code: unknown): { userId: number; via: 'app' | 'recovery' } {
  const h = thash(String(ticket || ''));
  const t = tickets.get(h);
  if (!t || t.exp < Date.now()) { tickets.delete(h); throw new TwoFactorError(401, 'This sign-in has expired. Enter your email and password again.'); }
  if (++t.tries > 5) { tickets.delete(h); throw new TwoFactorError(429, 'Too many tries. Enter your email and password again.'); }
  const via = checkCode(t.userId, code);
  tickets.delete(h);
  return { userId: t.userId, via };
}
every('2fa cleanup', () => { const now = Date.now(); for (const [k, v] of tickets) if (v.exp < now) tickets.delete(k); }, 60000).unref();

/** Mark the current session as having passed two-step (after setup), and sign out every other device. */
export function securePastSessions(userId: number, keepTokenHash: string | null) {
  if (keepTokenHash) {
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, keepTokenHash);
    db.prepare('UPDATE sessions SET mfa = 1 WHERE token_hash = ?').run(keepTokenHash);
  } else db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}
