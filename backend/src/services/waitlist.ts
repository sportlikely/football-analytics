/**
 * "Tell me when it opens" list for the sports that are coming (basketball, tennis, American football, baseball), Oct 2026.
 * One row per email and sport; signed-in users are linked to their account.
 */
import { db } from '../db';

export const COMING_SPORTS = ['basketball', 'tennis', 'american-football', 'baseball'] as const; // fix186: + baseball
export type ComingSport = (typeof COMING_SPORTS)[number];

db.exec(`
  CREATE TABLE IF NOT EXISTS sport_waitlist (
    email      TEXT NOT NULL,
    sport      TEXT NOT NULL,
    user_id    INTEGER,
    lang       TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (email, sport)
  );
`);

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/i;

export function joinWaitlist(emailIn: unknown, sportIn: unknown, userId: number | null, langIn: unknown) {
  const email = String(emailIn || '').trim().toLowerCase();
  const sport = String(sportIn || '');
  if (!EMAIL.test(email)) throw Object.assign(new Error('Enter a valid email address.'), { status: 400 });
  if (!(COMING_SPORTS as readonly string[]).includes(sport)) throw Object.assign(new Error('Unknown sport.'), { status: 400 });
  const lang = /^[a-z]{2}$/.test(String(langIn || '')) ? String(langIn) : null;
  db.prepare(`INSERT OR IGNORE INTO sport_waitlist (email, sport, user_id, lang, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(email, sport, userId, lang, new Date().toISOString());
  return { ok: true };
}

/** Admin: how many people wait for each sport, and the latest sign-ups. */
export function waitlistStats() {
  const bySport = db.prepare(`SELECT sport, COUNT(*) AS n FROM sport_waitlist GROUP BY sport`).all();
  const latest = db.prepare(`SELECT email, sport, lang, created_at FROM sport_waitlist ORDER BY created_at DESC LIMIT 50`).all();
  return { bySport, latest };
}
