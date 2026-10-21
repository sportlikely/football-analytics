/**
 * Plans and the monthly unlock allowance.
 *
 *   Free     — signed-in: FREE_WEEKLY_UNLOCKS (default 2) full match unlocks a week (Monday–Sunday, UTC); signed out: nothing.
 *   Premium  — $8.99 / month ($48.49 / 6 months, $86.29 / year): PREMIUM_UNLOCKS (default 60) match unlocks per calendar
 *              month (UTC). An unlocked match stays open for good (reopening is free); finished matches are always open;
 *              team / player stats and the track record in full.
 *   Pro      — $14.99 / month ($80.99 / 6 months, $143.99 / year): unlimited, plus draw alerts. (fix147: 6 months = 10% off,
 *              a year = 20% off.)
 *   Pick packs (fix147) — credits for single picks when the free / monthly allowance is used up: 5 / 10 / 20 picks at
 *              $0.79 each on Free, $0.59 on Premium (the price of the plan at purchase time); Pro needs none. Credits never
 *              expire, are shared by every sport and are spent one per pick, after the free picks and Premium's cap.
 *
 * Payments: no provider is connected yet. While BILLING_TEST_MODE=1 is set (Railway), a signed-in user can switch
 * their own plan from the Premium page to try the flow ("test checkout"). Remove the variable before launch; a real
 * provider (Paddle / Lemon Squeezy — Stripe does not serve Israeli businesses) will call setPlan() from its webhook.
 */
import { db } from '../db';
import { AuthError, setPlan, verificationRequired, type User, type Plan } from './auth';
import { signupFlag } from './signupGuard';

export const PREMIUM_UNLOCKS = parseInt(process.env.PREMIUM_UNLOCKS || '60', 10);
export const FREE_WEEKLY_UNLOCKS = parseInt(process.env.FREE_WEEKLY_UNLOCKS || '2', 10);
/** Money-back window shown on the plans page (the payment provider does the refund). */
export const REFUND_DAYS = 3;
export const billingTestMode = process.env.BILLING_TEST_MODE === '1';

/** fix147: monthly price, 6 months = 10% off, a year = 20% off. `perMonth` = what it comes to a month, `save` = % off. */
export const PLANS: { id: string; plan?: string; name: string; price: number; period: string; perMonth: number; save: number; unlocks: number | null }[] = [
  { id: 'premium', name: 'Premium', price: 8.99, period: 'month', perMonth: 8.99, save: 0, unlocks: PREMIUM_UNLOCKS },
  { id: 'premium-6m', plan: 'premium', name: 'Premium 6 months', price: 48.49, period: '6 months', perMonth: 8.08, save: 10, unlocks: PREMIUM_UNLOCKS },
  { id: 'premium-year', plan: 'premium', name: 'Premium yearly', price: 86.29, period: 'year', perMonth: 7.19, save: 20, unlocks: PREMIUM_UNLOCKS },
  { id: 'pro', name: 'Pro', price: 14.99, period: 'month', perMonth: 14.99, save: 0, unlocks: null },
  { id: 'pro-6m', plan: 'pro', name: 'Pro 6 months', price: 80.99, period: '6 months', perMonth: 13.5, save: 10, unlocks: null },
  { id: 'pro-year', plan: 'pro', name: 'Pro yearly', price: 143.99, period: 'year', perMonth: 12, save: 20, unlocks: null }
];

/* ---------- pick packs (fix147) ---------- */

