/**
 * Staff console login (Oct 2026): a second, separate sign-in for the CRM and the Users/admin area.
 *
 * - Every staff member (admin included) has a console username + console password, different from their account
 *   password. After each account sign-in (each session), opening the CRM or Users asks for them once; the session is
 *   then marked console-unlocked (sessions.console_ok). /api/crm/* and /api/admin/* refuse locked sessions.
 * - Usernames are chosen by the company (whoever sets the login). The admin sets up their own on first use.
 * - People with the 'team' permission set / change another staff member's console username and password (with a fresh
 *   two-step code, like every team change). Only the admin can do it for someone whose role manages the team. Staff
 *   can't change their own console password (Yarin's rule); only the admin changes his own.
 * - Forgot it: the admin can reset their own with account password + two-step code; staff ask a manager.
 * - Passwords: scrypt (same as accounts), at least 10 characters, not the account password, not the username.
 *   5 wrong tries per 15 minutes per account. Everything goes to the security log.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { pipeline } from 'stream/promises';
import { db } from '../db';
import { hashPassword, verifyPassword } from './auth';
import { isWeb } from './role';

db.exec(`
  CREATE TABLE IF NOT EXISTS staff_console (
    user_id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, pass_hash TEXT NOT NULL,
    must_change INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, updated_by INTEGER
  );
`);
{
  const cols = new Set((db.prepare('PRAGMA table_info(sessions)').all() as any[]).map(c => c.name));
  if (!cols.has('console_ok')) db.exec('ALTER TABLE sessions ADD COLUMN console_ok INTEGER NOT NULL DEFAULT 0');
}
// Oct 2026 (Yarin): staff don't choose their own console password — the manager's password is final
db.exec('UPDATE staff_console SET must_change = 0 WHERE must_change = 1');

/*
 * fix258: after the 28 Oct restarts the admin's console login was gone ("Create your console login", /api/admin/* 423).
 * No code path deletes a row except resetOwn / removeFor, so the login now has a protected second copy:
 * staff_console_keep, filled by triggers on every insert / update (whatever writes it), marked removed_at only by
 * resetOwn / removeFor. A login missing from staff_console but in the copy (not removed) comes back at the worker's
 * start and when its owner opens the console (restoreFromKeep). Without a copy (the first start after this fix) the
 * security log says who had a login that was never reset / removed, and the newest local backup on the volume gives it
 * back (restoreFromBackups). Both tables are on the retention job's never-touch list (utils/retention.ts PROTECTED).
 */
