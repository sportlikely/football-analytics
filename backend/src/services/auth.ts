/**
 * Accounts, sessions and plans (free / premium).
 *
 * - Passwords: scrypt (Node crypto, no extra packages), per-user salt, constant-time compare.
 * - Sessions: random 32-byte token in an httpOnly cookie; only its SHA-256 hash is stored,
 *   so a leaked database cannot be used to log in. 30-day sliding expiry.
 * - Plans: 'free' (default) or 'premium' (optionally until a date). Admins = emails listed in
 *   ADMIN_EMAILS (comma separated). Payments will set plan/premium_until through setPlan().
 * - Free users get a "teaser": the model's pick and confidence, no percentages (see teaseDeep).
 */
import crypto from 'crypto';
import type express from 'express';
import { db } from '../db';
import logger from '../utils/logger';
import { roleByKey, ALL_PERMS, type Perm } from './roles';
import { doubleChance } from '../utils/doubleChance';
import { emailEnabled, sendVerificationCode, sendResetCode, sendEmailChangeCode, sendEmailChangedNotice } from './email';
import { every } from './perf';
import { isDisposable } from './disposableDomains';

/** premium = $15 plan with a monthly allowance of match unlocks; pro = $30 plan, unlimited (see services/billing.ts) */
export type Plan = 'free' | 'premium' | 'pro';
export type Access = 'anon' | 'free' | 'premium' | 'pro' | 'admin';

export interface User {
  id: number;
  email: string;
  name: string | null;
  plan: Plan;
  premiumUntil: string | null;
  isAdmin: boolean;
  emailVerified: boolean;
  marketingOptIn: boolean;
  createdAt: string;
  cancelAt: string | null; // asked to cancel: the paid plan runs until premiumUntil and is not renewed
  twoFactor: boolean; // two-step login is on
  role: string | null; // staff role key (services/roles.ts); its permissions need two-step login to be used
  mfa?: boolean; // this session passed two-step login
}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    email          TEXT    NOT NULL UNIQUE,
    name           TEXT,
    pass_hash      TEXT    NOT NULL,
    plan           TEXT    NOT NULL DEFAULT 'free',
    premium_until  TEXT,
    created_at     TEXT    NOT NULL,
    last_login_at  TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash  TEXT    PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TEXT    NOT NULL,
    expires_at  TEXT    NOT NULL,
    user_agent  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE TABLE IF NOT EXISTS email_codes (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose     TEXT    NOT NULL,           -- 'verify' | 'reset'
    code_hash   TEXT    NOT NULL,
    expires_at  TEXT    NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    sent_at     TEXT    NOT NULL,
    PRIMARY KEY (user_id, purpose)
  );