export const PACK_SIZES = [5, 10, 20];
/** Price of one pick in a pack, by the plan at purchase time (Pro / admin: no packs, they see everything). */
export const PICK_PRICE: Record<string, number> = { free: 0.79, premium: 0.59 };
export function packsFor(access: string) {
  const each = PICK_PRICE[access];
  if (!each) return [];
  return PACK_SIZES.map(n => ({ id: `pack-${n}`, picks: n, each, price: Math.round(n * each * 100) / 100 }));
}
db.exec(`
  CREATE TABLE IF NOT EXISTS user_credits (user_id INTEGER PRIMARY KEY, balance INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS credit_events (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, delta INTEGER NOT NULL, reason TEXT NOT NULL, at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_credit_events_user ON credit_events(user_id, at);
`);
export const creditBalance = (userId: number): number => (db.prepare('SELECT balance FROM user_credits WHERE user_id = ?').get(userId) as any)?.balance ?? 0;
/** Add (or take, delta < 0) credits with a reason ('pack 10 (test)', 'unlock 123', 'staff grant by #5'). Never below 0. */
export function addCredits(userId: number, delta: number, reason: string): number {
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    const bal = creditBalance(userId);
    if (bal + delta < 0) throw new AuthError(402, 'Not enough picks left in your balance.');
    db.prepare(`INSERT INTO user_credits (user_id, balance, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET balance = excluded.balance, updated_at = excluded.updated_at`).run(userId, bal + delta, now);
    db.prepare('INSERT INTO credit_events (user_id, delta, reason, at) VALUES (?, ?, ?, ?)').run(userId, delta, reason.slice(0, 120), now);
    db.exec('COMMIT');
    return bal + delta;
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
export const creditEvents = (userId: number, limit = 50) => db.prepare('SELECT delta, reason, at FROM credit_events WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, limit);
/** Buy a pack. Only in test mode for now (no real charge); the payment webhook will call addCredits() when wired. */
export function buyPack(user: User, access: string, packId: string) {
  const pack = packsFor(access).find(p => p.id === packId);
  if (!pack) throw new AuthError(400, access === 'pro' || access === 'admin' ? 'Pro sees every pick: no packs needed.' : 'Unknown pack.');
  if (!billingTestMode) throw new AuthError(403, 'Payments are not open yet.');
  const balance = addCredits(user.id, pack.picks, `pack ${pack.picks} at $${pack.each} (test, $${pack.price})`);
  return { balance, pack };
}

db.exec(`
  CREATE TABLE IF NOT EXISTS match_unlocks (
    user_id  INTEGER NOT NULL,
    match_id INTEGER NOT NULL,
    at       TEXT    NOT NULL,
    PRIMARY KEY (user_id, match_id)
  );
  CREATE INDEX IF NOT EXISTS idx_unlocks_user_at ON match_unlocks(user_id, at);
`);
// which allowance an unlock came from: 'premium' (monthly) or 'free' (weekly); older rows were all Premium
if (!(db.prepare(`PRAGMA table_info(match_unlocks)`).all() as any[]).some(c => c.name === 'kind'))
  db.exec(`ALTER TABLE match_unlocks ADD COLUMN kind TEXT NOT NULL DEFAULT 'premium'`);

const DONE = new Set(['FINISHED', 'AWARDED', 'FT', 'AET', 'PEN']);
export const isFinished = (status: string) => DONE.has(String(status || ''));

function monthStart(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}
/** Monday 00:00 UTC of this week (free picks reset every Monday). */
function weekStart(d = new Date()) {
  const back = (d.getUTCDay() + 6) % 7; // Mon = 0 … Sun = 6
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back)).toISOString();
}
function nextWeekStart(d = new Date()) {
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back + 7)).toISOString();
}
function nextMonthStart(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
}

// small per-user cache: the match lists call this on every request
const idCache = new Map<number, { at: number; ids: Set<number> }>();

/** Every match this user has unlocked (last 120 days is plenty: older matches are finished and open anyway). */
export function unlockedIds(userId: number): Set<number> {
  const c = idCache.get(userId);
  if (c && Date.now() - c.at < 30000) return c.ids;
  const since = new Date(Date.now() - 120 * 86400000).toISOString();
  const ids = new Set((db.prepare('SELECT match_id FROM match_unlocks WHERE user_id = ? AND at >= ?').all(userId, since) as any[]).map(r => Number(r.match_id)));
  idCache.set(userId, { at: Date.now(), ids });
  if (idCache.size > 5000) idCache.delete(idCache.keys().next().value as number);
  return ids;
}

export function unlockStatus(user: User | null, access: string) {
  const unlimited = access === 'pro' || access === 'admin';
  if (!user) return { plan: 'anon', unlimited: false, allowance: FREE_WEEKLY_UNLOCKS, period: 'week', used: 0, left: 0, resetsAt: nextWeekStart(), testMode: billingTestMode, credits: 0, packs: [] as ReturnType<typeof packsFor> };
  const weekly = access === 'free';
  const since = weekly ? weekStart() : monthStart();
  const kind = weekly ? 'free' : 'premium';
  const used = (db.prepare('SELECT COUNT(*) n FROM match_unlocks WHERE user_id = ? AND at >= ? AND kind = ?').get(user.id, since, kind) as any).n;
  const allowance = access === 'premium' ? PREMIUM_UNLOCKS : weekly ? FREE_WEEKLY_UNLOCKS : 0;
  return {
    plan: access === 'admin' ? 'admin' : user.plan,
    unlimited,
    allowance,
    period: weekly ? 'week' : 'month',
    used,
    left: unlimited ? null : Math.max(0, allowance - used),
    resetsAt: weekly ? nextWeekStart() : nextMonthStart(),
    testMode: billingTestMode,
    // fix147: the pick balance and the packs this plan can buy
    credits: creditBalance(user.id),
    packs: packsFor(access)
  };
}