if (!isWeb) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS staff_console_keep (
      user_id INTEGER PRIMARY KEY, username TEXT NOT NULL, pass_hash TEXT NOT NULL, must_change INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL, updated_by INTEGER, removed_at TEXT
    );
    CREATE TRIGGER IF NOT EXISTS staff_console_keep_ins AFTER INSERT ON staff_console BEGIN
      INSERT OR REPLACE INTO staff_console_keep (user_id, username, pass_hash, must_change, updated_at, updated_by, removed_at)
      VALUES (NEW.user_id, NEW.username, NEW.pass_hash, NEW.must_change, NEW.updated_at, NEW.updated_by, NULL);
    END;
    CREATE TRIGGER IF NOT EXISTS staff_console_keep_upd AFTER UPDATE ON staff_console BEGIN
      INSERT OR REPLACE INTO staff_console_keep (user_id, username, pass_hash, must_change, updated_at, updated_by, removed_at)
      VALUES (NEW.user_id, NEW.username, NEW.pass_hash, NEW.must_change, NEW.updated_at, NEW.updated_by, NULL);
    END;
    INSERT OR REPLACE INTO staff_console_keep (user_id, username, pass_hash, must_change, updated_at, updated_by, removed_at)
      SELECT user_id, username, pass_hash, must_change, updated_at, updated_by, NULL FROM staff_console;
  `);
}
const keepExists = () => !!db.prepare(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'staff_console_keep'`).get();
const markRemoved = (userId: number) => { if (keepExists()) db.prepare('UPDATE staff_console_keep SET removed_at = ? WHERE user_id = ?').run(new Date().toISOString(), userId); };
function logRestore(userId: number, detail: string) {
  try {
    const u = db.prepare('SELECT email FROM users WHERE id = ?').get(userId) as any;
    db.prepare('INSERT INTO security_log (at, user_id, email, event, ip, ua, detail) VALUES (?, ?, ?, ?, NULL, NULL, ?)')
      .run(new Date().toISOString(), userId, u?.email ? String(u.email).toLowerCase() : null, 'console_restored', detail.slice(0, 300));
  } catch { /* logging never breaks the restore */ }
}
/** put rows back into staff_console (never over an existing one); returns the users restored */
function putBack(rows: any[], source: string): number[] {
  const out: number[] = [];
  for (const r of rows) {
    if (db.prepare('SELECT 1 AS x FROM staff_console WHERE user_id = ?').get(r.user_id)) continue;
    if (db.prepare('SELECT 1 AS x FROM staff_console WHERE username = ? COLLATE NOCASE').get(r.username)) continue; // name taken since
    db.prepare('INSERT INTO staff_console (user_id, username, pass_hash, must_change, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(r.user_id, r.username, r.pass_hash, r.must_change ? 1 : 0, r.updated_at, r.updated_by ?? null);
    logRestore(r.user_id, `console login "${r.username}" restored from ${source}`);
    out.push(r.user_id);
  }
  return out;
}

/** logins in the protected copy that staff_console lost (not reset / removed on purpose) → back; one user or all */
export function restoreFromKeep(userId?: number): number[] {
  if (!keepExists()) return [];
  const rows = db.prepare(`SELECT k.* FROM staff_console_keep k LEFT JOIN staff_console s ON s.user_id = k.user_id
    WHERE s.user_id IS NULL AND k.removed_at IS NULL${userId === undefined ? '' : ' AND k.user_id = ?'}`).all(...(userId === undefined ? [] : [userId])) as any[];
  return putBack(rows, 'its protected copy');
}

const HAD = `('console_setup', 'console_login_ok', 'console_password_changed')`;
/**
 * Who lost a console login, by the security log: an account that set up / signed in to the console (or got a login
 * from a manager) after its last reset / removal, still has an account, and has no row now (and none in the copy).
 */
export function lostBySecurityLog(): number[] {
  const t = (n: string) => !!db.prepare(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?`).get(n);
  if (!t('security_log')) return [];
  const rows = db.prepare(`
    SELECT u.id AS id,
      (SELECT MAX(at) FROM security_log l WHERE (l.user_id = u.id AND l.event IN ${HAD})
         OR (l.event = 'console_login_set' AND l.detail LIKE u.email || ' → username %')) AS had_at,
      (SELECT MAX(at) FROM security_log l WHERE (l.user_id = u.id AND l.event = 'console_reset_admin')
         OR (l.event = 'role_changed' AND l.detail = u.email || ' → no role')) AS gone_at
    FROM users u WHERE NOT EXISTS (SELECT 1 FROM staff_console s WHERE s.user_id = u.id)`).all() as any[];
  const removed = new Set(keepExists() ? (db.prepare('SELECT user_id FROM staff_console_keep WHERE removed_at IS NOT NULL').all() as any[]).map(r => r.user_id) : []);
  return rows.filter(r => r.had_at && (!r.gone_at || r.gone_at < r.had_at) && !removed.has(r.id)).map(r => r.id as number);
}

type Opener = (file: string) => { prepare(sql: string): { all(...a: any[]): any[] }; close(): void };
const openReadOnly: Opener = file => { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(file, { readOnly: true }); };
/**
 * fix258: the lost logins (security log) from the newest local backup that has them (BACKUP_DIR, gzipped SQLite
 * copies). Each copy is unpacked to the temp disk, read, deleted. Runs in the worker at start; never throws.
 */
export async function restoreFromBackups(backups: string[], opts: { tempDir?: string; open?: Opener } = {}): Promise<{ restored: number[]; lost: number[]; from: string | null; error?: string }> {
  const lost = lostBySecurityLog();
  if (!lost.length) return { restored: [], lost, from: null };
  const tmpDir = opts.tempDir || path.join(os.tmpdir(), 'sl-console-restore');
  const open = opts.open || openReadOnly;
  let error: string | undefined;
  for (const gz of backups) {
    const raw = path.join(tmpDir, `restore-${Date.now()}.sqlite`);
    try {
      await fs.promises.mkdir(tmpDir, { recursive: true });
      await pipeline(fs.createReadStream(gz), zlib.createGunzip(), fs.createWriteStream(raw));
      const b = open(raw);
      let rows: any[] = [];
      try { rows = b.prepare(`SELECT * FROM staff_console WHERE user_id IN (${lost.map(() => '?').join(',')})`).all(...lost); } catch { /* no table in that copy */ } finally { b.close(); }
      if (rows.length) {
        const restored = putBack(rows, `the backup ${path.basename(gz)}`);
        return { restored, lost, from: path.basename(gz) };
      }
    } catch (e: any) { error = String(e?.message || e); } finally { await fs.promises.rm(raw, { force: true }).catch(() => undefined); }
  }
  return { restored: [], lost, from: null, error };
}

export class ConsoleError extends Error { constructor(public status: number, msg: string) { super(msg); } }

const USER_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/i;
const now = () => new Date().toISOString();

const rowOf = (userId: number) => (db.prepare('SELECT username, must_change, updated_at FROM staff_console WHERE user_id = ?').get(userId) as any) || null;
export function consoleRow(userId: number): { username: string; must_change: number; updated_at: string } | null {
  const r = rowOf(userId);
  if (r || isWeb) return r;
  // fix258: a login the table lost comes back from its protected copy (the sign-in step shows, never "Create")
  try { return restoreFromKeep(userId).length ? rowOf(userId) : null; } catch { return null; }
}
export const sessionUnlocked = (tokenHash: string) =>
  !!tokenHash && !!(db.prepare('SELECT console_ok FROM sessions WHERE token_hash = ?').get(tokenHash) as any)?.console_ok;
const unlockSession = (tokenHash: string) => db.prepare('UPDATE sessions SET console_ok = 1 WHERE token_hash = ?').run(tokenHash);
export const lockSession = (tokenHash: string) => db.prepare('UPDATE sessions SET console_ok = 0 WHERE token_hash = ?').run(tokenHash);

function checkNew(userId: number, username: string, password: unknown) {
  const pw = String(password || '');
  if (pw.length < 10) throw new ConsoleError(400, 'The console password needs at least 10 characters.');
  if (pw.length > 200) throw new ConsoleError(400, 'That password is too long.');
  if (pw.toLowerCase().includes(username.toLowerCase())) throw new ConsoleError(400, 'The password may not contain the username.');
  const acct = db.prepare('SELECT pass_hash FROM users WHERE id = ?').get(userId) as any;
  if (!acct) throw new ConsoleError(404, 'Account not found.');
  if (verifyPassword(pw, acct.pass_hash)) throw new ConsoleError(400, 'The console password must be different from the account password.');
  return pw;
}

function save(userId: number, usernameIn: unknown, password: unknown, by: number, mustChange: boolean) {
  const username = String(usernameIn || '').trim();
  if (!USER_RE.test(username)) throw new ConsoleError(400, 'Username: 3–32 letters, numbers, dots, dashes or underscores.');
  const taken = db.prepare('SELECT user_id FROM staff_console WHERE username = ? COLLATE NOCASE').get(username) as any;
  if (taken && taken.user_id !== userId) throw new ConsoleError(409, 'That username is taken.');
  const pw = checkNew(userId, username, password);
  db.prepare(`INSERT INTO staff_console (user_id, username, pass_hash, must_change, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, pass_hash = excluded.pass_hash, must_change = excluded.must_change, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
    .run(userId, username, hashPassword(pw), mustChange ? 1 : 0, now(), by);
  return username;
}

/** First setup by the person themselves (admin only — staff get theirs from a manager). Unlocks this session. */
export function setupOwn(userId: number, tokenHash: string, username: unknown, password: unknown) {
  if (consoleRow(userId)) throw new ConsoleError(409, 'Your console login already exists. Sign in with it.');
  const u = save(userId, username, password, userId, false);
  unlockSession(tokenHash);
  return u;
}

/** A manager (or the admin) sets / resets someone else's console login. Staff can't change it themselves. */
export function setFor(targetId: number, username: unknown, password: unknown, by: number) {
  const u = save(targetId, username, password, by, false);
  // their open console sessions close: they sign in again with the new login
  db.prepare('UPDATE sessions SET console_ok = 0 WHERE user_id = ?').run(targetId);
  return u;
}

/** Change only the console username (password and "must change" stay as they are). */
export function renameFor(targetId: number, usernameIn: unknown, by: number) {
  const row = db.prepare('SELECT username FROM staff_console WHERE user_id = ?').get(targetId) as any;
  if (!row) throw new ConsoleError(400, 'They have no console login yet. Set a username and a password.');
  const username = String(usernameIn || '').trim();
  if (!USER_RE.test(username)) throw new ConsoleError(400, 'Username: 3–32 letters, numbers, dots, dashes or underscores.');
  const taken = db.prepare('SELECT user_id FROM staff_console WHERE username = ? COLLATE NOCASE').get(username) as any;
  if (taken && taken.user_id !== targetId) throw new ConsoleError(409, 'That username is taken.');
  db.prepare('UPDATE staff_console SET username = ?, updated_at = ?, updated_by = ? WHERE user_id = ?').run(username, now(), by, targetId);
  return { username, before: row.username as string };
}

const fails = new Map<number, number[]>();
/** Console sign-in for this session. */
export function consoleLogin(userId: number, tokenHash: string, username: unknown, password: unknown) {
  const t = Date.now();
  const list = (fails.get(userId) || []).filter(x => t - x < 15 * 60000);
  fails.set(userId, list);
  if (list.length >= 5) throw new ConsoleError(429, 'Too many wrong tries. Wait 15 minutes.');
  const row = db.prepare('SELECT username, pass_hash, must_change FROM staff_console WHERE user_id = ?').get(userId) as any;
  if (!row) throw new ConsoleError(400, 'You have no console login yet.');
  const ok = String(username || '').trim().toLowerCase() === String(row.username).toLowerCase() && verifyPassword(String(password || ''), row.pass_hash);
  if (!ok) { list.push(t); throw new ConsoleError(401, 'Wrong username or password.'); }
  fails.delete(userId);
  unlockSession(tokenHash);
  return { mustChange: !!row.must_change };
}

/** The admin changes his own console password (staff can't — their manager sets it). */
export function changeOwn(userId: number, current: unknown, next: unknown) {
  const row = db.prepare('SELECT username, pass_hash FROM staff_console WHERE user_id = ?').get(userId) as any;
  if (!row) throw new ConsoleError(400, 'You have no console login yet.');
  if (!verifyPassword(String(current || ''), row.pass_hash)) throw new ConsoleError(401, 'Current console password is wrong.');
  if (String(current) === String(next)) throw new ConsoleError(400, 'Choose a new password.');
  const pw = checkNew(userId, row.username, next);
  db.prepare('UPDATE staff_console SET pass_hash = ?, must_change = 0, updated_at = ?, updated_by = ? WHERE user_id = ?').run(hashPassword(pw), now(), userId, userId);
}

/** Admin forgot their own console login: account password + two-step code were checked by the caller. */
export function resetOwn(userId: number) {
  markRemoved(userId);
  db.prepare('DELETE FROM staff_console WHERE user_id = ?').run(userId);
  db.prepare('UPDATE sessions SET console_ok = 0 WHERE user_id = ?').run(userId);
}

export function removeFor(userId: number) {
  markRemoved(userId);
  db.prepare('DELETE FROM staff_console WHERE user_id = ?').run(userId);
  db.prepare('UPDATE sessions SET console_ok = 0 WHERE user_id = ?').run(userId);
}

export function consoleUsers(): Map<number, { username: string; mustChange: boolean; updatedAt: string }> {
  return new Map((db.prepare('SELECT user_id, username, must_change, updated_at FROM staff_console').all() as any[]).map(r => [r.user_id, { username: r.username, mustChange: !!r.must_change, updatedAt: r.updated_at }]));
}