`);

// Columns added after the first release. Accounts that existed before email verification count as verified.
{
  const cols = new Set(db.prepare('PRAGMA table_info(users)').all().map((c: any) => c.name));
  if (!cols.has('email_verified')) {
    db.exec('BEGIN');
    try {
      db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0');
      db.exec('UPDATE users SET email_verified = 1');
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  if (!cols.has('marketing_opt_in')) db.exec('ALTER TABLE users ADD COLUMN marketing_opt_in INTEGER NOT NULL DEFAULT 0');
  if (!cols.has('marketing_opt_in_at')) db.exec('ALTER TABLE users ADD COLUMN marketing_opt_in_at TEXT');
  if (!cols.has('cancel_at')) db.exec('ALTER TABLE users ADD COLUMN cancel_at TEXT');
  if (!cols.has('terms_at')) db.exec('ALTER TABLE users ADD COLUMN terms_at TEXT'); // when the user confirmed 18+ and accepted the terms
  // two-step login (services/twoFactor.ts): encrypted secret, pending secret during setup, replay guard, recovery code hashes
  for (const [c, t] of [['totp_secret', 'TEXT'], ['totp_pending', 'TEXT'], ['totp_enabled_at', 'TEXT'], ['totp_last_step', 'INTEGER'], ['totp_recovery', 'TEXT']])
    if (!cols.has(c)) db.exec(`ALTER TABLE users ADD COLUMN ${c} ${t}`);
  const sc = new Set(db.prepare('PRAGMA table_info(sessions)').all().map((c: any) => c.name));
  if (!cols.has('role')) db.exec('ALTER TABLE users ADD COLUMN role TEXT'); // staff role: 'support' (CRM inbox) — admins come from ADMIN_EMAILS
  if (!cols.has('pending_email')) db.exec('ALTER TABLE users ADD COLUMN pending_email TEXT'); // email change waiting for its code
  if (!sc.has('mfa')) db.exec('ALTER TABLE sessions ADD COLUMN mfa INTEGER NOT NULL DEFAULT 0'); // 1 = this sign-in passed two-step
}
db.exec(`CREATE TABLE IF NOT EXISTS plan_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, user_id INTEGER NOT NULL, from_plan TEXT, to_plan TEXT NOT NULL,
  until TEXT, source TEXT NOT NULL, amount REAL
)`);
// Admins with two-step login on (or everyone when ADMIN_2FA_REQUIRED=1) get admin access only from a session that passed it
const ADMIN_2FA_REQUIRED = process.env.ADMIN_2FA_REQUIRED === '1';

export const SESSION_COOKIE = 'b2b_session';
const SESSION_DAYS = 30;
const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean)
);

// ---------- passwords ----------

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  const key = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(key, expected);
}

// A fixed hash to compare against when the email is unknown, so timing doesn't reveal which emails exist
const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString('hex'));

// ---------- validation ----------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normEmail(e: unknown): string {
  return String(e || '').trim().toLowerCase();
}

function checkCredentials(email: string, password: unknown): string | null {
  if (!EMAIL_RE.test(email) || email.length > 200) return 'Please enter a valid email address.';
  const pw = String(password || '');
  if (pw.length < 8) return 'Password must be at least 8 characters.';
  if (pw.length > 200) return 'Password is too long.';
  return null;
}

// ---------- rate limiting (in memory, per IP and per email) ----------

const attempts = new Map<string, { n: number; reset: number }>();
const WINDOW_MS = 15 * 60 * 1000;

function limited(key: string, max: number, windowMs = WINDOW_MS): boolean {
  const now = Date.now();
  const a = attempts.get(key);
  if (!a || a.reset < now) {
    attempts.set(key, { n: 1, reset: now + windowMs });
    return false;
  }
  a.n++;
  return a.n > max;
}
/** Read a counter without adding to it. */
function over(key: string, max: number): boolean {
  const a = attempts.get(key);
  return !!a && a.reset >= Date.now() && a.n >= max;
}
every('auth cleanup', () => {
  const now = Date.now();
  for (const [k, a] of attempts) if (a.reset < now) attempts.delete(k);
}, WINDOW_MS).unref();

// ---------- users ----------

function rowToUser(r: any): User {
  const paidActive = (r.plan === 'premium' || r.plan === 'pro') && (!r.premium_until || r.premium_until > new Date().toISOString());
  return {
    id: r.id,
    email: r.email,
    name: r.name || null,
    plan: paidActive ? r.plan : 'free',
    premiumUntil: r.premium_until || null,
    // admin only with a confirmed inbox, so nobody can claim an admin address by just signing up with it
    isAdmin: ADMIN_EMAILS.has(String(r.email).toLowerCase()) && !!r.email_verified,
    emailVerified: !!r.email_verified,
    marketingOptIn: !!r.marketing_opt_in,
    createdAt: r.created_at,
    cancelAt: r.cancel_at || null,
    twoFactor: !!r.totp_secret,
    role: r.role || null
  };
}

/** Email confirmation is required only when an email provider is configured. */
export const verificationRequired = emailEnabled;

export function accessOf(user: User | null): Access {
  if (!user) return 'anon';
  if (verificationRequired && !user.emailVerified) return 'free'; // unconfirmed: free view only
  if (user.isAdmin) {
    if ((user.twoFactor || ADMIN_2FA_REQUIRED) && !user.mfa) return user.plan; // admin only after two-step login
    return 'admin';
  }
  return user.plan;
}

/**
 * Staff permissions (services/roles.ts). Admin = every permission (admin access already needs two-step login when
 * required). Other staff: their role's permissions, only with a confirmed email AND two-step login on AND used for this
 * session. staffOf = 'admin', the role key, or null.
 */
export type Staff = string | null;
export function permsOf(user: User | null): Perm[] {
  if (!user) return [];
  if (accessOf(user) === 'admin') return ALL_PERMS;
  const r = roleByKey(user.role);
  if (!r || !user.emailVerified || !user.twoFactor || !user.mfa) return [];
  return r.perms;
}
export function staffOf(user: User | null): Staff {
  if (!user) return null;
  if (accessOf(user) === 'admin') return 'admin';
  return permsOf(user).length ? user.role : null;
}

/** Give a staff role (a key from the roles table) or take it away (null). Admin accounts have no role. */
export function setRole(userId: number, role: string | null): User {
  const row: any = db.prepare('SELECT email FROM users WHERE id = ?').get(userId);
  if (!row) throw new AuthError(404, 'Account not found.');
  if (ADMIN_EMAILS.has(String(row.email).toLowerCase())) throw new AuthError(400, 'The admin account has every permission already.');
  if (role !== null && !roleByKey(role)) throw new AuthError(400, 'Unknown role.');
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId); // permissions are read on every request: effective at once
  return rowToUser(db.prepare('SELECT * FROM users WHERE id = ?').get(userId));
}

/** Every prediction in full, no counting: Pro and admins. ($15 Premium sees a match in full once it is unlocked.) */
export function canSeeFull(access: Access): boolean {
  return access === 'pro' || access === 'admin';
}

/** Any paid plan: full team / player stats, the track record, finished matches in full. */
export function isPaid(access: Access): boolean {
  return access === 'premium' || access === 'pro' || access === 'admin';
}

export class AuthError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function signup(emailIn: unknown, password: unknown, nameIn: unknown, ip: string, optIn = false, adult = false): User {
  const email = normEmail(emailIn);
  if (!adult) throw new AuthError(400, 'Please confirm you are 18 or older and accept the terms.');
  // fix168: 10 an hour and 3 per 10 minutes per network; one account per email address per day
  if (over(`signup:${ip}`, 10) || over(`signup10:${ip}`, 3)) throw new AuthError(429, 'Too many sign-ups from this network. Try again later.');
  if (over(`signup-email:${email}`, 1)) throw new AuthError(429, 'An account was already created with this email today. Try signing in.');
  const bad = checkCredentials(email, password);
  if (bad) throw new AuthError(400, bad);
  if (isDisposable(email)) throw new AuthError(400, 'Please use a permanent email address');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new AuthError(409, 'An account with this email already exists. Try signing in.');
  const name = String(nameIn || '').trim().slice(0, 80) || null;
  const now = new Date().toISOString();
  const r = db
    .prepare('INSERT INTO users (email, name, pass_hash, plan, created_at, email_verified, marketing_opt_in, marketing_opt_in_at, terms_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(email, name, hashPassword(String(password)), 'free', now, verificationRequired ? 0 : 1, optIn ? 1 : 0, optIn ? now : null, now);
  limited(`signup:${ip}`, 10, 3600 * 1000);
  limited(`signup10:${ip}`, 3, 10 * 60 * 1000);
  limited(`signup-email:${email}`, 1, 24 * 3600 * 1000);
  logger.info(`New account #${r.lastInsertRowid}`);
  return rowToUser(db.prepare('SELECT * FROM users WHERE id = ?').get(Number(r.lastInsertRowid)));
}