/**
 * Spend one unlock on a match (Premium). Already unlocked or finished: free. Out of unlocks: 402 with upgrade: true.
 * Pro / admin never need to unlock (they see everything).
 */
export function unlockMatch(user: User, access: string, matchId: number, status: string) {
  if (access === 'pro' || access === 'admin') return { unlocked: true, charged: false, ...unlockStatus(user, access) };
  if (access !== 'premium' && access !== 'free') throw Object.assign(new AuthError(401, 'Create a free account to unlock matches.'), { upgrade: false });
  // free picks need a confirmed email, so nobody farms them with throwaway accounts
  if (access === 'free' && verificationRequired && !user.emailVerified) throw new AuthError(403, 'Confirm your email to use your free picks.');
  // fix198: an account made without the security check confirms its email first, whatever the email setting
  if (access === 'free' && !user.emailVerified && signupFlag(user.id)) throw new AuthError(403, 'Confirm your email to use your free picks.');
  const have = db.prepare('SELECT 1 FROM match_unlocks WHERE user_id = ? AND match_id = ?').get(user.id, matchId);
  if (have || isFinished(status)) return { unlocked: true, charged: false, ...unlockStatus(user, access) };
  const st = unlockStatus(user, access);
  if ((st.left ?? 0) <= 0) {
    // fix147: allowance used up → one pick from the balance (every sport shares it), else the packs / upgrade sheet
    if (creditBalance(user.id) > 0) {
      addCredits(user.id, -1, `unlock ${matchId}`);
      db.prepare('INSERT OR IGNORE INTO match_unlocks (user_id, match_id, at, kind) VALUES (?, ?, ?, ?)').run(user.id, matchId, new Date().toISOString(), 'credit');
      idCache.delete(user.id);
      return { unlocked: true, charged: true, credit: true, ...unlockStatus(user, access) };
    }
    throw Object.assign(
      new AuthError(402, access === 'free' ? `You've used your ${FREE_WEEKLY_UNLOCKS} free picks this week. They come back on Monday. Buy a pick pack or go Premium.` : `You've used all ${PREMIUM_UNLOCKS} unlocks this month. Buy a pick pack or go Pro.`),
      { upgrade: true, packs: true }
    );
  }
  db.prepare('INSERT OR IGNORE INTO match_unlocks (user_id, match_id, at, kind) VALUES (?, ?, ?, ?)').run(user.id, matchId, new Date().toISOString(), access === 'free' ? 'free' : 'premium');
  idCache.delete(user.id);
  return { unlocked: true, charged: true, ...unlockStatus(user, access) };
}

/** Test checkout (BILLING_TEST_MODE=1 only): the signed-in user switches their own plan. */
export function testCheckout(user: User, planId: string) {
  if (!billingTestMode) throw new AuthError(403, 'Payments are not open yet.');
  const plan = PLANS.find(p => p.id === planId);
  const target: Plan = planId === 'free' ? 'free' : ((plan as any)?.plan || plan?.id) as Plan;
  if (!target || !['free', 'premium', 'pro'].includes(target)) throw new AuthError(400, 'Unknown plan.');
  const days = plan?.period === 'year' ? 365 : plan?.period === '6 months' ? 183 : 31;
  const until = target === 'free' ? null : new Date(Date.now() + days * 86400000).toISOString();
  return setPlan(user.id, target, until, 'test');
}

export function unlockStats() {
  const since = monthStart();
  const r: any = db.prepare(`SELECT COUNT(*) n, COUNT(DISTINCT user_id) users FROM match_unlocks WHERE at >= ? AND kind = 'premium'`).get(since);
  const out = db.prepare(`SELECT COUNT(*) n FROM (SELECT user_id, COUNT(*) c FROM match_unlocks WHERE at >= ? AND kind = 'premium' GROUP BY user_id HAVING c >= ?)`).get(since, PREMIUM_UNLOCKS) as any;
  const free: any = db.prepare(`SELECT COUNT(*) n, COUNT(DISTINCT user_id) users FROM match_unlocks WHERE at >= ? AND kind = 'free'`).get(since);
  return { month: since.slice(0, 7), unlocks: r.n, users: r.users, usersAtLimit: out.n, allowance: PREMIUM_UNLOCKS, freeUnlocks: free.n, freeUsers: free.users, freeWeekly: FREE_WEEKLY_UNLOCKS };
}