/** fix168: Turnstile is asked for on login after 3 failed attempts (this network + email, or the email). */
export function loginNeedsCheck(emailIn: unknown, ip: string): boolean {
  const email = normEmail(emailIn);
  return over(`login-ip-email:${ip}:${email}`, 3) || over(`login-email:${email}`, 3);
}

export function login(emailIn: unknown, password: unknown, ip: string): User {
  const email = normEmail(emailIn);
  // Only failed attempts count, so nobody can lock a user out by spamming their email from elsewhere
  // unless they are also guessing wrong from many networks (per-email cap is higher than per-IP+email)
  // fix168: 10 failed attempts per email per 15 minutes (was 50)
  if (over(`login-ip:${ip}`, 30) || over(`login-ip-email:${ip}:${email}`, 8) || over(`login-email:${email}`, 10))
    throw new AuthError(429, 'Too many attempts. Wait 15 minutes and try again.');
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const ok = verifyPassword(String(password || ''), row ? row.pass_hash : DUMMY_HASH);
  if (!row || !ok) {
    limited(`login-ip:${ip}`, 30);
    limited(`login-ip-email:${ip}:${email}`, 8);
    limited(`login-email:${email}`, 10);
    throw new AuthError(401, 'Wrong email or password.');
  }
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
  return rowToUser(row);
}

/** The account by id, or null. */
export function userById(userId: number): User | null {
  const r = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  return r ? rowToUser(r) : null;
}

/** Password check for sensitive changes (two-step setup / switch-off). */
export function checkPassword(userId: number, password: unknown): void {
  const row: any = db.prepare('SELECT pass_hash FROM users WHERE id = ?').get(userId);
  if (!row || !verifyPassword(String(password || ''), row.pass_hash)) throw new AuthError(401, 'Wrong password.');
}

/** Staff: the account password may not be the same as the staff console password. */
function notConsolePassword(userId: number, pw: string) {
  try {
    const c: any = db.prepare('SELECT pass_hash FROM staff_console WHERE user_id = ?').get(userId);
    if (c && verifyPassword(pw, c.pass_hash)) throw new AuthError(400, 'Use a different password from your staff console password.');
  } catch (e) { if (e instanceof AuthError) throw e; }
}

export function changePassword(userId: number, current: unknown, next: unknown): void {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!row) throw new AuthError(404, 'Account not found.');
  if (!verifyPassword(String(current || ''), row.pass_hash)) throw new AuthError(401, 'Current password is wrong.');
  const bad = checkCredentials(row.email, next);
  if (bad) throw new AuthError(400, bad);
  notConsolePassword(userId, String(next));
  db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(String(next)), userId);
  // sign out everywhere else
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

/** Set a user's plan (admin screen now, payment webhooks later). until = ISO date or null for no end. */
export function setPlan(userId: number, plan: Plan, until: string | null, source: 'admin' | 'test' | 'payment' = 'admin', amount: number | null = null): User {
  if (!['free', 'premium', 'pro'].includes(plan)) throw new AuthError(400, 'Unknown plan.');
  const before: any = db.prepare('SELECT plan FROM users WHERE id = ?').get(userId);
  const r = db.prepare('UPDATE users SET plan = ?, premium_until = ? WHERE id = ?').run(plan, plan === 'free' ? null : until, userId);
  if (!Number(r.changes)) throw new AuthError(404, 'Account not found.');
  // history for the revenue dashboard (only source 'payment' counts as money)
  db.prepare('INSERT INTO plan_events (at, user_id, from_plan, to_plan, until, source, amount) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(new Date().toISOString(), userId, before?.plan || null, plan, plan === 'free' ? null : until, source, amount);
  return rowToUser(db.prepare('SELECT * FROM users WHERE id = ?').get(userId));
}

/** Admin: set a new password for a user (until email reset exists) and sign them out. */
export function adminResetPassword(userId: number, next: unknown): void {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!row) throw new AuthError(404, 'Account not found.');
  const bad = checkCredentials(row.email, next);
  if (bad) throw new AuthError(400, bad);
  notConsolePassword(userId, String(next));
  db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(String(next)), userId);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function listUsers(): (User & { lastLoginAt: string | null })[] {
  return db
    .prepare('SELECT * FROM users ORDER BY created_at DESC')
    .all()
    .map((r: any) => ({ ...rowToUser(r), lastLoginAt: r.last_login_at || null }));
}

export function userStats() {
  const all = listUsers();
  return {
    total: all.length,
    premium: all.filter(u => u.plan === 'premium').length,
    pro: all.filter(u => u.plan === 'pro').length,
    admins: all.filter(u => u.isAdmin).length,
    verified: all.filter(u => u.emailVerified).length,
    optIn: all.filter(u => u.marketingOptIn).length
  };
}

// ---------- one-time codes (email confirmation, password reset) ----------

const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_COOLDOWN_MS = 45 * 1000;
const CODE_MAX_ATTEMPTS = 5;

async function issueCode(userId: number, email: string, purpose: 'verify' | 'reset' | 'email'): Promise<void> {
  const prev = db.prepare('SELECT sent_at FROM email_codes WHERE user_id = ? AND purpose = ?').get(userId, purpose);
  if (prev && Date.now() - new Date(prev.sent_at).getTime() < CODE_COOLDOWN_MS)
    throw new AuthError(429, 'A code was just sent. Wait a minute before asking for another one.');
  if (limited(`code:${purpose}:${userId}`, 6)) throw new AuthError(429, 'Too many codes requested. Try again in 15 minutes.');
  if (limited(`code-day:${purpose}:${userId}`, 20, 24 * 3600 * 1000)) throw new AuthError(429, 'Too many codes requested today. Try again tomorrow.');
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const now = new Date();
  db.prepare(
    `INSERT INTO email_codes (user_id, purpose, code_hash, expires_at, attempts, sent_at) VALUES (?, ?, ?, ?, 0, ?)
     ON CONFLICT(user_id, purpose) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, sent_at = excluded.sent_at`
  ).run(userId, purpose, sha(`${purpose}:${userId}:${code}`), new Date(now.getTime() + CODE_TTL_MS).toISOString(), now.toISOString());
  try {
    if (purpose === 'verify') await sendVerificationCode(email, code);
    else if (purpose === 'email') await sendEmailChangeCode(email, code);
    else await sendResetCode(email, code);
  } catch (e: any) {
    logger.error('Sending code failed', { status: e?.response?.status, message: e?.response?.data?.message || e?.message });
    db.prepare('DELETE FROM email_codes WHERE user_id = ? AND purpose = ?').run(userId, purpose);
    throw new AuthError(502, 'We couldn’t send the email. Please try again in a minute.');
  }
}

function useCode(userId: number, purpose: 'verify' | 'reset' | 'email', codeIn: unknown): void {
  const code = String(codeIn || '').replace(/\D/g, '');
  const row = db.prepare('SELECT * FROM email_codes WHERE user_id = ? AND purpose = ?').get(userId, purpose);
  if (!row) throw new AuthError(400, 'No active code. Ask for a new one.');
  if (row.expires_at < new Date().toISOString()) throw new AuthError(400, 'This code has expired. Ask for a new one.');
  if (row.attempts >= CODE_MAX_ATTEMPTS) throw new AuthError(429, 'Too many wrong codes. Ask for a new one.');
  const ok = code.length === 6 && crypto.timingSafeEqual(Buffer.from(sha(`${purpose}:${userId}:${code}`)), Buffer.from(row.code_hash));
  if (!ok) {
    db.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE user_id = ? AND purpose = ?').run(userId, purpose);
    const left = CODE_MAX_ATTEMPTS - row.attempts - 1;
    throw new AuthError(400, left > 0 ? `Wrong code. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Wrong code. Ask for a new one.');
  }
  db.prepare('DELETE FROM email_codes WHERE user_id = ? AND purpose = ?').run(userId, purpose);
}

/** Send (or re-send) the email confirmation code. */
export async function sendVerification(user: User): Promise<void> {
  if (!verificationRequired || user.emailVerified) return;
  await issueCode(user.id, user.email, 'verify');
}

export function verifyEmail(user: User, code: unknown): User {
  if (!user.emailVerified) {
    useCode(user.id, 'verify', code);
    db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(user.id);
  }
  return rowToUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id));
}

/** Forgot password: always answers the same way, so it can't be used to test which emails exist. */
export async function requestPasswordReset(emailIn: unknown, ip: string): Promise<void> {
  if (!emailEnabled) throw new AuthError(503, 'Password reset by email is not available yet. Contact support.');
  const email = normEmail(emailIn);
  if (limited(`reset-ip:${ip}`, 10)) throw new AuthError(429, 'Too many requests. Try again in 15 minutes.');
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!row) return;
  // Not awaited: the answer takes the same time whether or not the account exists
  issueCode(row.id, row.email, 'reset').catch(e => {
    if (!(e instanceof AuthError && e.status === 429)) logger.warn('Reset code not sent', { message: e?.message });
  });
}

export function resetPassword(emailIn: unknown, code: unknown, password: unknown, ip: string): User {
  const email = normEmail(emailIn);
  if (limited(`reset-try:${ip}`, 30)) throw new AuthError(429, 'Too many attempts. Try again in 15 minutes.');
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!row) throw new AuthError(400, 'No active code. Ask for a new one.');
  const bad = checkCredentials(email, password);
  if (bad) throw new AuthError(400, bad);
  useCode(row.id, 'reset', code);
  // The code proves the inbox, so the email counts as confirmed too
  notConsolePassword(row.id, String(password));
  db.prepare('UPDATE users SET pass_hash = ?, email_verified = 1 WHERE id = ?').run(hashPassword(String(password)), row.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
  return rowToUser(db.prepare('SELECT * FROM users WHERE id = ?').get(row.id));
}

/**
 * Change the account email, step 1: password OK → a code goes to the NEW address (proves it is theirs).
 * Admin accounts: the new address must already be in ADMIN_EMAILS (admin rights come from that list).
 */
export async function startEmailChange(user: User, password: unknown, newEmailIn: unknown): Promise<string> {
  if (!emailEnabled) throw new AuthError(503, 'Changing the email is not available yet. Contact support.');
  const email = normEmail(newEmailIn);
  // admin rights come from ADMIN_EMAILS: the new address must be listed there first, or the account would lose them
  if ((user.isAdmin || ADMIN_EMAILS.has(user.email.toLowerCase())) && !ADMIN_EMAILS.has(email))
    throw new AuthError(400, 'Admin account: first add the new address to ADMIN_EMAILS in Railway (keep the old one too), then change it here.');
  if (!EMAIL_RE.test(email) || email.length > 200) throw new AuthError(400, 'Please enter a valid email address.');
  if (email === user.email) throw new AuthError(400, 'That is already your email.');
  if (limited(`email-change:${user.id}`, 5, 3600000)) throw new AuthError(429, 'Too many tries. Try again in an hour.');
  checkPassword(user.id, password);
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new AuthError(409, 'Another account already uses this email.');
  db.prepare('UPDATE users SET pending_email = ? WHERE id = ?').run(email, user.id);
  await issueCode(user.id, email, 'email');
  return email;
}

/** Step 2: the code from the new inbox → the email changes; the old address gets a notice. */
export function confirmEmailChange(user: User, code: unknown): { user: User; oldEmail: string; newEmail: string } {
  const row: any = db.prepare('SELECT email, pending_email FROM users WHERE id = ?').get(user.id);
  if (!row?.pending_email) throw new AuthError(400, 'No email change in progress. Start again.');
  useCode(user.id, 'email', code);
  if (db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(row.pending_email, user.id)) throw new AuthError(409, 'Another account already uses this email.');
  db.prepare('UPDATE users SET email = ?, pending_email = NULL, email_verified = 1 WHERE id = ?').run(row.pending_email, user.id);
  sendEmailChangedNotice(row.email, row.pending_email).catch(e => logger.warn('Email-changed notice not sent', { message: e?.message }));
  return { user: rowToUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)), oldEmail: row.email, newEmail: row.pending_email };
}

export function setMarketingOptIn(userId: number, on: boolean): User {
  db.prepare('UPDATE users SET marketing_opt_in = ?, marketing_opt_in_at = ? WHERE id = ?').run(on ? 1 : 0, on ? new Date().toISOString() : null, userId);
  return rowToUser(db.prepare('SELECT * FROM users WHERE id = ?').get(userId));
}

/** All accounts as CSV (admin export). */
export function usersCsv(): string {
  const rows = db.prepare('SELECT * FROM users ORDER BY created_at').all();
  const esc = (v: any) => {
    const s = v === null || v === undefined ? '' : String(v);
    // quote, and neutralise spreadsheet formulas
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const head = ['id', 'email', 'name', 'plan', 'premium_until', 'email_verified', 'updates_opt_in', 'opt_in_at', 'created_at', 'last_login_at'];
  const lines = rows.map((r: any) => {
    const u = rowToUser(r);
    return [u.id, u.email, u.name, u.plan, u.premiumUntil, u.emailVerified ? 'yes' : 'no', u.marketingOptIn ? 'yes' : 'no', r.marketing_opt_in_at, r.created_at, r.last_login_at]
      .map(esc)
      .join(',');
  });
  return '\uFEFF' + [head.join(','), ...lines].join('\r\n') + '\r\n';
}

// ---------- sessions ----------

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/** Signed-in devices per account (account sharing): the oldest session is signed out when a new one starts. */
const MAX_DEVICES = parseInt(process.env.MAX_DEVICES || '2', 10);
const MAX_DEVICES_ADMIN = 6;

export function createSession(userId: number, userAgent?: string, mfa = false): { token: string; expires: Date } {
  const u: any = db.prepare('SELECT email, email_verified FROM users WHERE id = ?').get(userId);
  const admin = !!u && ADMIN_EMAILS.has(String(u.email).toLowerCase()) && !!u.email_verified;
  const keep = (admin ? MAX_DEVICES_ADMIN : MAX_DEVICES) - 1;
  const old = db.prepare('SELECT token_hash FROM sessions WHERE user_id = ? ORDER BY created_at DESC').all(userId) as any[];
  for (const s of old.slice(Math.max(0, keep))) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(s.token_hash);
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86400000);
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent, mfa) VALUES (?, ?, ?, ?, ?, ?)').run(
    sha(token),
    userId,
    now.toISOString(),
    expires.toISOString(),
    (userAgent || '').slice(0, 200),
    mfa ? 1 : 0
  );
  return { token, expires };
}

export function destroySession(token: string | undefined) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
}

const lastTouch = new Map<string, number>();

/** User for a session token, or null. Extends the session (at most once an hour). */
export function userForToken(token: string | undefined): User | null {
  if (!token) return null;
  const h = sha(token);
  const row = db
    .prepare('SELECT u.*, s.expires_at AS s_expires, s.mfa AS s_mfa FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?')
    .get(h);
  if (!row) return null;
  const now = Date.now();
  if (row.s_expires < new Date(now).toISOString()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(h);
    return null;
  }
  if ((lastTouch.get(h) || 0) < now - 3600000) {
    lastTouch.set(h, now);
    db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(new Date(now + SESSION_DAYS * 86400000).toISOString(), h);
  }
  return { ...rowToUser(row), mfa: !!row.s_mfa };
}

/** SHA-256 of a session token (sessions are stored by hash). */
export const sessionHash = (token: string) => sha(token);

every('auth sessions cleanup', () => {
  try {
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
  } catch {}
}, 6 * 3600000).unref();

// ---------- cookies ----------

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[k] = part.slice(i + 1).trim();
    }
  }
  return out;
}

export function setSessionCookie(res: express.Response, token: string, expires: Date, secure: boolean) {
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure, expires, path: '/' });
}

export function clearSessionCookie(res: express.Response, secure: boolean) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure, path: '/' });
}

// ---------- teaser (what free users receive instead of full predictions) ----------

/**
 * Finished matches: the pick and confidence (the public record). Keeps the shape { model, locked, pick, confidence },
 * plus dc = our double-chance pick (fix120: the recommended pick), without its percentage.
 */
export function teasePrediction(p: any) {
  if (!p || typeof p !== 'object') return p;
  if (p.locked) return { model: p.model, locked: true, pick: p.pick, dc: p.dc, confidence: p.confidence };
  const h = Number(p.home), d = Number(p.draw), a = Number(p.away);
  const pick = h >= d && h >= a ? 'H' : a >= d ? 'A' : 'D';
  return { model: p.model, locked: true, pick, dc: doubleChance(h, d, a)?.k, confidence: p.confidence };
}

/** Matches not played yet: nothing about the prediction, not even which side or how confident ({ model, locked }). */
export function hidePrediction(p: any) {
  if (!p || typeof p !== 'object') return p;
  return { model: p.model, locked: true };
}

const FINISHED = new Set(['FINISHED', 'AWARDED', 'FT', 'AET', 'PEN']);

/**
 * Deep copy of an API payload with predictions trimmed. `keep(id, status)` = show that match in full ($15 Premium:
 * unlocked or finished). Otherwise finished matches keep the pick, everything else is hidden. The match is the object
 * that carries `prediction(s)` (a match) or its `match` (a match-details payload).
 */
export function teaseDeepExcept(value: any, keep: (id: number, status: string) => boolean, depth = 0): any {
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(v => teaseDeepExcept(v, keep, depth + 1));
  const has = 'prediction' in value || 'predictions' in value;
  const owner = has ? (typeof value.id === 'number' ? value : value.match && typeof value.match.id === 'number' ? value.match : null) : null;
  const status = String(owner?.status || '');
  const open = !!owner && keep(owner.id, status);
  const trim = FINISHED.has(status) ? teasePrediction : hidePrediction;
  const out: any = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === 'prediction') out[k] = open || !v ? v : trim(v);
    else if (k === 'predictions' && Array.isArray(v)) out[k] = open ? v : v.map(trim);
    else out[k] = teaseDeepExcept(v, keep, depth + 1);
  }
  return out;
}

/** Anonymous and free users (and the live socket feed for them): no match is kept in full. */
export function teaseDeep(value: any): any {
  return teaseDeepExcept(value, () => false);
}

// ---------- your data (GDPR, Oct 2026): download everything we hold about you, or delete the account ----------

const tableExists = (name: string) => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
const safeAll = (sql: string, ...args: any[]) => { try { return db.prepare(sql).all(...args); } catch { return []; } };

/** Everything stored about one account, as plain data (no password hash, no session tokens). */
export function exportUserData(userId: number) {
  const u: any = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!u) throw new AuthError(404, 'Account not found.');
  return {
    exportedAt: new Date().toISOString(),
    account: {
      email: u.email, name: u.name, plan: u.plan, premiumUntil: u.premium_until, createdAt: u.created_at, lastLoginAt: u.last_login_at,
      emailConfirmed: !!u.email_verified, emailUpdates: !!u.marketing_opt_in, emailUpdatesChosenAt: u.marketing_opt_in_at, termsAcceptedAt: u.terms_at || null
    },
    signedInDevices: safeAll('SELECT created_at AS signedInAt, expires_at AS expiresAt, user_agent AS device FROM sessions WHERE user_id = ?', userId),
    favorites: tableExists('user_favorites') ? safeAll('SELECT kind, ref, data, created_at AS addedAt FROM user_favorites WHERE user_id = ?', userId).map((f: any) => {
      try { return { ...f, data: JSON.parse(f.data) }; } catch { return f; }
    }) : [],
    unlockedMatches: tableExists('match_unlocks') ? safeAll('SELECT match_id AS matchId, at FROM match_unlocks WHERE user_id = ? ORDER BY at', userId) : [],
    waitlists: tableExists('sport_waitlist') ? safeAll('SELECT sport, lang, created_at AS joinedAt FROM sport_waitlist WHERE user_id = ? OR email = ?', userId, u.email) : [],
    securityLog: tableExists('security_log') ? safeAll('SELECT at, event, ip, ua AS device FROM security_log WHERE user_id = ? ORDER BY id DESC LIMIT 500', userId) : [],
    cancellationFeedback: tableExists('leave_feedback') ? safeAll('SELECT plan, reason, details, at FROM leave_feedback WHERE user_id = ?', userId) : [],
    contactMessages: tableExists('contact_messages') ? safeAll('SELECT at, topic, message FROM contact_messages WHERE user_id = ? OR email = ? ORDER BY at', userId, u.email) : [],
    assistantUsage: tableExists('assistant_log') ? safeAll('SELECT at, match_id AS matchId FROM assistant_log WHERE user_id = ? ORDER BY at', userId) : [],
    notes: [
      'Passwords are stored only as a one-way hash and are not included.',
      'Visitor counts use a scrambled IP address that cannot be linked back to you or your account; it is deleted after 90 days.'
    ]
  };
}

// ---------- leaving: why people cancel or delete (Oct 2026) ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS leave_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, user_id INTEGER, plan TEXT, reason TEXT NOT NULL, details TEXT,
    member_days INTEGER, at TEXT NOT NULL
  );
`);
export const LEAVE_REASONS = ['too_expensive', 'not_accurate', 'not_using', 'missing_feature', 'other_service', 'technical', 'other'] as const;
function saveFeedback(kind: 'cancel' | 'delete', u: any, reason: unknown, details: unknown) {
  const r = LEAVE_REASONS.includes(String(reason) as any) ? String(reason) : 'other';
  const d = String(details || '').trim().slice(0, 1000) || null;
  const days = u?.created_at ? Math.floor((Date.now() - Date.parse(u.created_at)) / 86400000) : null;
  // deletions keep no link to the person: no user id, no email
  db.prepare('INSERT INTO leave_feedback (kind, user_id, plan, reason, details, member_days, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(kind, kind === 'cancel' ? u.id : null, u?.plan || null, r, d, days, new Date().toISOString());
}

/** Cancel a paid plan: it keeps running until premium_until and is not renewed. A reason is required. */
export function cancelPlan(userId: number, reason: unknown, details: unknown): User {
  const u: any = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!u) throw new AuthError(404, 'Account not found.');
  if (u.plan === 'free') throw new AuthError(400, 'There is no paid plan to cancel.');
  if (!LEAVE_REASONS.includes(String(reason) as any)) throw new AuthError(400, 'Please tell us why you are cancelling.');
  saveFeedback('cancel', u, reason, details);
  db.prepare('UPDATE users SET cancel_at = ? WHERE id = ?').run(new Date().toISOString(), userId);
  return rowToUser(db.prepare('SELECT * FROM users WHERE id = ?').get(userId));
}
/** Changed their mind: keep the plan renewing. */
export function resumePlan(userId: number): User {
  db.prepare('UPDATE users SET cancel_at = NULL WHERE id = ?').run(userId);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!u) throw new AuthError(404, 'Account not found.');
  return rowToUser(u);
}
/** Admin: reasons people gave when cancelling or deleting. */
export function leaveFeedback(days = 365) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = db.prepare('SELECT kind, plan, reason, details, member_days AS memberDays, at FROM leave_feedback WHERE at >= ? ORDER BY at DESC').all(since) as any[];
  const counts: Record<string, { cancel: number; delete: number }> = {};
  for (const r of rows) { counts[r.reason] ||= { cancel: 0, delete: 0 }; counts[r.reason][r.kind as 'cancel' | 'delete']++; }
  const pending = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE cancel_at IS NOT NULL AND plan != 'free'`).get() as any;
  return { total: rows.length, cancels: rows.filter(r => r.kind === 'cancel').length, deletes: rows.filter(r => r.kind === 'delete').length, cancelledStillActive: pending.n, counts, recent: rows.slice(0, 50) };
}

/** Delete an account and everything linked to it. Needs the current password. */
export function deleteAccount(userId: number, password: unknown, reason?: unknown, details?: unknown): void {
  const u: any = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!u) throw new AuthError(404, 'Account not found.');
  if (!verifyPassword(String(password || ''), u.pass_hash)) throw new AuthError(401, 'Password is wrong.');
  if (ADMIN_EMAILS.has(String(u.email).toLowerCase())) throw new AuthError(400, 'Admin accounts cannot be deleted here. Remove the email from ADMIN_EMAILS first.');
  if (reason) saveFeedback('delete', u, reason, details);
  db.exec('BEGIN');
  try {
    if (tableExists('user_favorites')) db.prepare('DELETE FROM user_favorites WHERE user_id = ?').run(userId);
    if (tableExists('match_unlocks')) db.prepare('DELETE FROM match_unlocks WHERE user_id = ?').run(userId);
    if (tableExists('user_picks')) db.prepare('DELETE FROM user_picks WHERE user_id = ?').run(userId);
    if (tableExists('sport_waitlist')) db.prepare('DELETE FROM sport_waitlist WHERE user_id = ? OR email = ?').run(userId, u.email);
    if (tableExists('assistant_log')) db.prepare('DELETE FROM assistant_log WHERE user_id = ?').run(userId);
    if (tableExists('security_log')) db.prepare('DELETE FROM security_log WHERE user_id = ?').run(userId);
    if (tableExists('contact_messages')) db.prepare('DELETE FROM contact_messages WHERE user_id = ? OR email = ?').run(userId, u.email);
    db.prepare('DELETE FROM email_codes WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
